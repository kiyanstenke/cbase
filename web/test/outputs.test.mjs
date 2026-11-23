// Outputs made visible — the web client.
//
// What this guard holds:
//   (a) lib/outputs.ts `outputsTree`: newest first (folders by their youngest file), subfolders stay, `internal` sits under ONE node
//       "Internal" at the very bottom; `filterOutputs` with a pattern; `outputsWay` unfolds down to the target (including "Internal").
//   (b) `outputPathParts`: only paths under a root of the SERVER become targets (a foreign path, a prefix of a longer name do not);
//       file/folder/pattern; punctuation after it does not belong to it; relative only with a root in the same message and a known
//       folder above.
//   (c) rendered through components/Markdown.tsx with context (`path`): inline code and free text become a button
//       `data-output-reference` with `href="#"`, without context the HTML is as before; LINK_TARGET stays unchanged.
//   (d) the wiring (web and iOS): the right bar shows the folder in the artifact section BEFORE the artifact tree (always, also without
//       artifacts) and always hangs the window in; the bubble gives assistant text the context; the client's routes are the server's.
//   (e) download: every file row links its file, every real folder row (not "Internal") and the "Outputs" row their folder as ZIP
//       (`outputFolderUrl`, the server's GET /outputs/folder); the link shows on hover; the labels have a German translation.
//
// Counter-probes (each shown red):
//   lib/outputs.ts `outputsTree` without the separation `!e.internal` (everything on top)          => (a) red;
//   lib/outputs.ts `build` sorts by name instead of by state                                     => (a) red;
//   lib/outputs.ts the branch for relative paths without `k.relative &&`                         => (b) red;
//   lib/outputs.ts the lookahead `(?![^\s/…])` after the root struck (prefix of a longer name becomes clickable) => (b) red;
//   Markdown.tsx `freeText(part, references)` -> `part`                                          => (c) red;
//   ChatRightSidebar.tsx the line `<OutputsFolder chatId={activeId} />` struck                    => (d) red;
//   OutputsFolder.tsx the folder row's `<DownloadLink … outputFolderUrl(chatId, k.key…)` struck     => (e) red;
//   OutputsFolder.tsx `k.key !== INTERNAL_KEY &&` struck (the virtual node would link a folder "internal:") => (e) red.
//
// Run:  ./check  (single file: node --test web/test/outputs.test.mjs)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const src = path.join(webDir, "src");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const reactDom = path.join(webDir, "node_modules", "react-dom");
const read = (...parts) => fs.readFileSync(path.join(src, ...parts), "utf8");
const withoutComments = (q) => q.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Compile under web/node_modules, otherwise the ESM resolution does not find `react`.
const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".outputs-test-"));
after(() => fs.rmSync(out, { recursive: true, force: true }));
execFileSync(process.execPath, [
  tsc, path.join(src, "lib", "outputs.ts"), path.join(src, "components", "Markdown.tsx"),
  "--jsx", "react-jsx", "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", out,
], { cwd: webDir, stdio: "pipe" });
const find = (name) => {
  for (const cand of [path.join(out, name), path.join(out, "lib", name), path.join(out, "components", name)]) if (fs.existsSync(cand)) return cand;
  throw new Error(`${name} not compiled`);
};
const A = await import(pathToFileURL(find("outputs.js")).href);
const M = await import(pathToFileURL(find("Markdown.js")).href);
const { renderToStaticMarkup } = await import(pathToFileURL(path.join(reactDom, "server.node.js")).href);
const { createElement } = await import(pathToFileURL(path.join(webDir, "node_modules", "react", "index.js")).href);

const W = "/home/agent/cbase/data/projects/e0ebc946/outputs/7e158315";
const OLD = "/home/agent/cbase/data/outputs/7e158315";
const e = (filePath, changed, internal = false) => ({ path: filePath, size: 1, changed, internal });
const LIST = {
  roots: [W, OLD], total: 7, clipped: false, max: 2000,
  entries: [
    e("agents/a1.output", 900, true), e("review-31.md", 800), e("screens/qa31-a.png", 700), e("screens/qa43-b.png", 950),
    e("check.js", 100), e("workflows/w.js", 50, true), e("qa-20-21/x/y.txt", 300),
  ],
};
const names = (node) => node.map((k) => k.name);

