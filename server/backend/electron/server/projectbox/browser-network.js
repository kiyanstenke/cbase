// Browser and profiles in the project container, seen from B. Two seams for the leaves browser-profiles.js and browsers.js — neither
// imports the store or docker; server.js sets them here.
//
// foreignProfileLock({ host, pid, immediately })  the seam of browser-profiles.js (setProfileLockSeam): does the process of a Chromium
//   lock `<host>-<pid>` with a FOREIGN hostname still live? The pid is valid in the namespace of the hostname.
//     null   "not mine, as today" (`process.kill` in B): always without an ops marker, and for every hostname that does not have the
//            form of a project container (`cbp-<n>`). A user container carries a new hostname after every deploy (the gateway assigns
//            none, server/gateway/containers.js — Docker takes the id): the corpses of its predecessor keep falling as before. Taken
//            literally ("unknown ⇒ alive" for EVERY foreign name), every corpse of the previous B would block its chat's profile for
//            ever (Chromium refuses a lock with a foreign hostname).
//     true   unknown ⇒ alive: a `cbp-<n>` without an instance of this hostname, an unreadable store, a docker that reports neither
//            0 nor 1 (cap, broken exec), `immediately` (the synchronous per-turn path never asks docker), every question during the
//            pause after a cap (LOCK_PAUSE_MS) and a frozen or paused container (its "is paused" with exit 1 is not "dead").
//     Promise  `docker exec <container> kill -0 <pid>` in the instance of this hostname: exit 0 ⇒ alive, exit 1 ⇒ dead (no such
//            process — or no running container, then its Chromium is gone too).
//   The instance is found by hostname, not by path: it stands in the lock, and it survives the recreation (`--hostname cbp-<n>` fixed).
//   Every row counts, not only converted ones: the lock says where a browser RAN, not where the next run runs.
//
// agentScanRoots()  the roots of the agent-browser scanner (browsers.js startAgentScan): per runtime location the profile root;
//   for a location with an instance (ops marker + converted, projectbox/run-instance.js runInstance) as
//   `{ root, host: <IP>, identifier }` — the scanner then asks the IP of the instance and keys by `agent:<identifier>:<dir>:<port>`
//   (the same port in B and in the instance are two browsers). Without an instance the root as a string: the scanner asks 127.0.0.1.
//   An instance whose row is unreadable or that carries no IP drops OUT for this pass — never falls back to 127.0.0.1 (there the same
//   port would hit a service of B).
//   PER INSTANCE OF THE CHAT: main and copies of a project share the runtime folder, but their browsers run in different containers
//   on different IPs. A profile `chat-<id>` (and `chat-<id>-agent-<aid>`) therefore belongs to the instance of ITS chat — the source
//   is set by `setBrowserChatInstance(fn)`: `fn(chatId, projectId)` → `"main"` | `"copy-<name>"` (empty = main). With a source there
//   is one entry per instance of the project with `only(dirName)` (browsers.js reads only the profiles for which it is true); a
//   profile whose instance cannot be resolved drops out — never to the IP of the main. Without a source everything is main, and the
//   root stands there as before. Profiles without a chat (the workspace stock) belong to the main.
//
// Guards: server/backend/test/browser-profiles.test.js, server/backend/test/projectbox-network-paths-browser.test.js.
import fs from "node:fs";
import * as store from "../store.js";
import { projectboxOps } from "./ops.js";
import { docker, isFrozen, isPausedError } from "./docker.js";
import { containerOf, runInstance } from "./run-instance.js";
import { allLocations, playwrightProfileRoot } from "../runs/runtime-location.js";
import { instanceIdentifierOf } from "../runs/instance.js";
import { profileParts } from "../browser-profiles.js";
import { BRIDGE_PREFIX, MAIN } from "./creation.js";

// The hostname of a project container (`--hostname cbp-<n>`, <n> the third octet of the project network) — from the ONE prefix
// (creation.js BRIDGE_PREFIX).
export const PROJECT_HOSTNAME = new RegExp(`^${BRIDGE_PREFIX}\\d{1,3}$`);

