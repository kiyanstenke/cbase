// The choice in the browser section of the right chat bar (src/lib/browser-choice.ts) — without a browser.
//
// The finding, measured with a real server and real @playwright/mcp: the bar remembered the `id` of the chosen agent browser — and
// that is the id of a Chromium SESSION. The agent starts a new Chromium in the same profile per run (turn, workflow step); the
// old id vanished, `agents.find((b) => b.id === choice)` found nothing, and the bar SILENTLY showed the own browser
// (about:blank) while the agent kept browsing next door. Also every entry carried a sentence below it ("1 tab · watch and
// intervene", "The browser of this project or workspace — the same as in the browser tab"), and a subagent's browser was named
// like its profile folder.
//
// What is checked is the computation that the bar only CALLS:
//   (a) the choice is the profile and survives the restart of the agent browser (new id, same profile);
//   (b) a profile without a session is "closed" — not the own browser; an unloaded list is "unknown" — neither "closed" nor "no
//       agent browsers" (empty is not unknown);
//   (c) which browsers belong to the chat (main agent, subagents, workflow agents; not that of another chat, not even one whose id
//       starts with this one), ONE per profile (the newer session), the main agent first;
//   (d) short names: "main agent", the subagent's job, the workflow agent's label — never the folder name;
//   (e) "controls right now" at its edges, and the timer for its expiry;
//   (f) bindings across file borders that no type error reports: the bar calls the computation, the sentences are gone (also from
//       the translation table), "no agent browser" appears only with a loaded list, BrowserPane follows the agent's tab, and the
//       profile scheme is the same as in the backend (runs/agents.js, browser-profiles.js);
//   (g) the extra window: an agent browser goes out as PROFILE (the window hung on the session id and showed "gone" after the next
//       run), the own one as scope — and for the native own browser not at all (a child window gets no preload, measured on
//       Electron 44.4.4: it showed the server's stream, a different browser); the page /browser reads the same addresses, bar
//       and pill open through the same call, and the Electron shells allow the window;
//       the chat of a COPY: the extra window of the own browser carries `&chat=` (only a `proj:` scope; the workspace has no
//       instance), the page /browser reads it back, and the bar passes its chat along — otherwise the window of a copy chat
//       would show main's browser;
//   (h) the browser of a chat: the bar of a chat shows ITS browser (`/api/chats/<id>`, server devtools/user-browser.js), in which
//       its main agent works too, always as the server's stream; the extra window carries the scope `chat:<id>`; "controls right
//       now" reads `agentChat`. The switch "agent uses my browser" is gone — route, field, words.
//
// Counter-test (which sabotage turns which test red):
//   the old BrowserSection (choice by session id, hint sentences) turns (f) red "BrowserSection does not call resolveChoice(";
//   keeping the OLDER session per profile turns (a) and (c) red; ignoring `loaded` turns (b) red "an empty, unloaded list is not
//   \"closed\"";
//   the pill with window.open and `?id=` turns it red "the pill does not open the window through openBrowserWindow with the
//   profile"; `windowUrl` with the session id instead of the profile turns it red "an agent browser goes out as profile"; the
//   page /browser with only `?id=` turns it red "the page /browser does not read the address through windowTarget/resolveProfile";
//   web/src/lib/browser-choice.ts: windowUrl without chat (`withChat = ""`) or windowTarget not reading the chat (`chat = ""`)
//   turns (g) red; ChatRightSidebar.tsx `windowUrl(…, copy ? false : native)` without `activeId` turns (g) red;
//   ownBrowserApiBase without the chat branch turns (h) red "in a chat the chat's browser"; apiBaseFromScope without `chat` turns
//   (h) red "chat:<id> is a scope"; agentControlsOwn without `b.kind === "user"` turns (h) red "an agent browser is not the own".
//
// Run:  node --test web/test/browser-choice.test.mjs
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
const read = (rel) => fs.readFileSync(path.resolve(repo, rel), "utf8");

