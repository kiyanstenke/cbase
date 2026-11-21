// New chat = draft.
//
// Every "New chat" entry opens the empty view WITHOUT a POST; the chat is created on the first send — with exactly what the entry
// selected. Every button except the hero used to create immediately, and every click left an empty chat in the list (the server now
// shows empty chats in no list — the client therefore has to hold the open one itself).
//
// Two parts:
//   1. the pure computations from `lib/chat-draft.ts` (a leaf without imports, compiled here with tsc and executed): which preselection an
//      entry sets, and which window event counts as a job;
//   2. the wiring, read as TEXT: coding (ChatPane, chatDraft.ts, useArchive, instances tab, page). An entry that creates by itself
//      again is not visible in the UI — only one more empty chat in the database. That is exactly why this is here.
//
// Counter-tests (each red): in ChatPane `createChatInFolder` with `api<Chat>("/api/chats", …)` again ⇒ "Coding" red; in
// draftPreselection the instance let through for a foreign project ⇒ "draftPreselection" red.
//
// Section 3: the plain entry starts without folder and without instance, the project is the own preselection (`draftPreselection` with
// `lane`), and ONE creation at a time (`oneCreation`), each EXECUTED and each bound to its callers. Counter-tests: `lib/chat-draft.ts`
// without the functions ⇒ all three units red (`draftPreselection({})` keeps folder X); in `draftPreselection` the plain branch on
// `projectSel` instead of the own one ⇒ "finding 5" red (the folder's project sticks); in `oneCreation` `??=` replaced by `=` ⇒
// "finding 6" red (two POSTs).
//
// Run:  node --test web/test/chat-draft.test.mjs
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
const withoutComments = (q) => q.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
// The body of a function (up to the first line `  }` at its indentation) — the anchor throws if it grips into nothing.
function body(source, header) {
  const a = source.indexOf(header);
  assert.ok(a >= 0, `anchor not found: ${header}`);
  return source.slice(a, source.indexOf("\n  }\n", a));
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-draft-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "chat-draft.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--lib", "es2022,dom",
], { stdio: "pipe" });
const { draftPreselection, readNewChatJob, NEW_CHAT_EVENT, oneCreation } = await import(pathToFileURL(path.join(out, "chat-draft.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

// NAMED contract: the return carries `lane` (what a folder/instance entry overwrote in the project choice), "no argument" is the PLAIN
// entry (row, "+": without folder, in main), and only the sheet (`sheet: true`) keeps what is set. "No argument" used to mean: project
// and folder stay — and folder X stuck to exactly that.
test("draftPreselection: folder → its project; instance → project AND instance, no folder; sheet keeps what is set; plain without folder — in focus never a foreign project", () => {
  const status = { focus: null, projectSel: "p0", folderSel: "f0" };
  // Folder: the folder's project, the folder, main (the draft names the project).
  assert.deepEqual(draftPreselection({ folder: { id: "f1", projectId: "p1" } }, status), { projectSel: "p1", folderSel: "f1", instance: null, lane: { set: "p1", prior: "p0" } });
  assert.deepEqual(draftPreselection({ folder: { id: "f2", projectId: null } }, status), { projectSel: "", folderSel: "f2", instance: null, lane: { set: "", prior: "p0" } }, "folder without project ⇒ whole workspace");
  assert.deepEqual(draftPreselection({ folder: { id: "f1", projectId: "p1" } }, { ...status, focus: "p1", projectSel: "" }), { projectSel: "", folderSel: "f1", instance: null, lane: null }, "in focus the project choice is fixed");
  assert.deepEqual(draftPreselection({ folder: { id: "f3", projectId: "p0" } }, status), { projectSel: "p0", folderSel: "f3", instance: null, lane: null }, "a folder in the own project overwrites nothing");
  // Instance: project AND instance, the folder of the previous draft drops.
  assert.deepEqual(draftPreselection({ projectId: "p2", instance: "copy-k1" }, status), { projectSel: "p2", folderSel: "", instance: "copy-k1", lane: { set: "p2", prior: "p0" } });
  assert.deepEqual(draftPreselection({ projectId: "p2", instance: "copy-k1" }, { ...status, focus: "p2" }), { projectSel: "p0", folderSel: "", instance: "copy-k1", lane: null }, "in the own focus the instance applies");
  assert.deepEqual(draftPreselection({ projectId: "p2", instance: "copy-k1" }, { ...status, focus: "p9" }), { projectSel: "p0", folderSel: "", instance: null, lane: null }, "in the focus of ANOTHER project no foreign instance");
  assert.deepEqual(draftPreselection({ projectId: "p2", instance: "" }, status), { projectSel: "p2", folderSel: "", instance: null, lane: { set: "p2", prior: "p0" } }, "empty instance ⇒ main");
  // Sheet "New chat in …": the user just chose project and folder there — they stay, the instance falls to main.
  assert.deepEqual(draftPreselection({ sheet: true }, status), { projectSel: "p0", folderSel: "f0", instance: null, lane: null });
  // Plain (row, "+"): NO folder, main, the project of the own preselection.
  assert.deepEqual(draftPreselection({}, status), { projectSel: "p0", folderSel: "", instance: null, lane: null });
});

test("Finding 5: after \"New chat in folder X\" or \"Start chat\" on a copy a plain \"New chat\" starts WITHOUT folder, in main and in the previous project — unless the user has chosen the project themselves since", () => {
  // The hook (chat/chatDraft.ts) runs exactly like this: compute the preselection, set it, remember `lane` for the next entry.
  const run = (start, entryPoints) => {
    let st = { focus: null, lane: null, ...start };
    const ways = [];
    for (const e of entryPoints) {
      if (typeof e === "function") { st = { ...st, ...e(st) }; continue; } // an action of the user between the entries
      const v = draftPreselection(e, st);
      st = { ...st, projectSel: v.projectSel, folderSel: v.folderSel, lane: v.lane };
      ways.push({ projectSel: v.projectSel, folderSel: v.folderSel, instance: v.instance });
    }
    return ways;
  };
  const X = { folder: { id: "fX", projectId: "pX" } };
  const withoutProject = { folder: { id: "fW", projectId: null } };
  // The case of the finding: in the whole workspace, "New chat in folder X", (created), then the row "New chat".
  assert.deepEqual(run({ projectSel: "", folderSel: "" }, [X, {}]).at(-1), { projectSel: "", folderSel: "", instance: null }, "folder X (and its project) stick to the next draft");
  // An own preselection (sheet or project choice of the empty chat) survives the folder entry.
  assert.deepEqual(run({ projectSel: "p0", folderSel: "" }, [X, {}]).at(-1), { projectSel: "p0", folderSel: "", instance: null });
  assert.deepEqual(run({ projectSel: "p0", folderSel: "" }, [withoutProject, {}]).at(-1), { projectSel: "p0", folderSel: "", instance: null }, "a folder without a project does not take the preselection along either");
  // "Start chat" on a copy: project and copy do not stick.
  assert.deepEqual(run({ projectSel: "", folderSel: "" }, [{ projectId: "pK", instance: "copy-k1" }, {}]).at(-1), { projectSel: "", folderSel: "", instance: null }, "the copy of an earlier entry sticks");
  // Two entries in a row: it goes back to the state BEFORE the first.
  assert.deepEqual(run({ projectSel: "p0", folderSel: "" }, [X, { folder: { id: "fY", projectId: "pY" } }, {}]).at(-1), { projectSel: "p0", folderSel: "", instance: null });
  assert.deepEqual(run({ projectSel: "p0", folderSel: "" }, [X, { projectId: "pK", instance: "copy-k1" }, {}]).at(-1), { projectSel: "p0", folderSel: "", instance: null });
  // After the folder entry the user chooses a project themselves in the empty chat: then their choice applies.
  assert.deepEqual(run({ projectSel: "", folderSel: "" }, [X, () => ({ projectSel: "pH", folderSel: "" }), {}]).at(-1), { projectSel: "pH", folderSel: "", instance: null });
  // The sheet confirms what it shows — afterwards that is the own preselection, the folder is not.
  assert.deepEqual(run({ projectSel: "", folderSel: "" }, [X, { sheet: true }, {}]).map((w) => w.projectSel + "|" + w.folderSel), ["pX|fX", "pX|fX", "pX|"]);
  // In focus the project is fixed; the folder drops anyway.
  assert.deepEqual(run({ focus: "pF", projectSel: "", folderSel: "" }, [{ folder: { id: "fF", projectId: "pF" } }, {}]).at(-1), { projectSel: "", folderSel: "", instance: null });
  // Without a lane (first entry, workspace or project change — the hook forgets it there): plain keeps the project, never the folder.
  assert.deepEqual(draftPreselection({}, { focus: null, projectSel: "p0", folderSel: "f0" }), { projectSel: "p0", folderSel: "", instance: null, lane: null });
});

test("Finding 6 oneCreation: calls during a running creation get the SAME promise (one POST); afterwards — after success as after failure — the way is free", async () => {
  const creation = oneCreation();
  let posts = 0;
  let resolve, throwing;
  const create = () => { posts += 1; return new Promise((a, b) => { resolve = a; throwing = b; }); };
  // Attachment + immediate Enter (or double Enter): two callers before the first answer is there.
  const a = creation(create);
  const b = creation(create);
  assert.equal(posts, 1, "two callers ⇒ two POSTs (the attachment hung on the orphaned chat)");
  assert.equal(a, b, "both wait for the same promise");
  resolve("c1");
  assert.deepEqual(await Promise.all([a, b]), ["c1", "c1"], "both get the same id");
  // Afterwards (ChatPane: the id is in activeIdRef) a new call creates anew — the creation is not remembered forever.
  const c = creation(create);
  assert.equal(posts, 2);
  throwing(new Error("500"));
  await assert.rejects(c, /500/, "an error arrives at the caller (error line, text back into the field)");
  const d = creation(create);
  assert.equal(posts, 3, "after an error the next attempt may create anew");
  resolve("c3");
  assert.equal(await d, "c3");
});

test("readNewChatJob: only a complete job counts — a missing field is no instruction", () => {
  assert.equal(NEW_CHAT_EVENT, "cbase-new-chat");
  assert.deepEqual(readNewChatJob({ workspaceId: "w", projectId: "p", instance: "main" }), { workspaceId: "w", projectId: "p", instance: "main" });
  for (const d of [null, undefined, "x", {}, { workspaceId: "w", projectId: "p" }, { workspaceId: "w", instance: "main" }, { projectId: "p", instance: "main" },
    { workspaceId: "", projectId: "p", instance: "main" }, { workspaceId: "w", projectId: 3, instance: "main" }]) {
    assert.equal(readNewChatJob(d), null, JSON.stringify(d));
  }
});

test("Coding: every entry is a draft — ONE POST /api/chats (ensureChat) that holds the open chat and reloads the list only after the first message", () => {
  const pane = withoutComments(read("src/components/chat/ChatPane.tsx"));
  assert.equal((pane.match(/"\/api\/chats", \{/g) ?? []).length, 1, "ChatPane creates in more than one place");
  // NAMED contract: `createChat(from?)` — without an argument plain (row, "+"), `"sheet"` from the sheet.
  assert.match(body(pane, '  async function createChat(from?: "sheet") {'), /^  async function createChat\(from\?: "sheet"\) \{\s*newChat\(from === "sheet" \? \{ sheet: true \} : \{\}\);$/,
    "\"New chat\" (row, sheet, \"+\") creates by itself again — or does not tell the sheet from the plain entry");
  const list = withoutComments(read("src/components/chat/ChatListPane.tsx"));
  assert.equal((list.match(/createChat\("sheet"\)/g) ?? []).length, 1, "\"Start chat\" in the sheet does not keep its choice (or a second place acts as if it were the sheet)");
  assert.equal((list.match(/void createChat\(\);/g) ?? []).length, 2, "row \"New chat\" and \"+\" of the rail are not plain");
  assert.ok(list.includes('createChat: (out?: "sheet") => Promise<void>;'), "the list contract does not know the sheet");
  assert.match(body(pane, "  async function createChatInFolder(folder: ChatFolder) {"), /^  async function createChatInFolder\(folder: ChatFolder\) \{\s*newChat\(\{ folder: folder \}\);$/,
    "\"New chat in folder\" (menu, key N) creates by itself again");
  const ensure = body(pane, "  async function ensureChat(): Promise<string> {");
  assert.ok(ensure.includes('api<Chat>("/api/chats", {'), "the POST is not in ensureChat");
  assert.ok(ensure.includes("...instanceForCreation") && ensure.includes("folderId: folderSel || undefined") && ensure.includes("projectId: newChatProjectId()"),
    "ensureChat does not create with the preselection of the draft");
  // NAMED contract (the field jumped on the first send): ensureChat creates an EMPTY cache entry and opens with
  // `afterCreation` — no loading state, and the mark of the first message stays.
  const iHold = ensure.indexOf("holdOpen(chat);"), iOpen = ensure.indexOf("await open(chat.id, { afterCreation: true });");
  const iCache = ensure.indexOf("putChatCache(chat.id, { rows: [], bubbles: [], chat, artifacts: [] });");
  assert.ok(iHold > 0 && iHold < iOpen, "the created chat is not held BEFORE switching (the list does not carry it yet)");
  assert.ok(iCache > 0 && iCache < iOpen, "the created chat opens with a loading state (no empty cache entry before open) — the field jumps on the first send");
  assert.ok(!ensure.includes("await loadList()"), "ensureChat waits for a list that does not carry the empty chat at all");
  const send = body(pane, "  async function send(");
  assert.ok(send.includes("if (!chatsRef.current.some((c) => c.id === chatId)) loadList().catch(console.error);"), "after the first message the list does not reload");
  assert.ok(pane.includes("const activeChat = chats.find((c) => c.id === activeId) ?? archiveChat;"), "the open chat does not also come from useArchive");
  // The draft closes the open chat completely (stream, run state, remembered choice) — and sets the preselection, not the open chat.
  const to = body(pane, "  function toDraft() {");
  for (const s of ["esRef.current?.close();", "++openSeqRef.current;", "activeIdRef.current = null;", "setActiveId(null);", "setBusy(false);",
    "setInput(readDraft(draftKeyNew(wsId, focusProjectId)));", "localStorage.removeItem(chatKey);", "draft.flush();"]) {
    assert.ok(to.includes(s), `toDraft: ${s}`);
  }
  assert.ok(/useNewChat\(\{ wsId, focusProjectId, activeId, folders, projectSel, folderSel, setProjectSel, setFolderSel, selectInstancePreselection, revealFolder, toDraft, taRef \}\)/.test(pane),
    "useNewChat does not get the instance preselection (but pickInstance?) or not toDraft");
  // Finding 6: ensureChat creates through ONE creation — a second caller during the POST gets the same promise.
  assert.ok(pane.includes("const [creation] = useState(() => oneCreation<string>());"), "ChatPane holds no running creation");
  assert.ok(/^  async function ensureChat\(\): Promise<string> \{\s*if \(activeIdRef\.current\) return activeIdRef\.current;\s*return creation\(async \(\) => \{/.test(ensure),
    "ensureChat creates past the shared promise (attachment + Enter ⇒ two chats)");
  const hook = withoutComments(read("src/components/chat/chatDraft.ts"));
  // The hook carries the lane from entry to entry and forgets it on workspace and project change.
  assert.ok(hook.includes("const v = draftPreselection(e, { focus: focusProjectId, projectSel, folderSel, lane: lane.current });") && hook.includes("lane.current = v.lane;"),
    "useNewChat does not pass the lane on or does not remember it — the plain entry would not find the previous project");
  assert.ok(hook.includes("useEffect(() => { lane.current = null; }, [deps.wsId, deps.focusProjectId]);"), "the lane survives a workspace/project change (a project of a foreign workspace would come back)");
  assert.ok(!/"\/api\/chats"|\bapi\(/.test(hook), "the draft hook creates by itself");
  assert.ok(/window\.addEventListener\(NEW_CHAT_EVENT, on\)/.test(hook) && /a\.workspaceId === d\.current\.wsId/.test(hook), "\"Start chat\" (event) does not reach the draft — or reaches the one of a foreign workspace");
  const page = withoutComments(read("src/app/workspaces/page.tsx"));
  assert.ok(page.includes("window.addEventListener(NEW_CHAT_EVENT, toChats);"), "\"Start chat\" does not switch the \"Chats\" tab");
  // The stage names the folder of the draft (otherwise "New chat in folder" would look like any empty chat).
  const stage = withoutComments(read("src/components/chat/ChatStage.tsx"));
  assert.ok(/\{draftFolder && \([\s\S]{0,200}t\("Folder · \{name\}", \{ name: draftFolder\.name \}\)/.test(stage), "the strip under the field does not name the folder of the draft");
  // The instance preselection falls to main only once the list of its project has been READ — "Start chat" sets project and instance in one go.
  const instance = withoutComments(read("src/components/chat/chatInstance.ts"));
  assert.ok(/if \(readFor && preselection !== MAIN && !instanceOptions\.some\(\(o\) => o\.name === preselection\)\) setPreselection\(MAIN\);/.test(instance),
    "the instance preselection falls to main before the list is read (empty is not unknown)");
  // In useArchive: every reload of the list pulls in the metadata of the open chat that it does not carry.
  const archive = withoutComments(read("src/components/chat/chatArchive.ts"));
  assert.ok(archive.includes("}, [chats, recheck]);") && archive.includes("const holdOpen = useCallback((c: Chat) => setMeta(c), []);"), "useArchive does not hold the empty open chat");
});
