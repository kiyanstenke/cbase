// What sits in a tab of the editor groups: a file, the Markdown preview of a file, a diff.
//
// (1) The computations, EXECUTED:
//     - lib/editor-inputs.ts: keys (foreign text from storage is null, not "a file"; a diff only in fixed form), which buffer is held
//       (file tab and the diff of the UNSTAGED change share it), rename/delete/reload, titles as in VS Code ("app.ts (Working Tree)",
//       "app.ts (Index)", "README.md (abc1234^ ↔ abc1234)", "Preview README.md", "[Preview] README.md"), ⇧⌘V/⌘K V (same group right of the
//       source resp. the group beside it, fixed, focus stays with ⌘K V, at most ONE unlocked preview per group), following, locking, back to
//       the source, "Open Changes" (`git.openChange`: unstaged before staged);
//     - lib/editor-groups.ts `replaceIn` (a tab replaced by another AT ITS place);
//     - lib/chat-tabs.ts: the same preview as a chat tab (open, follow, lock, back, read, rename, delete).
// (2) The sources: the timeline opens diffs as tabs (single click the italic preview, double click fixed, "Open Commit" fixed, menu as in
//     VS Code), CodePane draws diff tabs with the SAME building block as the chat (components/code/DiffTab.tsx, "Open File" in front),
//     "Open Changes" in the title bar, holds the diff buffers, asks on close only the last holder; the chat names diffs with the same
//     computation.
// (3) Commit diff title: "{0} ({1}) ↔ {0} ({2})" with the file's name TODAY (`current`) and the predecessor (`prior`); "Open Commit" opens as a
//     preview without focus; "Open Changes" on an untracked file opens the FILE ("README.md (Untracked)"); "Open as Preview";
//     per group after EVERY step at most one unlocked preview (`oneDynamicPreview` in `apply`); a restored preview without a file is dropped;
//     ⌘S outside the surface saves the diff in front (components/code/view-locations.ts); diff and preview keep scroll position and caret
//     across detaching; after saving the diff reads once; the palette lists only file tabs as open editors; in the chat the timeline stays
//     with the diff (`input`). The parts live in components/code/InputParts.tsx.
//
// Each sabotage is a copy of the source with ONE changed spot (the spot appears exactly once, otherwise the sabotage is stale);
// the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/editor-inputs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

