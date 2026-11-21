// The Markdown preview as in VS Code.
// (1) lib/md-preview.ts, EXECUTED: which files are Markdown, the title "Preview README.md", Cmd+Shift+V / Ctrl+Shift+V, the resolution of
//     a reference RELATIVE TO THE FILE (http(s)/mailto outward, `#anchor` inside the preview, a path with `/` from the root, otherwise
//     from the file's folder, `#L12` as a line; beyond the root, a foreign scheme, a foreign host and a badly encoded path are NO
//     reference), images only from the target, the identifier of a heading as in VS Code, the extensions of VS Code's language
//     "markdown" (.markdn and .workbook added, .mkdn not), the title of a locked preview, the identifiers of ALL headings (duplicates
//     with "-1", "-2" — the anchor searches over them; the rendered HTML is checked by web/test/markdown.test.mjs) and the sync of editor
//     and preview over the source lines of the blocks (VS Code preview-src/scroll-sync.ts).
// (2) The sources: the app's rendering is reused (components/Markdown.tsx via `MarkdownReferenceContext` — without context everything as
//     before), the preview follows the BUFFER (unsaved text), otherwise the disk, images via files/download of the instance, title and
//     palette translated. It is its own TAB (components/code/PreviewTab.tsx): Cmd+Shift+V opens it with focus at the editor's line,
//     Cmd+K V beside it without focus, on it Cmd+Shift+V / "Open Source File" leads to the source; the unlocked one follows the active
//     Markdown editor (groups and chat), locking in palette and "..." menu; both scroll in step.
// Every sabotage is a copy of the source with ONE changed spot; the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/md-preview.test.mjs
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
const SOURCE = read("src", "lib", "md-preview.ts");