// Compiled with the local tsc (pulls lib/chat-bar.ts along) — the real module text is tested (model: chat-bar).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-browser-choice-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "browser-choice.ts"), path.join(webDir, "src", "lib", "browser-native.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const {
  CHOICE_OWN, choiceForProfile, profileOfTheChoice, ACTIVE_MS, profileOf, controlsCurrently, nextExpiry,
  agentBrowserOfTheChat, agentNames, browserName, choiceEntries, resolveChoice,
  WINDOW_DIMENSIONS, openBrowserWindow, apiBaseFromScope, windowUrl, windowForSession, windowTarget, resolveProfile,
  ownBrowserApiBase, agentControlsOwn,
} = await import(pathToFileURL(path.join(out, "browser-choice.js")).href);
const { scopeFromApiBase } = await import(pathToFileURL(path.join(out, "browser-native.js")).href);

const CHAT = "4f1c2a7e-0000-4000-8000-000000000001";
const OTHER = "4f1c2a7e-0000-4000-8000-000000000002";
const TEXTS = { main: "Main agent", sub: "Subagent" };
// A browser as GET /api/browsers delivers it (browsers.js, summarize).
const agentB = (profile, id, extra = {}) => {
  const rest = profile.slice("chat-".length);
  const i = rest.indexOf("-agent-");
  return {
    id, kind: "agent", label: extra.label ?? "Explore projects", workspaceId: "ws1", scopeKey: `agent:${profile}:${extra.port ?? 40000}`,
    tabs: extra.tabs ?? 1, profile, chatId: i < 0 ? rest : rest.slice(0, i), agentId: i < 0 ? "" : rest.slice(i + 7),
    activeAt: extra.activeAt ?? 0, agentTab: extra.agentTab ?? "",
  };
};
const ownB = { id: "u1", kind: "user", label: "cbase", workspaceId: "ws1", scopeKey: "ws:ws1", tabs: 2 };
const MAIN = `chat-${CHAT}`;
const SUB = `chat-${CHAT}-agent-a7`;
const WF = `chat-${CHAT}-agent-wf3`;

test("(a) the choice is the profile: after the agent browser's restart (new session, new id) it shows the new session", () => {
  const choice = choiceForProfile(MAIN);
  assert.equal(profileOfTheChoice(choice), MAIN);
  assert.equal(profileOfTheChoice(CHOICE_OWN), "");
  const prior = resolveChoice(choice, [ownB, agentB(MAIN, "s1")], CHAT, true);
  assert.equal(prior.kind, "agent");
  assert.equal(prior.browser.id, "s1");
  // The next run: the old Chromium is gone, a new one in the same profile under a new port and a new id.
  const after = resolveChoice(choice, [ownB, agentB(MAIN, "s2", { port: 40001 })], CHAT, true);
  assert.equal(after.kind, "agent", `after the agent browser's restart the choice does not drop — measured "${after.kind}"`);
  assert.equal(after.browser.id, "s2", "the view hangs on the NEW session");
  // Both sessions at once (the old one dies, the new one is already discovered): the newer.
  const both = resolveChoice(choice, [agentB(MAIN, "s1"), agentB(MAIN, "s2", { port: 40001 })], CHAT, true);
  assert.equal(both.browser.id, "s2");
});

test("(b) without a session \"closed\", not the own browser; unloaded \"unknown\" — and \"own\" stays own", () => {
  const choice = choiceForProfile(SUB);
  assert.deepEqual(resolveChoice(choice, [ownB, agentB(MAIN, "s1")], CHAT, true), { kind: "closed", profile: SUB });
  assert.deepEqual(resolveChoice(choice, [], CHAT, false), { kind: "unknown", profile: SUB }, "an empty, unloaded list is not \"closed\"");
  assert.deepEqual(resolveChoice(choice, [agentB(SUB, "s9")], CHAT, false), { kind: "unknown", profile: SUB }, "unloaded means unloaded, even if something is in it already");
  assert.deepEqual(resolveChoice(CHOICE_OWN, [], CHAT, false), { kind: "own" });
  assert.deepEqual(resolveChoice(CHOICE_OWN, [agentB(MAIN, "s1")], CHAT, true), { kind: "own" });
  // A profile of ANOTHER chat is never selectable here — not even through an old choice.
  assert.equal(resolveChoice(choiceForProfile(`chat-${OTHER}`), [agentB(`chat-${OTHER}`, "x")], CHAT, true).kind, "closed");
});