// ── The sabotages: file, spot, replacement, which check must catch it ──────────────────────────────────────────────────────────────
const SABOTAGES = {
  // Key
  "preview of any file": { file: "editor-inputs.ts", old: "return path && !path.startsWith(MARKER) && isMarkdown(path) ? {", fresh: "return path && !path.startsWith(MARKER) ? {", catches: "key" },
  "diff not in fixed form counts": { file: "editor-inputs.ts", old: "  if (diffKey(source, title) !== k) return null;", fresh: "", catches: "key" },
  "source not in fixed form": { file: "editor-inputs.ts", old: "const fixed = checkSource(q) ?? q;", fresh: "const fixed = q;", catches: "key" },
  "title on every diff": { file: "editor-inputs.ts", old: "isMultiFile(fixed) && title ? { q: fixed, t: title } : { q: fixed }", fresh: "title ? { q: fixed, t: title } : { q: fixed }", catches: "key" },
  "lock lost on reading": { file: "editor-inputs.ts", old: "[[PREVIEW, false], [LOCKED, true]]", fresh: "[[PREVIEW, false], [LOCKED, false]]", catches: "key" },
  "broken JSON throws": { file: "editor-inputs.ts", old: "try { o = JSON.parse(k.slice(DIFF.length)); } catch { return null; }", fresh: "o = JSON.parse(k.slice(DIFF.length));", catches: "key" },
  "chat tab unlocked": { file: "editor-inputs.ts", old: "if (tab.kind === \"preview\") return previewKey(tab.path, Boolean(tab.locked));", fresh: "if (tab.kind === \"preview\") return previewKey(tab.path);", catches: "key" },
  "chat diff without key": { file: "editor-inputs.ts", old: "  return diffKey(tab.source, tab.title);\n}", fresh: "  return \"\";\n}", catches: "key" },
  // Buffer
  "staged diff holds the buffer": { file: "editor-inputs.ts", old: "  return writeFile(e.source);\n}", fresh: "  return diffFile(e.source);\n}", catches: "buffer" },
  "preview holds the buffer": { file: "editor-inputs.ts", old: "if (!e || e.kind === \"preview\") return null;\n  if (e.kind === \"file\") return e.path;", fresh: "if (!e) return null;\n  if (e.kind !== \"diff\") return e.path;", catches: "buffer" },
  "diff holds no buffer": { file: "editor-inputs.ts", old: "for (const k of G.allOpen(s)) { const d = bufferFile(k); if (d !== null && !out.includes(d)) out.push(d); }", fresh: "for (const k of openFiles(s)) { if (!out.includes(k)) out.push(k); }", catches: "buffer" },
  "the tab itself counts as another": { file: "editor-inputs.ts", old: "!(g.id === gid && k === key) && bufferFile(k) === d", fresh: "bufferFile(k) === d", catches: "buffer" },
  "open files with diffs": { file: "editor-inputs.ts", old: "G.allOpen(s).filter(isFileTab)", fresh: "G.allOpen(s)", catches: "buffer" },
  "timeline empty at diff": { file: "editor-inputs.ts", old: "return e.kind === \"file\" ? e.path : diffFile(e.source);\n}", fresh: "return e.kind === \"file\" ? e.path : null;\n}", catches: "buffer" },
  "file today dropped": { file: "editor-inputs.ts", old: "const d = diffPath(q);", fresh: "const d = q.kind === \"commit\" ? q.file : diffPath(q);", catches: "buffer" },
  "timeline at the preview": { file: "editor-inputs.ts", old: "if (!e || e.kind === \"preview\") return null;\n  return e.kind === \"file\"", fresh: "if (!e) return null;\n  if (e.kind === \"preview\") return e.path;\n  return e.kind === \"file\"", catches: "buffer" },
  // Paths
  "preview does not follow": { file: "editor-inputs.ts", old: "return e.kind === \"file\" ? form(k) : previewKey(form(e.path), e.locked);", fresh: "return e.kind === \"file\" ? form(k) : k;", catches: "paths" },
  "rename unlocks": { file: "editor-inputs.ts", old: "previewKey(form(e.path), e.locked)", fresh: "previewKey(form(e.path))", catches: "paths" },
  "delete hits git diffs": { file: "editor-inputs.ts", old: "e.kind === \"diff\" ? sourceFalls(e.source, hits, location) && !unsaved(k) : hits(e.path)", fresh: "e.kind === \"diff\" ? hits(diffFile(e.source) ?? \"\") : hits(e.path)", catches: "paths" },
  "delete leaves the working tree diff": { file: "editor-inputs.ts", old: "e.kind === \"diff\" ? sourceFalls(e.source, hits, location) && !unsaved(k) : hits(e.path)", fresh: "e.kind === \"diff\" ? false : hits(e.path)", catches: "paths" },
  "removed from outside closes the working tree diff": { file: "editor-inputs.ts", old: "return e !== null && e.kind !== \"diff\" && hits(e.path);", fresh: "return e !== null && (e.kind === \"diff\" ? sourceFalls(e.source, hits) : hits(e.path));", catches: "paths" },
  "diff does not follow": { file: "editor-inputs.ts", old: "return q === null || q === e.source ? k : diffKey(q, e.title);", fresh: "return k;", catches: "paths" },
  "unreadable stays": { file: "editor-inputs.ts", old: "G.remove(s, (k) => inputOf(k) === null)", fresh: "s", catches: "paths" },
  "reload with two dynamic ones": { file: "editor-inputs.ts", old: "oneDynamicPreview(G.remove(s, (k) => inputOf(k) === null))", fresh: "G.remove(s, (k) => inputOf(k) === null)", catches: "paths" },
  "diff is restored on reload": { file: "editor-inputs.ts", old: "return e !== null && e.kind !== \"diff\"; })", fresh: "return e !== null; })", catches: "paths" },
  "preview is not restored on reload": { file: "editor-inputs.ts", old: "e !== null && e.kind !== \"diff\"; })", fresh: "e !== null && e.kind === \"file\"; })", catches: "paths" },
  // Title
  "working copy instead of working tree": { file: "editor-inputs.ts", old: "t(\"{name} (Working Tree)\", { name })", fresh: "t(\"{name} (Working Copy)\", { name })", catches: "title" },
  "sides swapped": { file: "editor-inputs.ts", old: "q.staged ? t(\"{name} (Index)\"", fresh: "!q.staged ? t(\"{name} (Index)\"", catches: "title" },
  "commit without sides": { file: "editor-inputs.ts", old: "case \"commit\": return diffTitle(q.current ?? q.file, q.hash, q.prior);", fresh: "case \"commit\": return baseName(q.file);", catches: "title" },
  "commit title with the old name": { file: "editor-inputs.ts", old: "diffTitle(q.current ?? q.file, q.hash, q.prior)", fresh: "diffTitle(q.file, q.hash, q.prior)", catches: "title" },
  "commit title without predecessor": { file: "editor-inputs.ts", old: "q.hash, q.prior);", fresh: "q.hash);", catches: "title" },
  "untracked title with the whole path": { file: "editor-inputs.ts", old: "t(\"{name} (Untracked)\", { name: baseName(path) })", fresh: "t(\"{name} (Untracked)\", { name: path })", catches: "title" },
  "commit subject dropped": { file: "editor-inputs.ts", old: "default: return o.title || t(\"Commit {hash}\"", fresh: "default: return t(\"Commit {hash}\"", catches: "title" },
  "preview title without lock": { file: "editor-inputs.ts", old: "const v = previewTitle(e.path, e.locked);", fresh: "const v = previewTitle(e.path);", catches: "title" },
  "tab title without subject": { file: "editor-inputs.ts", old: "const name = diffName(e.source, t, { title: e.title });", fresh: "const name = diffName(e.source, t);", catches: "title" },
  // Preview
  "preview italic": { file: "editor-inputs.ts", old: "r = G.open(r, key, { fixed: true, group: target });", fresh: "r = G.open(r, key, { group: target });", catches: "preview" },
  "second dynamic preview": { file: "editor-inputs.ts", old: "if (dyn && dyn !== key) r = G.replaceIn(r, target, dyn, key);", fresh: "", catches: "preview" },
  "⌘K V in the same group": { file: "editor-inputs.ts", old: "  if (o.beside) {", fresh: "  if (false) {", catches: "preview" },
  "⌘K V takes the focus": { file: "editor-inputs.ts", old: "return o.beside ? G.activateGroup(r, gid) : r;", fresh: "return r;", catches: "preview" },
  // VS Code `ViewColumn.Beside`: ⌘K V no longer falls back to the left — a new group is created on the right.
  "⌘K V falls back to the left": { file: "editor-inputs.ts", old: "const n = G.neighbor(s, gid, \"right\");", fresh: "const n = G.neighbor(s, gid, \"right\") ?? G.neighbor(s, gid, \"left\");", catches: "preview" },
  "⌘K V creates no group": { file: "editor-inputs.ts", old: "const fresh = G.createGroup(s, gid, \"right\");", fresh: "const fresh = G.createGroup(s, gid, \"bottom\");", catches: "preview" },
  "preview of a non-Markdown file": { file: "editor-inputs.ts", old: "if (!isMarkdown(path) || path.startsWith(MARKER) || !G.groupOf(s, gid)) return s;", fresh: "if (!G.groupOf(s, gid)) return s;", catches: "preview" },
  "locked one follows": { file: "editor-inputs.ts", old: "g?.paths.find((k) => k.startsWith(PREVIEW)) ?? null;", fresh: "g?.paths.find((k) => k.startsWith(PREVIEW) || k.startsWith(LOCKED)) ?? null;", catches: "preview" },
  "follows only in the active group": { file: "editor-inputs.ts", old: "for (const g of s.groups) { const dyn = followingPreview(g);", fresh: "for (const g of [G.activeGroup(s)]) { const dyn = followingPreview(g);", catches: "preview" },
  "follows any file": { file: "editor-inputs.ts", old: "if (!path || path.startsWith(MARKER) || !isMarkdown(path)) return s;", fresh: "if (!path) return s;", catches: "preview" },
  "lock without effect": { file: "editor-inputs.ts", old: "const fresh = previewKey(e.path, !e.locked);", fresh: "const fresh = previewKey(e.path, e.locked);", catches: "preview" },
  "two remain unlocked": { file: "editor-inputs.ts", old: "if (e.locked) for (const k of G.groupOf(r, gid)?.paths ?? [])", fresh: "if (false) for (const k of G.groupOf(r, gid)?.paths ?? [])", catches: "preview" },
  "back only closes": { file: "editor-inputs.ts", old: "return G.replaceIn(s, gid, key, e.path);", fresh: "return G.close(s, gid, key);", catches: "preview" },
  "two dynamic ones remain": { file: "editor-inputs.ts", old: "if (dyn.length < 2) continue;", fresh: "continue;", catches: "preview" },
  "the active dynamic one is dropped": { file: "editor-inputs.ts", old: "g.active !== null && dyn.includes(g.active) ? g.active : ", fresh: "", catches: "preview" },
  "not the most recently used": { file: "editor-inputs.ts", old: "g.last?.find((k) => dyn.includes(k)) ?? dyn[0]", fresh: "dyn[0]", catches: "preview" },
  "as preview not locked": { file: "editor-inputs.ts", old: "const k = previewKey(path, true);\n  return keep", fresh: "const k = previewKey(path);\n  return keep", catches: "preview" },
  "as preview loses unsaved": { file: "editor-inputs.ts", old: "return keep ? G.open(s, k, { fixed: true, group: gid }) : G.replaceIn(s, gid, path, k);", fresh: "return G.replaceIn(s, gid, path, k);", catches: "preview" },
  "as preview beside": { file: "editor-inputs.ts", old: "return keep ? G.open(s, k, { fixed: true, group: gid }) : G.replaceIn(s, gid, path, k);", fresh: "return G.open(s, k, { fixed: true, group: gid });", catches: "preview" },
  "as preview of any file": { file: "editor-inputs.ts", old: "if (!g || !g.paths.includes(path) || !isMarkdown(path)) return s;", fresh: "if (!g) return s;", catches: "preview" },
  "back on every tab": { file: "editor-inputs.ts", old: "if (e?.kind !== \"preview\" || !g || !g.paths.includes(key)) return s;", fresh: "if (!g || !g.paths.includes(key)) return s;", catches: "preview" },
  // Open Changes
  "repo prefix without slash": { file: "editor-inputs.ts", old: "if (repo && path !== repo && !path.startsWith(`${repo}/`)) return null;", fresh: "if (repo && !path.startsWith(repo)) return null;", catches: "change" },
  "staged before unstaged": { file: "editor-inputs.ts", old: "staged: y === \" \" }", fresh: "staged: x !== \" \" && x !== \"?\" }", catches: "change" },
  "opened without a change": { file: "editor-inputs.ts", old: "if (!kind || !path || path.startsWith(MARKER)) return null;", fresh: "if (!path || path.startsWith(MARKER)) return null;", catches: "change" },
  "path not relative to the repo": { file: "editor-inputs.ts", old: "const file = repo ? path.slice(repo.length + 1) : path;", fresh: "const file = path;", catches: "change" },
  "untracked as diff": { file: "editor-inputs.ts", old: "if (kind === \"untracked\" || xy === \"??\") return \"untracked\";", fresh: "", catches: "change" },
  "only ?? means untracked": { file: "editor-inputs.ts", old: "kind === \"untracked\" || xy === \"??\"", fresh: "xy === \"??\"", catches: "change" },
  // replaceIn (lib/editor-groups.ts)
  "does not replace in place": { file: "editor-groups.ts", old: ": l.paths.map((p) => (p === old ? fresh : p));", fresh: ": [...l.paths.filter((p) => p !== old), fresh];", catches: "replaceIn" },
  "replaces twice": { file: "editor-groups.ts", old: "const paths = present ? l.paths.filter((p) => p !== old) : ", fresh: "const paths = present ? l.paths.map((p) => (p === old ? fresh : p)) : ", catches: "replaceIn" },
  "target becomes italic": { file: "editor-groups.ts", old: "preview: present && l.preview === old ? null : remap(l.preview),", fresh: "preview: shut(l.preview),", catches: "replaceIn" },
  "trail does not follow": { file: "editor-groups.ts", old: "...(l.last ? { last: [...new Set(l.last.map((p) => (p === old ? fresh : p)))] } : {}),", fresh: "...(l.last ? { last: l.last } : {}),", catches: "replaceIn" },
  // The chat (lib/chat-tabs.ts)
  "chat: preview italic": { file: "chat-tabs.ts", old: "  return open(state, tab, { fixed: true });\n}\n/** An unlocked preview", fresh: "  return open(state, tab);\n}\n/** An unlocked preview", catches: "chat" },
  "chat: second dynamic one": { file: "chat-tabs.ts", old: "  if (dyn && key(dyn) !== k) return open(replaceTab(state, key(dyn), tab), tab, { fixed: true });", fresh: "", catches: "chat" },
  "chat: locked one follows": { file: "chat-tabs.ts", old: "t.kind === \"preview\" && !t.locked && targetEqual(t.target, target));\n  if (!dyn || dyn.kind", fresh: "t.kind === \"preview\" && targetEqual(t.target, target));\n  if (!dyn || dyn.kind", catches: "chat" },
  "chat: follows in a foreign target": { file: "chat-tabs.ts", old: "!t.locked && targetEqual(t.target, target));\n  if (!dyn || dyn.kind", fresh: "!t.locked);\n  if (!dyn || dyn.kind", catches: "chat" },
  "chat: lock without effect": { file: "chat-tabs.ts", old: "...(t.locked ? {} : { locked: true })", fresh: "...(t.locked ? { locked: true } : {})", catches: "chat" },
  "chat: two remain unlocked": { file: "chat-tabs.ts", old: "if (t.locked) for (const x of s.tabs)", fresh: "if (false) for (const x of s.tabs)", catches: "chat" },
  "chat: back only closes": { file: "chat-tabs.ts", old: "const s = replaceTab(state, keyName, fresh), k = key(fresh);", fresh: "const s = close(stand, key);", catches: "chat" },
  "chat: preview not read": { file: "chat-tabs.ts", old: "if (x.kind === \"preview\") return pathValid(x.path) ?", fresh: "if (false) return pathValid(x.path) ?", catches: "chat" },
  "chat: lock not read": { file: "chat-tabs.ts", old: "...(x.locked === true ? { locked: true } : {})", fresh: "", catches: "chat" },
  "chat: key without lock": { file: "chat-tabs.ts", old: "JSON.stringify([...z, tab.path, tab.locked ? 1 : 0])", fresh: "JSON.stringify([...z, tab.path])", catches: "chat" },
  "chat: rename without preview": { file: "chat-tabs.ts", old: "if (t.kind !== \"diff\") { if (under(t.path, old))", fresh: "if (t.kind !== \"diff\") { if (t.kind === \"file\" && under(t.path, old))", catches: "chat" },
  "chat: delete without preview": { file: "chat-tabs.ts", old: ": under(t.path, path)) s = close(s, key(t));", fresh: ": t.kind === \"file\" && under(t.path, path)) s = close(s, key(t));", catches: "chat" },
  "chat: link unlocks": { file: "chat-tabs.ts", old: "path, ...(t.locked ? { locked: true } : {}) };", fresh: "path };", catches: "chat" },
  "chat: link without path check": { file: "chat-tabs.ts", old: "if (!t || t.kind !== \"preview\" || !pathValid(path)) return state;", fresh: "if (!t || t.kind !== \"preview\") return state;", catches: "chat" },
  "chat: as preview not locked": { file: "chat-tabs.ts", old: "path: t.path, locked: true };\n  if (keep)", fresh: "path: t.path };\n  if (keep)", catches: "chat" },
  "chat: as preview loses unsaved": { file: "chat-tabs.ts", old: "  if (keep) return open(state, fresh, { fixed: true });\n", fresh: "", catches: "chat" },
  "chat: current unchecked": { file: "chat-tabs.ts", old: "      if (x.current !== undefined && !text(x.current)) return null;\n", fresh: "", catches: "chat" },
  "chat: prior unchecked": { file: "chat-tabs.ts", old: "      if (x.prior !== undefined && !(typeof x.prior === \"string\" && /^[0-9a-f]{7,64}\\^?$/.test(x.prior))) return null;\n", fresh: "", catches: "chat" },
  "chat: current equal to the file stays": { file: "chat-tabs.ts", old: "text(x.current) && x.current !== file ?", fresh: "text(x.current) ?", catches: "chat" },
  "chat: key of old sources changes": { file: "chat-tabs.ts", old: "...(q.current || q.prior ? [q.current ?? \"\", q.prior ?? \"\"] : [])", fresh: "q.current ?? \"\", q.prior ?? \"\"", catches: "chat" },
  "chat: key without predecessor": { file: "chat-tabs.ts", old: "[q.current ?? \"\", q.prior ?? \"\"]", fresh: "[q.current ?? \"\"]", catches: "chat" },
  "chat: open file at the old name": { file: "chat-tabs.ts", old: "case \"change\": case \"commit\": return q.current ?? q.file;", fresh: "case \"change\": case \"commit\": return q.file;", catches: "chat" },
};

