// The message of an agent, bound: server, web and iOS read it by the SAME rule (agent communication).
//
// The third kind under the role `user` (beside user message and completion notice): a message with cause "message"
// is stored by the server as the input of a turn in the form
//   <cbase-message from="…" kind="agent|outer_loop" address="…">\n<text, defused>\n</cbase-message>
// built in ONE place (server/backend/electron/server/runs/message-marker.js: MESSAGE_MARKER, buildMessage,
// readMessage). It is read three times: `readMessage` in the server, web/src/lib/agents-message.ts and
// mobile/CbaseMobile/Chat/InboundAgentMessage.swift. If one reading drifts, one surface shows "Message from X" with a
// different sender or text than the other, or the XML appears as a user bubble. This is a CONTRACT between the three
// sides, not a UI test: the switches and the reducer are checked, never a drawn view.
//
// The server file is loaded IF it exists; otherwise the test checks against the copy `buildCopy` below and says so in
// a diagnostic line. The Swift sources are taken WHOLE (they import only Foundation), assembled with a stub for `L`
// into one program and REALLY run with `xcrun swift`; if the toolchain is missing, the test fails LOUDLY (hence
// registered in `latch.json` under `onlyMacOS`). Model: completion-notice-binding.test.mjs.
//
// Counter-tests (shown red, reverted): in InboundAgentMessage.swift the body via `String.hasSuffix("\n")` instead
// of UTF-16 makes the case "\r\n at the end" deviate; in lib/agents-message.ts `&amp;` defused first turns
// "&amp;lt; stays &lt;" red; in lib/completionNotice.ts the message switch in `queueEntry` removed makes the queue
// web differ from iOS; in chatBubbles.ts the branch in `buildBubbles` removed turns the reducer test red.
//
// Run:  node --test web/test/agents-message-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const SOURCE_TS = path.join(webDir, "src", "lib", "agents-message.ts");
const SOURCE_FINISHED_TS = path.join(webDir, "src", "lib", "completionNotice.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "InboundAgentMessage.swift");
const SOURCE_FINISHED_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "CompletionNotice.swift");
const SERVER = path.join(repo, "server", "backend", "electron", "server", "runs", "message-marker.js");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-message-binding-")));

// ── The server, or the copy of its rule ───────────────────────────────────────────────────────────────────────────
// A leaf module (runs/message-marker.js), importable without the data layer.
const server = fs.existsSync(SERVER) ? await import(pathToFileURL(SERVER).href) : null;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const buildCopy = ({ from, kind, address, text }) =>
  `<cbase-message from="${esc(from)}" kind="${esc(kind)}" address="${esc(address)}">\n${esc(text)}\n</cbase-message>`;
const build = server ? server.buildMessage : buildCopy;

// ── The cases ───────────────────────────────────────────────────────────────────────────────────────────────────
// (1) BUILT by the server (or the copy): the reading must return exactly the input.
const INPUTS = [
  { title: "simple", n: { from: "Chat A", kind: "agent", address: "chat:abc", text: "Hello" } },
  { title: "Outer loop", n: { from: "Release loop", kind: "outer_loop", address: "loop:r1", text: "Round 3 done." } },
  { title: "graph sender", n: { from: "Job → Ship", kind: "agent", address: "graph:s1", text: "Step n5 needs the migration." } },
  { title: "characters that are defused", n: { from: "Chat \"x\" > y & <z>", kind: "agent", address: "chat:a&b", text: "a & b <c> \"d\" &lt; &amp; '" } },
  { title: "the end element in the text", n: { from: "A", kind: "agent", address: "chat:1", text: "before </cbase-message> after" } },
  { title: "line breaks at the edge", n: { from: "A", kind: "agent", address: "chat:1", text: "\nline one\nline two\n" } },
  { title: "\\r\\n at the end", n: { from: "A", kind: "agent", address: "chat:1", text: "a\r\nb\r\n" } },
  { title: "empty text", n: { from: "A", kind: "agent", address: "chat:1", text: "" } },
  { title: "without sender", n: { from: "", kind: "agent", address: "", text: "anonymous" } },
  { title: "umlauts and emoji", n: { from: "Grüße-Chat", kind: "agent", address: "chat:ü", text: "Grüße 👋 — „Zitat“" } },
  { title: "Markdown", n: { from: "A", kind: "agent", address: "chat:1", text: "# Title\n\n- one\n- two\n\n```js\nif (a < b && c > d) {}\n```" } },
];
const BUILT = INPUTS.map((e) => ({ title: `built: ${e.title}`, text: build(e.n), read: e.n }));

