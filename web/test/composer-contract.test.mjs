// The contract of the composer (composer cut): `ChatComposerProps` has TWO groups — required and the picker group (optional in
// the type) — and ONE user:
//   - `ChatPane` (the coding chat) passes EVERY required prop AND every prop of the picker group through; the states that stay
//     in ChatPane and are only shown/switched in the composer arrive under the SAME name (`permPickerOpen={permPickerOpen}`, not
//     `permPickerOpen={false}`). Reason: the probes (slash-picker, draft, composer-strip) measure typing, sending, draft and
//     strip; a sabotage like `todoMode={false}` once stayed green there.
// The right bar `ChatRightSidebar` (`ChatRightSidebarProps`, ONE group, all required): ChatPane passes every prop through under
// its own name, the bar carries its identifiers and building blocks alone (none stay in ChatPane), and the text-artifact form
// runs through the upload chain up to `loadArtifacts` from ChatPane (the loader that also updates the chat cache) — the sabotage
// reads in the source: `loadArtifacts` not under its own name or no longer called from `uploadArtifacts` => red.
// The chat list `ChatListPane` (`ChatListPaneProps`, ONE group, all required): ChatPane passes every prop under its own name
// (list, folders, search, preselection of the next chat, create, loaders — they stay there because event stream, `open()`,
// header, stage and the global popover closer touch them), the list carries rows, menus and peek alone, and the folder menu is
// wired to `deleteFolder` — with confirmation, reload via `loadList` from ChatPane and closing the folder view. The sabotage
// reads in the source: `onDelete={deleteFolder}` missing on `<FolderMenu`, or `deleteFolder` no longer asks / reloads => red.
// The stage `ChatStage` (`ChatStageProps`, ONE group, all required, `children` is the composer slot): ChatPane passes every prop
// under its own name — the refs as REF OBJECT (`msgsRef`, `stickRef`, `taRef`, `activeIdRef`, `runStartRef`: open(), send(),
// answerAsk() and selectionInMessages() touch them in ChatPane, the stage reads and writes the same objects), the setters as
// React setters —, the `<ChatComposer …/>` call stands as CHILD between `<ChatStage …>` and `</ChatStage>` (its props do not run
// through the stage), the stage carries drop target, header, banner, hero, history, approval cards, selection menu and base alone,
// and the drop target is wired to `addFiles` from ChatPane. The sabotage reads in the source: `onDrop` no longer calls
// `addFiles(e.dataTransfer)`, or `addFiles` does not arrive under its own name => red; likewise `PermissionPrompt` without
// `decidePermission` and the limit strip without `retryLimitNow`.
// Three small contracts, all without context: the slash SWITCH `runSlash(text, attachments, h)` in `chatSlash.ts` (the values and
// handlers it used to read as a closure arrive as a map `h: SlashHandler` and are destructured at the head — ChatPane keeps the
// wrapper `runSlash(text, attachments)` and builds the map at the call, every value under its own name), the provider-switch
// sheet `ProviderSwitchModal` (`ProviderSwitchModalProps`, all required; ChatPane renders it conditionally, `pickModel`/
// `doProviderSwitch` stay there) and the history cache as hook `useHistoryCache(deps)` in `chatCache.ts` (cache ref + two
// useCallbacks at their old hook position, plus sync/reload/revalidate; the values the three read from ChatPane arrive as
// GETTERS — `loadArtifacts` stands in ChatPane only behind the hook; `open()` stays in ChatPane). The composer's table
// (`SLASH_COMMANDS` in ChatCatalog) and the switch know the same nine names.
// Two hooks under `chat/` that brought ChatPane under the line guard: the model and effort choice `useModelChoice(deps)` in
// `chatModelChoice.ts` (provider lists, preselection of the next chat, provider default, effective model with label, level with
// label, `pickEffort`; `pickModel`/`doProviderSwitch` stay in ChatPane) and the background state `useBackground(bubbles, busy)`
// in `chatBackground.ts` (wait phase, five wait states, their setters from the stream, the agents derived from them). The
// patterns that held the two provider lists and the effective model IN ChatPane now stand in the hook.
// Without a browser, by source text.
//
// COUNTER-TESTS: `permPickerOpen={false}` in ChatPane => "every passed-through prop carries its own name" red; a required prop
// dropped from the call => "every required prop is passed" red; a picker prop without default in the destructuring => "every
// prop of the picker group has a default" red. Right bar: `loadArtifacts={async () => []}` in ChatPane => "every prop under its
// own name" red; `await loadArtifacts(chatId)` dropped from `uploadArtifacts` => "upload chain" red; `data-chat-bar` back in
// ChatPane => "no identifier left in ChatPane" red. List: `onDelete={deleteFolder}` dropped from the FolderMenu => "folder menu"
// red; `loadList={async () => []}` in ChatPane => "every prop under its own name" red; `data-pop="sort"` back in ChatPane => "no
// identifier left in ChatPane" red. Stage: `addFiles(e.dataTransfer)` dropped from `onDrop` => "drop target" red;
// `addFiles={() => {}}` in ChatPane => "every prop under its own name" red; `data-pop="header"` back in ChatPane => "no identifier
// left in ChatPane" red; `<ChatComposer` out of the child slot => "the composer stands as child" red. Slash switch: the `browser`
// branch dropped from the switch => "table command without branch" red; `pickBrowser: pickEffort` in the handler map => "own
// name" red; `t={t}` dropped from the sheet => "every prop passed" red; `loadArtifacts: async () => []` in the getter => "own
// name" red. Activity bar: `<Segments` out of the list, terminal/browser in (`<TerminalsPane`, `<BrowserPane`, `data-bar-rail`,
// `data-bar-panel`); the pure parts and the DOM contract of the bar are in chat-bar.test.mjs.
// One user: `withPickers?: boolean;` back in the type => "two groups" red; a second `<ChatComposer` in components/ => "ONE user"
// red; `if (withPickers) loadGraphList();` back in updateSlash => "ONE user" red.
//
// Run:  node --test web/test/composer-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(here, "..", rel), "utf8");
const composer = read("src/components/chat/ChatComposer.tsx");
const pane = read("src/components/chat/ChatPane.tsx");
const sidebar = read("src/components/chat/ChatRightSidebar.tsx");
const list = read("src/components/chat/ChatListPane.tsx");
const stage = read("src/components/chat/ChatStage.tsx");

// Prop names from `export type ChatComposerProps = { … }` — one line per prop, `name?:` is optional. The groups are
// separated by the marker `// ── Picker group` (there used to be `// ── Switches for the manager composer` as a third group).
const typeBlock = (() => {
  const start = composer.indexOf("export type ChatComposerProps = {");
  assert.ok(start >= 0, "ChatComposerProps is in ChatComposer.tsx");
  const end = composer.indexOf("\n};", start);
  return composer.slice(start, end);
})();
const MARKER_PICKER = "// ── Picker group";
const MARKER_TOGGLE = "// ── Switches for the manager composer";
const groups = (() => {
  const p = typeBlock.indexOf(MARKER_PICKER);
  assert.ok(p > 0, "the marker of the picker group is in the type");
  const names = (text) => [...text.matchAll(/^\s{2}([A-Za-z]+)(\?)?:/gm)].map((m) => ({ name: m[1], optional: Boolean(m[2]) }));
  return { required: names(typeBlock.slice(0, p)), picker: names(typeBlock.slice(p)) };
})();
const required = groups.required.map((p) => p.name);
const picker = groups.picker.map((p) => p.name);
const all = [...required, ...picker];
// The seven switches of the manager composer — they must not return anywhere.
const TOGGLE_UNTIL_AO4 = ["mentionSource", "slashCommands", "slashGlow", "withPickers", "withInsertText", "skillArea", "modelFixed"];

// The call `<ChatComposer … />` with `name={value}` per line (the last one in the file).
function call(source, who) {
  const start = source.lastIndexOf("<ChatComposer");
  assert.ok(start >= 0, `${who} renders <ChatComposer`);
  const text = source.slice(start, source.indexOf("/>", start));
  return new Map([...text.matchAll(/\b([A-Za-z]+)=\{([^}]*)\}/g)].map((m) => [m[1], m[2].trim()]));
}
const inPane = call(pane, "ChatPane");

test("the contract has two groups: required and picker group (optional) — the switches of the manager composer are gone", () => {
  assert.ok(required.length >= 25, `required props found: ${required.length}`);
  assert.deepEqual(groups.required.filter((p) => p.optional), [], "a required prop carries a question mark");
  assert.equal(picker.length, 13, `picker group: ${picker.length} props`);
  assert.deepEqual(groups.picker.filter((p) => !p.optional), [], "a prop of the picker group is not optional");
  // The third group (the manager switches) is gone with its only setter.
  assert.ok(!typeBlock.includes("// ── Switches for the manager composer"), "the marker of the switch group is back in the type");
  assert.deepEqual(TOGGLE_UNTIL_AO4.filter((n) => all.includes(n)), [], "a switch of the manager composer is back in the type");
});

test("every prop of the picker group has a default in the destructuring (the composer never sees undefined)", () => {
  const start = composer.indexOf("const {", composer.indexOf("function ChatComposer(props, ref)"));
  const end = composer.indexOf("} = props;", start);
  assert.ok(start > 0 && end > start, "the destructuring `const { … } = props;` is in the composer");
  const dest = composer.slice(start, end);
  const without = picker.filter((n) => !new RegExp(`\\b${n} = `).test(dest));
  assert.deepEqual(without, [], "picker prop without default");
});

test("ChatPane: every required prop and every prop of the picker group is passed", () => {
  const missing = [...required, ...picker].filter((n) => !inPane.has(n));
  assert.deepEqual(missing, [], "props not passed in ChatPane");
});

test("ChatPane: every passed-through prop carries its own name (no literal, no foreign value)", () => {
  // The states ChatPane holds and the composer shows or switches ("touched from outside"):
  const passedThrough = ["input", "setInput", "files", "setFiles", "dragOver", "taRef", "send", "stop", "addFiles", "addPastedText",
    "modelPickerOpen", "setModelPickerOpen", "permPickerOpen", "setPermPickerOpen",
    "effortPickerOpen", "setEffortPickerOpen"];
  const wrong = passedThrough.filter((n) => inPane.get(n) !== n).map((n) => `${n}={${inPane.get(n)}}`);
  assert.deepEqual(wrong, [], "prop not passed through under its own name");
});

test("no unknown prop in the call, and `hero` is the empty state", () => {
  const known = new Set([...all, "ref"]);
  const foreign = [...inPane.keys()].filter((n) => !known.has(n));
  assert.deepEqual(foreign, [], "ChatPane: props the contract does not know");
  assert.equal(inPane.get("hero"), "empty", "ChatPane: hero");
});

// The promise from the other side: the composer has ONE user, and no remnant of a switch stands in the body.
test("ONE user: only ChatPane renders the composer, and nothing in the body reads a manager switch any more", () => {
  const root = path.resolve(here, "..", "src");
  const user = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) run(full);
      else if (/\.tsx?$/.test(e.name) && /<ChatComposer[\s/>]/.test(withoutComments(fs.readFileSync(full, "utf8")))) user.push(path.relative(root, full));
    }
  };
  run(root);
  assert.deepEqual(user.sort(), ["components/chat/ChatPane.tsx"], "who renders <ChatComposer");
  const code = withoutComments(composer);
  for (const n of TOGGLE_UNTIL_AO4) assert.ok(!new RegExp(`\\b${n}\\b`).test(code), `the composer still reads ${n}`);
  assert.ok(!code.includes("area=managing"), "the composer still asks for the managing skills");
  // The overlay marks everything from the picker's stock — commands, skills of the chat, graph workflows —, not only the nine commands.
  assert.ok(/slashMarkerLength\(input, slashNames, /.test(code) && /slashStock\.map\(\(e\) => e\.name\)/.test(code), "the marker is that of the picker stock");
  assert.ok(/\.\.\.SLASH_COMMANDS\.map\(/.test(code), "the table is SLASH_COMMANDS");
});

// ── Right bar ────────────────────────────────────────────────────────────────────
// Prop names from `export type ChatRightSidebarProps = { … }` — one line per prop, no groups, nothing optional.
const sidebarType = (() => {
  const start = sidebar.indexOf("export type ChatRightSidebarProps = {");
  assert.ok(start >= 0, "ChatRightSidebarProps is in ChatRightSidebar.tsx");
  return sidebar.slice(start, sidebar.indexOf("\n};", start));
})();
const sidebarProps = [...sidebarType.matchAll(/^\s{2}([A-Za-z]+)(\?)?:/gm)].map((m) => ({ name: m[1], optional: Boolean(m[2]) }));
const sidebarNames = sidebarProps.map((p) => p.name);
const inPaneSidebar = (() => {
  const start = pane.lastIndexOf("<ChatRightSidebar");
  assert.ok(start >= 0, "ChatPane renders <ChatRightSidebar");
  const text = pane.slice(start, pane.indexOf("/>", start));
  return new Map([...text.matchAll(/\b([A-Za-z]+)=\{([^}]*)\}/g)].map((m) => [m[1], m[2].trim()]));
})();

