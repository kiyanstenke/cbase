// File access of a copy. A leaf under `runtime/` (no domain knowledge): imports only `./git-run.js` (commandRun) and node:* —
// the instance comes as an object from the caller, never from the store.
//
// WHY. The loop engine's file tools (providers/tool-runtime.js), the code editor (files.js), the channel files and the project
// memory run in B. B sees the main instance; a copy's overlay view (stacks/: lowerdir main, upperdir copy) is mounted only IN
// the copy's container. A chat in its copy whose Read/Write/Edit ran in B would read and write the main instance. So every
// access to a path under a copy's project folder goes through its container.
//
// THE PATH: one Node program per call via `commandRun` (`node -e PROGRAM -- <op> <options> <path…>`, the pattern of
// workflows/worktree.js) — no long-running service. The paths are in argv (absolute), the options as JSON in argv, the bytes
// of a write on stdin, the answer is ONE line of JSON on stdout. NO fallback: if the call fails (container down, program
// aborts, cap), it throws `FileAccessError` — never a read or write in B in its place.
//
// THE OPERATIONS (all async, paths absolute in the container's namespace = that of B):
//   read(inst, path, { maxBytes })         → { kind, size, data?, sha256?, tooBig? } — follows symlinks like B; a folder or a
//                                            FIFO is not opened (kind "folder"/"otherwise"); above `maxBytes` no bytes come
//                                            back (tooBig)
//   write(inst, path, data, { expect, append })
//                                          → { size, sha256 }; missing folders are created. `expect`: the sha256 of the content
//                                            that must be there now, or null (the file must not exist) — otherwise ECONFLICT
//                                            (compared in the container, no window between reading and writing in B)
//   edit(inst, path, fn, { maxBytes })     read → fn(text) → write with expect = sha256 of what was read (compare-and-swap):
//                                            if the file changed in between, ECONFLICT instead of a silent overwrite
//   readSeveral(inst, paths, { maxBytes }) the project memory — several candidates in one call, each `{ real, data }` or `null`
//                                            (in the order of the paths)
//   stat / list / create / name / erase    for the code editor (files.js) — what B does with fs
//   list(inst, folder, { chains: { depth, max, heavy } })  per folder entry the chain of single subfolders (`chain`: names)
//                                            like files.js chainsAlongside; every entry carries `mode`. `stat` carries `real`
//                                            (realpath or null), `write` takes `mode` (effective only on create)
//   list(inst, folder, { repoInfo: true, root })  per folder entry also `isRepo` (`<entry>/.git` is a folder, lstat) and
//                                            `worktreeOf` (`.git` is a file whose `gitdir:` points into
//                                            `<repo>/.git/worktrees/<n>` of a repo UNDER `root` — that repo's path relative
//                                            to `root`, "." for the root itself)
//   glob / grep / search / names           tree walks in the container (Glob, Grep, the editor's full-text search, @-mentions)
//                                            — only the result comes back, not the tree
//   fileWay(inst, abs, { project, runtime })  "copy" | "b": paths in the RUNTIME FOLDER stay in B (it is the same mount for
//                                            main and copy), paths under (or above) a copy's project folder go through the
//                                            copy (if one anchor lies in the other, the deeper one wins); without a copy
//                                            instance always "b"
//
// CAPS that report themselves: deadline and output cap of commandRun; if one hits, the error says so (`code: "CAP"`) — no
// silent truncation. Every operation takes `withoutDeadline` (no timer — for content whose size the user determines) and
// `signal` (AbortSignal: ends the group in the container, error `code: "ABORTED"`) and passes both to commandRun. The cores
// of the tree walks (globCore, grepCore, searchCore, namesCore) have their own counters (files, hits).
//
// THE CORES. Their TEXT goes (Function#toString) into the program in the container, so they are functions WITHOUT references
// to anything outside their parameters and the other cores (fs, path, crypto as parameters). `programCore` is the dispatch
// and also runs in B against a folder in tests. Guard: server/backend/test/fileAccess.test.js (overlay view of the fake
// docker; the cores in step with the loop engine's tools and with files.js in B).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { commandRun } from "./git-run.js";
import { fastPattern, fastOpen, fastMatches } from "./fast-open.js";

export const READ_MAX = 32 * 1024 * 1024; // default for read(): nothing larger comes over the wire
export const DEADLINE_SMALL_MS = 60_000;
export const DEADLINE_TREE_MS = 120_000;
const OUTPUT_MAX = 16 * 1024 * 1024;

// ── The cores (pure, no outside references — their text goes into the program) ──────────────────────────────────────────────

/**
 * glob → a checker with `test(text)` (like a RegExp); ONE version for the tools in B and the program in the container.
 * `*` = any number of characters except `/`, `?` = one except `/`, `**` = any number of any characters (a following `/` is
 * part of it: `**\/*.ts` also matches `a.ts`). Everything else is LITERAL — also `[`, `]`, `{`, `}` (no character classes, no
 * alternation).
 *
 * Not a RegExp: `**` and `*` would become nested `.*`, and a pattern like `**\/**\/**\/*.ts` would need unbounded backtracking
 * against every path that does NOT match — synchronously in B. Instead an automaton: once per character of the path over the
 * set of reachable pattern positions — at most length(pattern) × length(path) steps, for any pattern. `**` does not match a
 * line ending (like `.` in a RegExp). The function is self-contained (its text goes into the program in the container, see
 * PROGRAM).
 */