// (2) By hand: edge cases with the expectation written out (`read`: result of readMessage; `card`: what the card
// shows, if it differs from `read`).
const M = "<cbase-message";
const n = (from, kind, address, text) => ({ from, kind, address, text });
const HAND = [
  { title: "hand: well-formed", text: `${M} from="A" kind="agent" address="chat:1">\nText\n</cbase-message>`, read: n("A", "agent", "chat:1", "Text") },
  { title: "hand: without line breaks", text: `${M} from="A" kind="agent" address="chat:1">Text</cbase-message>`, read: n("A", "agent", "chat:1", "Text") },
  { title: "hand: two breaks at the edge, only one each drops", text: `${M} from="A">\n\nText\n\n</cbase-message>`, read: n("A", "", "", "\nText\n") },
  // A `\r\n` directly before the end: only the `\n` drops (UTF-16 as in JavaScript); Swift's `hasSuffix("\n")` would
  // see `\r\n` as ONE character and leave both.
  { title: "hand: \\r\\n directly before the end", text: `${M} from="A">\nText\r\n</cbase-message>`, read: n("A", "", "", "Text\r") },
  { title: "hand: order of the values does not matter", text: `${M} address="graph:9" kind="outer_loop" from="L">\nx\n</cbase-message>`, read: n("L", "outer_loop", "graph:9", "x") },
  { title: "hand: duplicate value, the first applies", text: `${M} from="A" from="B">\nx\n</cbase-message>`, read: n("A", "", "", "x") },
  { title: "hand: missing values are empty", text: `${M}>\nx\n</cbase-message>`, read: n("", "", "", "x") },
  { title: "hand: capital letters in the name", text: `${M} Von="X">\nx\n</cbase-message>`, read: n("", "", "", "x") },
  { title: "hand: unknown kind stays", text: `${M} from="A" kind="system">\nx\n</cbase-message>`, read: n("A", "system", "", "x") },
  { title: "hand: &amp;lt; stays &lt;", text: `${M} from="&amp;quot;">\n&amp;lt;b&amp;gt; &quot;q&quot;\n</cbase-message>`, read: n("&quot;", "", "", "&lt;b&gt; \"q\"") },
  { title: "hand: the LAST end counts", text: `${M} from="A">\na</cbase-message>b\n</cbase-message>`, read: n("A", "", "", "a</cbase-message>b") },
  { title: "hand: trailer after the end", text: `${M} from="A">\nx\n</cbase-message>\nPostscript`, read: n("A", "", "", "x") },
  { title: "hand: > in a value ends the head", text: `${M} from="a>b">\nx\n</cbase-message>`, read: n("", "", "", "b\">\nx") },
  { title: "hand: without end", text: `${M} from="A">\nText without closing`, read: null, card: n("", "", "", `${M} from="A">\nText without closing`) },
  { title: "hand: without head end", text: `${M} from="A"`, read: null, card: n("", "", "", `${M} from="A"`) },
  { title: "hand: similar element name", text: "<cbase-messages>\nx\n</cbase-messages>", read: null, card: n("", "", "", "<cbase-messages>\nx\n</cbase-messages>") },
  { title: "none: ordinary text", text: "Hello <cbase-message from=\"A\">", read: null, card: null },
  { title: "none: space before", text: ` ${M} from="A">\nx\n</cbase-message>`, read: null, card: null },
  { title: "none: completion notice", text: "<task-notification>\n<task-id>a1</task-id>\n<summary>Agent \"A\" completed</summary>\n</task-notification>", read: null, card: null },
  { title: "none: empty", text: "", read: null, card: null },
];
const CASES = [...BUILT, ...HAND].map((f) => ({ ...f, card: "card" in f ? f.card : f.read }));