// ── Compile: the three sources, their dependencies (md-preview, timeAxis, diff-tab, tab-bar with explorer-decoration, commandPalette
//    with api/lsp.ts and a network-free stand-in for core.ts) and one copy per sabotage, in ONE tsc run. A copy imports the REAL
//    neighbours (a sabotaged editor-groups.ts acts only through its own call). ──
const LIB = ["editor-inputs.ts", "chat-tabs.ts", "editor-groups.ts", "md-preview.ts", "timeAxis.ts", "diff-tab.ts", "tab-bar.ts", "explorer-decoration.ts", "commandPalette.ts", "editor-raster.ts"];
const SOURCES = Object.fromEntries(LIB.map((d) => [d, read("src", "lib", d)]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-editor-inputs-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
for (const d of LIB) fs.writeFileSync(path.join(src, d), SOURCES[d]);
fs.writeFileSync(path.join(src, "api", "lsp.ts"), read("src", "lib", "api", "lsp.ts"));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in test: ${p}`); }\n");
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `${s.file.replace(/\.ts$/, "")}-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCES[s.file].replace(s.old, s.fresh));
  copies.push({ name, file, source: s.file, catches: s.catches, places: SOURCES[s.file].split(s.old).length - 1 });
}
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...files(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "editor-inputs.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = { E: await load("editor-inputs.ts"), G: await load("editor-groups.ts"), C: await load("chat-tabs.ts") };
const ROLE = { "editor-inputs.ts": "E", "editor-groups.ts": "G", "chat-tabs.ts": "C" };
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, m: { ...real, [ROLE[k.source]]: await load(k.file) } })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// ── The checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const t = (k, w) => (w ? k.replace(/\{(\w+)\}/g, (_, x) => String(w[x])) : k);
const L = (id, paths, active = paths[0] ?? null, preview = null) => ({ id, paths, active, preview });
const S = (groups, active = groups[0].id) => ({ groups, active });
const V = (p) => `\u0001preview\u0001${p}`, VG = (p) => `\u0001preview-locked\u0001${p}`;
const AE = (file, staged = false, repo = "web") => ({ kind: "change", repo, file, staged });
const H = "abc1234def5678abc1234def5678abc1234def56";
const pathsOf = (s) => s.groups.map((g) => g.paths);
const Z = { apiBase: "/api/workspaces/w1", instance: null }, Z2 = { apiBase: "/api/projects/p1", instance: null };

