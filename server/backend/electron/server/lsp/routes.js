// The editor's wrapper: `POST <apiBase>/lsp/<action>[?instance=…]`, mounted in devtools/code-route.js (both callers: project and
// workspace level). Instance, fence, copy and the `?instance=` choice are computed by the project level as for every file route
// (devtools/routes.js targetInstance/withSelectedInstance); here only the target of the file is resolved (`resolve`, supplied by
// the caller — lsp/ never imports runs/) and a response is built from a throw or a body.
//
// Not a route function in the sense of tools/check/lib/tree-rules.mjs (no `…Routes`, no NEXT): code-route.js calls
// `lspEditorResponse` and sends what comes back.
import { T } from "../i18n.js";
import { editorAction } from "./actions.js";
import { LspError } from "./documents.js";
import { LspNot } from "./sessions.js";

/** A response from a throw: no service ⇒ 200 `{ supported: false, … }`; `LspError` ⇒ its status; the server ⇒ 409/502/504. */
export function responseFromError(e) {
  if (e instanceof LspNot) return { status: 200, body: e.body };
  if (e instanceof LspError) return { status: e.status, body: e.body };
  if (Number.isInteger(e?.status) && e.status >= 400) return { status: e.status, body: { error: String(e?.message || e), ...(typeof e?.code === "string" ? { code: e.code } : {}) } };
  const text = String(e?.message || e);
  if (e?.code === "EDEADLINE") return { status: 504, body: { error: text } };
  if (e?.code === "EEND") return { status: 502, body: { error: text } };
  // Server response errors: ContentModified (-32801), RequestCancelled (-32800) and ServerCancelled (-32802 — B announces
  // `serverCancelSupport`, so the server may cancel on its own) mean "the state has moved" — the client simply asks again
  // (VS Code reschedules the request); likewise a request whose client has left (`EABORT`, lsp/connection.js — nobody reads the
  // response any more). Everything else is a server error.
  if (e?.code === -32801 || e?.code === -32800 || e?.code === -32802 || e?.code === "EABORT") return { status: 409, body: { error: text } };
  if (Number.isInteger(e?.code)) return { status: 502, body: { error: T`Language server: ${text}` } };
  console.warn("[lsp] action failed:", e?.stack || text);
  return { status: 500, body: { error: text } };
}

/** A signal that aborts when the client leaves before the response (the connection closes before `res` is finished): the editor
 *  aborts superseded requests (VS Code the token request on every change), B passes that on to the server as `$/cancelRequest`. */
export function abortOf(res) {
  const ac = new AbortController();
  // A caller without a stream (tests, internal calls with a mocked `res`) never aborts — the signal then simply stays open.
  if (typeof res?.on === "function") res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  return ac.signal;
}

/**
 * An editor action. `resolve(file | null)` → target (see the header of lsp/limit.js) or throws (`status`, `code`); `signal` aborts
 * when the client leaves (devtools/code-route.js) — a running request to the server is then cancelled (`$/cancelRequest`).
 * → `{ status, body }`.
 */
export async function lspEditorResponse(action, body, resolve, { signal = null } = {}) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  try {
    const file = typeof b.file === "string" && b.file ? b.file : null;
    const target = await resolve(file);
    return { status: 200, body: await editorAction(String(action || ""), target, b, { signal }) };
  } catch (e) { return responseFromError(e); }
}