export function globToRegExp(glob) {
  const g = String(glob ?? "");
  const kind = [];   // "lit" | "q" | "star" | "everything"
  const character = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { kind.push("everything"); character.push(""); i++; if (g[i + 1] === "/") i++; }
      else { kind.push("star"); character.push(""); }
    } else if (c === "?") { kind.push("q"); character.push(""); }
    else { kind.push("lit"); character.push(c); }
  }
  const n = kind.length;
  const lineEnding = (c) => c === "\n" || c === "\r" || c === " " || c === " "; // like `.` in a RegExp
  // A star position may take zero characters: whoever reaches it also reaches the next one (forwards, in one pass).
  const close = (m) => { for (let i = 0; i < n; i++) if (m[i] && (kind[i] === "star" || kind[i] === "everything")) m[i + 1] = 1; };
  const test = (text) => {
    const s = String(text);
    let now = new Uint8Array(n + 1);
    let next = new Uint8Array(n + 1);
    now[0] = 1;
    close(now);
    for (let p = 0; p < s.length; p++) {
      const c = s[p];
      next.fill(0);
      let alive = false;
      for (let i = 0; i < n; i++) {
        if (!now[i]) continue;
        const a = kind[i];
        if (a === "everything") { if (!lineEnding(c)) { next[i] = 1; alive = true; } }
        else if (a === "star") { if (c !== "/") { next[i] = 1; alive = true; } }
        else if (a === "q") { if (c !== "/") { next[i + 1] = 1; alive = true; } }
        else if (character[i] === c) { next[i + 1] = 1; alive = true; }
      }
      if (!alive) return false;
      close(next);
      const t = now; now = next; next = t;
    }
    return now[n] === 1;
  };
  return { test, source: g };
}

// A glob like VS Code: `**` only as a whole segment (`**/x`, `x/**`, `a/**/b`, `**` alone) — inside a segment (`a**b`) it acts
// like `*`; `*` and `?` do not match `/`; `[abc]`, `[a-z]`, `[!a]`/`[^a]` are character classes (a `]` right after `[` or `[!`
// is literal, and so is a `[` without a closing bracket). `{a,b}` is expanded by the caller beforehand. With `escape` (the
// ignore files, gitignore form) `\` takes the next character literally. Not a RegExp (see globToRegExp) — an automaton over
// the pattern positions, ONE step over the reachable positions per character of the path. Self-contained (its text goes into
// the program in the container).
export function searchGlob(glob, opt) {
  const escape = Boolean(opt && opt.escape);
  const g = String(glob ?? "");
  const segments = g.split("/");
  const tok = []; // { a: "lit"|"q"|"star"|"kind"|"everything"|"front"|"rear", c?, set?, not? } — "kind" is a character class
  segments.forEach((s, i) => {
    const last = i === segments.length - 1;
    if (s === "**") {
      if (segments.length === 1) { tok.push({ a: "everything" }); return; }
      if (!last) { if (i > 0) tok.push({ a: "lit", c: "/" }); tok.push({ a: "front" }); return; } // "**/": nothing, or whole segments with their "/"
      tok.push({ a: "rear" }); return; // "/**": nothing, or "/" and everything after it
    }
    if (i > 0 && segments[i - 1] !== "**") tok.push({ a: "lit", c: "/" });
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (escape && c === "\\" && j + 1 < s.length) { tok.push({ a: "lit", c: s[++j] }); continue; }
      if (c === "*") { while (s[j + 1] === "*") j++; tok.push({ a: "star" }); continue; }
      if (c === "?") { tok.push({ a: "q" }); continue; }
      if (c === "[") {
        let k = j + 1;
        const not = s[k] === "!" || s[k] === "^";
        if (not) k++;
        const beginning = k;
        if (s[k] === "]") k++;
        while (k < s.length && s[k] !== "]") k++;
        if (k < s.length) {
          const content = s.slice(beginning, k), set = [];
          for (let m = 0; m < content.length; m++) {
            if (content[m + 1] === "-" && m + 2 < content.length) { set.push([content[m], content[m + 2]]); m += 2; }
            else set.push([content[m], content[m]]);
          }
          tok.push({ a: "kind", set, not });
          j = k;
          continue;
        }
      }
      tok.push({ a: "lit", c });
    }
  });
  const n = tok.length;
  // States 0…n (n = at the end), plus one loop state n + 1 + i per "front"/"rear".
  const loop = (i) => n + 1 + i;
  const wrapper = (set) => {
    const stack = [...set];
    while (stack.length) {
      const s = stack.pop();
      let further = -1;
      if (s < n && (tok[s].a === "star" || tok[s].a === "everything" || tok[s].a === "front" || tok[s].a === "rear")) further = s + 1;
      else if (s > n && tok[s - n - 1].a === "rear") further = s - n; // loop of "rear" (i) ⇒ i + 1
      if (further >= 0 && !set.has(further)) { set.add(further); stack.push(further); }
    }
    return set;
  };
  const inClass = (t, c) => { const inside = t.set.some(([from, until]) => c >= from && c <= until); return t.not ? !inside : inside; };
  const test = (filePath) => {
    const p = String(filePath);
    let now = wrapper(new Set([0]));
    for (const c of p) {
      const next = new Set();
      for (const s of now) {
        if (s > n) { next.add(s); if (c === "/" && tok[s - n - 1].a === "front") next.add(s - n); continue; } // loop
        if (s === n) continue;
        const t = tok[s];
        if (t.a === "lit") { if (c === t.c) next.add(s + 1); }
        else if (t.a === "q") { if (c !== "/") next.add(s + 1); }
        else if (t.a === "star") { if (c !== "/") next.add(s); }
        else if (t.a === "kind") { if (c !== "/" && inClass(t, c)) next.add(s + 1); }
        else if (t.a === "everything") next.add(s);
        else if (t.a === "front") next.add(loop(s));
        else if (t.a === "rear") { if (c === "/") next.add(loop(s)); }
      }
      if (!next.size) return false;
      now = wrapper(next);
    }
    return now.has(n);
  };
  return { test, source: g };
}

