// The heavy-load lock of a user container. A leaf without imports.
//
// Why ONE lock per B and not "one relocation per B": `docker save | load` and the volume copy hit the whole cgroup of B and the shared
// SSD (measured 40–45 MB/s) — a second heavy disk operation beside it doubles both stalls. The copy build queues the volume clone of
// a copy behind it (`stacks/queue.js`): the same lock, the kind stands in the VALUE. There is no second lock, and no kind is "lighter"
// than the other.
//
//   HEAVY_LOAD_KINDS              the known kinds: `relocation`, `copy-clone`. An unknown kind THROWS — a typo would otherwise be a
//                                 lock that nobody recognizes as theirs.
//   occupyHeavyLoad(kind, target)  occupies the lock for `target` = { projectId, instance = "main" } and returns the release function
//                                 (idempotent: a second call releases nothing any more — certainly not the lock of a successor). If it
//                                 is occupied, it throws `HeavyLoadOccupied` with the holder (`occupied`: kind, project, instance,
//                                 since) — whatever kind, whatever project.
//   withHeavyLoad(kind, target, fn)  occupy, await `fn()`, release in the `finally`.
//   heavyLoadStatus()             `null` or { kind, projectId, instance, since } — the READER for /api/runs/active: while the lock is
//                                 held it stands in `projectWork` (runs/routes.js), and `busy` is true (deploy gate AND idle reaper hold
//                                 back; contract "a relocation holds busy").
//   setHeavyLoadWakeup(fn)       (connection for the copy queue) is called as a microtask after every release — the queue of the copies
//                                 waits at the lock and must learn that it is free. Without a wakeup: nothing.
//
// The lock lives in the MEMORY of this process, not in the database: it is a living procedure, no state. If the process ends in the
// middle of the operation, it falls with it — what holds `busy` afterwards and decides is the journal of the operation
// (projectbox/journal.js) and the instance row in state `relocation` (projectbox/instances.js). A stored lock would survive the crash
// of its holder and hold back every later relocation for ever.
//
// Guard: server/backend/test/projectbox-heavy-load.test.js.

export const HEAVY_LOAD_KINDS = Object.freeze(["relocation", "copy-clone"]);

export class HeavyLoadOccupied extends Error {
  constructor(occupied, kind) {
    super(`heavy load occupied: "${occupied.kind}" for ${occupied.projectId}/${occupied.instance} is running (since ${new Date(occupied.since).toISOString()}) — "${kind}" has to wait`);
    this.name = "HeavyLoadOccupied";
    this.code = "HEAVY_LOAD_OCCUPIED";
    this.occupied = { ...occupied };
  }
}

let holder = null; // { kind, projectId, instance, since, marker }
let wakeup = null;

export function setHeavyLoadWakeup(fn) {
  wakeup = typeof fn === "function" ? fn : null;
}

function check(kind, target) {
  if (!HEAVY_LOAD_KINDS.includes(kind)) throw new TypeError(`heavy load: unknown kind "${kind}" (known: ${HEAVY_LOAD_KINDS.join(", ")})`);
  const projectId = target?.projectId;
  if (typeof projectId !== "string" || !projectId) throw new TypeError("heavy load: without projectId");
  const instance = target?.instance ?? "main";
  if (typeof instance !== "string" || !instance) throw new TypeError("heavy load: invalid instance");
  return { projectId, instance };
}

/** Occupy or throw. Returns the release (idempotent). */
export function occupyHeavyLoad(kind, target) {
  const { projectId, instance } = check(kind, target);
  if (holder) throw new HeavyLoadOccupied(holder, kind);
  const marker = Symbol(kind);
  holder = { kind, projectId, instance, since: Date.now(), marker };
  return function approve() {
    if (!holder || holder.marker !== marker) return false;
    holder = null;
    const w = wakeup;
    if (w) queueMicrotask(() => { try { w({ kind, projectId, instance }); } catch (e) { console.error("[projectbox] heavy-load wakeup:", e?.message || e); } });
    return true;
  };
}

export async function withHeavyLoad(kind, target, fn) {
  const approve = occupyHeavyLoad(kind, target);
  try {
    return await fn();
  } finally {
    approve();
  }
}

export function heavyLoadStatus() {
  if (!holder) return null;
  const { kind, projectId, instance, since } = holder;
  return { kind, projectId, instance, since };
}