test("(a) tree: newest first, folders by youngest file, Internal collapsed at the bottom; filter and way", () => {
  const tree = A.outputsTree(LIST.entries, "Internal");
  assert.deepEqual(names(tree), ["screens", "review-31.md", "qa-20-21", "check.js", "Internal"]);
  assert.equal(tree.at(-1).key, A.INTERNAL_KEY);
  assert.equal(tree.at(-1).internal, true);
  assert.deepEqual(names(tree.at(-1).children), ["agents", "workflows"], "under Internal: agents/ and workflows/, newest first");
  const screens = tree[0];
  assert.equal(screens.key, "screens/");
  assert.deepEqual(names(screens.children), ["qa43-b.png", "qa31-a.png"]);
  assert.equal(screens.children[0].key, "screens/qa43-b.png", "the key of a file is its whole path");
  assert.deepEqual(names(tree[2].children), ["x"], "subfolders stay");
  // Without internal entries no "Internal" node.
  assert.ok(!names(A.outputsTree(LIST.entries.filter((x) => !x.internal))).includes("Internal"));
  // Filter: folder + pattern.
  assert.deepEqual(A.filterOutputs(LIST.entries, "screens", "qa31-*").map((x) => x.path), ["screens/qa31-a.png"]);
  assert.deepEqual(A.filterOutputs(LIST.entries, "screens", null).map((x) => x.path), ["screens/qa31-a.png", "screens/qa43-b.png"]);
  assert.deepEqual(A.outputsWay("agents/a1.output", true), [A.INTERNAL_KEY, "agents/"]);
  assert.deepEqual(A.outputsWay("qa-20-21/x/y.txt", false), ["qa-20-21/", "qa-20-21/x/"]);
  assert.equal(A.outputMime("screens/a.PNG"), "image/png");
  assert.equal(A.outputMime("page.html"), "text/html", "HTML is text — it is never executed");
  assert.equal(A.outputMime("without"), "application/octet-stream");
});

test("(b) paths: only under a root of the server; file, folder, pattern; relative only with a root in the message", () => {
  const message = `Report: ${W}/review-31.md . 49 screenshots are under screens/qa31-* and screens/qa43-*`;
  const k = A.pathContext(LIST, message);
  assert.equal(k.relative, true);
  const t1 = A.outputPathParts(`Report: ${W}/review-31.md.`, k);
  assert.deepEqual(t1.map((t) => t.text), ["Report: ", `${W}/review-31.md`, "."], "the punctuation does not belong to it");
  assert.deepEqual(t1[1].target, { kind: "file", path: "review-31.md" });
  assert.deepEqual(A.outputPathParts(`${W}/screens/qa31-*`, k)[0].target, { kind: "folder", path: "screens", pattern: "qa31-*" });
  assert.deepEqual(A.outputPathParts(`${W}/screens`, k)[0].target, { kind: "folder", path: "screens", pattern: null });
  assert.deepEqual(A.outputPathParts(W, k)[0].target, { kind: "folder", path: "", pattern: null });
  assert.deepEqual(A.outputPathParts(`${OLD}/old.md`, k)[0].target, { kind: "file", path: "old.md" }, "the old place is also a root");
  const rel = A.outputPathParts("are under screens/qa31-* and screens/qa43-*", k);
  assert.deepEqual(rel.filter((t) => t.target).map((t) => t.target), [
    { kind: "folder", path: "screens", pattern: "qa31-*" }, { kind: "folder", path: "screens", pattern: "qa43-*" },
  ]);
  // Nothing foreign: another place, a prefix of a longer name, an unknown folder above, a path in the middle of another.
  assert.equal(A.outputPathParts("/etc/passwd and /home/agent/cbase/data/projects/e0ebc946/scratch/x", k), null);
  assert.equal(A.outputPathParts(`${W}x/review.md`, k), null, "prefix of a longer name");
  assert.equal(A.outputPathParts("see src/app.ts and /tmp/screens/a.png", k), null);
  // Without a root in the message no relative paths.
  const without = A.pathContext(LIST, "49 screenshots under screens/qa31-*");
  assert.equal(without.relative, false);
  assert.equal(A.outputPathParts("49 screenshots under screens/qa31-*", without), null);
  assert.equal(A.pathContext(null, message), null);
  assert.equal(A.pathContext({ ...LIST, roots: [] }, message), null);
});