// The search pattern of the editor's full-text search: the matches of a line including "whole word", and the filters "files to
// include/exclude" over the path relative to the root. ONE version for files.js (B) and `searchCore` (the program in the
// container — hence self-contained like the other cores). The same matches as web/src/lib/file-search.ts (highlighting and
// "replace all" in the web client): web/test/file-search.test.mjs runs BOTH against the same lines; the rules here are held by
// server/backend/test/file-search-fields.test.js.
//   - "Whole word" like VS Code: on the left the start of the line, a separator before, or a separator as the first character
//     of the match; the same on the right. Separators = VS Code's `editor.wordSeparators` and whitespace.
//   - Globs like VS Code (`searchGlob`), comma-separated — a comma inside `{…}` or `[…]` does not separate, `{a,b}` is
//     expanded; `./x` applies from the root, otherwise at any depth (`**/x`); a pattern matches the path itself or everything
//     below it (`x/**`). An excluded folder is not entered. "Find in folder…" escapes special characters as a class (`[,]`).
//   - Without regex mode the input is literal (escaped); case via the flag `i`.
export function searchPattern(o) {
  const q = String(o.query || "");
  let re;
  try { re = new RegExp(o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.caseSensitive ? "g" : "gi"); }
  catch (e) { return { error: "Invalid regular expression: " + e.message }; }
  const SEPARATOR = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";
  const separator = (c) => c === undefined || SEPARATOR.includes(c) || /\s/.test(c);
  const wholeTerm = (z, s, e) => (s === 0 || separator(z[s - 1]) || (e > s && separator(z[s])))
    && (e === z.length || separator(z[e]) || (e > s && separator(z[e - 1])));
  const findings = (row, max = Infinity) => {
    const out = [];
    re.lastIndex = 0;
    let m;
    while (out.length < max && (m = re.exec(row)) !== null) {
      const s = m.index, e = s + m[0].length;
      if (!o.wholeWord || wholeTerm(row, s, e)) out.push(m.length > 1 ? { start: s, end: e, groups: m.slice(1) } : { start: s, end: e });
      if (e === s) { if (s >= row.length) break; re.lastIndex = s + 1; }
    }
    return out;
  };
  // A character class from `[` at j (as in `searchGlob`: `!`/`^`, a `]` right after is literal) — its end or -1 (no closing
  // bracket: literal). A comma or a brace INSIDE a class neither separates nor expands.
  const classesEnd = (s, j) => { let k = j + 1; if (s[k] === "!" || s[k] === "^") k++; if (s[k] === "]") k++; while (k < s.length && s[k] !== "]") k++; return k < s.length ? k : -1; };
  const parts = (s0) => {
    const s = String(s0 || ""), out = [];
    let depth = 0, current = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "[") { const k = classesEnd(s, i); if (k >= 0) { current += s.slice(i, k + 1); i = k; continue; } }
      if (c === "{") depth++; else if (c === "}") depth = Math.max(0, depth - 1);
      if (c === "," && depth === 0) { out.push(current); current = ""; } else current += c;
    }
    out.push(current);
    return out.map((x) => x.trim()).filter(Boolean);
  };
  const brackets = (g, n) => { // the innermost `{…}` before the first `}` (no nesting), parts by comma — classes do not count
    let on = -1;
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === "[") { const k = classesEnd(g, i); if (k >= 0) { i = k; continue; } }
      if (c === "{") on = i;
      else if (c === "}" && on >= 0) {
        if (n > 5) return [g];
        const inside = g.slice(on + 1, i), chunks = [];
        let current = "";
        for (let j = 0; j < inside.length; j++) {
          if (inside[j] === "[") { const k = classesEnd(inside, j); if (k >= 0) { current += inside.slice(j, k + 1); j = k; continue; } }
          if (inside[j] === ",") { chunks.push(current); current = ""; } else current += inside[j];
        }
        chunks.push(current);
        return chunks.flatMap((x) => brackets(g.slice(0, on) + x + g.slice(i + 1), n + 1));
      }
    }
    return [g];
  };
  const pattern = (s) => parts(s).flatMap((g0) => brackets(g0.replace(/\\/g, "/"), 0).slice(0, 64).map((g) => {
    let p = g, anchored = false;
    if (p.startsWith("./")) { p = p.slice(2); anchored = true; } else if (p.startsWith("/")) { p = p.replace(/^\/+/, ""); anchored = true; }
    while (p.startsWith("**/")) { p = p.slice(3); anchored = false; }
    p = p.replace(/\/+$/, "");
    if (!p || p === "**") return { everything: true };
    return { anchored, re: searchGlob(p), under: searchGlob(p + "/**") };
  }));
  const one = pattern(o.include), result = pattern(o.exclude);
  const matches = (rel, m) => {
    if (m.everything) return true;
    const candidates = [rel];
    if (!m.anchored) for (let i = rel.indexOf("/"); i >= 0; i = rel.indexOf("/", i + 1)) candidates.push(rel.slice(i + 1));
    return candidates.some((k) => m.re.test(k) || m.under.test(k));
  };
  return {
    findings,
    hits: (row) => findings(row, 1).length > 0,
    pathMatches: (rel) => (!one.length || one.some((m) => matches(rel, m))) && !result.some((m) => matches(rel, m)),
    folderFrom: (rel) => result.some((m) => matches(rel, m)),
  };
}