test("ChatRightSidebar: ChatPane passes every prop of the contract, each under its own name — without exception", () => {
  assert.ok(sidebarNames.length >= 20, `props in the contract: ${sidebarNames.length}`);
  assert.deepEqual(sidebarProps.filter((p) => p.optional), [], "the bar has no optional prop — ChatPane is its only user");
  const missing = sidebarNames.filter((n) => !inPaneSidebar.has(n));
  assert.deepEqual(missing, [], "props not passed in ChatPane");
  const foreign = [...inPaneSidebar.keys()].filter((n) => !sidebarNames.includes(n));
  assert.deepEqual(foreign, [], "ChatPane passes props the contract does not know");
  // The states that stay in ChatPane (tabs, open state, artifact list and selection, agent choice) and the handlers that live
  // there (setters, selectArtifact, loadArtifacts, addError): under the SAME name, no literal, no foreign value — otherwise the
  // bar would show a state nobody switches any more.
  const wrong = sidebarNames.filter((n) => inPaneSidebar.get(n) !== n).map((n) => `${n}={${inPaneSidebar.get(n)}}`);
  assert.deepEqual(wrong, [], "prop not passed through under its own name");
  // The card of the main run is gone — and with it every prop that served only it. Checked by NAME: a forgotten prop would be
  // required in the contract and a dead value in ChatPane.
  for (const way of ["runStartedAt", "currentProvider", "effectiveModel", "busy", "inTokens", "outTokens"]) {
    assert.ok(!sidebarNames.includes(way), `ChatRightSidebar still carries the main-run prop ${way}`);
  }
  assert.equal(inPaneSidebar.get("taskSequence"), "taskSequence", "the arrival sequence of the \"Background Tasks\" list under its own name");
  // The cards of the background runs in the same list — state and stop from `useGraphRuns` under its own name (the same hook the
  // stage reads for the strip; no second call).
  assert.equal(inPaneSidebar.get("graphRuns"), "graphRuns", "the graph starts on the bar under their own name");
  assert.equal(inPaneSidebar.get("stopGraphStart"), "stopGraphStart", "the stop of a graph card under its own name");
  // Archive: the bar reads `archived` under its own name.
  assert.ok(sidebarNames.includes("archived") && inPaneSidebar.get("archived") === "archived", "archived={archived} on the bar");
});

test("ChatRightSidebar: the bar lives only in ChatRightSidebar.tsx — no identifier, no building block left in ChatPane", () => {
  // The handles of the probes (artifact modal, agents, channel) and the building blocks of the four tabs.
  for (const marker of ["data-chat-bar", "data-bar-rail", "data-bar-panel", "data-agent-rail", "data-channel-pill-unread",
    "<ChannelSidebar", "<GitSidebar", "<AgentBar", "<ArtifactTree", "<TerminalsPane", "<BrowserPane", "useChannelStatus(",
    "saveTextArtifact", "uploadArtifacts", "revealArtifact", "toggleArtifactDir", "openArtifactDirs", "textDraftTitle"]) {
    assert.ok(!pane.includes(marker), `remnant of the bar in ChatPane: ${marker}`);
    assert.ok(sidebar.includes(marker), `missing in ChatRightSidebar: ${marker}`);
  }
  // What STAYS in ChatPane: the artifact modal with its state (open() and loadArtifacts touch it) and the open state with the
  // window gate (useAutoCollapse reads the raw setter).
  assert.ok(pane.includes("<ArtifactModal") && !sidebar.includes("<ArtifactModal"), "the ArtifactModal is in ChatPane, not in the bar");
  assert.ok(pane.includes("useAutoCollapse(1250, rightSidebarOpen, setRightSidebarOpenState)"), "the open state stays in ChatPane with its window gate");
  assert.ok(pane.includes("const loadArtifacts = useCallback(async (chatId: string) => {"), "loadArtifacts stays in ChatPane (event stream, chat switch)");
  assert.ok(!sidebar.includes("import") || !/from "@\/components\/chat\/ChatPane"/.test(sidebar), "the bar imports nothing from ChatPane");
});

test("ChatRightSidebar: the text-artifact form goes through the upload chain and reloads the list via loadArtifacts from ChatPane", () => {
  assert.ok(sidebar.includes("onSubmit={(e) => { e.preventDefault(); saveTextArtifact(); }}"), "the form saves via saveTextArtifact");
  const save = sidebar.slice(sidebar.indexOf("async function saveTextArtifact()"), sidebar.indexOf("\n  }\n", sidebar.indexOf("async function saveTextArtifact()")));
  assert.ok(save.includes('await uploadArtifacts([new File([body], name, { type: "text/plain" })]);'), "saveTextArtifact runs through uploadArtifacts (the same conflict question, the same reload)");
  assert.ok(save.includes("artifactNameFromTitle(title)"), "the title becomes the file name via artifactNameFromTitle");
  const upload = sidebar.slice(sidebar.indexOf("async function uploadArtifacts("), sidebar.indexOf("\n  }\n", sidebar.indexOf("async function uploadArtifacts(")));
  assert.ok(upload.includes("await loadArtifacts(chatId)"), "uploadArtifacts reloads the list via loadArtifacts");
  assert.ok(upload.includes("if (shown) revealArtifact(shown);"), "the new file is expanded in the tree, not opened");
  assert.ok(upload.includes("await question("), "the conflict question (409 + exists) stays");
  // The loader is the one from ChatPane: it also writes the chat cache, otherwise switching away and back would show the
  // state from before the upload.
  assert.equal(inPaneSidebar.get("loadArtifacts"), "loadArtifacts");
  const loader = pane.slice(pane.indexOf("const loadArtifacts = useCallback("), pane.indexOf("}, []);", pane.indexOf("const loadArtifacts = useCallback(")));
  assert.ok(loader.includes("cached.artifacts = list") && loader.includes("setArtifacts(list)"), "loadArtifacts writes cache AND list");
});

// ── Chat list ────────────────────────────────────────────────────────────────────────
// Prop names from `export type ChatListPaneProps = { … }` — one line per prop, no groups, nothing optional.
const listType = (() => {
  const start = list.indexOf("export type ChatListPaneProps = {");
  assert.ok(start >= 0, "ChatListPaneProps is in ChatListPane.tsx");
  return list.slice(start, list.indexOf("\n};", start));
})();
const listProps = [...listType.matchAll(/^\s{2}([A-Za-z]+)(\?)?:/gm)].map((m) => ({ name: m[1], optional: Boolean(m[2]) }));
const listNames = listProps.map((p) => p.name);
const inPaneList = (() => {
  const start = pane.lastIndexOf("<ChatListPane");
  assert.ok(start >= 0, "ChatPane renders <ChatListPane");
  const text = pane.slice(start, pane.indexOf("/>", start));
  return new Map([...text.matchAll(/\b([A-Za-z]+)=\{([^}]*)\}/g)].map((m) => [m[1], m[2].trim()]));
})();

test("ChatListPane: ChatPane passes every prop of the contract, each under its own name, no foreign one", () => {
  assert.ok(listNames.length >= 35, `props in the contract: ${listNames.length}`);
  assert.deepEqual(listProps.filter((p) => p.optional), [], "the list has no optional prop — ChatPane is its only user");
  const missing = listNames.filter((n) => !inPaneList.has(n));
  assert.deepEqual(missing, [], "props not passed in ChatPane");
  const foreign = [...inPaneList.keys()].filter((n) => !listNames.includes(n));
  assert.deepEqual(foreign, [], "ChatPane passes props the contract does not know");
  // The states that stay in ChatPane (list, folders, search, preselection, pop flags) and the handlers that live there (create,
  // rename, pin, delete, move, the loaders): under the SAME name, no literal, no foreign value — otherwise the list would show a
  // state nobody writes any more, or load through a loader that does not know the event stream.
  const wrong = listNames.filter((n) => inPaneList.get(n) !== n).map((n) => `${n}={${inPaneList.get(n)}}`);
  assert.deepEqual(wrong, [], "prop not passed through under its own name");
  // The setters arrive as React setters (functional updates: setChats in the notification sheet, setNewChatOpen/setSortOpen via
  // `(v) => !v`, setFolderView on folder delete) — the type says so, no `(v: X) => void`.
  for (const s of ["setChats", "setSortOpen", "setNewChatOpen", "setFolderView", "setListSearch", "setProjectSel", "setFolderSel"]) {
    assert.ok(new RegExp(`^\\s{2}${s}: React\\.Dispatch<React\\.SetStateAction<`, "m").test(listType), `${s} is typed as React.Dispatch`);
  }
});

test("ChatListPane: the list lives only in ChatListPane.tsx — no identifier, no building block left in ChatPane; what stays at the measurement stays", () => {
  // The handles of the probes (draft: `[data-pop="fresh"] button`; page switch) and the building blocks of the list.
  for (const marker of ['data-pop="fresh"', 'data-pop="sort"', "cbase-chatlist-collapsed", "renderList(", "<ChatRow", "<FolderRow",
    "<ChatMenu", "<FolderMenu", "<NotifySheet", "buildSections(", "useAutoCollapse(900,", "listPeek", "peekOpen", "peekClose",
    "toggleList", "openMenu(", "openFolderMenu(", "prevMenuRef", "listSearchOpen", "async function forkChat(", "async function createFolder()",
    "async function renameFolder(", "async function deleteFolder(", "async function moveToFolder("]) {
    assert.ok(!pane.includes(marker), `remnant of the list in ChatPane: ${marker}`);
    assert.ok(list.includes(marker), `missing in ChatListPane: ${marker}`);
  }
  // The persona choice is gone — neither the list nor ChatPane load personas or send `profile` on create.
  for (const way of ["listProfiles(", "profileSel", "setProfileSel", "profile: "]) {
    assert.ok(!pane.includes(way) && !list.includes(way), `persona remnant: ${way}`);
  }
  // What STAYS in ChatPane: the list and its loaders (event stream, focus, open), the filtered sets (the folder view on the stage
  // reads folderChats — and with it the search), create with the preselection, the header actions and the two pop flags the
  // global closer reads. `createChat(from?: "sheet")` — without argument the plain entry (row, "+": without folder), with "sheet"
  // the choice of the sheet "New chat in …" (web/test/chat-draft.test.mjs).
  for (const stays of ["const loadList = useCallback(async () => {", "const loadFolders = useCallback(async () => {",
    "const scopedChats = useMemo(() => {", "const folderChats = useMemo(() => {",
    "const [listSearch, setListSearch] = useState(\"\");", "async function createChat(from?: \"sheet\") {", "async function createChatInFolder(folder: ChatFolder) {",
    "async function renameChat(chat: Chat) {", "async function togglePin(chat: Chat) {", "async function deleteChat(chat: Chat) {",
    "async function moveToProject(chat: Chat, projectId: string | null) {", "const revealFolder = (id: string) =>",
    "useAutoCollapse(1250, rightSidebarOpen, setRightSidebarOpenState)"]) {
    assert.ok(pane.includes(stays), `missing in ChatPane (belongs there): ${stays}`);
    assert.ok(!list.includes(stays), `duplicated in ChatListPane: ${stays}`);
  }
  // The folder view reads folderChats — in the stage (ChatStage.tsx), which gets it as a prop from ChatPane.
  assert.ok(stage.includes("chats={folderChats.get(folderView.id) ?? []}") && !list.includes("<ChatFolderView"), "the folder view on the stage reads folderChats");
  assert.ok(/^\s{8}folderChats=\{folderChats\}$/m.test(pane.slice(pane.lastIndexOf("<ChatStage"))), "folderChats goes into the stage under its own name");
  // The global popover closer reads both list pops — that is why they are state of ChatPane.
  const closer = pane.slice(pane.indexOf("const anyPopOpen ="), pane.indexOf(";", pane.indexOf("const anyPopOpen =")));
  assert.ok(/\bnewChatOpen\b/.test(closer) && /\bsortOpen\b/.test(closer), "anyPopOpen reads newChatOpen and sortOpen");
  assert.ok(!/from "@\/components\/chat\/ChatPane"/.test(list), "the list imports nothing from ChatPane");
  assert.ok(!list.includes("forwardRef(") && !list.includes("useImperativeHandle("), "no handle: nothing in ChatPane triggers anything on the list");
});