test("(c) Markdown with context: inline code and free text become buttons, without context nothing differs", () => {
  const md = `Report \`${W}/review-31.md\`, images under ${W}/screens/qa31-* and \`/etc/passwd\`.`;
  const k = A.pathContext(LIST, md);
  const opened = [];
  const context = {
    image: () => null, link: () => null,
    path: (text) => A.outputPathParts(text, k)?.map((t) => (t.target ? { text: t.text, open: () => opened.push(t.target) } : { text: t.text })) ?? null,
  };
  const including = renderToStaticMarkup(createElement(M.MarkdownReferenceContext.Provider, { value: context }, createElement(M.Markdown, { src: md })));
  const buttons = including.match(/<a [^>]*data-output-reference[^>]*>[\s\S]*?<\/a>/g) || [];
  assert.equal(buttons.length, 2, including);
  assert.match(buttons[0], /href="#"/);
  assert.match(buttons[0], /<code[^>]*>[^<]*review-31\.md<\/code>/, "the whole inline code is the button");
  assert.match(buttons[1], /screens\/qa31-\*/);
  assert.doesNotMatch(including, /data-output-reference[^>]*>[^<]*<code[^>]*>\/etc\/passwd/, "a foreign path stays code");
  const without = renderToStaticMarkup(createElement(M.Markdown, { src: md }));
  assert.doesNotMatch(without, /data-output-reference/);
  assert.match(read("components", "Markdown.tsx"), /const LINK_TARGET = \/\^\(https\?:\|mailto:\|#\|\\\/\)\/;/, "LINK_TARGET unchanged");
});

test("(d) wiring: bar (folder before the artifact tree, window always), bubble (context), routes like the server's", () => {
  const bar = withoutComments(read("components", "chat", "ChatRightSidebar.tsx"));
  const folder = bar.indexOf("<OutputsFolder chatId={activeId} />");
  assert.ok(folder > 0, "the folder is in the artifact section");
  assert.ok(folder < bar.indexOf("artifacts.length === 0 ?"), "BEFORE the artifact tree — there even without artifacts");
  assert.match(bar, /<OutputsWindow chatId=\{activeId\} onJump=\{\(\) => openRightSidebar\("artifacts"\)\} \/>/);
  assert.ok(bar.indexOf("<OutputsWindow") > bar.lastIndexOf("</AnimatedSwitch>"), "the window hangs outside the section switch");
  const bubble = withoutComments(read("components", "chat", "ChatBubbleRow.tsx"));
  assert.match(bubble, /useOutputsReferences\(chatId, text,/);
  assert.match(bubble, /<MarkdownReferenceContext\.Provider value=\{references\}>\s*<AssistantBlocks /, "assistant text gets the context");
  const api = read("lib", "api", "outputs.ts");
  assert.match(api, /\/api\/chats\/\$\{chatId\}\/outputs`/);
  assert.match(api, /\/api\/chats\/\$\{chatId\}\/outputs\/file\?path=/);
  const server = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "chats", "outputs-routes.js"), "utf8");
  assert.match(server, /sub === "\/outputs"/);
  assert.match(server, /sub === "\/outputs\/file"/);
  assert.match(server, /searchParams\.get\("path"\)/);
  // iOS: the same routes and the row in the artifacts sheet (in BOTH branches — with and without artifacts).
  const ios = (...t) => fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", ...t), "utf8");
  const swift = ios("Chat", "ChatOutputs.swift");
  assert.match(swift, /"\/api\/chats\/\\\(chat\.id\)\/outputs"/);
  assert.match(swift, /"\/api\/chats\/\\\(chat\.id\)\/outputs\/file"/);
  assert.match(swift, /URLQueryItem\(name: "path"/);
  assert.equal((ios("Chat", "ChatArtifactSheets.swift").match(/OutputsEntryPoint\(model: model\)/g) || []).length, 2);
});

test("(e) download: file rows, real folder rows and the Outputs row link a download that shows on hover", () => {
  const view = withoutComments(read("components", "chat", "OutputsFolder.tsx"));
  const link = view.slice(view.indexOf("const DownloadLink"), view.indexOf("const ROW"));
  assert.match(link, /<a href=\{href\} download=""/, "an anchor: the browser streams to disk");
  assert.match(link, /opacity-0/);
  assert.match(link, /group-hover:opacity-100/, "shows on hover of the row");
  assert.match(link, /pointer-coarse:opacity-100/, "always visible without hover");
  assert.match(view, /const ROW = "group /, "the row is the hover group");
  // Folder rows: the real path (key without the trailing slash), never the virtual "Internal" node.
  const folderRow = view.slice(view.indexOf('if (k.kind === "folder")'), view.indexOf("const selected"));
  assert.match(folderRow, /\{k\.key !== INTERNAL_KEY && \(\s*<DownloadLink href=\{outputFolderUrl\(chatId, k\.key\.replace\(\/\\\/\$\/, ""\)\)\} label=\{t\("Download as ZIP"\)\} \/>/);
  const fileRow = view.slice(view.indexOf("const selected"), view.indexOf("const list = state.list"));
  assert.match(fileRow, /<DownloadLink href=\{outputUrl\(chatId, k\.entry\.path\)\} label=\{t\("Download"\)\} \/>/);
  assert.match(view, /<DownloadLink href=\{outputFolderUrl\(chatId, ""\)\} label=\{t\("Download all as ZIP"\)\} \/>/, "the whole location");
  assert.equal(A.INTERNAL_KEY.endsWith("/"), false, "the virtual node's key is no folder path");
  // The client's route is the server's.
  const api = read("lib", "api", "outputs.ts");
  assert.match(api, /\/api\/chats\/\$\{chatId\}\/outputs\/folder\?path=\$\{encodeURIComponent\(path\)\}/);
  const server = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "chats", "outputs-routes.js"), "utf8");
  assert.match(server, /sub === "\/outputs\/folder"/);
  // iOS: the folder level carries the ZIP download over the same route (not on the virtual "Internal" level).
  const swift = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatOutputs.swift"), "utf8");
  assert.match(swift, /"\/api\/chats\/\\\(chat\.id\)\/outputs\/folder"/);
  assert.match(swift, /front: path, withInternal: false,\s*zipPath: String\(path\.dropLast\(\)\)\)/);
  assert.match(swift, /title: L\("Internal"\), entries: es, front: "", withInternal: false\)/, "the Internal level has no zipPath");
  const de = read("lib", "i18n-de.ts");
  for (const key of ["Download", "Download as ZIP", "Download all as ZIP"]) assert.match(de, new RegExp(`^  "${key}": "`, "m"), `German for ${key}`);
});
