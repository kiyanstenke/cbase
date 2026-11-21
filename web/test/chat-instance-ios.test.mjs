// The instance of a coding chat on iOS. The pure rules live in mobile/CbaseMobile/Chat/ChatInstanceRules.swift and are REALLY compiled
// here with `xcrun swiftc` (together with Models/JSONValue.swift and Code/InstancesTree.swift, which they read) and EXECUTED; that the
// views use them is checked by the second part at the source.
//
// The claims, each with the way that breaks it:
//   (25) The header follows every change of `chats.instance` that the server reports (`harness`/`chat_settings {instance}`, also `null`),
//        and the divider "now works in …" is reloaded — immediately without a running turn, otherwise at the end of the run; likewise after
//        the own switch (`selectInstance`). A `chat_settings` WITHOUT `instance` (run fields of the workflow driver) says nothing about the
//        instance.
//   (26) A draft holds its copy only while it is an option (otherwise main), and a 409 UNKNOWN_INSTANCE on creation drops the choice;
//        the choice is visible while the chat is bound to a copy, even without options (main as the way back, the binding "no longer
//        available").
//   (32) The state in the menu is a WORD of the "Instances" tab (`ProjectInstancesPage.situationText` via `InstancesTree.situationOf`), never raw.
//   A converted project without a ready copy has the option main alone (`InstancesTree.chatInstanceOptions`, bound in
//        instances-tree-binding.test.mjs) — the menu stands with main selected, and `copyCreate` offers "Create copy …" exactly when there
//        are options (not for a binding to a dead copy without options: then there is no "Instances" tab). That the menu shows the entry and
//        where it leads is checked by instances-ui.test.mjs. Counter-test: `copyCreate` always returns `true` ⇒ "Rules" red.
//
// Run:  node --test web/test/chat-instance-ios.test.mjs   (macOS only: xcrun — latch.json `onlyMacOS`)
// COUNTER-TESTS (each shown red):
//   - without ChatInstanceRules.swift and without `case "chat_settings"` ⇒ both tests red;
//   - in ChatInstanceRules.swift `guard let raw = event["instance"] else { return .no }` → `let raw = event["instance"] ?? .null`
//     (a missing field would mean main) ⇒ "Rules" red;
//   - in ChatViewModel+Stream.swift the call `historyAfterInstanceSwitch()` in the case `chat_settings` removed ⇒ "Views" red.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const APP = path.join(repo, "mobile", "CbaseMobile");
const SOURCES = [
  path.join(APP, "Models", "JSONValue.swift"),
  path.join(APP, "Code", "InstancesTree.swift"),
  path.join(APP, "Chat", "ChatInstanceRules.swift"),
];
const read = (...parts) => fs.readFileSync(path.join(APP, ...parts), "utf8");
const withoutComments = (q) => q.split("\n").filter((z) => !/^\s*\/\//.test(z)).join("\n");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleaning up says nothing about the product */ } });

const EVENTS = [
  { ev: { type: "harness", subtype: "chat_settings", instance: "copy-k1" }, desired: { kind: "instance", value: "copy-k1" } },
  { ev: { type: "harness", subtype: "chat_settings", instance: null }, desired: { kind: "instance", value: null } },
  { ev: { type: "harness", subtype: "chat_settings", instance: "main" }, desired: { kind: "instance", value: null } },
  { ev: { type: "harness", subtype: "chat_settings", instance: "  " }, desired: { kind: "instance", value: null } },
  { ev: { type: "harness", subtype: "chat_settings", instance: " copy-k2 " }, desired: { kind: "instance", value: "copy-k2" } },
  // The workflow driver (workflows/driver.js) reports only run fields under the same name — no statement about the instance.
  { ev: { type: "harness", subtype: "chat_settings", model: "opus", permissionMode: "plan" }, desired: { kind: "no" } },
  { ev: { type: "harness", subtype: "chat_settings", instance: 5 }, desired: { kind: "no" } },
  { ev: { type: "harness", subtype: "chat_settings", instance: { name: "copy-k1" } }, desired: { kind: "no" } },
];
const DRAFT = [
  { selected: "copy-k1", live: ["main", "copy-k1"], desired: "copy-k1" },
  { selected: "copy-k1", live: ["main", "copy-k2"], desired: null }, // k1 deleted, k2 lives: back to main
  { selected: "copy-k1", live: ["main"], desired: null }, // the only copy is gone: only main left
  { selected: "copy-k1", live: [], desired: null }, // no options (the project no longer converted, field not readable)
  { selected: null, live: ["main", "copy-k1"], desired: null },
  { selected: "main", live: ["main", "copy-k1"], desired: null },
  { selected: "", live: [], desired: null },
];
const o = (name, state = "ready") => ({ name, identifier: `p1/${name}`, state });
const e = (name, state = "ready", selectable = true) => ({ name, state, selectable });
const MENU = [
  { options: [], selected: null, desired: [] }, // no converted project (or field not read): no menu
  { options: [], selected: "main", desired: [] },
  // Converted but without a ready copy — main alone (selected); below it "Create copy …" (`copyCreate`).
  { options: [o("main")], selected: null, desired: [e("main")] },
  { options: [o("main", "stopped")], selected: "copy-k1", desired: [e("main", "stopped"), e("copy-k1", "", false)] },
  { options: [o("main"), o("copy-k1", "stopped")], selected: null, desired: [e("main"), e("copy-k1", "stopped")] },
  { options: [o("main"), o("copy-k1")], selected: "copy-k1", desired: [e("main"), e("copy-k1")] },
  // Bound to a copy that is no longer an option — the choice stays visible, main is the way back.
  { options: [], selected: "copy-k1", desired: [e("main", "", true), e("copy-k1", "", false)] },
  { options: [o("main", "start"), o("copy-k2")], selected: "copy-k1", desired: [e("main", "start"), e("copy-k2"), e("copy-k1", "", false)] },
];
// The state of an option as the situation of the tree (and thus as a word of `situationText`).
const ROWS = [
  { name: "main", state: "start", desired: "starts" },
  { name: "copy-k1", state: "start", desired: "starts" },
  { name: "copy-k1", state: "stopped", desired: "stopped" },
  { name: "copy-k1", state: "ready", desired: "ready" },
  { name: "main", state: "recreate", desired: "starts" },
  { name: "main", state: "relocation", desired: "starts" },
  { name: "main", state: "error", desired: "error" },
  { name: "main", state: "clearAway", desired: "clearAway" },
  { name: "main", state: "something", desired: "unknown" },
  { name: "bogus", state: "start", desired: null },
];

const DRIVER = `import Foundation
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
func empty(_ v: String?) -> Any { v ?? NSNull() }
var announcements: [Any] = []
for raw in root["events"] as! [String] {
    let ev = try! JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    switch ChatInstanceRules.announcement(ev) {
    case .no: announcements.append(["kind": "no"] as [String: Any])
    case .instance(let w): announcements.append(["kind": "instance", "value": empty(w)] as [String: Any])
    }
}
var draft: [Any] = []
for f in root["draft"] as! [[String: Any]] {
    draft.append(empty(ChatInstanceRules.draftChoice(f["selected"] as? String, live: f["live"] as! [String])))
}
var menu: [Any] = []
var create: [Bool] = []
for f in root["menu"] as! [[String: Any]] {
    let options = (f["options"] as! [[String: String]]).map { InstancesTree.Option(name: $0["name"]!, identifier: $0["identifier"]!, state: $0["state"]!) }
    menu.append(ChatInstanceRules.entries(options, selected: f["selected"] as? String).map { ["name": $0.name, "state": $0.state, "selectable": $0.selectable] as [String: Any] })
    create.append(ChatInstanceRules.copyCreate(options))
}
var states: [Any] = []
for f in root["rows"] as! [[String: String]] {
    states.append(empty(ChatInstanceRules.row(name: f["name"]!, state: f["state"]!).map { InstancesTree.situationOf($0).rawValue }))
}
print(String(data: try! JSONSerialization.data(withJSONObject: ["announcements": announcements, "draft": draft, "menu": menu, "create": create, "states": states]), encoding: .utf8)!)
`;

test("Rules (executed): announcement from chat_settings, draft against the live options, menu entries, state as situation of the tree", () => {
  for (const q of SOURCES) {
    const text = fs.readFileSync(q, "utf8");
    assert.deepEqual(text.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], `${path.basename(q)} imports only Foundation`);
    assert.ok(!/\bL\(/.test(withoutComments(text)), `${path.basename(q)} does not translate itself (no L(…))`);
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-instance-ios-"));
  const files = SOURCES.map((q) => { const z = path.join(tmp, path.basename(q)); fs.copyFileSync(q, z); return z; });
  const main = path.join(tmp, "main.swift");
  fs.writeFileSync(main, DRIVER);
  const bin = path.join(tmp, "driver");
  try {
    execFileSync("xcrun", ["swiftc", "-o", bin, ...files, main], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    assert.fail(`the Swift source could not be compiled (xcrun swiftc): ${err.stderr || err.message}`);
  }
  const cases = path.join(tmp, "cases.json");
  const withoutDesired = ({ desired: _desired, ...rest }) => rest;
  fs.writeFileSync(cases, JSON.stringify({
    events: EVENTS.map((x) => JSON.stringify(x.ev)), draft: DRAFT.map(withoutDesired), menu: MENU.map(withoutDesired), rows: ROWS.map(withoutDesired),
  }));
  const out = JSON.parse(execFileSync(bin, [cases], { encoding: "utf8" }).trim().split("\n").pop());
  EVENTS.forEach((x, i) => assert.deepEqual(out.announcements[i], x.desired, `announcement ${JSON.stringify(x.ev)}`));
  DRAFT.forEach((x, i) => assert.equal(out.draft[i], x.desired, `draft ${JSON.stringify(x)}`));
  MENU.forEach((x, i) => assert.deepEqual(out.menu[i], x.desired, `menu ${JSON.stringify(x)}`));
  // "Create copy …" exactly with options — also where main is the only one; never for a binding to a dead copy without options.
  MENU.forEach((x, i) => assert.equal(out.create[i], x.options.length > 0, `create copy ${JSON.stringify(x)}`));
  assert.ok(MENU.some((x) => x.options.length === 0 && x.desired.length > 0), "no case \"binding to a dead copy without options\"");
  assert.ok(MENU.some((x) => x.options.length === 1), "no case \"converted, only main\"");
  ROWS.forEach((x, i) => assert.equal(out.states[i], x.desired, `row ${JSON.stringify(x)}`));
});

test("Views (source): stream, header, composer and creation use the rules — reload the divider, hold the draft, word instead of identifier", () => {
  // (25) The stream evaluates chat_settings: take over the binding, reload the history — and the end of the run fetches a deferred divider.
  const stream = withoutComments(read("Chat", "ChatViewModel+Stream.swift"));
  const start = stream.indexOf('case "chat_settings":');
  assert.ok(start >= 0, "handleHarness has no case `chat_settings`");
  const fall = stream.slice(start, stream.indexOf("\n        case ", start));
  assert.match(fall, /guard case \.instance\(let fresh\) = ChatInstanceRules\.announcement\(event\) else \{ break \}/, "chat_settings does not ask the rule");
  assert.match(fall, /chat\.instance = fresh/, "chat_settings does not take over the binding");
  assert.match(fall, /historyAfterInstanceSwitch\(\)/, "chat_settings does not reload the divider");
  assert.match(stream, /if joinedMidRun \|\| historyAfterRun \{\s*joinedMidRun = false\s*historyAfterRun = false\s*Task \{ await reloadChatAndLog\(\) \}/, "run_done does not fetch a deferred divider");
  const header = withoutComments(read("Chat", "ChatHeader.swift"));
  const select = header.slice(header.indexOf("func selectInstance"), header.indexOf("func historyAfterInstanceSwitch"));
  assert.match(select, /chat = updated\s*onChanged\(\)\s*historyAfterInstanceSwitch\(\)/, "the own switch does not reload the divider");
  assert.match(header, /func historyAfterInstanceSwitch\(\) \{\s*guard !isDraft else \{ return \}\s*if busy \{ historyAfterRun = true \} else \{ Task \{ await reloadChatAndLog\(\) \} \}/, "in the middle of a turn the history would be reloaded (wipes the answer text)");
  assert.match(read("Chat", "ChatViewModel.swift"), /var historyAfterRun = false \/\/ internal, for extensions/);
  // (26) The draft holds its copy only while it is an option — at the line that is always present in the draft.
  const composer = withoutComments(read("Chat", "ChatComposer.swift"));
  assert.match(composer, /\.onChange\(of: model\.instanceOptions\(in: state\)\.map\(\\\.name\), initial: true\) \{ _, live in\s*model\.holdDraftInstance\(live\)/, "the draft holds a dead copy");
  assert.match(header, /func holdDraftInstance\(_ live: \[String\]\) \{\s*guard isDraft else \{ return \}\s*let fresh = ChatInstanceRules\.draftChoice\(chat\.instance, live: live\)/);
  assert.match(withoutComments(read("Chat", "ChatViewModel+Server.swift")), /\} catch let e as APIError where e\.code == "UNKNOWN_INSTANCE" && draft\.instance != nil \{\s*chat\.instance = nil\s*throw e/, "a 409 on creation leaves the dead choice standing");
  // (26) The menu is built from the entries (also without options, while a copy is bound), the binding not selectable.
  const choice = header.slice(header.indexOf("struct ChatInstanceChoice"));
  assert.match(choice, /let entries = ChatInstanceRules\.entries\(model\.instanceOptions\(in: state\), selected: model\.chat\.instance\)/);
  assert.match(choice, /if !entries\.isEmpty \{/, "the menu still hangs on the options alone");
  assert.match(choice, /let create = ChatInstanceRules\.copyCreate\(model\.instanceOptions\(in: state\)\)/, "\"Create copy …\" does not ask the rule");
  assert.match(choice, /\.disabled\(!o\.selectable\)/);
  // (32) No raw state, but the word of the tree.
  assert.ok(!/\\\(o\.state\)/.test(choice), "the state stands raw in the menu");
  assert.match(choice, /ChatInstanceRules\.row\(name: e\.name, state: e\.state\)/);
  assert.match(choice, /return "\\\(e\.name\) · \\\(ProjectInstancesPage\.situationText\(row\)\)"/, "the menu does not translate the state via situationText");
  // The new sentence is in the English table (loc-audit checks the literals, here the key itself).
  assert.match(read("Kit", "LocDEInstances.swift"), /"\{name\} · no longer available": "/);
});