// What the search enters at all (like VS Code): with the switch "use exclude settings and ignore files" (`o.exclusions`, on by
// default as in VS Code) the defaults of `files.exclude` and `search.exclude` (`STANDARD`) and the ignore files
// (`search.useIgnoreFiles`: per folder `.git/info/exclude`, `.gitignore`, `.ignore` — in this order, a deeper folder after a
// higher one, the last matching rule wins, `!` takes back, an ignored folder is not entered); off: none of it (`.git` is
// searched too, like VS Code). There are no fixed exclusions beyond that (dist, build, out, vendor) — they are usually in
// .gitignore. `readText(abs)` reads an ignore file (null: none) — in B without symlinks (files.js), in the container via fs.
// Self-contained (program in the container).
export function searchArea(root, o, readText, connect) {
  const enabled = o.exclusions !== false;
  const STANDARD = ["**/.git", "**/.svn", "**/.hg", "**/.DS_Store", "**/Thumbs.db", "**/node_modules", "**/bower_components", "**/*.code-search"].map((g) => searchGlob(g));
  const nameText = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
  const parent = (rel) => { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); };
  const rules = (text) => {
    const out = [];
    for (let z of String(text).split("\n")) {
      if (z.endsWith("\r")) z = z.slice(0, -1);
      if (!z || z.startsWith("#")) continue;
      z = z.replace(/(?<!\\)\s+$/, "");
      let neg = false;
      if (z.startsWith("!")) { neg = true; z = z.slice(1); }
      else if (z.startsWith("\\!") || z.startsWith("\\#")) z = z.slice(1);
      let onlyFolder = false;
      if (z.endsWith("/")) { onlyFolder = true; z = z.replace(/\/+$/, ""); }
      if (!z) continue;
      const anchored = z.includes("/");
      out.push({ neg, onlyFolder, anchored, glob: searchGlob(z.replace(/^\//, ""), { escape: true }) });
    }
    return out;
  };
  const cache = new Map();
  const stack = (folder) => { // the rule sets for entries IN `folder`, from the root downwards
    if (cache.has(folder)) return cache.get(folder);
    const top = folder ? stack(parent(folder)) : [];
    const own = [];
    for (const file of [".git/info/exclude", ".gitignore", ".ignore"]) {
      const text = readText(connect(root, folder, file));
      if (text) own.push(...rules(text));
    }
    const s = own.length ? [...top, { base: folder, rules: own }] : top;
    cache.set(folder, s);
    return s;
  };
  const ignored = (rel, isFolder) => {
    let res = false;
    for (const { base, rules: r } of stack(parent(rel))) {
      const relB = base ? rel.slice(base.length + 1) : rel;
      for (const x of r) {
        if (x.onlyFolder && !isFolder) continue;
        if (x.anchored ? x.glob.test(relB) : x.glob.test(nameText(relB))) res = !x.neg;
      }
    }
    return res;
  };
  const standard = (rel) => STANDARD.some((g) => g.test(rel));
  const folderFrom = (rel) => enabled && (standard(rel) || ignored(rel, true));
  const fileFrom = (rel) => enabled && (standard(rel) || ignored(rel, false));
  return {
    folderFrom,
    fileFrom,
    /** A file with its folders in the area (the open buffers) — with the pattern's filters. */
    inArea: (rel, m) => {
      const segments = rel.split("/");
      for (let i = 1; i < segments.length; i++) { const d = segments.slice(0, i).join("/"); if (folderFrom(d) || m.folderFrom(d)) return false; }
      return !fileFrom(rel) && m.pathMatches(rel);
    },
  };
}

// The hits of ONE file: per line with hits `{ line, text, hits: [[from, to], …] }` — the columns of every match in the WHOLE
// line (a `\r` at the end of the line is dropped first), the line's text at most `PREVIEW` characters (the preview; replacing
// happens in the buffer at the columns). `slot` = how many hits are still allowed (the search cap). Self-contained (program
// in the container).
export function searchLines(text, pattern, slot) {
  const PREVIEW = 1000;
  const out = [];
  let n = 0;
  const rows = String(text).split("\n");
  for (let i = 0; i < rows.length && n < slot; i++) {
    let z = rows[i];
    if (z.endsWith("\r")) z = z.slice(0, -1);
    const f = pattern.findings(z, slot - n);
    if (!f.length) continue;
    out.push({ line: i + 1, text: z.length > PREVIEW ? z.slice(0, PREVIEW) : z, hits: f.map((x) => [x.start, x.end]) });
    n += f.length;
  }
  return { rows: out, n };
}

// The walk of the loop engine (tool-runtime.js walkFiles): stack, files in directory order, heavy and hidden folders skipped.
function stackWalk(fs, path, root, o, atFile) {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!o.skip.includes(e.name) && !e.name.startsWith(".")) stack.push(p); }
      else if (e.isFile()) { if (++n > o.maxFiles) return; atFile(p); }
    }
  }
}

// Glob (tool-runtime.js globTool): hits by modification time, newest first. The paths come back RELATIVE to the root (B puts
// them back on): what the container sees for a path is not in the answer. Against the absolute path the location B names
// (`o.anchor`) is checked, not the one under which the container has the root.
// `o.suffixes` (list of lower-case suffixes without the dot) instead of `o.pattern` — ONE walk for several suffixes (the
// Markdown server's search in a copy: thirteen suffixes like VS Code's `markdownFileExtensions`).
function globCore(fs, path, root, o) {
  const re = globToRegExp(o.pattern);
  const anchor = o.anchor || root;
  const suffixes = Array.isArray(o.suffixes) ? o.suffixes.map((e) => "." + String(e).toLowerCase()) : null;
  const hits = [];
  stackWalk(fs, path, root, o, (p) => {
    const rel = path.relative(root, p);
    if (suffixes ? suffixes.includes(path.extname(p).toLowerCase()) : re.test(rel) || re.test(path.join(anchor, rel)) || re.test(path.basename(p))) {
      let m = 0;
      try { m = fs.lstatSync(p).mtimeMs; } catch { /* file gone in the meantime */ }
      hits.push({ rel, m });
    }
  });
  hits.sort((x, y) => y.m - x.m);
  return { total: hits.length, hits: hits.slice(0, o.maxHits) };
}

