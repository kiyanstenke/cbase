// The gate marker: a full, green gate remembers the working tree it ran on.
//
// A gate proves something about bytes, not about the clock; the same bytes need no second proof. The marker says
// "these bytes, this result, this time" — and `deploy` repeats the gate only if the bytes changed or the marker is
// older than an hour (the environment ages: node, node_modules, simulator — none of it is in the tree).
//
// The tree is the WORKING TREE, not HEAD: `git write-tree` over a throwaway index with `git add -A` captures changed,
// new and deleted files, leaves out ignored ones (node_modules, .deploy-logs, deploy.local.json) and needs no hash
// loop of its own. `--quick` writes NO marker — a quick check proves no tests.
//
// SCOPE: a gate plan has a marker scope ("public" | "ops", lib/gate-plans.mjs). The marker names the scope and the suites
// it ran, and lives in a file per scope. It applies only to a request of the SAME scope whose suites it covers (marker suites
// ⊇ plan suites): a green public gate proves nothing about the private suites, and a marker of a smaller plan proves nothing
// about a larger one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "../config-repo.mjs";
import { probe } from "./sh.mjs";

// One file per scope; the public one keeps its old name.
export const MARKER_FILES = Object.freeze({
  public: path.join(REPO, ".deploy-logs", "gate-ok.json"),
  ops: path.join(REPO, ".deploy-logs", "ops-gate-ok.json"),
});
export function markerFile(scope) {
  const f = MARKER_FILES[scope];
  if (!f) throw new Error(`unknown marker scope: ${JSON.stringify(scope)}`);
  return f;
}
export const MARKER_MAX_OLD_MS = 60 * 60 * 1000;

// Hash of the working tree (tracked + untracked, without ignored files). Empty on any error —
// and empty means "unknown", never "equal": without a hash there is no marker and no skipping.
export async function workingTreeHash(repo = REPO) {
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-index-")), "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const r1 = await probe("git", ["-C", repo, "read-tree", "HEAD"], { env });
    if (r1.code !== 0) return "";
    const r2 = await probe("git", ["-C", repo, "add", "-A"], { env });
    if (r2.code !== 0) return "";
    const r3 = await probe("git", ["-C", repo, "write-tree"], { env });
    if (r3.code !== 0) return "";
    return String(r3.stdout).trim();
  } catch {
    return "";
  } finally {
    try { fs.rmSync(path.dirname(index), { recursive: true, force: true }); } catch {}
  }
}

export function writeGateMarker({ hash, result, scope, suites, file, now = Date.now() }) {
  if (!hash) return null;
  if (!Array.isArray(suites) || !suites.length) throw new Error("writeGateMarker: the suites that were run must be named");
  const marker = { hash, result: result || "", stamp: now, node: process.version, scope, suites: [...suites] };
  const target = file || markerFile(scope);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(marker, null, 2) + "\n");
  return marker;
}

export function readGateMarker(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    return m && typeof m.hash === "string" && Number.isFinite(m.stamp) ? m : null;
  } catch {
    return null;
  }
}

// Does the marker apply to this tree? Answer with a reason — the reason goes into the log so that
// "gate skipped" never appears without the bytes and the clock that justify it.
//
// `scope` and `suites` are the REQUEST (the plan about to be skipped): without them nothing applies — a caller that forgets
// to say what it needs is not served from a marker.
export function gateMarkerApplies(marker, hash, { scope, suites, now = Date.now(), maxAgeMs = MARKER_MAX_OLD_MS } = {}) {
  if (!hash) return { applies: false, reason: "working-tree hash unknown" };
  if (!marker) return { applies: false, reason: "no marker" };
  if (!scope || !Array.isArray(suites) || !suites.length) return { applies: false, reason: "the request names no scope or suites" };
  if (marker.scope !== scope) return { applies: false, reason: `marker scope ${marker.scope ?? "none"} ≠ requested scope ${scope}` };
  const ranSuites = Array.isArray(marker.suites) ? marker.suites : [];
  const missing = suites.filter((s) => !ranSuites.includes(s));
  if (missing.length) return { applies: false, reason: `marker lacks suites: ${missing.join(", ")}` };
  if (marker.hash !== hash) return { applies: false, reason: `working tree changed (${marker.hash.slice(0, 12)} → ${hash.slice(0, 12)})` };
  if (marker.node !== process.version) return { applies: false, reason: `node changed (${marker.node} → ${process.version})` };
  const age = now - marker.stamp;
  if (age < 0 || age > maxAgeMs) return { applies: false, reason: `marker too old (${Math.round(age / 60000)} min)` };
  const clock = new Date(marker.stamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return { applies: true, reason: `full gate green at ${clock} on the same working tree (${hash.slice(0, 12)}, ${Math.round(age / 60000)} min ago): ${marker.result}` };
}