// Cap of the `kill -0`. Estimated, not measured: a `docker exec` costs about 83 ms at the median; a hundred times that covers a loaded
// host. When reached, the verdict is "unknown ⇒ alive" and the message says it was a cap.
export const LOCK_CAP_MS = 10_000;

// After a cap, for LOCK_PAUSE_MS NO lock asks docker — each counts as alive, the verdict the cap itself gave. The scanner
// (browsers.js startAgentScan) asks serially: with a hanging dockerd every instance profile with a lock cost the whole cap, again in
// every pass — six profiles, a minute per pass, and a new agent browser of a B chat would show up that late in the pill. The pause
// applies to ALL containers, not per container: every `docker exec` goes to the same inner dockerd, and a cap is almost always its
// own — per container the caps would add up again, only over the projects instead of the profiles. It is the safe side: no lock
// falls, no profile is cleared away, the scanner asks the port (and pauses 30 s after a failed attempt) — the length is the same. So
// a hanging dockerd costs at most one cap per pause. The message comes once per hang (until docker says 0 or 1 again).
export const LOCK_PAUSE_MS = 30_000;
let capPauseUntil = 0;
let pauseReported = false;

const reported = new Set();
const once = (key, text) => {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(text);
};

// Two cases in which the lock of a project container is DEAD without `kill -0` knowing:
//   - a `cbp-<n>` without an instance row with a READABLE store: the container does not exist (any more) — until now "unknown ⇒
//     alive", and the lock blocked the profile for ever. A read error of the store stays "alive" (empty is not unknown);
//   - the lock is older than the last start of the container (`State.StartedAt`, lstat mtime of the link): its Chromium ran in an
//     earlier life of the container — the same pid now belongs to another process (or the /24 with its hostname was reassigned).
//     No readable start (docker without a verdict) ⇒ `kill -0` as before.
export function foreignProfileLock({ host, pid, immediately = false, mtime = 0 } = {}) {
  if (!projectboxOps()) return null;
  const h = String(host || "");
  if (!PROJECT_HOSTNAME.test(h)) return null;
  let inst = null;
  try {
    inst = store.projectInstances().find((i) => i.hostname === h) || null;
  } catch (e) {
    once(`store:${h}`, `[project] browser lock ${h}-${pid}: instances not readable (${e?.message || e}) — counts as alive`);
    return true;
  }
  if (!inst) return false; // no row with a readable store ⇒ no container ⇒ dead
  if (immediately) return true;
  if (Date.now() < capPauseUntil) return true; // after a cap: unknown ⇒ alive, without asking (LOCK_PAUSE_MS)
  const container = containerOf(inst);
  // A frozen container answers no exec — the daemon says "is paused" with exit 1, and that used to mean "dead": the scanner
  // remembered the lock of a LIVING browser as abandoned (browsers.js abandonedLocks) and never asked again, releaseStaleLocks
  // deleted it. Frozen ⇒ unknown ⇒ alive, without asking docker (the scanner asks serially and must not wait at the barrier);
  // "is paused" without an entry (a pause cbase does not hold) likewise.
  if (isFrozen(container)) return true;
  const capHit = () => {
    capPauseUntil = Date.now() + LOCK_PAUSE_MS;
    if (!pauseReported) {
      pauseReported = true;
      console.warn(`[project] browser lock ${h}-${pid}: docker in ${container} at the cap (${LOCK_CAP_MS} ms) — for ${LOCK_PAUSE_MS / 1000} s every lock of a project container counts as alive, without asking docker`);
    }
    return true;
  };
  const start = !(Number(mtime) > 0) ? Promise.resolve({ further: true })
    : docker(["inspect", "-f", "{{.State.StartedAt}}", container], { capMs: LOCK_CAP_MS }).then(
      (r) => {
        const since = Date.parse(String(r?.stdout || "").trim());
        return { further: !(Number.isFinite(since) && since > 0 && Number(mtime) < since) };
      },
      (e) => (e?.code === "CAP" ? { verdict: capHit() } : { further: true }),
    );
  return start.then((s) => (s.further ? docker(["exec", container, "kill", "-0", String(pid)], { capMs: LOCK_CAP_MS }).then(
    () => { pauseReported = false; return true; },
    (e) => {
      if (isPausedError(e)) {
        once(`paused:${container}`, `[project] browser lock ${h}-${pid}: ${container} is paused — counts as alive`);
        return true;
      }
      if (e?.code === 1) { pauseReported = false; return false; }
      if (e?.code === "CAP") return capHit();
      once(`docker:${container}:${e?.code}`, `[project] browser lock ${h}-${pid}: kill -0 in ${container} without a verdict (${e?.message || e}) — counts as alive`);
      return true;
    },
  ) : ("verdict" in s ? s.verdict : false)));
}

