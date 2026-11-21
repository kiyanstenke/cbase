// The browser of a chat in the view — without a browser.
//
// Requirement: when the chat changes, the browser of the new chat is loaded too; and for the tab choice in the shared browser: the view
// never jumps to the agent's tab by itself, the tab is marked.
//
// What holds here:
//   (a) the target of a pane is apiBase including the chat; an answer of ensure() for an OLD target does not apply (responseApplies);
//   (b) the tab choice: the browser of a chat never jumps (not even on a new tab of the agent), only a freshly opened view without a
//       choice takes the tab of the working agent; an agent viewer (subagent, workflow) keeps following the agent;
//   (c) bindings that no type error reports: BrowserPane computes the target via ensureTarget, discards a stale answer BEFORE every
//       setState, resets session, tabs, selection and image on a target change (the stream hangs on browserId and ends with it), chooses
//       tabs via tabAfterHello/tabAfterTabs and marks the agent's tab in a chat's browser with "Agent"; the sidebar re-mounts the
//       pane per chat (key with the chat's apiBase).
//
// COUNTER-TESTS (one place each, shown red):
//   lib/browser-stream.ts responseApplies → `return true`                         ⇒ (a) red
//   lib/browser-stream.ts tabAfterTabs without `!a.fest ||` (the old follow code for every browser) ⇒ (b) red "never jumps"
//   lib/browser-stream.ts tabAfterHello without the exception (`!a.fest && a.agentTab`) ⇒ (b) red "freshly opened"
//   BrowserPane.tsx ensure without the responseApplies line                         ⇒ (c) red
//   BrowserPane.tsx target change without `setBrowserId(fixedId || "")`            ⇒ (c) red
//
// Run:  node --test web/test/chat-browser.test.mjs
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
// Without comment lines — a comment that names the call literally would otherwise keep a binding green (chat-bar.test.mjs).
const readCode = (rel) => read(rel).split("\n").filter((z) => !/^\s*(\/\/|\*|\/\*)/.test(z)).join("\n");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-browser-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "browser-stream.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { ensureTarget, responseApplies, tabAfterHello, tabAfterTabs } = await import(pathToFileURL(path.join(out, "browser-stream.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

test("(a) chat switch: the target is apiBase including the chat — an answer for the old target does not apply", () => {
  const a = ensureTarget("/api/chats/c-a", null);
  const b = ensureTarget("/api/chats/c-b", null);
  assert.notEqual(a, b, "two chats, two targets");
  assert.notEqual(ensureTarget("/api/projects/p1", "c-a"), ensureTarget("/api/projects/p1", "c-b"), "same project, two chats (copies): two targets");
  assert.equal(ensureTarget("/api/chats/c-a", undefined), ensureTarget("/api/chats/c-a", null), "missing chat = no chat");
  // The incident: ensure for A is in flight, the sidebar switches to B, the answer for A arrives.
  let now = a;
  const asked = now;
  now = b;
  assert.equal(responseApplies(asked, now), false, "A's session does not land in B's pane");
  assert.equal(responseApplies(b, now), true, "the answer for B applies");
});

test("(b) tab choice in a chat's browser: never jumps to the agent; freshly opened it takes its tab; an agent viewer follows", () => {
  // The human sees t-human; the agent opens t-new (tabs event with agentTab).
  assert.equal(tabAfterTabs({ sel: "t-human", agentTab: "t-new", prior: "", fixed: false }), null, "a new tab of the agent does not change the human's selection (never jumps)");
  assert.equal(tabAfterTabs({ sel: "", agentTab: "t-new", prior: "t-old", fixed: false }), null, "even without a choice the running view does not jump");
  assert.equal(tabAfterHello({ sel: "t-human", tab: "t-active", agentTab: "t-agent", fixed: false }), "t-human", "hello: the human's choice stays");
  assert.equal(tabAfterHello({ sel: "", tab: "t-active", agentTab: "t-agent", fixed: false }), "t-agent", "freshly opened, the agent is working: its tab");
  assert.equal(tabAfterHello({ sel: "", tab: "t-active", agentTab: "", fixed: false }), "t-active", "freshly opened, no agent: the active tab");
  // The viewer of an agent browser (subagent, workflow): no human works there — it follows.
  assert.equal(tabAfterTabs({ sel: "t-old", agentTab: "t-new", prior: "t-old", fixed: true }), "t-new", "agent viewer: follows a new tab");
  assert.equal(tabAfterTabs({ sel: "t-click", agentTab: "t-old", prior: "t-old", fixed: true }), null, "agent viewer: a click holds until the agent switches");
  assert.equal(tabAfterTabs({ sel: "t-new", agentTab: "t-new", prior: "t-old", fixed: true }), null, "already there: nothing to do");
  assert.equal(tabAfterHello({ sel: "", tab: "t-active", agentTab: "t-agent", fixed: true }), "t-active", "agent viewer: hello hangs on the server's active tab (= the agent's)");
});

