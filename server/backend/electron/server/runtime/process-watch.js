// The backend process's policy for errors nobody catches ("a single error ends a shared process"). A leaf with no imports.
// Registered ONLY by the user container's entry point (server/backend/headless.js), and only AFTER a successful start — never
// by startServer: in tests dozens of servers run in ONE process, and there an unhandled rejection should fail the test
// (node:test reports it to the running test) instead of vanishing in a log.
//
// THE DECISION: B KEEPS RUNNING and logs — for `unhandledRejection` AND `uncaughtException`.
//   Why not "end in order via serverEnd": B is PID 1 of the user container and carries the inner dockerd with all project
//   containers, turns, subagents and dynamic workflows. An end — even the orderly one (runs/server-end.js: snapshot,
//   `docker stop -t 30` per project container, restart via `--restart unless-stopped`, recovery) — takes all of that down for
//   ONE error, and every error a stranger can trigger becomes an arbitrarily repeatable outage (e.g. `GET //` from any project
//   container, without a token). The cases found so far were all local: a stream without a listener (EPIPE on a stdin), a throw
//   from a setImmediate, a URL parsed before the try — the process state was fine afterwards, only the one request or job was
//   lost. Each of those is fixed at its site; the watch is the net for the next one, not the repair.
//   The price: Node advises against continuing after `uncaughtException` (a half-run path can leave a lock or a Map entry
//   behind — visible as a chat that is "running", solvable with stop). We accept that for availability; that is why the line is
//   loud: stack, origin, counter — `docker logs` of the user container.
//
// WHY ONLY AFTER THE START (measured on Node 22): with a listener on `uncaughtException` a rejected top-level await no longer
// ends the process — the listener gets it (origin "unhandledRejection"), and the process exits with 0 or lives on without
// listening. A failed start (EADDRINUSE, broken database) would leave a B that runs and does not answer. Before the start
// every error therefore stays fatal (exit 1, Docker restarts); after it the watch applies.
//
// The sandbox of the dynamic workflows (dynworkflows/sandbox.js catchRejection) registers itself for the duration of a run and
// answers rejections of promises FROM ITS vm context. The watch leaves a promise from a foreign realm to it while it is
// registered (otherwise every caught script error would show up again as "unhandled" in the log); everything from its own realm
// it logs, and the sandbox then no longer throws (it sees a second listener).

const stack = (e) => (e && typeof e === "object" && e.stack ? String(e.stack) : String(e));

/**
 * Registers the listeners on the process; the return value unregisters them. `output` is the log seam (default console.error),
 * `counter` counts along (`rejections`, `exceptions`).
 */
export function processWatch({ output = (z) => console.error(z), counter = { rejections: 0, exceptions: 0 } } = {}) {
  const rejection = (reason, promise) => {
    let foreignRealm = false;
    try { foreignRealm = Boolean(promise) && Object.getPrototypeOf(promise) !== Promise.prototype; } catch { /* Proxy or similar */ }
    if (foreignRealm && process.listenerCount("unhandledRejection") > 1) return;
    counter.rejections += 1;
    output(`[process] unhandled rejection #${counter.rejections} — the process keeps running (runtime/process-watch.js): ${stack(reason)}`);
  };
  const exception = (error, origin) => {
    counter.exceptions += 1;
    output(`[process] uncaught exception #${counter.exceptions} (${origin || "uncaughtException"}) — the process keeps running (runtime/process-watch.js): ${stack(error)}`);
  };
  process.on("unhandledRejection", rejection);
  process.on("uncaughtException", exception);
  return () => {
    process.off("unhandledRejection", rejection);
    process.off("uncaughtException", exception);
  };
}
