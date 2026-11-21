// JSON-RPC 2.0 over stdio with a language server (LSP "Base Protocol": `Content-Length: n\r\n\r\n` + n bytes of UTF-8). A leaf
// over node:* and the contract. The child process comes from outside (lsp/sessions.js starts it through runtime/inProject.js).
//
//   request(method, params, { deadline, signal })
//                                          → promise of the result; a server error throws (`code`, `data`), the deadline
//                                          (REQUEST_DEADLINE_MS) throws `EDEADLINE` and sends `$/cancelRequest` — never a hang. An
//                                          aborted `signal` (the client left) throws `EABORT` and also sends `$/cancelRequest`
//                                          (as VS Code does: the server does not finish computing a superseded request).
//   note(method, params)                   a notification to the server.
//   atRequest(method, fn)                  answers a request FROM THE SERVER (`workspace/configuration`, `workspace/applyEdit`, …);
//                                          without a handler "MethodNotFound" (-32601) goes back, never silence.
//   atNote(method, fn)                     notifications from the server (`textDocument/publishDiagnostics`, …).
//   atEnd(fn)                              the process is gone — `{ code, signal, stderr }` (the last 4 KB of stderr): every open
//                                          request then throws `EEND` with that text.
//   farewell(reason, { deadline })         the orderly end (LSP `shutdown`, then `exit`): every open request throws `EEND` with
//                                          `reason` IMMEDIATELY, and so does every new one (never a hang on a server that is just
//                                          leaving); it waits at most `deadline` (FAREWELL_MS) each for `shutdown` and then for
//                                          the process end. → whether the process left on its own (otherwise the caller kills it).
// CAPS: a header at most HEADER_MAX, a message at most MESSAGE_MAX bytes — beyond that it is a protocol error and the process is
// killed (SIGKILL). Without the cap B would buffer whatever a server announces; the server runs with the TypeScript and the
// plugins of the PROJECT.
import { T } from "../i18n.js";
import { writeStdin } from "../providers/kind-stdin.js";
import { REQUEST_DEADLINE_MS } from "./contract.js";

const STDERR_MAX = 4096;
const HEADER_MAX = 8192;
/** ONE message of a server may have at most this many bytes (`Content-Length`). */
export const MESSAGE_MAX = 64 * 1024 * 1024;
/** How long `farewell` waits per step (the response to `shutdown`, then the process end after `exit`). */
export const FAREWELL_MS = 2_000;

