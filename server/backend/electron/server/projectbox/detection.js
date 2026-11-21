// The services detection, seen from the domain side projectbox/. A leaf WITHOUT imports: the detection itself stands in
// projects/scans.js (`runServicesScan`), and projectbox/ never imports projects/ (cycle guard, import-direction.test.js) — it comes via
// a setter from server.js. Here stands only what the domain side must know about it.
//
// setServicesDetection(fn)          fn(projectId, { onlySupplement }) triggers the detection of a project (server.js →
//                                  projects/scans.js runServicesScan). Unset (tests without a server) `detectServices` does nothing.
// detectServices(projectId, { onlySupplement })  the ONE call for the domain side: after the end of the setup (without
//                                  `onlySupplement`: the creation reconciles) and after a subsequent upload (`onlySupplement` — nothing
//                                  is removed). `true` if triggered; `false` without a connection. If one is running already, EXACTLY ONE
//                                  more runs afterwards (re-run instead of discard, scans.js).
// detectionBegins(pid) / detectionEnds(pid) / runningDetectionsOf(pid)  the detections that are COMPUTING right now (after gate, save
//                                  gate and cap; scans.js counts) — the idle state of a project counts them under the reason "detection"
//                                  (projectbox/idle.js idleOf). A WAITING one does not count: it holds nothing back, and a lock that
//                                  waited for its end would hold it back itself (it waits at the lock).
// detectionWaiting(pid, wake) / wakeDetections(pid)  the detection that waits at the lock of the project (start gate,
//                                  runs/project-lock.js — a oneshot WITH an instance is judged like an agent): wakeProject calls
//                                  `wakeDetections` as soon as the main is free; `wake` runs in the next microtask, once.

let detection = null;
/** Connection fn(projectId, { onlySupplement }) — server.js sets it to projects/scans.js runServicesScan. `null` takes it back. */
export function setServicesDetection(fn) {
  detection = typeof fn === "function" ? fn : null;
}

/** Triggers the services detection of a project. `true` if triggered. */
export function detectServices(projectId, { onlySupplement = false } = {}) {
  if (!detection || !projectId) return false;
  detection(String(projectId), { onlySupplement: onlySupplement === true });
  return true;
}

// ── The computing detections per project (idle state) ────────────────────────────────────────────────────────────────────
const running = new Map(); // projectId → count
export function detectionBegins(projectId) {
  const k = String(projectId ?? "");
  running.set(k, (running.get(k) || 0) + 1);
}
export function detectionEnds(projectId) {
  const k = String(projectId ?? "");
  const n = (running.get(k) || 1) - 1;
  if (n > 0) running.set(k, n); else running.delete(k);
}
export const runningDetectionsOf = (projectId) => running.get(String(projectId ?? "")) || 0;

// ── The detections waiting at the lock (wakeProject) ────────────────────────────────────────────────────────────────────
const waiting = new Map(); // projectId → wake()
/** Remembers the detection that waits at the lock of the project (one per project — scans.js merges more). */
export function detectionWaiting(projectId, wake) {
  const k = String(projectId ?? "");
  if (typeof wake === "function") waiting.set(k, wake); else waiting.delete(k);
}
/** Wakes the waiting detection of the project (in the next microtask, once). Returns how many (0 or 1). */
export function wakeDetections(projectId) {
  const k = String(projectId ?? "");
  const fn = waiting.get(k);
  if (!fn) return 0;
  waiting.delete(k);
  queueMicrotask(() => {
    try { fn(); } catch (e) { console.error(`[detection] ${k}: waking failed:`, e?.message || e); }
  });
  return 1;
}
