// The archive in the web — without a browser.
//
// Two kinds in one file, as in chat-bar.test.mjs:
//   1. PURE LOGIC: `src/lib/archive.ts` is compiled with the local tsc and executed — the groups of the archive view
//      (`archiveGroups`), its search (`archiveSearch`) and the hint on the menu entry (`archiveHint`).
//   2. BINDINGS by path: the callers call these computations and none of their own (ChatPane: `?chat=` and the preselection
//      through `openTarget`), the bar stands in the child slot of the stage IN THE SAME expression as the composer, the stage
//      accepts nothing when archived (drop, project choice, "ask question"), `loadArchiveChat` says "does not exist" only on
//      404 — and the event name `"chat_archive"` stands the same at all three places (server, coding hook, and the iOS shell
//      `AppState.handleGlobalEvent`).
//
// Why the bindings: no type error reports any of them. A `list[0]` back in the reducer would let the 15 s tick replace the open
// archived conversation by the oldest again; a `chat_archive` in the hook would let the second window silently keep the
// composer.
//
// Counter-test (which sabotage turns which test red): deleting the archive branch turns two cases red; reversing the sort in
// `archiveGroups` turns it red; `locked` taken from `terminals` instead of `open` turns it red; `onlyQuestion` at "contains"
// turns it red; deleting `!archived` from `onDrop` turns it red; `chat_archive` in chatArchive.ts turns it red; `saved &&
// list.some(…)` before `openTarget` turns it red (the first version considered that green).
//
// Section 3: the numbers of the questions come from the SERVER and a missing number is never 0 (`folderDeleteQuestion`,
// `contextFilesSentence`, `archiveShellQuestion`), `archiveTargetMatches` checks the project only for the preselection, the task
// banner ticks nothing off in the archive, a deleted folder lets go of its open conversation (`CHATS_DELETED`), and the watches of
// the right bar stand.
//
// Section 4: the FLOWS of the questions stand as pure functions in lib/archive.ts and run here with injected effects — three
// sabotages that used to stay green in the gate (a catch with guessed folder numbers, a guessed precheck `{ open: [], terminals: 0 }`
// or `vp ?? { terminals: 0 }`, a reversed filter of the deleted ids) are now red — in the function through the unit, in the
// component through the binding (the API ways go in UNWRAPPED). Plus: the last click wins (`lastWins` + `openTargetProcedure`),
// the re-check of an open archived chat (`recheckArchive`).
//
// Run:  node --test web/test/archive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.resolve(webDir, rel), "utf8");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-archive-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "archive.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const {
  archiveGroups, archiveSearch, archiveHint,
  folderDeleteQuestion, contextFilesSentence, archiveShellQuestion, archiveTargetMatches, CHATS_DELETED,
  loadPrecheck, archiveProcedure, deletedIds, folderPermanentlyProcedure, lastWins, openTargetProcedure,
  recheckArchive, archiveDays, archiveRowLabel, AUTO_ARCHIVE_DAYS,
  autoArchiveStorage, archiveEventImmediately, bundler, ARCHIVE_BUNDLE_MS,
} = await import(pathToFileURL(path.join(out, "archive.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// ── 1. Pure logic ────────────────────────────────────────────────────────────────────────────────

const FOLDER = [
  { id: "fa", name: "Old archived", archivedAt: 100 },
  { id: "fb", name: "New archived", archivedAt: 300 },
  { id: "fl", name: "Empty archived", archivedAt: 200 },
  { id: "fx", name: "Active folder", archivedAt: null },
];
const CHATS = [
  { id: "a1", title: "One", folderId: "fa", archivedAt: 110, pinned: true },
  { id: "a2", title: "Two", folderId: "fa", archivedAt: 150 },
  { id: "b1", title: "Three", folderId: "fb", archivedAt: 310 },
  { id: "l1", title: "Loose old", folderId: null, archivedAt: 50, pinned: true },
  { id: "l2", title: "Loose new", folderId: null, archivedAt: 500 },
  { id: "x1", title: "In active folder", folderId: "fx", archivedAt: 400 },
  { id: "u1", title: "Folder unknown", folderId: "way", archivedAt: 450 },
];

test("archiveGroups: archived folders first (most recently archived on top, empty ones too), per group archivedAt DESC, pinned without effect; loose ones with the name of the active folder", () => {
  const g = archiveGroups(CHATS, FOLDER);
  assert.deepEqual(g.folder.map((x) => x.folder.id), ["fb", "fl", "fa"], "folders by archivedAt DESC; the empty archived one stays");
  assert.deepEqual(g.folder.find((x) => x.folder.id === "fa").chats.map((c) => c.id), ["a2", "a1"], "in the folder most recently archived first — the pinned a1 does NOT move up");
  assert.deepEqual(g.folder.find((x) => x.folder.id === "fl").chats, []);
  assert.deepEqual(g.loose.map((l) => l.chat.id), ["l2", "u1", "x1", "l1"], "loose ones by archivedAt DESC, pinned does not count");
  assert.equal(g.loose.find((l) => l.chat.id === "x1").label, "Active folder", "the active folder is the label");
  assert.equal(g.loose.find((l) => l.chat.id === "u1").label, "", "an unknown folder gives no label");
  assert.equal(g.loose.find((l) => l.chat.id === "l2").label, "");
  assert.ok(!g.loose.some((l) => ["a1", "a2", "b1"].includes(l.chat.id)), "chats of an archived folder stand only in its group");
  assert.deepEqual(archiveGroups([], []), { folder: [], loose: [] });
});

test("archiveSearch: title and folder name, case-insensitive; a hit on the folder keeps the whole group, otherwise only the hits; an empty search changes nothing", () => {
  const g = archiveGroups(CHATS, FOLDER);
  assert.equal(archiveSearch("", g), g);
  assert.equal(archiveSearch("   ", g), g);
  const folderHits = archiveSearch("OLD ARCH", g);
  assert.deepEqual(folderHits.folder.map((x) => x.folder.id), ["fa"]);
  assert.deepEqual(folderHits.folder[0].chats.map((c) => c.id), ["a2", "a1"], "folder name hits ⇒ all its chats");
  const title = archiveSearch("three", g);
  assert.deepEqual(title.folder.map((x) => x.folder.id), ["fb"]);
  assert.deepEqual(title.folder[0].chats.map((c) => c.id), ["b1"]);
  assert.deepEqual(title.loose, []);
  const label = archiveSearch("active", g);
  assert.deepEqual(label.loose.map((l) => l.chat.id), ["x1"], "a loose chat hits through its folder's label");
  assert.deepEqual(archiveSearch("loose", g).loose.map((l) => l.chat.id), ["l2", "l1"]);
  assert.deepEqual(archiveSearch("does not exist", g), { folder: [], loose: [] });
});

test("archiveHint: locked exactly with open work (not with shells); onlyQuestion exactly with [question]; shell sentence singular/plural, none at 0; server texts unchanged", () => {
  const rf = { reason: "question", text: "A question is waiting for an answer" };
  const ws = { reason: "queue", text: "2 messages are waiting in the queue" };
  const rowLine = { reason: "waitRow", text: "Waiting at the limit for continuation" };
  assert.deepEqual(archiveHint(null), { locked: false, onlyQuestion: false, rows: [], shells: "" }, "without a precheck open — the PUT checks itself");
  assert.deepEqual(archiveHint({ open: [], terminals: 0 }), { locked: false, onlyQuestion: false, rows: [], shells: "" });
  const onlyShells = archiveHint({ open: [], terminals: 2 });
  assert.equal(onlyShells.locked, false, "open shells do not lock — they are ended");
  assert.equal(onlyShells.shells, "Ends 2 open shells");
  assert.equal(archiveHint({ open: [], terminals: 1 }).shells, "Ends 1 open shell");
  const onlyRf = archiveHint({ open: [rf], terminals: 0 });
  assert.equal(onlyRf.locked, true);
  assert.equal(onlyRf.onlyQuestion, true, "the question is the ONLY reason");
  assert.deepEqual(onlyRf.rows, [rf.text], "the server's text, unchanged");
  const both = archiveHint({ open: [rf, ws], terminals: 0 });
  assert.equal(both.locked, true);
  assert.equal(both.onlyQuestion, false, "question AND queue ⇒ no discarding");
  assert.deepEqual(both.rows, [rf.text, ws.text]);
  assert.equal(archiveHint({ open: [rowLine], terminals: 3 }).onlyQuestion, false);
  // The folder precheck: per locked chat a row with title; never "only question" (the folder PUT knows no discarding).
  const folder = archiveHint({ open: [{ chatId: "c1", title: "Build", open: [rf] }, { chatId: "c2", title: "", open: [rowLine, ws] }], terminals: 0 });
  assert.equal(folder.locked, true);
  assert.equal(folder.onlyQuestion, false);
  assert.deepEqual(folder.rows, [`Build: ${rf.text}`, `Untitled: ${rowLine.text} · ${ws.text}`]);
  // The translation goes only through the passed-in t.
  const en = archiveHint({ open: [], terminals: 4 }, (s, p) => (s === "Ends {n} open shells" ? `Ends ${p.n} open shells` : s));
  assert.equal(en.shells, "Ends 4 open shells");
});

// ── 2. Bindings by path ─────────────────────────────────────────────────────────────────────────

const withoutComments = (q) => q.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const pane = read("src/components/chat/ChatPane.tsx");
const stage = read("src/components/chat/ChatStage.tsx");
const hook = read("src/components/chat/chatArchive.ts");
const apiArchive = read("src/lib/api/archive.ts");

test("ChatPane: ?chat= and the preselection go through openTarget — no list.some/list.find any more; the bar stands in the same expression as the composer in the stage's child slot", () => {
  const code = withoutComments(pane);
  assert.ok(!code.includes("wanted && list.some("), "?chat= no longer only from the list");
  assert.ok(!code.includes("list.find((x) => x.id === saved)"), "the preselection no longer only from the list");
  const effect = code.slice(code.indexOf("loadList()\n      .then(async (list) => {"), code.indexOf("}, [loadList]);"));
  // Three ways: `onlyChat` (coding → scheduled — exactly this chat, before all others and without a project check), `?chat=` and
  // the preselection.
  assert.equal([...effect.matchAll(/openTarget\(/g)].length, 3, "all three ways call openTarget");
  assert.ok(effect.includes("if (onlyChat) return void (await openTarget(onlyChat, list, { projectCheck: false, openOtherwise: true }));"), "onlyChat opens through openTarget, conditioned only by the id");
  // No prefilter from the list before it, in no form: a `saved && list.some(…)` before the call left the first version of this
  // test green — the condition of a way is the id alone.
  assert.ok(!/list\.(some|find)\(/.test(effect), "in the open effect nobody checks the list before openTarget");
  // The address does NOT check the project (as for an active chat) — only the preselection does.
  assert.ok(effect.includes("if (wanted && (await openTarget(wanted, list, { projectCheck: false })))"), "?chat= opens through openTarget, conditioned only by the id, without a project check");
  assert.ok(/if \(saved\) await openTarget\(saved, list\.filter\([^\n]*\)\);/.test(effect), "the preselection opens through openTarget, conditioned only by the id — with the default (project checked)");
  assert.ok(code.includes("= useArchive({"), "the hook stands in ChatPane");
  const start = pane.lastIndexOf("<ChatStage");
  const children = pane.slice(pane.indexOf("\n      >", start), pane.indexOf("</ChatStage>", start));
  const expression = children.slice(children.indexOf("{archived ? <ArchiveBar"));
  assert.ok(expression.length > 0 && expression.indexOf("<ChatComposer") > 0, "`{archived ? <ArchiveBar … : (<ChatComposer …)}` in the child slot");
  assert.ok(expression.trimEnd().endsWith(")}"), "the expression closes before </ChatStage>");
  assert.ok(!pane.slice(pane.indexOf("</ChatStage>")).includes("<ArchiveBar"), "no bar outside the stage");
});

test("ChatStage: when archived the stage accepts nothing — onDragOver/onDrop check it, project choice and \"ask question\" depend on it", () => {
  const over = stage.slice(stage.indexOf("onDragOver={(e) => {"), stage.indexOf("}}", stage.indexOf("onDragOver={(e) => {")));
  assert.ok(over.includes("!archived"), "onDragOver raises the drop flag only if not archived");
  const drop = stage.slice(stage.indexOf("onDrop={(e) => {"), stage.indexOf("}}", stage.indexOf("onDrop={(e) => {")));
  const hold = drop.indexOf("if (archived) return;");
  assert.ok(hold > 0 && hold < drop.indexOf("addFiles("), "onDrop returns when archived BEFORE addFiles");
  // The entry cards are gone; in their place the project choice hangs below the field on the archive.
  assert.ok(stage.includes("{empty && !archived && (\n          <div className=\"cb-strip-bottom"), "the project choice depends on !archived");
  assert.ok(stage.includes("onAsk={archived ? undefined : askAboutSelection}"), "\"ask question\" is missing in the archive");
  assert.ok(stage.includes("{activeId && !archived && (\n          <ComposerBase"), "no strip base in the archive");
});

test("loadArchiveChat: \"does not exist\" (null) ONLY on 404 — every other error throws", () => {
  const f = apiArchive.slice(apiArchive.indexOf("export async function loadArchiveChat"), apiArchive.indexOf("\n}\n", apiArchive.indexOf("export async function loadArchiveChat")));
  assert.ok(f.includes("if (r.status === 404) return null;"), "404 ⇒ null");
  assert.ok(f.includes("if (!r.ok) throw"), "otherwise it throws");
  assert.equal([...f.matchAll(/return null/g)].length, 1, "no second null way");
});

test("Event name: \"chat_archive\" as a literal on the server, in the coding hook and in the iOS shell", () => {
  // Swift: the ONE branch in `handleGlobalEvent` — coding list and open conversations read only the counter afterwards.
  // A `chat_archive` there would let the iPhone silently keep the composer of a chat that another window archived.
  const appState = fs.readFileSync(path.join(repo, "mobile/CbaseMobile/Models/AppState.swift"), "utf8");
  const locations = {
    "server/backend/electron/server/runs/archive.js": fs.readFileSync(path.join(repo, "server/backend/electron/server/runs/archive.js"), "utf8"),
    "web/src/components/chat/chatArchive.ts": hook,
    "mobile/CbaseMobile/Models/AppState.swift": appState,
  };
  for (const [location, q] of Object.entries(locations)) assert.ok(q.includes('"chat_archive"'), `${location} carries "chat_archive"`);
  assert.ok(locations["server/backend/electron/server/runs/archive.js"].includes('type: "chat_archive"'), "the server SENDS this name");
  assert.ok(hook.includes('m.type !== "chat_archive"'), "the web client listens for exactly it");
  assert.ok(/\btype\s*==\s*"chat_archive"/.test(appState), "AppState.handleGlobalEvent does not listen for exactly it (`type == \"chat_archive\"`)");
});

// ── 3. Numbers from the server, unknown is not 0 ─────────────────────────────────

test("folderDeleteQuestion: the number is the SERVER's, not that of the filtered group; verb by number; unknown context files without a number; unknown chats ⇒ no question", () => {
  // The case of the finding: folder "Customer Smith" with three archived chats, "invoice" is searched — the view's group carries
  // ONE chat, the server deletes three. The question computes only with what the server names.
  const folder = [{ id: "F", name: "Customer Smith", archivedAt: 10 }];
  const chats = [
    { id: "r", title: "Invoice March", folderId: "F", archivedAt: 11 },
    { id: "v", title: "Contract", folderId: "F", archivedAt: 12 },
    { id: "a", title: "Offer", folderId: "F", archivedAt: 13 },
  ];
  const filtered = archiveSearch("invoice", archiveGroups(chats, folder));
  assert.equal(filtered.folder[0].chats.length, 1, "the row may count the search hits");
  assert.equal(folderDeleteQuestion({ chats: 3, contextFiles: 2 }, "Customer Smith"),
    "Delete folder \"Customer Smith\" permanently? 3 chats and 2 context files will be lost.");
  assert.equal(folderDeleteQuestion({ chats: 1, contextFiles: 0 }, "X"), "Delete folder \"X\" permanently? 1 chat will be lost.##one", "singular: \"goes\"");
  assert.equal(folderDeleteQuestion({ chats: 2, contextFiles: 0 }, "X"), "Delete folder \"X\" permanently? 2 chats will be lost.");
  assert.equal(folderDeleteQuestion({ chats: 1, contextFiles: 1 }, "X"), "Delete folder \"X\" permanently? 1 chat and 1 context file will be lost.", "with context files the subject is plural");
  // Empty is not unknown: a missing number of context files does not become "none".
  for (const k of [undefined, null, "2", -1, 1.5]) {
    const text = folderDeleteQuestion({ chats: 3, contextFiles: k }, "X");
    assert.equal(text, "Delete folder \"X\" permanently? 3 chats and all of the folder's context files will be lost (number unknown).", `contextFiles=${JSON.stringify(k)}`);
  }
  // Without the number of chats nobody asks — and nothing is deleted then (ArchiveView aborts).
  for (const z of [null, undefined, {}, { chats: "3" }, { chats: null, contextFiles: 0 }]) {
    assert.equal(folderDeleteQuestion(z, "X"), null, `without a chat number no question: ${JSON.stringify(z)}`);
  }
  const en = folderDeleteQuestion({ chats: 1, contextFiles: 0 }, "X", (s, p) => (s === "1 chat" ? "1 Chat" : s.replace(/\{(\w+)\}/g, (m, k) => String(p?.[k] ?? m))));
  assert.equal(en, "Delete folder \"X\" permanently? 1 Chat will be lost.##one", "the translation goes through the passed-in t");
});

test("contextFilesSentence: 0 ⇒ no sentence; 1/n with a number; unknown ⇒ the sentence without a number, never the silence of a 0", () => {
  assert.equal(contextFilesSentence(0), "");
  assert.equal(contextFilesSentence(1), "The folder's 1 context file will be deleted.");
  assert.equal(contextFilesSentence(3), "The folder's 3 context files will be deleted.");
  for (const k of [null, undefined, "0", NaN]) assert.equal(contextFilesSentence(k), "All of the folder's context files will be deleted (number unknown).", JSON.stringify(k));
});

test("archiveShellQuestion: reported 0 ⇒ no question; failed precheck or missing number ⇒ question without a number; otherwise with a number", () => {
  assert.equal(archiveShellQuestion({ terminals: 0 }), null, "only a REPORTED 0 does not ask");
  assert.equal(archiveShellQuestion({ open: [], terminals: 0 }), null);
  assert.equal(archiveShellQuestion({ terminals: 1 }), "Archive? 1 open shell will be ended.");
  assert.equal(archiveShellQuestion({ terminals: 3 }), "Archive? 3 open shells will be ended.");
  const unknown = "Archive? Open shells could not be checked — any open shell will be ended.";
  for (const v of [null, undefined, {}, { terminals: null }, { terminals: "2" }]) assert.equal(archiveShellQuestion(v), unknown, JSON.stringify(v));
});

test("archiveTargetMatches: archived, kind normal, same workspace — the project only if one is passed", () => {
  const c = { archivedAt: 5, kind: "normal", workspaceId: "w", projectId: "B" };
  assert.equal(archiveTargetMatches(c, { wsId: "w", project: null }), true, "address/event: any project, as for an active chat");
  assert.equal(archiveTargetMatches(c, { wsId: "w", project: "B" }), true);
  assert.equal(archiveTargetMatches(c, { wsId: "w", project: "A" }), false, "the preselection in the entered project A opens no chat from B");
  assert.equal(archiveTargetMatches({ ...c, kind: undefined }, { wsId: "w", project: null }), true, "without kind normal counts");
  assert.equal(archiveTargetMatches({ ...c, kind: "manager" }, { wsId: "w", project: null }), false);
  assert.equal(archiveTargetMatches({ ...c, workspaceId: "x" }, { wsId: "w", project: null }), false);
  assert.equal(archiveTargetMatches({ ...c, archivedAt: null }, { wsId: "w", project: null }), false, "an active chat outside the list is no archive target");
  assert.equal(archiveTargetMatches(null, { wsId: "w", project: null }), false);
});

const withoutK = (q) => withoutComments(q);
const bodyOf = (q, header, end = "\n  }\n") => {
  const i = q.indexOf(header);
  assert.ok(i >= 0, `not found: ${header}`);
  return q.slice(i, q.indexOf(end, i) + end.length);
};
const view = read("src/components/ArchiveView.tsx");
const entry = read("src/components/ArchiveEntry.tsx");
const list = read("src/components/chat/ChatListPane.tsx");
const bar = read("src/components/chat/ChatRightSidebar.tsx");
const channel = read("src/components/ChannelSidebar.tsx");

test("ArchiveView: the folder question runs through folderPermanentlyProcedure — the numbers go in UNWRAPPED from the server's precheck, the folder row passes no number, and without a number nothing is deleted", () => {
  const code = withoutK(view);
  assert.ok(code.includes("void deleteFolder(o); }"), "the folder row calls deleteFolder(o) — without the (filtered) number of its group");
  assert.ok(!/deleteFolder\(o, /.test(code), "no number from the row into the question");
  const f = bodyOf(code, "async function deleteFolder(o: ChatFolder) {");
  assert.ok(f.includes("r = await folderPermanentlyProcedure(o, {"), "the flow stands in lib/archive.ts");
  // The API ways UNWRAPPED — a `(id) => folderArchivePrecheck(id).catch(() => ({ chats: 0, … }))` here would be the guessed
  // number again, only one line deeper.
  assert.ok(f.includes("counts: folderArchivePrecheck,"), "counts: the server's precheck, unwrapped");
  assert.ok(f.includes("erase: deleteFolderPermanently,"), "erase: the DELETE, unwrapped");
  assert.ok(f.includes("prior: () => (raw.current?.chats ?? []).filter((c) => c.folderId === o.id).map((c) => c.id),"), "prior: from the UNFILTERED state (no search, no project)");
  assert.ok(f.includes("loadAgain: load,"), "loadAgain: the archive, which yields `null` when it fails");
  const untilProcedure = f.slice(0, f.indexOf("r = await folderPermanentlyProcedure("));
  assert.ok(!/folderArchivePrecheck\(|folderDeleteQuestion\(|\bchats\s*:|contextFiles\s*:/.test(f), "no count of its own, no question of its own, no number as a literal in deleteFolder");
  assert.ok(!/catch/.test(untilProcedure) && [...f.matchAll(/catch/g)].length === 1, "exactly one catch — the one around the whole flow (a DELETE error is shown)");
  const afterCatch = f.slice(f.indexOf("catch (e)"), f.indexOf("\n", f.indexOf("catch (e)")));
  assert.equal(afterCatch.trim(), "catch (e) { setError((e as Error).message); return; }", "the catch shows the error and aborts — it guesses nothing");
  assert.ok(f.includes('if (r.status === "without-counts") {') && f.includes('if (r.status !== "deleted") return;'), "without numbers: message and nothing; aborted: nothing");
  assert.ok(!code.includes("catch(() => 0)"), "no guessed 0 in the archive view");
});

test("No caller guesses a 0 for the context files — `contextFileCount` is gone, resolving names the sentence from the server number", () => {
  const f = bodyOf(withoutK(list), "async function deleteFolder(folder: ChatFolder) {");
  assert.ok(f.includes("folderArchivePrecheck(folder.id).then((z) => z.contextFiles, () => null)"), "error ⇒ null (unknown), not 0");
  assert.ok(f.includes("contextFilesSentence(n, t)"), "the sentence comes from lib/archive.ts");
  for (const [location, q] of [["ChatListPane", list], ["ArchiveView", view], ["api/archive.ts", apiArchive]]) {
    assert.ok(!withoutK(q).includes("contextFileCount"), `${location}: contextFileCount is gone`);
  }
});

test("ArchiveEntry: the precheck loads through loadPrecheck (failed ⇒ null), `los` runs through archiveProcedure with the effect's promise — no substitute value for the precheck, nowhere in the file", () => {
  const code = withoutK(entry);
  const effect = code.slice(code.indexOf("useEffect(() => {"), code.indexOf("}, [target.kind, target.id]);"));
  assert.ok(effect.includes("loadPrecheck(() => archivePrecheck(target.id))") && effect.includes("loadPrecheck(() => folderArchivePrecheck(target.id))"),
    "both prechecks unwrapped in loadPrecheck");
  assert.ok(effect.includes("load.current = p;"), "the promise is the state `los` waits for");
  const f = bodyOf(code, "async function run(dismissQuestion: boolean) {");
  assert.ok(f.includes("archived = await archiveProcedure(load.current, {"), "`los` waits for the effect's state, without a substitute before it");
  // The two sabotages: a substitute in the effect (`.catch(() => ({ open: [], terminals: 0 }))`) or in `los`
  // (`vp ?? { terminals: 0 }`) — and any other form of a guessed precheck.
  assert.ok(!/\.catch\(/.test(code), "no .catch in ArchiveEntry — failed means null (loadPrecheck)");
  assert.ok(!/terminals\s*:/.test(code), "no `terminals:` as a value in ArchiveEntry");
  assert.ok(!/\?\?\s*[{(]/.test(code), "no `?? {…}` as a substitute for a precheck");
  assert.ok(!/\bvp\b/.test(f), "`los` does not read the rendered state — only the promise");
  assert.ok(f.indexOf("if (archived) after?.();") > f.indexOf("archiveProcedure("), "afterwards only after archiving");
});

test("ChatStage: no task banner any more — neither ticking off nor a jump into the ToDo tab", () => {
  const code = withoutK(stage);
  assert.ok(!/completeTodo|chatTodos|todosOpen/.test(code), "the stage carries a ToDo strip again");
  assert.ok(!code.includes("/todos/"), "the stage jumps into the ToDo tab");
});

test("openTarget runs through openTargetProcedure with a marker per call (lastWins), checks through archiveTargetMatches; cbase-open-chat takes the marker at the CLICK, the archive view goes through cbase-open-chat", () => {
  const h = withoutK(hook);
  const f = h.slice(h.indexOf("const openTarget = useCallback("), h.indexOf("}, []);", h.indexOf("const openTarget = useCallback(")));
  assert.ok(h.includes("const turns = useRef(lastWins());"), "ONE counter per hook, across all calls");
  const marker = f.indexOf("const marker = turns.current();"), procedure = f.indexOf("return openTargetProcedure(id, list, {");
  assert.ok(marker > 0 && marker < procedure && !/\bawait\b/.test(f.slice(0, procedure)), "the marker arises at the moment of the call, before any await");
  assert.ok(f.includes("applies: () => marker() && d.current.activeId === prior,"), "applies: the newest wish AND no other switch in between");
  assert.ok(f.includes("loadChat: loadArchiveChat, setMeta: setMeta, open: open, wsId,"), "the effects unwrapped");
  assert.ok(f.includes("project: opts.projectCheck === false ? null : focusProjectId, openOtherwise: opts.openOtherwise,"), "the rule (archiveTargetMatches) stands in lib/archive.ts, the project only for the preselection");
  assert.ok(!/\bopen\(|setMeta\(/.test(f), "openTarget does not switch by itself — only the flow, behind `applies()`");
  const code = withoutK(pane);
  const event = code.slice(code.indexOf("const onOpenChat = (e: Event) => {"), code.indexOf('window.addEventListener("cbase-open-chat", onOpenChat);'));
  // `loadList().then((list) => openTarget(…))` took the marker only AFTER the list fetch — if X's list came after Y's, X won.
  // The promise goes in, the marker applies from the click. The receiver passes the open chat along: a jump to it opens nothing
  // anew (lib/archive.ts `openTargetProcedure` with `openId`, run in web/test/jumps.test.mjs).
  assert.ok(event.includes("openTarget(chatId, loadList(), { projectCheck: false, openOtherwise: true, openId: activeIdRef.current, alreadyOpen: () => setFolderView(null) })"), "cbase-open-chat opens through openTarget, the list as a promise");
  assert.ok(!/\.then\(\(list\) => openTarget/.test(event), "no marker only after the list fetch");
  assert.ok(!/\bopen\(chatId\)/.test(event), "no direct open() any more in the event");
  const lq = withoutK(list);
  const viewCall = lq.slice(lq.indexOf("<ArchiveView"), lq.indexOf("/>", lq.indexOf("<ArchiveView")));
  assert.ok(viewCall.includes('onOpen={(id) => { window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: id })); }}'), "the archive view opens through cbase-open-chat");
  assert.ok(!/\bopen\(/.test(viewCall), "the archive view does not call open() directly");
});

test("After the permanent deletion the view reports the ids (CHATS_DELETED) BEFORE onChanged; coding calls chatAway (closes the open one)", () => {
  assert.equal(CHATS_DELETED, "cbase-chats-deleted");
  const f = bodyOf(withoutK(view), "async function deleteFolder(o: ChatFolder) {");
  const del = f.indexOf("r = await folderPermanentlyProcedure(o, {"), meld = f.indexOf("window.dispatchEvent(new CustomEvent<string[]>(CHATS_DELETED, { detail: r.ids }))"), fresh = f.indexOf("onChanged();");
  assert.ok(del > 0 && del < meld && meld < fresh, "delete → report (exactly the flow's ids, `r.ids`) → list anew");
  assert.ok(f.includes("prior: () => (raw.current?.chats ?? []).filter((c) => c.folderId === o.id).map((c) => c.id),"), "the ids from the UNFILTERED state (no search, no project)");
  assert.ok(!/\.filter\(\(id\)/.test(f), "no own computation of the deleted ids — `deletedIds` in lib/archive.ts");
  // Coding: the hook listens and calls chatAway; ChatPane passes chatAway in, and chatAway closes the open chat.
  const h = withoutK(hook);
  assert.ok(h.includes("window.addEventListener(CHATS_DELETED, onDeleted)") && h.includes("d.current.chatAway(id)"), "useArchive listens and calls chatAway per id");
  const code = withoutK(pane);
  assert.match(code, /= useArchive\(\{[^}]*\bchatAway\b[^}]*\}\);/, "ChatPane passes chatAway to useArchive");
  const way = bodyOf(code, "function chatAway(id: string) {");
  assert.ok(way.includes("if (activeIdRef.current === id) {") && way.includes("setActiveId(null);") && way.includes("dropChatCache(id);"), "chatAway closes the open chat and clears the cache");
  assert.ok(bodyOf(code, "async function deleteChat(chat: Chat) {").includes("chatAway(chat.id);"), "deleting ONE chat goes the same way");
});

test("ChatRightSidebar: in the archive no shell, no pasting, no uploading (button AND drag), no channel handles", () => {
  const q = withoutK(bar);
  // The shell stands in `terminalContent` — the same condition for the bar section AND the terminal tab in the main area
  // (portal), hence only ONE place.
  assert.ok(q.includes("const terminalContent = activeId && !archived ? (\n    <TerminalsPane"), "the shell only if not archived");
  assert.equal(q.split("<TerminalsPane").length - 1, 1, "the shell stands at exactly one place (bar and tab share it)");
  const block = q.slice(q.indexOf("{!archived && <>"), q.indexOf("</>}", q.indexOf("{!archived && <>")));
  assert.ok(block.includes("setTextDraftOpen((v) => !v)") && block.includes("uploadArtifacts(picked)"), "pasting and uploading stand in `{!archived && <>…</>}`");
  assert.ok(q.includes("{textDraftOpen && !archived && ("), "the paste form depends on !archived");
  const over = q.slice(q.indexOf("onDragOver={(e) => {"), q.indexOf("}}", q.indexOf("onDragOver={(e) => {")));
  const drop = q.slice(q.indexOf("onDrop={(e) => {"), q.indexOf("}}", q.indexOf("onDrop={(e) => {")));
  assert.ok(over.includes("if (archived ||"), "the drag does not raise the drop flag");
  assert.ok(drop.indexOf("if (archived ||") >= 0 && drop.indexOf("if (archived ||") < drop.indexOf("uploadArtifacts("), "dropping returns BEFORE the upload");
  // The upload ways of the UI: button and drag (bound above) — without the declaration and without the way through
  // saveTextArtifact, which stands only in the form behind `textDraftOpen && !archived`.
  assert.equal([...q.matchAll(/(?<!function )uploadArtifacts\((?!\[new File)/g)].length, 2, "exactly two upload ways of the UI, both bound above");
  const formPart = q.slice(q.indexOf("{textDraftOpen && !archived && ("), q.indexOf("</form>", q.indexOf("{textDraftOpen && !archived && (")));
  assert.ok(formPart.includes("saveTextArtifact()") && [...q.matchAll(/(?<!function )saveTextArtifact\(\)/g)].length === 1, "saving a text artifact only in the bound form");
  assert.match(q, /<ChannelSidebar [^>]*onlyRead=\{archived\}/, "the channel bar gets onlyRead");
  // The channel bar itself: every handle (`action(k, …)`) stands in the menu behind `!onlyRead` — the server has no
  // archive lock for /api/channels/*, this guard is the only one.
  const k = withoutK(channel);
  const menu = k.slice(k.indexOf("{k && controllable && !onlyRead && ("), k.indexOf("</Menu>", k.indexOf("{k && controllable && !onlyRead && (")));
  const all = [...k.matchAll(/action\(k, "/g)].length;
  assert.ok(all > 0 && [...menu.matchAll(/action\(k, "/g)].length === all, `all ${all} channel handles behind !onlyRead`);
});

// Agent communication: only the human reopens a channel in the channel bar — otherwise a closed ping-pong would separate two
// coding chats forever. The handle "open" stands in web and iOS ONLY at the state "closed" (never at "rejected", the inbox's
// decision), behind onlyRead, and the question on closing names the way back. Counter-test: ChannelSidebar.tsx or
// ChannelPane.swift in the old form turns it red.
test("Channel bar: a closed channel can be reopened — web and iOS, only \"closed\", never in the archive", () => {
  const k = withoutK(channel);
  assert.ok(k.includes('`/api/channels/${k.id}/open`'), "web calls POST /api/channels/:id/open");
  assert.ok(/k\.status === "closed" && <MenuEntry label=\{t\("Reopen"\)\}[^\n]*action\(k, "open"\)/.test(k), "\"Reopen\" only at status closed");
  assert.ok(k.includes('k.status === "closed" : false;'), "controllable includes \"closed\" (otherwise there would be no menu)");
  assert.ok(!k.includes('"rejected" : false') && !/rejected[^\n]*action\(k, "open"\)/.test(k), "\"rejected\" gets no way back");
  assert.ok(!k.includes("Afterwards neither of the two chats writes into it any more"), "the question on closing promises no forever");
  assert.ok(k.includes("until you reopen it here in the ⋯ menu"), "the question on closing names the way back");
  const ios = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChannelPane.swift"), "utf8");
  assert.ok(ios.includes('client.post("/api/channels/\\(id)/open")'), "iOS calls POST /api/channels/:id/open");
  const branch = ios.slice(ios.indexOf('if let channel, channel.status == "closed", !onlyRead {'), ios.indexOf("} else if let channel,"));
  assert.ok(branch.includes("model.open(channelId)") && !/\bpause\(/.test(branch) && !/\bclose\(/.test(branch), "iOS: at the closed channel exactly the one handle, behind !onlyRead");
  assert.equal([...ios.matchAll(/model\.open\(/g)].length, 1, "iOS: open only in this branch");
  assert.ok(ios.includes('channel.status != "rejected", !onlyRead {'), "iOS: the other handles also behind !onlyRead");
  assert.ok(ios.includes("until you reopen it here in the ⋯ menu"), "iOS: the question on closing names the way back");
  for (const file of [["Chat", "ChatView.swift"]]) {
    const q = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", ...file), "utf8");
    const button = q.slice(q.indexOf("ChatChannelsSheet("), q.indexOf(")", q.indexOf("ChatChannelsSheet(")));
    assert.ok(button.includes("onlyRead: model.archived"), `${file[1]}: the channels sheet gets onlyRead from the archive`);
  }
});

// ── 4. The flows as pure functions, with injected effects ──────────

// A log of the effects of a flow — the order is part of the promise.
function logValue() {
  const log = [];
  return {
    log,
    question: (response) => async (text) => { log.push(["question", text]); return response; },
    perform: (what, value) => async (...a) => { log.push([what, ...a]); return value; },
    throwing: (what, error) => async (...a) => { log.push([what, ...a]); throw error; },
  };
}
// A promise the test resolves from outside — so the answers arrive in the order the case needs.
function open() {
  let on;
  const p = new Promise((r) => { on = r; });
  return { p, on };
}

test("folderPermanentlyProcedure: server numbers → question → delete → deleted ids; if the number fetch fails, no question and NO deletion", async () => {
  // The normal case — and the order of the effects.
  const p = logValue();
  const r = await folderPermanentlyProcedure({ id: "F", name: "Customer Smith" }, {
    counts: p.perform("counts", { chats: 3, contextFiles: 1 }), question: p.question(true), erase: p.perform("erase"),
    prior: () => { p.log.push(["prior"]); return ["a", "b", "c"]; },
    loadAgain: p.perform("loadAgain", { chats: [{ id: "c" }, { id: "x" }] }),
  });
  assert.deepEqual(p.log.map((e) => e[0]), ["counts", "question", "prior", "erase", "loadAgain"], "numbers → question → prior → delete → reload");
  assert.equal(p.log[1][1], "Delete folder \"Customer Smith\" permanently? 3 chats and 1 context file will be lost.", "the SERVER's number in the question");
  assert.deepEqual(r, { status: "deleted", ids: ["a", "b"] }, "gone are those missing after the reload — c was only moved out");
  // The number fetch fails ⇒ no question, no deletion. The sabotage (`catch { counts = { chats: 0, contextFiles: 0 } }`) would
  // ask "0 chats will be lost" — and the DELETE would delete all.
  const q = logValue();
  const without = await folderPermanentlyProcedure({ id: "F", name: "X" }, {
    counts: q.throwing("counts", new TypeError("network down")), question: q.question(true), erase: q.perform("erase"),
    prior: () => ["a"], loadAgain: q.perform("loadAgain", null),
  });
  assert.deepEqual(without, { status: "without-counts", ids: [] });
  assert.deepEqual(q.log.map((e) => e[0]), ["counts"], "neither question nor deletion without the server's number");
  // An answer without a chat number is the same as none.
  const w = logValue();
  assert.equal((await folderPermanentlyProcedure({ id: "F", name: "X" }, {
    counts: w.perform("counts", { contextFiles: 2 }), question: w.question(true), erase: w.perform("erase"), prior: () => [], loadAgain: w.perform("loadAgain", null),
  })).status, "without-counts");
  assert.ok(!w.log.some((e) => e[0] === "erase"));
  // The server does not know the number of context files (null) ⇒ it asks anyway, without a number — never "0".
  const u = logValue();
  await folderPermanentlyProcedure({ id: "F", name: "X" }, {
    counts: u.perform("counts", { chats: 1, contextFiles: null }), question: u.question(false), erase: u.perform("erase"), prior: () => [], loadAgain: u.perform("loadAgain", null),
  });
  assert.equal(u.log[1][1], "Delete folder \"X\" permanently? 1 chat and all of the folder's context files will be lost (number unknown).");
  assert.ok(!u.log.some((e) => e[0] === "erase"), "cancelling deletes nothing");
  // An error of the DELETE reaches the caller (who shows it) — nothing is reported as deleted.
  const f = logValue();
  await assert.rejects(folderPermanentlyProcedure({ id: "F", name: "X" }, {
    counts: f.perform("counts", { chats: 2, contextFiles: 0 }), question: f.question(true), erase: f.throwing("erase", new Error("409")),
    prior: () => ["a"], loadAgain: f.perform("loadAgain", null),
  }), /409/);
  assert.ok(!f.log.some((e) => e[0] === "loadAgain"));
});

test("deletedIds: the DELETED ones are reported, never the survivors; if the reload fails, all seen before", () => {
  assert.deepEqual(deletedIds(["a", "b", "c"], { chats: [{ id: "c" }, { id: "z" }] }), ["a", "b"]);
  assert.deepEqual(deletedIds(["a", "b"], { chats: [] }), ["a", "b"]);
  assert.deepEqual(deletedIds(["a", "b"], { chats: [{ id: "a" }, { id: "b" }] }), [], "all still there ⇒ nothing reported");
  assert.deepEqual(deletedIds(["a", "b"], null), ["a", "b"], "reload failed ⇒ the folder's chats are gone");
  assert.deepEqual(deletedIds([], { chats: [{ id: "a" }] }), []);
});

test("loadPrecheck + archiveProcedure: a failed precheck is null (never { terminals: 0 }), and then the flow ASKS before it archives", async () => {
  assert.equal(await loadPrecheck(async () => { throw new TypeError("network down"); }), null, "failed ⇒ null");
  const v = { open: [], terminals: 2 };
  assert.equal(await loadPrecheck(async () => v), v, "succeeded ⇒ the value, unchanged");
  // Failed (null) ⇒ question without a number; cancel ⇒ no PUT. The sabotage `?? { terminals: 0 }` would archive here at
  // once — and end a running shell without a word.
  for (const state of [null, Promise.resolve(null), loadPrecheck(async () => { throw new Error("x"); }), undefined, {}]) {
    const p = logValue();
    const r = await archiveProcedure(state, { question: p.question(false), execute: p.perform("put") });
    assert.equal(r, false, "aborted");
    assert.deepEqual(p.log, [["question", "Archive? Open shells could not be checked — any open shell will be ended."]], `asked without a number, no PUT: ${JSON.stringify(state)}`);
  }
  // A REPORTED 0 does not ask; a number asks with the number; yes ⇒ PUT.
  const null0 = logValue();
  assert.equal(await archiveProcedure(Promise.resolve({ terminals: 0 }), { question: null0.question(false), execute: null0.perform("put") }), true);
  assert.deepEqual(null0.log, [["put"]]);
  const two = logValue();
  assert.equal(await archiveProcedure({ terminals: 2 }, { question: two.question(true), execute: two.perform("put") }), true);
  assert.deepEqual(two.log.map((e) => e[0]), ["question", "put"]);
  assert.equal(two.log[0][1], "Archive? 2 open shells will be ended.");
  // A still running fetch is AWAITED, not skipped.
  const late = open();
  const s = logValue();
  const run = archiveProcedure(late.p, { question: s.question(true), execute: s.perform("put") });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.log, [], "without a state no decision");
  late.on({ terminals: 1 });
  await run;
  assert.deepEqual(s.log.map((e) => e[0]), ["question", "put"]);
  // An error of the PUT reaches the caller (who shows it as a message).
  await assert.rejects(archiveProcedure({ terminals: 0 }, { question: s.question(true), execute: s.throwing("put", new Error("409 open")) }), /409/);
});

test("lastWins + openTargetProcedure: click X, then Y — if X's answers come last, Y stays open; setMeta before open; 404/error open nothing", async () => {
  const fresh = lastWins();
  const a = fresh(), b = fresh();
  assert.deepEqual([a(), b()], [false, true], "only the newest wish applies");
  // The case: two archived chats, X's list and X's chat arrive AFTER Y's.
  const log = [];
  const turn = lastWins();
  const loadX = open(), listX = open();
  const deps = (applies, load) => ({
    applies, loadChat: load, setMeta: (c) => log.push(["meta", c.id]), open: async (id) => { log.push(["open", id]); },
    wsId: "w", project: null,
  });
  const X = { id: "X", archivedAt: 1, kind: "normal", workspaceId: "w" };
  const Y = { id: "Y", archivedAt: 2, kind: "normal", workspaceId: "w" };
  const x = openTargetProcedure("X", listX.p, deps(turn(), () => loadX.p));
  const y = openTargetProcedure("Y", Promise.resolve([]), deps(turn(), async () => Y));
  assert.equal(await y, true);
  listX.on([]);
  await new Promise((r) => setImmediate(r));
  loadX.on(X);
  assert.equal(await x, false, "the older wish opens nothing any more");
  assert.deepEqual(log, [["meta", "Y"], ["open", "Y"]], "Y open — setMeta BEFORE open, X switched nothing");
  // The list alone can come late too: Y clicks while X is still waiting for its list.
  const log2 = [];
  const transaction2 = lastWins();
  const lateList = open();
  const d2 = (applies) => ({ applies, loadChat: async (id) => ({ id, archivedAt: 5, kind: "normal", workspaceId: "w" }), setMeta: (c) => log2.push(["meta", c.id]), open: async (id) => { log2.push(["open", id]); }, wsId: "w", project: null });
  const x2 = openTargetProcedure("X", lateList.p, d2(transaction2()));
  const y2 = openTargetProcedure("Y", [{ id: "Y" }], d2(transaction2()));
  await y2;
  lateList.on([{ id: "X" }]);
  assert.equal(await x2, false);
  assert.deepEqual(log2, [["open", "Y"]], "Y is in the list ⇒ ordinary opening; X's late list does not switch back");
  // And the list came EARLY, only the chat fetch late: X is already waiting for `loadChat` when Y clicks — the second check.
  const log3 = [];
  const transaction3 = lastWins();
  const laterChat = open();
  const d3 = (applies, load) => ({ applies, loadChat: load, setMeta: (c) => log3.push(["meta", c.id]), open: async (id) => { log3.push(["open", id]); }, wsId: "w", project: null });
  const x3 = openTargetProcedure("X", [], d3(transaction3(), () => laterChat.p));
  await new Promise((r) => setImmediate(r));
  const y3 = openTargetProcedure("Y", [], d3(transaction3(), async () => Y));
  assert.equal(await y3, true);
  laterChat.on(X);
  assert.equal(await x3, false);
  assert.deepEqual(log3, [["meta", "Y"], ["open", "Y"]], "X's late chat fetch sets no meta and opens nothing");
  // Without a race: archived and matching ⇒ meta, then open; 404 ⇒ nothing; error ⇒ nothing; foreign workspace ⇒ nothing,
  // except `openOtherwise` (event way) — then open WITHOUT meta (it is not archived or not known).
  const individual = async (load, extra = {}) => {
    const l = [];
    const ok = await openTargetProcedure("Z", [], { applies: () => true, loadChat: load, setMeta: (c) => l.push(["meta", c.id]), open: async (id) => { l.push(["open", id]); }, wsId: "w", project: null, ...extra });
    return [ok, l];
  };
  assert.deepEqual(await individual(async () => ({ id: "Z", archivedAt: 3, kind: "normal", workspaceId: "w" })), [true, [["meta", "Z"], ["open", "Z"]]]);
  assert.deepEqual(await individual(async () => null), [false, []], "404 ⇒ not opened");
  assert.deepEqual(await individual(async () => { throw new Error("Network"); }), [false, []], "error ⇒ not opened");
  assert.deepEqual(await individual(async () => ({ id: "Z", archivedAt: 3, kind: "normal", workspaceId: "different" })), [false, []]);
  assert.deepEqual(await individual(async () => null, { openOtherwise: true }), [true, [["open", "Z"]]], "event way: opens anyway, without meta");
  assert.deepEqual(await individual(async () => ({ id: "Z", archivedAt: 3, kind: "normal", workspaceId: "w", projectId: "B" }), { project: "A" }), [false, []], "the preselection in project A opens none from B");
});

// The child chat of a background run stands in no list and is not archived. Counter-test: deleting `|| Boolean(c.parentChatId)` in
// openTargetProcedure turns the first case red (opened WITHOUT metadata — the child chat would stand there without a title for one fetch).
test("openTargetProcedure: a NOT archived child (parentChatId) opens through the event way WITH metadata; the preselection does not open it; an ordinary active chat stays without", async () => {
  const individual = async (chat, extra = {}) => {
    const l = [];
    const ok = await openTargetProcedure("K", [], { applies: () => true, loadChat: async () => chat, setMeta: (c) => l.push(["meta", c.id, c.archivedAt ?? null]), open: async (id) => { l.push(["open", id]); }, wsId: "w", project: null, ...extra });
    return [ok, l];
  };
  const kind = { id: "K", archivedAt: null, parentChatId: "O", kind: "normal", workspaceId: "w", projectId: "P" };
  assert.deepEqual(await individual(kind, { openOtherwise: true }), [true, [["meta", "K", null], ["open", "K"]]], "card/bell/push: metadata BEFORE switching, not archived ⇒ the composer stays");
  assert.deepEqual(await individual(kind, { project: "P" }), [false, []], "the preselection (without openOtherwise) opens no child chat — archiveTargetMatches still demands archivedAt");
  assert.equal(archiveTargetMatches(kind, { wsId: "w", project: null }), false, "a child is no archive target");
  const active = { id: "K", archivedAt: null, kind: "normal", workspaceId: "w" };
  assert.deepEqual(await individual(active, { openOtherwise: true }), [true, [["open", "K"]]], "without parentChatId as before: open without metadata");
  assert.deepEqual(await individual({ ...active, parentChatId: "" }, { openOtherwise: true }), [true, [["open", "K"]]], "an empty parentChatId is none");
  // The wiring: the hook sets `archived` from archivedAt alone — a child with metadata stays writable.
  const h = fs.readFileSync(path.resolve(webDir, "src/components/chat/chatArchive.ts"), "utf8");
  assert.ok(h.includes("archived: archiveChat?.archivedAt != null,"), "archived asks only archivedAt");
});

test("recheckArchive: 404 ⇒ deleted; archived ⇒ the fresh state; brought back ⇒ back; an error is unknown — never \"deleted\"", async () => {
  assert.deepEqual(await recheckArchive("a", async () => null), { state: "deleted", chat: null });
  const c = { id: "a", archivedAt: 9, title: "Fresh" };
  assert.deepEqual(await recheckArchive("a", async () => c), { state: "archived", chat: c });
  const z = { id: "a", archivedAt: null };
  assert.deepEqual(await recheckArchive("a", async () => z), { state: "back", chat: z });
  assert.deepEqual(await recheckArchive("a", async () => { throw new TypeError("network down"); }), { state: "unknown", chat: null });
});

test("useArchive: the open ARCHIVED chat is re-checked — on opening, every 15 s when visible and on focus; 404 ⇒ chatAway", () => {
  const h = withoutK(hook);
  const np = h.slice(h.indexOf("const recheck = useCallback("), h.indexOf("}, []);", h.indexOf("const recheck = useCallback(")));
  assert.ok(np.includes("await recheckArchive(id, loadArchiveChat)"), "through the pure function");
  assert.ok(np.includes('if (n.state === "deleted") d.current.chatAway(id);'), "404 ⇒ chatAway (closes it, clears cache and draft)");
  assert.ok(np.includes("d.current.activeId !== id) return null;"), "only while it is still open");
  const effect = h.slice(h.indexOf("if (!activeId || inList) return;"), h.indexOf("}, [activeId, inList, recheck]);"));
  assert.ok(effect.includes("recheck(activeId, () => alive)"), "on opening");
  assert.ok(h.includes("const archiveOpenId = !inList && activeId && meta?.id === activeId && meta.archivedAt != null ? activeId : null;"), "the tick runs only for an open ARCHIVED chat");
  const tick = h.slice(h.indexOf("if (!archiveOpenId) return;"), h.indexOf("}, [archiveOpenId, recheck]);"));
  assert.ok(tick.includes("setInterval(check, 15_000)") && tick.includes('window.addEventListener("focus", check)') && tick.includes("clearInterval(iv)") && tick.includes('window.removeEventListener("focus", check)'), "15 s tick and focus, both unregistered again");
  assert.ok(tick.includes('document.visibilityState !== "visible"'), "only when the page is visible");
});

// ── Archiving chats automatically ──────────────
// Counter-test: in archiveRowLabel `reason === "auto"` changed to `reason` turns "label" red (a manually archived chat would be
// called "archived automatically"); deleting the range check in archiveDays turns "archiveDays" red.
test("archiveDays: only whole numbers from 1 to 365 — everything else is null and does not go out", () => {
  assert.deepEqual(AUTO_ARCHIVE_DAYS, { min: 1, max: 365 });
  for (const [raw, desired] of [["30", 30], [" 7 ", 7], ["1", 1], ["365", 365], ["030", 30]]) assert.equal(archiveDays(raw), desired, raw);
  for (const raw of ["", " ", "0", "366", "-3", "2.5", "1e2", "abc", "30 days", "+5"]) assert.equal(archiveDays(raw), null, JSON.stringify(raw));
});

test("archiveRowLabel: \"archived automatically\" ONLY with archiveReason auto — next to the folder name; user and unknown say nothing", () => {
  assert.equal(archiveRowLabel("", "auto"), "archived automatically");
  assert.equal(archiveRowLabel("Project X", "auto"), "Project X · archived automatically");
  assert.equal(archiveRowLabel("Project X", "user"), "Project X");
  assert.equal(archiveRowLabel("", "user"), "");
  assert.equal(archiveRowLabel("", null), "", "a server without the field claims no reason");
  assert.equal(archiveRowLabel("", undefined), "");
  assert.equal(archiveRowLabel("", "auto", (x) => `EN:${x}`), "EN:archived automatically", "the label goes through t()");
});

test("Archive view and settings: the row reads archiveReason through archiveRowLabel, loadArchive passes it on, the \"Chats\" page ALWAYS sends both fields", () => {
  const view = withoutComments(read("src/components/ArchiveView.tsx"));
  assert.ok(view.includes("const label = archiveRowLabel(folderName, c.archiveReason, t);"), "the archive row does not ask the reason");
  const apiArchive = withoutComments(read("src/lib/api/archive.ts"));
  assert.ok(/archiveReason: c\.archiveReason === "auto" \|\| c\.archiveReason === "user" \? c\.archiveReason : null,/.test(apiArchive),
    "loadArchive drops archiveReason (the entries' whitelist) — or takes a foreign value");
  // The PUT: a typed body with both fields (the route answers 400 otherwise) — no conditional spread, no single field.
  assert.ok(/const body: ChatAutoArchive = \{ enabled: value\.enabled, days: value\.days \};/.test(apiArchive), "the PUT does not carry both fields");
  assert.ok(apiArchive.includes('"/api/chat-auto-archive"'), "the setting's route");
  // Switch and number do not build their body from the state of the last server answer (`status`) but change ONE field of the
  // storage's local state (`autoArchiveStorage`, unit below) — it mixes in the rest and sends both fields. The number is still
  // checked by `archiveDays`, compared with the SHOWN state.
  const page = withoutComments(read("src/components/settings/ChatSettings.tsx"));
  assert.ok(page.includes("const n = archiveDays(raw);") && page.includes("if (n === null || n === now.days) { setDaysDraft(String(now.days)); return; }"),
    "an invalid number goes out — or the field does not jump back");
  assert.ok(/const \[storage\] = useState\(\(\) => autoArchiveStorage\(setChatAutoArchive, \{/.test(page), "the page does not save through the storage (local state, chain)");
  assert.ok(page.includes("void storage.change({ enabled: !now.enabled });") && page.includes("void storage.change({ days: n });"),
    "switch and number do not change ONE field each of the local state");
  assert.ok(page.includes("const now = storage.state();") && !/\bspeichern\(\{/.test(page), "a handle reads the state of the last server answer instead of the local one");
  assert.ok(page.includes(".then((s) => storage.loaded(s))"), "the loaded state does not go into the storage");
  assert.ok(/<Toggle on=\{status\?\.enabled \?\? false\}[^\n]*disabled=\{status === null\}/.test(page), "the switch is operable before loading");
  const modal = withoutComments(read("src/components/settings/SettingsModal.tsx"));
  // After "Chats" comes "Workflows" (cap and size of the dynamic workflows) — the promise of this line stays "Chats stands in
  // Behavior behind Browser".
  assert.ok(/\{ title: "Behavior", keys: \["models", "hooks", "browser", "chats", "workflows"\] \}/.test(modal), "\"Chats\" does not stand in \"Behavior\" behind \"Browser\" (and before \"Workflows\")");
});

// ── 5. Storage of the auto-archive setting and the bundled reload ──
//
// The "Chats" page saved stale values — typing days and clicking the switch right away would send `{enabled: old, days: new}` on
// blur and `{enabled: !old, days: old}` on click (both from the state of the last answer). `autoArchiveStorage` runs here with a fake
// PUT whose answers the test releases by hand (no clock).
// The first run of the automatic archive sends a `chat_archive` per chat, and every list reloaded on every event. `bundler` runs
// with a clock the test advances by hand; the three callers are bound by text.
//
// Counter-test (which sabotage turns which test red): in `change` instead of the chain immediately `write({ ...confirmed, ...part })`
// (the old body from the state of the last answer) turns both "autoArchiveStorage" tests red; deleting the reset in the error branch
// turns the second red; deleting `abort()` in `bundler.nudge` turns "bundler" red; going back to reloading per event in
// chatArchive.ts or ArchiveView.tsx turns "callers" red. Counting happens before every wait for a PUT: a surplus PUT stays open,
// and waiting for it would turn the red line into an aborted rest of the file.

function deferral() {
  let resolve, throwing;
  const p = new Promise((a, b) => { resolve = a; throwing = b; });
  return { p, resolve, throwing };
}
const quiet = () => new Promise((r) => setImmediate(r));

test("autoArchiveStorage: type days, then switch at once ⇒ ONE PUT with both NEW values; the last wins; always both fields", async () => {
  const puts = [];
  const shown = [];
  const error = [];
  const sp = autoArchiveStorage((w) => { const a = deferral(); puts.push({ w, a }); return a.p; }, { show: (s) => shown.push(s), error: (f) => error.push(f) });
  sp.change({ enabled: true });
  await quiet();
  assert.equal(puts.length, 0, "before loading the storage accepts nothing — \"not loaded yet\" is not \"off, 30 days\"");
  assert.equal(sp.state(), null);
  sp.loaded({ enabled: false, days: 30 });
  // Blur of the days field (10), then the click on the switch — at the same moment, before any answer.
  const a = sp.change({ days: 10 });
  const b = sp.change({ enabled: !sp.state().enabled });
  assert.deepEqual(sp.state(), { enabled: true, days: 10 }, "the local state carries both changes at once");
  assert.deepEqual(shown.at(-1), { enabled: true, days: 10 }, "the page shows at once (optimistic)");
  await quiet();
  assert.equal(puts.length, 1, "the first job reads the state of its RUN — it writes both");
  assert.deepEqual(puts[0].w, { enabled: true, days: 10 }, "both fields, both new");
  puts[0].a.resolve({ enabled: true, days: 10 });
  await quiet(); // count first, then wait: a second PUT would stay open, and waiting for it would be a hang instead of a red line
  assert.equal(puts.length, 1, "the second job has nothing left to write (the first took it along)");
  await a; await b;
  assert.deepEqual(error, [""], "a success clears the error line");
  // While a PUT runs, a further change comes: it goes out AFTER it, with the then-current state.
  const c = sp.change({ days: 20 });
  await quiet();
  const d = sp.change({ days: 21 });
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1].w, { enabled: true, days: 20 });
  puts[1].a.resolve({ enabled: true, days: 20 });
  await quiet();
  await c;
  assert.equal(puts.length, 3, "the jobs run one after another — the next only after the answer");
  assert.deepEqual(puts[2].w, { enabled: true, days: 21 }, "the last wins");
  assert.deepEqual(sp.state(), { enabled: true, days: 21 }, "an answer to an OLDER job does not take back the newer state");
  puts[2].a.resolve({ enabled: true, days: 21 });
  await d;
  for (const p of puts) assert.deepEqual(Object.keys(p.w).sort(), ["days", "enabled"], "every PUT carries both fields");
});

test("autoArchiveStorage: an error resets to the last CONFIRMED state (also what waited behind it) and shows the error line", async () => {
  const puts = [];
  const shown = [];
  const error = [];
  const sp = autoArchiveStorage((w) => { const a = deferral(); puts.push({ w, a }); return a.p; }, { show: (s) => shown.push(s), error: (f) => error.push(f) });
  sp.loaded({ enabled: true, days: 30 });
  const a = sp.change({ days: 5 });
  await quiet();
  const b = sp.change({ enabled: false }); // waits behind the running PUT
  puts[0].a.throwing(new Error("400: days must be 1–365"));
  await quiet();
  assert.equal(puts.length, 1, "after the error the waiting job writes nothing — it was part of the discarded state");
  await a; await b;
  assert.deepEqual(sp.state(), { enabled: true, days: 30 }, "back to the confirmed state");
  assert.deepEqual(shown.at(-1), { enabled: true, days: 30 }, "the page shows it (switch AND field)");
  assert.deepEqual(error, ["400: days must be 1–365"], "the error line names the server's text");
  // After that it goes on normally.
  const c = sp.change({ days: 7 });
  await quiet();
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1].w, { enabled: true, days: 7 });
  puts[1].a.resolve({ enabled: true, days: 7 });
  await c;
  assert.deepEqual(error.at(-1), "");
});

test("bundler + archiveEventImmediately: many events within the deadline ⇒ ONE reload; immediately takes the pending one along; abort clears", () => {
  let now = 0;
  const timer = new Map();
  let n = 0;
  const clock = { set: (f, ms) => { const id = ++n; timer.set(id, { f, until: now + ms }); return id; }, erase: (id) => { timer.delete(id); } };
  const run = (until) => { now = until; for (const [id, t] of [...timer]) if (t.until <= now) { timer.delete(id); t.f(); } };
  let loaded = 0;
  const b = bundler(() => { loaded += 1; }, ARCHIVE_BUNDLE_MS, clock);
  assert.equal(ARCHIVE_BUNDLE_MS, 300, "the same 300 ms as afterRunTimer in ChatPane");
  for (let i = 0; i < 50; i++) { b.nudge(); run(now + 5); }
  assert.equal(loaded, 0, "while the events come, nothing loads");
  run(now + 300);
  assert.equal(loaded, 1, "fifty events ⇒ ONE reload");
  b.nudge();
  b.immediately();
  assert.equal(loaded, 2, "immediately loads now …");
  run(now + 1000);
  assert.equal(loaded, 2, "… and takes the pending one along");
  b.nudge();
  b.abort();
  run(now + 1000);
  assert.equal(loaded, 2, "aborted (unmount) ⇒ no reload any more");
  assert.equal(timer.size, 0);
  // What "concerns the open chat": only an id list that contains it — never without an open chat.
  assert.equal(archiveEventImmediately(["a", "b"], "b"), true);
  assert.equal(archiveEventImmediately(["a", "b"], "c"), false);
  assert.equal(archiveEventImmediately(["a"], null), false);
  assert.equal(archiveEventImmediately(undefined, "a"), false, "an event without chatIds does not demonstrably concern the open one — bundled");
  assert.equal(archiveEventImmediately("a", "a"), false, "no list is no list");
});

test("Callers: coding hook and archive view reload BUNDLED on chat_archive, the open chat at once — and clear the timer on unmount", () => {
  const h = withoutK(hook);
  const branch = h.slice(h.indexOf('if (m.type !== "chat_archive" || m.kind !== "normal"'), h.indexOf("}), [reload]);"));
  assert.ok(h.includes("const [reload] = useState(() => bundler(() => { d.current.loadList().catch(console.error); }));"), "useArchive: the reload is not bundled");
  assert.ok(branch.includes("if (!a || !archiveEventImmediately(m.chatIds, a)) { reload.nudge(); return; }") && branch.includes("reload.immediately();"),
    "useArchive: foreign events not bundled — or the open chat waits");
  assert.ok(!branch.includes("d.current.loadList()"), "useArchive: a loadList of its own per event again");
  assert.ok(branch.includes("loadArchiveChat(a).then("), "useArchive: the open chat no longer fetches its metadata at once (bar)");
  assert.ok(h.includes("useEffect(() => () => reload.abort(), [reload]);"), "useArchive: the timer survives the unmount");

  const a = withoutK(read("src/components/ArchiveView.tsx"));
  const az = a.slice(a.indexOf('if (m.type === "chat_archive" && m.workspaceId === workspaceId && m.kind === kind) {'), a.indexOf("}), [load, workspaceId, kind, reload]);"));
  assert.ok(az.includes("if (archiveEventImmediately(m.chatIds, activeRef.current)) reload.immediately(); else reload.nudge();"), "archive view: chat_archive loads per event");
  assert.ok(a.includes("const [reload] = useState(() => bundler(() => { loadRef.current().catch(console.error); }));") && a.includes("useEffect(() => () => reload.abort(), [reload]);"),
    "archive view: no bundled reload with the current `load` — or no cleanup");

});
