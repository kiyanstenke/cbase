// kind-stdin.js — write to a child process's stdin without killing the server process.
//
// Why this exists: a write to a dead CLI ends as `uncaughtException: write EPIPE` — in production that kills the
// SERVER PROCESS.
//
// The cause is a mix-up of two emitters: `child.on("error", …)` catches the SPAWN error (ENOENT, EACCES) — errors of
// the stdin STREAM go to `child.stdin`. If the CLI dies before it reads, `child.stdin` emits an `error`; without a
// listener that is an unhandled exception.
//
// And a `try { child.stdin.write(…) } catch {}` is WORTHLESS against it: the stream error arrives asynchronously, the
// `catch` never sees it. That is the worst case — it looks like protection.
//
// The contract: the error handler is registered BEFORE writing, and a dead process is the NORMAL case, not an
// exception — the caller learns about the death through `close`/`error` of the CHILD, not through the stream. Where it
// still needs to know whether the text arrived, the return value says so (`false` = did not go out).
//
// Leaf: no imports. Guard: server/backend/test/stdin-epipe.test.js (functional AND static — no place under
// electron/server/ may write to a child's stdin past this module).

// Marked on the stream itself, not in a map: the stream lives exactly as long as its child, a map would need someone
// to empty it again.
const WATCHES = Symbol("cbase.stdinWatches");
const TOT = Symbol("cbase.stdinTot");

// The error handler. Idempotent: several write paths to the SAME child (claude.js writes the first message and injects
// more later) do not attach several listeners.
function watch(stream) {
  if (stream[WATCHES]) return;
  stream[WATCHES] = true;
  stream.on("error", () => { stream[TOT] = true; });
}

/**
 * Does this child's stdin still accept anything?
 * Dead means: error seen, ended regularly or destroyed.
 */
export function stdinOpen(child) {
  const stream = child?.stdin;
  if (!stream) return false;
  watch(stream);
  return !stream[TOT] && !stream.writableEnded && !stream.destroyed;
}

/**
 * Write text to the child's stdin.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {string|Buffer} text
 * @param {{close?: boolean}} [opt] `close: true` → `end()` right after (one-time calls: the prompt is the whole
 *   input). Default `false` — chat runs keep stdin open so the orchestrator can inject further messages during a turn.
 * @returns {boolean} whether it was written. `false` means "the process accepts nothing anymore" — for every caller
 *   that has to report that (claude.js `cbaseInject`).
 */
export function writeStdin(child, text, { close = false } = {}) {
  const stream = child?.stdin;
  if (!stream) return false;
  watch(stream); // ALWAYS before writing — afterwards it is too late.
  if (stream[TOT] || stream.writableEnded || stream.destroyed) {
    if (close) closeStdin(child);
    return false;
  }
  let ok = true;
  // The synchronous throw is the rare case (stream already destroyed); the common one is the asynchronous one, which
  // the watch above catches.
  try { stream.write(text); } catch { stream[TOT] = true; ok = false; }
  if (close) closeStdin(child);
  return ok;
}

/**
 * Close the child's stdin (the CLI then exits after its current state).
 * `end()` can throw EPIPE too — so closing goes through this path as well.
 *
 * @returns {boolean} whether it was closed (`false`: was already closed or already dead).
 */
export function closeStdin(child) {
  const stream = child?.stdin;
  if (!stream) return false;
  watch(stream);
  if (stream[TOT] || stream.writableEnded || stream.destroyed) return false;
  try { stream.end(); return true; } catch { stream[TOT] = true; return false; }
}

/**
 * Pipe a readable stream into the child's stdin and close it afterwards (e.g. the tar of a copy's open changes, up to
 * 2 GiB — never fully in memory). Same watch as above, BEFORE piping. If the child dies or its stdin closes, the stream
 * is destroyed (it would otherwise keep its descriptor); a read error closes the stdin hard — the child sees a
 * truncated end, its exit code reports that to the caller.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {import("node:stream").Readable} readable
 * @returns {boolean} whether it was piped (`false`: the stdin accepted nothing anymore — the stream is already destroyed).
 */
export function streamIntoStdin(child, readable) {
  const stream = child?.stdin;
  const dismiss = () => { try { if (!readable.destroyed) readable.destroy(); } catch { /* already gone */ } };
  if (!stream) { dismiss(); return false; }
  watch(stream);
  if (stream[TOT] || stream.writableEnded || stream.destroyed) { dismiss(); return false; }
  stream.once("error", dismiss);
  stream.once("close", dismiss);
  readable.once("error", () => { stream[TOT] = true; try { stream.destroy(); } catch { /* already gone */ } });
  readable.pipe(stream);
  return true;
}