// Grep (tool-runtime.js grepTool, without the rendering): per file the hit lines with context. `file` is relative to the
// target ("" = the target itself, a single file); `lines` holds `[seq, ":" | "-", text]` and the word "--" between the groups —
// B assembles the lines. Invalid expression → { error }.
function grepCore(fs, path, target, o) {
  let individual = false;
  try { individual = fs.statSync(target).isFile(); } catch { /* target missing — empty walk */ }
  const root = individual ? path.dirname(target) : target;
  let re;
  try { re = new RegExp(o.pattern, `${o.ci ? "i" : ""}${o.multiline ? "sm" : ""}g`); } catch (e) { return { error: `Invalid RegExp: ${e.message}` }; }
  const inclusion = o.glob ? globToRegExp(o.glob) : null;
  const proFile = [];
  let total = 0;
  let cutOff = false;
  const scan = (p) => {
    if (cutOff) return;
    const rel = path.relative(root, p);
    if (o.exts && !o.exts.includes(path.extname(p).slice(1).toLowerCase())) return;
    if (inclusion && !(inclusion.test(rel) || inclusion.test(path.basename(p)))) return;
    let content;
    try { const raw = fs.readFileSync(p); if (raw.includes(0)) return; content = raw.toString("utf8"); } catch { return; }
    const rows = content.split("\n");
    const hits = new Set();
    re.lastIndex = 0;
    if (o.multiline) {
      for (let m; (m = re.exec(content)) !== null;) {
        const from = content.slice(0, m.index).split("\n").length;
        const until = from + (m[0].split("\n").length - 1);
        for (let l = from; l <= until; l++) hits.add(l);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    } else {
      for (let i = 0; i < rows.length; i++) { re.lastIndex = 0; if (re.test(rows[i])) hits.add(i + 1); }
    }
    if (!hits.size) return;
    const entry = { file: individual ? "" : rel, count: hits.size, lines: [] };
    if (o.mode === "content") {
      const show = new Set();
      for (const l of hits) for (let k = l - o.prior; k <= l + o.after; k++) if (k >= 1 && k <= rows.length) show.add(k);
      let previous = 0;
      for (const l of [...show].sort((x, y) => x - y)) {
        if (previous && l > previous + 1) entry.lines.push("--");
        const sep = hits.has(l) ? ":" : "-";
        entry.lines.push([l, sep, rows[l - 1].slice(0, 300)]);
        previous = l;
      }
    }
    proFile.push(entry);
    total += hits.size;
    if (total >= o.maxHits) cutOff = true;
  };
  if (individual) scan(target);
  else stackWalk(fs, path, root, o, scan);
  return { proFile, total, cutOff };
}

// The editor's full-text search (files.js searchFiles): recursive, binary and large files skipped; what is entered is decided
// by `searchArea` (exclusions and ignore files like VS Code), what matches by `searchPattern`, the lines by `searchLines` — the
// same three computations as in B. `rel`: the path relative to the root, with "/" — B decides the order of the results
// (sorted by path). `o.open`: paths of unsaved buffers — what comes back is which of them lie in the area (`openMatches`;
// their text is searched by the web client).
function searchCore(fs, path, root, o) {
  const pattern = searchPattern(o); // whole word, include/exclude
  if (pattern.error) return { error: pattern.error };
  const relOf = (abs) => path.relative(root, abs).split(path.sep).join("/");
  const readText = (abs) => {
    try { const st = fs.lstatSync(abs); if (!st.isFile() || st.size > 1024 * 1024) return null; return fs.readFileSync(abs, "utf8"); } catch { return null; }
  };
  const area = searchArea(root, o, readText, (w, folder, file) => path.join(w, folder, file));
  const results = [];
  let hits = 0;
  let files = 0;
  let cutOff = false;
  const walk = (dir) => {
    if (cutOff) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (cutOff) return;
      const abs = path.join(dir, e.name);
      const rel = relOf(abs);
      if (e.isDirectory()) {
        if (area.folderFrom(rel) || pattern.folderFrom(rel)) continue;
        walk(abs);
      } else if (e.isFile()) {
        if (area.fileFrom(rel) || !pattern.pathMatches(rel)) continue;
        if (++files > o.maxFiles) { cutOff = true; return; }
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > o.maxFile) continue;
        let buf;
        try { buf = fs.readFileSync(abs); } catch { continue; }
        if (buf.subarray(0, 8192).includes(0)) continue;
        const r = searchLines(buf.toString("utf8"), pattern, o.maxHits - hits);
        if (r.rows.length) results.push({ rel, matches: r.rows });
        hits += r.n;
        if (hits >= o.maxHits) { cutOff = true; return; }
      }
    }
  };
  walk(root);
  const openMatches = (Array.isArray(o.open) ? o.open : []).filter((rel) => typeof rel === "string" && area.inArea(rel, pattern));
  return { results, hits, files: results.length, cutOff, openMatches };
}

// The editor's file-name search (files.js findFilesByName): the files, up to the cap, whose path (relative, with "/")
// contains `o.query` (lower-case); B does the ranking.
function namesCore(fs, path, root, o) {
  const q = String(o.query || "");
  const files = [];
  let run = 0;
  let stopped = false;
  const walk = (dir) => {
    if (stopped) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stopped) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!o.skip.includes(e.name)) walk(abs); }
      else if (e.isFile()) {
        if (++run > o.maxFiles) { stopped = true; return; }
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (!q || rel.toLowerCase().includes(q)) files.push(rel);
      }
    }
  };
  walk(root);
  return { files, stopped };
}

// Quick Open (⌘P): the files in the search area (`searchArea` with VS Code's exclusions and the ignore files — the same as
// `/files/search`), filtered with the prefilter during the walk already, then sorted and capped like VS Code's Quick Open
// (runtime/fast-open.js) — the two caps as in files.js `quickOpenFiles`: `o.maxFiles` counts only MATCHING files (full ⇒
// `truncated`), `o.maxWalk` every file in the area (full ⇒ `aborted`, `searched`).
function fastCore(fs, path, root, o) {
  const pattern = fastPattern(String(o.query || ""));
  if (!pattern) return { results: [], truncated: false };
  const readText = (abs) => {
    try { const st = fs.lstatSync(abs); if (!st.isFile() || st.size > 1024 * 1024) return null; return fs.readFileSync(abs, "utf8"); } catch { return null; }
  };
  const area = searchArea(root, { exclusions: true }, readText, (w, folder, file) => path.join(w, folder, file));
  const files = [];
  let seen = 0;
  let stopped = false, aborted = false;
  const walk = (dir) => {
    if (stopped) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stopped) return;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) { if (!area.folderFrom(rel)) walk(abs); }
      else if (e.isFile()) {
        if (area.fileFrom(rel)) continue;
        if (++seen > o.maxWalk) { stopped = aborted = true; return; }
        if (!fastMatches(rel, pattern)) continue;
        if (files.length >= o.maxFiles) { stopped = true; return; }
        files.push(rel);
      }
    }
  };
  walk(root);
  const r = fastOpen(files, String(o.query || ""), o.cap);
  return { results: r.results, truncated: r.truncated || stopped, ...(aborted ? { aborted: true, searched: o.maxWalk } : {}) };
}