// ── Web ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let webMod = null;
async function loadWeb() {
  if (webMod) return webMod;
  const out = path.join(tmpDir(), "web");
  // completionNotice.ts pulls in agents-message.ts relatively; one compilation delivers both.
  execFileSync(process.execPath, [tsc, SOURCE_FINISHED_TS, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const message = await import(pathToFileURL(path.join(out, "agents-message.js")).href);
  const finished = await import(pathToFileURL(path.join(out, "completionNotice.js")).href);
  webMod = { ...message, queueEntry: finished.queueEntry };
  return webMod;
}
// The same placeholder replacement as `fmt` in src/lib/i18n.ts; English is the key.
const t = (k, p) => (p ? k.replace(/\{(\w+)\}/g, (m, x) => (x in p ? String(p[x]) : m)) : k);

// The queue: every text with and without the server's flag.
const QUEUE = CASES.flatMap((f) => [true, false, null].map((systemNotice) => ({ text: f.text, systemNotice })));

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let iosResult = null;
function runIos() {
  if (iosResult) return iosResult;
  const sources = [SOURCE_SWIFT, SOURCE_FINISHED_SWIFT].map((d) => fs.readFileSync(d, "utf8"));
  for (const [i, q] of sources.entries()) {
    assert.deepEqual(q.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"],
      `${path.basename([SOURCE_SWIFT, SOURCE_FINISHED_SWIFT][i])} imports only Foundation; otherwise it no longer runs alone here`);
  }
  const input = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(input, JSON.stringify({ texts: CASES.map((f) => f.text), queue: QUEUE }));
  const file = path.join(tmpDir(), "message.swift");
  fs.writeFileSync(file, `${sources[0]}
${sources[1].replace(/^import Foundation\n/m, "")}

// ── Stub and driver (web/test/agents-message-binding.test.mjs) ──
func L(_ key: String) -> String { key }
func L(_ key: String, _ params: [String: CustomStringConvertible]) -> String {
    var s = key
    for (k, v) in params { s = s.replacingOccurrences(of: "{\\(k)}", with: v.description) }
    return s
}
func asJson(_ n: InboundAgentMessage?) -> Any {
    guard let n else { return NSNull() }
    return ["from": n.from, "kind": n.kind, "address": n.address, "text": n.text]
}
let data = try! Data(contentsOf: URL(fileURLWithPath: ${JSON.stringify(input)}))
let root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
var cases: [Any] = []
for text in root["texts"] as! [String] {
    let card = InboundAgentMessage.card(text)
    cases.append(["isMessage": InboundAgentMessage.isMessage(text), "read": asJson(InboundAgentMessage.read(text)), "card": asJson(card),
                   "header": card.map { $0.header as Any } ?? NSNull()])
}
var queue: [Any] = []
for q in root["queue"] as! [[String: Any]] {
    let flag = q["systemNotice"] as? Bool
    if let z = CompletionNotice.queue(text: q["text"] as! String, systemNotice: flag) { queue.append(z) } else { queue.append(NSNull()) }
}
let outData = try! JSONSerialization.data(withJSONObject: ["cases": cases, "queue": queue])
print(String(data: outData, encoding: .utf8)!)
`);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift sources could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  iosResult = JSON.parse(output.trim().split("\n").pop());
  return iosResult;
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────────────────────
test("server <-> web <-> iOS: kind, sender, type, address and text; case by case the same reading, and the right one", async (tc) => {
  tc.diagnostic(server
    ? "server rule: runs/message-marker.js"
    : "server rule: runs/message-marker.js is still missing; building and reading use the copy of this file (buildCopy)");
  const web = await loadWeb();
  const ios = runIos();
  assert.equal(ios.cases.length, CASES.length);
  assert.equal(web.MESSAGE_MARKER, "<cbase-message");
  if (server) assert.equal(server.MESSAGE_MARKER, web.MESSAGE_MARKER, "server and web recognize the kind by different beginnings");
  CASES.forEach((f, i) => {
    const w = { isMessage: web.isMessage(f.text), read: web.readMessage(f.text), card: web.messageCard(f.text) };
    assert.deepEqual(w.read, f.read, `${f.title}: web reads wrongly`);
    assert.deepEqual(w.card, f.card, `${f.title}: web shows a wrong card`);
    assert.equal(w.isMessage, f.card !== null, `${f.title}: web recognizes the kind wrongly`);
    assert.deepEqual({ isMessage: ios.cases[i].isMessage, read: ios.cases[i].read, card: ios.cases[i].card }, w, `${f.title}: iOS deviates from the web`);
    if (server) assert.deepEqual(server.readMessage(f.text), f.read, `${f.title}: the server reads differently from web and iOS`);
  });
});

test("header of the card and queue: web and iOS alike, written out for every kind", async () => {
  const web = await loadWeb();
  const ios = runIos();
  CASES.forEach((f, i) => {
    const k = f.card ? web.messageHeader(f.card) : null;
    assert.equal(ios.cases[i].header, k ? t(k.label, k.labelParams) : null, `${f.title}: header web ≠ iOS`);
  });
  const header = (from, kind) => { const k = web.messageHeader({ from, kind }); return t(k.label, k.labelParams); };
  assert.equal(header("Chat A", "agent"), "Message from Chat A");
  assert.equal(header("Release", "outer_loop"), "Outer loop Release");
  assert.equal(header("A", "system"), "Message from A", "an unknown kind is called message");
  assert.equal(header("", "agent"), "Message from an agent");
  assert.equal(header("", "outer_loop"), "Outer loop");
  // The queue: a message is a system row without trash can, whether or not the server flags it; and the completion
  // notice switch behind it stays unchanged.
  assert.equal(ios.queue.length, QUEUE.length);
  QUEUE.forEach((q, i) => {
    const e = web.queueEntry({ text: q.text, ...(q.systemNotice === null ? {} : { systemNotice: q.systemNotice }) });
    const webRow = e.systemNotice ? t(e.label, e.labelParams) : null;
    assert.equal(ios.queue[i], webRow, `entry ${i} (${JSON.stringify(q).slice(0, 90)}): web and iOS deviate`);
  });
  const message = build({ from: "Chat B", kind: "agent", address: "chat:b", text: "Question" });
  for (const systemNotice of [undefined, false, true]) {
    const e = web.queueEntry({ text: message, ...(systemNotice === undefined ? {} : { systemNotice }) });
    assert.equal(e.systemNotice && t(e.label, e.labelParams), "Message from Chat B", `systemNotice=${systemNotice}`);
  }
  assert.equal(web.queueEntry({ text: "And another question" }).systemNotice, false, "an input stays an input");
});

// The reducer of the coding chat (chat/chatBubbles.ts), built from the history and from the stream: a card, no user
// bubble, and an open question stays open (nobody wrote). The counter-test is in the test: the same line as ordinary
// text closes the question and becomes a bubble.
test("reducer: the message becomes a card (in the history, as user_message and as message_injected), no bubble, no closed question", async () => {
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".message-reducer-"));
  let mod;
  try {
    execFileSync(process.execPath, [
      tsc, path.join(webDir, "src", "components", "chat", "chatBubbles.ts"),
      "--outDir", out, "--rootDir", path.join(webDir, "src"), "--module", "es2022", "--target", "es2022",
      "--moduleResolution", "bundler", "--noCheck", "--isolatedModules", "--skipLibCheck",
    ], { cwd: webDir, stdio: "pipe" });
    mod = await import(pathToFileURL(path.join(out, "components", "chat", "chatBubbles.js")).href);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  const text = build({ from: "Chat B", kind: "agent", address: "chat:b", text: "Is **the migration** done yet?" });
  const ask = { id: 1, role: "ask", ts: 1, text: JSON.stringify({ requestId: "r1", questions: [{ question: "Continue?", options: [] }] }) };
  const history = mod.buildBubbles([ask, { id: 2, role: "user", ts: 2, text }]);
  assert.deepEqual(history.map((b) => b.role), ["ask", "message"]);
  assert.deepEqual(history[1].message, { from: "Chat B", kind: "agent", address: "chat:b", text: "Is **the migration** done yet?" });
  assert.equal(history[0].ask.answerable, true, "an agent's message does not close a question");
  const against = mod.buildBubbles([ask, { id: 2, role: "user", ts: 2, text: "Is the migration done yet?" }]);
  assert.deepEqual(against.map((b) => b.role), ["ask", "user"], "counter-test: an ordinary text stays a user bubble");
  assert.equal(against[0].ask.answerable, false, "counter-test: an ordinary text closes the question");

  const ctx = {
    stream: { open: false, gotText: false }, now: 0, wfStatus: undefined, activeId: null, joined: false, runStart: null,
    inTok: 0, outTok: 0, t, resultToText: () => "",
  };
  const start = mod.buildBubbles([ask]);
  const live = mod.reduceChatEvent(start, { type: "harness", subtype: "user_message", text }, ctx);
  assert.deepEqual(live.map((b) => b.role), ["ask", "message"], "user_message: card instead of bubble");
  assert.equal(live[0].ask.answerable, true, "user_message: the question stays open");
  const injected = mod.reduceChatEvent(start, { type: "harness", subtype: "message_injected", text }, ctx);
  assert.deepEqual(injected.map((b) => b.role), ["ask", "message", "assistant"], "message_injected: card, then the new answer");
  assert.equal(injected[0].ask.answerable, true, "message_injected: the question stays open");
});

// The other views that read history rows ask the same switch (source contract; nothing is drawn here).
test("the web row and the iOS timeline ask the switch, in the history AND in the stream", () => {
  const read = (...parts) => fs.readFileSync(path.join(repo, ...parts), "utf8");
  assert.match(read("web", "src", "components", "chat", "ChatBubbleRow.tsx"), /b\.role === "message" \?/, "ChatBubbleRow draws the card");
  const chat = (d) => read("mobile", "CbaseMobile", "Chat", d);
  assert.match(chat("ChatViewModel+Timeline.swift"), /case "user" where InboundAgentMessage\.isMessage\(entry\.text\):[^]*?role: \.message, message: InboundAgentMessage\.card\(entry\.text\)/);
  // Before the completion notice: a `case "user" where CompletionNotice…` ahead of it would never catch the line, an ordinary "user" ahead of it would.
  const tl = chat("ChatViewModel+Timeline.swift");
  assert.ok(tl.indexOf('case "user" where InboundAgentMessage.isMessage') < tl.indexOf('case "user":'), "the kind stands before the ordinary user case");
  assert.match(chat("ChatViewModel+Stream.swift"), /if let message = InboundAgentMessage\.card\(text\) \{\n\s*\/\/[^\n]*\n\s*timeline\.append\(TimelineItem\(role: \.message, message: message\)\)\n\s*return/);
  assert.match(chat("ChatViewModel+Blocks.swift"), /if !silent, let message = InboundAgentMessage\.card\(text\) \{/);
  assert.match(chat("ChatTimelineRow.swift"), /case \.message:\n\s*if let message = item\.message \{\n\s*AgentMessageCardView\(message: message\)/);
});

test("every header is translated, in the web and on iOS", async () => {
  const web = await loadWeb();
  const entries = (q) => new Set([...q.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"/gm)].map((m) => m[1]));
  const webKey = entries(fs.readFileSync(path.join(webDir, "src", "lib", "i18n-de.ts"), "utf8"));
  const iosKey = entries(["LocDEBase.swift", "LocDEMobile.swift", "LocDECommunication.swift"]
    .map((d) => fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Kit", d), "utf8")).join("\n"));
  const labels = [...new Set([["A", "agent"], ["A", "outer_loop"], ["", "agent"], ["", "outer_loop"]].map(([from, kind]) => web.messageHeader({ from, kind }).label))];
  assert.equal(labels.length, 4);
  assert.deepEqual(labels.filter((l) => !webKey.has(l)), [], "without German version in the web");
  assert.deepEqual(labels.filter((l) => !iosKey.has(l)), [], "without German version on iOS");
});
