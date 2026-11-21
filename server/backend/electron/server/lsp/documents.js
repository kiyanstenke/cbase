// The documents of a session: B is the ONLY LSP client and keeps ONE document `{ text, source, version }` per session and file —
// `source` is `"buffer"` (with `buffer`, the identifier of a window's buffer: a random id per buffer and window) or `"disk"` (an
// agent has no buffer: B reads the disk). A leaf over the contract and text.js; the session comes in as an object.
//
//   documentReconcile(s, { abs, buffer, version, text, languageId })
//       If `buffer` and `version` match the document, it stands (not a byte goes to the server). Otherwise B reconciles with `text`
//       — `didOpen` the first time, after that `didChange` with the WHOLE text (no partial changes: after a reconcile error the
//       client simply sends everything, and two windows with buffers of the same file take turns without any bookkeeping). If `text`
//       is missing it throws 409 TEXT_MISSING — the client repeats the same request WITH the text.
//   closeDocument(s, abs, buffer)   `didClose`, if this buffer holds the document.
//   cleanExpired(s, now)            every document that has not seen a request for BUFFER_LEASE_MS gets `didClose` — the server
//                                   reads the disk afterwards (a window that closed without sending `close`).
//   reopenDocuments(s, list)        the documents of a session that restarted because of the language switch, `didOpen` in the
//                                   new one — with source, buffer and buffer version as before (the window's next request matches
//                                   without text) and the old `last` (the lease keeps running, it does not start over).
//   receiveDiagnostic(s, params)    `textDocument/publishDiagnostics` (push) into the store per file, with the state.
//   diagnosticsOf(s, d)             the diagnostics for the document's state AT THE CALL (version pinned): pull
//                                   (`textDocument/diagnostic`) if the server offers it, otherwise wait until a report for EXACTLY
//                                   this state arrived — at most DIAGNOSTICS_WAIT_MS, then the last known ones (never a hang).
//                                   tsserver reports a state in stages (syntax, then semantics): after the first matching report
//                                   B waits another LINGER_MS for more, never past the deadline. If a second window or an agent
//                                   reconciles the same document during the wait, later reports belong to FOREIGN text: then the
//                                   last report for this state counts, and if none came the answer is empty. If the session ends
//                                   during the wait (language switch, stop) it throws `EEND` at once — never sit out the deadline,
//                                   never diagnostics of a dead server.
import { T } from "../i18n.js";
import { DIAGNOSTICS_WAIT_MS, BUFFER_LEASE_MS } from "./contract.js";
import { uriOfPath } from "./text.js";

const LINGER_MS = 150;
const ended = () => Object.assign(new Error(T("The language server was shut down (restart) — repeat the request")), { code: "EEND" });

export class LspError extends Error {
  constructor(status, body) { super(String(body?.error || body?.code || "language service")); this.status = status; this.body = body; }
}
export const textMissing = () => new LspError(409, { code: "TEXT_MISSING", error: T("The server does not know the state of this buffer — repeat the request with `text`.") });

function set(s, d, uri, abs, text, kind) {
  s.seq += 1;
  if (!d) {
    d = { uri, abs, languageId: kind.languageId, version: 1 };
    s.documents.set(uri, d);
    s.v.note("textDocument/didOpen", { textDocument: { uri, languageId: kind.languageId, version: 1, text } });
  } else if (d.text !== text) {
    d.version += 1;
    s.v.note("textDocument/didChange", { textDocument: { uri, version: d.version }, contentChanges: [{ text }] });
  }
  if (d.text !== text) d.change = s.seq;
  Object.assign(d, { text, last: Date.now(), source: kind.source, buffer: kind.buffer ?? null, bufVersion: kind.bufVersion ?? null });
  return d;
}

export function documentReconcile(s, { abs, buffer, version, text, languageId }) {
  const uri = uriOfPath(abs);
  const d = s.documents.get(uri) || null;
  if (buffer) {
    const matches = d && d.source === "buffer" && d.buffer === buffer && d.bufVersion === version;
    if (matches && (typeof text !== "string" || text === d.text)) { d.last = Date.now(); return d; }
    if (typeof text !== "string") throw textMissing();
    return set(s, d, uri, abs, text, { source: "buffer", buffer, bufVersion: version, languageId });
  }
  if (typeof text !== "string") throw new Error("documentReconcile: without a buffer it needs the text from disk");
  if (d && d.source === "disk" && d.text === text) { d.last = Date.now(); return d; }
  return set(s, d, uri, abs, text, { source: "disk", languageId });
}