// The source of the instance of a chat (set by the move-in) — without it every profile belongs to the main.
let chatInstanceSource = null;
export function setBrowserChatInstance(fn) { chatInstanceSource = typeof fn === "function" ? fn : null; }

// The instance of a profile folder: its chat's; without a chat (workspace stock) the main. Throws if the source throws.
function profileInstance(dirName, projectId) {
  const { chatId } = profileParts(dirName);
  if (!chatId) return MAIN;
  return String(chatInstanceSource(chatId, projectId) || MAIN);
}

export function agentScanRoots() {
  const roots = [];
  for (const location of allLocations()) {
    const root = playwrightProfileRoot(location);
    if (!location.projectId) { roots.push(root); continue; }
    let inst = null;
    try { inst = runInstance(location.projectId); } catch (e) {
      once(`read:${location.projectId}`, `[project] agent browser of ${location.projectId}: ${e?.message || e} — this root drops out`);
      continue;
    }
    if (!inst) { roots.push(root); continue; }
    if (!chatInstanceSource) {
      if (!inst.ip) {
        once(`ip:${location.projectId}`, `[project] agent browser of ${location.projectId}: instance without IP — this root drops out`);
        continue;
      }
      roots.push({ root, host: inst.ip, identifier: instanceIdentifierOf(inst) });
      continue;
    }
    roots.push(...rootsPerInstance(location.projectId, root, inst));
  }
  return roots;
}

// With a source: per instance that claims a profile of this root, one entry with its IP and `only` — the verdict per profile is
// made ONCE per pass (the source asks the store). An instance without a row or without an IP drops out with its profiles (never the
// IP of the main for a profile of a copy), likewise a profile whose instance the source does not name.
function rootsPerInstance(projectId, root, main) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const perInstance = new Map();
  for (const n of names) {
    let i;
    try { i = profileInstance(n, projectId); } catch (e) {
      once(`chat:${projectId}:${n}`, `[project] agent browser ${n}: instance of the chat not readable (${e?.message || e}) — this profile drops out`);
      continue;
    }
    if (!perInstance.has(i)) perInstance.set(i, new Set());
    perInstance.get(i).add(n);
  }
  const out = [];
  for (const [i, profile] of perInstance) {
    let inst = main;
    if (i !== MAIN) {
      try { inst = runInstance(projectId, i); } catch (e) {
        once(`read:${projectId}/${i}`, `[project] agent browser of ${projectId}/${i}: ${e?.message || e} — its profiles drop out`);
        continue;
      }
    }
    if (!inst) {
      once(`missing:${projectId}/${i}`, `[project] agent browser of ${projectId}/${i}: no instance row — its profiles drop out`);
      continue;
    }
    if (!inst.ip) {
      once(`ip:${projectId}/${i}`, `[project] agent browser of ${projectId}/${i}: instance without IP — its profiles drop out`);
      continue;
    }
    out.push({ root, host: inst.ip, identifier: instanceIdentifierOf(inst), only: (n) => profile.has(n) });
  }
  return out;
}