// ── (1) The calculation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SABOTAGES = {
  "mdx is Markdown": { old: "export const MARKDOWN_SUFFIXES = [\".md\", ", fresh: "export const MARKDOWN_SUFFIXES = [\".mdx\", \".md\", ", catches: "markdown" },
  "\".md\" alone is Markdown": { old: " && p.length > e.length && !p.endsWith(`/${e}`)", fresh: "", catches: "markdown" },
  "title with path": { old: "values: { name: nameOf(path) } };", fresh: "values: { name: path } };", catches: "title" },
  "locked like open": { old: "key: locked ? \"[Preview] {name}\" : \"Preview {name}\"", fresh: "key: \"Preview {name}\" as \"Preview {name}\"", catches: "title" },
  ".mkdn is Markdown": { old: "\".markdn\", ", fresh: "\".markdn\", \".mkdn\", ", catches: "markdown" },
  ".workbook missing": { old: ", \".workbook\"]", fresh: "]", catches: "markdown" },
  "duplicate heading without counter": { old: "return anchorSlug(`${slug}-${n + 1}`);", fresh: "return slug;", catches: "anchor" },
  "counter does not count on": { old: "counter.set(slug, n + 1);", fresh: "", catches: "anchor" },
  "anchor compared raw": { old: ".indexOf(anchorSlug(anchor))", fresh: ".indexOf(anchor)", catches: "anchor" },
  "between two blocks over the starts": { old: "const end = prior.top + prior.height;", fresh: "const end = prior.top;", catches: "sync" },
  "in the block without fraction": { old: "return prior.top + prior.height * (row - Math.floor(row));", fresh: "return prior.top;", catches: "sync" },
  "exact line like in between": { old: "if (b.row === whole) { prior = b; next = null; break; }", fresh: "", catches: "sync" },
  "gap takes the next": { old: "if (b.top > y) {", fresh: "if (false) {", catches: "sync" },
  "in the block without successor share": { old: "if (n) return b.row + ((y - b.top) / Math.max(1, n.top - b.top)) * (n.row - b.row);", fresh: "", catches: "sync" },
  "after the last unbounded": { old: "return b.row + Math.min(1, (y - b.top) / Math.max(1, b.height));", fresh: "return b.row + (y - b.top) / Math.max(1, b.height);", catches: "sync" },
  "key with Alt": { old: "if (!v || !e.shiftKey || e.altKey) return false;", fresh: "if (!v || !e.shiftKey) return false;", catches: "key" },
  "Ctrl on the Mac": { old: "return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;", fresh: "return e.metaKey || e.ctrlKey;", catches: "key" },
  "foreign scheme as path": { old: "if (SCHEMA.test(h) || h.startsWith(\"//\")) return { kind: \"none\" };", fresh: "", catches: "reference" },
  "beyond the root": { old: "if (s === \"..\") { if (!out.length) return null; out.pop(); continue; }", fresh: "if (s === \"..\") { out.pop(); continue; }", catches: "reference" },
  "absolute like relative": { old: "const base = part.startsWith(\"/\") ? [] : folder.split(\"/\").filter(Boolean);", fresh: "const base = folder.split(\"/\").filter(Boolean);", catches: "reference" },
  "query in the path": { old: "const raw = question >= 0 ? withoutHash.slice(0, question) : withoutHash;", fresh: "const raw = withoutHash;", catches: "reference" },
  "broken encoding guessed": { old: "try { part = decodeURI(raw); } catch { return null; }", fresh: "part = raw;", catches: "reference" },
  "no line": { old: "const row = m ? Math.max(1, Number(m[1])) : null;", fresh: "const row = null;", catches: "reference" },
  "empty anchor": { old: "return id ? { kind: \"anchor\", id } : { kind: \"none\" };", fresh: "return { kind: \"anchor\", id };", catches: "reference" },
  "image from outside": { old: "return v.kind === \"file\" ? v.path : null;", fresh: "return v.kind === \"file\" ? v.path : v.kind === \"extern\" ? v.href : null;", catches: "image" },
  "leading dashes stay": { old: ".replace(/^-+/, \"\")", fresh: ".replace(/^\\u0000/, \"\")", catches: "anchor" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-md-preview-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "md-preview.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `md-preview-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

const D = "docs/guide/README.md";
const CHECKS = {
  markdown: (m) => {
    // VS Code extensions/markdown-basics: .md .mkd .mdwn .mdown .markdown .markdn .mdtxt .mdtext .workbook — NOT .mkdn.
    for (const p of ["README.md", "a/b.MARKDOWN", "x.mdown", "notes.mkd", "a.markdn", "b.workbook", "c.mdwn", "d.mdtxt", "e.mdtext"]) assert.equal(m.isMarkdown(p), true, p);
    for (const p of ["x.mdx", "x.mkdn", "md", "a/.md", ".md", "a.ts", null, ""]) assert.equal(m.isMarkdown(p), false, String(p));
  },
  title: (m) => {
    assert.deepEqual(m.previewTitle(D), { key: "Preview {name}", values: { name: "README.md" } }, "VS Code \"Preview README.md\"");
    assert.deepEqual(m.previewTitle(D, true), { key: "[Preview] {name}", values: { name: "README.md" } }, "locked: VS Code \"[Preview] README.md\"");
  },
  key: (m) => {
    const t = (x) => ({ key: "V", code: "KeyV", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, ...x });
    assert.equal(m.isPreviewKey(t({ metaKey: true }), true), true, "⇧⌘V");
    assert.equal(m.isPreviewKey(t({ ctrlKey: true }), false), true, "Strg+⇧+V");
    assert.equal(m.isPreviewKey(t({ ctrlKey: true }), true), false, "on the Mac not with Ctrl");
    assert.equal(m.isPreviewKey(t({ metaKey: true, altKey: true }), true), false, "Alt+Shift+Cmd+V is another key");
    assert.equal(m.isPreviewKey(t({ metaKey: true, shiftKey: false }), true), false, "Cmd+V is paste");
  },
  reference: (m) => {
    assert.deepEqual(m.resolveReference(D, "https://example.com/x"), { kind: "extern", href: "https://example.com/x" });
    assert.deepEqual(m.resolveReference(D, "mailto:a@b.example"), { kind: "extern", href: "mailto:a@b.example" });
    assert.deepEqual(m.resolveReference(D, "#Install-Steps"), { kind: "anchor", id: "Install-Steps" });
    for (const h of ["#", "", "file:///etc/passwd", "smb://host/x", "javascript:alert(1)", "//foreign.example/x", "../../../x", "%E0%A4%A", "#%E0%A4%A"]) {
      assert.deepEqual(m.resolveReference(D, h), { kind: "none" }, `"${h}" is no reference`);
    }
    assert.deepEqual(m.resolveReference(D, "../api.md"), { kind: "file", path: "docs/api.md", row: null, markdown: true }, "relative to the file's folder");
    assert.deepEqual(m.resolveReference(D, "./image.png"), { kind: "file", path: "docs/guide/image.png", row: null, markdown: false });
    assert.deepEqual(m.resolveReference(D, "/web/src/a.ts#L12"), { kind: "file", path: "web/src/a.ts", row: 12, markdown: false }, "\"/\" from the root, #L12 as a line");
    assert.deepEqual(m.resolveReference(D, "a%20b.md?x=1#top"), { kind: "file", path: "docs/guide/a b.md", row: null, markdown: true }, "decoded, without query");
  },
  image: (m) => {
    assert.equal(m.imagePath("README.md", "img/a.png"), "img/a.png");
    assert.equal(m.imagePath("docs/x.md", "../logo.svg"), "logo.svg");
    assert.equal(m.imagePath("README.md", "https://example.com/a.png"), null, "nothing is loaded from outside");
    assert.equal(m.imagePath("README.md", "data:image/png;base64,AAAA"), null, "data: is passed through by the rendering itself");
  },
  anchor: (m) => {
    assert.equal(m.anchorSlug("Install Steps!"), "install-steps");
    assert.equal(m.anchorSlug("  Über uns: Team "), "über-uns-team");
    assert.equal(m.anchorSlug("-- a --"), "a", "dashes at the edge drop");
    // All headings in order; the second of the same name gets "-1", the third "-2" (VS Code githubSlugifier.createBuilder).
    assert.deepEqual(m.anchorIds(["Intro", "Setup", "Intro", "Intro"]), ["intro", "setup", "intro-1", "intro-2"]);
    assert.equal(m.anchorIndex(["Intro", "Install Steps", "Intro"], "Install-Steps"), 1, "the anchor is read like an identifier");
    assert.equal(m.anchorIndex(["Intro", "Install Steps", "Intro"], "intro-1"), 2, "\"#intro-1\" is the SECOND \"Intro\"");
    assert.equal(m.anchorIndex(["Intro"], "missing"), -1);
  },
  // The preview side of the sync (VS Code `scrollToRevealSourceLine` / `getEditorLineNumberForPageOffset`).
  sync: (m) => {
    const B = [{ row: 0, top: 0, height: 20 }, { row: 4, top: 40, height: 60 }, { row: 10, top: 120, height: 20 }];
    assert.equal(m.positionForLine(B, 0), 0);
    assert.equal(m.positionForLine(B, 4), 40, "a line with a block: its start");
    assert.equal(m.positionForLine(B, 4.5), 70, "inside it: its fraction");
    assert.equal(m.positionForLine(B, 2), 30, "between two blocks: proportionally over the gap (20 … 40)");
    assert.equal(m.positionForLine(B, 7), 110, "between 4 and 10: over the gap 100 … 120");
    assert.equal(m.positionForLine(B, 12), 120, "after the last: its start");
    assert.equal(m.positionForLine([], 5), 0);
    assert.equal(m.lineForPosition(B, 0), 0);
    assert.equal(m.lineForPosition(B, 70), 6.25, "in block 4: proportionally up to the next (4 + 30/80 · 6)");
    assert.equal(m.lineForPosition(B, 30), 3, "in the gap before block 4: proportionally from the previous (0 + 30/40 · 4)");
    assert.equal(m.lineForPosition(B, 125), 10.25, "in the last: its fraction");
    assert.equal(m.lineForPosition(B, 500), 11, "after the last: at most one line further");
    assert.equal(m.lineForPosition([], 3), null);
  },
};

test("(1) Markdown preview: suffixes, title, key, references relative to the file, images, anchor, scroll sync", async () => {
  const m = await load("md-preview.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("(1) Markdown preview: every sabotage fails at its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot appears ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The preview is its own TAB (lib/editor-inputs.ts, components/code/PreviewTab.tsx). The calculation of the tabs (Cmd+Shift+V, Cmd+K V,
// following, locking, back to the source) is run by web/test/editor-inputs.test.mjs; here it is checked that the surface uses it.
// components/code/InputParts.tsx draws the preview, the title buttons and the "..." menu (CodePane only passes the connection); plus
// "Open as Preview" (VS Code `markdown.reopenAsPreview`), a reference switches THIS preview in the chat (also the locked one, VS Code
// `this.update`) and otherwise jumps to the line, a restored preview without a file is dropped.
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  md: read("src", "components", "Markdown.tsx"),
  preview: read("src", "components", "code", "MarkdownPreview.tsx"),
  tab: read("src", "components", "code", "PreviewTab.tsx"),
  pane: read("src", "components", "CodePane.tsx"),
  input: read("src", "components", "code", "InputParts.tsx"),
  chat: read("src", "components", "chat", "ChatCodeArea.tsx"),
  chattabs: read("src", "components", "chat", "chatTabs.ts"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
/** The body of the function `name` (from its line to the next line that closes at the same depth). */
const body = (q, header) => { const i = q.indexOf(header); if (i < 0) return ""; const j = q.indexOf("\n  }\n", i); return q.slice(i, j < 0 ? undefined : j); };
function sources(q) {
  const md = withoutComments(q.md), v = withoutComments(q.preview), tab = withoutComments(q.tab), c = withoutComments(q.pane), chat = withoutComments(q.chat), ct = withoutComments(q.chattabs);
  const one = withoutComments(q.input);
  // The app's rendering, not rebuilt — with context for the references, without it as before.
  assert.ok(md.includes("const references = useContext(MarkdownReferenceContext);"), "the rendering does not know the preview context");
  assert.ok(md.includes("const own = references?.image(image[2]) ?? null;") && md.includes("const href = imageTarget(image[2]);"), "images: the context or the route from before");
  assert.ok(md.includes("const own = references?.link(link[2]) ?? null;") && md.includes("const href = LINK_TARGET.test(link[2]) ? link[2] : \"\";"), "references: the context or the route from before");
  assert.ok(v.includes("<MarkdownReferenceContext.Provider value={references}>") && v.includes("<Markdown src={text} preview />"), "the preview builds its own rendering");
  assert.ok(v.includes("onFile(v.path, v.row, v.markdown);"), "a reference to a file does not open it");
  // The anchor searches via the rendering's marker (headings are <div>) and `anchorIndex`.
  assert.ok(v.includes("querySelectorAll<HTMLElement>(`[${HEADING_MARKER}]`)") && v.includes("const i = anchorIndex(headings.map((h) => h.textContent || \"\"), anchor);")
    && v.includes("if (f) anchorTarget(f, v.id)?.scrollIntoView({ block: \"start\" });"), "an anchor does not scroll to the heading");
  assert.ok(!/querySelectorAll[^;]*h1, h2/.test(v), "the anchor searches h1–h6 — the rendering draws <div>");
  // The surface takes the focus — Cmd+Shift+V opens the tab WITH focus (the group focuses its preview), Cmd+K V without.
  assert.ok(v.includes("<div ref={surface} tabIndex={-1} ") && v.includes("useEffect(() => { if (focus) surface.current?.focus({ preventScroll: true }); }, []);"), "the preview does not take the focus");
  assert.ok(tab.includes("<MarkdownPreview t={t} path={path} text={text ?? own?.text ?? null} imageUrl={imageUrl} onFile={onFile} focus={focus} row={row}"), "the tab does not pass text, focus or start line to the preview");
  assert.ok(c.includes("el.querySelector<HTMLElement>(\"[data-preview-tab] [data-md-preview]\")") && c.includes("if (view) { view.focus({ preventScroll: true }); return true; }"), "a group's focus does not go into its preview");
  // If the tab is not in front yet (Cmd+Shift+V to the source, which is still loading; a diff that is reading), the focus waits on the
  // group and goes in as soon as it is — never if the human has put it elsewhere in the meantime.
  assert.ok(c.includes("if (G.groupOf(gr.ref.current, gid)?.active) focusOpen.current = gid;")
    && c.includes("const observer = new MutationObserver(() => { if (done()) observer.disconnect(); });")
    && c.includes("if (document.activeElement === el && !focusIn(open)) return false;"), "the focus stays on the group when its editor appears only later");
  assert.ok(c.includes("if (applyGroups((x) => E.openPreview(x, gid, e.path)) !== s) focusWish.current = gid;"), "Cmd+Shift+V does not open the preview tab (or without focus)");
  assert.ok(!body(c, "function previewBeside(gid: string) {").includes("focusWish"), "Cmd+K V takes the focus from the editor");
  assert.ok(c.includes("applyGroups((s) => E.openPreview(s, gid, a, { beside: true }));"), "Cmd+K V does not open the preview beside");
  // Start line: whoever triggers Cmd+Shift+V/Cmd+K V remembers the top line of the editor under the tab's key; the tab takes it ONCE.
  assert.ok(c.includes("rememberStartLine(E.previewKey(e.path), editorRowIn(gid));") && c.includes("rememberStartLine(E.previewKey(a), editorRowIn(gid));")
    && c.includes("return v && v.dom.getClientRects().length > 0 ? editorRow(v) : undefined;"), "Cmd+Shift+V/Cmd+K V does not open at the editor's line");
  assert.ok(tab.includes("const [row] = useState(() => takeStartRow(previewKey));") && tab.includes("const z = START.get(key);\n  START.delete(key);"), "the start line is not taken (once)");
  // The sync: on opening the editor's line, afterwards both directions; the preview knows the editor of the same file beside it.
  assert.ok(v.includes("v.scrollDOM.addEventListener(\"scroll\", onEditorScroll, { passive: true });") && v.includes("f.addEventListener(\"scroll\", onPreviewScroll, { passive: true });")
    && v.includes("f.scrollTop = positionForLine(previewBlocks(f), editorRow(v));") && v.includes("setEditorLine(v, z);"), "editor and preview do not scroll in step");
  assert.ok(c.includes("editor={q ? { view: () => viewOf(q).current?.view ?? null, key: q } : null}")
    && one.includes("{...(editor ? { editor: editor.view, editorKey: editor.key } : {})}"), "the preview does not know the editor beside it");
  // Following (VS Code: the dynamic preview shows the active Markdown editor) — in the groups and in the chat.
  assert.ok(c.includes("if (!isControlled && activePathIntern && isMarkdown(activePathIntern)) applyGroups((s) => E.followUpPreviews(s, activePathIntern));"), "the preview does not follow the active editor");
  assert.ok(ct.includes("useEffect(() => { if (mdFront) setStatus((s) => followUpPreview(s, mdFront.target, mdFront.path)); }, [mdFrontKey]);"), "the preview in the chat does not follow");
  // Locking: palette and "..." menu (VS Code `1_markdown`).
  assert.ok(c.includes("{ id: \"markdown.togglePreviewLock\", title: t(\"Markdown: Toggle Preview Locking\"), execute: () => toggleLock(lockTarget) }"), "the lock is missing in the palette");
  assert.ok(one.includes("{ id: \"markdown.preview.toggleLock\", label: t(\"Toggle Preview Locking\"), execute: p.lock },")
    && c.includes("lock: () => { if (front) toggleLock({ gid, key: front }); },"), "the lock is missing in the \"...\" menu");
  assert.ok(c.includes("const toggleLock = (z: { gid: string; key: string }) => applyGroups((s) => E.toggleLock(s, z.gid, z.key));"), "the lock has no effect on the tab");
  // Live from the buffer (subscribed), otherwise the disk via the instance, anew on every save/git state; images via the instance.
  assert.ok(tab.includes("useEffect(() => buffer?.subscribe(tick), [buffer]);") && tab.includes("const text = buffer && buffer.status.state === \"loaded\" ? buffer.text : null;"), "the preview does not follow the buffer");
  assert.ok(tab.includes("api<{ content?: unknown; sha?: unknown }>(instancePath(`${target.apiBase}/files/read?path=${encodeURIComponent(path)}`, target.instance))")
    && tab.includes("}, [withoutBuffer, path, target.apiBase, target.instance, revision]);"), "without a buffer the preview does not read the disk (via the instance, anew on every state)");
  assert.ok(c.includes("buffer={bufferOf(path)}") && c.includes("status={fileStatus} imageUrl={(x) => fileDownloadUrl(apiBase, x, true, instance)}"), "the group does not pass buffer, state or instance");
  // Cmd+Shift+V: on Markdown open, on the preview back to the source; the key and the "Open Source File" button.
  assert.ok(c.includes("else if (isPreviewKey(e, isMac()) && (previewFront || isMarkdown(activePath))) {") && c.includes("previewToggle(); }"), "Cmd+Shift+V does not open the preview");
  assert.ok(c.includes("if (e.kind === \"preview\") { if (applyGroups((x) => E.toSource(x, gid, k)) !== s) focusWish.current = gid; return; }"), "Cmd+Shift+V on the preview does not lead to the source");
  assert.ok(one.includes("<TitleButton name=\"file-code\" title={t(\"Open Source File\")} onClick={onSource} ") && c.includes("<EditorTitleButtons t={t} kind=\"preview\" onSource={() => sourceOpen(gid, key)} />")
    && c.includes("applyGroups((x) => E.toSource(G.activateGroup(x, gid), gid, key))"), "\"Open Source File\" is missing");
  assert.ok(one.includes("{ id, symbol: \"open-preview\", title: t(\"Open Preview to the Side\"), data: { \"data-preview-beside\": \"\" }, execute: (alt) => v.open(alt) }") && one.includes("onClick={(ev) => a.execute(ev.altKey)} />")
    && c.includes("open: (old) => { if (old) { applyGroups((x) => G.activateGroup(x, gid)); previewToggle(); } else previewBeside(gid); }"), "\"Open Preview to the Side\" is missing (or Alt does not open in the same group)");
  // "Open as Preview" (VS Code `markdown.reopenAsPreview`, navigation@2, codicon preview): the file becomes a locked preview in its place.
  assert.ok(one.includes("{ id, symbol: \"preview\", title: t(\"Open as Preview\"), data: { \"data-as-preview\": \"\" }, execute: () => d.asPreview?.() }")
    && c.includes("asPreview: md ? () => asPreview(gid) : null,")
    && c.includes("applyGroups((x) => E.asPreview(x, g.id, path, dirtyOf(path) && !E.otherHolds(x, g.id, path)))")
    && chat.includes("asPreview: () => { const a = tabsRef.current.activeTab; if (a?.kind === \"file\") tabsRef.current.asPreview(keyName(a)); },")
    && ct.includes("asPreview: useCallback((key: string) => setStatus((s) => asPreviewOpen(s, key, carriesUnsaved(s)(key))), [setStatus, carriesUnsaved]),"), "\"Open as Preview\" is missing");
  // The tab stands in the editor's place; a reference to a .md shows it IN the preview (VS Code `openMarkdownLinks: inPreview`).
  assert.ok(c.includes("{input?.kind === \"preview\" && g.active && previewFor(g, g.active, input.path)}"), "the preview tab is not drawn");
  assert.ok(c.includes("if (markdown && row === null && e?.kind === \"preview\") { applyGroups((s) => G.replaceIn(s, g.id, key, E.previewKey(x, e.locked))); focusWish.current = g.id; return; }"), "a linked .md does not open in the preview (or the focus falls on the body)");
  // The same in the chat: THIS preview switches (also the locked one), a reference with a line jumps there (the jump via the nav context).
  assert.ok(chat.includes("if (markdown && row === null) { onReference(path); return; }") && chat.includes("onReference={(path) => tabsRef.current.switchPreview(keyName(preview), path)}")
    && ct.includes("switchPreview: useCallback((key: string, path: string) => setStatus((s) => previewSwitch(s, key, path)), [setStatus]),"), "in the chat a reference does not switch the preview");
  assert.ok(chat.includes("if (row !== null) nav?.rememberJump(path, { line: Math.max(0, row - 1), character: 0 });"), "in the chat a reference does not jump to its line");
  // A restored preview whose file is missing is dropped — in the groups and in the chat.
  assert.ok(tab.includes("onDisk?.(false); })") && tab.includes("onDisk?.(isMissingReading(e)); });"), "the preview does not report whether its file is missing");
  assert.ok(c.includes("onDisk={(missing) => { if (gr.restored.current.delete(key) && missing) applyGroups((s) => G.remove(s, (k) => k === key)); }}"), "a restored preview without a file stays (groups)");
  assert.ok(chat.includes("onDisk={(missing) => tabsRef.current.previewRead(keyName(preview), missing)}") && ct.includes("if (w && w.keys.delete(key) && missing) setStatus((s) => close(s, key));"), "a restored preview without a file stays (chat)");
  assert.ok(c.includes("else if (id === \"markdown.showPreviewToSide\") previewBeside(gid);"), "Cmd+K V is not wired");
  // The group query also answers maximise, widths and moving — Cmd+K V stays restricted to Markdown, in the asking group, and only on
  // a FILE tab.
  assert.ok(c.includes("const s = gr.ref.current, g = G.groupOf(s, group ?? s.active);\n    if (id === \"markdown.showPreviewToSide\") return isMarkdown(E.fileTab(g?.active));"), "Cmd+K V is also offered on non-Markdown in the palette");
  // The tab is named as in VS Code and carries the preview symbol.
  assert.ok(one.includes("if (e.kind === \"preview\") return { kind: \"preview\", name: tt.name, hint: tt.hint, symbolPath: null, icon: <TitleSymbolSvg name=\"markdown-preview\" />, relPath: null, explorer: false };"), "the preview tab does not carry name or symbol (or \"Copy Path\"/\"Reveal in Explorer\" — a webview is no file)");
  // In the chat: the same building block, Cmd+Shift+V via the control, "Open Source File" in the title row.
  assert.ok(chat.includes(") : preview ? <ChatPreview key={keyName(preview)} ") && chat.includes("<PreviewTab t={t} target={tab.target} path={tab.path} previewKey={previewKey(tab.path)} buffer={buffer} state={nudge}"), "the chat does not draw the preview tab");
  assert.ok(chat.includes("open: (path) => tabsRef.current.openPreview(z, path),") && c.includes("else if (activePath && isMarkdown(activePath)) { rememberStartLine(E.previewKey(activePath), editorRowIn(G.BEGINNING.groups[0].id)); st.preview?.open(activePath); }"), "Cmd+Shift+V opens no preview tab in the chat");
  assert.ok(chat.includes("<TitleButton name=\"file-code\" title={t(\"Open Source File\")} onClick={onSource} "), "\"Open Source File\" is missing in the chat");
  for (const k of ["Preview {name}", "[Preview] {name}", "Markdown: Open Preview", "Markdown: Open Preview to the Side", "Markdown: Toggle Preview Locking", "Toggle Preview Locking",
    "Markdown: Open Source File", "Open Source File", "Open Preview to the Side", "Refresh Preview", "Open Preview", "Open as Preview"]) assert.ok(q.i18n.includes(`\n  ${JSON.stringify(k)}: `), `"${k}" without a German entry`);
}
const SOURCE_SABOTAGES = [
  ["without context", "md", "const references = useContext(MarkdownReferenceContext);", "const references = null as MarkdownReferences | null;"],
  ["route from before gone", "md", "const href = LINK_TARGET.test(link[2]) ? link[2] : \"\";", "const href = link[2];"],
  ["own rendering", "preview", "<Markdown src={text} preview />", "<pre>{text}</pre>"],
  ["rendering without markers", "preview", "<Markdown src={text} preview />", "<Markdown src={text} />"],
  ["file reference dead", "preview", "onFile(v.path, v.row, v.markdown);", ""],
  ["anchor dead", "preview", "if (f) anchorTarget(f, v.id)?.scrollIntoView({ block: \"start\" });", ""],
  ["anchor searches h1–h6", "preview", "querySelectorAll<HTMLElement>(`[${HEADING_MARKER}]`)", "querySelectorAll<HTMLElement>(\"h1, h2, h3, h4, h5, h6\")"],
  ["preview without focus", "preview", "useEffect(() => { if (focus) surface.current?.focus({ preventScroll: true }); }, []);", ""],
  ["preview not focusable", "preview", "<div ref={surface} tabIndex={-1} ", "<div ref={surface} "],
  ["focus not passed on", "tab", "onFile={onFile} focus={focus} row={row}", "onFile={onFile} line={line}"],
  ["start line not passed on", "tab", "focus={focus} row={row}", "focus={focus}"],
  ["focus not into the preview", "pane", "el.querySelector<HTMLElement>(\"[data-preview-tab] [data-md-preview]\")", "null"],
  ["focus into the editor", "pane", "if (view) { view.focus({ preventScroll: true }); return true; }", "void view;"],
  ["focus does not wait for the editor", "pane", "if (G.groupOf(gr.ref.current, gid)?.active) focusOpen.current = gid;", ""],
  ["focus without checking", "pane", "const observer = new MutationObserver(() => { if (done()) observer.disconnect(); });", "const observer = { disconnect() {} };"],
  ["focus snatches it from the human", "pane", "if (document.activeElement === el && !focusIn(open)) return false;", "if (!focusIn(open)) return false;"],
  ["Cmd+Shift+V without focus", "pane", "if (applyGroups((x) => E.openPreview(x, gid, e.path)) !== s) focusWish.current = gid;", "applyGroups((x) => E.openPreview(x, gid, e.path));"],
  ["Cmd+K V takes the focus", "pane", "applyGroups((s) => E.openPreview(s, gid, a, { beside: true }));", "applyGroups((s) => E.openPreview(s, gid, a, { beside: true })); focusWish.current = gid;"],
  ["Cmd+K V in the same group", "pane", "applyGroups((s) => E.openPreview(s, gid, a, { beside: true }));", "applyGroups((s) => E.openPreview(s, gid, a));"],
  ["Cmd+Shift+V without line", "pane", "rememberStartLine(E.previewKey(e.path), editorRowIn(gid));", ""],
  ["Cmd+K V without line", "pane", "rememberStartLine(E.previewKey(a), editorRowIn(gid));", ""],
  ["line also when hidden", "pane", "return v && v.dom.getClientRects().length > 0 ? editorRow(v) : undefined;", "return v ? editorRow(v) : undefined;"],
  ["start line never taken", "tab", "const [row] = useState(() => takeStartRow(previewKey));", "const [line] = useState<number | undefined>(undefined);"],
  ["start line stays around", "tab", "const z = START.get(key);\n  START.delete(key);", "const z = START.get(key);"],
  ["editor does not scroll the preview", "preview", "v.scrollDOM.addEventListener(\"scroll\", onEditorScroll, { passive: true });", ""],
  ["preview does not scroll the editor", "preview", "setEditorLine(v, z);", ""],
  ["beside without editor", "pane", "editor={q ? { view: () => viewOf(q).current?.view ?? null, key: q } : null}", "editor={null}"],
  ["editor not passed on", "input", "{...(editor ? { editor: editor.view, editorKey: editor.key } : {})}", "{...{}}"],
  ["does not follow", "pane", "if (!isControlled && activePathIntern && isMarkdown(activePathIntern)) applyGroups((s) => E.followUpPreviews(s, activePathIntern));", ""],
  ["does not follow in the chat", "chattabs", "useEffect(() => { if (mdFront) setStatus((s) => followUpPreview(s, mdFront.target, mdFront.path)); }, [mdFrontKey]);", ""],
  ["lock not in the palette", "pane", "{ id: \"markdown.togglePreviewLock\", title: t(\"Markdown: Toggle Preview Locking\"), execute: () => toggleLock(lockTarget) }", "{ id: \"x\", title: \"\", execute: () => undefined }"],
  ["lock not in the menu", "input", "{ id: \"markdown.preview.toggleLock\", label: t(\"Toggle Preview Locking\"), execute: p.lock },", ""],
  ["lock in the menu without effect", "pane", "lock: () => { if (front) toggleLock({ gid, key: front }); },", "lock: () => undefined,"],
  ["lock without effect", "pane", "applyGroups((s) => E.toggleLock(s, z.gid, z.key));", "undefined;"],
  ["saved text", "tab", "const text = buffer && buffer.status.state === \"loaded\" ? buffer.text : null;", "const text = null;"],
  ["buffer not subscribed", "tab", "useEffect(() => buffer?.subscribe(tick), [buffer]);", ""],
  ["disk bypassing the instance", "tab", "`${target.apiBase}/files/read?path=${encodeURIComponent(path)}`, target.instance)", "`${target.apiBase}/files/read?path=${encodeURIComponent(path)}`, null)"],
  ["disk never anew", "tab", "}, [withoutBuffer, path, target.apiBase, target.instance, revision]);", "}, [withoutBuffer, path, target.apiBase, target.instance]);"],
  ["group without buffer", "pane", "buffer={bufferOf(path)}", "buffer={null}"],
  ["image without instance", "pane", "status={fileStatus} imageUrl={(x) => fileDownloadUrl(apiBase, x, true, instance)}", "status={fileStatus} imageUrl={(x) => fileDownloadUrl(apiBase, x, true)}"],
  ["Cmd+Shift+V dead", "pane", "else if (isPreviewKey(e, isMac()) && (previewFront || isMarkdown(activePath))) {", "else if (false) {"],
  ["Cmd+Shift+V on the preview dead", "pane", "else if (isPreviewKey(e, isMac()) && (previewFront || isMarkdown(activePath))) {", "else if (isPreviewKey(e, isMac()) && isMarkdown(activePath)) {"],
  ["Cmd+Shift+V without way back", "pane", "if (e.kind === \"preview\") { if (applyGroups((x) => E.toSource(x, gid, k)) !== s) focusWish.current = gid; return; }", ""],
  ["source file button missing", "input", "<TitleButton name=\"file-code\" title={t(\"Open Source File\")} onClick={onSource} ", "<TitleButton name=\"file-code\" title=\"\" onClick={() => undefined} "],
  ["source file button without effect", "pane", "<EditorTitleButtons t={t} kind=\"preview\" onSource={() => sourceOpen(gid, key)} />", "<EditorTitleButtons t={t} kind=\"other\" onSource={() => undefined} />"],
  ["Alt opens beside", "pane", "if (old) { applyGroups((x) => G.activateGroup(x, gid)); previewToggle(); } else previewBeside(gid);", "previewBeside(gid);"],
  ["Alt does not reach the button", "input", "onClick={(ev) => a.execute(ev.altKey)} />", "onClick={() => a.execute(false)} />"],
  ["Alt does not reach the preview", "input", "execute: (alt) => v.open(alt) }", "execute: () => v.open(false) }"],
  ["Open as Preview missing", "input", "{ id, symbol: \"preview\", title: t(\"Open as Preview\"), data: { \"data-as-preview\": \"\" }, execute: () => d.asPreview?.() }", "{ id, symbol: \"preview\", title: t(\"Open as Preview\"), data: { \"data-as-preview\": \"\" }, execute: () => undefined }"],
  ["Open as Preview without group", "pane", "asPreview: md ? () => asPreview(gid) : null,", "asPreview: null,"],
  ["Open as Preview loses unsaved text", "pane", "applyGroups((x) => E.asPreview(x, g.id, path, dirtyOf(path) && !E.otherHolds(x, g.id, path)))", "applyGroups((x) => E.asPreview(x, g.id, path, false))"],
  ["Open as Preview dead in the chat", "chat", "if (a?.kind === \"file\") tabsRef.current.asPreview(keyName(a)); },", "},"],
  ["Open as Preview in the chat loses unsaved text", "chattabs", "asPreviewOpen(s, key, carriesUnsaved(s)(key))", "asPreviewOpen(s, key, false)"],
  ["preview tab empty", "pane", "{input?.kind === \"preview\" && g.active && previewFor(g, g.active, input.path)}", ""],
  ["linked .md in the editor", "pane", "if (markdown && row === null && e?.kind === \"preview\") { applyGroups((s) => G.replaceIn(s, g.id, key, E.previewKey(x, e.locked))); focusWish.current = g.id; return; }", ""],
  ["linked .md loses the lock", "pane", "E.previewKey(x, e.locked))); focusWish", "E.previewKey(x))); focusWish"],
  ["linked .md without focus", "pane", "E.previewKey(x, e.locked))); focusWish.current = g.id; return; }", "E.previewKey(x, e.locked))); return; }"],
  ["linked .md in the chat as a file", "chat", "if (markdown && row === null) { onReference(path); return; }", ""],
  ["chat reference does not switch", "chattabs", "setStatus((s) => previewSwitch(s, key, path))", "undefined"],
  ["chat reference without line", "chat", "if (row !== null) nav?.rememberJump(path, { line: Math.max(0, row - 1), character: 0 });", ""],
  ["missing file not reported", "tab", "onDisk?.(isMissingReading(e)); });", "}); "],
  ["missing preview stays (groups)", "pane", "if (gr.restored.current.delete(key) && missing) applyGroups((s) => G.remove(s, (k) => k === key));", ""],
  ["missing preview stays (chat)", "chattabs", "if (w && w.keys.delete(key) && missing) setStatus((s) => close(s, key));", ""],
  ["Cmd+K V dead", "pane", "else if (id === \"markdown.showPreviewToSide\") previewBeside(gid);", ""],
  ["Cmd+K V on every file", "pane", "if (id === \"markdown.showPreviewToSide\") return isMarkdown(E.fileTab(g?.active));", "if (id === \"markdown.showPreviewToSide\") return true;"],
  ["tab without symbol", "input", "icon: <TitleSymbolSvg name=\"markdown-preview\" />, relPath: null, explorer: false };", "icon: null, relPath: null, explorer: false };"],
  ["preview with explorer and path", "input", "icon: <TitleSymbolSvg name=\"markdown-preview\" />, relPath: null, explorer: false };", "icon: <TitleSymbolSvg name=\"markdown-preview\" />, relPath: e.path, explorer: true };"],
  ["chat without preview tab", "chat", ") : preview ? <ChatPreview key={keyName(preview)} ", ") : false ? <ChatPreview key={keyName(preview)} "],
  ["chat Cmd+Shift+V dead", "chat", "open: (path) => tabsRef.current.openPreview(z, path),", "open: () => undefined,"],
  ["chat without source file", "chat", "<TitleButton name=\"file-code\" title={t(\"Open Source File\")} onClick={onSource} ", "<TitleButton name=\"file-code\" title=\"\" onClick={() => undefined} "],
  ["translation missing", "i18n", "  \"Preview {name}\": \"Vorschau {name}\",\n", ""],
  ["translation Open Source File missing", "i18n", "  \"Open Source File\": \"Quelldatei öffnen\",\n", ""],
  ["translation Open as Preview missing", "i18n", "  \"Open as Preview\": \"Als Vorschau öffnen\",\n", ""],
];
test("(2) sources: the app's rendering, preview as a tab (focus, start line, following, lock, source), buffer, instance, chat, texts (with counter-probes)", (t) => {
  sources(Q);
  for (const [name, k, old, fresh] of SOURCE_SABOTAGES) {
    const places = Q[k].split(old).length - 1;
    assert.equal(places, 1, `counter-probe "${name}" is stale: the spot appears ${places}x in ${k}`);
    assert.throws(() => sources({ ...Q, [k]: Q[k].replace(old, fresh) }), `counter-probe "${name}" was not caught`);
  }
  t.diagnostic(`${SOURCE_SABOTAGES.length} counter-probes caught`);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