test("(c) main agent, subagents and workflow agents belong to the chat — one per profile, the main agent first", () => {
  const prefixChat = `${CHAT}9`; // starts with this chat's id, but is another one
  const list = [
    ownB,
    agentB(SUB, "s-sub"),
    agentB(`chat-${OTHER}`, "s-foreign"),
    agentB(`chat-${prefixChat}`, "s-prefix"),
    agentB(MAIN, "s-main-old"),
    agentB(WF, "s-wf"),
    agentB(MAIN, "s-main-new", { port: 40002 }),
    { ...agentB(`chat-${CHAT}-agent-alt`, "s-without-profile"), profile: undefined, chatId: undefined, agentId: undefined }, // older server
  ];
  const ids = agentBrowserOfTheChat(list, CHAT).map((b) => b.id);
  assert.deepEqual(ids, ["s-main-new", "s-sub", "s-wf", "s-without-profile"]);
  assert.deepEqual(agentBrowserOfTheChat(list, ""), [], "without a chat none");
  assert.equal(profileOf(list[7]), `chat-${CHAT}-agent-alt`, "without `profile` from the scopeKey");
  assert.equal(profileOf(ownB), "", "the own browser has no profile");
});

test("(d) short names: main agent, job, workflow label — never the folder name", () => {
  const names = agentNames(
    [{ agentId: "a7", job: "  Check login " }, { agentId: "empty", job: "   " }],
    [{ name: "Research", agents: [{ agentId: "wf3", label: "", n: 2 }, { agentId: "wf4", label: "Read sources", n: 3 }, { agentId: "", label: "without id", n: 4 }] }],
  );
  assert.deepEqual([...names.entries()].sort(), [["a7", "Check login"], ["wf3", "Research #2"], ["wf4", "Read sources"]].sort());
  assert.equal(browserName(agentB(MAIN, "h"), CHAT, names, TEXTS), "Main agent", "the main agent is not named like the chat — the bar is in it already");
  assert.equal(browserName(agentB(SUB, "s"), CHAT, names, TEXTS), "Check login");
  assert.equal(browserName(agentB(WF, "w"), CHAT, names, TEXTS), "Research #2");
  const unknown = `chat-${CHAT}-agent-zz`;
  assert.equal(browserName(agentB(unknown, "z", { label: "Run tests" }), CHAT, names, TEXTS), "Run tests", "otherwise the name from the server");
  assert.equal(browserName(agentB(unknown, "z", { label: unknown }), CHAT, names, TEXTS), "Subagent", "the folder name is no name");

  const now = 1_000_000;
  const entries = choiceEntries([ownB, agentB(SUB, "s", { tabs: 3, activeAt: now - 5 }), agentB(MAIN, "h", { tabs: 1 })], CHAT, names, TEXTS, now);
  assert.deepEqual(entries, [
    { choice: choiceForProfile(MAIN), name: "Main agent", tabs: 1, active: false, browserId: "h" },
    { choice: choiceForProfile(SUB), name: "Check login", tabs: 3, active: true, browserId: "s" },
  ]);
});

test("(e) \"controls right now\" at its edges, and when the mark expires", () => {
  const now = 5_000_000;
  assert.equal(controlsCurrently({ activeAt: 0 }, now), false, "never active");
  assert.equal(controlsCurrently({}, now), false, "an older server sends no activeAt");
  assert.equal(controlsCurrently({ activeAt: now }, now), true);
  assert.equal(controlsCurrently({ activeAt: now - ACTIVE_MS + 1 }, now), true);
  assert.equal(controlsCurrently({ activeAt: now - ACTIVE_MS }, now), false, "exactly after ACTIVE_MS it is over");
  assert.equal(controlsCurrently({ activeAt: now + 10 }, now), false, "a stamp from the future (server clock ahead) does not count");
  assert.equal(nextExpiry([{ activeAt: 0 }, { activeAt: now - ACTIVE_MS }], now), null, "none active ⇒ no timer");
  assert.equal(nextExpiry([{ activeAt: now - 100 }, { activeAt: now - 2000 }, { activeAt: 0 }], now), now - 2000 + ACTIVE_MS, "the earliest");
});

