// The shared arbiter of waiting for memory. A leaf WITHOUT imports: the sources arrive by setter from server.js — the
// graph starts (workflows/graph-start.js graphCandidates), the stack copies (stacks/queue.js copyCandidates), service
// detection, project setup, the start of a stopped instance (projectbox/instance-stop.js instanceStartCandidates,
// source "instance-start") and the workflow agents of dynamic workflows waiting for memory (dynworkflows/cap.js
// storageCandidates, source "dyn-workflows" — it also wakes the arbiter itself, at the end of each agent).
// workflows/ never imports stacks/; this leaf does not know any of its sources either.
//
// WHY ONE arbiter: the save gate (storage-gate.js) admits at most ONE start out of the memory wait per pass, the
// oldest — otherwise several waiting jobs would fill the freed memory at once. Two queues with one start each would
// pass the gate twice in the same tick; hence one count across graph starts AND copies.
//
// setStorageQueueSource(name, candidates)   registers a source (the same name replaces; `null` unregisters).
//     `candidates()` returns the candidates of THIS pass in their own order: `{ waitingSince, storage, attempts }` —
//       waitingSince time of the request (ms), oldest first; same age ⇒ order of registration, then of the list;
//       storage     true when the candidate is in the memory wait NOW (`waiting_storage`) — only those count;
//       attempts()  try a start; `{ started: true }` means begun, anything else not (keeps waiting, discarded).
//     If `candidates()` throws, that source is missing in this pass (with a log line); if an `attempts()` throws, it
//     does not count.
// wakeStorageQueue()   ONE pass: all candidates of all sources, oldest first; out of the memory wait at most ONE
//     starts — whoever is still in the memory wait afterwards waits for the next pass. A start out of another wait
//     (lock, queue) does not count (memory was not its reason). Not reentrant: a wake DURING a pass (from inside an
//     `attempts()`) is dropped — the running pass sees everything anyway, and an immediate second one would turn "one
//     per pass" into two. Returns the number of starts (for tests), `null` for a dropped call.
// storageQueueSoon()   a pass in the next microtask, bundled (several causes ⇒ one) — for causes that arrive together
//     (heavy load freed, a build ended).
// Woken by the tick (server.js, `graphTickMs` — the MAIN path: memory becomes free without anything reporting it), by
// the trigger wakeup (a workflow run ended, server.js setTriggerWakeup), by the heavy load (a lock fell,
// projectbox/heavyLoad.js setHeavyLoadWakeup) and by the end of a copy's build (stacks/queue.js).
//
// Guards: server/backend/test/stacks-queue.test.js (graph older, copy younger ⇒ graph first, the copy in the next pass)
// and server/backend/test/graph-save-gate.test.js.

const sources = new Map(); // name → candidates(); registration order breaks ties

export function setStorageQueueSource(name, candidates) {
  const n = String(name || "");
  if (!n) throw new TypeError("storage queue: a source needs a name");
  if (candidates === null || candidates === undefined) { sources.delete(n); return; }
  if (typeof candidates !== "function") throw new TypeError(`storage queue: the source "${n}" is not a function`);
  sources.set(n, candidates);
}

/** The registered sources (names, in registration order) — for guards. */
export const storageQueueSources = () => [...sources.keys()];

// Bundled: several causes at the same moment (the heavy load falls AND a build ends) yield ONE pass in the next
// microtask — not two in a row, which would undermine "one per pass".
let scheduled = false;
export function storageQueueSoon() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    try { wakeStorageQueue(); } catch (e) { console.error("[storage-queue] pass:", e?.message || e); }
  });
}

let running = false;
export function wakeStorageQueue() {
  if (running) return null;
  running = true;
  let starts = 0;
  try {
    const all = [];
    let rang = 0;
    for (const [name, candidates] of sources) {
      let list;
      try { list = candidates(); } catch (e) { console.error(`[storage-queue] source ${name}:`, e?.message || e); continue; }
      for (const k of Array.isArray(list) ? list : []) {
        if (!k || typeof k.attempts !== "function") continue;
        all.push({ name, k, rang: rang++, waitingSince: Number.isFinite(k.waitingSince) ? k.waitingSince : 0 });
      }
    }
    all.sort((a, b) => a.waitingSince - b.waitingSince || a.rang - b.rang);
    let fromStorage = false;
    for (const { name, k } of all) {
      if (k.storage && fromStorage) continue;
      try {
        const r = k.attempts();
        if (r?.started) {
          starts += 1;
          if (k.storage) fromStorage = true;
        }
      } catch (e) { console.error(`[storage-queue] ${name}:`, e?.message || e); }
    }
  } finally { running = false; }
  return starts;
}
