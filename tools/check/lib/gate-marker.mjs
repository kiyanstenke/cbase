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
// ONE PER MACHINE, NOT PER CLONE: the files live in a per-user folder (~/.cache/cbase-gate, CBASE_GATE_MARKER_DIR overrides it),
// like the gate lock is one per machine. A green gate in the development clone thus also serves a deploy from a rollout clone
// of the same commit. What a second clone can have differently is part of the key (`gateKey`): the outer working tree, the
// working tree of the private clone (the ops suites read it), the installed dependencies (`node_modules` is ignored by git, and
// two clones install separately) and the local environment the suites see (`envFingerprint`). The installation's own
// deploy.local.json is NOT part of it: the suites run without it (check.mjs sets CBASE_DEPLOY_LOCAL=off, config.mjs honours it),
// so a development clone without one and a rollout clone with one test the same thing. Equal key + equal node + within the hour
// = the same proof.
//
// SCOPE: a gate plan has a marker scope ("public" | "ops", lib/gate-plans.mjs). The marker names the scope and the suites
// it ran, and lives in a file per scope. It applies only to a request of the SAME scope whose suites it covers (marker suites
// ⊇ plan suites): a green public gate proves nothing about the private suites, and a marker of a smaller plan proves nothing
// about a larger one.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "../config-repo.mjs";
import { PRIVATE_ROOT } from "../cleanliness.mjs";
import { probe } from "./sh.mjs";

