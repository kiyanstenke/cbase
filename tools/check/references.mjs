#!/usr/bin/env node
// The reference guard: a public file points only at things a public clone has.
//
// Promise: outside the allowlist (references-allow.json, each entry with a reason) no public file
//   (a) names a private path of the tree (the list the private part of the tree carries — see cleanliness.mjs PRIVATE_PATHS),
//   (b) names, in a comment or a doc, a repository file that does not exist (`server/…`, `web/…`, `client/…`, `mobile/…`, `tools/…`
//       with a file extension; a path counts as existing when a file of the tree ends with it — comments often name paths relative to
//       their own folder), or
//   (c) names a test file or a measurement script by its file name when no public file of that name exists.
// CLAUDE.md and .claude/ are product terms (the project memory and settings of Claude Code in a user's project), so they count as
// private only where a line says the repository's own (`see CLAUDE.md`, `(CLAUDE.md, …)` in a comment of this tree) — that check is
// left to review; the guard skips them. Paths with placeholders (`*`, `<…>`, `{…}`, `${…}`) are patterns, not references, and are not checked.
//
//   node tools/check/references.mjs           report; exit 1 on any finding
//   node tools/check/references.mjs --list    every finding as file:line, kind, reference
//   node tools/check/references.mjs --json    machine-readable
// Guard: tools/check/references.test.mjs (counter-test with a planted private path, a missing file and a missing test name).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVATE_PATHS, publicFiles, REPO } from "./cleanliness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ALLOW_FILE = path.join(HERE, "references-allow.json");
const MAX_BYTES = 4 << 20;
const TEXT = /\.(m?js|cjs|ts|tsx|swift|json|md|txt|sh|sql|yml|yaml|toml|html|css|plist|service|cjs|py|rb|xcstrings|strings)$|(^|\/)[^./]+$/;
const ROOTS = ["server", "web", "client", "mobile", "tools"];
const EXT = "m?js|cjs|ts|tsx|swift|json|md|sh|sql|txt|html|css";
const REPO_PATH = new RegExp(`(?<![\\w./@-])((?:${ROOTS.join("|")})/[\\w./@+-]*?\\.(?:${EXT}))(?![\\w/-])`, "g");
const TEST_NAME = /(?<![\w./-])([\w.-]+\.test\.(?:m?js|cjs|js))(?![\w/-])/g;
const MEASUREMENT = /measurement script ([\w.-]+\.(?:m?js|cjs))/g;
const PLACEHOLDER = /[*<>{}$]/;
const PRODUCT_TERMS = new Set(["CLAUDE.md", ".claude/"]);
const COMMENT = /^\s*(\/\/|\/\*|\*|#|<!--|--)|\s\/\/\s|\/\*.*\*\//;

/** The allowlist: `{ files: [{ file, reason }], lines: [{ file, pattern, reason }] }`, regexes compiled. */
export function loadAllow(file = ALLOW_FILE) {
  if (!fs.existsSync(file)) return { files: [], lines: [] };
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const need = (e) => { if (typeof e.reason !== "string" || e.reason.length < 10) throw new Error(`${path.basename(file)}: entry without a reason: ${JSON.stringify(e)}`); };
  return {
    files: (raw.files || []).map((e) => { need(e); return { re: new RegExp(e.file), ...e }; }),
    lines: (raw.lines || []).map((e) => { need(e); return { fileRe: new RegExp(e.file), re: new RegExp(e.pattern), ...e }; }),
  };
}

/** A private path as a token in text: `a/` matches `a/x`, `CLAUDE.md` matches `CLAUDE.md`, never inside a longer word or path. */
function privateMatchers(privatePaths) {
  return privatePaths.filter((p) => !PRODUCT_TERMS.has(p)).map((p) => {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { p, re: new RegExp(`(?<![\\w.@/-])${esc}${p.endsWith("/") ? "" : "(?![\\w-])"}`) };
  });
}

/**
 * Scans `files` (repo-relative) under `root`. `exists(rel)` answers whether a repo path exists, `basenames` is the set of every file
 * name in the tree. Returns `{ findings: [{ file, line, kind, ref }], allowed }`.
 */
export function scan({ root = REPO, files = publicFiles(root), privatePaths = PRIVATE_PATHS, allow = loadAllow(), basenames = null, exists = null } = {}) {
  const every = listAll(root);
  const all = basenames ?? new Set(every.map((f) => path.basename(f)));
  const has = exists ?? ((rel) => fs.existsSync(path.join(root, rel)) || every.some((f) => f.endsWith(`/${rel}`)));
  const priv = privateMatchers(privatePaths);
  const findings = [];
  let allowed = 0;
  for (const file of files) {
    if (!TEXT.test(file) || allow.files.some((e) => e.re.test(file))) continue;
    const abs = path.join(root, file);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const text = fs.readFileSync(abs, "utf8");
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    const doc = /\.(md|txt)$/.test(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hits = [];
      for (const m of priv) if (m.re.test(line)) hits.push({ kind: "private", ref: m.p });
      if (doc || COMMENT.test(line)) for (const m of line.matchAll(REPO_PATH)) {
        const ref = m[1].replace(/[.,;:)]+$/, "");
        if (!PLACEHOLDER.test(ref) && !priv.some((x) => ref.startsWith(x.p)) && !has(ref)) hits.push({ kind: "missing-file", ref });
      }
      for (const re of [TEST_NAME, MEASUREMENT]) {
        for (const m of line.matchAll(re)) {
          const ref = m[1];
          if (!PLACEHOLDER.test(ref) && !all.has(ref) && !hits.some((h) => h.ref.endsWith(ref))) hits.push({ kind: re === TEST_NAME ? "missing-test" : "missing-script", ref });
        }
      }
      for (const h of hits) {
        if (allow.lines.some((e) => e.fileRe.test(file) && e.re.test(line))) { allowed++; continue; }
        findings.push({ file, line: i + 1, ...h });
      }
    }
  }
  return { findings, allowed };
}

/** The public files: what a clone has. A name or path counts as existing only when a PUBLIC file carries it. */
function listAll(root) {
  return publicFiles(root);
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = scan();
  const args = process.argv.slice(2);
  if (args.includes("--json")) console.log(JSON.stringify({ findings: r.findings.length, allowed: r.allowed, byKind: count(r.findings, "kind") }));
  else if (args.includes("--list")) for (const f of r.findings) console.log(`${f.file}:${f.line}\t${f.kind}\t${f.ref}`);
  else {
    console.log(`references: ${r.findings.length} findings (${r.allowed} allowlisted)`);
    for (const [k, n] of Object.entries(count(r.findings, "kind"))) console.log(`  ${k.padEnd(15)} ${n}`);
    for (const [k, n] of Object.entries(count(r.findings, "file")).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  process.exit(r.findings.length ? 1 : 0);
}
function count(list, key) { const o = {}; for (const x of list) o[x[key]] = (o[x[key]] || 0) + 1; return o; }
