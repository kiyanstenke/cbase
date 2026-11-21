// The archive on the iPhone — bindings by PATH, no simulator.
//
// Reads the Swift sources under `mobile/CbaseMobile/` and executes the list side of the UI-test fixture (reading and Node
// only, so it also runs on Linux — NOT under `onlyMacOS`). What stands here is reported by no type error and in most cases
// by no UI test that runs green:
//
//   22  the delete question on the archived folder takes its numbers from the SERVER (`archivePrecheck(folder:)`), not from
//       the group cut by search and project. Behavior: ShellUITests `testFolderPermanentlyDeleteNamesTheNumbersOfTheServers`.
//   28  The archive notices are kept per id with a counter and read with the OLD state of the `onChange`; the computation
//       itself runs in archive-binding.test.mjs.
//   29  `SelectedChatHost.fetchPerId` opens only coding chats (`kind == "normal"`).
//   30  The fixture reads `archive=` like the server: only a MISSING parameter is "without", an empty one is 400 — EXECUTED,
//       both functions against the same table.
//   31  Singular of the folder delete question ("1 chat will be lost") — key present, and `ArchiveQuestion` chooses it.
//   32  The goal of an archived chat is read-only. Behavior: ShellUITests `testArchivedChatShowsTheGoalReadOnly`.
//
// Auto-archive findings:
//    3  The auto-archive reports one `chat_archive` per chat — reloading is bundled, unless the event names an open chat.
//    6  A second send during creation does not create a second chat (ONE job per draft).
//    8  Settings → Chats: the throttled PUT reads the state at FIRING time, the last change wins.
//   10  `ChatAutoArchiveDoc` requires both fields — a response without them is an error, not "off, 30 days".
//    2  The explicit level choice always goes out, with `effortChoice: true`; a model change never as a level — fixture EXECUTED.
//
// Comments are removed before every check — the sources NAME the old thing in order to justify it. Counter-tests: each
// check was shown red once (sabotaged, seen red, restored).
//
// Run:  node --test web/test/ios-archive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const IOS = "mobile/CbaseMobile";
const raw = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

// ── Reading Swift ──────────────────────────────────────────────────────────────────────────────────
// Comments become spaces (line breaks stay), strings stay — copied from ios-drawer.test.mjs, not imported (a test never
// imports another). `strings: false` additionally blanks the CONTENT of strings so that a `{n}` in `L("{n} chats")` does not
// count when counting brackets; both versions are equally long, the positions stay valid.
function read(t, { strings = true } = {}) {
  let out = "";
  let i = 0;
  const empty = (s) => s.replace(/[^\n]/g, " ");
  while (i < t.length) {
    if (t.startsWith('"""', i)) {
      const end = t.indexOf('"""', i + 3);
      const until = end < 0 ? t.length : end + 3;
      out += strings ? t.slice(i, until) : '"""' + empty(t.slice(i + 3, until - 3)) + '"""';
      i = until;
    } else if (t[i] === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== '"' && t[j] !== "\n") j += t[j] === "\\" ? 2 : 1;
      out += strings ? t.slice(i, j + 1) : '"' + empty(t.slice(i + 1, j)) + (j < t.length ? t[j] : "");
      i = j + 1;
    } else if (t.startsWith("//", i)) {
      const end = t.indexOf("\n", i);
      const until = end < 0 ? t.length : end;
      out += empty(t.slice(i, until));
      i = until;
    } else if (t.startsWith("/*", i)) {
      let depth = 1;
      let j = i + 2;
      while (j < t.length && depth > 0) {
        if (t.startsWith("/*", j)) { depth++; j += 2; } else if (t.startsWith("*/", j)) { depth--; j += 2; } else j++;
      }
      out += empty(t.slice(i, j));
      i = j;
    } else {
      out += t[i];
      i++;
    }
  }
  return out;
}
const swift = (rel) => read(raw(rel));