// A chat whose project is deleted (old data — the server now clears the chats' id) used to stand in NO section under "By project":
// not under a project (there is none) and not under "No project" (it has an id). It had vanished from the list. `buildSections`
// is cut from the source, compiled with the TypeScript of the web folder and executed (it has no imports) — merely reading would
// not prove the promise. COUNTER-TEST: the old ChatListRows.tsx => red (the chat "b" is missing in every section).
test("chat list \"By project\": a chat with a deleted project stands under \"No project\", every chat exactly once — executed", async () => {
  const { createRequire } = await import("node:module");
  const ts = createRequire(path.resolve(here, "..", "package.json"))("typescript");
  const q = read("src/components/chat/ChatListRows.tsx");
  const start = q.indexOf("function buildSections(");
  const end = q.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "buildSections not found in ChatListRows.tsx — moved? Then follow here.");
  const js = ts.transpileModule(q.slice(start, end + 3), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  // eslint-disable-next-line no-new-func
  const buildSections = new Function(`${js}\nreturn buildSections;`)();
  const chats = [
    { id: "a", projectId: "p1", pinned: false, updatedAt: 3 },
    { id: "b", projectId: "deleted", pinned: false, updatedAt: 2 },
    { id: "c", projectId: null, pinned: false, updatedAt: 1 },
  ];
  const secs = buildSections(chats, "project", [{ id: "p1", name: "Checkout" }]);
  assert.deepEqual(secs.map((s) => [s.key, s.chats.map((c) => c.id)]), [["p1", ["a"]], ["none", ["b", "c"]]],
    "the chat with a deleted project vanished from the list");
  const ids = secs.flatMap((s) => s.chats.map((c) => c.id)).sort();
  assert.deepEqual(ids, ["a", "b", "c"], "every chat stands exactly once in the list");
  // "Recent" is untouched by the project assignment.
  assert.deepEqual(buildSections(chats, "recent", []).flatMap((s) => s.chats.map((c) => c.id)), ["a", "b", "c"]);
});

test("ChatListPane: the folder menu is wired to deleteFolder — with confirmation, closing the folder view and reloading via loadList from ChatPane", () => {
  const menu = list.slice(list.indexOf("<FolderMenu"), list.indexOf("/>", list.indexOf("<FolderMenu")));
  const props = new Map([...menu.matchAll(/\b([A-Za-z]+)=\{([^}]*)\}/g)].map((m) => [m[1], m[2].trim()]));
  assert.equal(props.get("onDelete"), "deleteFolder", "onDelete={deleteFolder}");
  assert.equal(props.get("onRename"), "renameFolder", "onRename={renameFolder}");
  assert.equal(props.get("onNewChat"), "createChatInFolder", "onNewChat={createChatInFolder} — creating comes from ChatPane");
  const start = list.indexOf("async function deleteFolder(folder: ChatFolder) {");
  assert.ok(start >= 0, "deleteFolder is a function of the list");
  const body = list.slice(start, list.indexOf("\n  }\n", start));
  assert.ok(body.includes("if (!(await question(") && body.includes("danger: true"), "deleteFolder asks for confirmation (dangerous)");
  assert.ok(body.includes("setFolderView((cur) => (cur?.id === folder.id ? null : cur));"), "an open folder view of this folder closes");
  assert.ok(body.includes("await loadList();") && body.includes("onChanged?.();"), "then reload list AND folders and report the counter");
  // The loader is the one from ChatPane (chats + folders in ONE go), under its own name — no second loader in the list.
  assert.equal(inPaneList.get("loadList"), "loadList");
  assert.ok(!list.includes("/api/chats?workspaceId="), "the list does not load the chats itself");
  // Delete chat (menu of the row AND ⋯ of the header) stays in ChatPane and arrives as a prop.
  const chatMenu = list.slice(list.indexOf("<ChatMenu"), list.indexOf("/>", list.indexOf("<ChatMenu")));
  assert.ok(chatMenu.includes("onDelete={deleteChat}"), "ChatMenu: onDelete={deleteChat}");
  assert.equal(inPaneList.get("deleteChat"), "deleteChat");
  // The ⋯ menu of the header lies in the stage and calls the same deleteChat from ChatPane (prop under its own name).
  assert.ok(stage.includes("deleteChat(activeChat)") && /^\s{8}deleteChat=\{deleteChat\}$/m.test(pane.slice(pane.lastIndexOf("<ChatStage"))), "the ⋯ menu of the header calls the same deleteChat");
});

// No probe measures collapsing/expanding the chat list: `pageSwitch.mjs` grabs `aside` = the WorkspaceRail (228 px), not the
// chat list (268 px). A `toggleList` replaced by `() => {}` stayed green in tsc, all gate tests and the probe set. Hence here:
// the two buttons of the rail and the list head hang on toggleList, and toggleList really toggles (setListCollapsed with
// negation) and closes the peek.
test("ChatListPane: collapsing/expanding is wired — both buttons call toggleList, and toggleList toggles", () => {
  const buttons = [...list.matchAll(/onClick=\{toggleList\}/g)].length;
  assert.equal(buttons, 2, "exactly two buttons (list head: collapse, rail: expand) call toggleList");
  const start = list.indexOf("const toggleList = useCallback(() => {");
  assert.ok(start >= 0, "toggleList is a useCallback of the list");
  const body = list.slice(start, list.indexOf("\n  }, [", start));
  assert.ok(body.includes("setListCollapsed((v) => {") && body.includes("const next = !v;"), "toggleList negates listCollapsed");
  assert.ok(body.includes('localStorage.setItem("cbase-chatlist-collapsed"'), "and remembers the state under the same key");
  assert.ok(body.includes("setListPeek(false)"), "toggleList closes the peek");
  assert.ok(!pane.includes("toggleList"), "toggleList no longer lives in ChatPane");
});

// ── Stage ────────────────────────────────────────────────────────────────────────────
// Prop names from `export type ChatStageProps = { … }` — one line per prop, no groups, nothing optional; `children` is the
// composer slot and arrives not as an attribute but as a child.
const stageType = (() => {
  const start = stage.indexOf("export type ChatStageProps = {");
  assert.ok(start >= 0, "ChatStageProps is in ChatStage.tsx");
  return stage.slice(start, stage.indexOf("\n};", start));
})();
const stageProps = [...stageType.matchAll(/^\s{2}([A-Za-z]+)(\?)?:/gm)].map((m) => ({ name: m[1], optional: Boolean(m[2]) }));
const stageNames = stageProps.map((p) => p.name);
// The call `<ChatStage … >` has children: the opening mark ends at the line `      >`, the slot reaches to `</ChatStage>`.
const stageCall = (() => {
  const start = pane.lastIndexOf("<ChatStage");
  assert.ok(start >= 0, "ChatPane renders <ChatStage");
  const openEnd = pane.indexOf("\n      >", start);
  const to = pane.indexOf("</ChatStage>", start);
  assert.ok(openEnd > start && to > openEnd, "the opening mark ends at `>`, the slot at </ChatStage>");
  const props = new Map([...pane.slice(start, openEnd).matchAll(/\b([A-Za-z]+)=\{([^}]*)\}/g)].map((m) => [m[1], m[2].trim()]));
  return { props, children: pane.slice(openEnd, to) };
})();
const inPaneStage = stageCall.props;