const CHECKS = {
  key: ({ E }) => {
    assert.equal(E.previewKey("docs/README.md"), V("docs/README.md"));
    assert.equal(E.previewKey("docs/README.md", true), VG("docs/README.md"));
    assert.deepEqual(E.inputOf("web/a.ts"), { kind: "file", path: "web/a.ts" }, "a path stays a file tab (a remembered state from before is valid)");
    assert.deepEqual(E.inputOf(V("README.md")), { kind: "preview", path: "README.md", locked: false });
    assert.deepEqual(E.inputOf(VG("README.md")), { kind: "preview", path: "README.md", locked: true }, "the lock survives reload");
    assert.equal(E.inputOf(V("a.ts")), null, "the preview of a non-Markdown file is not a tab");
    for (const x of ["", 5, null, "\u0001kaputt", "\u0001diff\u0001{", "\u0001diff\u0001{}", V("")]) assert.equal(E.inputOf(x), null, `unreadable: ${JSON.stringify(x)}`);
    const q = AE("a.ts");
    assert.deepEqual(E.inputOf(E.diffKey(q)), { kind: "diff", source: q }, "a diff reads back");
    const converted = { staged: false, file: "a.ts", kind: "change", repo: "web" };
    assert.equal(E.diffKey(converted), E.diffKey(q), "same source ⇒ same key, whatever the order");
    assert.equal(E.inputOf(`\u0001diff\u0001${JSON.stringify({ q: converted })}`), null, "not in fixed form: no second tab for the same source");
    assert.equal(E.diffKey(q, "x"), E.diffKey(q), "the title belongs only to a whole commit/stash");
    const whole = { kind: "commit-whole", repo: "", hash: H };
    assert.deepEqual(E.inputOf(E.diffKey(whole, "abc1234 - Fix")), { kind: "diff", source: whole, title: "abc1234 - Fix" });
    assert.equal(E.isFileTab("a.ts"), true); assert.equal(E.isFileTab(V("a.md")), false);
    assert.equal(E.fileTab("a.ts"), "a.ts"); assert.equal(E.fileTab(V("a.md")), null); assert.equal(E.fileTab(null), null);
    // A chat tab as the key of the groups (the chat timeline reads it — for a diff too).
    assert.equal(E.inputFromTab({ kind: "file", target: Z, path: "a.ts" }), "a.ts");
    assert.equal(E.inputFromTab({ kind: "preview", target: Z, path: "a.md", locked: true }), VG("a.md"));
    assert.equal(E.inputFromTab({ kind: "preview", target: Z, path: "a.md" }), V("a.md"));
    assert.equal(E.inputFromTab({ kind: "diff", target: Z, source: q }), E.diffKey(q));
  },
  buffer: ({ E }) => {
    const un = E.diffKey(AE("c.ts")), ge = E.diffKey(AE("d.ts", true));
    const co = E.diffKey({ kind: "commit", repo: "web", hash: H, file: "e.ts" });
    assert.equal(E.bufferFile("a.ts"), "a.ts");
    assert.equal(E.bufferFile(V("b.md")), null, "the preview reads the buffer but does not hold it");
    assert.equal(E.bufferFile(un), "web/c.ts", "the unstaged change shows the file buffer on the right");
    assert.equal(E.bufferFile(ge), null, "the staged one shows the index — no buffer");
    assert.equal(E.bufferFile(co), null);
    assert.equal(E.fileOf(V("b.md")), "b.md"); assert.equal(E.fileOf(co), "web/e.ts");
    assert.equal(E.fileOf(E.diffKey({ kind: "commit-whole", repo: "", hash: H })), null);
    // The timeline (VS Code TimelinePane): the file in front, also that of a diff — an entry opens its diff, the timeline stays.
    assert.equal(E.timeAxisFile("a.ts"), "a.ts"); assert.equal(E.timeAxisFile(co), "web/e.ts", "the diff of a commit: the timeline of its file");
    assert.equal(E.timeAxisFile(un), "web/c.ts"); assert.equal(E.timeAxisFile(ge), "web/d.ts");
    assert.equal(E.timeAxisFile(V("b.md")), null, "a preview is a webview — no timeline");
    assert.equal(E.timeAxisFile(E.diffKey({ kind: "commit-whole", repo: "", hash: H })), null, "a whole commit has no file");
    assert.equal(E.timeAxisFile(null), null); assert.equal(E.timeAxisFile("\u0001kaputt"), null);
    // Renamed: the file TODAY (`current`) — timeline, colour and "Open File" read it; the content still comes from the commit.
    const renamedKey = E.diffKey({ kind: "commit", repo: "web", hash: H, file: "old.ts", current: "fresh.ts" });
    assert.equal(E.timeAxisFile(renamedKey), "web/fresh.ts", "after a rename the timeline stays with the file as of today");
    assert.equal(E.fileOf(renamedKey), "web/fresh.ts");
    const s = S([L("g1", ["a.ts", V("b.md"), un]), L("g2", ["a.ts", ge])]);
    assert.deepEqual(E.heldFiles(s), ["a.ts", "web/c.ts"], "held: file tabs and unstaged diffs, each once");
    assert.deepEqual(E.openFiles(s), ["a.ts"], "open file tabs: no preview, no diff");
    assert.equal(E.otherHolds(s, "g1", "a.ts"), true, "the other group holds a.ts");
    assert.equal(E.otherHolds(s, "g1", un), false, "only this diff holds web/c.ts");
    assert.equal(E.otherHolds(S([L("g1", ["web/c.ts", un])]), "g1", un), true, "the file tab holds the same buffer as the diff");
    assert.equal(E.otherHolds(s, "g1", V("b.md")), false);
  },
  paths: ({ E }) => {
    const form = (p) => (p === "a.md" ? "b.md" : p), O = { target: Z }; // the target of the area where the rename/delete happened
    const diff = E.diffKey({ kind: "commit", repo: "", hash: H, file: "a.md" });
    assert.equal(E.formKey(form, O)("a.md"), "b.md");
    assert.equal(E.formKey(form, O)(V("a.md")), V("b.md"), "the preview follows");
    assert.equal(E.formKey(form, O)(VG("a.md")), VG("b.md"), "… locked stays locked");
    // A diff follows (the file today in `current`, the content still from the commit) — web/test/comparison.test.mjs computes it.
    assert.equal(E.formKey(form, O)(diff), E.diffKey({ kind: "commit", repo: "", hash: H, file: "a.md", current: "b.md" }), "a diff follows");
    // Deleted in the explorer (`hitsDeleted`) resp. removed from outside (`hitsFile`; web/test/comparison.test.mjs computes unsaved changes
    // and the comparison of two files).
    const hits = E.hitsDeleted((p) => p === "a.md", () => false, O);
    assert.equal(hits("a.md"), true); assert.equal(hits(V("a.md")), true, "the preview falls with its file");
    assert.equal(hits(diff), false, "a commit diff shows what was — it stays"); assert.equal(hits("\u0001kaputt"), false);
    assert.equal(hits(E.diffKey(AE("a.md", false, ""))), true, "the working tree diff falls with its file (VS Code handleDeletedFile)");
    assert.equal(hits(E.diffKey(AE("a.md", true, ""))), false, "the index stays");
    const gone = E.hitsFile((p) => p === "a.md");
    assert.equal(gone("a.md"), true); assert.equal(gone(V("a.md")), true, "removed from outside: the preview falls with its file");
    assert.equal(gone(E.diffKey(AE("a.md", false, ""))), false, "removed from outside: the working tree diff stays (VS Code closeOnFileDelete off)");
    const s = E.tidy(S([L("g1", ["a.ts", V("x.ts"), "\u0001diff\u0001{"]), L("g2", ["\u0001kaputt"])]));
    assert.deepEqual(pathsOf(s), [["a.ts"]], "unreadable ones drop on reading, a group left empty too");
    const two = E.tidy(S([L("g1", [V("a.md"), "b.md", V("c.md")], "b.md")]));
    assert.equal(two.groups[0].paths.filter((k) => k.startsWith("\u0001preview\u0001")).length, 1, "a remembered state with two dynamic previews: one stays");
    // Restoring: file tabs AND previews are read (if the file is missing the tab drops); a diff shows a source in git.
    const change = E.diffKey(AE("x.ts"));
    assert.deepEqual(E.toRestore(S([L("g1", ["a.ts", V("b.md"), VG("c.md"), change])])), ["a.ts", V("b.md"), VG("c.md")]);
  },
  title: ({ E }) => {
    assert.equal(E.diffName(AE("src/app.ts"), t), "app.ts (Working Tree)", "index ↔ working tree as in VS Code (German \"Arbeitsstruktur\")");
    assert.equal(E.diffName(AE("src/app.ts", true), t), "app.ts (Index)", "HEAD ↔ Index");
    // VS Code `git.timeline.openDiff`: "{0} ({1}) ↔ {0} ({2})", {0} the file name TODAY, {1} the predecessor, {2} the commit — eight characters.
    const H2 = "fedcba9876543210fedcba9876543210fedcba98";
    assert.equal(E.diffName({ kind: "commit", repo: "", hash: H, file: "docs/README.md", prior: H2 }, t), "README.md (fedcba98) ↔ README.md (abc1234d)", "a commit of the timeline");
    assert.equal(E.diffName({ kind: "commit", repo: "", hash: H, file: "README.md" }, t), "README.md (abc1234d^) ↔ README.md (abc1234d)", "without predecessor: <ref>^");
    assert.equal(E.diffName({ kind: "commit", repo: "", hash: H, file: "old.md", current: "docs/fresh.md", prior: H2 }, t), "fresh.md (fedcba98) ↔ fresh.md (abc1234d)", "renamed: the name today");
    assert.equal(E.untrackedTitle("docs/README.md", t), "README.md (Untracked)", "\"Open Changes\" on an untracked file (VS Code \"{0} (Untracked)\")");
    assert.equal(E.diffName({ kind: "stash", repo: "", ref: "stash@{0}" }, t), "stash@{0}");
    assert.equal(E.diffName({ kind: "commit-whole", repo: "", hash: H }, t, { title: "abc1234 - Fix" }), "abc1234 - Fix");
    assert.equal(E.diffName({ kind: "commit-whole", repo: "", hash: H }, t), "Commit abc1234");
    assert.deepEqual(E.tabTitle(V("docs/README.md"), t), { name: "Preview README.md", hint: "docs/README.md" });
    assert.deepEqual(E.tabTitle(VG("docs/README.md"), t), { name: "[Preview] README.md", hint: "docs/README.md" });
    assert.deepEqual(E.tabTitle("web/a.ts", t), { name: "a.ts", hint: "web/a.ts" });
    assert.deepEqual(E.tabTitle(E.diffKey(AE("a.ts")), t), { name: "a.ts (Working Tree)", hint: "web/a.ts · Working tree ↔ Index" });
    assert.equal(E.tabTitle(E.diffKey({ kind: "commit-whole", repo: "", hash: H }, "abc1234 - Fix"), t).name, "abc1234 - Fix", "the subject from the key");
  },
  preview: ({ E, G }) => {
    // ⇧⌘V: right of the source in the SAME group, fixed, active.
    const s0 = S([L("g1", ["a.md", "b.ts"], "a.md")]);
    const s1 = E.openPreview(s0, "g1", "a.md");
    assert.deepEqual(s1.groups[0].paths, ["a.md", V("a.md"), "b.ts"], "⇧⌘V: right of the source");
    assert.equal(s1.groups[0].active, V("a.md")); assert.equal(s1.groups[0].preview, null, "a preview is never italic");
    assert.equal(E.openPreview(s0, "g1", "b.ts"), s0, "no preview of a non-Markdown file");
    // A second one takes the unlocked one's place.
    const s2 = E.openPreview(G.activateTab({ ...s1, groups: [{ ...s1.groups[0], paths: [...s1.groups[0].paths, "c.md"] }] }, "g1", "c.md"), "g1", "c.md");
    assert.deepEqual(s2.groups[0].paths, ["a.md", V("c.md"), "b.ts", "c.md"], "at most one unlocked preview per group");
    // ⌘K V: into the group beside (right, otherwise a new one on the right — VS Code `ViewColumn.Beside`) — the source stays active.
    const d1 = E.openPreview(s0, "g1", "a.md", { beside: true });
    assert.equal(d1.groups.length, 2); assert.deepEqual(d1.groups[1].paths, [V("a.md")], "⌘K V: a new group on the right with the preview");
    assert.deepEqual(G.rasterOf(d1).situation, "sideBySide", "⌘K V: the new group is on the right, not below");
    assert.deepEqual(d1.groups[0].paths, ["a.md", "b.ts"]); assert.equal(d1.active, "g1", "⌘K V: the focus stays in the editor");
    const right = E.openPreview(S([L("g1", ["a.md"]), L("g2", ["x.ts"])]), "g1", "a.md", { beside: true });
    assert.deepEqual(pathsOf(right), [["a.md"], ["x.ts", V("a.md")]], "⌘K V with a group on the right: into it");
    const two = S([L("g1", ["x.ts"]), L("g2", ["a.md"])], "g2");
    const d2 = E.openPreview(two, "g2", "a.md", { beside: true });
    assert.deepEqual(pathsOf(d2), [["x.ts"], ["a.md"], [V("a.md")]], "⌘K V from the right group: a new one to its right, never the left one");
    assert.equal(d2.active, "g2");
    // Following: the unlocked ones in EVERY group follow the Markdown file in front; locked ones stay.
    const f0 = S([L("g1", ["a.md", V("a.md"), "c.md"], "c.md"), L("g2", [VG("x.md"), V("y.md")])]);
    const f1 = E.followUpPreviews(f0, "c.md");
    assert.deepEqual(pathsOf(f1), [["a.md", V("c.md"), "c.md"], [VG("x.md"), V("c.md")]], "the previews follow, the locked one stays");
    assert.equal(E.followUpPreviews(f0, "b.ts"), f0, "none follows a non-Markdown file");
    assert.equal(E.followingPreview(f0.groups[1]), V("y.md"));
    // Locking: in place; when unlocked a second unlocked one drops.
    assert.deepEqual(E.toggleLock(s1, "g1", V("a.md")).groups[0].paths, ["a.md", VG("a.md"), "b.ts"]);
    assert.deepEqual(E.toggleLock(S([L("g1", [VG("a.md"), V("b.md")])]), "g1", VG("a.md")).groups[0].paths, [V("a.md")], "unlocked: at most one follows");
    assert.equal(E.toggleLock(s1, "g1", "a.md"), s1);
    // Back to the source: if it is there the preview closes; otherwise the source takes its place.
    const z1 = E.toSource(s1, "g1", V("a.md"));
    assert.deepEqual(z1.groups[0].paths, ["a.md", "b.ts"]); assert.equal(z1.groups[0].active, "a.md");
    const z2 = E.toSource(S([L("g1", [V("a.md"), "b.ts"])]), "g1", V("a.md"));
    assert.deepEqual(z2.groups[0].paths, ["a.md", "b.ts"], "without the source in the group: in the preview's place"); assert.equal(z2.groups[0].active, "a.md");
    assert.equal(E.toSource(s1, "g1", "a.md"), s1, "only a preview leads to the source");
    // After EVERY step at most one unlocked preview per group (VS Code `onDidChangeViewState`): the one in front, otherwise the most recently used.
    const e0 = S([{ ...L("g1", [V("a.md"), "x.ts", V("b.md"), VG("c.md")], "x.ts"), last: ["x.ts", V("b.md"), V("a.md")] }, L("g2", [V("d.md")])]);
    assert.deepEqual(pathsOf(E.oneDynamicPreview(e0)), [["x.ts", V("b.md"), VG("c.md")], [V("d.md")]], "the most recently used one stays, the locked one too");
    const e1 = S([{ ...L("g1", [V("a.md"), V("b.md")], V("b.md")), last: [V("a.md")] }]);
    assert.deepEqual(pathsOf(E.oneDynamicPreview(e1)), [[V("b.md")]], "the one in front stays (before the most recently used)");
    assert.equal(E.oneDynamicPreview(s1), s1, "one: nothing to do");
    // "Open as Preview" (VS Code `markdown.reopenAsPreview`): the locked preview in the file's place; with unsaved changes beside it.
    const a0 = S([L("g1", ["x.ts", "a.md", "b.ts"], "a.md")]);
    const a1 = E.asPreview(a0, "g1", "a.md", false);
    assert.deepEqual(a1.groups[0].paths, ["x.ts", VG("a.md"), "b.ts"], "in its place, locked"); assert.equal(a1.groups[0].active, VG("a.md"));
    const a2 = E.asPreview(a0, "g1", "a.md", true);
    assert.deepEqual(a2.groups[0].paths, ["x.ts", "a.md", VG("a.md"), "b.ts"], "unsaved: the file stays, the preview beside it");
    assert.equal(a2.groups[0].active, VG("a.md")); assert.equal(a2.groups[0].preview, null, "fixed");
    assert.equal(E.asPreview(S([L("g1", ["x.ts"])]), "g1", "x.ts", false).groups[0].paths[0], "x.ts", "Markdown only");
  },
  change: ({ E }) => {
    assert.deepEqual(E.changeSource("web/a.ts", "web", " M", "M"), AE("a.ts"), "working tree only: (Working Tree)");
    assert.deepEqual(E.changeSource("web/a.ts", "web", "M ", "M"), AE("a.ts", true), "index only: (Index)");
    assert.deepEqual(E.changeSource("web/a.ts", "web", "MM", "M"), AE("a.ts"), "both: the unstaged one (VS Code opens the working tree)");
    // Untracked: no left side — VS Code opens the file itself (`resolveChangeCommand`: "{0} (Untracked)").
    assert.equal(E.changeSource("web/a.ts", "web", "??", "U"), "untracked", "new, untracked: the file");
    assert.equal(E.changeSource("web/a.ts", "web", null, "untracked"), "untracked", "an older server without xy: by kind");
    assert.deepEqual(E.changeSource("web/a.ts", "web", null, "M"), AE("a.ts"), "an older server without xy: the unstaged one");
    assert.deepEqual(E.changeSource("a.ts", "", " M", "M"), AE("a.ts", false, ""), "the repo at the root");
    for (const [p, r, xy, a] of [["webx/a.ts", "web", " M", "M"], ["web/a.ts", "web", " M", null], ["web/a.ts", "web", "  ", "M"], ["web", "web", " M", "M"], [V("a.md"), "", " M", "M"]]) {
      assert.equal(E.changeSource(p, r, xy, a), null, `no change: ${JSON.stringify([p, r, xy, a])}`);
    }
  },
  replaceIn: ({ G }) => {
    const s = S([{ ...L("g1", ["a", "b", "c"], "b", "b"), last: ["b", "a"] }, L("g2", ["b"])]);
    const r = G.replaceIn(s, "g1", "b", "x");
    assert.deepEqual(r.groups[0], { id: "g1", paths: ["a", "x", "c"], active: "x", preview: "x", last: ["x", "a"] }, "in ITS place; active, italic, trail follow");
    assert.deepEqual(r.groups[1].paths, ["b"], "only in the named group");
    const d = G.replaceIn(s, "g1", "b", "c");
    assert.deepEqual(d.groups[0].paths, ["a", "c"], "if the target is already there the old one drops"); assert.equal(d.groups[0].active, "c");
    assert.equal(d.groups[0].preview, null, "the target was fixed — it stays fixed");
    assert.deepEqual(G.replaceIn(s, "g1", "q", "x"), s);
    const lane = G.replaceIn(S([{ ...L("g1", ["a", "b", "c"], "b"), last: ["b", "c", "a"] }]), "g1", "c", "x");
    assert.deepEqual(lane.groups[0].last, ["b", "x", "a"], "the replaced tab keeps its place in the \"most recently used\" trail");
  },
  chat: ({ C }) => {
    const file = { kind: "file", target: Z, path: "a.md" };
    const st0 = C.open(C.emptyState(), file, { fixed: true });
    const st1 = C.openPreview(st0, Z, "a.md");
    const vk = C.key({ kind: "preview", target: Z, path: "a.md" });
    assert.deepEqual(st1.tabs.map((x) => [x.kind, x.path]), [["file", "a.md"], ["preview", "a.md"]]);
    assert.equal(st1.active, vk); assert.equal(st1.preview, null, "the preview is fixed");
    const st2 = C.openPreview(st1, Z, "b.md");
    assert.deepEqual(st2.tabs.map((x) => [x.kind, x.path]), [["file", "a.md"], ["preview", "b.md"]], "one unlocked per target, in its place");
    assert.deepEqual(C.followUpPreview(st1, Z, "c.md").tabs[1], { kind: "preview", target: Z, path: "c.md" }, "it follows the file in front");
    assert.equal(C.followUpPreview(st1, Z2, "c.md"), st1, "… only in its own target");
    const locked = C.toggleLock(st1, vk);
    assert.equal(locked.tabs[1].locked, true); assert.equal(C.followUpPreview(locked, Z, "c.md"), locked, "a locked one does not follow");
    const twoG = C.openPreview(locked, Z, "b.md");
    assert.equal(twoG.tabs.filter((x) => x.kind === "preview").length, 2, "an unlocked one beside a locked one");
    const unlocked = C.toggleLock(twoG, C.key({ kind: "preview", target: Z, path: "a.md", locked: true }));
    assert.deepEqual(unlocked.tabs.filter((x) => x.kind === "preview").map((x) => x.path), ["a.md"], "unlocked: at most one follows");
    const q1 = C.toSource(st1, vk);
    assert.deepEqual(q1.tabs.map((x) => x.kind), ["file"]); assert.equal(q1.active, C.fileKey(Z, "a.md"));
    const onlyV = C.openPreview(C.emptyState(), Z, "a.md");
    const q2 = C.toSource(onlyV, vk);
    assert.deepEqual(q2.tabs, [file], "without a file tab: the source in the preview's place"); assert.equal(q2.preview, null);
    assert.deepEqual(C.checkTab({ kind: "preview", target: Z, path: "a.md", locked: true }), { kind: "preview", target: Z, path: "a.md", locked: true }, "the preview survives reload");
    assert.deepEqual(C.rename(st1, Z, "a.md", "b.md").tabs.map((x) => x.path), ["b.md", "b.md"], "renaming takes the preview along");
    assert.deepEqual(C.removeFiles(st1, Z, "a.md", () => true).tabs, [], "deleting closes the preview");
    // A link in the preview switches THIS preview (the locked one too, VS Code `this.update`); an invalid path does nothing.
    const w1 = C.switchPreview(locked, C.key({ kind: "preview", target: Z, path: "a.md", locked: true }), "docs/b.md");
    assert.deepEqual(w1.tabs[1], { kind: "preview", target: Z, path: "docs/b.md", locked: true }, "the locked one switches and stays locked");
    assert.deepEqual(C.switchPreview(st1, vk, "b.md").tabs[1], { kind: "preview", target: Z, path: "b.md" });
    assert.equal(C.switchPreview(st1, vk, "../x.md"), st1, "a path out of the target switches nothing");
    // "Open as Preview" in the chat.
    const dk = C.fileKey(Z, "a.md");
    const av = C.asPreview(st0, dk, false);
    assert.deepEqual(av.tabs, [{ kind: "preview", target: Z, path: "a.md", locked: true }], "in the file's place, locked");
    assert.deepEqual(C.asPreview(st0, dk, true).tabs.map((x) => [x.kind, x.locked ?? false]), [["file", false], ["preview", true]], "unsaved: beside");
    // The source of a commit diff carries the file today and the predecessor — checked, in fixed form; old sources keep their key.
    const H2 = "fedcba9876543210fedcba9876543210fedcba98";
    const cq = { kind: "commit", repo: "", hash: H, file: "old.md", current: "fresh.md", prior: H2 };
    assert.deepEqual(C.checkSource({ prior: H2, current: "fresh.md", file: "old.md", hash: H, repo: "", kind: "commit" }), cq);
    assert.deepEqual(Object.keys(C.checkSource(cq)), ["kind", "repo", "hash", "file", "current", "prior"], "fixed order");
    assert.deepEqual(C.checkSource({ ...cq, current: "old.md" }), { kind: "commit", repo: "", hash: H, file: "old.md", prior: H2 }, "if it is named today as there: without `current`");
    assert.equal(C.checkSource({ ...cq, current: 5 }), null); assert.equal(C.checkSource({ ...cq, prior: "HEAD" }), null);
    assert.equal(C.diffPath(cq), "fresh.md", "\"Open File\" opens the file as of today");
    const without = { kind: "commit", repo: "", hash: H, file: "a.md" };
    assert.deepEqual(C.sourceParts(without), ["commit", "", H, "a.md", ""], "a source from before keeps its key");
    assert.notEqual(C.key({ kind: "diff", target: Z, source: { ...without, prior: H2 } }), C.key({ kind: "diff", target: Z, source: { ...without, prior: H } }), "the predecessor belongs to the source");
  },
};

