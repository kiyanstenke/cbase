// The web UI of the "Instances" tab and of the instance choice in the chat. The COMPUTATION sits in the sheet lib/instances-tree.ts
// and has its own test (instances-tree.test.mjs, bound to iOS); here is what the UI makes of it and what it sends to the server:
//
//   1. Wire: lib/api/instances.ts sends typed bodies. The instance change of a chat ALWAYS carries the field `instance` — `null` means
//      main (a PATCH without the field would leave everything as it is: "a missing field is no statement"). Error fields of a 409 arrive
//      as lists, and a response WITHOUT a list is `null`, never `[]` ("empty is not unknown").
//   2. Chat: the instance choice exists only with options (a converted project — also without a live copy), in the hero AND in the
//      header; the POST of a new chat carries the preselection only for a copy and only where the project comes from the hero. Below
//      the options a separator and "Create copy …" at BOTH places, leading via lib/project-jump.ts into the "Instances" tab — with the
//      current instance as base.
//   3. Tab: tick 5 s only with a visible page, immediately after `project/instance`, `project/copy` (of this project) and `preview/*`;
//      `?open=` from the expanded rows; no click catcher `fixed inset-0`. Via the airlock (lib/retrieval-airlock.ts, behavior in
//      retrieval-airlock.test.mjs): ONE retrieval at a time, the tick nudges without follow-up (`load(false)`), occasions too — no "only
//      the answer of the newest counts" any more (it let a route slower than the tick never arrive).
//   4. Link, stop, create: the link of a service row comes from the TREE (`linkInTree`, never only `linkOfTheRow` over the once-loaded
//      state); a stopped instance shows it neutrally with "Instance stopped" (`linkStopped`); "Create copy" works only with a tree, the
//      dialog shows "loading…" without a tree and updates the name suggestion until the person types.
//   5. Translations: every t("…") of the new files has exactly one line in i18n-de.ts (a missing one shows German, a duplicate
//      breaks the build with TS1117).
//   6. Jump from outside (`takeInstancesTarget`) opens the dialog only with a tree and selects a copy; the page switches the tab on the
//      event or `?instances=` and discards a jump into a project that does not exist. A copy that is being created shows in row and
//      header the step in words, the bar and the hint on overrun (projects/CopyProgress.tsx).
//   7. iOS (by TEXT): the same — `ChatInstanceRules.copyCreate` and `AppState.instancesShow` on the menu, the projects page sets the
//      segment only with a read creation path, the tab picks up the wish only when it is in front, and the progress is in row and header
//      (Code/CopyProgressDisplay.swift).
//   8. Create copy: the dialog sends `baseInstance` (the instance name, as stacks/routes.js BODY_FIELDS reads it) and knows no fallback
//      "main only" any more; the four rejections of a base (400 BASE_INSTANCE_INVALID, 409 TEMPLATE_UNKNOWN/TEMPLATE_NOT_READY/
//      TEMPLATE_UNREADABLE) it says in its own words; "Copy from this instance" preselects the base.
//   9. One place for the DELETE of a copy ("two places for the same list: delete one"): under web/src ONLY lib/api/instances.ts sends a
//      DELETE on `stack-copies` (directly, via `clearAwayPath`/`copyPath` or via a variable bound from them), and `deleteCopy(` is
//      called only by the delete dialog. The apps page opens it like the pill.
//  10. Wire/actions: `restartStack` reads the 202 response (`{ instance, action }`) — only `since` of the action, the result is in the
//      tree; 409 IGNORED_FILES arrives with list and count like OPEN_CHANGES; an error response WITHOUT text (524 of the tunnel with an HTML
//      page, over HTTP/2 without `statusText`) carries the status code, never an empty text (lib/api/core.ts). The branch dialog shows
//      IGNORED_FILES as a list, holds the restart button as long as ITS restart runs (event `project/instance`, recognized by `since`),
//      and the instance shows its action (`action`, lib/instances-tree.ts actionFrom); MAIN_STOPPED of the copy dialog is in its own words.
//      iOS (by TEXT, without Xcode): APIClient carries the status code for an error response without text; the branch sheet catches
//      IGNORED_FILES with a list; the stack restart no longer evaluates a stack list of the response (202); the copy sheet says
//      MAIN_STOPPED in its own words.
//
// Counter-tests (each red once, the source then restored): `const body: ChatInstanceBody = { instance }` to `instance ? { instance } : {}`
// => "Wire" red (main would never arrive); `name === MAIN ? null : name` to `name` => "Chat" red; `...instanceForCreation` removed
// from ensureChat => "Chat" red; the visibility guard in the tick removed => "Tab" red; `<MenuSeparator />` removed from
// ChatInstanceChoice.tsx => "Chat" red; `guard visible, …` to `guard …` in ProjectInstances.swift (the covered tab would steal the wish)
// => iOS red; lib/api/core.ts with `new Error(String(msg))` => "Wire" red (empty text instead of "HTTP 524"); `restartStack` reading the
// list from `stacks` => "Wire" red. The pill clears via the SAME delete dialog — held by services-status.test.mjs.
//
// Run:  node --test web/test/instances-ui.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const FRESH = [
  "src/components/projects/InstancesPage.tsx",
  "src/components/projects/InstanceDialogs.tsx",
  "src/components/projects/CopyProgress.tsx",
  "src/components/chat/ChatInstanceChoice.tsx",
  "src/components/chat/chatInstance.ts",
];