test("(c) bindings: BrowserPane discards the old answer, resets on a target change, chooses tabs via the rule, marks the agent tab; the sidebar re-mounts per chat", () => {
  const pane = readCode("src/components/BrowserPane.tsx");
  assert.ok(/import \{[^}]*\bensureTarget\b[^}]*\} from "@\/lib\/browser-stream"/.test(pane) && /\bresponseApplies\b/.test(pane), "BrowserPane does not take ensureTarget/responseApplies from @/lib/browser-stream");
  assert.ok(/const target = ensureTarget\(apiBase, chatId\);/.test(pane) && /targetRef\.current = target;/.test(pane), "BrowserPane does not compute its target via ensureTarget(apiBase, chatId) (targetRef)");
  const ensure = pane.slice(pane.indexOf("const ensure = useCallback("), pane.indexOf("}, [apiBase, chatId]);"));
  const asked = ensure.indexOf("const asked = ensureTarget(apiBase, chatId);");
  const check = ensure.indexOf("if (!responseApplies(asked, targetRef.current)) return;");
  const sets = ensure.indexOf("setBrowserId(r.id)");
  assert.ok(asked >= 0 && check > asked && sets > check, "ensure does not check the target BEFORE setBrowserId (an answer for the old chat would land in the new chat's pane)");
  assert.ok(/if \(responseApplies\(asked, targetRef\.current\)\) setError\(/.test(ensure), "an error of the old target lands in the new target's pane");
  const changeover = pane.slice(pane.indexOf("if (targetPrior.current === target) return;"), pane.indexOf("}, [target, fixedId]);"));
  assert.ok(changeover.length > 0, "the target change effect is missing");
  for (const z of ["frameToken.current++", 'setBrowserId(fixedId || "")', "setTabs([])", 'setSelTab("")', "clearRect("]) {
    assert.ok(changeover.includes(z), `the target change does not reset: ${z}`);
  }
  // The stream hangs on browserId: it ends with the session (cleanup closes the EventSource).
  assert.ok(/\}, \[browserId, selTab, active, base, fixedId, ack, ackTimerClean\]\);/.test(pane) && /es\.close\(\);/.test(pane), "the stream effect does not hang on browserId or does not close");
  assert.ok(/tabAfterHello\(\{ sel: selRef\.current, tab: d\.tab \|\| "", agentTab: d\.agentTab \|\| "", fixed: Boolean\(fixedId\) \}\)/.test(pane), "hello does not choose the tab via tabAfterHello");
  assert.ok(/tabAfterTabs\(\{ sel: selRef\.current, agentTab: d\.agentTab \|\| "", prior: agentTabRef\.current, fixed: Boolean\(fixedId\) \}\)/.test(pane), "tabs does not choose the tab via tabAfterTabs");
  assert.ok(!/setSelTab\(d\.agentTab\)/.test(pane), "BrowserPane still jumps to the agent's tab by itself (old follow code)");
  assert.ok(/data-browser-agent-tab="marker"/.test(pane) && /\{t\("Agent"\)\}/.test(pane), "the agent's tab in a chat's browser is not marked \"Agent\"");
  const i18n = read("src/lib/i18n-de.ts");
  for (const word of ["Agent", "The agent is working in this tab"]) assert.ok(i18n.includes(`"${word}":`), `i18n-de.ts does not translate "${word}"`);

  const bar = readCode("src/components/chat/ChatRightSidebar.tsx");
  assert.ok(/<BrowserPane key=\{`own:\$\{scopeApiBase\}:\$\{copy \?\? ""\}`\} apiBase=\{scopeApiBase\}/.test(bar), "the sidebar does not re-mount the pane per browser (the chat's apiBase)");
  assert.ok(/const scopeApiBase = ownBrowserApiBase\(\{ chatId: activeId, \.\.\.scope \}\);/.test(bar), "the sidebar's apiBase is not the chat's");
});
