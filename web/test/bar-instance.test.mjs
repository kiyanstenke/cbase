// The instance choice of the git section of the right chat bar. The sheet web/src/lib/bar-instance.ts is compiled with tsc
// (together with lib/code-instance.ts, which it imports) and EXECUTED.
//
// The promises, each with the way that breaks it:
//   (a) no choice without chat, without move, without a read own instance, on a loading list or with only ONE instance — the
//       target is then exactly the chat (`chat=<id>`, no `instance=`);
//   (b) the options: main, the own copy (ALWAYS, even if not ready — the server keeps binding the chat to it), further READY
//       copies; the own one is marked;
//   (c) a choice different from the own: the target carries EXACTLY the choice — copy `instance=<identifier>`, main without any
//       parameter, never with the chat (else 400 INSTANCE_INVALID, 409 for main already with a locked own copy). Matrix over
//       all situations: never both;
//   (d) a choice equal to the own is chat mode (`normalised`, silent);
//   (e) the chosen copy gone/cleared away/failed => back to the CHAT (not to main), with a hint; only temporarily not ready =>
//       the choice stays; the chat moved in or out (signature) => back, hint "own"; a `start` of the own copy does not. Also: if
//       the remembered own copy has no row any more, the choice drops — for a child chat of a graph run (no row carries its chatId,
//       the signature stays empty) the only way to see the fallback to main;
//   (f) empty is not unknown: on a loading or failed list a made choice stays;
//   (g) a 404 `UNKNOWN_INSTANCE` / 400 `INSTANCE_INVALID` of the CHOSEN instance drops the choice, any other error does not;
//   (h) a click remembers the choice together with own instance and signature; a click on the own one is chat mode;
//   (j) empty is not unknown: a fetch that fails SILENTLY (network, 502/504 while B restarts — no `error`) says nothing about the
//       own instance — no options, and the copy from the last answer stays the own one (never "main · this chat"); the bar reads it
//       from `git.read` (lib/chat-instance.ts afterRetrieval/ownCopySaid, compiled along);
//   (k) the hint of a dropped choice follows every read list (`barHintBySituation`) — "clearAway -> removed" becomes "gone", ready
//       again drops it; the bar applies that on every load and shows states as a word.
//
// Run:  node --test web/test/bar-instance.test.mjs
// Counter-test (which sabotage turns which test red; each ONE place in bar-instance.ts):
//   selectedStatus with `chatId` instead of `chatId: null` (chat and instance at once)       => (c) red
//   deleting the normalisation `if (choice.identifier === ownIdentifier)`                    => (d) red
//   fallback `chatState({ kind: "gone" … })` replaced by `selectedStatus(null, [])`           => (e) red
//   `if (e.situation !== "loaded") return selectedStatus(null, [])` → `return chatState(null)`   => (f) red
//   deleting the check `ownRow && !…some(…)`                                                 => (e) red (child chat)
//   in lib/chat-instance.ts afterRetrieval `read: t.error ? t : prior.read` → `read: t` (a silent failure would count as an
//   answer)                                                                                  => (j) red, and chat-bar (e1) afterRetrieval red
//   `fallbackBySituation` without "row gone => way"                                          => (k) red
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const SOURCE = path.join(webDir, "src", "lib", "bar-instance.ts");
const SOURCE_CHAT = path.join(webDir, "src", "lib", "chat-instance.ts"); // afterRetrieval + ownCopySaid, the origin of the own instance
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