test("wire: typed bodies, the field `instance` is always there, error lists only as lists", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — wire not checkable"); return; }
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".instances-ui-test-"));
  const prior = globalThis.fetch;
  try {
    execFileSync(process.execPath, [
      tsc, path.join(webDir, "src", "lib", "api", "instances.ts"), "--module", "esnext", "--target", "es2022",
      "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
    ], { cwd: webDir, stdio: "pipe" });
    const m = await import(pathToFileURL(path.join(out, "instances.js")).href);
    const calls = [];
    let response = { status: 200, body: {} };
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method ?? "GET", body: opts.body ?? null });
      // `html`: a page instead of JSON (the 524 of the tunnel) — without `statusText`, as over HTTP/2.
      if (typeof response.html === "string") return new Response(response.html, { status: response.status, headers: { "content-type": "text/html" } });
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const last = () => calls.at(-1);

    response = { status: 200, body: { id: "c1", instance: null } };
    await m.setChatInstance("c1", null);
    assert.deepEqual(last(), { url: "/api/chats/c1", method: "PATCH", body: '{"instance":null}' }, "the switch to main does not send the field");
    await m.setChatInstance("c1", "copy-k1");
    assert.equal(last().body, '{"instance":"copy-k1"}');

    // "Start chat" does not create itself any more — it opens the draft in the instance (lib/chat-draft.ts), and `ensureChat` sends
    // the POST with project AND instance on the first send (check "Chat" below). A second creation path here would be a second place
    // for the same creation.
    assert.equal(m.startChatInInstance, undefined, "lib/api/instances.ts creates a chat itself again — \"Start chat\" is a draft");

    response = { status: 202, body: { name: "k1" } };
    await m.deleteCopy("p1", "k1");
    assert.deepEqual(last(), { url: "/api/projects/p1/stack-copies/k1", method: "DELETE", body: null });

    // Copy from a copy — `baseInstance` is the instance name, `base` is missing without a deviating branch, and a chatId NEVER goes
    // out. The rejection of a template arrives with its code.
    response = { status: 202, body: { copy: { name: "k2", state: "waiting_queue" } } };
    assert.deepEqual(await m.createCopy("p1", { name: "k2", baseInstance: "copy-k1" }), { name: "k2", state: "waiting_queue" });
    assert.deepEqual(last(), { url: "/api/projects/p1/stack-copies", method: "POST", body: '{"name":"k2","baseInstance":"copy-k1"}' });
    await m.createCopy("p1", { name: "k3", baseInstance: "copy-k1", base: { ".": "main", app: "feature" } });
    assert.deepEqual(JSON.parse(last().body), { name: "k3", baseInstance: "copy-k1", base: { ".": "main", app: "feature" } });
    response = { status: 409, body: { error: "The template \"k1\" is not ready (copy ready, instance stopped)", code: "TEMPLATE_NOT_READY" } };
    let fv = null;
    try { await m.createCopy("p1", { name: "k4", baseInstance: "copy-k1" }); } catch (e) { fv = m.errorFields(e); }
    assert.deepEqual([fv?.code, fv?.text], ["TEMPLATE_NOT_READY", "The template \"k1\" is not ready (copy ready, instance stopped)"]);

    // 409 INSTANCE_WORKING: the chats as a list; an error without a list is `null`, not "no chat".
    response = { status: 409, body: { error: "working", code: "INSTANCE_WORKING", chats: [{ id: "c2", title: "Checkout", reason: "turn", running: true }] } };
    let f = null;
    try { await m.deleteCopy("p1", "k1"); } catch (e) { f = m.errorFields(e); }
    assert.equal(f?.code, "INSTANCE_WORKING");
    assert.deepEqual(f?.chats, [{ id: "c2", title: "Checkout", reason: "turn", running: true }]);
    response = { status: 500, body: { error: "broken" } };
    f = null;
    try { await m.deleteCopy("p1", "k1"); } catch (e) { f = m.errorFields(e); }
    assert.equal(f?.text, "broken");
    assert.equal(f?.chats, null, "an error without a chat list became \"no chat is working\"");

    // 409 OPEN_CHANGES of the branch switch: the files and their count.
    response = { status: 409, body: { error: "open", code: "OPEN_CHANGES", files: ["a.txt", "b.txt"], count: 2 } };
    f = null;
    try { await m.switchBranch("p1", "copy-k1", { repo: "", branch: "main" }); } catch (e) { f = m.errorFields(e); }
    assert.equal(last().url, "/api/projects/p1/instances/copy-k1/branch");
    assert.deepEqual(JSON.parse(last().body), { repo: "", branch: "main" });
    assert.deepEqual([f?.code, f?.files, f?.count], ["OPEN_CHANGES", ["a.txt", "b.txt"], 2]);

    // 409 IGNORED_FILES — the same fields as OPEN_CHANGES.
    response = { status: 409, body: { error: "ignored", code: "IGNORED_FILES", files: [".env"], count: 1 } };
    f = null;
    try { await m.switchBranch("p1", "main", { repo: "app", branch: "cfg" }); } catch (e) { f = m.errorFields(e); }
    assert.deepEqual([f?.code, f?.files, f?.count], ["IGNORED_FILES", [".env"], 1]);

    // The stack restart is a 202 with the running action — only its start (`since`) is read.
    response = { status: 202, body: { instance: "main", action: { kind: "stack-restart", running: true, since: 1700000000123, stacks: null } } };
    assert.deepEqual(await m.restartStack("p1", "main"), { since: 1700000000123 });
    assert.deepEqual(last(), { url: "/api/projects/p1/instances/main/stack-restart", method: "POST", body: "{}" });
    response = { status: 202, body: { instance: "main" } };
    assert.deepEqual(await m.restartStack("p1", "main"), { since: null }, "without an action `since` is unknown (null), never 0");
    response = { status: 409, body: { error: "A stack restart is currently running on the main instance.", code: "OCCUPIED" } };
    f = null;
    try { await m.restartStack("p1", "main"); } catch (e) { f = m.errorFields(e); }
    assert.deepEqual([f?.code, f?.text], ["OCCUPIED", "A stack restart is currently running on the main instance."]);
    // … and an error response without text (524 of the tunnel with an HTML page, without statusText) carries the status code.
    response = { status: 524, html: "<html><body>A timeout occurred</body></html>" };
    f = null;
    try { await m.restartStack("p1", "main"); } catch (e) { f = m.errorFields(e); }
    assert.equal(f?.text, "HTTP 524", "an error response without text became an empty error");

    // Repos of an instance: a response without `loaded: true` is "not read", never an empty list.
    response = { status: 200, body: { loaded: false, error: "Instance not ready", state: "stopped" } };
    assert.deepEqual(await m.loadInstanceRepos("p1", "main"), { loaded: false, error: "Instance not ready", state: "stopped" });
    response = { status: 200, body: {} };
    assert.equal((await m.loadInstanceRepos("p1", "main")).loaded, false);

    // The tree: `?open=` and `fresh=1` only if set — without both the bare route.
    response = { status: 200, body: { ops: true, asOf: 1, instances: [] } };
    await m.loadInstancesTree("p1", null);
    assert.equal(last().url, "/api/projects/p1/instances");
    await m.loadInstancesTree("p1", "main,copy-k1", true);
    assert.equal(last().url, "/api/projects/p1/instances?open=main%2Ccopy-k1&fresh=1");
    await m.loadInstancesTree("p1", null, true);
    assert.equal(last().url, "/api/projects/p1/instances?fresh=1");
  } finally {
    globalThis.fetch = prior;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("chat: choice only with options, switch with `null` for main, preselection only in the POST from the hero", () => {
  const hook = withoutComments(read("src/components/chat/chatInstance.ts"));
  assert.ok(/setChatInstance\(chatId, name === MAIN \? null : name\)/.test(hook), "the switch to main does not send `null`");
  assert.ok(/chatInstanceOptions\(read\.field\)/.test(hook) && /read\.pid === projectId/.test(hook),
    "the options do not come from the sheet — or a field of the previous project would apply to the new one");
  assert.ok(/!activeChat && preselection !== MAIN && instanceOptions\.some\(\(o\) => o\.name === preselection\) \? \{ instance: preselection \} : \{\}/.test(hook),
    "the preselection goes into the POST for main or a vanished copy");
  const choice = withoutComments(read("src/components/chat/ChatInstanceChoice.tsx"));
  assert.ok(/if \(!options\.length\) return null;/.test(choice), "the choice is there even without options");
  // Below the options a separator and "Create copy …" — into the "Instances" tab, the current instance as base.
  assert.ok(/<MenuSeparator \/>\s*<MenuEntry\s+label=\{t\("Create copy …"\)\}[\s\S]*?onClick=\{onCopyCreate\}/.test(choice),
    "the choice does not offer \"Create copy …\" under a separator");
  assert.ok(/showInstances\(\{ workspaceId, projectId, createFrom: activeInstance \}\)/.test(hook),
    "\"Create copy …\" does not lead into the \"Instances\" tab — or without the current instance as base");
  const stage = withoutComments(read("src/components/chat/ChatStage.tsx"));
  assert.equal((stage.match(/<ChatInstanceChoice [^\n]*onCopyCreate=\{copyCreate\}/g) ?? []).length, 2, "hero AND header offer \"Create copy …\"");
  const strip = stage.slice(stage.indexOf('className="cb-strip-bottom'));
  assert.ok(/<ChatInstanceChoice t=\{t\} location="hero"/.test(strip.slice(0, strip.indexOf("{activeId && !archived && !empty"))),
    "the instance choice is not in the strip under the field of the empty chat");
  assert.ok(/<ChatInstanceChoice t=\{t\} location="header"/.test(stage), "the header has no instance switch");
  const pane = withoutComments(read("src/components/chat/ChatPane.tsx"));
  // On the instance switch in the stream (`chat_settings` with `instance`) ChatPane sets the instance in the list and reloads the
  // history — otherwise the divider "now working in …" (a notice message, not in the stream) would only be there after a reload.
  // Without a run immediately (delta via `revalidateChat` — no third setBubbles in onEvent, composer-contract), with a run at the end
  // of the run (joinedMidRun).
  const changeover = pane.slice(pane.indexOf('evt.subtype === "chat_settings"'), pane.indexOf('evt.subtype === "folder_context_changed"'));
  assert.ok(changeover.length > 0 && /const changeover = instanceSwitchFromEvent\(evt\);/.test(changeover), "ChatPane does not evaluate the instance switch in the stream");
  assert.ok(/setChats\(\(cs\) => cs\.map\(\(c\) => \(c\.id === id \? \{ \.\.\.c, instance: changeover\.instance \} : c\)\)\);/.test(changeover), "the chat list does not learn of the switch");
  assert.ok(/if \(busyRef\.current\) joinedMidRunRef\.current = true;/.test(changeover) && /else revalidateChat\(id, openSeqRef\.current\)\.catch\(console\.error\);/.test(changeover),
    "the history is not reloaded after the switch (the divider would only be there after a reload)");
  // `createChat` does not create any more — `ensureChat` is the ONE POST, and it carries the preselection.
  const withPreselection = pane.match(/projectId: newChatProjectId\(\)[^\n]*\.\.\.instanceForCreation/g) ?? [];
  assert.equal(withPreselection.length, 1, "ensureChat (hero project) does not carry the preselection — or a second POST creates again");
  assert.equal((pane.match(/\.\.\.instanceForCreation/g) ?? []).length, 1, "the preselection also goes into a POST whose project does not come from the hero");
  // "Start chat" on an instance orders the draft WITH this instance — chat/chatDraft.ts sets the preselection via
  // `selectInstancePreselection` (not `pickInstance`: that would write into the chat that is just closing).
  const instPage = withoutComments(read("src/components/projects/InstancesPage.tsx"));
  assert.ok(/showNewChat\(\{ workspaceId, projectId, instance: i\.name \}\)/.test(instPage), "\"Start chat\" does not order a draft in the instance");
  assert.ok(!/"\/api\/chats"/.test(instPage), "the \"Instances\" tab creates a chat itself again");
  const draftHook = withoutComments(read("src/components/chat/chatDraft.ts"));
  assert.ok(/selectInstancePreselection\(v\.instance \?\? MAIN\)/.test(draftHook), "the draft does not set the instance preselection");
});

test("tab: tick only with a visible page, immediately (and fresh) after the events of this project, `?open=` = the chosen instance, list + detail without a surface", () => {
  const page = withoutComments(read("src/components/projects/InstancesPage.tsx"));
  assert.ok(/const TICK_MS = 5000;/.test(page));
  assert.ok(/setInterval\(\(\) => \{ if \(document\.visibilityState === "visible"\) load\(false\); \}, TICK_MS\)/.test(page),
    "the tick asks even with a hidden page — or nudges with follow-up (retrieval after retrieval on a slow route)");
  assert.ok(/document\.addEventListener\("visibilitychange", visible\)/.test(page) && /clearInterval\(tick\)/.test(page));
  // An event of THIS project and every own action ask with `fresh=1` (the server then reads all instances anew instead of from its
  // 30 s summary), `preview/*` only reloads (links are in the DB).
  assert.ok(/if \(\(type === "project\/instance" \|\| type === "project\/copy"\) && String\(evt\.projectId \?\? ""\) === projectId\) load\(true, true\);\s*else if \(type\.startsWith\("preview\/"\)\) load\(\);/.test(page),
    "the events do not reload (fresh) — or also those of foreign projects");
  assert.ok(/finally \{\s*setBusy\(null\);\s*load\(true, true\);/.test(page), "after an own action the tree does not come fresh");
  assert.ok(/if \(fresh\) freshRef\.current = true;\s*airlock\.current\?\.nudge\(afterRun\);/.test(page), "a `fresh` during a running retrieval is lost");
  // ONE retrieval at a time via the airlock, one per project, ended on unmount; no "only the newest counts" any more. The retrieval
  // consumes `fresh` and asks the chosen instance as `?open=` (openParam from the sheet).
  assert.ok(/const fresh = freshRef\.current;\s*freshRef\.current = false;\s*return loadInstancesTree\(projectId, openParam\(\[choiceRef\.current\], treeRef\.current\), fresh\);/.test(page),
    "`?open=` does not come from the sheet, not from the choice, or `fresh` is not consumed");
  assert.ok(/const s = retrievalAirlock\(fetch, \{/.test(page), "the tree does not load via the airlock (lib/retrieval-airlock.ts)");
  // The calm form: kit SplitPane, the row from `rowOf` (bound to iOS) — not everything slapped side by side in one card.
  assert.ok(!/cb-kit-pane/.test(page), "the tab is on one surface (card) again");
  assert.ok(/<SplitPane\b/.test(page) && /const z = rowOf\(i\);/.test(page), "list + detail or the row from rowOf is missing");
  assert.ok(/s\.end\(\);/.test(page), "the airlock is not ended on unmount/project change — a late answer would hit the new project");
  assert.ok(!/turn\.current/.test(page), "still the old \"only the answer of the newest retrieval counts\"");
  assert.ok(/error: \(e\) => setLoadError\(errorFields\(e\)\.text\)/.test(page), "an error is not (always) reported");
  for (const d of FRESH) assert.ok(!/fixed inset-0/.test(withoutComments(read(d))), `${d}: click catcher as fixed inset-0`);
});

test("create copy: `baseInstance` always goes along, no fallback \"main only\", the four rejections of a base in words, preselection from the menu", () => {
  const dlg = withoutComments(read("src/components/projects/InstanceDialogs.tsx"));
  const keysA = dlg.slice(dlg.indexOf("export function CopyCreate"), dlg.indexOf("function BranchChoice"));
  assert.ok(keysA.length > 0, "CopyCreate not found");
  assert.ok(!/BASE_STILL_NOT|onlyMain|baseOnlyMain/.test(dlg), "the dialog still knows the fallback \"main only\" (409 BASE_STILL_NOT no longer exists)");
  assert.ok(/const options = useMemo\(\(\) => baseOptions\(tree\), \[tree\]\);/.test(keysA), "the base choice is not every ready instance of the tree");
  assert.ok(/createCopy\(projectId, \{\s*name: name\.trim\(\), baseInstance: sent,/.test(keysA), "the POST does not carry `baseInstance` (or not the base of this call)");
  assert.ok(!/chatId/.test(keysA), "the dialog sends a chatId (the copy belongs to no chat)");
  // Preselection: "Copy from this instance" in the ⋯ menu opens the dialog with the instance as base, the dialog adopts it if it is ready.
  assert.ok(/useState\(\(\) => \(options\.some\(\(o\) => o\.name === preselection\) \? preselection : options\[0\]\?\.name \?\? MAIN\)\)/.test(keysA), "the preselection does not apply");
  const page = withoutComments(read("src/components/projects/InstancesPage.tsx"));
  assert.ok(/onCopy=\{\(\) => setDialog\(\{ kind: "create", base: i\.name \}\)\}/.test(page) && /preselection=\{dialog\.base\}/.test(page),
    "\"Copy from this instance\" does not preselect the base");
  assert.ok(/label=\{t\("Copy from this instance"\)\} disabled=\{!a\.asBase\.on\}/.test(page), "\"Copy from this instance\" does not hang on `asBase` (the same computation as baseOptions)");
  // A base that drops out of the ready ones stays visibly chosen and blocks "Create" — the dialog never shows main while it sends a copy.
  assert.ok(/const baseReady = options\.some\(\(o\) => o\.name === base\);/.test(keysA) && /\{!baseReady && <option value=\{base\} disabled>/.test(keysA)
    && /disabled=\{busy \|\| !tree \|\| !name\.trim\(\) \|\| !baseReady\}/.test(keysA), "a vanished base is not visibly there or can be sent");
  // The four codes of the template (stacks/request.js) — one sentence of its own each, the server's sentence below.
  const request = fs.readFileSync(path.resolve(webDir, "..", "server", "backend", "electron", "server", "stacks", "request.js"), "utf8");
  for (const code of ["BASE_INSTANCE_INVALID", "TEMPLATE_UNKNOWN", "TEMPLATE_NOT_READY", "TEMPLATE_UNREADABLE"]) {
    assert.ok(request.includes(`"${code}"`), `${code}: the server does not know the code (any more) — the dialog translates a dead code`);
    assert.ok(new RegExp(String.raw`case "${code}": return t\("`).test(dlg), `${code}: no sentence of the dialog`);
  }
  assert.ok(/explanation=\{baseErrorText\(error\.f\.code, error\.base, t\)\}/.test(keysA), "the creation error does not go through baseErrorText");
  assert.ok(/\{explanation && f\.text && <div[^>]*data-instance-error-server>\{f\.text\}<\/div>\}/.test(dlg), "the server's sentence is missing under the explanation");
});

test("link, stop, create: link from the tree, \"Instance stopped\", create copy only with a tree", () => {
  const page = withoutComments(read("src/components/projects/InstancesPage.tsx"));
  // The tree is the source of the link, the once-loaded state only supplements.
  assert.ok(/const link = linkInTree\(d\.link, tree\.asOf, preview, \{ projectId, instance: i\.name, serviceId, serviceName: d\.name, port: d\.port \}\);/.test(page),
    "the link of the service row does not come from the tree");
  assert.ok(!/linkOfTheRow\(/.test(page), "the service row still reads the link from the links state alone");
  // A stopped instance — neutral dot and "Instance stopped".
  assert.ok(/instanceStopped=\{linkStopped\(i\)\}/.test(page), "the link row does not learn that the instance is stopped");
  const share = withoutComments(read("src/components/preview/PreviewShare.tsx"));
  assert.ok(/const point = instanceStopped \? "border border-edge" :/.test(share), "the dot of a stopped instance is not neutral");
  assert.ok(/\{instanceStopped && <span[^>]*data-preview-stopped>\{t\("Instance stopped"\)\}<\/span>\}/.test(share), "the sentence \"Instance stopped\" is missing");
  // "Create copy" only with a tree; without a tree the dialog says "loading…" and updates the name until the person types.
  assert.ok(/<button type="button" className=\{primary\} disabled=\{!tree\}[\s\S]{0,300}?data-instance-copy-create>/.test(page), "\"Create copy\" works even without a read tree");
  const dlg = withoutComments(read("src/components/projects/InstanceDialogs.tsx"));
  const keysA = dlg.slice(dlg.indexOf("export function CopyCreate"), dlg.indexOf("function BranchChoice"));
  assert.ok(/const name = ownName \?\? freeCopyName\(tree\);/.test(keysA) && /onChange=\{\(e\) => setOwnName\(e\.target\.value\)\}/.test(keysA),
    "the name suggestion is computed only once on opening");
  assert.ok(/\{!tree \? \([\s\S]*?data-copy-base-loading[\s\S]*?\) : options\.length \? \(/.test(keysA), "without a tree the dialog says \"no instance is ready\" instead of \"loading…\"");
});

// A window before `method: "DELETE"` (the row and the one before) and the question: does the call target a copy? Directly (`stack-copies`,
// `clearAwayPath(`, `copyPath(`) or via a name the file binds from such an expression (`const path = clearAwayPath(…)`).
const COPY_PATH = /stack-copies|\bclearAwayPath\(|\bcopyPath\(/;
function copyDeletes(text) {
  const s = text.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\*\*[\s\S]*?\*\//gm, "");
  const hits = [];
  for (const m of s.matchAll(/method:\s*"DELETE"/g)) {
    const row = s.lastIndexOf("\n", m.index - 1);
    const window = s.slice(s.lastIndexOf("\n", row - 1) + 1, m.index);
    const bound = [...new Set(window.match(/[A-Za-z_$][\w$]*/g) ?? [])].some((id) =>
      new RegExp(String.raw`(?:const|let|var)\s+${id.replace(/\$/g, "\\$")}\s*=\s*[^;\n]*(?:stack-copies|\bclearAwayPath\(|\bcopyPath\()`).test(s));
    if (COPY_PATH.test(window) || bound) hits.push(window.trim().slice(-160));
  }
  return hits;
}
function sources(dir, rel = "") {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) return sources(dir, r);
    return /\.(ts|tsx)$/.test(e.name) ? [r] : [];
  });
}

test("one place for the DELETE of a copy: only lib/api/instances.ts sends it, only the delete dialog calls deleteCopy, the apps page opens the dialog", () => {
  const ALLOWED = "src/lib/api/instances.ts";
  const files = sources(path.join(webDir, "src")).map((r) => path.join("src", r).split(path.sep).join("/"));
  assert.ok(files.length > 100 && files.includes(ALLOWED) && files.includes("src/app/apps/page.tsx"), `only ${files.length} sources found`);
  // Positive anchor: the detector recognizes the one allowed DELETE — a detector that finds nothing is no green case.
  assert.equal(copyDeletes(read(ALLOWED)).length, 1, "the DELETE of deleteCopy is not recognized as a DELETE on a copy — does the detector still match?");
  assert.equal(copyDeletes("    const path = clearAwayPath(projectId, i);\n    try {\n      const r = await fetch(`${API_BASE}${path}`, { method: \"DELETE\" });\n").length, 1,
    "the old form of the apps page (path via a variable) is not recognized");
  assert.equal(copyDeletes("    await api(`/api/projects/${p.id}/gliederung/auftrag`, { method: \"DELETE\" });\n").length, 0, "a foreign DELETE counts as a copy");
  const foreign = [];
  const caller = [];
  for (const d of files) {
    const text = read(d);
    if (d !== ALLOWED) for (const f of copyDeletes(text)) foreign.push(`${d}: DELETE on a copy — ${f}`);
    if ((withoutComments(text).match(/\bdeleteCopy\(/g) ?? []).length) caller.push(d);
  }
  assert.deepEqual(foreign, [], "a second place sends the DELETE of a copy — past the delete preview and 409 INSTANCE_WORKING with the chats");
  assert.deepEqual(caller, ["src/components/projects/InstanceDialogs.tsx"], "somebody besides the delete dialog calls deleteCopy");
  // The apps page opens the SAME dialog as tab and pill — without its own question, never for the main, result from the 202.
  const apps = withoutComments(read("src/app/apps/page.tsx"));
  assert.ok(/import \{ CopyDelete \} from "@\/components\/projects\/InstanceDialogs"/.test(apps) && /<CopyDelete\b/.test(apps), "the apps page does not clear via the delete dialog");
  assert.ok(!/useConfirm|clearAwayQuestion\(/.test(apps), "the apps page still asks its own question");
  const start = apps.slice(apps.indexOf("function clearAway("));
  const on = start.indexOf("setDelete({ projectId, projectName, i })");
  assert.ok(on > 0 && /if \(!clearAwayPath\(projectId, i\)\) return;/.test(start.slice(0, on)), "without a path (the main) no delete dialog may open");
  assert.ok(/onDeleted=\{\(body\) => clearAwayAccepted\(erase\.projectId, erase\.i, body\)\}/.test(apps)
    && /setInfo\(clearAwayResult\(202, body, i, t\)\.text\)/.test(apps), "the accepted clearing does not appear as the result of the 202");
});

test("actions: IGNORED_FILES as a list, restart button held until the end of ITS action, action on the instance, MAIN_STOPPED in words", () => {
  const dlg = withoutComments(read("src/components/projects/InstanceDialogs.tsx"));
  const page = withoutComments(read("src/components/projects/InstancesPage.tsx"));
  assert.ok(/setIgnored\(f\.code === "IGNORED_FILES" && f\.files \? \{ files: f\.files, count: f\.count \?\? f\.files\.length \} : null\)/.test(dlg)
    && /data-branch-ignored/.test(dlg), "IGNORED_FILES shows no list");
  // The restart: 202 → `since`; the event `project/instance` of THIS instance with THIS action (same `since`) sets the state.
  assert.ok(/const r = await restartStack\(projectId, instance\); setRestart\(\{ since: r\.since, action: null \}\)/.test(dlg), "the dialog does not remember `since`");
  assert.ok(/evt\.type !== "project\/instance" \|\| String\(evt\.projectId \?\? ""\) !== projectId \|\| String\(evt\.instance \?\? ""\) !== instance/.test(dlg)
    && /a\.kind !== "stack-restart" \|\| \(restartSince !== null && a\.since !== restartSince\)/.test(dlg), "the dialog takes foreign events as its restart");
  assert.ok(/disabled=\{busy !== null \|\| restartRunning\}/.test(dlg), "the restart button is free while the restart runs (a second click)");
  assert.ok(/case "MAIN_STOPPED": return t\(/.test(dlg), "MAIN_STOPPED without own words");
  // The tab: no waiting for the restart in the click, the action stands on the instance.
  const click = page.slice(page.indexOf("const stackNew = "), page.indexOf("const code = "));
  assert.ok(/await restartStack\(projectId, i\.name\);/.test(click) && !/\.filter\(|stacks/.test(click), "the tab still evaluates a synchronous stack list");
  assert.ok(/\{i\.action && <ActionRow action=\{i\.action\} t=\{t\} \/>\}/.test(page), "the instance does not show its action");
});

test("iOS: error response without text carries the status code, IGNORED_FILES as a list, restart as 202, action on the instance, MAIN_STOPPED in words", () => {
  const app = path.resolve(webDir, "..", "mobile", "CbaseMobile");
  const swift = (rel) => withoutComments(fs.readFileSync(path.join(app, rel), "utf8"));
  const api = swift("Models/APIClient.swift");
  const error = api.slice(api.indexOf("guard (200..<300).contains(http.statusCode) else {"));
  assert.ok(error.length > 0, "the error branch of APIClient cannot be found — move the anchor");
  assert.match(error.slice(0, 900), /let fromBody = \(decoded\?\["error"\]\?\.stringValue \?\? decoded\?\["detail"\]\?\.stringValue\)\?\.trimmingCharacters\(in: \.whitespacesAndNewlines\)/,
    "an empty or whitespace-only `error` counts as text");
  assert.match(error.slice(0, 900), /\?\? "\\\(HTTPURLResponse\.localizedString\(forStatusCode: http\.statusCode\)\) \(HTTP \\\(http\.statusCode\)\)"/,
    "an error response without text does not name the status code");
  const branch = swift("Code/BranchSwitch.swift");
  assert.match(branch, /catch let e as APIError where e\.code == "IGNORED_FILES" \{\s*let files = [^\n]+\n\s*ignored = \(files, max\(/, "IGNORED_FILES without a list");
  assert.match(branch, /accessibilityIdentifier\("branch-ignored"\)/);
  assert.doesNotMatch(branch, /restartText|\["stacks"\]/, "the branch sheet still evaluates a synchronous stack list");
  const page = swift("Code/ProjectInstances.swift");
  const restart = page.slice(page.indexOf("func stackRestart("), page.indexOf("nonisolated static func actionText("));
  assert.ok(restart.length > 0 && !/stacks|JSONDecoder/.test(restart), "stackRestart still evaluates a synchronous stack list");
  assert.match(page, /if let a = i\.action, let set = InstancesPageModel\.actionText\(a\)/, "the instance does not show its action");
  assert.match(page, /\.accessibilityIdentifier\("instance-action"\)/);
  assert.match(swift("Code/CopyCreate.swift"), /case "MAIN_STOPPED":\s*return L\(/, "MAIN_STOPPED without own words");
});

test("jump and progress: dialog only with a tree, select copy, switch tab; step, bar, hint in row and header", () => {
  const pageValue = withoutComments(read("src/components/projects/InstancesPage.tsx"));
  assert.match(pageValue, /const fetch = \(\) => \{ const z = takeInstancesTarget\(projectId\); if \(z\) setTarget\(z\); \};\s*fetch\(\);/,
    "the tab does not pick up a waiting jump on mount");
  assert.match(pageValue, /window\.addEventListener\(PROJECT_JUMP_EVENT, on\)/, "on already open tab does not hear the jump");
  assert.match(pageValue, /if \(target\.createFrom !== undefined && !tree\) return;/, "the dialog opened without a tree");
  assert.match(pageValue, /if \(target\.instance\) select\(target\.instance\);\s*if \(target\.createFrom !== undefined\) setDialog\(\{ kind: "create", base: target\.createFrom \}\);/);
  // The progress: only on a copy, via the bound computation, in row AND header; the header shows the step instead of the raw phase.
  assert.equal((pageValue.match(/const detail = i\.name === MAIN \? null : progressDetail\(i\.progress, i\.state\);/g) ?? []).length, 2,
    "row and header do not (both) compute the progress via progressDetail");
  assert.equal((pageValue.match(/<CopyProgressBar a=\{detail\}/g) ?? []).length, 2, "row and header do not (both) show a bar");
  assert.match(pageValue, /\{step \? ` · \$\{step\}` : !detail && i\.phase/, "the header shows the raw phase next to the step");
  const form = withoutComments(read("src/components/projects/CopyProgress.tsx"));
  assert.match(form, /const kind = waiting \? "waiting" : a\.share !== null \? "determinate" : "indeterminate";/, "the bar invents a share");
  assert.match(form, /prefers-reduced-motion: reduce/, "the band also runs with reduced motion");
  assert.ok(!/fixed inset-0/.test(form));
  // The page: the event creates the jump, the address likewise (and leaves it again), applied only with the overview of THIS workspace;
  // a project that does not exist discards the wish. The general jump into a sub-item (lib/project-jump.ts) — the instances are one of
  // them, the sub-item comes from the event or the address.
  const page = withoutComments(read("src/app/workspaces/page.tsx"));
  assert.match(page, /window\.addEventListener\(PROJECT_JUMP_EVENT, jump\)/);
  assert.match(page, /isProjectSubitem\(d\.subitem\)/, "an event with an unknown sub-item created a jump");
  assert.match(page, /const wantedProject = projectFromAddress\(params\);/);
  assert.match(page, /for \(const k of JUMP_PARAMETER\) u\.searchParams\.delete\(k\);/, "the jump parameters stay in the address (every ⌘R would jump again)");
  assert.match(page, /if \(!projectJump \|\| !activeId \|\| !overview \|\| overview\.id !== activeId\) return;/);
  assert.match(page, /if \(!p\) \{ takeProjectTarget\(subitem, projectId\); return; \}/, "a jump into a missing project would stay as a wish");
  assert.match(page, /setOpenProject\(\{ id: p\.id, name: p\.name, view: subitem \}\);/);
  assert.match(page, /setProjectTab\(subitem\);\s*setTab\("project"\);/);
});

test("iOS: \"Create copy …\" on the instance choice, jump via the projects page into the tab, progress in row and header", () => {
  const swift = (rel) => withoutComments(fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", rel), "utf8"));
  const header = swift("Chat/ChatHeader.swift");
  const choice = header.slice(header.indexOf("struct ChatInstanceChoice"));
  assert.match(choice, /let create = ChatInstanceRules\.copyCreate\(model\.instanceOptions\(in: state\)\)/);
  assert.match(choice, /if create, let pid = model\.chat\.projectId \{\s*Divider\(\)\s*Button \{\s*hideKeyboard\(\)\s*state\.instancesShow\(projectId: pid, createFrom: selected\)/,
    "the menu does not offer \"Create copy …\" under a separator — or without the chat's instance as base");
  assert.match(choice, /Label\(L\("Create copy …"\), systemImage: "plus\.square\.on\.square"\)/);
  const instances = swift("Code/ProjectInstances.swift");
  // ONE mechanism for every sub-item (Code/ProjectView.swift `ProjectWish` with `page`, `projectShow`) — `instancesShow` is a thin
  // call on it.
  const view = swift("Code/ProjectView.swift");
  assert.match(view, /func projectShow\(_ wish: ProjectWish\) \{[\s\S]*?projectWish = wish\s*openCoding\(\.projects\)/);
  assert.match(view, /func instancesShow\(projectId: String, instance: String\? = nil, createFrom: String\? = nil\) \{\s*projectShow\(ProjectWish\(projectId: projectId, page: \.instances, instance: instance, createFrom: createFrom\)\)/);
  // The tab picks up the wish only when it is in front (a covered page would otherwise steal it from the projects page) and it applies
  // to it (not to the Git page), and the dialog waits for the tree.
  assert.match(instances, /private func pickUpWish\(\) \{\s*guard visible, let w = state\.projectWish, w\.page == \.instances, w\.projectId == project\.id else \{ return \}\s*state\.projectWish = nil\s*guard !w\.expired else \{ return \}/);
  assert.match(instances, /if w\.createFrom != nil, model\.tree == nil \{ return \}/, "the dialog opened without a tree");
  assert.match(instances, /\.onChange\(of: model\.tree != nil\) \{ _, _ in wishExecute\(\) \}/);
  const pane = swift("Code/ProjectsPane.swift");
  const apply = pane.slice(pane.indexOf("private func projectWishApply"), pane.indexOf("private func followUp("));
  assert.match(apply, /guard let mode = creation\.mode else \{ return \}/, "the segment would be set before the creation path (and fall back to \"Services\")");
  assert.match(apply, /project\.instance\?\.converted == true else \{\s*state\.projectWish = nil/);
  assert.match(apply, /detailPage = w\.page\s*if detail\?\.id != project\.id \{ detail = project \}/);
  assert.match(pane, /\.onChange\(of: creation\.mode\) \{ _, _ in projectWishApply\(\) \}/);
  // The progress: via the bound computation, only on a copy, in row AND header; the header shows the step instead of the raw phase.
  assert.match(instances, /i\.name == InstancesTree\.main \? nil : InstancesTree\.progressDetail\(i\.progress, state: i\.state\)/);
  assert.ok((instances.match(/CopyProgressBar\(a: a\)/g) ?? []).length >= 2, "row and header do not (both) show a bar");
  assert.match(instances, /\} else if detail == nil, !i\.phase\.isEmpty/, "the header shows the raw phase next to the step");
  const display = swift("Code/CopyProgressDisplay.swift");
  assert.match(display, /@Environment\(\\\.accessibilityReduceMotion\) private var quiet/, "the band also runs with \"Reduce Motion\"");
  assert.match(display, /if let share = a\.share \{/, "the bar invents a share");
  const en = fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", "Kit", "LocDEInstances.swift"), "utf8");
  for (const k of ["Create copy …", "Step {n} of {m}", "Stage {seq}/{from}", "about {n} min left", "taking longer than last time", "Second clone"]) {
    assert.ok(en.includes(`"${k}": "`), `"${k}" missing in LocDEInstances.swift`);
  }
});

test("translations: every t(\"…\") of the new files has exactly one line in i18n-de.ts", () => {
  const en = read("src/lib/i18n-de.ts").split("\n");
  const missing = [];
  const notLiteral = [];
  let n = 0;
  for (const d of FRESH) {
    const text = read(d);
    for (const m of text.matchAll(/\bt\(([^)]?)/g)) if (m[1] !== '"') notLiteral.push(`${d}: t(${m[1]}…`);
    for (const m of text.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) {
      n++;
      const rows = en.filter((z) => z.trimStart().startsWith(`"${m[1]}":`));
      if (rows.length !== 1) missing.push(`${d}: "${m[1]}" (${rows.length} lines)`);
    }
  }
  console.log(`  [i18n] ${n} t("…") calls in ${FRESH.length} files`);
  assert.ok(n >= 80, `only ${n} t("…") found — does the regex still match?`);
  assert.deepEqual(notLiteral, [], "a t(…) with a non-literal key — nobody can hold that against i18n-de.ts");
  assert.deepEqual(missing, []);
});