/** The body from `header` to its closing bracket (brackets in strings do not count). */
function body(rel, header) {
  const source = raw(rel);
  const code = read(source);
  const count = read(source, { strings: false });
  const start = code.indexOf(header);
  assert.ok(start >= 0, `"${header}" is no longer in ${rel} — renamed? Move the anchor, do not delete the test`);
  const on = count.indexOf("{", start + header.length - 1);
  let depth = 0;
  for (let i = on; i < count.length; i++) {
    if (count[i] === "{") depth++;
    else if (count[i] === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  assert.fail(`the closing bracket of "${header}" in ${rel} is missing`);
}

// ── 22: the numbers of the delete question come from the server ──
// Counter-test: `counts.chats` → `group.chats.count` => red; `archivePrecheck(folder:` removed => red.
test("(22) the question on the archived folder names the numbers of the server precheck, not those of the cut group", () => {
  const question = body(`${IOS}/Chat/ArchiveList.swift`, "private func questionFolder(");
  assert.ok(question.includes("client.archivePrecheck(folder: group.id)"), "questionFolder does not ask the server (GET …/archive on the archived folder)");
  assert.match(question, /ArchiveQuestion\.folderDelete\([^)]*chats:\s*counts\.chats,\s*contextFiles:\s*counts\.contextFiles\)/,
    "the question does not insert the numbers of the server response");
  for (const old of ["group.chats.count", "group.chats", "contextFileCount"]) {
    assert.ok(!question.includes(old), `questionFolder reads "${old}" again — the group is cut by search and project, the server deletes the whole folder`);
  }
  // No answer, no question: the catch branch returns before `folderDelete` is set.
  const capture = question.indexOf("catch");
  assert.ok(capture > 0 && question.indexOf("return", capture) < question.indexOf("folderDelete = "), "without a server response no question with a guessed number may arise");
  // A response without a chat count is the same situation as no response: `folderDelete` gives `nil`, and the caller returns.
  assert.match(question, /guard let text = ArchiveQuestion\.folderDelete\([\s\S]*?\) else \{[\s\S]*?return\s*\}/,
    "a response without a chat count still leads to the question");
  const model = body(`${IOS}/Models/ArchiveModels.swift`, "struct ArchiveFolderPrecheck");
  // Empty is not unknown: if a number is missing from the response it must not silently become 0 (`c.int` defaults to 0).
  for (const field of ["chats", "contextFiles"]) {
    assert.ok(new RegExp(`let ${field}: Int\\?`).test(model) && new RegExp(`${field} = c\\.intOpt\\(\\.${field}\\)`).test(model),
      `ArchiveFolderPrecheck does not read \`${field}\` as an optional number — a missing number would silently be 0`);
  }
  assert.match(model, /case [^\n]*\bcontextFiles\b/, "ArchiveFolderPrecheck does not decode `contextFiles`");
});

// ── "Reply" hangs on the archive ──
// Counter-test: `onAsk: model.archived ? nil :` → `onAsk:` in ChatView => red.
test("archived: no \"Reply\" in the coding chat", () => {
  const marker = swift(`${IOS}/Chat/ChatTextMarker.swift`);
  assert.ok(/let onAsk: \(\(\) -> Void\)\?/.test(marker), "ChatSelectionMenuOverlay.onAsk is not optional");
  const menu = body(`${IOS}/Chat/ChatTextMarker.swift`, "private var menu: some View");
    assert.ok(/if let onAsk \{\s*button\(L\("Reply"\)/.test(menu), "\"Reply\" is not under `if let onAsk`");
    for (const [rel, fn] of [[`${IOS}/Chat/ChatView.swift`, "askAboutSelection"]]) {
    const q = swift(rel);
    assert.ok(q.includes(`onAsk: model.archived ? nil : { ${fn}() }`), `${path.basename(rel)} offers "Reply" even when archived`);
    const f = body(rel, `private func ${fn}()`);
    assert.match(f, /guard let selection = textSelection, !model\.archived else \{ return \}/, `${fn} writes into the input even when archived`);
  }
});

// ── 28: the reader takes the bound computation ──
// Counter-test: `.onChange(of: state.archiveChanged) { alt, _ in` → `{ _, _ in` + `lastArchiveChatIds` => red.
test("(28) the composer reads via the bound computation (ArchiveNotices)", () => {
  const app = swift(`${IOS}/Models/AppState.swift`);
  assert.ok(!app.includes("lastArchiveChatIds"), "AppState keeps ONE replaced id set again — two notices before one render lose the first");
  // `archiveServe` delivers — bundled or immediately, but always per id in `ArchiveNotices`.
  const supplies = body(`${IOS}/Models/AppState.swift`, "private func archiveServe()");
  assert.ok(supplies.includes("archiveNotices.report(chatIds)"), "the delivery does not enter the ids into `ArchiveNotices`");
  const composer = swift(`${IOS}/Chat/ChatComposer.swift`);
  assert.match(composer, /\.onChange\(of: state\.archiveChanged\) \{ old, _ in\s*guard state\.archiveNamed\(model\.chat\.id, since: old\) else \{ return \}/,
    "the composer does not ask with the OLD counter whether a notice named it");
});

// ── 29: by id only coding chats ──
// Counter-test: `&& chat.kind == "normal"` removed => red.
test("(29) SelectedChatHost opens by id only a coding chat of the workspace (`kind == \"normal\"`)", () => {
  const fetch = body(`${IOS}/Shell/CategoryContent.swift`, "private func fetchPerId()");
  assert.match(fetch, /if chat\.workspaceId == workspace\.id && chat\.kind == "normal" \{/, "fetchPerId does not check the kind");
  const chat = body(`${IOS}/Models/Models.swift`, "struct Chat: Codable");
  assert.match(chat, /var kind: String/, "Chat carries no kind");
  assert.match(chat, /decodeIfPresent\(String\.self, forKey: \.kind\)/, "Chat does not read `kind` from the response");
});

// ── 30: the fixture reads `archive=` like the server — EXECUTED ──
// The server function is cut from its source and executed with its value list (runs/archive.js pulls in the whole store —
// importing would mean opening a database). Counter-test: in the fixture `get("archive") || "without"` back => `?archive=` red.
test("(30) `archivePage` in the fixture answers like the server — an empty value is unknown (400), only a missing one is \"without\"", async () => {
  const source = raw("server/backend/electron/server/runs/archive.js");
  const list = source.match(/^const ARCHIVE_PAGES = (\[[^\]]*\]);$/m);
  const fn = source.match(/^function archivePage\(url\) \{\n[\s\S]*?\n\}$/m);
  assert.ok(list && fn, "archivePage/ARCHIVE_PAGES are no longer in runs/archive.js — move the anchor");
  const server = new Function(`const ARCHIVE_PAGES = ${list[1]};\n${fn[0]}\nreturn archivePage;`)();
  const { archivePage: fixture } = await import(pathToFileURL(path.join(repo, "mobile/test-fixtures/chat-gateway/state.mjs")).href);
  const cases = ["", "?archive=", "?archive=without", "?archive=only", "?archive=including", "?archive=x", "?archive=ONLY", "?archive=%20only", "?archive=only&archive=including"];
  const deviations = [];
  for (const f of cases) {
    const url = new URL(`http://x/api/chats${f}`);
    const s = server(url);
    const x = fixture(url);
    if (s !== x) deviations.push(`${f || "(without parameter)"}: server ${JSON.stringify(s)}, fixture ${JSON.stringify(x)}`);
  }
  assert.deepEqual(deviations, [], `fixture and server read \`archive\` differently:\n  ${deviations.join("\n  ")}`);
  assert.equal(fixture(new URL("http://x/api/chats?archive=")), null, "an empty value is unknown (400)");
  console.log(`  [archive] archivePage: ${cases.length} cases, fixture == server`);
});

// ── 31: singular of the folder delete question ──
// Counter-test: in ArchiveQuestion `n == 1 ?` → `false ?` => red. The wording is computed by archive-binding.test.mjs.
test("(31) \"… {chats} will be lost.\" is translated and is chosen for one chat without context files", () => {
  const singular = "Delete folder \\\"{name}\\\" permanently? {chats} will be lost.##one";
  const plural = "Delete folder \\\"{name}\\\" permanently? {chats} will be lost.";
  const loc = raw(`${IOS}/Kit/LocDEBase.swift`);
  for (const k of [singular, plural]) assert.ok(loc.includes(`"${k}": "`), `LocDEBase does not translate "${k}"`);
  const question = body(`${IOS}/Models/ArchiveModels.swift`, "static func folderDelete(");
  const i = question.indexOf("return n == 1");
  assert.ok(i > 0 && question.indexOf(singular, i) > i && question.indexOf(`${plural}"`, i) > question.indexOf(singular, i),
    "ArchiveQuestion does not choose the singular for n == 1 (without context files)");
});

// ── 32: the goal in the archive is read-only ──
// Counter-test: `onlyRead: model.archived` removed => red (and ShellUITests red).
test("(32) the goal sheet of an archived chat has no save and no remove", () => {
  const view = swift(`${IOS}/Chat/ChatView.swift`);
  // The sheet also gets `paused` (footer "Goal paused").
  assert.ok(view.includes("GoalSheet(goal: $goalText, onlyRead: model.archived, paused: model.chat.goalPaused)"), "ChatView opens the goal sheet for editing even when archived");
  const sheet = body(`${IOS}/Chat/ChatSheets.swift`, "struct GoalSheet: View");
  assert.ok(sheet.includes("if !goal.isEmpty && !onlyRead {"), "\"Remove goal\" does not hang on `!onlyRead`");
  // The bar has no if/else branch any more — the ✕ is always there, "Save" alone under `if !onlyRead {`. The promise stays:
  // archived, no saving.
  const bar = sheet.slice(sheet.indexOf(".toolbar {"));
  const branch = bar.indexOf("if !onlyRead {");
  const save = bar.indexOf('L("Save")');
  assert.ok(branch > 0 && save > branch && bar.lastIndexOf('L("Save")') === save,
    "\"Save\" is not (alone) in the non-read-only branch of the toolbar");
});

// ── Auto-archive, iOS part ──
// Counter-tests (each red once, then restored): in `reportArchive` `archiveBundle?.cancel()` removed => 3 red; `immediately: true` in the
// event branch => 3 red; in `ensureServerChat` the branch `if let running = creationJob` removed => 6 red; in the throttle `save(new, …)`
// with the value from the keystroke instead of `submit()` => 8 red; `an = c.bool(.an)` => 10 red.
test("(3) `chat_archive` reloads bundled — immediately only if it names an open chat (or the own action)", () => {
  const report = body(`${IOS}/Models/AppState.swift`, "func reportArchive(");
  assert.match(report, /func reportArchive\(_ chatIds: \[String\], immediately: Bool = true\)/,
    "the own action no longer takes effect immediately (default `immediately: true`)");
  const abort = report.indexOf("archiveBundle?.cancel()");
  const sleep = report.indexOf("Task.sleep(nanoseconds: Self.archiveBundleNs)");
  assert.ok(abort > 0 && sleep > abort, "not every notice cancels the waiting job before it restarts it");
  assert.ok(report.indexOf("guard !immediately else {") < sleep && report.indexOf("archiveServe()") < sleep,
    "an immediate notice waits too — it must deliver everything collected at once");
  const app = swift(`${IOS}/Models/AppState.swift`);
  assert.match(app, /static let archiveBundleNs: UInt64 = 300_000_000/, "the bundling does not wait ~300 ms");
  const branch = app.slice(app.indexOf('type == "chat_archive"'), app.indexOf("func reportArchive("));
  assert.match(branch, /reportArchive\(chatIds, immediately: selectedChatId\.map \{ chatIds\.contains\(\$0\) \} \?\? false\)/, "the event does not take effect immediately when it names the open chat");
  // The readers reload only via the (now bundled) counter — none hangs on its own event branch.
  assert.ok(swift(`${IOS}/Chat/ArchiveList.swift`).includes(".onChange(of: state.archiveChanged) { Task { await load() } }"), "the archive list does not reload via the counter");
});

test("(6) ONE creation per draft — a second send during the POST waits for the same job", () => {
  const ensure = body(`${IOS}/Chat/ChatViewModel+Server.swift`, "func ensureServerChat()");
  const wait = ensure.indexOf("if let running = creationJob {");
  const fresh = ensure.indexOf("let job = Task { try await self.createDraftNow() }");
  assert.ok(wait > 0 && fresh > wait, "a second caller starts its own creation instead of waiting for the running one");
  assert.ok(ensure.slice(wait, fresh).includes("try await running.value"), "the second caller does not wait for the running job");
  assert.ok(ensure.includes("creationJob = job") && ensure.includes("defer { creationJob = nil }"),
    "the job is not remembered or not reset afterwards (a failure would block every further creation)");
  // The creation runs only via this job.
  const creation = body(`${IOS}/Chat/ChatViewModel+Server.swift`, "private func createDraftNow()");
  assert.ok(creation.includes("let created = try await createChatNow(draft)"), "the creation bypasses `createDraftAn`");
  // A change during the creation waits for it.
  const update = body(`${IOS}/Chat/ChatViewModel+Actions.swift`, "func updateSettings(");
  assert.ok(update.indexOf("await waitForCreation()") < update.indexOf("if isDraft {"), "a change during the creation misses the created chat");
  const code = swift(`${IOS}/Chat/ChatViewModel+Server.swift`);
  assert.equal(code.split("createDraftNow()").length - 1, 2, "`createDraftNow` has a second caller besides `ensureServerChat`");
});

// (2) `/effort` with the level that already applies did not stick. The EXPLICIT path (`/effort <level>`, `/effort ultracode`, the effort
// selection of the chat sheet) ALWAYS sends the level or `ultracode`, with `effortChoice: true` (the server then sets the marker even at
// the same value); every other path (model change) still sends no passed-through level. The fixture accepts the PATCH — EXECUTED.
// Counter-tests (each red once, then restored): in `/effort <level>` `, effortChoice: true` removed => red; in the level computation
// `!effortChoice && ` removed => red; in the body `effortChoice: effortChoice && …` → `effortChoice: effortChoice ? true : nil` => red;
// in the fixture the check for `effortChoice` ends with `return "x"` (a valid `effortChoice` => 400) => red; in the fixture the line
// "only next to effort or ultracode" removed => red.
test("(2) the explicit level choice always goes out, with `effortChoice: true` — a model change never as a level", async () => {
  // The explicit path: every call in the `/effort` branch carries `effortChoice: true`, no other slash branch.
  const run = body(`${IOS}/Chat/ChatViewModel+Slash.swift`, "func runSlash(");
  const effortFall = run.slice(run.indexOf('case "effort":'), run.indexOf('case "mode":'));
  const calls = effortFall.split("updateSettings(").length - 1;
  assert.ok(calls >= 2, "the `/effort` branch no longer calls `updateSettings` for level and ultracode");
  assert.equal(effortFall.split("effortChoice: true").length - 1, calls, "not every call in the `/effort` branch is an explicit choice (`effortChoice: true`)");
  assert.ok(!run.slice(run.indexOf('case "mode":')).includes("effortChoice"), "`/mode` or `/model` counts as a level choice");
  // The chat sheet (coding): only whoever touched the selection — remembered via the binding, reset on reconcile.
  const sheet = swift(`${IOS}/Chat/ChatSheets.swift`);
  assert.ok(sheet.includes("EffortSelection(effort: levelChoice,") && sheet.includes("effortChoice: levelSelected"), "the chat sheet does not report the choice of the effort selection");
  assert.ok(body(`${IOS}/Chat/ChatSheets.swift`, "private var levelChoice: Binding<String>").includes("levelSelected = true"), "the binding of the effort selection does not remember the choice");
  assert.ok(body(`${IOS}/Chat/ChatSheets.swift`, "private func syncSelections()").includes("levelSelected = false"), "the reconcile leaves a discarded choice standing");

  // `updateSettings`: no empty level (next to ultracode it goes along, two axes), and `effortChoice` appears only next to `effort`/`ultracode`.
  const update = body(`${IOS}/Chat/ChatViewModel+Actions.swift`, "func updateSettings(");
  assert.match(update, /effortChoice: Bool = false\s*\) async throws \{/, "`updateSettings` has no parameter `effortChoice` defaulting to false");
  assert.ok(update.includes("let level: String? = effort.isEmpty ? nil : effort"),
    "an empty level goes out");
  assert.ok(update.includes("effort: level,") && update.includes("effortChoice: effortChoice && (level != nil || ultracode != nil) ? true : nil"),
    "`effortChoice` goes out without `effort`/`ultracode` (a 400 at the server) or not at all");
  assert.match(update, /let effortChoice: Bool\?/, "the PATCH body carries no optional `effortChoice` (missing = omitted)");
  // The coding draft adopts every value locally and sends it in the POST.
  const draft = update.slice(update.indexOf("if isDraft {"), update.indexOf("return", update.indexOf("if isDraft {")));
  assert.ok(draft.includes("chat.permissionMode = permissionMode") && draft.includes("chat.effort = effort"), "the draft does not adopt mode or level");
  assert.ok(!draft.includes("draftChoice"), "the draft remembers a choice for a follow-up again");

  // The fixture accepts the PATCH (no 400), does not carry the field as a column of the chat row and holds the server's rule.
  const { routesChat } = await import(pathToFileURL(path.join(repo, "mobile/test-fixtures/chat-gateway/routes-chat.mjs")).href);
  const { chatId } = await import(pathToFileURL(path.join(repo, "mobile/test-fixtures/chat-gateway/state.mjs")).href);
  async function patch(id, bodyData) {
    const req = (async function* () { yield Buffer.from(JSON.stringify(bodyData)); })();
    const response = { status: 0, text: "" };
    const res = { writeHead(s) { response.status = s; }, end(t) { response.text = String(t ?? ""); } };
    const url = new URL(`http://127.0.0.1/api/chats/${id}`);
    await routesChat({ req, res, url, path: url.pathname, method: "PATCH" });
    return { status: response.status, chat: response.text ? JSON.parse(response.text) : null };
  }
  for (const [kind, id] of [["Coding", chatId]]) {
    for (const bodyData of [{ effort: "high", ultracode: false, effortChoice: true }, { ultracode: true, effortChoice: true }, { effort: "low", effortChoice: true }]) {
      const r = await patch(id, bodyData);
      assert.equal(r.status, 200, `Fixture (${kind}): PATCH ${JSON.stringify(bodyData)} ⇒ ${r.status}`);
      assert.ok(!("effortChoice" in r.chat), `the fixture (${kind}) carries \`effortChoice\` as a field of the chat row`);
    }
    assert.equal((await patch(id, { effortChoice: true })).status, 400, `Fixture (${kind}): \`effortChoice\` alone is a 400 at the server`);
    assert.equal((await patch(id, { effort: "high", effortChoice: "yes" })).status, 400, `Fixture (${kind}): an \`effortChoice\` without a boolean is a 400 at the server`);
  }
});

test("(8/10) Settings → Chats — the PUT reads at firing time, the last change wins; both fields mandatory when reading", () => {
  const doc = body(`${IOS}/Settings/ChatSettings.swift`, "struct ChatAutoArchiveDoc:");
  assert.ok(doc.includes("on = try c.decode(Bool.self, forKey: .on)") && doc.includes("days = try c.decode(Int.self, forKey: .days)"),
    "ChatAutoArchiveDoc reads leniently again — a response without fields would become \"off, 30 days\"");
  const change = body(`${IOS}/Settings/ChatSettings.swift`, "private func change(");
  assert.ok(change.indexOf("round &+= 1") < change.indexOf("throttle?.cancel()"), "the round does not count on change");
  assert.match(change, /try\? await Task\.sleep\(nanoseconds: 600_000_000\)\s*guard !Task\.isCancelled else \{ return \}\s*submit\(\)/,
    "the throttle does not send via `submit` (the state at firing time)");
  const deviations = body(`${IOS}/Settings/ChatSettings.swift`, "private func submit()");
  assert.match(deviations, /await prior\?\.value\s*guard my == round, let current = snapshot else \{ return \}\s*await save\(current, round: my\)/,
    "the PUT does not wait for the previous one or does not send the state of NOW");
  const page = swift(`${IOS}/Settings/ChatSettings.swift`);
  assert.ok(!/save\(an:/.test(page), "a caller still saves values from the time of the keystroke");
  const sp = body(`${IOS}/Settings/ChatSettings.swift`, "private func save(");
  assert.ok(sp.includes("body: ChatAutoArchiveBody(on: value.on, days: value.days)"), "the PUT does not carry both fields");
  const capture = sp.slice(sp.indexOf("} catch {"));
  assert.ok(capture.indexOf("back()") > 0 && capture.indexOf("error = error.localizedDescription") > capture.indexOf("back()"),
    "a failure does not fall back to the confirmed state or shows no error line");
});
