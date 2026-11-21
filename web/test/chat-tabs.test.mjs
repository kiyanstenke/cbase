// Code tabs in the chat. Two parts:
//
// (1) The model `web/src/lib/chat-tabs.ts`: a leaf without imports, compiled here with tsc and EXECUTED. Equality of a tab (display
//     fields do not count, staged/unstaged are two tabs), opening like VS Code (a preview replaces the preview in place, unless it
//     holds unsaved text; an open tab only becomes active; `fixed` makes it fixed), closing (never the chat, the most recently used
//     becomes active, otherwise the neighbour), a new tab right of the active one (VS Code `openPositioning: right`), the recency
//     trail survives reload and rename, Ctrl+Tab cycles INCLUDING the chat, loading with a check PER ROW (one broken row drops, not the
//     list; "empty is not unknown": a missing instance is no statement, only `null` means main), drafts with a cap, the shortcuts as
//     a matrix (Mac/other x desktop/browser; Cmd+W does not exist in the browser), the jump from outside (`target: null` = the chat's
//     target, resolved in `tabFromJump`, with a checked source), follow live (Edit/Write, sign on the chat tab), cleaning up (never
//     without a loaded list, never a draft), `sourceKey` <=> key pairwise and `relativeToRoot` (tool path -> path in the target,
//     outside null), the views (explorer, browser, terminal from the ... menu: open once, closable, in the row behind the chat, an old
//     state with "files" in front gets the explorer), keyboard of the bar (`tabKey`), nudge only for its own target (`nudgeFor`),
//     Cmd+P only with the fresh answer (`finderSituation`), the draft carries the checksum of its base.
// (2) Source guards: the Coding -> Files page stays UNCONTROLLED (only the chat's code area passes `controlled`), the controlled git
//     state has NO tick of its own (useGitState, the same store as the right bar), the own tab row is dropped only when controlled, the
//     stage wires bar and area, ChatPane calls the hook exactly once, a drop over the code area does not become an attachment, the
//     shortcuts act only with a visible bar and no open sheet, busyPrior, takeover only into the chat of THIS draft, only the visible
//     area writes, a too large draft stays in memory and reports it, the structure of the bar, the finder; every `t("...")` key of
//     the new parts is in i18n-de.ts.
//
// COUNTER-TESTS BUILT IN: every sabotage below is a copy of the source with ONE changed spot; the assigned check must throw on it
// (and the spot must appear exactly once in the source, otherwise the sabotage itself is stale and the test red).
//
// Run:  node --test web/test/chat-tabs.test.mjs
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
const source = read("src", "lib", "chat-tabs.ts");
const enSource = read("src", "lib", "i18n-de.ts");

// ── (1) Sabotages on the model: name -> { old, fresh, catches } ─────────────────────────────────────────────────────────────────────────────
const SABOTAGES = {
  "preview does not replace the preview": { old: "if (!opt.fixed && state.preview && !opt.unsaved?.(state.preview)) {", fresh: "if (false) {", catches: "open" },
  "preview with unsaved text is replaced": { old: "if (!opt.fixed && state.preview && !opt.unsaved?.(state.preview)) {", fresh: "if (!opt.fixed && state.preview) {", catches: "open" },
  "an open tab opens twice": { old: "if (i >= 0) {", fresh: "if (false) {", catches: "open" },
  "fixed does not fix an open preview": { old: "preview: opt.fixed && state.preview === k ? null : state.preview", fresh: "preview: state.preview", catches: "open" },
  "background comes to the front": { old: "if (opt.background) return i >= 0 ? state : { ...state, tabs: rightFromActive(state, tab) };", fresh: "", catches: "open" },
  // Most recently used after closing, new right of the active one, the trail stays.
  "closing takes the neighbour instead of the most recently used": { old: "(last[0] ?? r[i + 1] ?? r[i - 1] ?? CHAT)", fresh: "(r[i + 1] ?? r[i - 1] ?? CHAT)", catches: "last" },
  "new at the end instead of right of the active one": { old: "return used({ ...state, tabs: rightFromActive(state, tab), active: k, preview });", fresh: "return used({ ...state, tabs: [...stand.tabs, tab], active: k, preview });", catches: "last" },
  "activating remembers nothing": { old: "  return { ...s, last: [s.active, ...old.filter((k) => k !== s.active && present.has(k))] };", fresh: "  return s;", catches: "last" },
  "trail is not stored": { old: "...(s.last ? { last: s.last } : {})", fresh: "", catches: "last" },
  "trail loads foreign keys": { old: "typeof k === \"string\" && present.has(k)", fresh: "typeof k === \"string\"", catches: "last" },
  "rename forgets the trail": { old: "  if (state.last) s.last = [...new Set(state.last.map((k) => remap(k) ?? k))];\n", fresh: "", catches: "last" },
  "the chat tab is closable": { old: "if (keyName === CHAT) return state;\n  const r = queue(state);", fresh: "const r = queue(state);", catches: "close" },
  "left instead of right becomes active": { old: "r[i + 1] ?? r[i - 1] ?? CHAT", fresh: "r[i - 1] ?? r[i + 1] ?? CHAT", catches: "close" },
  "Ctrl+Tab without the chat": { old: "export const queue = (state: TabState): string[] => [CHAT, ...state.views, ...state.tabs.map(key)];", fresh: "export const queue = (state: TabState): string[] => [...state.views, ...state.tabs.map(key)];", catches: "paginate" },
  "Ctrl+Tab without the views": { old: "export const queue = (state: TabState): string[] => [CHAT, ...state.views, ...state.tabs.map(key)];", fresh: "export const queue = (state: TabState): string[] => [CHAT, ...state.tabs.map(key)];", catches: "paginate" },
  "a view opens twice": { old: "const views = state.views.includes(a) ? state.views : [...state.views, a];", fresh: "const views = [...state.views, a];", catches: "views" },
  "a closed view becomes active": { old: "(isView(keyName) && state.views.includes(keyName))", fresh: "isView(keyName)", catches: "views" },
  "a view stays open when closing": { old: "  const views = state.views.filter((a) => a !== keyName);\n", fresh: "  const views = stand.views;\n", catches: "views" },
  "an old files state loses the explorer": { old: "  if (!Array.isArray(o.views) && o.active === FILES) views.push(FILES);\n", fresh: "", catches: "load" },
  "unknown views are loaded": { old: "if (isView(a) && !views.includes(a)) views.push(a);", fresh: "if (typeof a === \"string\") views.push(a as View);", catches: "load" },
  "a broken row topples the list": { old: "    if (!t) continue;", fresh: "    if (!t) return emptyState();", catches: "load" },
  "a missing instance counts as main": { old: "if (x.instance === null) return { apiBase, instance: null };", fresh: "if (x.instance == null) return { apiBase, instance: null };", catches: "load" },
  "a path with .. passes": { old: "return p.split(\"/\").every((g) => g !== \"\" && g !== \".\" && g !== \"..\");", fresh: "return true;", catches: "load" },
  "duplicate rows stay": { old: "    if (keys.has(k)) continue;\n", fresh: "", catches: "load" },
  "active key unchecked": { old: "(o.active === CHAT || (isView(o.active) && views.includes(o.active)) || keys.has(o.active))", fresh: "true", catches: "load" },
  "copy of a foreign project": { old: "if (!pid || !instance.startsWith(`${pid}/`)) return null;", fresh: "", catches: "load" },
  "empty state is stored": { old: "if (s.tabs.length === 0 && s.views.length === 0 && s.active === CHAT) return null;", fresh: "", catches: "load" },
  "open views are not stored": { old: "if (s.tabs.length === 0 && s.views.length === 0 && s.active === CHAT) return null;", fresh: "if (s.tabs.length === 0 && s.active === CHAT) return null;", catches: "load" },
  "the title counts toward equality": { old: "return `diff:${JSON.stringify([...z, ...sourceParts(tab.source)])}`;", fresh: "return `diff:${JSON.stringify([...z, ...sourceParts(tab.source), tab.title ?? \"\"])}`;", catches: "key" },
  "staged and unstaged are one tab": { old: "[q.kind, q.repo, q.file, q.staged ? 1 : 0, ", fresh: "[q.kind, q.repo, q.file, ", catches: "key" },
  // The equality of two sources (diff block) is the SAME computation as the tab key.
  "sourceKey computes its own": { old: "export const sourceKey = (q: DiffSource): string => JSON.stringify(sourceParts(q));", fresh: "export const sourceKey = (q: DiffSource): string => JSON.stringify([q.kind, q.repo]);", catches: "key" },
  "draft without cap": { old: "if (e.content.length + e.base.length > DRAFT_MAX_CHARACTERS) return null;", fresh: "", catches: "draft" },
  "Cmd+W also in the browser": { old: "if (o.shell && mod && !e.altKey) return \"close\";", fresh: "if (mod && !e.altKey) return \"close\";", catches: "shortcut" },
  "Shift is not checked": { old: "  if (e.shiftKey) return null;\n", fresh: "", catches: "shortcut" },
  "Ctrl counts as Cmd on the Mac": { old: "const mod = o.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;", fresh: "const mod = e.metaKey || e.ctrlKey;", catches: "shortcut" },
  "jump without path check": { old: "    if (!pathValid(detail.path)) return null;\n", fresh: "", catches: "jump" },
  "a broken target becomes the chat's": { old: "  if (!withoutTarget && !target) return null;\n", fresh: "", catches: "jump" },
  "a diff jump without source check": { old: "    if (!source) return null;\n    return { chatId, kind: \"diff\"", fresh: "    return { chatId, kind: \"diff\"", catches: "jump" },
  "a jump without target does not take the chat's": { old: "const target = s.target ?? chatTargetNow;", fresh: "const target = s.target ?? { apiBase: \"/api/workspaces/w\", instance: null };", catches: "jump" },
  "relative: a sibling folder with the same prefix": { old: "w.some((g, i) => a[i] !== g)", fresh: "!a.join(\"/\").startsWith(w.join(\"/\"))", catches: "relative" },
  "relative: .. beyond the root": { old: "if (g === \"..\") { if (!out.length) return null; out.pop(); }", fresh: "if (g === \"..\") { out.pop(); }", catches: "relative" },
  "relative: a relative path without cwd": { old: "cwd.startsWith(\"/\") ? `${cwd}/${path}` : null", fresh: "`/${path}`", catches: "relative" },
  "a tool error counts as written": { old: "if (!b.id || !b.done || b.resultIsError || ", fresh: "if (!b.id || !b.done || ", catches: "followUps" },
  "sub-agents write invisibly": { old: "      if (b.children?.length) go(b.children);\n", fresh: "", catches: "followUps" },
  "pathMatches matches ba.ts for a.ts": { old: "return g === tabPath || g.endsWith(`/${tabPath}`);", fresh: "return g.endsWith(tabPath);", catches: "followUps" },
  "running before open question": { old: "e.waiting ? \"question\" : e.running ? \"running\"", fresh: "e.running ? \"running\" : e.waiting ? \"question\"", catches: "followUps" },
  "main becomes a copy": { old: "name && name !== \"main\" ?", fresh: "name ?", catches: "target" },
  "rename hits another target": { old: "    } else if (!o.onlyCompare && targetEqual(t.target, target)) {\n      if (t.kind !== \"diff\")", fresh: "    } else if (!o.onlyCompare) {\n      if (t.kind !== \"diff\")", catches: "rename" },
  "cleanup without loaded list": { old: "  if (!loaded) return out;\n", fresh: "", catches: "cleanUp" },
  "cleanup hits the draft": { old: "if (!chat || chat.includes(\"@\") || known.has(chat)) continue;", fresh: "if (!chat || known.has(chat)) continue;", catches: "cleanUp" },
  "Left without wrap-around": { old: "case \"ArrowLeft\": return { kind: \"focus\", target: queue[(i - 1 + n) % n] };", fresh: "case \"ArrowLeft\": return { kind: \"focus\", target: queue[Math.max(0, i - 1)] };", catches: "keyPress" },
  "Delete closes the chat": { old: "case \"Delete\": return now === CHAT ? null : { kind: \"close\", target: now };", fresh: "case \"Delete\": return { kind: \"close\", target: now };", catches: "keyPress" },
  "Space does not open": { old: "case \"Enter\": case \" \":", fresh: "case \"Enter\":", catches: "keyPress" },
  "nudge hits every target": { old: "paths: a.target && !targetEqual(a.target, z) ? [] : a.paths", fresh: "paths: a.paths", catches: "nudge" },
  "Cmd+P takes the old answer": { old: "if (!response || response.q !== q) return", fresh: "if (!response) return", catches: "finder" },
  "Enter does not wait": { old: "stale: Boolean(response), enter: { kind: \"wait\" } };", fresh: "stale: Boolean(response), enter: null };", catches: "finder" },
  "draft loses the checksum": { old: "at: e.at, ...(e.sha ? { sha: e.sha } : {}), ", fresh: "at: e.at, ", catches: "draft" },
  // The draft carries the buffer it came from (lib/buffer.ts `takeDraft`: "done" only for the same buffer).
  "draft loses the buffer": { old: "...(e.buffer ? { buffer: e.buffer } : {}) });", fresh: "});", catches: "draft" },
  "draft does not read the buffer": { old: "...(typeof o.buffer === \"string\" && o.buffer ? { buffer: o.buffer } : {}),", fresh: "", catches: "draft" },
  // A deleted chat discards only what ITS draft carries.
  "deleted chat discards without draft": { old: "return Boolean(p && p.dirty && p.holders === 0 && draft && draft.content.replace(/\\r\\n?/g, \"\\n\") === p.text);", fresh: "return Boolean(p && p.dirty && p.holders === 0);", catches: "deleted" },
  "deleted chat discards held text": { old: "return Boolean(p && p.dirty && p.holders === 0 && draft", fresh: "return Boolean(p && p.dirty && draft", catches: "deleted" },
  "draft reads any checksum": { old: "...(typeof o.sha === \"string\" && /^[0-9a-f]{64}$/.test(o.sha) ? { sha: o.sha } : {})", fresh: "...(typeof o.sha === \"string\" ? { sha: o.sha } : {})", catches: "draft" },
};