// The dispatch: an operation → its result (throws with `code`). `readStdin()` delivers the bytes of a write.
function programCore(fs, path, crypto, op, o, paths, readStdin) {
  const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
  const kind = (st) => (st.isSymbolicLink() ? "reference" : st.isDirectory() ? "folder" : st.isFile() ? "file" : "otherwise");
  const error = (code, text) => Object.assign(new Error(text), { code });
  const p = paths[0];
  switch (op) {
    case "read": {
      let st;
      try { st = fs.statSync(p); } catch (e) { // follows symlinks like B does — and reports like `readFileSync`: "…, open '<path>'"
        if (e.code === "ENOENT") throw error("ENOENT", `ENOENT: no such file or directory, open '${p}'`);
        throw e;
      }
      if (st.isDirectory()) return { kind: "folder", size: st.size };
      if (!st.isFile()) return { kind: "otherwise", size: st.size }; // a FIFO or device is not opened
      if (st.size > o.maxBytes) return { kind: "file", size: st.size, tooBig: true };
      const buf = fs.readFileSync(p);
      return { kind: "file", size: buf.length, sha256: sha(buf), data: buf.toString("base64") };
    }
    case "readMany": { // several files in ONE call (project memory: up to nine candidates per turn) — `null` where there is no readable file
      const files = paths.map((q) => {
        try {
          const real = fs.realpathSync(q);
          if (!fs.statSync(real).isFile()) return null;
          const fd = fs.openSync(real, "r");
          try {
            const buf = Buffer.alloc(o.maxBytes);
            const n = fs.readSync(fd, buf, 0, o.maxBytes, 0);
            return { real, data: buf.subarray(0, n).toString("base64") };
          } finally { fs.closeSync(fd); }
        } catch { return null; }
      });
      return { files };
    }
    case "write": {
      const data = readStdin();
      if (Object.prototype.hasOwnProperty.call(o, "expect")) {
        let actual = null;
        try {
          const st = fs.statSync(p);
          if (st.isDirectory()) throw error("EISDIR", "Is a directory");
          actual = sha(fs.readFileSync(p));
        } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (actual !== o.expect) throw error("ECONFLICT", "The file has changed since it was read");
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      try { if (fs.statSync(p).isDirectory()) throw error("EISDIR", "Is a directory"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      fs.writeFileSync(p, data, { flag: o.append ? "a" : "w", ...(typeof o.mode === "number" ? { mode: o.mode & 0o777 } : {}) });
      return { size: data.length, sha256: o.append ? null : sha(data) };
    }
    case "stamp": { // per path "kind:size:mtime" (stat, follows symlinks) or null — the Markdown server's freshness in a copy, ONE call
      return { stamp: paths.map((q) => { try { const st = fs.statSync(q); return `${st.isDirectory() ? "d" : "f"}:${st.size}:${st.mtimeMs}`; } catch { return null; } }) };
    }
    case "stat": {
      const st = fs.lstatSync(p);
      const r = { kind: kind(st), size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o7777 };
      if (st.isSymbolicLink()) { try { const z = fs.statSync(p); r.target = { kind: kind(z), size: z.size }; } catch { r.target = null; } }
      try { r.real = fs.realpathSync(p); } catch { r.real = null; } // the real location (copying into itself via a symlink)
      return r;
    }
    case "list": {
      const st = fs.statSync(p);
      if (!st.isDirectory()) throw error("ENOTDIR", "Not a directory");
      // `repoInfo` — per folder isRepo / worktreeOf (see the header). Only a `.git` that lstat reports as a regular file is
      // read (no symlink, no FIFO), and at most 4 KiB of it.
      const repoInfo = o.repoInfo === true;
      const root = repoInfo && typeof o.root === "string" && o.root ? path.resolve(o.root) : null;
      const underRoot = (x) => Boolean(root) && (x === root || x.startsWith(root === "/" ? "/" : root + "/"));
      // `chains` ({ depth, max, heavy }) — per folder the chain of single subfolders (files.js chainsAlongside, the same rule).
      const chains = o.chains && typeof o.chains === "object" ? o.chains : null;
      let read = 0;
      return { entries: fs.readdirSync(p).map((nameText) => {
        let l;
        try { l = fs.lstatSync(path.join(p, nameText)); } catch { return { name: nameText, kind: null }; }
        const r = { name: nameText, kind: kind(l), size: l.size, mode: l.mode & 0o7777 };
        if (chains && l.isDirectory() && !chains.heavy.includes(nameText)) {
          const chain = [];
          let location = path.join(p, nameText);
          while (chain.length < chains.depth && read < chains.max) {
            read++;
            let content;
            try { content = fs.readdirSync(location, { withFileTypes: true }).filter((d) => d.name !== ".git"); } catch { break; }
            if (content.length !== 1 || !content[0].isDirectory()) break;
            location = path.join(location, content[0].name);
            chain.push(content[0].name);
            if (chains.heavy.includes(content[0].name)) break;
          }
          if (chain.length) r.chain = chain;
        }
        if (l.isSymbolicLink()) { try { const z = fs.statSync(path.join(p, nameText)); r.target = { kind: kind(z), size: z.size }; } catch { r.target = null; } }
        if (repoInfo && l.isDirectory()) {
          const location = path.join(p, nameText);
          let g = null;
          try { g = fs.lstatSync(path.join(location, ".git")); } catch { g = null; }
          r.isRepo = Boolean(g && g.isDirectory());
          if (g && g.isFile() && g.size <= 4096) {
            let text = "";
            try { text = fs.readFileSync(path.join(location, ".git"), "utf8"); } catch { text = ""; }
            const m = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(text);
            const w = m ? /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(path.resolve(location, m[1])) : null;
            if (w && underRoot(w[1] || "/")) r.worktreeOf = path.relative(root, w[1] || "/") || ".";
          }
        }
        return r;
      }) };
    }
    case "create": {
      let present = true;
      try { fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") present = false; else throw e; }
      if (present) throw error("EEXIST", "Already exists");
      if (o.kind === "folder") fs.mkdirSync(p, { recursive: true });
      else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.closeSync(fs.openSync(p, "wx")); }
      return {};
    }
    case "name": {
      const to = paths[1];
      try { fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") throw error("ENOENT", "Source not found"); throw e; }
      let present = true;
      try { fs.lstatSync(to); } catch (e) { if (e.code === "ENOENT") present = false; else throw e; }
      if (present) throw error("EEXIST", "Target already exists");
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(p, to);
      return {};
    }
    case "erase": {
      try { fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") throw error("ENOENT", "Not found"); throw e; }
      fs.rmSync(p, { recursive: true, force: true }); // a symlink itself is removed, its target stays
      return {};
    }
    case "glob": return globCore(fs, path, p, o);
    case "grep": return grepCore(fs, path, p, o);
    case "search": return searchCore(fs, path, p, o);
    case "names": return namesCore(fs, path, p, o);
    case "fast": return fastCore(fs, path, p, o);
    default: throw error("EOP", `Unknown operation ${op}`);
  }
}

// The program in the container: the cores, then the dispatch. argv (after "--"): op, options (JSON), paths…. Output: ONE line.
export const PROGRAM = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
${[globToRegExp, searchGlob, searchPattern, searchArea, searchLines, stackWalk, globCore, grepCore, searchCore, namesCore, fastOpen, fastPattern, fastMatches, fastCore, programCore].map((f) => f.toString()).join("\n")}
const [op, options, ...paths] = process.argv.slice(1);
let response;
try {
  response = { ok: true, ...programCore(fs, path, crypto, op, JSON.parse(options || "{}"), paths, () => fs.readFileSync(0)) };
} catch (e) {
  response = { ok: false, code: (e && e.code) || "EERROR", message: String((e && e.message) || e) };
}
process.stdout.write(JSON.stringify(response) + "\\n");
`;

/** The cores for the test in B (against a folder): the same functions that go into the program. */
export const CORES = Object.freeze({ globCore, grepCore, searchCore, namesCore, fastCore, fastOpen, fastPattern, fastMatches, programCore, stackWalk, searchPattern, searchGlob, searchArea, searchLines });

// ── The call from B ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the access reports. `code`: ENOENT, EEXIST, EISDIR, ENOTDIR, ECONFLICT (stale content), CAP (deadline/output), PROGRAM
 *  (the program itself failed: container down, Node missing …), otherwise the file system's code in the container. */
export class FileAccessError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "FileAccessError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const who = (inst) => inst?.identifier || inst?.projectId || "?";

async function run(inst, op, options, paths, { stdin, timeout = DEADLINE_SMALL_MS, maxBuffer = OUTPUT_MAX, withoutDeadline = false, signal = null } = {}) {
  if (!inst) throw new TypeError("fileAccess: without an instance there is no container — the caller takes the plain path");
  for (const pf of paths) {
    if (typeof pf !== "string" || !path.isAbsolute(pf)) throw new TypeError(`fileAccess: path is not absolute: ${String(pf).slice(0, 120)}`);
  }
  const r = await commandRun(inst, "/", process.execPath, ["-e", PROGRAM, "--", op, JSON.stringify(options || {}), ...paths], { timeout, maxBuffer, ...(withoutDeadline === true ? { withoutDeadline: true } : {}), ...(signal ? { signal } : {}), ...(stdin != null ? { stdin } : {}) });
  if (r.aborted) throw new FileAccessError("ABORTED", `${op} in copy ${who(inst)}: aborted`);
  if (r.cap) {
    throw new FileAccessError("CAP", `${op} in copy ${who(inst)}: ${r.cap === "deadline" ? `deadline cap (${Math.round(timeout / 1000)} s)` : `output cap (${maxBuffer} bytes)`} reached — aborted, nothing truncated`, { cap: r.cap });
  }
  let response = null;
  try { response = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null"); } catch { response = null; }
  if (!response) {
    throw new FileAccessError("PROGRAM", `${op} in copy ${who(inst)}: ${String(r.stderr || "").trim().split("\n").slice(-3).join(" ") || `Exit ${r.code}`}`);
  }
  if (response.ok === false) throw new FileAccessError(response.code || "EERROR", String(response.message || `${op} failed`));
  return response;
}

/** Read a file from the copy — see the header. `maxBytes` 0 means: only kind and size. */
export async function read(inst, filePath, { maxBytes = READ_MAX, timeout, maxBuffer, withoutDeadline, signal } = {}) {
  const r = await run(inst, "read", { maxBytes }, [filePath], { timeout, withoutDeadline, signal, maxBuffer: maxBuffer ?? Math.ceil(maxBytes * 4 / 3) + 65536 });
  return { kind: r.kind, size: r.size, tooBig: Boolean(r.tooBig), sha256: r.sha256 || null, data: r.data == null ? null : Buffer.from(r.data, "base64") };
}

/**
 * Read several files in ONE call (project memory): per path `{ real, data }` (`real`: the resolved location in the container,
 * `data`: the first `maxBytes` bytes) or `null` where there is no readable regular file (missing, folder, unreadable) — a
 * missing file is no exception here, the candidate list is longer than what exists. A failed call throws like all others
 * (never a read in B).
 */
export async function readSeveral(inst, paths, { maxBytes = 160_000, timeout, maxBuffer, withoutDeadline, signal } = {}) {
  if (!paths.length) return [];
  const r = await run(inst, "readMany", { maxBytes }, paths, { timeout, withoutDeadline, signal, maxBuffer: maxBuffer ?? paths.length * (Math.ceil(maxBytes * 4 / 3) + 4096) + 65536 });
  return r.files.map((d) => (d ? { real: d.real, data: Buffer.from(d.data, "base64") } : null));
}

/** Write a file in the copy (create or replace, `append`: continue). `expect`: see the header. */
export async function write(inst, filePath, data, { expect, append = false, mode, timeout, maxBuffer, withoutDeadline, signal } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""));
  const o = { ...(expect !== undefined ? { expect } : {}), ...(append ? { append: true } : {}), ...(typeof mode === "number" ? { mode } : {}) };
  const r = await run(inst, "write", o, [filePath], { stdin: buf, timeout, maxBuffer, withoutDeadline, signal });
  return { size: r.size, sha256: r.sha256 };
}

/** Read, modify, write back with a sha256 comparison — `fn(text)` → new text (throws if the change is not possible). */
export async function edit(inst, filePath, fn, { maxBytes = READ_MAX, ...rest } = {}) {
  const r = await read(inst, filePath, { maxBytes, ...rest });
  if (r.kind !== "file") throw new FileAccessError(r.kind === "folder" ? "EISDIR" : "ENOFILE", r.kind === "folder" ? "Is a directory" : `Not a regular file: ${filePath}`);
  if (r.tooBig) throw new FileAccessError("TOO_LARGE", `File too large (${r.size} bytes)`);
  const fresh = await fn(r.data.toString("utf8"));
  return write(inst, filePath, Buffer.from(String(fresh)), { expect: r.sha256, ...rest });
}

/** Kind, size, modification time and mode (lstat; for a symlink also `target`) — `null` if the path does not exist. */
export async function stat(inst, filePath, rest = {}) {
  try { return await run(inst, "stat", {}, [filePath], rest); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
}

/** Per path its stamp "d|f:<size>:<mtimeMs>" (stat, follows symlinks) or `null` (missing) — ONE call for many paths. */
export async function stamp(inst, paths, rest = {}) {
  if (!paths.length) return [];
  return (await run(inst, "stamp", {}, paths, rest)).stamp;
}

/** The entries of a folder: `[{ name, kind, size, target? }]` (lstat; for a symlink also `target`). Throws ENOENT/ENOTDIR.
 *  With `repoInfo: true` (and `root`, the project root) per folder also `isRepo` and `worktreeOf` (see the header). */
export async function list(inst, folder, { repoInfo = false, root = null, chains = null, ...rest } = {}) {
  const o = {
    ...(repoInfo ? { repoInfo: true, ...(root ? { root: path.resolve(String(root)) } : {}) } : {}),
    ...(chains ? { chains: { depth: Number(chains.depth) || 0, max: Number(chains.max) || 0, heavy: [...(chains.heavy || [])] } } : {}),
  };
  return (await run(inst, "list", o, [folder], rest)).entries;
}

/** Create a NEW file (kind "file") or folder ("folder") — EEXIST if the name exists (also as a symlink). */
export async function create(inst, filePath, kind, rest = {}) {
  await run(inst, "create", { kind: kind === "folder" ? "folder" : "file" }, [filePath], rest);
}

/** Rename/move (missing folders of the target are created): ENOENT = source missing, EEXIST = target exists. */
export async function name(inst, from, to, rest = {}) {
  await run(inst, "name", {}, [from, to], rest);
}

/** Delete (file, symlink or folder with its content) — ENOENT if the entry does not exist. */
export async function erase(inst, filePath, rest = {}) {
  await run(inst, "erase", {}, [filePath], rest);
}

/** Glob in the container: `{ total, hits: [{ p, m }] }` (p absolute under `root`), newest first. `o`: { pattern, skip, maxFiles, maxHits }. */
export async function glob(inst, root, o, rest = {}) {
  const r = await run(inst, "glob", { ...o, anchor: root }, [root], { timeout: DEADLINE_TREE_MS, ...rest });
  return { total: r.total, hits: r.hits.map((t) => ({ p: path.join(root, t.rel), m: t.m })) };
}

/**
 * Grep in the container (file or tree): `{ proFile: [{ file, count, lines }], total, cutOff }` — `file` absolute, `lines`
 * finished lines (`<file>:<seq>:<text>`, without the number if `o.numbers` is false; "--" between the groups), as grepTool
 * builds them in B — or `{ error }` for an invalid expression. `o`: see grepCore.
 */
export async function grep(inst, target, o, rest = {}) {
  const r = await run(inst, "grep", o, [target], { timeout: DEADLINE_TREE_MS, ...rest });
  if (r.error) return { error: r.error };
  return {
    total: r.total,
    cutOff: r.cutOff,
    proFile: r.proFile.map((e) => {
      const file = e.file ? path.join(target, e.file) : target;
      return { file, count: e.count, lines: e.lines.map((z) => (z === "--" ? z : o.numbers ? `${file}${z[1]}${z[0]}${z[1]}${z[2]}` : `${file}${z[1]}${z[2]}`)) };
    }),
  };
}

/** The editor's full-text search in the container: `{ results: [{ rel, matches: [{ line, text, hits }] }], hits, files, cutOff, openMatches }`
 *  (unsorted) or `{ error }`. */
export async function search(inst, root, o, rest = {}) {
  return run(inst, "search", o, [root], { timeout: DEADLINE_TREE_MS, ...rest });
}

/** The files under `root` (up to the cap) whose relative path contains `o.query`: `{ files: [rel], stopped }`. */
export async function names(inst, root, o, rest = {}) {
  return run(inst, "names", o, [root], { timeout: DEADLINE_TREE_MS, ...rest });
}

/** Quick Open (⌘P) in the copy: `{ results, truncated }` — see `fastCore`. */
export async function fast(inst, root, o, rest = {}) {
  return run(inst, "fast", o, [root], { timeout: DEADLINE_TREE_MS, ...rest });
}

// ── Which way? ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isCopy = (inst) => Boolean(inst) && String(inst.instance || "main") !== "main";
const under = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * The way of a path for an instance: "copy" — through the copy's container — or "b" — the plain path in B. Only a COPY knows
 * the first; main and "no instance" are always "b". A copy owns everything that touches the project folder (below it and, for
 * a tree walk, above it); the runtime folder stays in B, and so does everything that touches neither.
 */
export function fileWay(inst, abs, { project = null, runtime = null } = {}) {
  if (!isCopy(inst)) return "b";
  const p = path.resolve(String(abs));
  const lw = runtime ? path.resolve(runtime) : null;
  const pw = project ? path.resolve(project) : null;
  const inRuntimeFolder = Boolean(lw) && under(p, lw);
  const inProject = Boolean(pw) && under(p, pw);
  // If one folder lies in the other, the deeper one wins (the more specific anchor).
  if (inRuntimeFolder && inProject) return lw.length > pw.length ? "b" : "copy";
  if (inRuntimeFolder) return "b";
  return inProject || (Boolean(pw) && under(pw, p)) ? "copy" : "b";
}