test("(f) bindings: the bar calls the computation, the sentences are gone, \"no agent browser\" only when loaded, the view follows the tab, profile scheme as in the backend", () => {
  const bar = read("web/src/components/chat/ChatRightSidebar.tsx");
  const section = bar.slice(bar.indexOf("function BrowserSection("));
  assert.ok(section.length > 100, "BrowserSection missing in ChatRightSidebar.tsx");
  for (const call of ["resolveChoice(", "choiceEntries(", "agentNames(", "nextExpiry("]) {
    assert.ok(section.includes(call), `BrowserSection does not call ${call} — the computation would stand twice`);
  }
  assert.ok(!/b\.id === choice/.test(section), "the choice is no longer resolved through the session id");
  assert.ok(!/\bhint=/.test(section), "no menu entry of the browser section carries a hint sentence");
  const i18n = read("web/src/lib/i18n-de.ts");
  for (const set of ["Zuschauen und eingreifen", "derselbe wie im Browser-Reiter"]) {
    assert.ok(!bar.includes(set), `ChatRightSidebar.tsx still carries "${set}"`);
    assert.ok(!i18n.includes(set), `i18n-de.ts still carries "${set}" (dead key)`);
  }
  for (const word of ["Main agent", "in use##controlling", "The agent's browser is closed."]) {
    assert.ok(i18n.includes(`"${word}"`), `i18n-de.ts does not translate "${word}"`);
  }
  assert.ok(/loaded \? t\("No agent browser is running in this chat"\)/.test(section), "\"No agent browser\" only with a loaded list");
  assert.ok(/data-browser-closed/.test(section) && /data-browser-entry/.test(section) && /data-browser-controls/.test(section), "the markers of the browser probe");

  const pane = read("web/src/components/BrowserPane.tsx");
  // Through the pure rule (lib/browser-stream.ts tabAfterTabs, guard browser-stream.test.mjs): an agent viewer
  // (`fixed`) keeps following, the browser of a chat never does.
  assert.ok(/tabAfterTabs\(\{ sel: selRef\.current, agentTab: d\.agentTab \|\| "", prior: agentTabRef\.current, fixed: Boolean\(fixedId\) \}\)/.test(pane) && /if \(followUp\) setSelTab\(followUp\)/.test(pane), "BrowserPane does not follow the agent's tab (tabs event, agentTab) through tabAfterTabs");

  // The profile scheme the computation presupposes: "chat-<chatId>" and "chat-<chatId>-agent-<agentId>".
  assert.ok(read("server/backend/electron/server/runs/agents.js").includes("const profileKeyValue = (chatId, agentId) => `${chatId}-agent-${agentId}`;"), "runs/agents.js names subagent profiles differently");
  assert.ok(read("server/backend/electron/server/browser-profiles.js").includes('const AGENT_SEPARATOR = "-agent-";'), "browser-profiles.js separates differently");
  assert.ok(/profile: s\.profile \|\| "", chatId: s\.chatId \|\| "", agentId: s\.agentId \|\| "", activeAt: s\.activeAt \|\| 0, agentTab: s\.agentTab \|\| ""/.test(read("server/backend/electron/server/browsers.js")), "browsers.js (summarize) does not deliver the fields lib/api/devtools.ts expects");
});