// Compile the real source, one copy per sabotage and the dictionary in ONE tsc run (all leaves without imports).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-tabs-"));
const src = path.join(tmp, "src");
const out = path.join(tmp, "out");
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, "real.ts"), source);
fs.writeFileSync(path.join(src, "i18n-de.ts"), enSource);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), source.replace(s.old, s.fresh));
  return { name, ...s, file, places: source.split(s.old).length - 1 };
});
// Type errors count only in the REAL source and the dictionary: a sabotage may break the type (tsc still emits), it is meant to be
// caught by BEHAVIOUR.
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)),
    "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--lib", "es2022,dom", "--strict"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "real.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("real.ts");
const { DE } = await load("i18n-de.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ }

// ── Building blocks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const Z = { apiBase: "/api/projects/p1", instance: null };
const K = { apiBase: "/api/projects/p1", instance: "p1/copy-k1" };
const d = (filePath, target = Z) => ({ kind: "file", target, path: filePath });
const Q = { kind: "change", repo: "", file: "src/a.ts", staged: false };
const diff = (source, extra = {}) => ({ kind: "diff", target: Z, source, ...extra });

// ── The checks (one function each, run against the real module and every sabotage) ───────────────────────────────────────────────
const CHECKS = {
  key(m) {
    assert.equal(m.key(d("a.ts")), m.key(d("a.ts")));
    assert.notEqual(m.key(d("a.ts")), m.key(d("a.ts", K)), "the instance belongs to equality");
    assert.equal(m.key(diff(Q, { title: "Subject", short: "abc1234" })), m.key(diff(Q)), "display fields do not count");
    assert.notEqual(m.key(diff(Q)), m.key(diff({ ...Q, staged: true })), "staged and unstaged are two tabs");
    assert.notEqual(m.key(diff({ kind: "commit", repo: "", hash: "abc", file: "a.ts" })), m.key(diff({ kind: "commit", repo: "", hash: "abc", file: "a.ts", old: "b.ts" })));
    assert.notEqual(m.key(d("src/a.ts")), m.key(diff(Q)), "file and diff of the same file are two tabs");
    assert.notEqual(m.key(diff({ kind: "commit-whole", repo: "", hash: "h" })), m.key(diff({ kind: "history", repo: "", hash: "h" })));
    assert.equal(m.key({ kind: "chat" }), m.CHAT);
    // Same source <=> same tab: the equality of the diff block and the tab key say the same about EVERY pair.
    const sources = [Q, { ...Q, staged: true }, { ...Q, file: "src/b.ts" }, { ...Q, repo: "sub" },
      { kind: "commit", repo: "", hash: "abc", file: "a.ts" }, { kind: "commit", repo: "", hash: "abc", file: "a.ts", old: "b.ts" }, { kind: "commit", repo: "", hash: "abd", file: "a.ts" },
      { kind: "commit-whole", repo: "", hash: "abc" }, { kind: "history", repo: "", hash: "abc" }, { kind: "stash", repo: "", ref: "stash@{0}" }, { kind: "stash", repo: "", ref: "stash@{1}" }];
    for (const a of sources) for (const b of sources) {
      assert.equal(m.sourceKey(a) === m.sourceKey(b), m.key(diff(a)) === m.key(diff(b)), `source and tab disagree: ${JSON.stringify([a, b])}`);
    }
  },
  relative(m) {
    const r = (p) => m.relativeToRoot(p, "/w/till", "/w");
    assert.equal(r("/w/till/src/a.ts"), "src/a.ts");
    assert.equal(r("till/src/a.ts"), "src/a.ts", "relative to the cwd of the run (the workspace)");
    assert.equal(r("/w/till/./src/../lib/b.ts"), "lib/b.ts");
    assert.equal(r("/w/till2/a.ts"), null, "a sibling folder with the same prefix lies OUTSIDE");
    assert.equal(r("/w/till"), null, "the root itself is not a file");
    assert.equal(r("/w/till/../../etc/passwd"), null, ".. beyond the root");
    assert.equal(r("/w/till/../../../w/till/a.ts"), null, ".. beyond the root folder of the file system");
    assert.equal(r("/w/other/a.ts"), null);
    assert.equal(m.relativeToRoot("a.ts", "/w/till", ""), null, "a relative path without cwd has no place");
    for (const broken of [null, 3, "", "~/a.ts", "/w/till/a\u0000.ts"]) assert.equal(r(broken), null, JSON.stringify(broken));
    assert.equal(m.relativeToRoot("/w/till/a.ts", "w/till", "/w"), null, "a relative root is none");
  },
  open(m) {
    const k = (t) => m.key(t);
    const names = (s) => s.tabs.map((t) => t.path);
    let s = m.open(m.emptyState(), d("a.ts"));
    assert.deepEqual([names(s), s.active, s.preview], [["a.ts"], k(d("a.ts")), k(d("a.ts"))], "a click opens a preview");
    s = m.open(s, d("b.ts"));
    assert.deepEqual([names(s), s.preview], [["b.ts"], k(d("b.ts"))], "the next click REPLACES the preview");
    s = m.open(s, d("c.ts"), { fixed: true });
    assert.deepEqual([names(s), s.active, s.preview], [["b.ts", "c.ts"], k(d("c.ts")), k(d("b.ts"))], "fixed is added, the preview stays");
    s = m.open(s, d("d.ts"));
    assert.deepEqual(names(s), ["d.ts", "c.ts"], "the new preview takes the place of the old one");
    const prior = s;
    s = m.open(s, d("c.ts"));
    assert.deepEqual([names(s), s.active, s.preview], [names(prior), k(d("c.ts")), k(d("d.ts"))], "an open tab only becomes active");
    s = m.open(s, d("d.ts"), { fixed: true });
    assert.deepEqual([names(s), s.active, s.preview], [["d.ts", "c.ts"], k(d("d.ts")), null], "fixed on the open preview fixes it");
    s = m.open(s, d("e.ts"));
    assert.deepEqual([names(s), s.preview], [["d.ts", "e.ts", "c.ts"], k(d("e.ts"))], "without a preview the new one goes right of the active one (VS Code openPositioning: right)");
    assert.equal(m.keep(s, k(d("e.ts"))).preview, null);
    assert.equal(m.keep(s, k(d("c.ts"))), s, "fixing a fixed tab changes nothing");
    const t1 = diff({ kind: "commit-whole", repo: "", hash: "h1" });
    let u = m.open(m.emptyState(), t1, { fixed: true });
    u = m.open(u, { ...t1, title: "Subject added later" });
    assert.deepEqual([u.tabs.length, u.tabs[0].title], [1, "Subject added later"], "the same diff with a new title stays ONE tab");
    assert.equal(m.activate(s, "file:unknown"), s, "an unknown key does not become active");
    assert.equal(m.openView(s, m.FILES).active, m.FILES);
    // Background: a buffer got unsaved text without a tab (rename, peek); its tab is added as fixed, nothing comes to the front;
    // if it is already open, everything stays as it is.
    const h = m.open(s, d("f.ts"), { fixed: true, background: true });
    assert.deepEqual([names(h), h.active, h.preview], [["d.ts", "e.ts", "f.ts", "c.ts"], s.active, s.preview], "in the background: fixed right of the active one, nothing comes to the front, the preview stays");
    assert.equal(m.open(h, d("c.ts"), { background: true }), h, "an open tab stays as it is in the background");
    // A preview with unsaved text (typed, or rename/peek into the file) is never replaced: replacing would release its buffer with a
    // discard. It stays as a fixed tab, the new file is added as a preview; without unsaved text it replaces as usual.
    const asked = [];
    const unsaved = (key) => { asked.push(key); return key === k(d("e.ts")); };
    const u1 = m.open(h, d("g.ts"), { unsaved });
    assert.deepEqual([names(u1), u1.active, u1.preview], [["d.ts", "e.ts", "g.ts", "f.ts", "c.ts"], k(d("g.ts")), k(d("g.ts"))], "a preview with unsaved text was replaced");
    assert.deepEqual(asked, [k(d("e.ts"))], "only the preview is asked about, nothing else");
    const u2 = m.open(u1, d("i.ts"), { unsaved });
    assert.deepEqual([names(u2), u2.preview], [["d.ts", "e.ts", "i.ts", "f.ts", "c.ts"], k(d("i.ts"))], "a clean preview is still replaced (in its place)");
  },
  last(m) {
    // VS Code `workbench.editor.focusRecentEditorAfterClose` and `openPositioning: right`.
    const k = (t) => m.key(t);
    const names = (s) => s.tabs.map((t) => t.path);
    let s = m.open(m.emptyState(), d("a.ts"), { fixed: true });
    s = m.open(s, d("b.ts"), { fixed: true });
    s = m.open(s, d("c.ts"), { fixed: true });
    assert.deepEqual(names(s), ["a.ts", "b.ts", "c.ts"]);
    s = m.activate(s, k(d("a.ts")));
    s = m.open(s, d("x.ts"), { fixed: true });
    assert.deepEqual(names(s), ["a.ts", "x.ts", "b.ts", "c.ts"], "new right of the active one, not at the end");
    s = m.activate(s, k(d("c.ts")));
    assert.equal(m.close(s, k(d("c.ts"))).active, k(d("x.ts")), "after closing the most recently used, not the neighbour (b)");
    s = m.activate(s, k(d("a.ts")));
    s = m.activate(s, k(d("c.ts")));
    assert.equal(m.close(s, k(d("c.ts"))).active, k(d("a.ts")), "the most recently used also wins against the most recently opened");
    const v = m.open(m.openView(s, m.FILES), d("y.ts"), { fixed: true });
    assert.equal(v.tabs[0].path, "y.ts", "if a view is in front: before the first code tab");
    assert.equal(m.close(v, k(d("y.ts"))).active, m.FILES, "a view can be the most recently used too");
    // The trail survives reload and rename; it does not load foreign keys.
    const raw = m.writeStatus(s);
    assert.deepEqual(m.readStatus(raw).last, s.last, "the trail survives reload");
    assert.deepEqual(m.readStatus(JSON.stringify({ ...JSON.parse(raw), last: ["file:foreign", k(d("b.ts")), k(d("b.ts")), 7] })).last, [k(d("b.ts"))], "only keys of the row, once each");
    const u = m.rename(s, Z, "c.ts", "z.ts");
    assert.equal(m.close(m.activate(u, k(d("x.ts"))), k(d("x.ts"))).active, k(d("z.ts")), "the trail follows the rename (otherwise the neighbour b)");
  },
  views(m) {
    // The ... menu: explorer, browser, terminal; each open at most once, in opening order behind the chat.
    const k = (t) => m.key(t);
    let s = m.open(m.emptyState(), d("a.ts"), { fixed: true });
    assert.equal(m.activate(s, m.TERMINAL), s, "a closed view does not become active (opening goes through the menu)");
    s = m.openView(s, m.TERMINAL);
    s = m.openView(s, m.FILES);
    assert.deepEqual([s.views, s.active], [[m.TERMINAL, m.FILES], m.FILES]);
    s = m.openView(s, m.TERMINAL);
    assert.deepEqual([s.views, s.active], [[m.TERMINAL, m.FILES], m.TERMINAL], "an open view only comes to the front, not twice");
    assert.equal(m.openView(s, m.TERMINAL), s, "the front view once more: nothing changes");
    assert.deepEqual(m.queue(s), [m.CHAT, m.TERMINAL, m.FILES, k(d("a.ts"))], "the views stand behind the chat, before the code tabs");
    assert.equal(m.activate(s, m.FILES).active, m.FILES, "an open view becomes active");
    let r = m.close(s, m.TERMINAL);
    assert.deepEqual([r.views, r.active], [[m.FILES], m.FILES], "closing: gone from the bar, the right neighbour becomes active");
    r = m.close(r, m.FILES);
    assert.deepEqual([r.views, r.active, r.tabs.length], [[], k(d("a.ts")), 1], "the explorer is closable, the code tab stays");
    assert.equal(m.close(r, m.BROWSER), r, "closing a closed view changes nothing");
    assert.deepEqual([...m.VIEWS], [m.FILES, m.BROWSER, m.TERMINAL], "the order of the menu: explorer, browser, terminal");
    assert.deepEqual([m.isView(m.BROWSER), m.isView(m.CHAT), m.isView(k(d("a.ts"))), m.isView(7)], [true, false, false, false]);
  },
  close(m) {
    const k = (t) => m.key(t);
    const s = { tabs: [d("a.ts"), d("b.ts"), d("c.ts")], active: k(d("b.ts")), preview: null, views: [] };
    assert.equal(m.close(s, m.CHAT), s, "the chat tab is never closable");
    assert.equal(m.close({ ...s, views: [m.FILES], active: m.CHAT }, m.CHAT).active, m.CHAT, "not next to a view either");
    assert.equal(m.close(s, m.FILES), s, "closing a view that is not open changes nothing");
    let r = m.close(s, k(d("b.ts")));
    assert.deepEqual([r.tabs.map((t) => t.path), r.active], [["a.ts", "c.ts"], k(d("c.ts"))], "the right neighbour becomes active");
    r = m.close({ ...s, active: k(d("c.ts")) }, k(d("c.ts")));
    assert.equal(r.active, k(d("b.ts")), "far right: the left neighbour");
    r = m.close({ tabs: [d("a.ts")], active: k(d("a.ts")), preview: k(d("a.ts")), views: [] }, k(d("a.ts")));
    assert.deepEqual(r, { tabs: [], active: m.CHAT, preview: null, views: [], last: [m.CHAT] }, "the last tab: the chat becomes active, the preview is gone");
    r = m.close({ ...s, active: m.CHAT }, k(d("a.ts")));
    assert.equal(r.active, m.CHAT, "another tab closes without changing the active one");
  },
  paginate(m) {
    const k = (t) => m.key(t);
    const s = { tabs: [d("a.ts"), d("b.ts")], active: m.CHAT, preview: null, views: [] };
    const a1 = m.paginate(s, 1);
    const a2 = m.paginate(a1, 1);
    const a3 = m.paginate(a2, 1);
    assert.deepEqual([a1.active, a2.active, a3.active], [k(d("a.ts")), k(d("b.ts")), m.CHAT], "Ctrl+Tab cycles INCLUDING the chat");
    assert.equal(m.paginate(s, -1).active, k(d("b.ts")), "Ctrl+Shift+Tab from the chat to the last tab");
    assert.equal(m.paginate({ ...s, active: "file:foreign" }, 1).active, k(d("a.ts")), "from an unknown key forwards to the first tab");
    assert.equal(m.paginate({ ...s, active: "file:foreign" }, -1).active, m.CHAT, "from an unknown key backwards to the chat");
    const withView = { ...s, views: [m.BROWSER] };
    assert.deepEqual([m.paginate(withView, 1).active, m.paginate({ ...withView, active: m.BROWSER }, 1).active], [m.BROWSER, k(d("a.ts"))], "Ctrl+Tab also goes through the views");
    const empty = m.emptyState();
    assert.equal(m.paginate(empty, 1), empty, "without tabs nothing to cycle");
  },
  load(m) {
    const k = (t) => m.key(t);
    for (const raw of [null, "", "{broken", "[]", "5", JSON.stringify({ tabs: 5 })]) assert.deepEqual(m.readStatus(raw), m.emptyState(), `unreadable: ${raw}`);
    const good = d("src/a.ts");
    const stash = diff({ kind: "stash", repo: "app", ref: "stash@{0}" });
    const rows = [
      good,
      { kind: "file", target: { apiBase: "/etc/passwd", instance: null }, path: "x.ts" },
      { kind: "file", target: Z, path: "../secret.txt" },
      { kind: "file", target: Z, path: "/abs.ts" },
      { kind: "file", target: { apiBase: "/api/projects/p1" }, path: "without-instance.ts" },
      { kind: "file", target: { apiBase: "/api/projects/p1", instance: "p2/copy-k1" }, path: "foreign-copy.ts" },
      good,
      { kind: "diff", target: Z, source: { kind: "change", repo: "", file: "a.ts" } },
      stash,
      null, "x", 7, { kind: "chat" },
      d("b.ts", K),
    ];
    const s = m.readStatus(JSON.stringify({ v: 1, tabs: rows, active: k(d("way.ts")), preview: k(good) }));
    assert.deepEqual(s.tabs.map(k), [k(good), k(stash), k(d("b.ts", K))], "only the valid rows, once each; the list stays");
    assert.equal(s.active, m.CHAT, "an active key without a tab becomes the chat");
    assert.equal(s.preview, k(good));
    assert.deepEqual(m.readStatus(m.writeStatus(s)), s, "round trip");
    assert.equal(m.readStatus(JSON.stringify({ tabs: [good], active: k(good), preview: k(d("way.ts")) })).preview, null);
    assert.equal(m.writeStatus(m.emptyState()), null, "an empty state is not stored (the key is dropped)");
    const explorer = { tabs: [], active: m.FILES, preview: null, views: [m.FILES] };
    assert.deepEqual(m.readStatus(m.writeStatus(explorer)), explorer, "the explorer without a code tab is a state");
    assert.deepEqual(m.readStatus(JSON.stringify({ v: 1, tabs: [], active: m.FILES, preview: null })), explorer,
      "a state from before the views with 'files' in front gets the explorer as a tab");
    const raw = JSON.stringify({ v: 1, tabs: [], active: m.BROWSER, preview: null, views: [m.TERMINAL, "nonsense", m.TERMINAL, 3] });
    assert.deepEqual(m.readStatus(raw), { tabs: [], active: m.CHAT, preview: null, views: [m.TERMINAL] }, "only known views, once each; a view that is not open is not active");
    assert.notEqual(m.writeStatus({ tabs: [], active: m.CHAT, preview: null, views: [m.TERMINAL] }), null, "an open view is stored");
  },
  draft(m) {
    const e = { base: "old", content: "fresh", at: 5 };
    assert.deepEqual(m.readDraft(m.writeDraft(e)), e);
    for (const raw of [null, "{", JSON.stringify({ base: "a" }), JSON.stringify({ base: "a", content: "b", at: "x" })]) assert.equal(m.readDraft(raw), null);
    assert.equal(m.writeDraft({ base: "", content: "x".repeat(m.DRAFT_MAX_CHARACTERS + 1), at: 1 }), null, "too large is not remembered");
    assert.equal(m.storageKey("c1"), "cbase-chat-tabs:c1");
    assert.ok(m.draftKey("c1", m.key(d("a.ts"))).startsWith("cbase-chat-tab-draft:c1|file:"));
    // The draft carries the checksum of its base (the precondition when it is saved after a reload).
    const sha = "a".repeat(64);
    assert.deepEqual(m.readDraft(m.writeDraft({ ...e, sha })), { ...e, sha }, "the checksum is lost when remembering");
    assert.deepEqual(m.readDraft(JSON.stringify({ ...e, sha: "short" })), e, "a checksum that is none is dropped");
    // The buffer the draft came from goes along (an empty or foreign value is dropped).
    assert.deepEqual(m.readDraft(m.writeDraft({ ...e, buffer: "b-1" })), { ...e, buffer: "b-1" }, "the buffer of the draft is lost when remembering");
    assert.deepEqual([m.readDraft(JSON.stringify({ ...e, buffer: "" })), m.readDraft(JSON.stringify({ ...e, buffer: 7 }))], [e, e]);
  },
  deleted(m) {
    // Since ONE buffer also serves Coding -> Files, a deleted chat discards only what ITS draft carries; text typed elsewhere (the
    // same file in Coding -> Files, unsaved, editor detached) stays.
    const p = (text, o = {}) => ({ dirty: true, holders: 0, text, ...o });
    const e = (content) => ({ base: "a\n", content, at: 1 });
    assert.equal(m.dismissesDeletedChat(p("mein\n"), e("mein\n")), true, "the chat's draft carries the text: discard");
    assert.equal(m.dismissesDeletedChat(p("mein\n"), e("mein\r\n")), true, "CRLF in the draft does not count");
    assert.equal(m.dismissesDeletedChat(p("elsewhere\n"), e("mine\n")), false, "text from elsewhere stays");
    assert.equal(m.dismissesDeletedChat(p("elsewhere\n"), null), false, "without a draft of the chat the text does not come from it");
    assert.equal(m.dismissesDeletedChat(p("mein\n", { holders: 1 }), e("mein\n")), false, "someone else holds it: nothing");
    assert.equal(m.dismissesDeletedChat(p("mein\n", { dirty: false }), e("mein\n")), false);
    assert.equal(m.dismissesDeletedChat(null, e("x")), false);
  },
  keyPress(m) {
    // WAI-ARIA "Tabs": Left/Right cycle with wrap-around, Home/End jump to the edge, Enter/Space open, Delete closes only code tabs.
    const r = [m.CHAT, "a", "b", m.FILES];
    assert.deepEqual(m.tabKey("ArrowRight", r, "a"), { kind: "focus", target: "b" });
    assert.deepEqual(m.tabKey("ArrowRight", r, m.FILES), { kind: "focus", target: m.CHAT }, "Right at the end starts at the front");
    assert.deepEqual(m.tabKey("ArrowLeft", r, m.CHAT), { kind: "focus", target: m.FILES }, "Left at the start jumps to the end");
    assert.deepEqual([m.tabKey("Home", r, "b"), m.tabKey("End", r, "a")], [{ kind: "focus", target: m.CHAT }, { kind: "focus", target: m.FILES }]);
    assert.deepEqual([m.tabKey("Enter", r, "a"), m.tabKey(" ", r, "b")], [{ kind: "activate", target: "a" }, { kind: "activate", target: "b" }]);
    assert.deepEqual(m.tabKey("Delete", r, "a"), { kind: "close", target: "a" });
    assert.equal(m.tabKey("Delete", r, m.CHAT), null, "Delete does not close the chat");
    assert.deepEqual(m.tabKey("Delete", r, m.FILES), { kind: "close", target: m.FILES }, "Delete closes a view like a tab");
    assert.deepEqual([m.tabKey("x", r, "a"), m.tabKey("ArrowRight", r, "foreign")], [null, null]);
  },
  nudge(m) {
    // A save nudges the tabs of ITS target; every other target sees the number but reads nothing.
    const a = { seq: 3, paths: ["x.ts"], target: Z };
    assert.deepEqual(m.nudgeFor(a, Z), { seq: 3, paths: ["x.ts"] });
    assert.deepEqual(m.nudgeFor(a, K), { seq: 3, paths: [] }, "a save in main does not nudge the copy");
    assert.deepEqual(m.nudgeFor({ seq: 4, paths: null }, K), { seq: 4, paths: null }, "without a target (turn end) it applies to all");
  },
  finder(m) {
    // Hits count only for their input; Enter waits for the fresh answer instead of opening an old hit.
    assert.deepEqual(m.finderSituation("", null, ["a", "b"], 1), { rows: ["a", "b"], stale: false, enter: { kind: "open", path: "b" } }, "empty: the open tabs");
    assert.deepEqual(m.finderSituation("pre", { q: "pr", results: ["process.ts"] }, [], 0), { rows: ["process.ts"], stale: true, enter: { kind: "wait" } }, "an answer for an OLD input is stale");
    assert.deepEqual(m.finderSituation("pre", null, [], 0), { rows: [], stale: false, enter: { kind: "wait" } });
    assert.deepEqual(m.finderSituation(" pre ", { q: "pre", results: ["p1", "p2"] }, [], 1), { rows: ["p1", "p2"], stale: false, enter: { kind: "open", path: "p2" } });
    assert.equal(m.finderSituation("pre", { q: "pre", results: [] }, [], 0).enter, null, "no hit: Enter does nothing");
  },
  shortcut(m) {
    const k = (code, mods = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    const mac = { mac: true, shell: false }, macShell = { mac: true, shell: true }, win = { mac: false, shell: false }, winShell = { mac: false, shell: true };
    const f = m.tabShortcut;
    assert.equal(f(k("KeyP", { metaKey: true }), mac), "find");
    assert.equal(f(k("KeyP", { ctrlKey: true }), mac), null, "Ctrl+P is not Cmd+P on the Mac");
    assert.equal(f(k("KeyP", { ctrlKey: true }), win), "find");
    assert.equal(f(k("KeyP", { metaKey: true }), win), null);
    assert.equal(f(k("KeyP", { metaKey: true, shiftKey: true }), mac), null, "Cmd+Shift+P is not Cmd+P");
    assert.equal(f(k("Digit1", { metaKey: true }), macShell), "chat");
    assert.equal(f(k("KeyW", { metaKey: true }), macShell), "close", "Cmd+W in the desktop client");
    assert.equal(f(k("KeyW", { metaKey: true }), mac), null, "in the browser Cmd+W closes the browser tab before the page sees it");
    assert.equal(f(k("KeyW", { altKey: true }), mac), "close", "Opt+W in the browser");
    assert.equal(f(k("KeyW", { altKey: true }), macShell), null);
    assert.equal(f(k("KeyW", { ctrlKey: true }), winShell), "close");
    assert.equal(f(k("KeyW", { altKey: true }), win), "close");
    assert.equal(f(k("Tab", { ctrlKey: true }), mac), "next", "Ctrl+Tab is Ctrl on the Mac too");
    assert.equal(f(k("Tab", { ctrlKey: true, shiftKey: true }), mac), "previous");
    assert.equal(f(k("Tab", { ctrlKey: true }), win), "next");
    assert.equal(f(k("Tab", { metaKey: true }), mac), null, "Cmd+Tab belongs to the system");
    assert.equal(f(k("KeyS", { metaKey: true }), mac), null, "Cmd+S belongs to the editor");
    assert.deepEqual([macShell, mac, winShell, win].map((o) => m.closeShortcutText(o)), ["⌘W", "⌥W", "Ctrl+W", "Alt+W"]);
  },
  jump(m) {
    assert.deepEqual(m.chatTabJumpFrom({ chatId: "c1", kind: "diff", source: Q, target: Z, title: "x", fixed: true }), { chatId: "c1", kind: "diff", source: Q, target: Z, title: "x", fixed: true });
    assert.deepEqual(m.chatTabJumpFrom({ chatId: "c1", kind: "diff", source: Q, target: null }), { chatId: "c1", kind: "diff", source: Q, target: null, fixed: false }, "without a target: the chat's");
    // tabFromJump: a jump without a target takes the chat's target AT THIS MOMENT (the git bar in chat mode, an Edit row).
    assert.deepEqual(m.tabFromJump({ chatId: "c1", kind: "diff", source: Q, target: null, title: "T", fixed: false }, K), { kind: "diff", target: K, source: Q, title: "T" });
    assert.deepEqual(m.tabFromJump({ chatId: "c1", kind: "diff", source: Q, target: Z, fixed: false }, K), { kind: "diff", target: Z, source: Q }, "a given target stays");
    assert.deepEqual(m.tabFromJump({ chatId: "c1", kind: "file", path: "a.ts", target: null, fixed: false }, K), { kind: "file", target: K, path: "a.ts" });
    assert.deepEqual(m.chatTabJumpFrom({ chatId: "c1", kind: "file", path: "src/a.ts" }), { chatId: "c1", kind: "file", path: "src/a.ts", target: null, fixed: false });
    assert.deepEqual(m.chatTabJumpFrom({ chatId: "c1", kind: "file", path: "a.ts", target: K }).target, K);
    for (const broken of [null, "x", { kind: "file", path: "a.ts" }, { chatId: "c1", kind: "file", path: "../a.ts" }, { chatId: "c1", kind: "file", path: "a.ts", target: { apiBase: "/x" } },
      { chatId: "c1", kind: "diff", source: { kind: "change", repo: "", file: "a.ts" } }, { chatId: "c1", kind: "diff", source: d("a.ts") },
      { chatId: "c1", kind: "diff", source: Q, target: { apiBase: "/x" } }, { chatId: "c1", kind: "diff", source: Q, target: { apiBase: "/api/projects/p1", instance: "p2/copy-k1" } },
      { chatId: "c1", kind: "chat" }]) {
      assert.equal(m.chatTabJumpFrom(broken), null, `no jump: ${JSON.stringify(broken)}`);
    }
    const old = globalThis.window;
    const window = new EventTarget();
    globalThis.window = window;
    const belongs = [];
    window.addEventListener(m.CHAT_TAB_EVENT, (e) => belongs.push(m.chatTabJumpFrom(e.detail)));
    try {
      m.openDiffTab("c1", Q, Z, { fixed: true, title: "T", short: "abc1234" });
      m.openFileTab("c1", "src/b.ts");
      m.openDiffTab("", Q, Z);
      m.openDiffTab("draft@w1", Q, null);
    } finally { globalThis.window = old; }
    assert.deepEqual(belongs, [
      { chatId: "c1", kind: "diff", source: Q, target: Z, title: "T", short: "abc1234", fixed: true },
      { chatId: "c1", kind: "file", path: "src/b.ts", target: null, fixed: false },
      { chatId: "draft@w1", kind: "diff", source: Q, target: null, fixed: false },
    ], "the jump reaches the listener checked; without a chat no event; the draft of a new chat is a chat");
  },
  followUps(m) {
    const bubbles = [{ role: "user", blocks: [] }, { role: "assistant", blocks: [
      { kind: "tool", id: "t1", name: "Edit", input: { file_path: "/w/till/src/a.ts" }, done: true },
      { kind: "tool", id: "t2", name: "Write", input: { file_path: "/w/till/b.ts" }, done: true, resultIsError: true },
      { kind: "tool", id: "t3", name: "Edit", input: { file_path: "/w/c.ts" } },
      { kind: "tool", id: "t4", name: "Read", input: { file_path: "/w/d.ts" }, done: true },
      { kind: "tool", id: "t5", name: "Task", done: true, children: [{ kind: "tool", id: "t6", name: "MultiEdit", input: { file_path: "/w/e.ts" }, done: true }] },
      { kind: "tool", id: "t7", name: "apply_patch", input: { changes: [{ path: "f.ts" }, { path: "g.ts" }] }, done: true },
      { kind: "text", text: "finished" },
    ] }];
    assert.deepEqual(m.writtenFiles(bubbles).map((x) => x.path).sort(), ["/w/e.ts", "/w/till/src/a.ts", "f.ts", "g.ts"],
      "finished, error-free write tools, also in the sub-agent; never Read, never an error, never a running one");
    assert.ok(m.pathMatches("src/a.ts", "/w/till/src/a.ts") && m.pathMatches("src/a.ts", "src/a.ts") && m.pathMatches("a.ts", "C:\\w\\a.ts"));
    assert.ok(!m.pathMatches("a.ts", "/w/ba.ts"), "ba.ts is not a.ts");
    const ask = (o) => ({ role: "ask", blocks: [], ask: { requestId: "r", questions: [], answerable: true, ...o } });
    assert.equal(m.waitingForHuman([ask({})]), true);
    assert.equal(m.waitingForHuman([ask({ answers: [] })]), false);
    assert.equal(m.waitingForHuman([{ ...ask({}), dimmed: true }]), false);
    assert.equal(m.waitingForHuman([{ role: "approval", blocks: [], approval: { open: true } }]), true);
    assert.equal(m.waitingForHuman([{ role: "approval", blocks: [], approval: { open: true, ruling: { behavior: "allow" } } }]), false);
    assert.equal(m.chatSign({ waiting: true, running: true, fresh: true }), "question", "an open question before the run");
    assert.equal(m.chatSign({ waiting: false, running: true, fresh: true }), "running");
    assert.equal(m.chatSign({ waiting: false, running: false, fresh: true }), "fresh");
    assert.equal(m.chatSign({ waiting: false, running: false, fresh: false }), null);
  },
  target(m) {
    assert.deepEqual(m.chatTarget({ workspaceId: "w1", projectId: null, instance: "copy-k1" }), { apiBase: "/api/workspaces/w1", instance: null }, "without a project the workspace root");
    assert.deepEqual(m.chatTarget({ workspaceId: "w1", projectId: "p1", instance: "main" }), Z);
    assert.deepEqual(m.chatTarget({ workspaceId: "w1", projectId: "p1", instance: "" }), Z);
    assert.deepEqual(m.chatTarget({ workspaceId: "w1", projectId: "p1", instance: "copy-k1" }), K);
    assert.deepEqual([m.copyOf(K), m.copyOf(Z), m.projectIdOf(K), m.projectIdOf({ apiBase: "/api/workspaces/w1", instance: null })], ["k1", null, "p1", null]);
  },
  rename(m) {
    const k = (t) => m.key(t);
    const s = { tabs: [d("src/a.ts"), d("src/b.ts"), d("src/a.ts", K), d("x.ts"), d("lib/a.ts")], active: k(d("src/a.ts")), preview: k(d("src/b.ts")), views: [m.FILES] };
    const r = m.rename(s, Z, "src", "lib");
    assert.deepEqual(r.tabs.map(k), [k(d("lib/a.ts")), k(d("lib/b.ts")), k(d("src/a.ts", K)), k(d("x.ts"))], "the folder follows, only in ITS target; a duplicate drops");
    assert.deepEqual([r.active, r.preview], [k(d("lib/a.ts")), k(d("lib/b.ts"))]);
    assert.deepEqual(r.views, [m.FILES], "the views stay");
    const w = m.removeFiles(r, Z, "lib", () => true);
    assert.deepEqual(w.tabs.map(k), [k(d("src/a.ts", K)), k(d("x.ts"))]);
    assert.equal(w.active, k(d("src/a.ts", K)), "the active deleted tab hands over to its neighbour");
  },
  cleanUp(m) {
    const keys = ["cbase-chat-tabs:c1", "cbase-chat-tabs:c2", `cbase-chat-tab-draft:c2|${m.key(d("a.ts"))}`, "cbase-chat-tabs:draft@w1", "cbase-chat-tab-draft:draft@w1|x", "foreign"];
    assert.equal(m.cleanupCandidates(keys, new Set(["c1"]), false).size, 0, "without a loaded list no candidate (empty is not unknown)");
    const r = m.cleanupCandidates(keys, new Set(["c1"]), true);
    assert.deepEqual([...r.keys()], ["c2"], "only chats outside the list, never the draft");
    assert.equal(r.get("c2").length, 2, "list AND draft of the chat");
  },
};

test("(1) the model (lib/chat-tabs.ts): equality, opening with preview, closing, Ctrl+Tab, loading per row, draft, shortcuts, jump, follow-ups", () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

test("(1) counter-tests on the model: every sabotage hits exactly one spot and is caught by its check", () => {
  const notCaught = [];
  for (const s of sabotaged) {
    assert.equal(s.places, 1, `sabotage '${s.name}': the spot appears ${s.places}x in the source; the sabotage is stale`);
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [chat-tabs] ${sabotaged.length} sabotages on the model, each caught`);
});

// ── (2) Source guards ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q_FILES = {
  codePane: "src/components/CodePane.tsx",
  codeArea: "src/components/CodeArea.tsx",
  page: "src/app/workspaces/page.tsx",
  stage: "src/components/chat/ChatStage.tsx",
  pane: "src/components/chat/ChatPane.tsx",
  hook: "src/components/chat/chatTabs.ts",
  area: "src/components/chat/ChatCodeArea.tsx",
  bar: "src/components/chat/ChatTabBar.tsx",
  // The tile of a tab, the same for the Files page and the chat.
  tile: "src/components/code/TabBar.tsx",
  // The former file finder is the "files" mode of the command palette: the path in palette-modes.ts (`useFiles`), input and Enter
  // in the window (CommandPalette.tsx).
  finder: "src/components/code/palette-modes.ts",
  palette: "src/components/code/CommandPalette.tsx",
  turnout: "src/components/chat/DiffTabSwitch.tsx",
  bar2: "src/components/chat/ChatRightSidebar.tsx",
};
const sources = Object.fromEntries(Object.entries(Q_FILES).map(([k, p]) => [k, read(p)]));
// Who passes `controlled=`? Counted over ALL components; a second place would be a second spot where CodePane runs controlled.
const allComponents = (() => {
  const out = [];
  const go = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) go(p); else if (/\.tsx?$/.test(e.name)) out.push(p); } };
  go(path.join(webDir, "src"));
  return out;
})();

const SOURCE_CHECKS = {
  pageUncontrolled(q) {
    // The Coding -> Files page stays as it was: CodeArea renders CodePane WITHOUT `controlled`, and only the chat's code area passes it.
    const area = withoutComments(q.codeArea);
    assert.ok(/<CodePane\b/.test(area), "CodeArea no longer renders CodePane");
    assert.ok(!/controlled/.test(area), "CodeArea.tsx passes `controlled`: the Files page would run controlled");
    assert.ok(!/controlled/.test(withoutComments(q.page)), "workspaces/page.tsx knows `controlled`");
    assert.equal((withoutComments(q.area).match(/(?<![\w-])controlled=\{/g) ?? []).length, 1, "ChatCodeArea passes `controlled` exactly once");
  },
  gitWithoutTick(q) {
    const pane = withoutComments(q.codePane);
    assert.ok(pane.includes("const gitState = useGitState(controlled && isActive ? apiBase : null, controlled?.gitChat ?? null, controlled?.gitChat ? null : instance);"),
      "the controlled area does not read the git state from the shared store (or also when hidden)");
    assert.equal((pane.match(/setInterval\(/g) ?? []).length, 1, "CodePane has a second tick");
    assert.match(pane, /if \(!isActive \|\| isControlled\) return;\s*refreshGit\(\);[\s\S]{0,240}setInterval\(refreshGit, 8000\)/, "the own tick also runs when controlled");
    assert.ok(pane.includes("if (stRef.current) { await gitRefresh.current(); return; }"), "refreshGit queries itself when controlled instead of the store");
    assert.ok(withoutComments(q.area).includes("gitChat: tabs.chatId && targetEqual(z, tabs.chatTarget) ? tabs.chatId : null,"),
      "the chat's target does not ask WITH the chat: a different store than the right bar (second fetch)");
  },
  oneTabList(q) {
    const pane = withoutComments(q.codePane);
    // The tab row exists per GROUP (`g.paths`), its buttons come from `buttonsFor(activePath)` of the group; when controlled the same
    // computation for the chat's tab (`actionsButtons = buttonsFor(activePath)`). A tab of the group can be a preview or a diff, so the
    // tab row asks `buttonsFor(g.active, g.id, slot)` (the tab's key and the group whose title row holds the diff's buttons).
    assert.ok(pane.includes("{g.paths.length > 0 && !controlled && ("), "the own tab row also exists when controlled (a second tab list in the chat)");
    assert.ok(pane.includes("const activePath = controlled ? controlled.active : activePathIntern;"), "when controlled the chat does not decide which tab is in front");
    assert.match(pane, /createPortal\(\s*<div className="flex items-center gap-0\.5" data-code-actions>\{actionsButtons\}<\/div>,\s*controlled\.actions,/, "the tab's buttons are not in the title row");
    assert.ok(pane.includes("const actionsButtons = buttonsFor(activePath);"), "the title row's buttons are a copy");
    assert.equal((pane.match(/\{actionsButtons\}/g) ?? []).length + (pane.match(/\{buttonsFor\(g\.active, g\.id, slot\)\}/g) ?? []).length, 2, "the same buttons in exactly two places (tab row uncontrolled, title row controlled)");
  },
  wired(q) {
    const stage = withoutComments(q.stage);
    assert.match(stage, /<ChatTabBar\s+t=\{t\}\s+tabs=\{chatTabs\}/, "the stage does not show the tab bar");
    assert.ok(stage.includes("<ChatCodeArea key={chatTabs.chatKey} t={t} tabs={chatTabs} workspace={workspace} />"), "the code area is not re-mounted per chat");
    assert.ok(stage.includes("if (el) el.inert = codeFront;"), "history and dock stay reachable under the code area");
    assert.ok(/\{!codeFront && activeId && \(limitWait \|\| wfRun\) && \(/.test(stage), "the conversation's banners stand above the code");
    const pane = withoutComments(q.pane);
    assert.equal((pane.match(/useChatTabs\(/g) ?? []).length, 1, "ChatPane does not call useChatTabs exactly once");
    assert.match(pane, /^\s{8}chatTabs=\{chatTabs\}$/m, "chatTabs does not go into the stage under its own name");
  },
  throwNoAttachment(q) {
    assert.ok(withoutComments(q.area).includes("onDrop={(e) => { e.stopPropagation(); e.preventDefault(); }}"),
      "a drop over the code area reaches the stage: the file would become an attachment of the chat");
  },
  shortcutOnlyVisible(q) {
    const hook = withoutComments(q.hook);
    assert.ok(hook.includes('window.addEventListener("keydown", on, true);'), "the shortcuts do not listen in the capture phase (CodeMirror would see Cmd+P first)");
    assert.ok(hook.includes("if (!el || !el.isConnected || el.getClientRects().length === 0) return;"), "the shortcuts also act when the chat is not in front");
    assert.ok(hook.includes(`if (document.querySelector('[aria-modal="true"]')) return;`), "the shortcuts act under an open sheet (also under the question, role=alertdialog)");
    assert.ok(hook.includes("if (s.active === CHAT) return; // in the chat Cmd+W belongs to the window"), "Cmd+W closes something in the chat");
  },
  busyPrior(q) {
    // On a chat switch the run of the NEW chat counts as "before"; otherwise a running chat would take its end for a start (or the
    // reverse) and nudge tabs or set "new" without anything happening.
    assert.ok(withoutComments(q.hook).includes("useEffect(() => { setNew(false); busyPrior.current = busy; }, [chatKey]);"), "busyPrior does not follow the chat switch");
  },
  takeoverMarker(q) {
    // The draft's tabs go ONLY into the chat that sending THIS draft created; marked in ChatPane, not guessed via "just created"
    // (createdAt).
    const hook = withoutComments(q.hook);
    assert.ok(hook.includes("if (fromDraft.get(activeId) !== u.from) return;"), "the takeover does not check the creation marker");
    assert.ok(!/createdAt/.test(hook), "the takeover guesses via createdAt again");
    const pane = withoutComments(q.pane);
    assert.equal((pane.match(/rememberCreationFromDraft\(wsId, chatId\)/g) ?? []).length, 1, "ChatPane does not report the creation from the draft (exactly once)");
    assert.match(pane, /function heroDraftReattach\(chatId: string\) \{\s*if \(activeIdRef\.current\) return;[\s\S]{0,200}rememberCreationFromDraft\(wsId, chatId\)/, "the marker is not where the draft is re-attached");
  },
  onlyVisible(q) {
    // Two areas of the same chat (two tabs): only the visible one writes the state and opens jumps; when a hidden one becomes visible
    // it reads anew.
    const hook = withoutComments(q.hook);
    assert.ok(hook.includes("if (raw.k !== chatKey || !visible()) return;"), "a hidden area writes the state");
    assert.ok(hook.includes("if (!visible()) return;"), "a hidden area opens jumps");
    assert.match(hook, /if \(prior === false && now\) \{[\s\S]{0,120}setRaw\(\(r\) => \(r\.k === k \? \{ k, s: loadStatus\(k\), drafts: draftTabsWithStorage\(k\) \} : r\)\);/, "nothing is re-read when becoming visible");
  },
  draftTooBig(q) {
    // What localStorage does not take stays in memory (the dot stays, a chat switch does not lose it), the result says false; in the
    // browser beforeunload asks, in the desktop client NOT (there it would silently hold the window open).
    const hook = withoutComments(q.hook);
    assert.ok(hook.includes("if (d && !ok) { onlyInStorage.current.set(k, d); write(k, null); }"), "a too large draft is lost");
    assert.match(hook, /const draftWrite = useCallback\([\s\S]*?return ok;\n  \}, \[chatKey\]\);/, "draftWrite does not say whether it was remembered");
    assert.match(hook, /useEffect\(\(\) => \{\s*if \(inShell\(window\)\) return;\s*const beforeUnload/, "beforeunload also in the desktop client");
    assert.ok(hook.includes("return onlyInStorage.current.get(k) ?? readDraft(read(k));"), "draftRead does not read the memory first");
  },
  barAccessible(q) {
    // ONE tab stop (roving tabIndex), the x is no tab stop and sits NEXT TO the role=tab, the instance choice beside the list.
    const l = withoutComments(q.bar);
    assert.ok(l.includes("const r = tabKey(e.key, queue, k);"), "the bar does not ask the keys via tabKey");
    assert.ok(l.includes("tabIndex: carrier === k ? 0 : -1,"), "no roving tabIndex");
    // The tile (components/code/TabBar.tsx) draws tab and x for the Files page AND the chat; the bar passes role and roving tabIndex
    // through as `tabProps`. The x sits NEXT TO the role=tab, no tab stop.
    assert.match(l, /tabProps=\{\{\s*\.\.\.role\(k\), "aria-selected": active,/, "the code tabs do not get role and roving tabIndex");
    assert.match(l, /tabProps=\{\{ \.\.\.role\(a\), "aria-selected": active,/, "the views do not get role and roving tabIndex");
    const k = withoutComments(q.tile);
    const tab = k.indexOf("{...tabProps}"), end = k.indexOf("</span>\n      <button", tab), x = k.indexOf("data-tab-close", tab);
    assert.ok(tab > 0 && end > tab && x > end, "the x is INSIDE the role=tab (a button in a tab)");
    assert.match(k.slice(end, x), /tabIndex=\{-1\}/, "the x is a tab stop");
    // The ... menu and the instance choice stand BEHIND the closed tab list: list and scroll strip are closed before the ... comes,
    // and the instance choice follows only after it.
    const list = l.indexOf('role="tablist"'), more = l.indexOf("<Menu"), right = l.indexOf("{right && ");
    assert.ok(list > 0 && more > list && right > more, "order tab list, ..., instance choice is wrong");
    assert.match(l.slice(list, more), /<\/div>\s*<\/div>\s*$/, "the ... or the instance choice is INSIDE the tab list");
    assert.ok(q.bar.includes("Ctrl+Tab/Ctrl+Shift+Tab (chat/chatTabs.ts) never reaches the page in the BROWSER"), "the header does not say that Ctrl+Tab never arrives in the browser");
  },
  terminalOnlyOnce(q) {
    // Terminal and browser as a tab: the right bar draws the SAME section into the stage's slot and only a hint at its own place;
    // otherwise two xterms would hang on the chat's PTY (and two browser streams would run).
    const r = withoutComments(q.bar2);
    assert.ok(r.includes('tabView.kind === "terminal" ? ('), "the bar also shows the terminal while it is in front as a tab");
    assert.ok(r.includes('tabView.kind === "browser" ? ('), "the bar also shows the browser while it is in front as a tab");
    assert.match(r, /\{tabView\.slot && createPortal\(/, "terminal and browser do not come into the tab via portal");
    assert.equal((r.match(/<TerminalsPane\b/g) ?? []).length, 1, "the bar builds the terminal in more than one place");
  },
  finderFresh(q) {
    // The finder computes via finderSituation; a new input forgets a waiting Enter.
    const fi = withoutComments(q.finder);
    // The rows are VS Code's row: "recently opened" and "file results" in ONE list (lib/quick-input.ts `fileRows`), not only the
    // server's answer; it is fresh only for the input of the answer.
    assert.ok(fi.includes("const situation = finderSituation(query, response ? { q: response.q, results: queue.map((z) => z.path) } : null, openHere, choice);"), "the finder does not compute via finderSituation");
    assert.ok(fi.includes("return { state: status, forgetEnter: () => { enterWaiting.current = null; } };"), "the finder cannot forget the waiting Enter");
    assert.ok(withoutComments(q.palette).includes("onChange={(e) => { files.forgetEnter(); setInput(e.target.value); }}"), "a new input does not forget the waiting Enter");
    assert.ok(fi.includes('else if (situation.enter?.kind === "wait") enterWaiting.current = query.trim();'), "Enter does not wait for the fresh answer");
    assert.ok(fi.includes("if (enterWaiting.current === q) {"), "the fresh answer does not redeem the waiting Enter");
  },
};
const SOURCE_SABOTAGES = {
  "CodeArea controlled": { file: "codeArea", old: "<CodePane", fresh: "<CodePane controlled={null}", catches: "pageUncontrolled" },
  "tick also when controlled": { file: "codePane", old: "if (!isActive || isControlled) return;", fresh: "if (!isActive) return;", catches: "gitWithoutTick" },
  "git state also when hidden": { file: "codePane", old: "useGitState(controlled && isActive ? apiBase : null,", fresh: "useGitState(controlled ? apiBase : null,", catches: "gitWithoutTick" },
  "chat target without chat": { file: "area", old: "gitChat: tabs.chatId && targetEqual(z, tabs.chatTarget) ? tabs.chatId : null,", fresh: "gitChat: null,", catches: "gitWithoutTick" },
  "tab row also when controlled": { file: "codePane", old: "{g.paths.length > 0 && !controlled && (", fresh: "{g.paths.length > 0 && (", catches: "oneTabList" },
  "title row with copied buttons": { file: "codePane", old: "const actionsButtons = buttonsFor(activePath);", fresh: "const actionsButtons = null;", catches: "oneTabList" },
  "area not per chat": { file: "stage", old: "<ChatCodeArea key={chatTabs.chatKey} ", fresh: "<ChatCodeArea ", catches: "wired" },
  "drop reaches the stage": { file: "area", old: "onDrop={(e) => { e.stopPropagation(); e.preventDefault(); }}", fresh: "onDrop={(e) => { e.preventDefault(); }}", catches: "throwNoAttachment" },
  "shortcuts without visibility check": { file: "hook", old: "if (!el || !el.isConnected || el.getClientRects().length === 0) return;", fresh: "if (!el) return;", catches: "shortcutOnlyVisible" },
  "shortcuts blocked only under role=dialog": { file: "hook", old: `document.querySelector('[aria-modal="true"]')`, fresh: `document.querySelector('[role="dialog"][aria-modal="true"]')`, catches: "shortcutOnlyVisible" },
  "busyPrior wrong on switch": { file: "hook", old: "setNew(false); busyPrior.current = busy; }, [chatKey]);", fresh: "setNew(false); busyPrior.current = false; }, [chatKey]);", catches: "busyPrior" },
  "takeover without marker": { file: "hook", old: "    if (fromDraft.get(activeId) !== u.from) return;\n", fresh: "", catches: "takeoverMarker" },
  "ChatPane does not report the creation": { file: "pane", old: " rememberCreationFromDraft(wsId, chatId);", fresh: "", catches: "takeoverMarker" },
  "hidden writes": { file: "hook", old: "if (raw.k !== chatKey || !visible()) return;", fresh: "if (raw.k !== chatKey) return;", catches: "onlyVisible" },
  "hidden opens jumps": { file: "hook", old: "      if (!visible()) return; // only the visible area", fresh: "      // Finding 14", catches: "onlyVisible" },
  "visible without re-read": { file: "hook", old: "if (prior === false && now) {", fresh: "if (false) {", catches: "onlyVisible" },
  "too large draft lost": { file: "hook", old: "if (d && !ok) { onlyInStorage.current.set(k, d); write(k, null); }", fresh: "if (d && !ok) { write(k, null); }", catches: "draftTooBig" },
  "beforeunload in the desktop client": { file: "hook", old: "    if (inShell(window)) return;\n    const beforeUnload", fresh: "    const beforeUnload", catches: "draftTooBig" },
  "no roving tabIndex": { file: "bar", old: "tabIndex: carrier === k ? 0 : -1,", fresh: "tabIndex: 0,", catches: "barAccessible" },
  "x as tab stop": { file: "tile", old: "        type=\"button\"\n        tabIndex={-1}\n", fresh: "        type=\"button\"\n", catches: "barAccessible" },
  "x in the tab": { file: "tile", old: "{dirty && <span className=\"sr-only\">{t(\"unsaved\")}</span>}\n      </span>\n      <button", fresh: "{dirty && <span className=\"sr-only\">{t(\"unsaved\")}</span>}\n      <button", catches: "barAccessible" },
  "code tabs without role": { file: "bar", old: "                  ...role(k), \"aria-selected\": active,", fresh: "                  \"aria-selected\": active,", catches: "barAccessible" },
  "... in the list": { file: "bar", old: "      </div>\n      {/* The ... directly behind the last tab", fresh: "      {/* The ... directly behind the last tab", catches: "barAccessible" },
  "terminal twice": { file: "bar2", old: "            tabView.kind === \"terminal\" ? (", fresh: "            false ? (", catches: "terminalOnlyOnce" },
  "browser twice": { file: "bar2", old: "            tabView.kind === \"browser\" ? (", fresh: "            false ? (", catches: "terminalOnlyOnce" },
  "finder without finderSituation": { file: "finder", old: "const situation = finderSituation(query, response ? { q: response.q, results: queue.map((z) => z.path) } : null, openHere, choice);", fresh: "const situation = finderSituation(query, response ? { q: query.trim(), results: queue.map((z) => z.path) } : null, openHere, choice);", catches: "finderFresh" },
  "new input keeps the Enter": { file: "palette", old: "onChange={(e) => { files.forgetEnter(); setInput(e.target.value); }}", fresh: "onChange={(e) => { setInput(e.target.value); }}", catches: "finderFresh" },
  "forgetting forgets nothing": { file: "finder", old: "forgetEnter: () => { enterWaiting.current = null; }", fresh: "forgetEnter: () => {}", catches: "finderFresh" },
};

test("(2) source guards: Files page uncontrolled, no second git tick, ONE tab list, stage wired, drop is no attachment, shortcuts only when visible, review findings", () => {
  for (const [name, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(sources); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  const controlledHandedOver = allComponents.filter((p) => /(?<![\w-])controlled=\{/.test(withoutComments(fs.readFileSync(p, "utf8")))).map((p) => path.relative(webDir, p));
  assert.deepEqual(controlledHandedOver, ["src/components/chat/ChatCodeArea.tsx"], "only the chat's code area controls CodePane");
});

test("(2) counter-tests on the sources: every sabotage is caught", () => {
  const notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    const template = sources[s.file];
    assert.equal(template.split(s.old).length - 1 >= 1, true, `sabotage '${name}': the spot is missing in ${Q_FILES[s.file]}`);
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...sources, [s.file]: template.replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(name);
  }
  assert.deepEqual(notCaught, [], "source sabotages that no check catches");
});

test("(2) every t(\"...\") key of the new parts is in i18n-de.ts", () => {
  const key = new Set();
  for (const k of ["bar", "area", "finder", "palette", "turnout", "hook"]) {
    for (const m of sources[k].matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) key.add(JSON.parse(`"${m[1]}"`));
  }
  for (const k of ["The file was changed — reload it or keep your changes?", "Reload", "Keep mine", "Dismiss",
    "The file was deleted — your text is still here; “Keep mine” recreates it when you save.", "Too large for a draft — it will not survive a reload; save before closing.",
    "Choose first: reload or keep your changes.", "Not saved: the file has changed in the meantime.", "Saving failed: {msg}"]) {
    assert.ok(sources.codePane.includes(`t("${k}"`), `CodePane does not name '${k}'`);
    key.add(k);
  }
  const missing = [...key].filter((k) => !(k in DE));
  assert.deepEqual(missing, [], "without a German entry");
  assert.ok(key.size >= 20, `too few keys found (${key.size}); the reader no longer matches`
);
});