test("ChatStage: ChatPane passes every prop of the contract under its own name, no foreign one — refs as ref object, setters as React setters, the composer as child", () => {
  assert.ok(stageNames.length >= 75, `props in the contract: ${stageNames.length}`);
  assert.deepEqual(stageProps.filter((p) => p.optional), [], "the stage has no optional prop — ChatPane is its only user");
  assert.equal(stageNames[stageNames.length - 1], "children", "the slot is called children and stands at the end of the contract");
  const missing = stageNames.filter((n) => n !== "children" && !inPaneStage.has(n));
  assert.deepEqual(missing, [], "props not passed in ChatPane");
  const foreign = [...inPaneStage.keys()].filter((n) => !stageNames.includes(n));
  assert.deepEqual(foreign, [], "ChatPane passes props the contract does not know");
  // Everything that stays in ChatPane (stream state, pop flags, selection menu, folder view, the handlers, the provider
  // derivations, the refs) under the SAME name — no literal, no foreign value, no `.current`: the stage writes
  // stickRef/setJumpDown/setDragOver itself, a value instead of the object would be a silent copy.
  const wrong = stageNames.filter((n) => n !== "children" && inPaneStage.get(n) !== n).map((n) => `${n}={${inPaneStage.get(n)}}`);
  assert.deepEqual(wrong, [], "prop not passed through under its own name");
  // `taRef` and `setInput` are not in the stage (the entry cards of the empty chat are gone) — the composer still gets both (list
  // `passedThrough`).
  for (const r of ["msgsRef", "stickRef", "activeIdRef", "runStartRef"]) {
    assert.ok(new RegExp(`^\\s{2}${r}: React\\.RefObject<`, "m").test(stageType), `${r} is typed as React.RefObject (the same object as in ChatPane)`);
  }
  // A coding chat has no task list any more (no `setTodosOpen` in the stage).
  for (const s of ["setChats", "setSelMenu", "setDragOver", "setFolderView", "setProjPickerOpen", "setHeaderMenu"]) {
    assert.ok(new RegExp(`^\\s{2}${s}: React\\.Dispatch<React\\.SetStateAction<`, "m").test(stageType), `${s} is typed as React.Dispatch`);
  }
  // The composer stands as child in the slot — with its handle and its empty state — and the stage renders the child exactly once,
  // in the base behind the toast and before the context bar.
  assert.ok(stageCall.children.includes("<ChatComposer") && stageCall.children.includes("ref={composerRef}") && stageCall.children.includes("hero={empty}"),
    "the composer stands as child between <ChatStage …> and </ChatStage>");
  assert.ok(!inPaneStage.has("composer") && !stageType.includes("composer:"), "no second slot beside children");
  assert.equal(stage.split("\n").filter((z) => z.trim() === "{children}").length, 1, "the stage renders {children} exactly once");
  const slot = stage.indexOf("\n        {children}\n");
  assert.ok(stage.lastIndexOf("createPortal(", slot) > 0 && stage.indexOf("Context-window usage", slot) > slot, "the slot lies between toast and context bar");
  assert.ok(!/^\s*<ChatComposer\b/m.test(stage) && !stage.includes('from "@/components/chat/ChatComposer"'), "the stage does not render the composer itself — its props do not run through it");
  // Archive: the three props of the stage and the one of the bar are in the contract and go in under their own name — the hook
  // delivers them INDIVIDUALLY (`const { archived, … } = useArchive(…)`), an `archive.archived` would be the value of an object
  // nobody else knows.
  for (const n of ["archived", "archive", "restore"]) {
    assert.ok(stageNames.includes(n), `ChatStageProps carries ${n}`);
    assert.equal(inPaneStage.get(n), n, `${n}={${n}} on the stage`);
  }
  // Plus `holdOpen` — `ensureChat` holds the just-created, still empty chat with it, which the list leads only after its first message.
  assert.ok(/^\s*const \{ archived, archivedAt, archiveChat, archive, restore, openTarget, holdOpen \} = useArchive\(/m.test(pane), "useArchive delivers the names individually");
});

test("ChatStage: the stage lives only in ChatStage.tsx — no identifier, no building block left in ChatPane; what stays at the measurement stays", () => {
  // The handles of the probes (approval, ask pager, limit strip, autocompact, text size, stream healing) and the building blocks
  // of header, banners, hero, history and base. The working indicator belongs to the stage, not to ChatPane: `<RunDisplay` (in
  // the shared building block chat/RunDisplay.tsx). What runs on the side the stage computes itself for the pill — `useRunningTasks(`
  // belongs to it, not to ChatPane.
  for (const marker of ['data-pop="header"', 'data-pop="project"', "<RunDisplay", "<LimitStrip", "<PermissionPrompt", "<SelectionMenu",
    "<BubbleRow", "<ChatSkeleton", "<ChatFolderView", "<ComposerBase", "useRunningTasks(", "<NativeTaskBar", "<AutocompactMenu", "<ThresholdsMarker",
    "<ContainScope", "<Contained", "ref={msgsRef}", "ref={msgsInnerRef}", "ref={dockRef}", "ref={headerRef}", "useHeightMemory()", "new EndAnchor()",
    "useUserInput(", "useLayoutEffect(", "useGateThreshold(", "nativeTaskList(", "lastAssistantIdx", "heroProjectLabel", "onDragOver=", "onDrop=",
    "setJumpDown(", "paddingTop: headerH + 12", "const historyPresent =", "copyBubbleRef", "answerAskRef", "decidePermissionRef", "cb-kit-veil-top", "cb-kit-veil-bottom",
    "greeting()", "t(\"Jump to latest\")"]) {
    assert.ok(!pane.includes(marker), `remnant of the stage in ChatPane: ${marker}`);
    assert.ok(stage.includes(marker), `missing in ChatStage: ${marker}`);
  }
  // What STAYS in ChatPane: the two refs that open()/send()/answerAsk() and selectionInMessages() touch, the empty state (the
  // composer reads it too), the selection menu with its escape effect, the drop flag (the composer shows it), addFiles, the two
  // pop flags of the global closer, the provider-switch modal.
  for (const stays of ["const msgsRef = useRef<HTMLDivElement>(null);", "const stickRef = useRef(true);",
    // From sending the first message on the chat is no longer empty (`firstInFlight`).
    "const empty = !firstInFlight && (!activeId || (bubbles.length === 0 && !chatLoading));", "function selectionInMessages(): { text: string; rect: DOMRect } | null {",
    "const [selMenu, setSelMenu] = useState<{ text: string; rect: DOMRect } | null>(null);", "const [dragOver, setDragOver] = useState(false);",
    "async function addFiles(source: UploadSource) {", "async function answerAsk(requestId: string, answers: AskAnswer[]) {",
    "const [headerMenu, setHeaderMenu] = useState(false);", "const [projPickerOpen, setProjPickerOpen] = useState(false);",
    // An archived chat is not in the list — its metadata come from `useArchive` (`archiveChat`), the line stays in ChatPane.
    "function pickHeroProject(id: string | null) {", "const activeChat = chats.find((c) => c.id === activeId) ?? archiveChat;", "{providerSwitch && ("]) {
    assert.ok(pane.includes(stays), `missing in ChatPane (belongs there): ${stays}`);
    assert.ok(!stage.includes(stays), `duplicated in ChatStage: ${stays}`);
  }
  // The three writers of stickRef in ChatPane (open, send, answerAsk) — and the stage writes the same object.
  assert.equal([...pane.matchAll(/stickRef\.current = true;/g)].length, 3, "open(), send() and answerAsk() set stickRef in ChatPane");
  assert.ok(stage.includes("if (k !== null) stickRef.current = k;") && stage.includes("stickRef.current = true; // from now on follow the end again"), "the stage writes stickRef in the scroll handler and at the jump arrow");
  assert.equal(inPaneStage.get("dragOver"), undefined, "dragOver does not go into the stage — it only sets it");
  assert.equal(call(pane, "ChatPane").get("dragOver"), "dragOver", "the composer shows dragOver from ChatPane");
  // The global popover closer reads both stage pops — that is why they are state of ChatPane.
  const closer = pane.slice(pane.indexOf("const anyPopOpen ="), pane.indexOf(";", pane.indexOf("const anyPopOpen =")));
  assert.ok(/\bheaderMenu\b/.test(closer) && /\bprojPickerOpen\b/.test(closer), "anyPopOpen reads headerMenu and projPickerOpen");
  assert.ok(!/from "@\/components\/chat\/ChatPane"/.test(stage), "the stage imports nothing from ChatPane");
  assert.ok(!stage.includes("forwardRef(") && !stage.includes("useImperativeHandle("), "no handle: nothing in ChatPane triggers anything on the stage");
  // The stage is rendered unconditionally (its mount is ChatPane's mount — the []-effects of the measurement run equally often).
  const beforeCall = pane.slice(pane.lastIndexOf("\n", pane.lastIndexOf("<ChatStage") - 1) - 200, pane.lastIndexOf("<ChatStage"));
  assert.ok(!/&&\s*\(?\s*$/.test(beforeCall.trimEnd()) && !/\?\s*\(?\s*$/.test(beforeCall.trimEnd()), "the call does not stand behind a condition");
});

test("ChatStage: drop target, approval cards and limit strip are wired to the handlers from ChatPane", () => {
  // Drop target (sabotage "drop target without addFiles"): the root div of the stage accepts files and hands them to addFiles
  // from ChatPane (upload + chip in the composer) — with preventDefault and resetting the drop flag.
  const drop = stage.slice(stage.indexOf("onDrop={(e) => {"), stage.indexOf("}}", stage.indexOf("onDrop={(e) => {")));
  assert.ok(drop.includes("if (!activeId) return;"), "without a chat no drop");
  assert.ok(drop.includes("e.preventDefault();") && drop.includes("setDragOver(false);"), "drop prevents opening the file and resets the flag");
  assert.ok(drop.includes("if (e.dataTransfer.files.length) addFiles(e.dataTransfer);"), "drop target calls addFiles with the DataTransfer (folders are walked, drop-files.test.mjs)");
  assert.equal(inPaneStage.get("addFiles"), "addFiles", "addFiles comes from ChatPane under its own name");
  assert.equal(inPaneStage.get("setDragOver"), "setDragOver");
  const over = stage.slice(stage.indexOf("onDragOver={(e) => {"), stage.indexOf("}}", stage.indexOf("onDragOver={(e) => {")));
  assert.ok(over.includes('e.dataTransfer.types.includes("Files")') && over.includes("setDragOver(true);"), "DragOver with files raises the flag");
  assert.ok(!stage.includes("/api/chats/") || !stage.includes("/attachments"), "the stage does not upload attachments itself");
  // Approval cards: every open request renders PermissionPrompt with decidePermission from ChatPane (the server call and the
  // removal from permReqs live there); the history row gets the same function via the stable ref.
  assert.ok(stage.includes("{permReqs.map((r) => ("), "one card per open approval");
  assert.ok(stage.includes("<PermissionPrompt key={r.requestId} req={r} onDecide={(behavior, extras) => decidePermission(r.requestId, behavior, extras)} />"), "PermissionPrompt decides via decidePermission");
  assert.equal(inPaneStage.get("decidePermission"), "decidePermission");
  assert.ok(stage.includes("decidePermissionRef.current = decidePermission;") && stage.includes("onDecideApproval={onDecideApproval}"), "the history row decides via the same function (stable ref)");
  assert.ok(pane.includes("async function decidePermission(") && !stage.includes("async function decidePermission("), "decidePermission lives in ChatPane");
  // Limit strip: "Try now" and "Start anyway" go to retryLimitNow from ChatPane (body {anyway}).
  const strip = stage.slice(stage.indexOf("<LimitStrip"), stage.indexOf("/>", stage.indexOf("<LimitStrip")));
  assert.ok(strip.includes("onNow={() => retryLimitNow()}") && strip.includes("onAnyway={() => retryLimitNow(true)}") && strip.includes("onAbort={cancelLimitWait}"), "limit strip on retryLimitNow/cancelLimitWait");
  assert.ok(strip.includes("threshold={gateThreshold}") && stage.includes("const gateThreshold = useGateThreshold(isGateWaitRow(limitWait));"), "the gate threshold comes via useGateThreshold in the stage");
  assert.equal(inPaneStage.get("retryLimitNow"), "retryLimitNow");
  assert.ok(pane.includes("async function retryLimitNow(anyway = false) {") && pane.includes("JSON.stringify({ anyway })"), "retryLimitNow lives in ChatPane and sends {anyway}");
  // Question cards: answerAsk from ChatPane, to the history row via the stable ref.
  assert.ok(stage.includes("answerAskRef.current = answerAsk;") && stage.includes("onAnswerAsk={onAnswerAsk}"), "questions are answered via answerAsk from ChatPane");
  assert.equal(inPaneStage.get("answerAsk"), "answerAsk");
});

// Two gaps that sabotages exposed which tsc AND all gate tests left green:
// (1) `{folderView ? null : ( <ChatStage …/> )}` — the stage rendered conditionally (the existing check saw only a `&& (` /
//     `? (` directly before `<ChatStage`); conditional would mean: `useHeightMemory`, measuring effects and the anchor die on
//     hiding. (2) in the stage `stickRef: stickRefProp` destructured and `const stickRef = useRef(stickRefProp.current)` —
//     body, type and call identical, but open()/send()/answerAsk() in ChatPane write into the void. Regex form like the neighbors.
test("ChatStage: the stage stands as a DIRECT child of the cb-kit-stage surface — no expression ({ … }) between surface and <ChatStage", () => {
  // The root div of the surface opens with `cb-kit-stage`; up to the stage only comments ({/* … */}) may stand.
  const start = pane.indexOf('<div className="cb-kit-stage');
  const call = pane.lastIndexOf("<ChatStage");
  assert.ok(start > 0 && call > start, "cb-kit-stage surface before the stage");
  const between = pane.slice(pane.indexOf(">", start) + 1, call).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trim();
  assert.equal(between, "", `code stands between the surface and <ChatStage: ${JSON.stringify(between.slice(0, 60))}`);
  // And after `</ChatStage>` no `)}` closer of an expression before the next comment/element: there the surface of the stage closes
  // (`</div>`), and the right bar follows as a card of its own BESIDE it.
  const after = pane.slice(pane.indexOf("</ChatStage>") + "</ChatStage>".length).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trimStart();
  assert.ok(/^<\/div>\s*<ChatRightSidebar/.test(after), `behind </ChatStage> does not follow "</div>" and the right bar, but: ${JSON.stringify(after.slice(0, 30))}`);
});

test("ChatStage: the shared refs arrive as the SAME object — destructured bare, no ref of its own with the same name, no copy via .current", () => {
  const destr = stage.slice(stage.indexOf("export function ChatStage(props: ChatStageProps) {"), stage.indexOf("} = props;"));
  const body = stage.slice(stage.indexOf("} = props;"));
  for (const r of ["msgsRef", "stickRef", "activeIdRef", "runStartRef"]) {
    assert.ok(new RegExp(`(^|[\\s,{])${r}\\s*[,}\\n]`).test(destr), `${r} is destructured under its own name (no ${r}: alias)`);
    assert.ok(!new RegExp(`\\b${r}\\s*:`).test(destr), `${r} is not renamed`);
    assert.ok(!new RegExp(`\\b(const|let|var)\\s+${r}\\b`).test(body), `no declaration of ${r} of its own in the stage`);
    assert.ok(!new RegExp(`useRef\\([^)]*\\b${r}\\b`).test(body), `no useRef(…${r}…) — the stage does not copy the ref`);
  }
  // The stage creates exactly its own refs — no more (another would be a copy or a new state). `bringAlongRef` is the ONE pending
  // catch-up to the end in the next frame after a layout scroll was clamped at a too small scroll height (a new state, no copy).
  const own = [...body.matchAll(/const (\w+) = useRef[<(]/g)].map((m) => m[1]);
  assert.deepEqual(own, ["msgsInnerRef", "bringAlongRef", "dockRef", "headerRef", "copyBubbleRef", "answerAskRef", "decidePermissionRef"], "the own refs of the stage");
});

// ── The streaming reducer ──
// `onEvent` in ChatPane is only the shell: ONE `setBubbles((prev) => reduceChatEvent(prev, evt, ctx))` at the head,
// `streamRef.current = streamAfterEvent(evt, ctx)` beside it, then the side effects per event kind. Every bubble mutation lives
// in chat/chatBubbles.ts. Two guards: (1) the body of onEvent contains no mutation — no second setBubbles, no bubble literal, no
// `.blocks`, no `streaming:`, no assignment to streamRef besides the one; (2) the event kinds the reducer knows are in ONE list
// here, and the list is held against the reducer, the shell AND the fixtures — a kind that occurs in the recordings and that
// nobody assigned to a side is red; a kind the reducer loses likewise.
// COUNTER-TESTS: a `setBubbles((prev) => [...prev, …])` in onEvent => (1) red; `"limit_line"` dropped from the reducer => (2) red;
// a new scenario with "run_error" in the fixtures without an entry here => (2) red.
const bubbles = read("src/components/chat/chatBubbles.ts");
const onEventBody = (() => {
  const start = pane.indexOf("  function onEvent(evt: Record<string, any>) {");
  assert.ok(start >= 0, "onEvent is in ChatPane.tsx");
  const end = pane.indexOf("\n  // ── Actions ──", start);
  assert.ok(end > start, "the mark ── Actions ── follows onEvent");
  return pane.slice(start, end);
})();
// Comments removed: whole lines, block comments and " // …" at the line end (with a space before — a "://" in a URL stays).
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/ \/\/ .*$/gm, "");

test("reducer: onEvent in ChatPane is the shell — one setBubbles at the head, no bubble mutation in the body", () => {
  const code = withoutComments(onEventBody);
  const setBubblesCalls = [...code.matchAll(/setBubbles\(/g)].length;
  // The cache reconciliation in "connected" goes through `reconcileAfterConnected` (chatCache.ts) — onEvent mutates only via the
  // reducer.
  assert.equal(setBubblesCalls, 1, "exactly one setBubbles in onEvent: the reducer call at the head");
  assert.ok(code.includes("if (activeIdRef.current) reconcileAfterConnected(activeIdRef.current, evt, !reconnected);"), "\"connected\" reconciles via the hook");
  assert.ok(code.includes("setBubbles((prev) => reduceChatEvent(prev, evt, ctx));"), "the reducer call stands literally");
  assert.ok(code.includes("streamRef.current = streamAfterEvent(evt, ctx);"), "the stream state comes from streamAfterEvent");
  assert.ok(code.indexOf("const ctx = reducerCtx();") < code.indexOf("setBubbles((prev) => reduceChatEvent"), "the snapshot stands BEFORE the reducer call");
  const header = code.indexOf("streamRef.current = streamAfterEvent(evt, ctx);");
  assert.ok(header < code.indexOf('if (evt.type === "harness")'), "snapshot, reducer and stream state stand before the first switch");
  // Marks of a mutation that must no longer occur in the body.
  for (const marker of ['{ role: "', ".blocks", "streaming:", "streamRef.current = {", "streamRef.current.open", "streamRef.current.gotText", "startAssistant(", "pushAsk(", "pushApproval(", "pushCapture(", "pushChannel(", "appendText(", "appendThinking(", "addTool(", "upsertTool(", "setToolResult(", "finish(", "attachSummaryToLast(", "startInjectedTurn(", "appendUserMessage(", "seedStreamedText(", "applyClear(", "addError(", "markAskAnswered(", "markApprovalDecided(", "mutateBlocks(", "closeOpenAsks(", "resultToText("]) {
    assert.ok(!code.includes(marker), `mutation mark in the body of onEvent: ${JSON.stringify(marker)}`);
  }
  // What refs the shell reads, it reads AFTER the snapshot only for side effects — the reducer gets only ctx. The fields of the
  // snapshot are in reducerCtx.
  const ctxBuild = pane.slice(pane.indexOf("const reducerCtx = (): ReducerCtx => ({"), pane.indexOf("});", pane.indexOf("const reducerCtx = (): ReducerCtx => ({")));
  for (const field of ["stream: streamRef.current", "now: Date.now()", "wfStatus: wfRunRef.current?.status", "activeId: activeIdRef.current", "joined: joinedMidRunRef.current", "runStart: runStartRef.current", "inTok: inTokensRef.current", "outTok: outTokensRef.current", "t, resultToText"]) {
    assert.ok(ctxBuild.includes(field), `reducerCtx carries ${field}`);
  }
  // The four mutators that are called outside the stream are shells over the pure versions.
  for (const [name, pure] of [["addError", "addErrorPure(prev, text)"], ["applyClear", "applyClearPure(prev, at)"], ["markAskAnswered", "markAskAnsweredPure(prev, requestId, answers, overChannel)"], ["markApprovalDecided", "markApprovalDecidedPure(prev, requestId, ruling)"]]) {
    assert.ok(pane.includes(`setBubbles((prev) => ${pure})`), `${name} in ChatPane calls the pure version: ${pure}`);
  }
  // And the reducer itself knows no React, no setter, no ref, no clock, no fetch.
  const reducer = withoutComments(bubbles.slice(bubbles.indexOf("// ── Streaming reducer ──")));
  for (const forbidden of ["useState", "useRef", "useEffect", "setBubbles", "setState", "Date.now(", ".current", "fetch(", "from \"react\"", "window.", "document."]) {
    assert.ok(!reducer.includes(forbidden), `the reducer contains ${JSON.stringify(forbidden)} — it would no longer be pure`);
  }
  assert.ok(!/^import .* from "@\/[^"]+";$/m.test(bubbles.replace(/^import \{ type [^}]*\} from "@\/[^"]+";$/gm, "").replace(/^import type [^;]*;$/gm, "")), "chatBubbles.ts imports only types via @/ (leaf module)");
});

// The event kinds of the chat stream, in two lists: what the reducer processes (bubbles), and what only the shell processes
// (states, reloading). Together they cover every kind that occurs in the recordings.
const IN_REDUCER = {
  harness: ["connected", "run_started", "run_done", "run_aborted", "run_error", "compacted", "cleared", "permission_request", "approval_ruling", "permission_resolved", "ask_request", "ask_resolved", "channel_message", "capture_message", "message_injected", "user_message", "goal_check", "monitor", "workflow_step", "limit_line", "workflow_marker", "workflow_approval", "workflow_approval_decided"], // workflow_marker: start/end marker of a dynamic workflow; workflow_approval(_decided): approval card
  types: ["harness", "stream_event", "user", "assistant", "result", "row"], // row: a history row outside the turn stream, bubbles only
  stream_event: ["content_block_delta", "content_block_start"],
};
const ONLY_WRAPPER = {
  harness: ["compacting", "compact_failed", "message_queue", "title", "run_waiting", "run_busy", "background", "workflow_run", "limit_wait", "artifact_changed", "folder_context_changed", "provider", "chat_settings", "target"], // provider: the provider of the last response (context bar only); chat_settings: instance switch — chat list and reloading, no bubble; target: goal or pause changed via PATCH — row, cache and list, no bubble
  types: ["system"],
  stream_event: ["message_start", "message_delta"],
};
// Kinds that ONLY the reducer knows — without a branch in the shell because they trigger nothing there (no side effect): the
// start/end marker of a dynamic workflow, the approval card of a dynamic workflow and its decision (the card calls the server
// itself). A new line in ChatPane.tsx is forbidden (the line guard is at the limit), and an empty branch would only be a line
// saying "goes to the reducer". The list does not lie: its kinds are in the reducer and NOT in the shell (checked below).
const WITHOUT_WRAPPER = ["workflow_marker", "workflow_approval", "workflow_approval_decided"];
const subtypesIn = (code) => [...new Set([...code.matchAll(/evt\.subtype === "([a-z_]+)"/g)].map((m) => m[1]))];
const typesIn = (code) => [...new Set([...code.matchAll(/evt\.type === "([a-z_]+)"/g)].map((m) => m[1]))];
const evTypesIn = (code) => [...new Set([...code.matchAll(/ev\.type === "([a-z_]+)"/g)].map((m) => m[1]))];

test("reducer: the event kinds of the reducer are in the list, the shell knows the rest, and the fixtures know no third", () => {
  const reducer = withoutComments(bubbles.slice(bubbles.indexOf("function apply(")));
  assert.deepEqual(subtypesIn(reducer).sort(), [...IN_REDUCER.harness].sort(), "harness kinds in the reducer (apply) == IN_REDUCER.harness");
  assert.deepEqual(typesIn(reducer).sort(), [...IN_REDUCER.types].sort(), "event types in the reducer == IM_REDUCER.types");
  assert.deepEqual(evTypesIn(reducer).sort(), [...IN_REDUCER.stream_event].sort(), "stream_event kinds in the reducer");
  // The switch of the background hook is also part of the shell: `onEvent` calls it for every event, and `run_busy`/`background`
  // have their only branch there (they set only background states).
  const hgBody = background.slice(background.indexOf("function backgroundEvent("), background.indexOf("\n  }\n", background.indexOf("function backgroundEvent(")));
  assert.ok(onEventBody.includes("backgroundEvent(evt);"), "onEvent feeds the background hook");
  const wrapper = withoutComments(onEventBody) + withoutComments(hgBody);
  const allHarness = [...IN_REDUCER.harness, ...ONLY_WRAPPER.harness];
  const inTheWrapper = allHarness.filter((a) => !WITHOUT_WRAPPER.includes(a));
  for (const a of WITHOUT_WRAPPER) {
    assert.ok(IN_REDUCER.harness.includes(a), `${a} is in WITHOUT_WRAPPER, but not in the reducer`);
    assert.ok(!subtypesIn(wrapper).includes(a), `${a} now has a branch in the shell — remove it from WITHOUT_WRAPPER`);
  }
  // The kinds of the background switch stand as `case` in backgroundAfter (lib/agents.ts).
  assert.ok(hgBody.includes("backgroundAfter(s, evt)"), "the hook's switch advances the state via backgroundAfter");
  assert.deepEqual([...new Set([...subtypesIn(wrapper), ...casesIn(hgAfter)])].sort(), [...inTheWrapper].sort(), "the shell (onEvent + background switch) lists every harness kind — those of the reducer as a branch for their side effect");
  for (const s of ONLY_WRAPPER.harness) assert.ok(!IN_REDUCER.harness.includes(s), `${s} is in both lists`);
  assert.deepEqual(evTypesIn(wrapper).sort(), [...IN_REDUCER.stream_event, ...ONLY_WRAPPER.stream_event].sort(), "stream_event kinds of the shell");
  // The fixtures: every occurring kind is assigned to a side.
  const fixtures = path.resolve(here, "fixtures", "streams");
  const seen = { harness: new Set(), types: new Set(), stream_event: new Set() };
  for (const file of fs.readdirSync(fixtures).filter((f) => f.endsWith(".sse.jsonl"))) {
    for (const row of fs.readFileSync(path.join(fixtures, file), "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(row);
      seen.types.add(e.type);
      if (e.type === "harness") seen.harness.add(e.subtype);
      if (e.type === "stream_event" && e.event?.type) seen.stream_event.add(e.event.type);
    }
  }
  const allTypes = [...IN_REDUCER.types, ...ONLY_WRAPPER.types];
  for (const s of seen.harness) assert.ok(allHarness.includes(s), `harness kind from the fixtures without assignment: ${s}`);
  for (const s of seen.types) assert.ok(allTypes.includes(s), `event type from the fixtures without assignment: ${s}`);
  // The stream_event kinds that only close the state of a bubble (content_block_stop, message_stop) are processed by neither
  // side — they are listed here explicitly so that a new kind stands out.
  const silentStreamEvents = ["content_block_stop", "message_stop"];
  for (const s of seen.stream_event) assert.ok([...IN_REDUCER.stream_event, ...ONLY_WRAPPER.stream_event, ...silentStreamEvents].includes(s), `stream_event kind from the fixtures without assignment: ${s}`);
  // And the cores the recordings must carry (streams.test.mjs measures the sequence; here only: they are there).
  for (const s of ["connected", "user_message", "run_started", "run_done", "ask_request", "ask_resolved", "limit_line", "limit_wait", "compacting", "compacted", "message_injected"]) assert.ok(seen.harness.has(s), `fixture core missing: ${s}`);
  for (const s of ["system", "stream_event", "assistant", "user", "result"]) assert.ok(seen.types.has(s), `fixture core missing: ${s}`);
});

// The stream hook had no guard (`useChatStream` called conditionally or `esRef` duplicated in ChatPane — tsc and all gate tests
// stayed green). The same form as for the stage: the hook is called exactly once and unconditionally, its five refs come
// destructured from it and are not created again in ChatPane; the hook itself knows exactly its five refs.
test("useChatStream: once, unconditionally, and the five stream refs exist only in the hook", () => {
  const stream = read("src/components/chat/chatStream.ts");
  const calls = [...pane.matchAll(/useChatStream\(/g)].length;
  assert.equal(calls, 1, "exactly one call of useChatStream in ChatPane");
  const row = pane.split("\n").find((l) => l.includes("useChatStream("));
  assert.match(row, /^  const \{ .* \} = useChatStream\(\{ activeIdRef, onEvent \}\);$/, "at component level (two spaces), not in a branch or body");
  const refs = ["esRef", "streamSeenRef", "streamReadyRef", "esRetryRef", "esWatchdogRef"];
  for (const r of refs) {
    assert.ok(row.includes(r), `${r} comes from the hook`);
    assert.ok(!new RegExp(`\\b(const|let|var)\\s+${r}\\b`).test(pane), `no declaration of ${r} of its own in ChatPane`);
    assert.ok(new RegExp(`const ${r} = useRef`).test(stream), `${r} is created in the hook`);
  }
  const own = [...stream.matchAll(/const (\w+) = useRef[<(]/g)].map((m) => m[1]);
  assert.deepEqual(own, refs, "the hook creates exactly the five stream refs");
  assert.ok(!pane.includes("new EventSource("), "the connection is opened only in the hook");
});

// ── Slash switch, provider-switch sheet, history cache ────────────────────────────────────────────────────
const slash = read("src/components/chat/chatSlash.ts");
const sheet = read("src/components/chat/ProviderSwitchModal.tsx");
const cache = read("src/components/chat/chatCache.ts");
const catalog = read("src/components/chat/ChatCatalog.tsx");
// The two hooks that brought ChatPane under the line guard.
const modelChoice = read("src/components/chat/chatModelChoice.ts");
const background = read("src/components/chat/chatBackground.ts");
// The semantics of the background state stand as a pure transition function in lib/agents.ts (the kinds as `case`, the hook's
// switch checks only the set BACKGROUND_KINDS); it is tested in agents.test.mjs.
const agentsLib = read("src/lib/agents.ts");
const hgAfter = agentsLib.slice(agentsLib.indexOf("export function backgroundAfter("), agentsLib.indexOf("\n}\n", agentsLib.indexOf("export function backgroundAfter(")));
const casesIn = (code) => [...new Set([...code.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]))];
const hgKinds = (() => { const m = agentsLib.match(/BACKGROUND_KINDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/); return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : []; })();
const modelChoiceRow = pane.split("\n").find((l) => l.includes("= useModelChoice(")) ?? "";
const modelChoiceCall = modelChoiceRow.slice(0, modelChoiceRow.indexOf("= useModelChoice("));
// Prop/field names of an `export type X = { … }` block: one line per value (`  name:` or `  name?:`).
const typeFields = (source, type) => {
  const start = source.indexOf(`export type ${type} = {`);
  assert.ok(start >= 0, `${type} is in the file`);
  return [...source.slice(start, source.indexOf("\n};", start)).matchAll(/^\s{2}([A-Za-z]+)\??:/gm)].map((m) => m[1]);
};
const shorthand = (list) => list.split(", ").map((x) => x.trim());

test("runSlash: the switch in chatSlash.ts knows every command of the table, ChatPane holds only the shell with the handler map — every handler under its own name", () => {
  // Table (SLASH_COMMANDS in the catalog) and switch (`cmd === "…"` in chatSlash.ts) know the same names.
  const boardBlock = catalog.slice(catalog.indexOf("const SLASH_COMMANDS"), catalog.indexOf("\n];", catalog.indexOf("const SLASH_COMMANDS")));
  const board = [...boardBlock.matchAll(/name: "([a-z]+)"/g)].map((m) => m[1]);
  const branches = [...slash.matchAll(/cmd === "([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(board.length >= 9, `the table carries at least nine commands (measured: ${board.length})`);
  for (const b of board) assert.ok(branches.includes(b), `table command without branch in the switch: ${b}`);
  for (const z of branches) assert.ok(board.includes(z), `branch without table entry (invisible command): ${z}`);
  assert.equal([...pane.matchAll(/cmd === "/g)].length, 0, "no command branch is left in ChatPane");
  assert.ok(!pane.includes("SLASH_RE"), "ChatPane no longer reads SLASH_RE — the recognition lies in the switch");
  // The type, the destructuring at the head of the switch and the map of the shell carry the same names in the same order.
  const type = typeFields(slash, "SlashHandler");
  const header = slash.match(/^export async function runSlash\(text: string, attachments: Attachment\[\], h: SlashHandler\)[^\n]*\n  const \{ (.*) \} = h;$/m);
  assert.ok(header, "the switch destructures the handler map in ONE line directly under the signature");
  assert.deepEqual(shorthand(header[1]), type, "destructuring == fields of SlashHandler (order of first access)");
  const wrapper = pane.match(/^  async function runSlash\(text: string, attachments: Attachment\[\] = \[\]\): Promise<boolean \| \{ send: string; display: string \}> \{\n    return runSlashPure\(text, attachments, \{ (.*) \}\);\n  \}$/m);
  assert.ok(wrapper, "runSlash in ChatPane is only the shell: one line `return runSlashPure(text, attachments, { … });`");
  const map = shorthand(wrapper[1]);
  assert.deepEqual(map, type, "the handler map of the shell carries exactly the fields of SlashHandler");
  for (const name of map) {
    assert.match(name, /^[A-Za-z]+$/, `handler not under its own name (shorthand): ${name}`);
    assert.ok(new RegExp(`\\b(const|let|function|async function)\\s+(\\[[^\\]]*\\b)?${name}\\b|\\b${name}\\b[^\\n]*=\\s*use[A-Z]|\\[${name}, set`).test(pane), `handler ${name} comes from ChatPane (declaration there)`);
  }
  assert.ok(pane.includes('import { runSlash as runSlashPure } from "@/components/chat/chatSlash";'), "the shell imports the switch as runSlashPure");
  assert.equal([...pane.matchAll(/\brunSlash\(/g)].length, 2, "runSlash in ChatPane: the shell and its only caller (send)");
  // The switch is pure behavior: no React, no hook, no state, no ref writing.
  for (const forbidden of ['from "react"', "useState", "useRef", "useEffect", "useCallback", "setState", "activeIdRef.current =", "window.", "document."]) {
    assert.ok(!slash.includes(forbidden), `chatSlash.ts contains ${JSON.stringify(forbidden)}`);
  }
});

// The workflow button in the composer is gone with marker, preselection and manual start; the third group of the slash picker is
// the GRAPH workflows of the chat as `workflow:<shortname>`. Every list that offers "/name" must be fetched fresh on OPENING —
// one created in the meantime would be missing until the chat switch, a deleted one would run into the server's rejection.
// COUNTER-TESTS: the call from `updateSlash` moved into an effect on `activeId` => red; the group added to the stock
// unconditionally => red; the button `data-pop="workflow"` back => red.
test("slash picker: the graph workflows arrive on EVERY opening via the two routes", () => {
  const start = composer.indexOf("function updateSlash(");
  assert.ok(start > 0, "updateSlash is in the composer");
  const body = composer.slice(start, composer.indexOf("\n  }\n", start));
  // There is only the coding chat (no `if (withPickers)` guard any more).
  assert.match(body, /if \(q !== null && slashQ === null\) \{[\s\S]*\n\s*loadGraphList\(\);/, "fetched when the picker OPENS");
  assert.equal([...composer.matchAll(/loadGraphList\(\)/g)].length, 1, "exactly one call, the one on opening — no second load time (not on chat switch either)");
  const loader = composer.slice(composer.indexOf("const loadGraphList = useCallback("), composer.indexOf("}, [wsId, focusProjectId]);", composer.indexOf("const loadGraphList = useCallback(")));
  assert.ok(loader.includes("`/api/chats/${id}/workflows`") && loader.includes("`/api/workspaces/${wsId}/effective-workflows?projectId=${focusProjectId ?? \"\"}`"),
    "the same two routes as the old button: the chat, otherwise (draft) the effective view of the workspace with the focus project");
  assert.match(composer, /\.\.\.graphEntries\(graphList, t\("This workflow has no description\."\)\),/, "the group is in the stock");
  assert.ok(composer.includes('titleWorkflows={t("Workflows")}'), "the group is called \"Workflows\"");
  for (const way of ["loadDynWorkflows", "dynWfList", "DynWorkflowShort", "wfSel", "wfPickOpen", "loadWorkflowList", 'data-pop="workflow"', 'titleWorkflows={t("Dynamic workflows")}']) {
    assert.ok(!composer.includes(way), `the composer still contains ${way}`);
  }
  for (const way of ["loadDynWorkflows", "dynWorkflowNames", "dynWorkflowCall", "DynWorkflowShort", "wfSel", "wfPickOpen", "loadWorkflowList", "dynWorkflow }", "/workflow`, {"]) {
    assert.ok(!pane.includes(way), `ChatPane still contains ${way}`);
  }
  assert.ok(!slash.includes("dynWorkflowCall(") && !slash.includes("dynWorkflowNames:") && !slash.includes("dynWorkflowNames,"), "the slash switch no longer knows a dynamic workflow (no interception, no field of the handler map)");
  assert.ok(!/name: "workflows?"/.test(catalog), "no local command /workflow or /workflows (the mention goes to the server; the CLI knows /workflows)");
});

test("composer handle: only `clear` — the picker loads the graph list itself", () => {
  const type = composer.slice(composer.indexOf("export type ChatComposerHandle = {"), composer.indexOf("\n};", composer.indexOf("export type ChatComposerHandle = {")));
  assert.deepEqual([...type.matchAll(/^\s{2}([A-Za-z]+)\(/gm)].map((m) => m[1]), ["clear"], "the handle has exactly one method");
  const handle = composer.slice(composer.indexOf("useImperativeHandle(ref, () => ({"), composer.indexOf("}));", composer.indexOf("useImperativeHandle(ref, () => ({")));
  assert.deepEqual([...handle.matchAll(/^\s{4}([A-Za-z]+)\(\)/gm)].map((m) => m[1]), ["clear"], "useImperativeHandle creates exactly `clear`");
  assert.deepEqual([...pane.matchAll(/composerRef\.current\?\.([A-Za-z]+)\(/g)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i), ["clear"], "ChatPane calls only `clear` on the handle");
});

test("ProviderSwitchModal: ChatPane passes every prop of the contract under its own name, no foreign one; the sheet lives only in ProviderSwitchModal.tsx, rendered conditionally as before", () => {
  const type = typeFields(sheet, "ProviderSwitchModalProps");
  assert.equal(type.length, 7, "seven props");
  const start = pane.indexOf("<ProviderSwitchModal");
  assert.ok(start >= 0, "ChatPane renders <ProviderSwitchModal");
  const call = new Map([...pane.slice(start, pane.indexOf("/>", start)).matchAll(/\b([A-Za-z]+)=\{([^}]*)\}/g)].map((m) => [m[1], m[2].trim()]));
  for (const p of type) assert.ok(call.has(p), `required prop not passed: ${p}`);
  for (const [p, value] of call) { assert.ok(type.includes(p), `foreign prop on the sheet: ${p}`); assert.equal(value, p, `prop ${p} not under its own name: ${value}`); }
  assert.match(pane.slice(pane.lastIndexOf("\n", start) - 40, start), /\{providerSwitch && \(\n\s+$/, "rendered conditionally as before: `{providerSwitch && (` directly before the sheet");
  // No modal remnant in ChatPane: the glass sheet, its texts, the storage write access and the confirm path lie only in the sheet.
  for (const marker of ["<Modal ", "Don't show again", "Compact & switch", "compacting…", "localStorage.setItem(PROVIDER_SWITCH_NOWARN", 't("Switch to")', "const target = providerSwitch;"]) {
    assert.ok(!pane.includes(marker), `modal remnant in ChatPane: ${JSON.stringify(marker)}`);
    assert.ok(sheet.includes(marker), `missing in the sheet: ${JSON.stringify(marker)}`);
  }
  assert.ok(pane.includes("async function pickModel(") && pane.includes("async function doProviderSwitch("), "pickModel and doProviderSwitch stay in ChatPane");
  assert.ok(pane.includes("localStorage.getItem(PROVIDER_SWITCH_NOWARN)"), "the pre-check \"don't warn\" stays in pickModel");
  assert.ok(sheet.includes("await doProviderSwitch(target.providerId, target.model);") && sheet.includes("setProviderSwitch(null);"), "confirm calls doProviderSwitch from ChatPane and closes afterwards");
  assert.ok(sheet.startsWith('"use client";\n'), "the sheet is a client component");
  assert.equal([...sheet.matchAll(/\buse[A-Z]\w*\(/g)].length, 0, "the sheet holds no state — checkbox and target come from ChatPane");
});

test("useHistoryCache: once, unconditionally, at the place of the cache ref; the three cache hooks exist only in the hook; the getter carries exactly the deps of the type under their own names; open() stays", () => {
  assert.equal([...pane.matchAll(/useHistoryCache\(/g)].length, 1, "exactly one call of useHistoryCache in ChatPane");
  const row = pane.split("\n").find((l) => l.includes("useHistoryCache("));
  // The returns include `applyReconcile` (the rule from lib/history-reconcile instead of "only without busy"), `reconcileAfterConnected`
  // and `afterTheLoad` (reconciliation against the state in "connected"), `loadOlder` (older page in front) and `windowOf` (are there
  // rows before?).
  const m = row.match(/^  const \{ chatCacheRef, putChatCache, dropChatCache, syncChatCache, reloadOpenChatLog, revalidateChat, applyReconcile, reconcileAfterConnected, afterTheLoad, loadOlder, windowOf \} = useHistoryCache\(\(\) => \(\{ (.*) \}\)\);$/);
  assert.ok(m, "at component level, all eleven returns destructured, the deps as getter object");
  const deps = shorthand(m[1]);
  assert.deepEqual(deps, typeFields(cache, "HistoryCacheDeps"), "getter object == fields of HistoryCacheDeps");
  for (const d of deps) assert.match(d, /^[A-Za-z]+$/, `dep not under its own name: ${d}`);
  // Position: between the stream hook and the first useMemo after it — there the cache ref stood.
  const iStream = pane.indexOf("= useChatStream("), iCache = pane.indexOf("= useHistoryCache("), iMemo = pane.indexOf("const newChatFolders = useMemo(");
  assert.ok(iStream > 0 && iStream < iCache && iCache < iMemo, "useHistoryCache stands after useChatStream and before newChatFolders (the old hook position of the cache ref)");
  // The three hooks and the three reconcile functions exist only in the hook; open() stays in ChatPane. `syncChatCache` is a queue
  // per chat via `syncOnce` (ONE reconciliation at a time) — no longer `async`.
  for (const marker of ["const chatCacheRef = useRef", "const putChatCache = useCallback", "const dropChatCache = useCallback", "function syncChatCache(", "async function syncOnce(", "async function reloadOpenChatLog(", "async function revalidateChat(", "function applyReconcile(", "function afterTheLoad(", "CHAT_CACHE_MAX"]) {
    assert.ok(!pane.includes(marker), `cache remnant in ChatPane: ${marker}`);
    assert.ok(cache.includes(marker), `missing in the hook: ${marker}`);
  }
  // `afterCreation` — ensureChat opens the just-created chat without taking the marker of the first message.
  assert.ok(pane.includes("  async function open(id: string, { afterCreation = false }: { afterCreation?: boolean } = {}) {"), "open() stays in ChatPane");
  // Without cache the stream comes first, the artifacts come in parallel and afterwards into the entry; applied via
  // `applyReconcile` with the empty base; the reconciliation from the cache gets the cache history as base. `log` is the window
  // `{ total, lastId, older, rows }` (lib/api/log-window.ts).
  assert.ok(pane.includes("putChatCache(id, { ...log, bubbles: bs, chat, artifacts: [] });") && pane.includes("revalidateChat(id, seq, cached.bubbles).catch(console.error);"), "open() calls putChatCache and revalidateChat from the hook");
  assert.ok(pane.includes("applyReconcile(id, empty, bs);") && pane.includes("afterTheLoad(id);"), "open() applies the loaded history via the rule and then reconciles against \"connected\"");
  // After creation no reconciliation — its GET overwrote the goal of a `/goal X` in the fresh chat.
  assert.ok(pane.includes("if (!afterCreation) revalidateChat(id, seq, cached.bubbles).catch(console.error);"), "open() does not reconcile a just-created chat");
  const hookCalls = [...withoutComments(cache).matchAll(/\b(use[A-Z]\w*)[<(]/g)].map((x) => x[1]).filter((h) => h !== "useHistoryCache");
  // Plus the per-chat queue ref and `connectedRef` (the remembered "connected"), `useState` (tick of sorting in — `windowOf` is read
  // while rendering), the loading-full state, the resolve ref, `depsRef` and the `useEffect` of the event that loads a truncated
  // row in full.
  assert.deepEqual(hookCalls, ["useRef", "useState", "useCallback", "useCallback", "useRef", "useRef", "useRef", "useRef", "useRef", "useEffect"], "the hook calls exactly these hooks — in this order");
  assert.ok(cache.includes("\n  return { chatCacheRef, putChatCache, dropChatCache, syncChatCache, reloadOpenChatLog, revalidateChat, applyReconcile, reconcileAfterConnected, afterTheLoad, loadOlder, windowOf };\n"), "the hook returns exactly the eleven");
  // Every function that reads deps fetches them in ONE line at the head (state of the render, like the old closure). Both read
  // `targetStatusRef` too — a GET that went out before the last setting of the target no longer shows its target (it would
  // overwrite a just-set pause). `bubblesRef` is not among the deps — the base of a reconciliation comes from React's queue
  // (`baseAfterQueued(setBubbles)`), applied inside the updater; `reloadOpenChatLog` takes `keepError` (the error bubble of
  // run_error stays), `applyReconcile` the state of the result (`lastId`) — guard and counter-tests in web/test/chat-open.test.mjs.
  assert.match(cache, /async function reloadOpenChatLog\(id: string, opts\?: \{ keepError\?: boolean \}\) \{\n    const \{ activeIdRef, setBubbles, setCtxTokens, setGoal, targetStatusRef \} = deps\(\);\n/, "reloadOpenChatLog destructures at the head");
  // revalidateChat takes the base of the reconciliation (open(): the cache history; otherwise the one after everything queued) and
  // sets nothing itself — `applyReconcile` does; the two other functions read their deps likewise in one line at the head.
  assert.match(cache, /async function revalidateChat\(id: string, seq: number, base\?: Bubble\[\]\) \{\n    const \{ openSeqRef, activeIdRef, busyRef, setCtxTokens, setGoal, loadArtifacts, targetStatusRef, setBubbles \} = deps\(\);\n/, "revalidateChat destructures at the head");
  assert.match(cache, /function applyReconcile\(id: string, base: Bubble\[\], bs: Bubble\[\], lastId = chatCacheRef\.current\.get\(id\)\?\.lastId \?\? 0\) \{\n    const \{ setBubbles, activeIdRef, busyRef, joinedMidRunRef \} = deps\(\);\n/, "applyReconcile destructures at the head");
  assert.match(cache, /function afterTheLoad\(id: string\) \{\n    const \{ setBubbles, activeIdRef \} = deps\(\);\n/, "afterTheLoad destructures at the head");
  // Three more functions read deps, each once at the head — `applyRowsAn`, `loadOlder`, `resolveTruncation`; the event of the
  // truncated row reads them via `depsRef` (an effect that is not re-attached on every render).
  assert.match(cache, /async function applyRows\([^\n]*\) \{\n    const \{ activeIdRef \} = deps\(\);\n/, "applyRows destructures at the head");
  assert.match(cache, /function loadOlder\(until\?: number\): Promise<void> \{\n    const \{ activeIdRef, setBubbles \} = deps\(\);\n/, "loadOlder destructures at the head");
  assert.match(cache, /function resolveTruncation\(id: string, row: number\): Promise<void> \{\n    const \{ setBubbles \} = deps\(\);\n/, "resolveTruncation destructures at the head");
  assert.equal([...cache.matchAll(/deps\(\)/g)].length, 7, "deps() is called exactly seven times, once per function at the head — syncChatCache reads nothing from outside");
});

// ── Effort levels: the chain from the server catalog to the picker ─────────────────────────────────────
//
// No choice offers five fixed levels any more, but the MEASURED ones per model (`efforts` from /api/providers, source
// `server/backend/electron/server/providers/connectors/codex.js`). The chain has three places where the information is lost
// silently — each has its guard here, because at none of them a type error or a red probe would arise:
//   1. ChatPane looks for the levels in the list FILTERED to `connected`. If a container stands on `codex connected:false`, its
//      user would permanently get the old choice. Hence two lists: `pickerProviders` (connected, for /model) and `allProviders`
//      (all, for effort).
//   2. ChatPane passes the RAW chat model. A new chat and every old chat carry '' there — that is in no catalog, so the choice
//      would fall back to the default in the most common case (default model gpt-5.5: the picker would offer "Max", measured
//      HTTP 400). Hence the prop is called `effectiveModel` and is resolved beforehand.
//   3. The fallback catalog in ChatCatalog.tsx carries no `efforts`. It applies until /api/providers has answered — and that
//      answer waits for `codex login status` with a 15 s timeout.
//
// COUNTER-TESTS: `effortCatalog={pickerProviders}` in ChatPane => "effort catalog is the UNFILTERED list" red;
// `effectiveModel={currentModel}` => "the effective model" red; an `efforts` dropped from the fallback or a level changed =>
// "the fallback catalog carries the same levels as the server" red; the marker on the collapsed button removed => "the collapsed
// button carries the marker" red.
const effortLib = read("src/lib/effort.ts");
const serverCodex = fs.readFileSync(path.resolve(here, "..", "..", "server", "backend", "electron", "server", "providers", "connectors", "codex.js"), "utf8");
// `efforts` per model id from a `CODEX_MODELS = [ … ]` block (server as web, the same notation). The same for `CLAUDE_MODELS` —
// the empty list (Haiku) becomes `[]`.
const modelLevels = (source, name) => {
  // The DECLARATION, not the first mention: both files name the name earlier in a comment.
  const decl = source.match(new RegExp(`^(?:export )?const ${name}[^\\n]*= \\[$`, "m"));
  assert.ok(decl, `the declaration of ${name} is in the file`);
  const start = decl.index;
  const block = source.slice(start, source.indexOf("\n];", start));
  return new Map([...block.matchAll(/\{ id: "([^"]+)".*?efforts: \[([^\]]*)\]/g)]
    .map((m) => [m[1], m[2].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean)]));
};
const codexLevels = (source) => modelLevels(source, "CODEX_MODELS");

test("effort: the fallback catalog on the web carries the same levels as the server — it applies until /api/providers answers", () => {
  const server = codexLevels(serverCodex);
  const web = codexLevels(catalog);
  assert.ok(server.size >= 7, `the server catalog carries levels for ${server.size} models`);
  assert.deepEqual([...web.keys()], [...server.keys()], "the same models in the same order");
  for (const [id, levels] of server) assert.deepEqual(web.get(id), levels, `levels of ${id}`);
  // The marker `onlyApiKey` is server-side and never goes out — it must not appear on the web.
  assert.ok(!catalog.includes("onlyApiKey"), "the web catalog does not know `onlyApiKey` (the server filters, the client does not check)");
});

// The CLAUDE side of the same catalog: the same models with label and context window stand in TWO places —
// `providers/connectors/claude.js` (the answer of /api/providers) and `ChatCatalog.tsx` (the fallback until it is there). The
// concrete error of tomorrow: a new model in the server catalog, forgotten in the fallback — and it is not selectable for the
// first 15 seconds of every load, because /api/providers waits for `codex login status`.
const serverClaude = fs.readFileSync(path.resolve(here, "..", "..", "server", "backend", "electron", "server", "providers", "connectors", "claude.js"), "utf8");
// id -> { label, context } from a `CLAUDE_MODELS = [ … ]` block. The number comes once with and once without thousands underscore
// (`1000000` / `1_000_000`) — the VALUE is compared.
const claudeModels = (source, location) => {
  const decl = source.match(/^(?:export )?const CLAUDE_MODELS[^\n]*= \[$/m);
  assert.ok(decl, `the declaration of CLAUDE_MODELS is in ${location} — renamed? Update the anchor, do not drop the test`);
  const start = decl.index;
  const block = source.slice(start, source.indexOf("\n];", start));
  const hits = [...block.matchAll(/\{ id: "([^"]+)", label: "([^"]*)", context: ([0-9_]+)/g)];
  assert.ok(hits.length >= 5, `only ${hits.length} models in ${location} — does the regex still match?`);
  return new Map(hits.map((m) => [m[1], { label: m[2], context: Number(m[3].replace(/_/g, "")) }]));
};

test("catalog: the Claude fallback on the web carries the same models as the server — ids, names and context windows", () => {
  const server = claudeModels(serverClaude, "providers/connectors/claude.js");
  const web = claudeModels(catalog, "ChatCatalog.tsx");
  assert.deepEqual([...web.keys()], [...server.keys()], "the same models in the same order — the picker knows no free text");
  for (const [id, m] of server) {
    assert.equal(web.get(id).label, m.label, `label of ${id}`);
    assert.equal(web.get(id).context, m.context, `context window of ${id} (the context bar relies on it)`);
  }
  // Claude carries `efforts` per model — measured on the pinned CLI, Haiku 4.5 EMPTY ("no levels", no picker). The fallback
  // carries the SAME levels as the server, model by model — also the empty list. If it were missing in the fallback, the picker
  // would offer the default levels on Haiku in the first 15 s.
  const levelsServer = modelLevels(serverClaude, "CLAUDE_MODELS");
  const levelsWeb = modelLevels(catalog, "CLAUDE_MODELS");
  assert.deepEqual([...levelsWeb.keys()], [...server.keys()], "every Claude model of the fallback carries `efforts`");
  assert.deepEqual([...levelsServer.keys()], [...server.keys()], "every Claude model of the server carries `efforts`");
  for (const [id, levels] of levelsServer) assert.deepEqual(levelsWeb.get(id), levels, `levels of ${id}`);
  assert.deepEqual(levelsServer.get("claude-haiku-4-5-20251001"), [], "Haiku 4.5 carries NO levels — empty, not missing");
});

test("effort: ChatPane passes on the UNFILTERED provider list and the EFFECTIVE model — composer as slash switch", () => {
  // The two lists and the effective model stand in the hook `useModelChoice` (chat/chatModelChoice.ts). The promise (levels from
  // the UNFILTERED list, the model resolved) hangs on these lines, whichever file they stand in. Plus: ChatPane takes the values
  // FROM the hook and builds no version of its own beside it — a second, filtered `allProviders` in ChatPane would leave the
  // patterns in the hook green and still take the levels from the composer.
  // Two lists, one difference: `pickerProviders` filters to `connected`, `allProviders` does not.
  assert.match(modelChoice, /const allProviders: \{ id: string; label: string; caps\?: \{ effort\?: boolean \}; models: \{ id: string; label: string; efforts\?: string\[\] \}\[\] \}\[\] =\n\s+providers\.length \? providers : \[/,
    "allProviders is the unfiltered list and carries `efforts` (and `caps`) in the annotation");
  assert.match(modelChoice, /const pickerProviders: [^\n]*=\n\s+providers\.length \? providers\.filter\(\(p\) => p\.connected\) : allProviders;/,
    "pickerProviders is the list filtered to `connected` (fallback: the same base set)");
  for (const n of ["allProviders", "pickerProviders", "effectiveModel", "currentModel", "providers"]) {
    assert.ok(modelChoiceCall.includes(n), `${n} comes in ChatPane from useModelChoice`);
    assert.ok(!new RegExp(`\\b(const|let|var)\\s+${n}\\b`).test(pane), `no declaration of ${n} of its own in ChatPane`);
  }
  assert.equal(inPane.get("effortCatalog"), "allProviders", "the composer gets the effort catalog from the UNFILTERED list");
  assert.notEqual(inPane.get("effortCatalog"), "pickerProviders", "a catalog from the filtered list would take its levels from every logged-out provider");
  // The model: resolved, not raw. `currentModel` comes from the hook but no longer goes to the composer anywhere.
  assert.match(modelChoice, /const effectiveModel = currentModel \|\| providerDefault\(currentProvider\);/, "effectiveModel resolves the empty chat choice to the provider default");
  assert.equal(inPane.get("effectiveModel"), "effectiveModel", "the composer gets the effective model");
  assert.ok(!inPane.has("currentModel"), "the raw chat model no longer goes to the composer — '' would have neither levels nor names there");
  // The same two values in the handler map of the slash switch (shorthand, so under their own name).
  const slashMap = pane.match(/return runSlashPure\(text, attachments, \{ (.*) \}\);/)[1].split(", ").map((x) => x.trim());
  for (const n of ["effectiveModel", "allProviders"]) assert.ok(slashMap.includes(n), `/effort gets ${n}`);
  assert.ok(!slashMap.includes("currentModel"), "the switch no longer gets the raw model");
  assert.match(slash, /effortLevels\(currentProvider, effectiveModel, allProviders\)/, "the /effort branch computes with the effective model and the unfiltered list");
});

test("effort: the composer passes the catalog through to the choice — and the COLLAPSED button carries the marker", () => {
  // The type of the prop is the shared `EffortCatalog` from lib/effort.ts: the `efforts` information stands in ONE place. A newly
  // written form (`{ id; label; models: { id; label }[] }`) would lose it without tsc or a test noticing — exactly the error this
  // guard rules out.
  assert.match(composer, /^\s{2}effortCatalog\?: EffortCatalog;/m, "the prop carries the shared type, no form of its own");
  assert.match(effortLib, /export type EffortCatalog = readonly \{ id: string; defaultModel\?: string; defaultEffort\?: string; caps\?: \{ effort\?: boolean \}; models: readonly \{ id: string; efforts\?: string\[\] \}\[\] \}\[\];/, "EffortCatalog is in lib/effort.ts and carries `efforts` — and `defaultModel`, because an empty model is the provider default, `caps` (caps.effort off => no picker) and `defaultEffort` (the provider's default level for \"Default · <level>\")");
  // The composer gets its entries from the ONE building block `effortEntries` (lib/effort.ts), like suggestion items and workflow
  // settings — with the four arguments plus the word of the empty entry (none: `null`) and `t`. The promise of this guard: catalog
  // and EFFECTIVE model, neither the raw one nor the filtered list — negated for the old AND the new name, otherwise a fallback
  // via the building block would be possible unnoticed.
  assert.match(composer, /effortEntries\(currentProvider, effectiveModel, effortCatalog, currentEffort, null, t\)/, "the choice computes with catalog and effective model — without empty entry");
  for (const name of ["effortSelection", "effortEntries"]) {
    assert.ok(!composer.includes(`${name}(currentProvider, currentModel`), `no fallback to the raw model (${name})`);
    assert.ok(!composer.includes(`${name}(currentProvider, effectiveModel, pickerProviders`), `and none to the filtered list (${name})`);
  }
  // The marker on the collapsed button (house rule: a cap must say that it is one). It used to show a calm "Max", and that the run
  // silently thinks with the CLI default was seen only by those who opened the picker. The button also stands without levels
  // (ultracode switch) — there is nothing to carry there.
  assert.match(composer, /const effortOk = effortNone \|\| effortSupported\(currentProvider, effectiveModel, effortCatalog, currentEffort\);/, "the button asks the same computation as the list");
  const button = composer.slice(composer.indexOf('<div className="relative" data-pop="effort">'), composer.indexOf("{effortPickerOpen && ("));
  assert.ok(button.includes("effortOk ?") && button.includes("text-warn"), "the collapsed button colors itself when the level is not supported");
  assert.ok(button.includes('{effortOk ? "" : " !"}'), "… and appends an exclamation mark to the value (the key is narrow)");
  // The tooltip names the consequence in plain words — and the SUBSTITUTE, not the loss: the clamp at spawn no longer drops an
  // unsupported level but raises it to the highest supported one.
  assert.ok(/title=\{effortOk\n/.test(button) && button.includes("t(effortHint(currentProvider)"), "the tooltip names the consequence in plain words");
  assert.ok(!composer.includes("the run starts with the CLI default"), "and not the old consequence, which has been wrong since the third round");
  assert.match(composer, /const effortFallbackLabel = effortLabel\(effortFallback\(currentProvider, effectiveModel, effortCatalog, currentEffort\)\);/,
    "the substitute comes from the same computation as in the backend (lib/effort.ts: effortFallback)");
  assert.ok(button.includes("aria-label={effortOk ?") && button.includes("effortMarker(currentProvider)"), "and the aria label carries the marker too");
  // The sentence does NOT stand in the component any more: who rejects the level depends on the provider (with Claude the CLI,
  // otherwise the model), and this distinction belongs in ONE place. A sentence built in literally here would be the next to
  // age — exactly how "the run starts with the CLI default" lived on.
  assert.ok(!composer.includes("is not supported by this model"), "the wording stands in lib/effort.ts, not in the composer");
  assert.ok(!composer.includes("EFFORT_NOT_SUPPORTED"), "and the fixed marker is replaced by effortMarker(provider)");
});

test("model picker: a set but unlisted model stands marked in its group", () => {
  // /api/providers withholds the models the logged-in account cannot run. A chat that stands on one of them carried a checkmark on
  // NO entry on the web and showed the raw id in the pill. iOS had healed exactly that (Chat/ChatSheets.swift, `modelMissing`).
  assert.match(composer, /pv\.id === currentProvider && effectiveModel && !pv\.models\.some\(\(mo\) => mo\.id === effectiveModel\)/,
    "the missing choice hangs in the group of ITS provider, not anywhere");
  assert.ok(composer.includes("{ id: effectiveModel, label: currentModelLabel, missing: true }"),
    "it carries the label of the chat (currentModelLabel) and the marker `missing`");
  // The row is drawn by the shared component (components/ModelChoice.tsx, `ModelSearchList` — OpenRouter carries the whole catalog):
  // the composer passes marker and warning color, the component writes every marker in parentheses behind the row. Both are
  // checked together.
  assert.ok(composer.includes('markers: [...(missing ? [t("unavailable")] : [])'), "the row says that it is missing (marker)");
  assert.ok(composer.includes("warn: missing,"), "… in warning color");
  assert.ok(/<ModelSearchList\b/.test(composer), "the composer draws the list with the shared component");
  const modelChoiceComponent = read("src/components/ModelChoice.tsx");
  assert.ok(modelChoiceComponent.includes("{(o.markers ?? []).map((m) => <span key={m} className={`shrink-0 text-[10px] font-normal ${o.warn ? \"\" : \"text-dim\"}`}>({m})</span>)}"),
    "the component writes the markers in parentheses behind the row");
  // The label itself: `modelLabelFor` falls back to the constants table before it shows the id.
  assert.match(catalog, /^const modelLabelFor = /m, "ChatCatalog carries modelLabelFor");
  // The line stands in the model-choice hook; ChatPane takes `currentModelLabel` from it.
  assert.match(modelChoice, /const currentModelLabel = modelLabelFor\(currentProvider, effectiveModel, providers\);/,
    "the model choice labels with it — otherwise \"gpt-5.4\" instead of \"GPT-5.4\" would stand in the pill");
  assert.ok(modelChoiceCall.includes("currentModelLabel") && !/\bconst currentModelLabel\b/.test(pane), "ChatPane takes the label from the hook");
});

// ── Two hooks that keep ChatPane under the line guard ──────────
// ChatPane stood at the 2,000-line limit, and follow-up work puts state, handlers or event branches there. Two things moved
// into hooks under `chat/` (form like `useChatStream`/`useHistoryCache`): the model and effort choice and the background state.
// The guards: per hook exactly one call at component level (unconditional), the return destructured whole and under its own
// names, and in the components no version of its own of what the hook holds.
// COUNTER-TESTS: `activeChat: null` in the call of useModelChoice => "useModelChoice" red; `const [waiting, setWaiting] =
// useState(false);` back in ChatPane => "useBackground" red; `|| evt.subtype === "run_error"` dropped from the hook's switch =>
// "useBackground" red.
// Names from `return { a, b, … };` at the end of a hook (one or several lines).
const hookReturnValue = (source) => {
  const m = source.match(/\n  return \{([^}]*)\};\n\}\s*$/);
  assert.ok(m, "the hook ends with `return { … };`");
  return m[1].split(",").map((x) => x.trim()).filter(Boolean);
};
// Hook calls of a source in order (without comments), without the hook itself.
const hookCallsIn = (source, itself) => [...withoutComments(source).matchAll(/\b(use[A-Z]\w*)[<(]/g)].map((x) => x[1]).filter((h) => h !== itself);

test("useModelChoice: once, unconditionally, behind `activeChat`; ChatPane takes the whole return and holds no provider list of its own", () => {
  assert.equal([...pane.matchAll(/useModelChoice\(/g)].length, 1, "exactly one call of useModelChoice in ChatPane");
  const m = modelChoiceRow.match(/^  const \{ (.*) \} = useModelChoice\(\{ (.*) \}\);$/);
  assert.ok(m, "at component level (two spaces), the return destructured in ONE line, the deps as object");
  assert.deepEqual(shorthand(m[1]), hookReturnValue(modelChoice), "ChatPane destructures exactly the return of the hook, in its order");
  const deps = shorthand(m[2]);
  assert.deepEqual(deps, typeFields(modelChoice, "ModelChoiceDeps"), "deps object == fields of ModelChoiceDeps");
  for (const d of deps) assert.match(d, /^[A-Za-z]+$/, `dep not under its own name: ${d}`);
  // It reads `activeChat` — so it stands behind it (before it would be a TDZ in the render).
  assert.ok(pane.indexOf("const activeChat = ") > 0 && pane.indexOf("const activeChat = ") < pane.indexOf("= useModelChoice("), "useModelChoice stands behind `activeChat`");
  // What the hook holds does not exist in ChatPane again.
  for (const marker of ['"/api/providers"', "useState<ProviderMeta", "setGlobalProvider", "setEffortSel", "DEFAULT_MODEL_FALLBACK", "modelLabelFor(", "effortLabel(", "async function pickEffort(", "function providerDefault(", "async function setUltracode(", "setUltracodeSel"]) {
    assert.ok(!pane.includes(marker), `remnant of the model choice in ChatPane: ${marker}`);
    assert.ok(modelChoice.includes(marker), `missing in the hook: ${marker}`);
  }
  // pickModel and the provider switch stay in ChatPane (see ProviderSwitchModal test) — they read the history.
  assert.ok(!withoutComments(modelChoice).includes("function pickModel(") && !withoutComments(modelChoice).includes("doProviderSwitch"), "pickModel/doProviderSwitch are not in the hook");
  assert.deepEqual(hookCallsIn(modelChoice, "useModelChoice"), ["useState", "useState", "useState", "useState", "useState", "useState", "useState", "useEffect"], "the hook calls seven useState (incl. ultracodeSel) and one useEffect — and nothing else");
});

test("useBackground: ONE hook — ChatPane neither holds nor sets the wait states itself, ONE semantics", () => {
  const back = hookReturnValue(background);
  for (const [who, source] of [["ChatPane", pane]]) {
    assert.equal([...source.matchAll(/useBackground\(/g)].length, 1, `${who}: exactly one call of useBackground`);
    const row = source.split("\n").find((l) => l.includes("= useBackground("));
    const m = row.match(/^  const \{ (.*) \} = useBackground\(bubbles, busy\);$/);
    assert.ok(m, `${who}: at component level, with its own history and its own busy`);
    assert.deepEqual(shorthand(m[1]), back, `${who}: destructures exactly the return of the hook`);
    // The stream feeds the hook: ONE call, at the head of the switch, for every event.
    const turnout = source.slice(source.indexOf("  function onEvent(evt: Record<string, any>) {"));
    const iHg = turnout.indexOf("backgroundEvent(evt);"), iHarness = turnout.indexOf('if (evt.type === "harness")');
    assert.ok(iHg > 0 && iHg < iHarness, `${who}: backgroundEvent(evt) stands before the harness switch of onEvent`);
    // ChatPane calls the setter a SECOND time — in `toDraft`, with a `run_aborted`: the draft has no stream whose `connected` would
    // clear the state of the abandoned chat. The same semantics (backgroundAfter: abort clears everything), no setter of its own.
    const extra = who === "ChatPane" ? 1 : 0;
    assert.equal([...source.matchAll(/backgroundEvent\(/g)].length, 1 + extra, `${who}: backgroundEvent is called ${1 + extra} times`);
    if (extra) {
      const body = source.slice(source.indexOf("  function toDraft() {"), source.indexOf("\n  }\n", source.indexOf("  function toDraft() {")));
      assert.ok(body.includes('backgroundEvent({ type: "harness", subtype: "run_aborted" });'), "ChatPane: the second call is the abort in toDraft");
    }
    // The grep proof: no version of its own, no setter of its own.
    const code = withoutComments(source);
    for (const marker of ["setWaiting", "useState<LiveAgent", "waitAgents", "agentsList", "stateCard(", "stateKey(", "runningBlockIds(", "isAgentCall("]) {
      assert.ok(!code.includes(marker), `${who} holds the background state itself again: ${marker}`);
    }
    assert.ok(!/\bsetWait[A-Z]/.test(code), `${who} sets a wait state itself`);
  }
  // The switch of the hook: exactly the eight kinds that carry the state — as set BACKGROUND_KINDS and as `case` of the pure
  // transition function backgroundAfter (lib/agents.ts). Their semantics (run_done clears only the foreground, abort and error
  // everything) is tested by agents.test.mjs on behavior, not on text.
  const eight = ["background", "connected", "run_aborted", "run_busy", "run_done", "run_error", "run_started", "run_waiting"];
  assert.deepEqual([...hgKinds].sort(), eight, "BACKGROUND_KINDS are exactly the eight kinds");
  assert.deepEqual(casesIn(hgAfter).sort(), eight, "backgroundAfter handles exactly the eight kinds");
  const hgSwitch = withoutComments(background.slice(background.indexOf("function backgroundEvent("), background.indexOf("\n  }\n", background.indexOf("function backgroundEvent("))));
  assert.match(hgSwitch, /if \(evt\.type !== "harness" \|\| !BACKGROUND_KINDS\.has\(evt\.subtype\)\) return;\s*setStatus\(\(s\) => backgroundAfter\(s, evt\)\);/, "the switch: only the eight kinds, advanced via backgroundAfter");
  // Plus the arrival sequence of the "Background Tasks" list (lib/background-tasks.ts) — like the card via a ref and a useMemo
  // with content key, so that it is not new on every token tick.
  assert.deepEqual(hookCallsIn(background, "useBackground"), ["useState", "useMemo", "useMemo", "useMemo", "useRef", "useMemo", "useRef", "useMemo"], "the hook: ONE state, then the derivation (three useMemo, ref, card; ref, sequence)");
});