test("(1) computations: key, buffer, paths, title, preview, Open Changes, replaceIn, chat — as in VS Code", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) counter-tests: each sabotage appears exactly once in its source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}× in ${k.source})`);
  assert.deepEqual(stale, [], "sabotages whose spot is not exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.m); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages no check catches");
  console.log(`  [editor-inputs] ${sabotaged.length} sabotages on the computations, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  timeAxis: read("src", "components", "code", "explorer", "TimeAxis.tsx"),
  pane: read("src", "components", "CodePane.tsx"),
  connection: read("src", "components", "code", "editor-groups-connection.ts"),
  difftab: read("src", "components", "code", "DiffTab.tsx"),
  turnout: read("src", "components", "chat", "DiffTabSwitch.tsx"),
  bar: read("src", "components", "chat", "ChatTabBar.tsx"),
  chat: read("src", "components", "chat", "ChatCodeArea.tsx"),
  input: read("src", "components", "code", "InputParts.tsx"),
  chattabs: read("src", "components", "chat", "chatTabs.ts"),
  preview: read("src", "components", "code", "MarkdownPreview.tsx"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
function sources(q) {
  const z = withoutComments(q.timeAxis), c = withoutComments(q.pane), a = withoutComments(q.connection), d = withoutComments(q.difftab);
  const w = withoutComments(q.turnout), l = withoutComments(q.bar), ch = withoutComments(q.chat), one = withoutComments(q.input), ct = withoutComments(q.chattabs);
  const mv = withoutComments(q.preview);
  // Timeline: single click the italic preview, double click fixed; "Open Commit" as in VS Code `viewCommit` as a preview without focus
  // (`preview: true, preserveFocus: true`); the menu as in VS Code.
  assert.ok(z.includes("onClick={(m) => { if (m.detail < 2) open(e); }}") && z.includes("onDoubleClick={() => open(e, true)}"), "timeline: click/double click do not open as in VS Code");
  assert.ok(z.includes("onOpen(entrySource(repo, e, { current: target.file, prior }), { title: diffTitle(target.file, e.hash, prior), short: e.short, fixed });"), "timeline: the diff does not go as a tab with title and fixed/italic");
  assert.ok(z.includes("const openCommit = (e: TimeAxisEntry) => onOpen(commitSource(repo, e), { title: commitTitle(e), short: e.short, fixed: false, focus: false });"), "timeline: \"Open Commit\" is missing (or not as a preview without focus)");
  assert.ok(z.includes("{ id: \"timeline.openDiff\", label: t(\"Open Changes\"), execute: () => open(e) },") && z.includes("{ id: \"timeline.viewCommit\", label: t(\"Open Commit\"), execute: () => openCommit(e) },")
    && z.includes("{ id: \"timeline.copyCommitId\", label: t(\"Copy Commit Hash\"), execute: () => copyText(e.hash) },"), "timeline: the context menu is not that of VS Code");
  assert.ok(z.includes("onClick={(m) => { m.stopPropagation(); openCommit(e); }}"), "timeline: the \"Open Commit\" button in the row is missing");
  // CodePane: the diff as a tab of the group (italic, unless fixed or without the preview setting), with the SAME building block as the chat.
  assert.ok(c.includes("const fixed = Boolean(o.fixed) || !settingsRef.current.preview;") && c.includes("applyGroups((s) => G.open(s, E.diffKey(source, o.title), { fixed, unsaved: dirtyOf }));"), "the timeline diff opens no tab");
  // The timeline stays when its entry opens its diff (VS Code: the diff shows the same file) — it reads the file of the tab in front.
  assert.ok(c.includes("const timeAxisFile = E.timeAxisFile(controlled ? (controlled.input ?? activePath) : activeKeyIntern);")
    && ch.includes("input: activeTab && targetEqual(activeTab.target, z) ? inputFromTab(activeTab) : null,")
    && c.includes("activeFile={isActive && timeAxisFile && !timeAxisFile.startsWith(\"/\") ? timeAxisFile : null}"), "the timeline goes empty as soon as a diff is in front");
  assert.ok(c.includes("{input?.kind === \"diff\" && g.active && diffFor(g, g.active, input.source)}")
    && c.includes("<DiffInput t={t} tabKey={key} source={source} target={target} editor={editorHolder} buttonsIn={diffLocations[g.id] ?? null} location={diffLocation(g.id)} status={fileStatus}")
    && one.includes("<DiffTab key={tabKey} source={source} target={target} bufferTarget={target} editor={editor} header={false} buttonsIn={buttonsIn} location={location}"), "the diff tab is not drawn (with the chat's building block)");
  assert.ok(c.includes("onFileOpen={file ? () => { applyGroups((s) => G.activateGroup(s, g.id)); void openFile(file, undefined, true); focusWish.current = g.id; } : null}")
    && one.includes("buttonsExtra={onFileOpen ? <FileOpenButton t={t} onClick={onFileOpen} /> : null}"), "\"Open File\" is missing on the diff tab (or drops the focus — VS Code openFile focuses the editor)");
  assert.ok(c.includes("onFixed={() => applyGroups((s) => G.keep(s, key, g.id))}") && one.includes("onUnsaved={(d) => { if (d) onFixed(); }}"), "typing in the diff does not fix the tab");
  assert.ok(one.includes("if (kind === \"diff\") return diffLocation ? <span ref={diffLocation} className=\"flex items-center gap-0.5\" data-diff-buttons-location /> : null;")
    && c.includes("if (e?.kind === \"diff\") return gid ? <EditorTitleButtons t={t} kind=\"diff\" diffLocation={diffLocationOf(gid)} /> : null;"), "the diff buttons have no place in the title row");
  // After saving the diff re-reads by itself — the group only triggers the git status (otherwise it read three times).
  assert.ok(c.includes("onSaved={refreshGit}") && !c.includes("onSaved={() => { setFileStatus((n) => n + 1); refreshGit(); }}"), "saving in the diff reads several times");
  // "Open Changes" (VS Code `git.openChange`) in the title bar of a changed file.
  assert.ok(c.includes("return repo ? E.changeSource(path, repo.relPath ?? \"\", gitXY[path] ?? null, gitStatus[path] ?? null) : null;")
    && one.includes("{ id, symbol: \"compare-changes\", title: t(\"Open Changes\"), data: { \"data-changes-open\": \"\" }, execute: () => d.change?.() }")
    && c.includes("change: change && gid ? () => changeOpen(gid, p, change) : null,")
    && c.includes(": G.open(G.activateGroup(x, gid), E.diffKey(q), { fixed: !settingsRef.current.preview, unsaved: dirtyOf, group: gid }));"), "\"Open Changes\" is missing");
  // … on an untracked file: the file itself, its tab is named "README.md (Untracked)" until it closes.
  assert.ok(c.includes("if (q === \"untracked\") setUntracked((m) => (m.has(path) ? m : new Set([...m, path])));")
    && c.includes("applyGroups((x) => q === \"untracked\" ? G.activateTab(G.activateGroup(x, gid), gid, path)")
    && c.includes("display: inputDisplay(p, t, untracked.has(p))")
    && c.includes("setUntracked((m) => ([...m].every((p) => files.has(p)) ? m : new Set([...m].filter((p) => files.has(p)))));")
    && one.includes("if (e.kind === \"file\") return untracked ? { kind: \"file\", name: E.untrackedTitle(e.path, t), hint: e.path, symbolPath: e.path, relPath: e.path, explorer: true } : undefined;"), "\"Open Changes\" on an untracked file does not open it as in VS Code");
  // Per group after EVERY step at most one unlocked preview; a restored preview is read (if its file is missing it drops).
  assert.ok(a.includes("const old = ref.current, fresh = oneDynamicPreview(f(old));"), "split/move/drag yield a second unlocked preview");
  assert.ok(a.includes("restored.current = new Set(toRestore(s));"), "restored previews are not read");
  // ⌘S with the focus outside the surface: the diff in front saves (groups and chat), without saving twice if the surface did.
  assert.ok(c.includes("if (e.nativeEvent.defaultPrevented) return; e.preventDefault(); if (activePath) saveFile(activePath); else if (!stRef.current) saveLocation(diffLocation(gr.ref.current.active)); }"), "⌘S does not save the diff in front (groups)");
  assert.ok(ct.includes("saveLocation(`chat:${chatKeyRef.current}`);") && ct.includes("&& !(ev.target instanceof Element && ev.target.closest(\".cm-editor\"))) {"), "⌘S does not save the diff in front (chat)");
  assert.ok(d.includes("useEffect(() => (location ? reportSave(location, () => { void saveRef.current(); }) : undefined), [location]);") && w.includes("      location={location}\n") && ch.includes("          location={location}\n"), "the diff does not register for saving");
  // Scroll position and caret survive detaching (tab switch) — in the diff and in the preview; the count goes with the surface.
  assert.ok(d.includes("const r = roleOf(rk);") && d.includes("remember = () => { if (alive) rememberRole(rk, { top: roller.scrollTop, header: b.state.selection.main.head }); };")
    && d.includes("roller.addEventListener(\"scroll\", remember, { passive: true });"), "the diff loses scroll position/caret on tab switch");
  assert.ok(d.includes("run.current.onCount?.(null);"), "the change count stays after detaching");
  assert.ok(mv.includes("f.scrollTop = (scrollKey ? roleOf(scrollKey)?.top : undefined) ?? 0;") && mv.includes("const remember = () => rememberRole(scrollKey, { top: f.scrollTop });"), "the preview loses its scroll position on tab switch");
  // The palette lists only file tabs as open editors — not a file held only by a diff.
  assert.ok(c.includes("open: isControlled ? tabs.map((x) => x.path) : E.openFiles(gr.state),"), "the palette lists files held only by a diff");
  // Buffer: diffs of the unstaged change hold it; closing asks only the last holder.
  assert.ok(c.includes("const openKey = controlled ? null : E.heldFiles(gr.state).join(\"\\n\");"), "the view does not hold the diff buffers");
  assert.ok(c.includes("!E.otherHolds(gr.ref.current, gid, key) &&"), "closing asks although another tab holds the buffer");
  assert.ok(a.includes("if (s) s = tidy(s);"), "reload keeps unreadable tabs");
  // The building block: ⌥F5/⇧⌥F5 and the change count; "Open File" in the chat too; the same names in the chat.
  assert.ok(d.includes("{ key: \"Alt-F5\", run: goToNextChunk, preventDefault: true },") && d.includes("{ key: \"Shift-Alt-F5\", run: goToPreviousChunk, preventDefault: true },"), "⌥F5/⇧⌥F5 are missing");
  assert.ok(d.includes("data-diff-count={count}"), "the change count is missing");
  assert.ok(w.includes("buttonsExtra={open ? <FileOpenButton t={t} onClick={() => openFile(open)} /> : null}"), "\"Open File\" is missing in the chat");
  assert.ok(l.includes("return diffName(tab.source, t, { title: tab.title, short: tab.short });"), "the chat names diffs with its own computation");
  assert.ok(ch.includes("{ fixed: Boolean(o.fixed) }"), "\"Open Commit\" in the chat is not fixed");
  for (const k of ["{name} (Working Tree)", "{name} (Untracked)", "Open Changes", "Open Commit", "Copy Commit Hash", "Copy Commit Message", "Previous Change", "{n} change", "{n} changes"]) {
    assert.ok(q.i18n.includes(`\n  ${JSON.stringify(k)}: `), `"${k}" without English text`);
  }
}
const SOURCE_SABOTAGES = [
  ["click opens twice", "timeAxis", "onClick={(m) => { if (m.detail < 2) open(e); }}", "onClick={() => open(e)}"],
  ["double click not fixed", "timeAxis", "onDoubleClick={() => open(e, true)}", "onDoubleClick={() => open(e)}"],
  ["timeline always fixed", "timeAxis", "short: e.short, fixed });", "short: e.short, fixed: true });"],
  ["commit fixed", "timeAxis", "{ title: commitTitle(e), short: e.short, fixed: false, focus: false }", "{ title: commitTitle(e), short: e.short, fixed: true, focus: false }"],
  ["commit takes the focus", "timeAxis", "{ title: commitTitle(e), short: e.short, fixed: false, focus: false }", "{ title: commitTitle(e), short: e.short, fixed: false }"],
  ["diff with the old name", "timeAxis", "title: diffTitle(target.file, e.hash, prior)", "title: diffTitle(e.file, e.hash, before)"],
  ["menu without commit", "timeAxis", "{ id: \"timeline.viewCommit\", label: t(\"Open Commit\"), execute: () => openCommit(e) },", ""],
  ["inline button dead", "timeAxis", "onClick={(m) => { m.stopPropagation(); openCommit(e); }}", "onClick={(m) => { m.stopPropagation(); }}"],
  ["timeline without setting", "pane", "const fixed = Boolean(o.fixed) || !settingsRef.current.preview;", "const fixed = Boolean(o.fixed);"],
  ["timeline only at file tabs", "pane", "const timeAxisFile = E.timeAxisFile(controlled ? (controlled.input ?? activePath) : activeKeyIntern);", "const timeAxisFile = activePath;"],
  ["timeline in the chat empty at diff", "pane", "controlled ? (controlled.input ?? activePath) : activeKeyIntern", "controlled ? activePath : activeKeyIntern"],
  ["chat does not report the tab in front", "chat", "input: activeTab && targetEqual(activeTab.target, z) ? inputFromTab(activeTab) : null,", "input: null,"],
  ["timeline reads the file tab", "pane", "activeFile={isActive && timeAxisFile && !timeAxisFile.startsWith(\"/\") ? timeAxisFile : null}", "activeFile={active && activePath && !activePath.startsWith(\"/\") ? activePath : null}"],
  ["timeline without tab", "pane", "applyGroups((s) => G.open(s, E.diffKey(source, o.title), { fixed, unsaved: dirtyOf }));", ""],
  ["diff tab empty", "pane", "{input?.kind === \"diff\" && g.active && diffFor(g, g.active, input.source)}", ""],
  ["diff tab with its own header", "input", "editor={editor} header={false} buttonsIn={buttonsIn}", "editor={editor} buttonsIn={buttonsIn}"],
  ["diff tab without location", "pane", "buttonsIn={diffLocations[g.id] ?? null} location={diffLocation(g.id)} status={fileStatus}", "buttonsIn={diffLocations[g.id] ?? null} stand={fileStatus}"],
  ["Open File missing", "pane", "onFileOpen={file ? () =>", "onFileOpen={false ? () =>"],
  ["Open File button missing", "input", "buttonsExtra={onFileOpen ? <FileOpenButton", "buttonsExtra={false ? <FileOpenButton"],
  ["Open File without focus", "pane", "void openFile(file, undefined, true); focusWish.current = g.id; } : null}", "void openFile(file, undefined, true); } : null}"],
  ["typing does not fix", "pane", "onFixed={() => applyGroups((s) => G.keep(s, key, g.id))}", "onFixed={() => undefined}"],
  ["typing does not report", "input", "onUnsaved={(d) => { if (d) onFixed(); }}", "onUnsaved={() => undefined}"],
  ["buttons without location", "input", "<span ref={diffLocation} className=\"flex items-center gap-0.5\" data-diff-buttons-location />", "<span className=\"flex items-center gap-0.5\" data-diff-buttons-location />"],
  ["buttons without the group location", "pane", "diffLocation={diffLocationOf(gid)}", ""],
  ["saving reads three times", "pane", "onSaved={refreshGit}", "onSaved={() => { setFileStatus((n) => n + 1); refreshGit(); }}"],
  ["Open Changes without xy", "pane", "gitXY[path] ?? null, gitStatus[path] ?? null", "null, gitStatus[path] ?? null"],
  ["Open Changes button dead", "pane", "change: change && gid ? () => changeOpen(gid, p, change) : null,", "change: null,"],
  ["Open Changes button without effect", "input", "execute: () => d.change?.() }", "execute: () => undefined }"],
  ["untracked never marked", "pane", "if (q === \"untracked\") setUntracked(", "if (false) setUntracked("],
  ["untracked without title", "pane", "display: inputDisplay(p, t, untracked.has(p))", "display: inputDisplay(p, t)"],
  ["untracked stays marked", "pane", "setUntracked((m) => ([...m].every((p) => files.has(p)) ? m : new Set([...m].filter((p) => files.has(p)))));", ""],
  ["untracked title never", "input", "untracked ? { kind: \"file\", name: E.untrackedTitle(e.path, t),", "false ? { kind: \"file\", name: E.untrackedTitle(e.path, t),"],
  ["second dynamic one after splitting", "connection", "fresh = oneDynamicPreview(f(old));", "fresh = f(old);"],
  ["preview not restored", "connection", "restored.current = new Set(toRestore(s));", "restored.current = new Set();"],
  ["⌘S dead at the diff (groups)", "pane", " else if (!stRef.current) saveLocation(diffLocation(gr.ref.current.active));", ""],
  ["⌘S saves twice", "pane", "if (e.nativeEvent.defaultPrevented) return; ", ""],
  ["⌘S dead at the diff (chat)", "chattabs", "saveLocation(`chat:${chatKeyRef.current}`);", ""],
  ["⌘S twice in the editor (chat)", "chattabs", "&& !(ev.target instanceof Element && ev.target.closest(\".cm-editor\"))) {", ") {"],
  ["diff not registered", "difftab", "useEffect(() => (location ? reportSave(location, () => { void saveRef.current(); }) : undefined), [location]);", ""],
  ["chat does not pass the location", "turnout", "      location={location}\n", ""],
  ["diff forgets the scroll position", "difftab", "roller.addEventListener(\"scroll\", remember, { passive: true });", ""],
  ["diff restores nothing", "difftab", "const r = roleOf(rk);", "const r = undefined as { top: number; header?: number } | undefined;"],
  ["count stays", "difftab", "run.current.onCount?.(null);", ""],
  ["preview forgets the scroll position", "preview", "const remember = () => rememberRole(scrollKey, { top: f.scrollTop });", "const remember = () => undefined;"],
  ["palette lists diff files", "pane", "open: isControlled ? tabs.map((x) => x.path) : E.openFiles(gr.state),", "open: tabs.map((x) => x.path),"],
  ["Open Changes always fixed", "pane", "E.diffKey(q), { fixed: !settingsRef.current.preview, unsaved: dirtyOf, group: gid }", "E.diffKey(q), { fixed: true, unsaved: dirtyOf, group: gid }"],
  ["diffs hold no buffer", "pane", "E.heldFiles(gr.state).join(\"\\n\")", "E.openFiles(gr.state).join(\"\\n\")"],
  ["closing asks everyone", "pane", "!E.otherHolds(gr.ref.current, gid, key) &&", ""],
  ["reload keeps unreadable", "connection", "if (s) s = tidy(s);", ""],
  ["⌥F5 missing", "difftab", "{ key: \"Alt-F5\", run: goToNextChunk, preventDefault: true },", ""],
  ["count missing", "difftab", "data-diff-count={count}", "data-x={count}"],
  ["chat without Open File", "turnout", "buttonsExtra={open ? <FileOpenButton", "buttonsExtra={false ? <FileOpenButton"],
  ["chat names it itself", "bar", "return diffName(tab.source, t, { title: tab.title, short: tab.short });", "return tab.title || \"\";"],
  ["chat commit italic", "chat", "{ fixed: Boolean(o.fixed) }", "{}"],
  ["translation missing", "i18n", "  \"{name} (Working Tree)\": \"{name} (Arbeitsstruktur)\",\n", ""],
  ["translation Untracked missing", "i18n", "  \"{name} (Untracked)\": \"{name} (keine Nachverfolgung)\",\n", ""],
];

test("(2) sources: timeline, diff tabs in the groups, Open Changes, buffer, chat, English (with counter-tests)", (tt) => {
  sources(Q);
  for (const [name, k, old, fresh] of SOURCE_SABOTAGES) {
    const n = Q[k].split(old).length - 1;
    assert.equal(n, 1, `counter-test "${name}" is stale: the spot appears ${n}× in ${k}`);
    assert.throws(() => sources({ ...Q, [k]: Q[k].replace(old, fresh) }), undefined, `counter-test "${name}" is not caught`);
  }
  tt.diagnostic(`${SOURCE_SABOTAGES.length} counter-tests caught`);
});
