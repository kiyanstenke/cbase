// The orderly end of the server process. A leaf with ONE import (the hook register); server.js passes `endServer`
// through, callers are server/backend/headless.js (SIGTERM/SIGINT in the user container) and the test entry
// server/backend/test/agent-server-child.mjs.
//
// endServer(server)
//   1. fires the hook kind "serverEnd" and WAITS for its subscribers (registered in server.js; today the stop chain
//      of the project containers, projectbox/serverEnd.js — snapshot, then `docker stop -t 30`). Cap
//      `serverEndCapMs()` (default 45 s, a product cap that says it is one): after it things go on even if a
//      subscriber is still running — the stop deadline of the user container (60 s, server/gateway/containers.js
//      B_STOP_DEADLINE) must be above it, otherwise the backend ends by SIGKILL in the middle of the chain;
//   2. closes all connections (`closeAllConnections`), DESTROYS the open upgrade sockets (see below) and closes the
//      server; `close` triggers the server-end subscribers that server.js registered on the server run
//      (agentsAtServerEnd, dynWorkflowsAtServerEnd, the tickers). That too with a cap (CLOSE_CAP_MS) — only a net
//      for a path this leaf does not know;
//   3. `process.exit(0)`.
//   Once per process: a second signal (SIGINT after SIGTERM) gets the same promise.
//
// WHY FIRED ONLY HERE. Not in the `close` event: every test that closes a server and every golden scenario would
// otherwise get a new line in its hook sequence — the chain belongs to the end of the process, not to the server run.
//
// Knob: CBASE_SERVER_END_MS (ms, integer ≥ 0) instead of the 45 s. In tests set in the OPPOSITE direction (like
// CBASE_AGENT_STALL_MS): a test never relies on the cap; the cap test forces it small.
import fs from "node:fs";
import path from "node:path";
import { fireHooks } from "./hooks.js";

export const SERVER_END_CAP_MS = 45_000;
export const CLOSE_CAP_MS = 5_000;

export function serverEndCapMs() {
  const raw = process.env.CBASE_SERVER_END_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms >= 0 ? ms : SERVER_END_CAP_MS;
}

// Wait with a cap: `true` if `p` finished in time (also with an error — that is then on stderr).
function withCap(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    Promise.resolve(p).then(
      () => { clearTimeout(t); resolve(true); },
      (e) => { clearTimeout(t); console.error("[server-end] subscriber:", e?.message || e); resolve(true); },
    );
  });
}

let end = null;