export function closeDocument(s, abs, buffer) {
  const uri = uriOfPath(abs);
  const d = s.documents.get(uri);
  if (!d || (buffer && !(d.source === "buffer" && d.buffer === buffer))) return false;
  s.documents.delete(uri);
  s.diagnostics.delete(uri);
  s.v?.note("textDocument/didClose", { textDocument: { uri } });
  return true;
}

export function reopenDocuments(s, list) {
  let n = 0;
  for (const old of list || []) {
    if (!old?.uri || typeof old.text !== "string" || s.documents.has(old.uri)) continue; // already opened by a request in the meantime
    const d = set(s, null, old.uri, old.abs, old.text, { source: old.source, buffer: old.buffer, bufVersion: old.bufVersion, languageId: old.languageId });
    d.last = old.last ?? d.last;
    n += 1;
  }
  return n;
}

/** What of a session's documents carries over into a new one (reopenDocuments) — without server versions, those count anew there. */
export const carryoverOf = (d) => ({ uri: d.uri, abs: d.abs, languageId: d.languageId, text: d.text, source: d.source, buffer: d.buffer ?? null, bufVersion: d.bufVersion ?? null, last: d.last });

export function cleanExpired(s, now = Date.now(), lease = BUFFER_LEASE_MS) {
  let n = 0;
  for (const d of [...s.documents.values()]) if (now - d.last > lease && closeDocument(s, d.abs, null)) n += 1;
  return n;
}

export function receiveDiagnostic(s, p) {
  if (!p || typeof p.uri !== "string") return;
  s.diagnostics.set(p.uri, { items: Array.isArray(p.diagnostics) ? p.diagnostics : [], seq: s.seq, version: Number.isInteger(p.version) ? p.version : null, at: Date.now() });
  for (const w of [...s.diagWaiters]) w();
}

function wait(s, condition, until) {
  if (condition()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let finished = false;
    const end = (ok) => { if (finished) return; finished = true; s.diagWaiters.delete(w); clearTimeout(tick); resolve(ok); };
    const w = () => { if (s.intentional) end(false); else if (condition()) end(true); }; // ending the session calls the waiters: return at once
    const tick = setTimeout(() => end(condition()), Math.max(0, until - Date.now()));
    s.diagWaiters.add(w);
  });
}

export async function diagnosticsOf(s, d) {
  // The state of THIS request — `d` is the session's shared document and changes underfoot (see the header).
  const { uri, version } = d;
  const change = d.change ?? 0;
  const moved = () => s.documents.get(uri) !== d || d.version !== version;
  if (s.caps?.diagnosticProvider) {
    try {
      const r = await s.v.request("textDocument/diagnostic", { textDocument: { uri } });
      // The response applies to the state the server knew when the request arrived — the pinned one (notifications and requests
      // are processed in order).
      if (r?.kind === "full") {
        const items = Array.isArray(r.items) ? r.items : [];
        if (!moved()) s.diagnostics.set(uri, { items, seq: s.seq, version, at: Date.now() });
        return items;
      }
      if (r?.kind === "unchanged") return s.diagnostics.get(uri)?.items || [];
    } catch { /* ⇒ the pushed ones */ }
    if (s.intentional) throw ended();
  }
  // A report matches if it carries EXACTLY this state (with `version`) or — without `version` — arrived after the change while
  // the document is still at this state. Checked at the moment of arrival (receiveDiagnostic calls the waiters synchronously).
  let hits = null;
  const matches = () => {
    const diag = s.diagnostics.get(uri);
    if (!diag) return false;
    // (A document that was closed and reopened counts from the start — the same number is then a different state.)
    const ok = s.documents.get(uri) === d && (diag.version !== null ? diag.version === version : !moved() && diag.seq >= change);
    if (ok) hits = diag;
    return ok;
  };
  const until = Date.now() + DIAGNOSTICS_WAIT_MS;
  const found = await wait(s, matches, until);
  if (s.intentional) throw ended();
  if (found) {
    for (;;) {
      const prior = s.diagnostics.get(uri);
      const fresh = await wait(s, () => s.diagnostics.get(uri) !== prior, Math.min(until, Date.now() + LINGER_MS));
      if (!fresh || Date.now() >= until || !matches()) break;
    }
    return hits.items;
  }
  return moved() ? [] : s.diagnostics.get(uri)?.items || [];
}