// One file per scope, in the per-machine folder (see the head).
export const MARKER_DIR = process.env.CBASE_GATE_MARKER_DIR || path.join(os.homedir(), ".cache", "cbase-gate");
export const MARKER_FILES = Object.freeze({
  public: path.join(MARKER_DIR, "gate-ok.json"),
  ops: path.join(MARKER_DIR, "ops-gate-ok.json"),
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

// The package folders whose installed dependencies the suites use (each has a tracked package-lock.json).
export const DEP_DIRS = Object.freeze(["server/backend", "web", "client"]);

// Fingerprint of what is INSTALLED: npm's hidden lockfile `node_modules/.package-lock.json` lists every installed package. Only
// path, version, integrity and resolved count — not the root name or the formatting, which differ between installs of the same
// tree. A folder without installed packages counts as "none" (so a clone without `npm ci` never matches one with).
export function depsFingerprint(repo = REPO, dirs = DEP_DIRS) {
  const h = crypto.createHash("sha256");
  for (const d of dirs) {
    h.update(`\0${d}\0`);
    let pk = null;
    try { pk = JSON.parse(fs.readFileSync(path.join(repo, d, "node_modules", ".package-lock.json"), "utf8")).packages; } catch {}
    if (!pk || typeof pk !== "object") { h.update("none"); continue; }
    for (const k of Object.keys(pk).sort()) {
      const e = pk[k] || {};
      h.update(`${k}\t${e.version ?? ""}\t${e.integrity ?? ""}\t${e.resolved ?? ""}\n`);
    }
  }
  return h.digest("hex").slice(0, 16);
}

// Native files npm does not record in its hidden lockfile: modes and sizes under `prebuilds/` and `build/Release/` of every
// installed package (node-pty's spawn-helper ships 0644 and must be made executable; a rebuild changes the binaries).
function nativeFiles(repo, dirs) {
  const out = [];
  const walk = (abs, rel, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const a = path.join(abs, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory() && depth < 6) walk(a, r, depth + 1);
      else if (e.isFile()) { const st = fs.statSync(a); out.push(`${r}\t${(st.mode & 0o777).toString(8)}\t${st.size}`); }
    }
  };
  for (const d of dirs) {
    const nm = path.join(repo, d, "node_modules");
    let pkgs = [];
    try { pkgs = fs.readdirSync(nm); } catch { continue; }
    for (const p of pkgs.sort()) {
      const names = p.startsWith("@") ? (() => { try { return fs.readdirSync(path.join(nm, p)).map((x) => `${p}/${x}`); } catch { return []; } })() : [p];
      for (const n of names) for (const sub of ["prebuilds", "build/Release"]) walk(path.join(nm, n, sub), `${d}/${n}/${sub}`, 0);
    }
  }
  return out;
}

// What the suites see from the machine that is not in a tree: the git version (tests drive git), the caller's CBASE_* variables
// (config.mjs and many tests read them), the symbolic links git ignores (the private overlay: hooks, skills — the hook tests run
// them), the native files of the dependencies, and git repositories ignored inside the private clone. Node is checked by the
// marker itself. Known limit: a file excluded only in ONE clone's .git/info/exclude (not .gitignore) that a suite reads from disk
// is seen by neither part — keep test files and fixtures out of info/exclude.
export async function envFingerprint(repo = REPO, dirs = DEP_DIRS) {
  const h = crypto.createHash("sha256");
  const gv = await probe("git", ["--version"]).catch(() => ({ code: 1, stdout: "" }));
  h.update(`git\t${gv.code === 0 ? String(gv.stdout).trim() : "?"}\n`);
  for (const k of Object.keys(process.env).filter((k) => k.startsWith("CBASE_")).sort()) h.update(`env\t${k}=${process.env[k]}\n`);
  const ig = await probe("git", ["-C", repo, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).catch(() => ({ code: 1 }));
  if (ig.code !== 0) return "";
  for (const p of String(ig.stdout).split("\0").filter(Boolean).map((x) => x.replace(/\/$/, "")).sort()) {
    try { if (fs.lstatSync(path.join(repo, p)).isSymbolicLink()) h.update(`link\t${p}\t${fs.readlinkSync(path.join(repo, p))}\n`); } catch {}
  }
  for (const f of nativeFiles(repo, dirs)) h.update(`native\t${f}\n`);
  // Git repositories the private clone keeps ignored inside itself (a bare clone of the old history that its suites read): its own
  // working-tree hash leaves them out. Name and HEAD count; other ignored local material (notes, logs) differs between clones
  // and is read by no suite.
  const priv = path.join(repo, PRIVATE_ROOT);
  if (fs.existsSync(path.join(priv, ".git"))) {
    const pig = await probe("git", ["-C", priv, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).catch(() => ({ code: 1 }));
    if (pig.code !== 0) return "";
    for (const p of String(pig.stdout).split("\0").filter((x) => x.endsWith("/")).sort()) {
      const dir = path.join(priv, p);
      if (!fs.existsSync(path.join(dir, "HEAD")) || !fs.existsSync(path.join(dir, "objects"))) continue;
      let head = "?";
      try { head = fs.readFileSync(path.join(dir, "HEAD"), "utf8").trim(); } catch {}
      h.update(`repo\t${p}\t${head}\n`);
    }
  }
  return h.digest("hex").slice(0, 16);
}

// The key a marker is written under and asked with: the outer working tree, the private clone's working tree when the tree has
// one, the installed dependencies, the environment. Empty when any part is unknown — and empty never applies. A private folder
// without its own git (copied, unpacked) cannot be hashed: unknown, so no marker serves it.
export async function gateKey(repo = REPO) {
  const tree = await workingTreeHash(repo);
  if (!tree) return "";
  let key = tree;
  if (fs.existsSync(path.join(repo, PRIVATE_ROOT))) {
    if (!fs.existsSync(path.join(repo, PRIVATE_ROOT, ".git"))) return "";
    const ops = await workingTreeHash(path.join(repo, PRIVATE_ROOT));
    if (!ops) return "";
    key += `+ops:${ops.slice(0, 16)}`;
  }
  const env = await envFingerprint(repo);
  if (!env) return "";
  return `${key}+deps:${depsFingerprint(repo)}+env:${env}`;
}

export function writeGateMarker({ hash, result, scope, suites, file, now = Date.now() }) {
  if (!hash) return null;
  if (!Array.isArray(suites) || !suites.length) throw new Error("writeGateMarker: the suites that were run must be named");
  const marker = { hash, result: result || "", stamp: now, node: process.version, scope, suites: [...suites], repo: REPO };
  const target = file || markerFile(scope);
  // The folder lies outside the clone (read-only home, full disk): a marker that cannot be written costs the next deploy a gate,
  // it must never turn a green gate red.
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(marker, null, 2) + "\n");
  } catch (e) {
    return { ...marker, notWritten: String(e?.message || e) };
  }
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
  if (marker.hash !== hash) return { applies: false, reason: `working tree changed (${keyDiff(marker.hash, hash)})` };
  if (marker.node !== process.version) return { applies: false, reason: `node changed (${marker.node} → ${process.version})` };
  const age = now - marker.stamp;
  if (age < 0 || age > maxAgeMs) return { applies: false, reason: `marker too old (${Math.round(age / 60000)} min)` };
  const clock = new Date(marker.stamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const where = marker.repo && marker.repo !== REPO ? ` in ${marker.repo}` : "";
  return { applies: true, reason: `full gate green at ${clock}${where} on the same working tree (${hash.slice(0, 12)}, ${Math.round(age / 60000)} min ago): ${marker.result}` };
}

// Which part of the key differs, readable: "tree 0123456789ab → fedcba987654", "deps …", "ops …".
function keyDiff(a, b) {
  const parts = (k) => Object.fromEntries(String(k).split("+").map((p, i) => (i === 0 ? ["tree", p] : p.split(/:(.*)/s).slice(0, 2))));
  const pa = parts(a), pb = parts(b);
  const names = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((n) => pa[n] !== pb[n]);
  return names.map((n) => `${n} ${(pa[n] ?? "none").slice(0, 12)} → ${(pb[n] ?? "none").slice(0, 12)}`).join(", ") || `${String(a).slice(0, 12)} → ${String(b).slice(0, 12)}`;
}