test("(g) the extra window: agent as profile (survives the restart), own as scope, native own not at all — page, bar and pill on the same computation", () => {
  // The address from what the bar shows.
  const s1 = resolveChoice(choiceForProfile(SUB), [agentB(SUB, "s1")], CHAT, true);
  const s2 = resolveChoice(choiceForProfile(SUB), [agentB(SUB, "s2", { port: 40009 })], CHAT, true);
  const url = windowUrl(s1, "ws:ws1", false);
  assert.equal(url, `/browser/?profile=${encodeURIComponent(SUB)}`, "an agent browser goes out as profile");
  assert.equal(windowUrl(s2, "ws:ws1", false), url, "after the agent browser's restart (new session) the same address — the window attaches to the new one");
  assert.equal(windowUrl({ kind: "closed", profile: SUB }, "ws:ws1", true), url, "also closed: the window waits for the next session");
  assert.equal(windowUrl({ kind: "unknown", profile: SUB }, null, null), url);
  assert.equal(windowUrl({ kind: "own" }, "ws:ws1", false), "/browser/?scope=ws%3Aws1", "the own browser as scope");
  assert.equal(windowUrl({ kind: "own" }, "proj:p-7", false), "/browser/?scope=proj%3Ap-7");
  assert.equal(windowUrl({ kind: "own" }, "ws:ws1", true), null, "native own browser: no window (it would show ANOTHER browser)");
  assert.equal(windowUrl({ kind: "own" }, "ws:ws1", null), null, "as long as it is open whether the bridge is there, no button");
  assert.equal(windowUrl({ kind: "own" }, null, false), null, "without scope no window");
  // The own browser of a project carries the bar's chat along — the window of a copy chat shows the copy
  // (`/browser/ensure?chat=`), never main. The workspace has no instance: no chat there.
  assert.equal(windowUrl({ kind: "own" }, "proj:p-7", false, "c 1"), "/browser/?scope=proj%3Ap-7&chat=c%201");
  assert.equal(windowUrl({ kind: "own" }, "ws:ws1", false, "c1"), "/browser/?scope=ws%3Aws1", "the workspace gets no chat");
  assert.equal(windowUrl({ kind: "own" }, "proj:p-7", false, null), "/browser/?scope=proj%3Ap-7");
  assert.equal(windowUrl(s1, "proj:p-7", false, "c1"), url, "an agent browser stays its profile — the chat changes nothing about it");
  assert.deepEqual(windowTarget(new URL(windowUrl({ kind: "own" }, "proj:p-7", false, "c1"), "http://x").search), { kind: "scope", apiBase: "/api/projects/p-7", chat: "c1" }, "the page reads the chat back");
  assert.deepEqual(windowTarget("?scope=ws%3Aws1&chat=c1"), { kind: "scope", apiBase: "/api/workspaces/ws1" }, "a chat on the workspace is not read");
  // The pill: per session, but with profile; an older server without the field — from the scopeKey; without both the id.
  assert.equal(windowForSession(agentB(MAIN, "h1")), `/browser/?profile=${encodeURIComponent(MAIN)}`);
  assert.equal(windowForSession({ ...agentB(SUB, "alt"), profile: undefined }), `/browser/?profile=${encodeURIComponent(SUB)}`);
  assert.equal(windowForSession({ id: "x y", kind: "agent", label: "", workspaceId: "", scopeKey: "", tabs: 1 }), "/browser/?id=x%20y");
  assert.equal(windowForSession(ownB), "/browser/?id=u1");

  // The page reads the same addresses back — round trip through the bar.
  assert.deepEqual(windowTarget(new URL(url, "http://x").search), { kind: "profile", profile: SUB });
  const barScope = scopeFromApiBase("/api/projects/p-7");
  assert.deepEqual(windowTarget(new URL(windowUrl({ kind: "own" }, barScope, false), "http://x").search), { kind: "scope", apiBase: "/api/projects/p-7" });
  assert.deepEqual(windowTarget(new URL(windowUrl({ kind: "own" }, scopeFromApiBase("/api/workspaces/ws1"), false), "http://x").search), { kind: "scope", apiBase: "/api/workspaces/ws1" });
  assert.deepEqual(windowTarget("?id=abc"), { kind: "id", id: "abc" }, "the old address still applies");
  assert.deepEqual(windowTarget("?profile=p&id=abc"), { kind: "profile", profile: "p" }, "profile takes precedence");
  assert.deepEqual(windowTarget(""), { kind: "missing" });
  for (const malicious of ["proj:../../api/x", "ws:", "foo:1", "/api/projects/1", "proj:a/b", "ws:..", "proj:..", "ws:."]) {
    assert.equal(apiBaseFromScope(malicious), null, `"${malicious}" is no scope`);
    assert.deepEqual(windowTarget(`?scope=${encodeURIComponent(malicious)}`), { kind: "missing" }, `"${malicious}" leads to no ensure call`);
  }

  // The page resolves the profile across ALL browsers (it knows no chat): the later session, never an own one.
  assert.equal(resolveProfile(SUB, [agentB(SUB, "alt"), ownB, agentB(SUB, "fresh", { port: 40010 })], true).browser.id, "fresh");
  assert.deepEqual(resolveProfile(SUB, [ownB, agentB(MAIN, "h")], true), { kind: "closed", profile: SUB });
  assert.deepEqual(resolveProfile(SUB, [], false), { kind: "unknown", profile: SUB }, "unloaded is not closed");
  assert.equal(resolveProfile("", [ownB], true).kind, "closed", "the own browser has no profile — it is never a hit");

  // The one call: the same measures as the pill always had.
  const open = [];
  openBrowserWindow({ open: (...a) => { open.push(a); return null; } }, url);
  assert.deepEqual(open, [[url, "_blank", "width=1280,height=860"]]);
  assert.equal(WINDOW_DIMENSIONS, "width=1280,height=860");

  // Bindings across file borders.
  const bar = read("web/src/components/chat/ChatRightSidebar.tsx");
  const section = bar.slice(bar.indexOf("function BrowserSection("));
  // With the chat, and in a copy the stream applies (`copy ? false : native`): there the bar shows the copy's browser, never
  // the scope's native one — so the window exists too. In a chat the scope is `chat:<id>` (the chat's browser, always the stream).
  assert.ok(/const timeWindow = windowUrl\(state, inChat \? scopeFromApiBase\(scopeApiBase\) \?\? `chat:\$\{activeId\}` : scopeFromApiBase\(scopeApiBase\), inChat \|\| copy \? false : native, activeId\);/.test(section), "the section does not compute the window address through windowUrl from the choice (with chat, stream in a chat and in a copy)");
  assert.ok(/setNative\(nativeAvailable\(window\)\)/.test(section), "the section does not ask the bridge (after mount) — the native own browser would get a button to another browser");
  const button = section.slice(section.indexOf("data-browser-window="), section.indexOf("</button>", section.indexOf("data-browser-window=")));
  assert.ok(/onClick=\{\(\) => openBrowserWindow\(window, timeWindow\)\}/.test(button), "the button does not open through openBrowserWindow");
  assert.ok(/title=\{t\("Open in its own window"\)\}/.test(button) && /aria-label=\{t\("Open in its own window"\)\}/.test(button), "the button does not carry the word in title AND aria-label");
  assert.ok(/>\s*\{WindowIcon\}\s*$/.test(button), "the button holds more than the symbol (no description text)");
  const i18n = read("web/src/lib/i18n-de.ts");
  assert.equal(i18n.split('"Open in its own window":').length - 1, 1, "i18n-de.ts does not translate \"Open in its own window\" exactly once (TS1117)");
  const pill = read("web/src/components/pills/AgentBrowsersPill.tsx");
  assert.ok(/openBrowserWindow\(window, windowForSession\(b\)\)/.test(pill), "the pill does not open the window through openBrowserWindow with the profile");
  assert.ok(!/window\.open\(/.test(pill), "the pill still calls window.open itself — two ways to one window");
  const page = read("web/src/app/browser/page.tsx");
  assert.ok(/windowTarget\(window\.location\.search\)/.test(page) && /resolveProfile\(profile, browsers, loaded\)/.test(page), "the page /browser does not read the address through windowTarget/resolveProfile");
  assert.ok(/<BrowserPane key=\{`agent:\$\{state\.browser\.id\}`\} browserId=\{state\.browser\.id\} active \/>/.test(page), "the page does not re-attach the pane per session (key) — it would stay on the old one");
  // The shell: the child window of the same origin is allowed (client).
  assert.ok(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*if \(sameOrigin\(url\)\) return \{ action: "allow" \};/.test(read("client/main.js")), "client/main.js no longer allows a child window of the same origin — button and pill would open nothing");
});

test("(h) browser of the chat: /api/chats/<id>, the server's stream, window with chat:<id>, \"controls right now\" from agentChat — no switch any more", () => {
  const WS = "ws-1";
  assert.equal(ownBrowserApiBase({ chatId: CHAT, focusProjectId: "p-page", wsId: WS }), `/api/chats/${CHAT}`, "in a chat the chat's browser");
  assert.equal(ownBrowserApiBase({ chatId: null, focusProjectId: "p-page", wsId: WS }), "/api/projects/p-page", "without a chat the page's scope");
  assert.equal(ownBrowserApiBase({ chatId: null, focusProjectId: null, wsId: WS }), `/api/workspaces/${WS}`, "without a chat and without an entered project the workspace");
  assert.equal(apiBaseFromScope(`chat:${CHAT}`), `/api/chats/${CHAT}`, "chat:<id> is a scope");
  assert.equal(apiBaseFromScope("chat:.."), null, "\"..\" is no chat id");
  assert.deepEqual(windowTarget(new URL(windowUrl({ kind: "own" }, `chat:${CHAT}`, false, CHAT), "http://x").search), { kind: "scope", apiBase: `/api/chats/${CHAT}` }, "the extra window shows the same browser of the chat");

  assert.equal(agentControlsOwn([{ kind: "user", agentChat: CHAT }], CHAT), true, "the browser this chat holds");
  assert.equal(agentControlsOwn([{ kind: "agent", agentChat: CHAT }], CHAT), false, "an agent browser is not the own");
  assert.equal(agentControlsOwn([{ kind: "user", agentChat: OTHER }], CHAT), false, "another chat holds it");
  assert.equal(agentControlsOwn([{ kind: "user", agentChat: "" }], ""), false, "without a chat never");
  assert.equal(agentControlsOwn([{ kind: "user" }], CHAT), false, "an older server without the field: nobody holds it");

  const bar = read("web/src/components/chat/ChatRightSidebar.tsx");
  const section = bar.slice(bar.indexOf("function BrowserSection("));
  assert.ok(/const scopeApiBase = ownBrowserApiBase\(\{ chatId: activeId, \.\.\.scope \}\);/.test(section), "the section does not compute the browser through ownBrowserApiBase with the chat");
  assert.ok(/agentControlsOwn\(browsers, activeId \?\? ""\)/.test(section), "\"controls right now\" on the own browser does not come from agentControlsOwn");
  assert.ok(/onlyStream=\{inChat \|\| Boolean\(copy\)\}/.test(section), "in a chat always the stream — the native browser is not the chat's");
  for (const gone of ["Toggle", "browser-user", "setAgentUses", "uses"]) assert.ok(!new RegExp(`\\b${gone}\\b`).test(section), `the section still carries "${gone}"`);
  assert.ok(!/browser-user|browserUser|setAgentUses/.test(read("web/src/lib/api/events.ts")), "the client still knows the switch");
  const server = read("server/backend/electron/server/devtools/user-browser.js");
  assert.ok(server.includes('if (sub === "/browser/ensure" && m === "POST") {') && !server.includes("/browser-user"), "the server does not answer POST /api/chats/:id/browser/ensure or still knows the switch");
  assert.ok(!/browserUser|browser_user/.test(read("server/backend/electron/server/store/chats.js")), "the chat object still reads or writes browser_user");
  assert.ok(/agentChat: s\.agentChats\?\.size/.test(read("server/backend/electron/server/browsers.js")), "browsers.js (summarize) does not deliver agentChat");
  const i18n = read("web/src/lib/i18n-de.ts");
  for (const word of ["Chat browser", "The agent is working in this tab"]) assert.ok(i18n.includes(`"${word}"`), `i18n-de.ts does not translate "${word}"`);
  for (const word of ["Agent nutzt meinen Browser", "Mein Browser · Agent"]) assert.ok(!i18n.includes(`"${word}"`), `i18n-de.ts still carries "${word}" (dead key)`);
});