export class Connection {
  constructor(kind) {
    this.kind = kind;
    this.nextId = 1;
    this.open = new Map(); // id → { resolve, reject, method, tick }
    this.requestGiver = new Map();
    this.noteGiver = new Map();
    this.endGiver = [];
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.closed = false;
    this.farewellReason = null; // the reason while `farewell` is running — new requests throw it
    this.dismissed = false;
    this.end = null;
    kind.stdout?.on("data", (c) => this.#read(c));
    kind.stderr?.on("data", (c) => { this.stderr = (this.stderr + String(c)).slice(-STDERR_MAX); });
    kind.on("error", (e) => this.#end({ code: null, signal: null, error: String(e?.message || e) }));
    kind.on("exit", (code, signal) => this.#end({ code, signal }));
  }

  get alive() { return !this.closed; }

  request(method, params, { deadline = REQUEST_DEADLINE_MS, signal = null } = {}) {
    if (this.closed) return Promise.reject(this.#endError());
    if (this.farewellReason) return Promise.reject(this.#farewellError());
    const abort = () => Object.assign(new Error(`Aborted (${method})`), { code: "EABORT" });
    if (signal?.aborted) return Promise.reject(abort());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const settle = () => { this.open.delete(id); clearTimeout(tick); signal?.removeEventListener("abort", atAbort); };
      const tick = setTimeout(() => {
        settle();
        this.note("$/cancelRequest", { id });
        reject(Object.assign(new Error(T`The language server did not answer within ${Math.round(deadline / 1000)} s (${method})`), { code: "EDEADLINE" }));
      }, deadline);
      const atAbort = () => { if (!this.open.has(id)) return; settle(); this.note("$/cancelRequest", { id }); reject(abort()); };
      signal?.addEventListener("abort", atAbort, { once: true });
      // The deadline timer keeps the event loop alive while the request is open (the process itself does not, lsp/sessions.js).
      this.open.set(id, { resolve: (x) => { signal?.removeEventListener("abort", atAbort); resolve(x); }, reject: (e) => { signal?.removeEventListener("abort", atAbort); reject(e); }, method, tick });
      this.#write({ jsonrpc: "2.0", id, method: method, ...(params === undefined ? {} : { params }) });
    });
  }

  note(method, params) {
    if (this.closed || this.farewellReason) return;
    this.#write({ jsonrpc: "2.0", method: method, ...(params === undefined ? {} : { params }) });
  }

  atRequest(method, fn) { this.requestGiver.set(method, fn); }
  atNote(method, fn) { this.noteGiver.set(method, fn); }
  atEnd(fn) { if (this.end) fn(this.end); else this.endGiver.push(fn); }

  async farewell(reason, { deadline = FAREWELL_MS } = {}) {
    if (this.closed || this.farewellReason) return this.closed;
    this.farewellReason = String(reason || T("The language server is shutting down"));
    const f = this.#farewellError();
    for (const [, o] of this.open) { clearTimeout(o.tick); o.reject(f); }
    this.open.clear();
    const end = new Promise((resolve) => this.atEnd(resolve));
    const deadlineEnd = () => new Promise((resolve) => { const t = setTimeout(resolve, deadline); t.unref?.(); });
    const id = this.nextId++;
    const response = new Promise((resolve) => { this.open.set(id, { resolve, reject: resolve, method: "shutdown", tick: null }); });
    this.#write({ jsonrpc: "2.0", id, method: "shutdown" });
    await Promise.race([response, end, deadlineEnd()]);
    this.open.delete(id);
    if (!this.closed) this.#write({ jsonrpc: "2.0", method: "exit" });
    await Promise.race([end, deadlineEnd()]);
    return this.closed;
  }

  #farewellError() { return Object.assign(new Error(this.farewellReason), { code: "EEND" }); }

  #write(message) {
    // Through the helper (error handler BEFORE the write, EPIPE is the normal case): a dead process reports itself through `exit`.
    const text = JSON.stringify(message);
    writeStdin(this.kind, `Content-Length: ${Buffer.byteLength(text, "utf8")}\r\n\r\n${text}`);
  }

  #read(chunk) {
    if (this.dismissed) return; // after a protocol error the rest of the stream is no longer protocol; the process is being killed
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    for (;;) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) {
        if (this.buffer.length > HEADER_MAX) { this.#logError("header without end"); return; }
        return;
      }
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const m = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.#logError(`header without Content-Length: ${header.slice(0, 80)}`); return; }
      const length = Number(m[1]);
      if (!Number.isSafeInteger(length) || length > MESSAGE_MAX) { this.#logError(`message too large (Content-Length ${m[1].slice(0, 20)}, cap ${MESSAGE_MAX})`); return; }
      const beginning = separator + 4;
      if (this.buffer.length < beginning + length) return;
      const body = this.buffer.subarray(beginning, beginning + length).toString("utf8");
      this.buffer = this.buffer.subarray(beginning + length);
      let n;
      try { n = JSON.parse(body); } catch { continue; }
      this.#distribute(n);
    }
  }

  #logError(text) {
    this.stderr = `${this.stderr}\n[cbase] ${text}`.slice(-STDERR_MAX);
    this.buffer = Buffer.alloc(0);
    this.dismissed = true;
    try { this.kind.kill("SIGKILL"); } catch { /* gone */ }
  }

  #distribute(n) {
    if (n && n.id !== undefined && n.id !== null && !n.method) {
      const o = this.open.get(n.id);
      if (!o) return;
      this.open.delete(n.id);
      clearTimeout(o.tick);
      if (n.error) o.reject(Object.assign(new Error(String(n.error.message || T("Language server error"))), { code: n.error.code, data: n.error.data }));
      else o.resolve(n.result === undefined ? null : n.result);
      return;
    }
    if (n && typeof n.method === "string" && n.id !== undefined && n.id !== null) {
      const fn = this.requestGiver.get(n.method);
      if (!fn) { this.#write({ jsonrpc: "2.0", id: n.id, error: { code: -32601, message: `cbase does not answer ${n.method}` } }); return; }
      Promise.resolve().then(() => fn(n.params)).then(
        (result) => this.#write({ jsonrpc: "2.0", id: n.id, result: result === undefined ? null : result }),
        (e) => this.#write({ jsonrpc: "2.0", id: n.id, error: { code: -32603, message: String(e?.message || e) } }),
      );
      return;
    }
    if (n && typeof n.method === "string") {
      const fn = this.noteGiver.get(n.method);
      if (fn) { try { fn(n.params); } catch (e) { console.warn(`[lsp] ${n.method}:`, e?.message || e); } }
    }
  }

  #endError() {
    const e = this.end || {};
    const reason = e.error || (e.signal ? `Signal ${e.signal}` : `Exit ${e.code ?? "?"}`);
    const rest = this.stderr.trim().split("\n").slice(-3).join(" · ");
    return Object.assign(new Error(T`The language server has exited (${reason})${rest ? `: ${rest}` : ""}`), { code: "EEND" });
  }

  #end(info) {
    if (this.closed) return;
    this.closed = true;
    this.end = { ...info, stderr: this.stderr };
    const f = this.#endError();
    for (const [, o] of this.open) { clearTimeout(o.tick); o.reject(f); }
    this.open.clear();
    for (const fn of this.endGiver.splice(0)) { try { fn(this.end); } catch { /* keep going */ } }
  }
}