let module = null;
async function load() {
  if (module) return module;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bar-instance-"));
  execFileSync(process.execPath, [tsc, SOURCE, SOURCE_CHAT, "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  module = { ...(await import(pathToFileURL(path.join(tmp, "bar-instance.js")).href)), ...(await import(pathToFileURL(path.join(tmp, "chat-instance.js")).href)) };
  return module;
}

const P = "p1";
const C = "chat-1";
const H = `${P}/main`;
const K = (n) => `${P}/copy-${n}`;
const field = (copies, o = {}) => ({ identifier: H, state: "ready", converted: true, copies, ...o });
const k = (name, state = "ready", chatId = "other") => ({ identifier: K(name), name: `${name}.p1.cbase`, chatId, state });
const base = (o) => ({ projectId: P, field: field([]), situation: "loaded", chatId: C, ownFromServer: null, choice: null, ...o });
const choiceOf = (identifier, own, f) => ({ identifier, projectId: P, own, signature: module.ownSignature(f, C) });

test("(a) no choice: without chat, without move, own unread, list loading, only one instance — the target is exactly the chat", async () => {
  const { barGitChoice } = await load();
  const two = field([k("k1", "ready", C)]);
  for (const [name, e] of [
    ["without chat", base({ field: two, chatId: null, ownFromServer: undefined })],
    ["not converted", base({ field: field([k("k2")], { converted: false }) })],
    ["without field", base({ field: undefined })],
    ["own unread", base({ field: two, ownFromServer: undefined })],
    ["list loading", base({ field: two, situation: "loading", ownFromServer: "k1" })],
    ["list failed", base({ field: two, situation: "error", ownFromServer: "k1" })],
    ["only main", base({ field: field([k("k2", "clearAway"), k("k3", "error")]) })],
    ["copy of another project", base({ field: field([{ identifier: "p2/copy-k1", state: "ready" }]) })],
  ]) {
    const s = barGitChoice(e);
    assert.deepEqual(s.options, [], name);
    assert.equal(s.foreign, false, name);
    assert.equal(s.remember, null, name);
    assert.deepEqual(s.target, { chatId: e.chatId ?? null, instance: null }, name);
  }
});

test("(b) options: main, the own copy (even not ready), further ready copies — the own one marked, none twice", async () => {
  const { barGitChoice } = await load();
  const f = field([k("k1", "ready", C), k("k2"), k("k3", "start"), k("k4", "clearAway"), k("k2")]);
  const s = barGitChoice(base({ field: f, ownFromServer: "k1" }));
  assert.deepEqual(s.options, [
    { identifier: H, kind: "main", name: "", own: false },
    { identifier: K("k1"), kind: "copy", name: "k1", own: true },
    { identifier: K("k2"), kind: "copy", name: "k2", own: false },
  ]);
  assert.deepEqual([s.shown, s.shownName, s.foreign, s.target], [K("k1"), "k1", false, { chatId: C, instance: null }]);
  // The own copy is being cleared away right now (the server keeps binding the chat to it) — it stays the own option.
  const way = barGitChoice(base({ field: field([k("k1", "clearAway", C), k("k2")]), ownFromServer: "k1" }));
  assert.deepEqual(way.options.map((o) => [o.identifier, o.own]), [[H, false], [K("k1"), true], [K("k2"), false]]);
  // A child chat the list does not know: the own copy comes from the server, not from the list.
  const kind = barGitChoice(base({ field: field([k("k2")]), ownFromServer: "k9" }));
  assert.deepEqual(kind.options.map((o) => o.identifier), [H, K("k9"), K("k2")]);
  // A main chat with a ready copy of another chat.
  const main = barGitChoice(base({ field: field([k("k2")]), ownFromServer: null }));
  assert.deepEqual(main.options.map((o) => [o.identifier, o.own]), [[H, true], [K("k2"), false]]);
  assert.deepEqual([main.shown, main.shownName], [H, null]);
});

test("(c) a choice different from the own: exactly the choice in the target — copy as instance=, main without parameter, never chat AND instance", async () => {
  const { barGitChoice } = await load();
  const f = field([k("k1", "ready", C), k("k2")]);
  const main = barGitChoice(base({ field: f, ownFromServer: undefined, choice: choiceOf(H, "k1", f) }));
  assert.deepEqual(main.target, { chatId: null, instance: null }, "main: without chat, without parameter");
  assert.deepEqual([main.shown, main.shownName, main.foreign, main.hint], [H, null, true, null]);
  assert.equal(main.options.find((o) => o.own)?.identifier, K("k1"), "the own instance comes from the choice, not from the (unread) tree");
  const k2 = barGitChoice(base({ field: f, ownFromServer: undefined, choice: choiceOf(K("k2"), "k1", f) }));
  assert.deepEqual(k2.target, { chatId: null, instance: K("k2") });
  assert.deepEqual([k2.shown, k2.shownName, k2.foreign], [K("k2"), "k2", true]);
  const ofMain = barGitChoice(base({ field: f, choice: choiceOf(K("k1"), null, f) }));
  assert.deepEqual(ofMain.target, { chatId: null, instance: K("k1") }, "a main chat chooses a copy");

  // Matrix: over all situations, states, choices and own instances never both.
  let n = 0;
  for (const situation of ["loaded", "loading", "error"]) for (const z of ["ready", "start", "clearAway", "error"]) for (const own of [null, "k1", "k9", undefined]) {
    const ff = field([k("k1", z, C), k("k2", z)]);
    for (const g of [null, H, K("k1"), K("k2"), K("k5"), "p2/copy-k1"]) {
      const choice = g === null ? null : { identifier: g, projectId: g.startsWith("p2") ? "p2" : P, own: own === undefined ? null : own, signature: module.ownSignature(ff, C) };
      const s = barGitChoice(base({ field: ff, situation, ownFromServer: own, choice }));
      assert.ok(!(s.target.chatId && s.target.instance), `chat and instance at once: ${JSON.stringify([situation, z, own, g, s.target])}`);
      assert.ok(s.target.chatId === C || s.target.chatId === null);
      if (s.target.chatId === null) assert.ok(s.remember && s.foreign, "without chat only with a valid, foreign choice");
      n++;
    }
  }
  assert.ok(n > 200);
});

test("(d) a choice equal to the own instance is chat mode — silent, without hint", async () => {
  const { barGitChoice } = await load();
  const f = field([k("k1", "ready", C), k("k2")]);
  const s = barGitChoice(base({ field: f, choice: choiceOf(K("k1"), "k1", f) }));
  assert.deepEqual([s.target, s.remember, s.hint, s.foreign], [{ chatId: C, instance: null }, null, null, false]);
  const h = barGitChoice(base({ field: field([k("k2")]), choice: choiceOf(H, null, field([k("k2")])) }));
  assert.deepEqual([h.target, h.remember, h.hint], [{ chatId: C, instance: null }, null, null]);
});

test("(e) fallback to the CHAT: copy gone, cleared away, failed; move in/out — not when temporarily not ready or `start`", async () => {
  const { barGitChoice } = await load();
  const prior = field([k("k1", "ready", C), k("k2")]);
  const choice = choiceOf(K("k2"), "k1", prior);
  const gone = barGitChoice(base({ field: field([k("k1", "ready", C)]), ownFromServer: undefined, choice }));
  assert.deepEqual([gone.target, gone.remember, gone.hint], [{ chatId: C, instance: null }, null, { kind: "gone", name: "k2" }], "gone => the chat, not main");
  for (const z of ["clearAway", "error", "relocation"]) {
    const s = barGitChoice(base({ field: field([k("k1", "ready", C), k("k2", z)]), ownFromServer: undefined, choice }));
    assert.deepEqual([s.target, s.remember, s.hint], [{ chatId: C, instance: null }, null, { kind: "not-ready", name: "k2", state: z }], z);
  }
  for (const z of ["create", "start", "recreate"]) {
    const s = barGitChoice(base({ field: field([k("k1", "ready", C), k("k2", z)]), ownFromServer: undefined, choice }));
    assert.deepEqual([s.target, s.remember, s.hint], [{ chatId: null, instance: K("k2") }, choice, { kind: "transient", name: "k2", state: z }], z);
    assert.ok(s.options.some((o) => o.identifier === K("k2")), `${z}: the chosen one stays in the menu`);
  }
  // The own copy restarts (after every restart of B) — no move out.
  const start = barGitChoice(base({ field: field([k("k1", "start", C), k("k2")]), ownFromServer: undefined, choice }));
  assert.deepEqual([start.target, start.remember], [{ chatId: null, instance: K("k2") }, choice]);
  // Move out: the own row is gone. Move in: a new row of this chat.
  for (const [name, f] of [["move out", field([k("k2")])], ["move in", field([k("k1", "ready", C), k("k2"), k("k3", "create", C)])]]) {
    const s = barGitChoice(base({ field: f, ownFromServer: undefined, choice }));
    assert.deepEqual([s.target, s.remember, s.hint], [{ chatId: C, instance: null }, null, { kind: "own" }], name);
  }
  // Child chat of a graph run: it works in copy k1 of its parent chat — no row carries ITS chatId,
  // the signature is empty and stays so. As long as k1 has a row the choice holds; if k1 drops (move out), it drops too.
  const parent = field([k("k1", "ready", "parent"), k("k2")]);
  const kindChoice = choiceOf(K("k2"), "k1", parent);
  assert.equal(kindChoice.signature, "", "a child chat has no signature");
  const holds = barGitChoice(base({ field: parent, ownFromServer: undefined, choice: kindChoice }));
  assert.deepEqual([holds.target, holds.remember], [{ chatId: null, instance: K("k2") }, kindChoice], "the parent chat's copy lives: the choice holds");
  for (const [name, f] of [["k1 gone", field([k("k2")])], ["k1 gone, nothing left", field([])], ["without copies field", field(undefined)]]) {
    const s = barGitChoice(base({ field: f, ownFromServer: undefined, choice: kindChoice }));
    assert.deepEqual([s.target, s.remember, s.hint], [{ chatId: C, instance: null }, null, { kind: "own" }], `child: ${name}`);
  }
  // The same for a choice of main by a child chat.
  const kindMain = barGitChoice(base({ field: field([k("k2")]), ownFromServer: undefined, choice: choiceOf(H, "k1", parent) }));
  assert.deepEqual([kindMain.target, kindMain.remember, kindMain.hint], [{ chatId: C, instance: null }, null, { kind: "own" }]);
  // A main chat (own null) needs no row.
  const mainChat = barGitChoice(base({ field: field([k("k2")]), ownFromServer: undefined, choice: choiceOf(K("k2"), null, field([k("k2")])) }));
  assert.deepEqual(mainChat.target, { chatId: null, instance: K("k2") });
  // A choice of another project does not apply (silent).
  const foreign = barGitChoice(base({ field: prior, ownFromServer: "k1", choice: { ...choice, projectId: "p2" } }));
  assert.deepEqual([foreign.target, foreign.hint, foreign.foreign], [{ chatId: C, instance: null }, null, false]);
});

test("(f) empty is not unknown: on a loading or failed list the choice stays", async () => {
  const { barGitChoice } = await load();
  const f = field([k("k1", "ready", C), k("k2")]);
  const choice = choiceOf(K("k2"), "k1", f);
  for (const situation of ["loading", "error"]) {
    const s = barGitChoice(base({ field: undefined, situation, ownFromServer: undefined, choice }));
    assert.deepEqual([s.target, s.remember, s.foreign, s.shown, s.options], [{ chatId: null, instance: K("k2") }, choice, true, K("k2"), []], situation);
  }
});

test("(g) afterErrorBar: 404 UNKNOWN_INSTANCE / 400 INSTANCE_INVALID of the CHOSEN instance drops the choice — nothing else", async () => {
  const { afterErrorBar } = await load();
  const choice = { identifier: K("k2"), projectId: P, own: "k1", signature: "" };
  assert.deepEqual(afterErrorBar(choice, { code: "UNKNOWN_INSTANCE", identifier: K("k2") }), { kind: "gone", name: "k2" });
  assert.deepEqual(afterErrorBar(choice, { code: "INSTANCE_INVALID" }), { kind: "gone", name: "k2" });
  assert.deepEqual(afterErrorBar(choice, Object.assign(new Error("x"), { code: "UNKNOWN_INSTANCE", identifier: K("k2"), error: "x" })), { kind: "gone", name: "k2" });
  for (const [name, w, e] of [
    ["without choice", null, { code: "UNKNOWN_INSTANCE" }],
    ["other identifier", choice, { code: "UNKNOWN_INSTANCE", identifier: K("k3") }],
    ["409 frozen", choice, { error: "frozen" }],
    ["Network", choice, new Error("Failed to fetch")],
    ["null", choice, null],
  ]) assert.equal(afterErrorBar(w, e), null, name);
});

test("(h) selectInBar: remembers choice, own instance and signature — the own or an unknown one is chat mode", async () => {
  const { barGitChoice, selectInBar, ownSignature } = await load();
  const f = field([k("k1", "ready", C), k("k2"), k("k3", "create", C)]);
  const s = barGitChoice(base({ field: f, ownFromServer: "k1" }));
  assert.equal(ownSignature(f, C), `${K("k1")}|${K("k3")}`);
  assert.deepEqual(selectInBar(s, H, { projectId: P, field: f, chatId: C }), { identifier: H, projectId: P, own: "k1", signature: `${K("k1")}|${K("k3")}` });
  assert.deepEqual(selectInBar(s, K("k2"), { projectId: P, field: f, chatId: C })?.identifier, K("k2"));
  assert.equal(selectInBar(s, K("k1"), { projectId: P, field: f, chatId: C }), null, "the own");
  assert.equal(selectInBar(s, K("k7"), { projectId: P, field: f, chatId: C }), null, "unknown");
  const h = barGitChoice(base({ field: field([k("k2")]), ownFromServer: null }));
  assert.equal(selectInBar(h, K("k2"), { projectId: P, field: field([k("k2")]), chatId: C })?.own, null, "a main chat remembers main as the own");
  // Round trip: the remembered choice yields the target, and a click back on the own yields the chat.
  const w = selectInBar(s, K("k2"), { projectId: P, field: f, chatId: C });
  const afterwards = barGitChoice(base({ field: f, ownFromServer: undefined, choice: w }));
  assert.deepEqual(afterwards.target, { chatId: null, instance: K("k2") });
  assert.equal(selectInBar(afterwards, K("k1"), { projectId: P, field: f, chatId: C }), null);
});

test("(j) empty is not unknown: a silently failed retrieval yields no options and never turns the own copy into main", async () => {
  // The bar's path: state => afterRetrieval => `read` => ownCopySaid => barGitChoice({ ownFromServer }) — EXECUTED here.
  // Counter-test: see the header (lib/chat-instance.ts afterRetrieval `read: t`).
  const { barGitChoice, afterRetrieval, ownCopySaid, selectInBar } = await load();
  const f = field([k("k1", "ready", C), k("k2")]);
  const options = (snapshot) => barGitChoice(base({ field: f, ownFromServer: ownCopySaid(snapshot.read) })).options.map((o) => [o.identifier, o.own]);
  const empty = { tree: null, print: "", read: null };
  // The first fetch fails silently (B restarts): no choice — neither "main · this chat" nor a foreign k1.
  const still = afterRetrieval(empty, { kind: "error", error: Object.assign(new Error("Gateway Timeout"), { status: 504 }) });
  assert.deepEqual(still.tree, { repos: [] }, "the panel shows the empty tree as before");
  assert.deepEqual(options(still), [], "an error tree without `error` yields NO options");
  // The answer names k1.
  const present = afterRetrieval(still, { kind: "response", tree: { repos: [], instance: "copy-k1" } });
  assert.deepEqual(options(present), [[H, false], [K("k1"), true], [K("k2"), false]]);
  // Then a tick fails silently: the own one stays k1.
  const after502 = afterRetrieval(present, { kind: "error", error: new Error("Failed to fetch") });
  assert.deepEqual(after502.tree, { repos: [] });
  assert.deepEqual(options(after502), [[H, false], [K("k1"), true], [K("k2"), false]], "after 502");
  // And a choice made in this state remembers k1 as the own — never main.
  const s = barGitChoice(base({ field: f, ownFromServer: ownCopySaid(after502.read) }));
  assert.equal(selectInBar(s, H, { projectId: P, field: f, chatId: C })?.own, "k1");
});

test("(i) Binding: the bar goes through the computation — git state and panel read the same target, the browser stays with the chat", () => {
  const raw = fs.readFileSync(path.join(webDir, "src", "components", "chat", "ChatRightSidebar.tsx"), "utf8");
  const bar = raw.split("\n").filter((z) => !/^\s*\/\//.test(z)).join("\n");
  assert.ok(/const raw = barGitChoice\(/.test(bar) && /const target = raw\.target;/.test(bar), "ChatRightSidebar.tsx: the target does not come from barGitChoice");
  assert.ok(/useGitState\(gitApiBase, target\.chatId, target\.instance\)/.test(bar), "the bar's git state does not read the choice's target");
  const startAt = bar.search(/<GitSidebar\s+key=/);
  const el = bar.slice(startAt, bar.indexOf("/>", startAt));
  assert.ok(/chatId=\{target\.chatId\}/.test(el) && /instance=\{target\.instance\}/.test(el), "<GitSidebar> does not get the choice's target");
  assert.ok(/key=\{`chat-git:[^`]*target\.instance[^`]*`\}/.test(el), "<GitSidebar> is not rebuilt when the instance changes (key without the choice)");
  assert.ok(/onError=\{onGitError\}/.test(el), "<GitSidebar> does not report an action's error to the choice");
  assert.ok(/const browserCopy = focusProjectId \? ownCopy : null;/.test(bar), "the own browser is not tied to the chat's own instance (ownCopy) — it would move with the choice");
  assert.ok(/const ownCopy = inChatMode \? copy : \(rememberedChoice\?\.own \?\? null\);/.test(bar), "ownCopy does not follow the server's truth or the remembered own instance");
  for (const marker of ["data-bar-instance-choice", "data-bar-instance-foreign", "data-bar-instance-entry", "data-bar-instance-hint", "data-bar-instance"]) {
    assert.ok(bar.includes(`"${marker}"`) || bar.includes(`${marker}=`), `marker ${marker} missing`);
  }
  assert.ok(!/localStorage[^;\n]*instance/i.test(bar), "the choice belongs in the module map, not in localStorage (a forgotten choice across the reload)");
  // The own instance only from an ANSWER ((j)), the list reloads on `project/copy` too ((e)), and the form: the choice button
  // names its state (aria-label/title), shrinks instead of taking the title's room, the entries are a choice with a check mark,
  // and a foreign choice also shows on the rail (name, badge).
  assert.ok(/const copySaid = inChatMode \? ownCopySaid\(git\.read\) : undefined;/.test(bar), "the bar does not read the own copy from git.read");
  assert.ok(/inChatMode && copySaid !== undefined \? barGitChoice\(\{ \.\.\.choiceInput, ownFromServer: copySaid \}\)/.test(bar), "the choice gets an own instance without the server's answer (a silent failure would mean \"main\")");
  assert.ok(/git\.read !== null/.test(bar) && !/git\.loaded/.test(bar), "the own browser starts before an answer (git.loaded instead of git.read) — a silent failure would give a copy chat the main's browser");
  assert.ok(/evt\.type === "project\/instance" \|\| evt\.type === "project\/copy"/.test(bar), "the instance list does not reload on `project/copy` — after a move out the old own copy would stay remembered");
  const headerStart = bar.indexOf("const instanceHeader =");
  const menu = bar.slice(headerStart, bar.indexOf("</Menu>", headerStart));
  assert.ok(/label=\{t\("Choose instance: \{instance\}", \{ instance: instanceText \}\)\}/.test(menu), "the choice button is only called \"Choose instance\" — screen readers and hover do not learn which instance is shown");
  assert.ok(/\bshrinks\b/.test(menu) && /<span className="shrink-0">· \{t\("this chat"\)\}<\/span>/.test(menu), "the button cuts \"· this chat\" away with the name (own shrink-0 span, shrinking shell)");
  assert.ok(/selected=\{o\.identifier === gitChoice\.shown\}/.test(menu), "the shown instance is not marked as chosen in the menu (check mark, menuitemradio)");
  assert.ok(/<Header title=\{gitTitle\} titleFull>/.test(bar), "the git section's title shrinks to \"GI…\" against the choice");
  assert.ok(/gitlab: \{\s*label: gitChoice\.foreign \?/.test(bar) && /foreign: gitChoice\.foreign,/.test(bar), "the rail does not say whose changes the badge counts on a foreign choice");
  const kit = fs.readFileSync(path.join(webDir, "src", "components", "CbKit.tsx"), "utf8");
  assert.ok(/role=\{choice \? "menuitemradio" : "menuitem"\}/.test(kit) && /"aria-checked": Boolean\(selected\)/.test(kit), "MenuEntry: `selected` does not set role=menuitemradio and aria-checked");
  assert.ok(/\[role="menuitemradio"\]\[aria-checked="true"\]/.test(kit), "Menu: the focus does not find a menuitemradio (it would stand nowhere on opening)");
  const git = fs.readFileSync(path.join(webDir, "src", "components", "GitSidebar.tsx"), "utf8");
  assert.ok(/onError\?\.\(e\);\s*throw e;/.test(git), "GitSidebar: `act` does not pass an error to onError");
  const ci = fs.readFileSync(path.join(webDir, "src", "lib", "chat-instance.ts"), "utf8");
  assert.ok(/UNKNOWN_INSTANCE/.test(ci), "gitErrorTree discards `code` — the 404 of the chosen copy would stand until the next event");
});

test("(k) the hint of a dropped choice follows the read list — clearAway → removed becomes \"way\"", async () => {
  const { barGitChoice, barHintBySituation } = await load();
  // The choice on k2 drops while k2 is being cleared away: "not ready (clearAway)" — and is forgotten.
  const prior = field([k("k1", "ready", C), k("k2")]);
  const s = barGitChoice(base({ field: field([k("k1", "ready", C), k("k2", "clearAway")]), ownFromServer: "k1", choice: choiceOf(K("k2"), "k1", prior) }));
  assert.deepEqual([s.hint, s.remember, s.target], [{ kind: "not-ready", name: "k2", state: "clearAway" }, null, { chatId: C, instance: null }]);
  const h = s.hint;
  // After that the choice computes nothing about k2 any more — the retained hint follows the list.
  assert.deepEqual(barHintBySituation(h, field([k("k1", "ready", C)]), "loaded"), { kind: "gone", name: "k2" }, "clearAway → removed");
  assert.deepEqual(barHintBySituation(h, field([k("k1", "ready", C), k("k2", "error")]), "loaded"), { kind: "not-ready", name: "k2", state: "error" });
  assert.equal(barHintBySituation(h, field([k("k1", "ready", C), k("k2")]), "loaded"), null, "ready again: superseded");
  assert.equal(barHintBySituation(h, field([k("k1", "ready", C), k("k2", "clearAway")]), "loaded"), h, "unchanged: the same object");
  for (const situation of ["loading", "error"]) assert.equal(barHintBySituation(h, field([]), situation), h, situation);
  for (const stays of [{ kind: "own" }, { kind: "gone", name: "k2" }, { kind: "gone", name: "" }, { kind: "transient", name: "k2", state: "start" }]) {
    assert.equal(barHintBySituation(stays, field([]), "loaded"), stays, JSON.stringify(stays));
  }
  assert.equal(barHintBySituation(null, field([]), "loaded"), null);
  // The bar (by path): tracks the hint on every load of the list — only for the project whose copy it names — and shows
  // the state as a word, never the identifier "clearAway".
  const raw = fs.readFileSync(path.join(webDir, "src", "components", "chat", "ChatRightSidebar.tsx"), "utf8");
  const bar = raw.split("\n").filter((z) => !/^\s*\/\//.test(z)).join("\n");
  assert.ok(/if \(!g \|\| g\.pid !== instanceList\.pid\) return g;\s*const h = barHintBySituation\(g\.hint, instanceList\.field, "loaded"\);/.test(bar), "the bar does not track the hint on the list");
  assert.ok(/\}, \[instanceList\]\);/.test(bar), "the tracking is not tied to every load of the list");
  assert.ok(!/state: h\.state \|\| "\?"/.test(bar) && /stateWord\(h\.state, t\)/.test(bar), "the bar shows the raw state identifier");
});

test("(l) an instance change without a copy row (PATCH {instance}, cbase_switch_instance) drops the choice", async () => {
  // Chat C works in main, the foreign copy k2 is chosen. Then the head switches C to k2: `chats.instance` changes, no copy
  // row (`copies[].chatId` only means "created by"). Otherwise the choice would stay — the menu would list "main · this
  // chat", and a tap on it would go to chat mode, which the server resolves to k2. Counter-test: a signature without the
  // binding, or `const b = bindingOf(binding)` → `const b = null` in bar-instance.ts, turns it red.
  const { barGitChoice, selectInBar, ownSignature } = await load();
  const f = field([k("k2")]);
  const prior = barGitChoice(base({ field: f, ownFromServer: null, binding: null }));
  const choice = selectInBar(prior, K("k2"), { projectId: P, field: f, chatId: C, binding: null });
  assert.deepEqual(choice, { identifier: K("k2"), projectId: P, own: null, signature: "" });
  // Same binding: the choice holds.
  assert.deepEqual(barGitChoice(base({ field: f, ownFromServer: undefined, binding: null, choice })).remember, choice);
  assert.deepEqual(barGitChoice(base({ field: f, ownFromServer: undefined, binding: "main", choice })).remember, choice, "\"main\" is no binding");
  // Switched to k2: the choice drops, back to the chat, hint "own" — on the same list.
  const afterwards = barGitChoice(base({ field: f, ownFromServer: undefined, binding: "copy-k2", choice }));
  assert.deepEqual([afterwards.remember, afterwards.hint, afterwards.foreign, afterwards.target], [null, { kind: "own" }, false, { chatId: C, instance: null }]);
  // A choice made in the copy remembers the binding and drops back to main on the switch.
  const inCopy = barGitChoice(base({ field: f, ownFromServer: "k2", binding: "copy-k2" }));
  const w2 = selectInBar(inCopy, H, { projectId: P, field: f, chatId: C, binding: "copy-k2" });
  assert.equal(w2?.signature, ownSignature(f, C, "copy-k2"));
  assert.equal(w2?.signature, "#copy-k2");
  assert.deepEqual(barGitChoice(base({ field: f, ownFromServer: undefined, binding: "copy-k2", choice: w2 })).remember, w2);
  assert.deepEqual(barGitChoice(base({ field: f, ownFromServer: undefined, binding: null, choice: w2 })).hint, { kind: "own" });
  // The bar (by path) takes in the open chat's binding — for choice AND tap; ChatPane passes `activeChat.instance` through.
  const raw = fs.readFileSync(path.join(webDir, "src", "components", "chat", "ChatRightSidebar.tsx"), "utf8");
  assert.match(raw, /const choiceInput = \{[^}]*binding: chatInstance,/, "the bar's choice without binding");
  assert.match(raw, /selectInBar\(gitChoice, o\.identifier, \{[^}]*binding: chatInstance \}\)/, "the tap remembers the signature without binding");
  const pane = fs.readFileSync(path.join(webDir, "src", "components", "chat", "ChatPane.tsx"), "utf8");
  assert.match(pane, /const chatInstance = activeChat\?\.instance \?\? null;/, "ChatPane does not read the binding from the open chat");
  assert.match(pane, /<ChatRightSidebar[^>]*chatInstance=\{chatInstance\}/, "ChatPane does not pass the binding through");
});
