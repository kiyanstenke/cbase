// Dropping a FOLDER into the chat — without a browser.
//
// The bug: a folder dropped on the chat (attachments), on the artifact list or on the folder context arrived as ONE pseudo-file in
// `DataTransfer.files` (the folder itself, unreadable). The upload handed it to `fetch` as the body, the browser failed while reading
// it, and the user saw "Upload failed: Failed to fetch" — no request ever reached the server.
//
// Two kinds in one file:
//   1. PURE LOGIC: `src/lib/drop-files.ts` is compiled with the local tsc and run against fake entries (a folder with subfolders,
//      readEntries in batches, a name with an ellipsis and dots) — `droppedFiles` walks folders into relative paths, falls back to
//      the plain list without entries, `filesOf` tells a DataTransfer from a list, and `readableFile` names an unreadable file.
//   2. BINDINGS by path: every drop target hands the DataTransfer itself to its upload function (not `.files`), every upload
//      function takes its files through `filesOf` BEFORE its first await and reads each through `readableFile` before `api(`, and
//      project-upload.ts takes the walker from drop-files.ts instead of keeping a second copy.
//
// Counter-test (which sabotage turns which test red): `if (e.isDirectory) return;` in filesOfEntries turns "walks a dropped folder"
// red; `readEntries` read once instead of to the empty batch turns it red; a `catch {}` that returns the file in readableFile turns
// "names an unreadable file" red; `uploadArtifacts(e.dataTransfer.files)` back in ChatRightSidebar turns "drop targets" red; an
// `await` before `filesOf(` in addFiles turns "before the first await" red; deleting `readableFile(` from uploadContext turns
// "readableFile before api" red.
//
// Run:  node --test web/test/drop-files.test.mjs
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
const read = (rel) => fs.readFileSync(path.resolve(webDir, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-drop-files-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "drop-files.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--lib", "es2022,dom",
], { stdio: "pipe" });
const { droppedFiles, filesOf, filesOfList, readableFile, UnreadableFile } = await import(pathToFileURL(path.join(out, "drop-files.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// ── Fakes of the entries API ─────────────────────────────────────────────────────────────────────────────────────────

const fileEntry = (name, body = name) => ({ name, isFile: true, isDirectory: false, file: (ok) => ok(new File([body], name)) });
// readEntries delivers at most two children per call, like Chrome's batches of 100: a walker that reads once loses the rest.
const dirEntry = (name, children) => ({
  name, isFile: false, isDirectory: true,
  createReader() { let i = 0; return { readEntries(ok) { const part = children.slice(i, i + 2); i += part.length; ok(part); } }; },
});
// The pseudo-file Chrome puts into `files` for a dropped folder: listed, but reading it fails.
const folderPseudoFile = (name) => {
  const f = new File([], name);
  Object.defineProperty(f, "slice", { value: () => ({ arrayBuffer: () => Promise.reject(new DOMException("unreadable", "NotFoundError")) }) });
  return f;
};
const transfer = ({ entries = null, files = [] }) => ({
  getData: () => "",
  files,
  items: entries === null ? undefined : entries.map((e) => ({ kind: "file", webkitGetAsEntry: () => e })),
});

// Shaped like the folder that failed: loose files, a zip, two subfolders, a name with "…" followed by two dots.
const odd = "ASTM B 422 Alloy…..pdf";
const drop = () => transfer({
  entries: [dirEntry("OneDrive_1", [
    fileEntry("po.pdf"), fileEntry("bundle.zip"),
    dirEntry("Normen", [fileEntry(odd)]),
    dirEntry("Spezifikationen", [fileEntry("a.pdf"), fileEntry("b.pdf"), fileEntry("c.pdf")]),
  ])],
  files: [folderPseudoFile("OneDrive_1")],
});

test("droppedFiles walks a dropped folder into its files with paths relative to the drop", async (t) => {
  const got = await droppedFiles(drop());
  const rels = got.map((d) => d.rel).sort();
  t.diagnostic(`files: ${rels.length}`);
  assert.deepEqual(rels, [
    "OneDrive_1/Normen/" + odd, "OneDrive_1/Spezifikationen/a.pdf", "OneDrive_1/Spezifikationen/b.pdf",
    "OneDrive_1/Spezifikationen/c.pdf", "OneDrive_1/bundle.zip", "OneDrive_1/po.pdf",
  ]);
  for (const d of got) assert.ok(d.file instanceof File && d.file.size > 0, `${d.rel} is a real, readable file`);
});

test("droppedFiles: loose files and folders mixed; without the entries API the plain list is the fallback", async () => {
  const mixed = await droppedFiles(transfer({ entries: [fileEntry("x.txt"), dirEntry("d", [fileEntry("y.txt")])] }));
  assert.deepEqual(mixed.map((d) => d.rel), ["x.txt", "d/y.txt"]);
  const plain = await droppedFiles(transfer({ files: [new File(["1"], "one.txt")] }));
  assert.deepEqual(plain.map((d) => d.rel), ["one.txt"]);
});

test("filesOf tells a DataTransfer from a picked list; a folder picker keeps webkitRelativePath", async () => {
  const fromDrop = await filesOf(drop());
  assert.equal(fromDrop.length, 6, "a DataTransfer is walked");
  const picked = new File(["1"], "a.pdf");
  Object.defineProperty(picked, "webkitRelativePath", { value: "Folder/a.pdf" });
  assert.deepEqual((await filesOf([picked, new File(["2"], "b.pdf")])).map((d) => d.rel), ["Folder/a.pdf", "b.pdf"]);
  assert.deepEqual(filesOfList([new File(["2"], "b.pdf")]).map((d) => d.rel), ["b.pdf"]);
});

test("readableFile names an unreadable file instead of letting fetch fail; readable and empty files pass", async () => {
  const describe = (rel) => `cannot read ${rel}`;
  await assert.rejects(readableFile({ rel: "OneDrive_1", file: folderPseudoFile("OneDrive_1") }, describe), (e) => {
    assert.ok(e instanceof UnreadableFile);
    assert.equal(e.message, "cannot read OneDrive_1");
    assert.equal(e.rel, "OneDrive_1");
    return true;
  });
  const ok = new File(["pdf"], "a.pdf");
  assert.equal(await readableFile({ rel: "a.pdf", file: ok }, describe), ok);
  const empty = new File([], "empty.txt");
  assert.equal(await readableFile({ rel: "empty.txt", file: empty }, describe), empty);
});

// ── Bindings by path ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The body of `async function <name>(` up to its matching closing brace. Throws when the declaration is missing. */
function bodyOf(src, name, where) {
  const at = src.indexOf(`async function ${name}(`);
  if (at < 0) throw new Error(`anchor: "async function ${name}(" not found in ${where} — adjust the anchor, do not delete the test`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`anchor: body of ${name} in ${where} not closed`);
}

const uploads = [
  { file: "src/components/chat/ChatPane.tsx", fn: "addFiles" },
  { file: "src/components/chat/ChatRightSidebar.tsx", fn: "uploadArtifacts" },
  { file: "src/components/ChatFolderView.tsx", fn: "uploadContext" },
];
const drops = [
  { file: "src/components/chat/ChatStage.tsx", call: "addFiles(e.dataTransfer)" },
  { file: "src/components/chat/ChatRightSidebar.tsx", call: "uploadArtifacts(e.dataTransfer)" },
  { file: "src/components/ChatFolderView.tsx", call: "uploadContext(e.dataTransfer)" },
];

test("drop targets hand the DataTransfer itself to the upload, never its .files", () => {
  for (const d of drops) {
    const src = stripComments(read(d.file));
    assert.ok(src.includes(d.call), `${d.file}: ${d.call} — the drop must reach filesOf whole (anchor; adjust, do not delete)`);
    assert.doesNotMatch(src, /(addFiles|uploadArtifacts|uploadContext)\(e\.dataTransfer\.files\)/, `${d.file}: an upload with .files loses dropped folders`);
  }
});

test("every upload takes its files through filesOf before the first await", () => {
  for (const u of uploads) {
    const body = stripComments(bodyOf(read(u.file), u.fn, u.file));
    const call = body.indexOf("filesOf(source)");
    assert.ok(call >= 0, `${u.file} ${u.fn}: filesOf(source) missing`);
    const firstAwait = body.indexOf("await ");
    assert.ok(firstAwait < 0 || call < firstAwait, `${u.file} ${u.fn}: filesOf must run before the first await (the drop's entries are gone afterwards)`);
  }
});

test("every upload reads each file through readableFile before api(", () => {
  for (const u of uploads) {
    const body = stripComments(bodyOf(read(u.file), u.fn, u.file));
    const probe = body.indexOf("readableFile(");
    const send = body.indexOf("api<");
    assert.ok(send >= 0, `${u.file} ${u.fn}: anchor api< not found (adjust, do not delete)`);
    assert.ok(probe >= 0 && probe < send, `${u.file} ${u.fn}: readableFile( must come before api(`);
  }
});

test("project-upload.ts takes the walker from drop-files.ts, no second copy", () => {
  const src = stripComments(read("src/lib/project-upload.ts"));
  assert.match(src, /from "@\/lib\/drop-files"/, "project-upload imports drop-files");
  assert.doesNotMatch(src, /createReader\(|webkitGetAsEntry/, "no own walker in project-upload.ts");
});
