// The guard against regrowth: no source file over 2,000 lines.
//
// Why a guard and not a rule in one's head: server.js once had 19,333 lines, and nobody decided that — it grew, one
// route after the other. A limit that only stands in a style guide holds nothing; one that turns `./check` red
// holds.
//
// The exception list `tools/check/loc-allow.json` carries a reason and a follow-up job per entry and is printed
// on EVERY run — a silent exception could not be told from a forgotten one. It may only shrink: an entry whose file
// now lies under the limit or is missing is an error (it would otherwise silently cover the next overrun).
import fs from "node:fs";
import path from "node:path";

export const LOC_LIMIT = 2000;

// Where sources live. Build outputs and foreign code stay out.
//
// WHOLE areas instead of an enumeration: with fine-grained roots, whatever grew beside them silently fell out. A
// guard that keeps a list of subfolders protects the list, not the tree. The guard for this is in
// tools/check/loc-gate.test.mjs: EVERY versioned source file of the repo must lie under one of these roots — that is
// no second copy, but a coverage check.
export const LOC_ROOTS = ["web", "mobile", "server", "client", "tools", "ops"];
export const LOC_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".swift", ".py", ".sh", ".css"]);
// Outputs, foreign code and copies. `build-context` is the Docker staging folder under server/backend
// (none of it is versioned), `out`/`web-out` the built web bundles, `dist` the Electron app.
export const SKIP_DIRS = new Set(["node_modules", ".next", "out", "dist", "build-context", "web-out", "DerivedData", ".git"]);

export function countLines(buf) {
  const s = buf.toString("utf8");
  if (!s.length) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith("\n") ? n : n + 1;
}

// All source files under the roots as [{ rel, rows }].
export function locScan(repo, roots = LOC_ROOTS) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name), `${rel}/${e.name}`);
        continue;
      }
      if (!e.isFile() || !LOC_EXTENSIONS.has(path.extname(e.name))) continue;
      out.push({ rel: `${rel}/${e.name}`.replace(/^\//, ""), rows: countLines(fs.readFileSync(path.join(abs, e.name))) });
    }
  };
  for (const r of roots) walk(path.join(repo, r), r);
  return out.sort((a, b) => b.rows - a.rows || (a.rel < b.rel ? -1 : 1));
}

export function readAllow(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(j.entries)) throw new Error(`${file}: field "entries" missing`);
  for (const e of j.entries) {
    for (const k of ["file", "reason", "fallsOutWith"]) {
      if (!e[k] || !String(e[k]).trim()) throw new Error(`${file}: entry ${e.file || "?"} without "${k}" — reason and follow-up job are mandatory`);
    }
  }
  return { limit: Number(j.limit) || LOC_LIMIT, entries: j.entries };
}

// Pure evaluation — what is over the limit, what is covered, which exception is dead.
export function locVerdict(files, allow) {
  const limit = allow.limit || LOC_LIMIT;
  const byRel = new Map(files.map((f) => [f.rel, f.rows]));
  const allowed = new Map(allow.entries.map((e) => [e.file, e]));
  const violations = files.filter((f) => f.rows > limit && !allowed.has(f.rel));
  const covered = files.filter((f) => f.rows > limit && allowed.has(f.rel)).map((f) => ({ ...f, ...allowed.get(f.rel) }));
  const tot = allow.entries
    .filter((e) => !byRel.has(e.file) || byRel.get(e.file) <= limit)
    .map((e) => ({ ...e, rows: byRel.get(e.file) ?? null }));
  return { limit, violations, covered, tot, ok: !violations.length && !tot.length };
}

export function locGate(repo, allowFile = path.join(repo, "tools/check/loc-allow.json")) {
  return locVerdict(locScan(repo), readAllow(allowFile));
}