// This leaf tracks upgrade sockets ITSELF. `closeAllConnections` does not count an upgrade connection (the port
// tunnel tunnel.js, the browser devtools browsers.js:attachBrowserDevtools) — it has left the HTTP server — but
// `server.close` waits for it. Without this `close` would never fire while a tunnel is open: agentsAtServerEnd and
// dynWorkflowsAtServerEnd would not run, the process would end via the close cap, and for the runs the end would
// look like a crash. So server.js registers EVERY server here (`trackUpgradeSocket`, before the two upgrade paths),
// and endServer destroys the open sockets before `close`. Tracked on the "upgrade" event itself, not per path: a
// third upgrade path is covered without further work. Guard: server/backend/test/projectbox-server-end.test.js.
const upgradeSocket = new WeakMap();
export function trackUpgradeSocket(server) {
  if (!server || upgradeSocket.has(server)) return;
  const open = new Set();
  upgradeSocket.set(server, open);
  server.on("upgrade", (_req, socket) => {
    if (!socket || socket.destroyed) return;
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
}
// Destroys a server's open upgrade sockets; returns how many there were (an unregistered server: 0).
export function closeUpgradeSocket(server) {
  const open = server ? upgradeSocket.get(server) : null;
  if (!open) return 0;
  const all = [...open];
  for (const s of all) { try { s.destroy(); } catch {} }
  return all.length;
}

// The mark "server is ending", set FIRST in endServer, before fireHooks, and never false again — the process ends.
// The stop chain only stops the project containers its `docker ps` sees; a container or run created in the up to
// 45 s after that would die hard with the backend. Readers: the creation of a project container
// (projectbox/instance.js: refuses) and projectbox/idle.js `projectLock` (via runs/project-lock.js: in a CONVERTED
// project no new turn begins — it waits with reason "serverEnd" for the next process —, a workflow agent waits, a
// subagent is refused; oneshots run, they run in the backend). A value, not an event: whoever asks later gets the
// same answer. Only this mark, without the foreign one, is read by `ownServerEnd()` (below).
let ends = false;

// The FOREIGN mark "B is ending" (B = the backend's user container). When the gateway stops a user container not via
// `docker stop` (the backend then runs endServer itself) but via `docker exec … docker stop -t 30 $ids`
// (server/gateway/containers.js stopProjectContainer), the gateway FIRST writes the file /run/cbase/b-ends
// (content: epoch ms) via `docker exec -u root`. Without it the observer (projectbox/resumption.js) would take this
// stop for a crash and restart the project containers at once in the still living container — the following `rm -f`
// would kill them hard. It counts like the own mark if file AND directory are owned by root and not writable for
// group/others (/run/cbase is root 0755), the file is a regular one (lstat: no link) and not older than
// B_ENDS_AGE_MS (age counts the file's modification time; entry.sh removes it on every start, the ten minutes are
// the net for a path that does not). Path prefixed with the test seam CBASE_NETWORK_ROOT (like
// projectbox/network-marker.js). Not cached: one lstat per question is cheap, and a cache would bring a point in
// time nobody checks. Never throws: every error ⇒ false.
// WHAT "owned by root" PROTECTS: only against a process WITHOUT docker access. Every process the backend starts as
// agent carries the docker group and can write a root-owned 0644 file b-ends through the inner dockerd (`docker run
// -v /run/cbase:/m …`): then serverEnds() holds for up to ten minutes (renewable) — turns of converted projects
// wait, the observer starts nothing, creation and relocation answer 503. That is no new power (with the docker group
// the same process can stop the project containers anyway), but no boundary against agents either. Binding the mark
// to the start time of PID 1 or to a gateway identifier would not draw one: the backend runs under the same uid as
// the agents, what it can read they can read too — and a new format of the mark would couple backend and gateway,
// which are rolled out separately. The boundary would only exist if agents lost the docker group.
export const B_ENDS_MARKER = "/run/cbase/b-ends";
export const B_ENDS_AGE_MS = 10 * 60 * 1000;
// The pure verdict on the two lstat results (file, directory) — testable without a file system, including the case
// "file and directory belong to different owners" that a test without root cannot create. Never throws: unreadable
// ⇒ false.
export function bEndsVerdict(stFile, stDir, { owner = 0, now = Date.now() } = {}) {
  try {
    const onlyOwner = (st) => st.uid === owner && (st.mode & 0o022) === 0;
    if (!stFile?.isFile() || !onlyOwner(stFile)) return false;
    if (!stDir?.isDirectory() || !onlyOwner(stDir)) return false;
    return now - stFile.mtimeMs < B_ENDS_AGE_MS;
  } catch {
    return false;
  }
}
export function bEndsMarkerApplies({ root = process.env.CBASE_NETWORK_ROOT || "", now = Date.now(), owner = 0 } = {}) {
  try {
    const file = path.join(root || "/", B_ENDS_MARKER);
    const st = fs.lstatSync(file);
    if (!st.isFile()) return false; // the directory only if the file is one (one lstat less)
    return bEndsVerdict(st, fs.lstatSync(path.dirname(file)), { owner, now });
  } catch {
    return false;
  }
}
// Test seam: the owner that serverEnds() takes for "root". Always 0 in the product — the product never calls the
// seam. A test that does not run as root cannot create a root-owned file; with the seam set to its own uid it runs
// serverEnds() ITSELF (server/backend/test/server-end-marker.test.js, reset in the finally).
let bEndsOwner = 0;
export function bEndsOwnerForTest(uid = 0) { bEndsOwner = Number.isInteger(uid) && uid >= 0 ? uid : 0; }
export function serverEnds() { return ends || bEndsMarkerApplies({ owner: bEndsOwner }); }
// This process's OWN orderly end: only the mark from endServer (SIGTERM/SIGINT via server/backend/headless.js),
// NEVER the foreign mark b-ends. For a reader whose answer to "the server is ending" cannot be taken back in a
// process that lives on: dynworkflows/run.js freezes a run for GOOD on it (row "interrupted", script aborted). Any
// agent process in the container can write the foreign mark — a false alarm through it would halt a run until the
// next restart, without a completion notice, and a waiting graph step would hang. Set FIRST in endServer, i.e.
// BEFORE the "serverEnd" chain stops the project containers (projectbox/serverEnd.js) — an agent that dies there
// already finds it. Guard: server/backend/test/dynworkflows-server-end.test.js.
export function ownServerEnd() { return ends; }
// Test seam: set and reset the mark in the TEST PROCESS — endServer ends with process.exit and cannot be run there.
// Guards of the queue and the creation of copies (server/backend/test/stacks-queue.test.js,
// stacks-creation.test.js) use it to ask what happens in the ending process. The product sets the mark only in
// endServer.
export function serverEndMarkerForTest(value) { ends = Boolean(value); }

export function endServer(server) {
  ends = true;
  if (end) return end;
  end = (async () => {
    const cap = serverEndCapMs();
    const finished = await withCap(fireHooks("serverEnd", {}), cap);
    if (!finished) console.error(`[server-end] cap of ${cap} ms hit — the subscribers of "serverEnd" are still running, the server ends anyway`);
    server?.closeAllConnections?.();
    closeUpgradeSocket(server);
    const closed = await withCap(new Promise((resolve) => (server ? server.close(() => resolve()) : resolve())), CLOSE_CAP_MS);
    if (!closed) console.error(`[server-end] cap of ${CLOSE_CAP_MS} ms hit — server.close is still waiting for open connections, the process ends anyway`);
    process.exit(0);
  })();
  return end;
}
