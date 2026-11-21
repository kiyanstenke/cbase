// The pure parts of the right chat bar (src/lib/chat-bar.ts) — an activity bar in VS Code style. Without a browser: what is checked are
// the computations the bar only CALLS — the width clamp of the draggable panel, the mapping of a key press to a section, the text of a
// counter badge, the tooltip with shortcut — and bindings across file boundaries that no type error would ever report.
//
// Why the clamp is a guard: the width comes from localStorage, and nobody has checked what is in there — a "999" would eat the stage, an
// "abc" would yield `width: NaNpx` and thus a panel without width. Why the shortcut is a MATRIX: `mod` is ⌘ on the Mac and Ctrl otherwise,
// but Ctrl+` is Ctrl EVERYWHERE — and ⌘` is the system's window switch on the Mac, which the bar must not swallow. A test that only checks
// the Mac would leave the other half of the users with a dead shortcut. `clampWidth(null)` must give the default (Number(null) is 0 and
// 0 clamps to MIN): localStorage delivers exactly null for a user without a stored width.
//
// The bindings: (a) ChatPane reads the stored section via `isSection(…)` from the same list — a hand-written whitelist would silently
// reset to "gitlab" at the next section. (b) ChatRightSidebar renders the buttons from `BAR_SECTIONS` and carries every mark of the DOM
// contract as a literal — DOM probes in a real browser grab exactly these identifiers; a
// renamed mark would be a "not found" there that only shows at the next probe run, and that does not run in the gate. (c) The two marks in
// the NEIGHBOURS of the panel (`data-terminal-new` in TerminalsPane, `data-git-commit-menu` in GitSidebar), and GitSidebar reads the git
// state from `useGitState` instead of a tick of its own: the claim "ONE poller for badge and panel" has two readers.
//
// (e) The chat of a COPY: (e1) the computation (lib/chat-instance.ts) is executed, (e2) every git call of the bar and the browser ensure
// go through it and carry the chat, (e3) the iOS git view of a chat does the same.
// COUNTER-TESTS (one place each, shown red):
//   clampWidth(641) expected against MAX+1 ⇒ "clamp" red;
//   web/src/lib/chat-instance.ts   chatPath ignores the chat (`if (true || …) return url`)                  ⇒ (e1) red
//   web/src/lib/git-state.ts       fetch `${apiBase}/git` without chat                                       ⇒ (e2) red
//                                  register key without chat (`key = apiBase`)                               ⇒ (e2) red
//                                  `const state = raw;`                                                      ⇒ (e2) red
//   web/src/components/GitSidebar.tsx   the diff past `path` (`${apiBase}/git/diff`)                         ⇒ (e2) red
//   web/src/components/chat/ChatRightSidebar.tsx   `useGitState(gitApiBase)` without the chat/target         ⇒ (e2) red
//                                  <GitSidebar> without `chatId={target.chatId}`                             ⇒ (e2) red
//                                  own browser without `onlyStream={inChat || Boolean(copy)}`                ⇒ (e2) red
//   web/src/components/BrowserPane.tsx   ensure without the chat (`${apiBase}/browser/ensure`)               ⇒ (e2) red
//   mobile/CbaseMobile/Code/GitPane.swift   the log (git/log) without `query: chatQuery`                     ⇒ (e3) red
//   mobile/CbaseMobile/Chat/ChatView.swift  ChatGitButton with `chatId: nil`                                 ⇒ (e3) red
//   lib/chat-instance.ts afterRetrieval `read: t` instead of `t.error ? t : before.read`                     ⇒ (e1) red
// The sources are read WITH comments only where stated; the bindings use `readCode` (without comment lines), because a header comment
// that names the call literally would keep the sabotage `useGitState(gitApiBase)` green. That the target without a choice is EXACTLY
// `chat=activeId` and never carries chat and instance together is held by web/test/bar-instance.test.mjs (a)/(c) on the executed
// computation. (e2) demands `afterRetrieval(b, result)` including taking over `read`, and `ownCopySaid(git.read)` in the bar (and NO
// `git.tree?.instance` any more); (d) allows `prev.read === read` before the bail-out.
//
// Run:  node --test web/test/chat-bar.test.mjs
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

// The source is compiled to JS with the local tsc and imported — what is checked is the real module text, not a replica (model:
// scrollBand.test.mjs).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-bar-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "chat-bar.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const {
  BAR_SECTIONS, isSection, BAR_WIDTH_MIN, BAR_WIDTH_MAX, BAR_WIDTH_DEFAULT, BAR_RAIL,
  BAR_WIDTH_KEY, clampWidth, SHORTCUT, shortcutSection, badgeText, barTooltip, browserBelongsToChat,
} = await import(pathToFileURL(path.join(out, "chat-bar.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

// The contract values the probes and the bar build against — here as numbers, so that a silent change in chat-bar.ts (say 300 instead of
// 360) does not turn three probes red at once without anyone knowing the reason. The agenda section (right after git) is bound in
// web/test/agenda.test.mjs (f).
const CONTRACT = { sections: ["gitlab", "agenda", "timeline", "artifacts", "channels", "agents", "terminal", "browser"], min: 280, max: 640, preset: 360, rail: 40, key: "cbase-chat-bar-width" };
console.log(`  [bar] sections ${BAR_SECTIONS.join(" · ")} · width ${BAR_WIDTH_MIN}–${BAR_WIDTH_MAX} (default ${BAR_WIDTH_DEFAULT}) · rail ${BAR_RAIL} px · shortcuts ${Object.keys(SHORTCUT).join("/")}`);

// A key press in the form the bar hands to `shortcutSection` (the five fields of a KeyboardEvent that count). Everything not named is
// OFF.
const keyName = (code, mods = {}) => ({ code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

test("The contract: the sections in this order, 280–640 with default 360, rail 40, one global key", () => {
  assert.deepEqual([...BAR_SECTIONS], CONTRACT.sections, "the order of the sections IS the order of the buttons — and that of the probes");
  assert.equal(BAR_WIDTH_MIN, CONTRACT.min);
  assert.equal(BAR_WIDTH_MAX, CONTRACT.max);
  assert.equal(BAR_WIDTH_DEFAULT, CONTRACT.preset);
  assert.equal(BAR_RAIL, CONTRACT.rail);
  assert.equal(BAR_WIDTH_KEY, CONTRACT.key, "the width is global per user — the probe sets exactly this key");
  assert.ok(BAR_WIDTH_MIN < BAR_WIDTH_DEFAULT && BAR_WIDTH_DEFAULT < BAR_WIDTH_MAX, "the default lies within the range");
});

test("isSection: each of the section identifiers ⇒ true; \"gitlab \", \"\", null, a number ⇒ false", () => {
  for (const key of CONTRACT.sections) assert.equal(isSection(key), true, key);
  for (const foreign of ["gitlab ", "", "Gitlab", "git", null, undefined, 3, ["gitlab"]]) {
    assert.equal(isSection(foreign), false, `isSection(${JSON.stringify(foreign)})`);
  }
});

test("clampWidth: the range holds, below it MIN, above it MAX, nonsense becomes the default, fractions are rounded", () => {
  assert.equal(clampWidth(360), 360);
  assert.equal(clampWidth(280), 280, "the lower bound itself passes");
  assert.equal(clampWidth(640), 640, "the upper bound itself passes");
  assert.equal(clampWidth(279), 280);
  assert.equal(clampWidth(0), 280);
  assert.equal(clampWidth(-50), 280);
  assert.equal(clampWidth(641), 640);
  assert.equal(clampWidth(999), 640, "the probe sets \"999\" in localStorage and measures 640");
  // localStorage delivers strings — the clamp takes them, so the bar does not have to parse.
  assert.equal(clampWidth("420"), 420);
  assert.equal(clampWidth(" 420 "), 420, "Number() tolerates margins");
  for (const nonsense of [NaN, null, undefined, "abc", "", Infinity, -Infinity, {}, "12px"]) {
    assert.equal(clampWidth(nonsense), BAR_WIDTH_DEFAULT, `clampWidth(${String(nonsense)}) is the default`);
  }
  assert.equal(clampWidth(400.4), 400, "rounding down");
  assert.equal(clampWidth(400.6), 401, "rounding up");
  assert.equal(clampWidth("400.5"), 401, "Math.round rounds .5 up");
  assert.ok(Number.isInteger(clampWidth(333.3333)), "the result is an integer — `width: 333.3333px` would be a flickering panel");
});

test("shortcutSection as a matrix: Ctrl+` Terminal everywhere, ⌘⇧B/⌘⇧G Mac only, Ctrl+Shift+B/G non-Mac only, without Shift · with Alt · both modifiers · foreign code ⇒ null", () => {
  // Each row: [key press, expectation on the Mac, expectation on non-Mac].
  const matrix = [
    [keyName("Backquote", { ctrlKey: true }), "terminal", "terminal"],
    [keyName("Backquote", { metaKey: true }), null, null], // ⌘` is the window switch of the Mac — never swallow
    [keyName("Backquote", { ctrlKey: true, shiftKey: true }), null, null], // Ctrl+Shift+` is a different shortcut
    [keyName("KeyB", { metaKey: true, shiftKey: true }), "browser", null],
    [keyName("KeyB", { ctrlKey: true, shiftKey: true }), null, "browser"],
    [keyName("KeyG", { metaKey: true, shiftKey: true }), "gitlab", null],
    [keyName("KeyG", { ctrlKey: true, shiftKey: true }), null, "gitlab"],
    [keyName("KeyB", { metaKey: true }), null, null], // without Shift: ⌘B is bold in the editor
    [keyName("KeyG", { ctrlKey: true }), null, null],
    [keyName("KeyB", { metaKey: true, shiftKey: true, altKey: true }), null, null], // plus Alt ⇒ nothing
    [keyName("Backquote", { ctrlKey: true, altKey: true }), null, null],
    [keyName("KeyB", { metaKey: true, ctrlKey: true, shiftKey: true }), null, null], // both modifiers ⇒ nothing
    [keyName("Backquote", { ctrlKey: true, metaKey: true }), null, null],
    [keyName("KeyX", { metaKey: true, shiftKey: true }), null, null], // foreign code
    [keyName("KeyX", { ctrlKey: true, shiftKey: true }), null, null],
    [keyName("KeyB"), null, null], // without any modifier: a typed "b"
    [keyName("Backquote"), null, null],
  ];
  const wrong = [];
  for (const [e, mac, otherwise] of matrix) {
    const desc = `${e.code}${e.metaKey ? "+meta" : ""}${e.ctrlKey ? "+ctrl" : ""}${e.shiftKey ? "+shift" : ""}${e.altKey ? "+alt" : ""}`;
    const isMac = shortcutSection(e, true), isElse = shortcutSection(e, false);
    if (isMac !== mac) wrong.push(`${desc} on Mac: ${isMac} instead of ${mac}`);
    if (isElse !== otherwise) wrong.push(`${desc} on non-Mac: ${isElse} instead of ${otherwise}`);
  }
  console.log(`  [shortcuts] ${matrix.length} key presses × 2 platforms`);
  assert.deepEqual(wrong, [], "mapping key press → section");
  // And every shortcut in the catalog hits its section — an entry that never applies would be a tooltip that lies.
  for (const [key, k] of Object.entries(SHORTCUT)) {
    const e = keyName(k.code, { shiftKey: k.shift, ...(k.mod === "ctrl" ? { ctrlKey: true } : { metaKey: true }) });
    assert.equal(shortcutSection(e, true), key, `SHORTCUT.${key} applies on the Mac`);
    const e2 = keyName(k.code, { shiftKey: k.shift, ctrlKey: true });
    assert.equal(shortcutSection(e2, false), key, `SHORTCUT.${key} applies on non-Mac (Ctrl)`);
  }
});

test("badgeText: 0 ⇒ \"\", 1 ⇒ \"1\", 9 ⇒ \"9\", 10 ⇒ \"9+\", 3.7 ⇒ \"3\", NaN and negative ⇒ \"\"", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(9), "9");
  assert.equal(badgeText(10), "9+");
  assert.equal(badgeText(12), "9+", "the probe seeds twelve artifacts and expects \"9+\"");
  assert.equal(badgeText(999), "9+");
  assert.equal(badgeText(3.7), "3", "fractions are cut off — a counter is an integer");
  assert.equal(badgeText(NaN), "");
  assert.equal(badgeText(-1), "");
  assert.equal(badgeText(Infinity), "");
  assert.equal(badgeText(undefined), "", "a missing counter is no badge");
});

test("barTooltip: label with shortcut in parentheses, on non-Mac Ctrl+Shift instead of ⌘⇧, without a shortcut only the label", () => {
  assert.equal(barTooltip("Browser", "browser", true), "Browser (⌘⇧B)");
  assert.equal(barTooltip("Browser", "browser", false), "Browser (Ctrl+Shift+B)");
  assert.equal(barTooltip("GitLab", "gitlab", true), "GitLab (⌘⇧G)");
  assert.equal(barTooltip("GitLab", "gitlab", false), "GitLab (Ctrl+Shift+G)");
  assert.equal(barTooltip("Terminal", "terminal", true), "Terminal (Ctrl+`)", "Ctrl+` stays Ctrl on the Mac too");
  assert.equal(barTooltip("Terminal", "terminal", false), "Terminal (Ctrl+`)");
  for (const key of ["artifacts", "channels", "agents"]) {
    assert.equal(barTooltip("Label", key, true), "Label", `${key} has no shortcut — no empty parentheses`);
    assert.equal(barTooltip("Label", key, false), "Label");
  }
  // The label runs through t() — the tooltip takes it as it comes.
  assert.equal(barTooltip("Channels", "channels", true), "Channels");
});

test("browserBelongsToChat: the profile SEGMENT decides — \"chat-ab\" does not hit \"chat-abc\", subagent profiles count too", () => {
  // `scopeKey` is `agent:<profile folder>:<port>`; the folder is called `chat-<id>` (main agent) or
  // `chat-<id>-agent-<n>` (subagent). The browser choice in the panel header lists only those of this chat.
  assert.equal(browserBelongsToChat("agent:chat-ab:9222", "ab"), true);
  assert.equal(browserBelongsToChat("agent:chat-ab-agent-2:9223", "ab"), true, "the browser of a subagent belongs to the chat");
  assert.equal(browserBelongsToChat("agent:chat-abc:9222", "ab"), false, "a prefix comparison would hit here — it is a segment comparison");
  assert.equal(browserBelongsToChat("agent:chat-abc-agent-1:9222", "ab"), false);
  assert.equal(browserBelongsToChat("agent:chat-ab:9222", "abc"), false);
  assert.equal(browserBelongsToChat("agent:chat-ab:9222", ""), false, "without a chat nothing belongs to it");
  assert.equal(browserBelongsToChat("", "ab"), false);
  assert.equal(browserBelongsToChat("chat-ab", "ab"), false, "without the `agent:` prefix there is no segment");
});

// ── Bindings by path ──────────────────────────────────────────────────────────────────────────

test("Binding (a): ChatPane reads the stored section via isSection() — no hand-written whitelist any more, and the type comes from chat-bar", () => {
  const pane = read("src/components/chat/ChatPane.tsx");
  const catalog = read("src/components/chat/ChatCatalog.tsx");
  assert.ok(pane.includes("isSection("), "ChatPane.tsx does not call isSection( — the stored tab would then be checked against a list of its own that is silently too short at the next section");
  assert.ok(/import\s*\{[^}]*\bisSection\b[^}]*\}\s*from\s*"@\/lib\/chat-bar"/.test(pane), "in ChatPane.tsx isSection comes from @/lib/chat-bar, not from a replica");
  for (const rest of ['v === "artifacts" || v === "channels"', 'v === "artifacts"||v === "channels"', '=== "agents" ? v : "gitlab"']) {
    assert.ok(!pane.includes(rest), `the old whitelist is still in ChatPane.tsx: ${rest}`);
  }
  // The type has ONE source: ChatCatalog imports `RightSidebarTab` from chat-bar and passes it on (existing importers stay) — a second
  // union there would be the list once more.
  assert.ok(!/^type RightSidebarTab\s*=\s*"gitlab"/m.test(catalog) && !/^export type RightSidebarTab\s*=\s*"gitlab"/m.test(catalog),
    "ChatCatalog.tsx still carries a union of its own `type RightSidebarTab = \"gitlab\" | …` — the type comes from @/lib/chat-bar");
  assert.ok(/from "@\/lib\/chat-bar"/.test(catalog) && /RightSidebarTab/.test(catalog), "ChatCatalog.tsx imports RightSidebarTab from @/lib/chat-bar and exports it on");
});

test("Binding (b): ChatRightSidebar renders the buttons from BAR_SECTIONS and carries every mark of the DOM contract as a literal", () => {
  const sidebar = read("src/components/chat/ChatRightSidebar.tsx");
  assert.ok(/import\s*\{[^}]*\bBAR_SECTIONS\b[^}]*\}\s*from\s*"@\/lib\/chat-bar"/.test(sidebar),
    "ChatRightSidebar.tsx does not import BAR_SECTIONS from @/lib/chat-bar — the buttons would then come from a second list");
  assert.ok(/BAR_SECTIONS\.map\(/.test(sidebar), "the buttons of the rail arise from BAR_SECTIONS.map( — not from hand-written <button>s");
  // The marks the probes grab (coding-glass, channel-bar, run.mjs) and the helpers the bar calls from chat-bar/git-state — each as a
  // literal, so that a grep finds it.
  const markers = [
    "data-chat-bar", "data-chat-bar-open", "data-chat-bar-section",
    "data-bar-rail", "data-bar-section", "data-bar-badge", "data-bar-active",
    "data-bar-panel", "data-bar-header", "data-bar-handle",
    "data-agent-rail", "data-channel-pill-unread", "data-browser-choice",
    "BAR_WIDTH_KEY", "clampWidth(", "shortcutSection(", "badgeText(", "barTooltip(", "useGitState(",
  ];
  const missing = markers.filter((m) => !sidebar.includes(m));
  assert.deepEqual(missing, [], "a mark of the contract is missing in ChatRightSidebar.tsx (the probes grab them by identifier)");
  assert.ok(/from "@\/lib\/git-state"/.test(sidebar), "the git state comes from @/lib/git-state — ONE poller for badge and panel");
  // What must NOT be there any more: the word tabs of the old kit and the 52 px pill.
  for (const rest of ["<Segments", "data-cb-strip-end", "w-[52px]"]) {
    assert.ok(!sidebar.includes(rest), `remnant of the old bar in ChatRightSidebar.tsx: ${rest}`);
  }
});

test("Binding (c): the neighbours of the panel — TerminalsPane and GitSidebar carry their contract marks, and GitSidebar has no tick of its own any more", () => {
  // The two marks of the contract that are NOT in ChatRightSidebar but in the building blocks the panel renders: the terminal header
  // (variant "bar") and the commit menu. Without these lines a rename would be noticed nowhere — no probe grabs them.
  const terminals = read("src/components/TerminalsPane.tsx");
  assert.ok(terminals.includes("data-terminal-new"), "TerminalsPane.tsx does not carry the mark data-terminal-new (button \"New terminal\" in the header of the bar variant)");
  const gitSidebar = read("src/components/GitSidebar.tsx");
  assert.ok(gitSidebar.includes("data-git-commit-menu"), "GitSidebar.tsx does not carry the mark data-git-commit-menu (the menu next to the commit button)");
  // "ONE poller for badge and panel" has TWO readers: the bar (binding b) and GitSidebar, which used to carry its own tick (POLL_MS,
  // setInterval, visibilitychange). Whoever builds it back there doubles `git status` every 6 s — without anything else turning red.
  assert.ok(gitSidebar.includes("useGitState("), "GitSidebar.tsx does not call useGitState( — the git state would then come from a second tick");
  assert.ok(/from "@\/lib\/git-state"/.test(gitSidebar), "GitSidebar.tsx does not import useGitState from @/lib/git-state");
  assert.ok(!/setInterval\(|POLL_MS/.test(gitSidebar), "GitSidebar.tsx carries a tick of its own again (setInterval/POLL_MS) — the poller belongs in lib/git-state.ts alone");
});

test("Binding (d): the shared git state does NOT render on an unchanged tree, and amend takes only staged files", () => {
  // `fetch()` reported in the `finally` on EVERY tick, and the reader set `setStatus({ tree, loaded })` — a new object, so no React
  // bail-out. The whole bar with the terminal tub and up to 300 file rows would then re-render every 6 s although `git status` brought
  // nothing new — and the header comment promised the opposite.
  // git-state.ts imports React and cannot be executed here; what is checked is the source text at the two places that carry the claim.
  // Counter-test: the state before the fix is red at both lines (`setStatus({ tree, loaded })`, `report(b)` without a condition in the finally).
  const source = read("src/lib/git-state.ts");
  // The state carries its key (instance choice of the bar, (e2)) — the condition before it is allowed, the bail-out stays.
  // Also `read` (what the server said last, (e1) afterRetrieval) — likewise allowed before it.
  assert.ok(/setStatus\(\(prev\)\s*=>\s*\(?(?:prev\.key === key && )?(?:prev\.read === read && )?prev\.tree === tree && prev\.loaded === loaded \? prev :/.test(source),
    "git-state.ts: the reader sets the state without a bail-out — the same tree must return the same object (`setStatus((prev) => prev.tree === tree && … ? prev : …)`)");
  assert.ok(!/setStatus\(\{\s*tree,\s*loaded\s*\}\)/.test(source), "git-state.ts: `setStatus({ tree, loaded })` builds a new object per tick — every reader would then render every 6 s");
  const finallyBlock = source.slice(source.indexOf("} finally {"), source.indexOf("}", source.indexOf("} finally {") + 12));
  assert.ok(/if \(fresh\) report\(b\)/.test(finallyBlock), "git-state.ts: the fetch reports unconditionally in the finally — only a changed print, the first fetch or the change into the error state may report");
  // Amend: the smart-commit fallback of the main button (nothing staged ⇒ everything) must NOT carry over to amend — otherwise the whole
  // tree moves into HEAD on a dirty tree although only the message was to be changed.
  const gitSidebar = read("src/components/GitSidebar.tsx");
  assert.ok(!/all:\s*art === "all" \|\| smartAll/.test(gitSidebar), "GitSidebar.tsx: amend takes over the smart-commit fallback (`all: art === \"all\" || smartAll`) — amend takes only staged files");
  assert.ok(/kind !== "amend" && smartAll/.test(gitSidebar), "GitSidebar.tsx: the smart-commit fallback must explicitly exclude amend (`kind !== \"amend\" && smartAll`)");
});

// ── (e) The chat of a COPY ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The finding: the bar of a chat that has moved into its copy k1 called git and browser WITHOUT `?chat` — the server (devtools/routes.js
// targetInstance) then took main. The panel showed the state of main as that of the chat, and commit, discard, stash, checkout from this
// chat changed the repo of MAIN (discard deleted unsaved work there); the browser of the bar was that of main. The server could do it
// long since (gitOptions, `/browser/ensure?chat=`) — no client attached the chat.
// Checked are (e1) the computation (lib/chat-instance.ts), (e2) that every git call of the bar and the ensure of its browser go through it
// and carry the chat, (e3) that the iOS git view of a chat does the same.
const outInstance = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-instance-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "chat-instance.ts"),
  "--outDir", outInstance, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { bindsChat, chatPath, copyName, gitErrorTree, afterRetrieval, ownCopySaid } = await import(pathToFileURL(path.join(outInstance, "chat-instance.js")).href);
try { fs.rmSync(outInstance, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
// The bindings read the source text WITHOUT comment lines (`//`, `///`, `*`, `/*`) and without JSX comments: the header comments name
// the same calls (`useGitState(gitApiBase, activeId)`, `chatPath(apiBase, "", chatId)`) — with the comment the sabotage
// `useGitState(gitApiBase)` stayed green.
const code = (src) => src.split("\n").filter((z) => !/^\s*(\/\/|\/\*|\*)/.test(z)).join("\n").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const readCode = (rel) => code(read(rel));

test("(e1) chatPath: a project route carries the chat as a query (also behind ?repo=), the workspace level and a call without a chat never", () => {
  assert.equal(chatPath("/api/projects/p1", "/git", "c1"), "/api/projects/p1/git?chat=c1");
  assert.equal(chatPath("/api/projects/p1", "", "c1"), "/api/projects/p1?chat=c1", "the key of the git register: one inventory per chat");
  assert.equal(chatPath("/api/projects/p1", "/git/stashes?repo=a%2Fb", "c1"), "/api/projects/p1/git/stashes?repo=a%2Fb&chat=c1", "behind a query with &");
  assert.equal(chatPath("/api/projects/p1", "/browser/ensure", "c 1/x"), "/api/projects/p1/browser/ensure?chat=c%201%2Fx", "the id is encoded");
  for (const without of [null, undefined, ""]) assert.equal(chatPath("/api/projects/p1", "/git", without), "/api/projects/p1/git", `without a chat (${String(without)}) the path of today`);
  assert.equal(chatPath("/api/workspaces/w1", "/git", "c1"), "/api/workspaces/w1/git", "the workspace level has no instance — no ?chat");
  assert.equal(bindsChat("/api/projects/p1"), true);
  for (const no of ["/api/workspaces/w1", "/api/projects/p1?chat=c", "/api/projects/", "/api/projects/p1/git", ""]) assert.equal(bindsChat(no), false, no);
});

test("(e1) copyName and gitErrorTree: \"copy-k1\" is called k1, main has none; an error with `error` is a situation, not an empty repo", () => {
  assert.equal(copyName("copy-k1"), "k1");
  assert.equal(copyName("copy-with-dash"), "with-dash");
  for (const no of ["main", "", null, undefined, "copy-", "k1"]) assert.equal(copyName(no), null, String(no));
  const text = "The copy \"copy-k1\" of this chat (p1/copy-k1) cannot be resolved";
  const locked = Object.assign(new Error(text), { error: text, instance: "copy-k1" });
  assert.deepEqual(gitErrorTree(locked), { repos: [], error: text, instance: "copy-k1" }, "the 409 of a locked copy shows in the panel — with its name");
  assert.deepEqual(gitErrorTree(Object.assign(new Error("x"), { error: "fence" })), { repos: [], error: "fence" });
  assert.deepEqual(gitErrorTree(new Error("Failed to fetch")), { repos: [] }, "an error without `error` stays what it was (silent)");
  assert.deepEqual(gitErrorTree(null), { repos: [] });
  assert.deepEqual(gitErrorTree("broken"), { repos: [] });
  // Instance choice: the 404/400 of a CHOSEN instance keeps `code` and `identifier` — that is how the bar's choice visibly falls back
  // (lib/bar-instance.ts); every other code stays out, a situation without `error` stays silent.
  const way = Object.assign(new Error("unknown instance: p1/copy-k2"), { error: "unknown instance: p1/copy-k2", code: "UNKNOWN_INSTANCE", identifier: "p1/copy-k2" });
  assert.deepEqual(gitErrorTree(way), { repos: [], error: "unknown instance: p1/copy-k2", code: "UNKNOWN_INSTANCE", identifier: "p1/copy-k2" });
  assert.deepEqual(gitErrorTree(Object.assign(new Error("x"), { error: "x", code: "INSTANCE_INVALID", identifier: "" })), { repos: [], error: "x", code: "INSTANCE_INVALID" }, "an empty identifier drops out");
  assert.deepEqual(gitErrorTree(Object.assign(new Error("x"), { error: "x", code: "INSTANCE_FOREIGN", identifier: "p1/main" })), { repos: [], error: "x" }, "only the two codes of the choice");
  assert.deepEqual(gitErrorTree(Object.assign(new Error("x"), { code: "UNKNOWN_INSTANCE" })), { repos: [] }, "without `error` silent as before");
});

test("(e1) afterRetrieval: a silent failure shows the empty tree but leaves `read` standing — the own copy comes only from an answer", () => {
  // The bar read the chat's own instance from the tree, and a failure WITHOUT `error` (network, 502/504 on a restart of B) set it to
  // `{ repos: [] }` — \"no answer\" meant \"main\". Counter-test: in afterRetrieval `read: t.error ? t : before.read` → `read: t` ⇒ this check red.
  const empty = { tree: null, print: "", read: null };
  const copy = { repos: [{ relPath: "", counts: { total: 2 } }], instance: "copy-k1" };
  // The first fetch fails silently: the panel shows the empty tree (as before), the server said nothing.
  const a = afterRetrieval(empty, { kind: "error", error: new Error("Failed to fetch") });
  assert.deepEqual([a.tree, a.print, a.read, a.fresh], [{ repos: [] }, "", null, true]);
  assert.equal(ownCopySaid(a.read), undefined, "without an answer the own instance is UNKNOWN, not main");
  // Repeated silently: nothing new.
  assert.equal(afterRetrieval(a, { kind: "error", error: new Error("502") }).fresh, false);
  // The answer names the copy.
  const b = afterRetrieval(a, { kind: "response", tree: copy });
  assert.deepEqual([b.tree, b.read, b.fresh], [copy, copy, true]);
  assert.equal(ownCopySaid(b.read), "k1");
  // The same tree once more: nothing new, the same object stays.
  const b2 = afterRetrieval(b, { kind: "response", tree: JSON.parse(JSON.stringify(copy)) });
  assert.equal(b2.fresh, false);
  assert.equal(b2.tree, copy);
  // B restarts (502 without `error`): the panel shows empty, `read` stays the copy — the bar keeps saying "Copy k1 · this chat".
  const c = afterRetrieval(b, { kind: "error", error: Object.assign(new Error("Bad Gateway"), { status: 502 }) });
  assert.deepEqual([c.tree, c.print, c.fresh], [{ repos: [] }, "", true]);
  assert.equal(c.read, copy);
  assert.equal(ownCopySaid(c.read), "k1", "a silent failure does not turn the copy into main");
  // The 409 of a locked copy IS an answer: the situation including the copy.
  const text = "The copy \"copy-k1\" of this chat (p1/copy-k1) cannot be resolved";
  const d = afterRetrieval(c, { kind: "error", error: Object.assign(new Error(text), { error: text, instance: "copy-k1" }) });
  assert.deepEqual([d.tree, d.read, d.fresh], [{ repos: [], error: text, instance: "copy-k1" }, { repos: [], error: text, instance: "copy-k1" }, true]);
  assert.ok(d.print.startsWith("error:"));
  assert.equal(ownCopySaid(d.read), "k1");
  // Main answers without `instance`: main is said (null), not "unknown".
  const e = afterRetrieval(d, { kind: "response", tree: { repos: [] } });
  assert.equal(ownCopySaid(e.read), null);
  for (const nothing of [null, undefined]) assert.equal(ownCopySaid(nothing), undefined);
});

test("(e2) Binding: every git call of the bar and the ensure of its browser carry the chat — register, panel, bar, BrowserPane, extra window", () => {
  const source = readCode("src/lib/git-state.ts");
  assert.ok(/export function useGitState\(apiBase: string \| null, chatId\?: string \| null(?:, instance\?: string \| null)?\)/.test(source), "git-state.ts: useGitState does not take the chat (second argument)");
  assert.ok(/chatPath\(apiBase, "\/git", chatId\)/.test(source), "git-state.ts: the fetch does not go through chatPath(apiBase, \"/git\", chatId) — the tree would come from main");
  assert.ok(/chatPath\(apiBase, "", chatId\)/.test(source), "git-state.ts: the register key does not carry the chat — two chats would share one tree");
  assert.ok(!/`\$\{apiBase\}\/git`/.test(source), "git-state.ts still builds `${apiBase}/git` itself");
  // `fetch` computes via `afterRetrieval` (lib/chat-instance.ts, (e1) EXECUTED: the failure goes through gitErrorTree there, and a silent one
  // leaves `read` standing) — here only that `fetch` calls it and passes the error in.
  assert.ok(/result = \{ kind: "error", error: e \}/.test(source) && /afterRetrieval\(b, result\)/.test(source), "git-state.ts: a failed fetch does not go through afterRetrieval/gitErrorTree — the 409 of a locked copy would look like \"no repository\"");
  assert.ok(/b\.read = r\.read/.test(source) && /b\.read = tree;/.test(source), "git-state.ts: `read` is not taken over from afterRetrieval or from the answer of an action (setTree)");
  // The state carries its key — otherwise after a change of target the tree of the old target would stand under the new one for one render,
  // the bar would read the chat's copy from the tree of main, and the own browser would hang wrong.
  assert.ok(/raw\.key === key \? raw : fromRegister\(key\)/.test(source), "git-state.ts: the state does not apply only to its key — after a target change the old tree would stand there for one render");

  const git = readCode("src/components/GitSidebar.tsx");
  // `active ? apiBase : null`: the column of the hidden code tab does not read the state — visibly the same.
  assert.ok(/useGitState\((?:active \? apiBase : null|apiBase), chatId(?:, instance)?\)/.test(git), "GitSidebar.tsx: useGitState(apiBase, chatId) is missing — panel and badge would read different trees");
  assert.ok(/chatPath\(apiBase, rest, chatId\)/.test(git), "GitSidebar.tsx: the path builder `path` does not go through chatPath(apiBase, rest, chatId)");
  assert.ok(!/\$\{apiBase\}/.test(git), "GitSidebar.tsx builds an address past `path` (`${apiBase}…`) — this call would go to main");
  // The graph of the bar (components/git-bar/GitGraph.tsx) belongs too: it gets `path` as a prop — counted over both files.
  const graph = readCode("src/components/git-bar/GitGraph.tsx");
  assert.ok(!/\$\{apiBase\}/.test(graph), "GitGraph.tsx builds an address past `path` (`${apiBase}…`) — this call would go to main");
  const barGit = `${git}\n${graph}`;
  const calls = [...barGit.matchAll(/\bapi(?:<[^(]*?>)?\(/g)].map((m) => barGit.slice(m.index + m[0].length, m.index + m[0].length + 60));
  assert.ok(calls.length >= 15, `GitSidebar.tsx + GitGraph.tsx: only ${calls.length} api calls found — the count no longer measures anything`);
  const past = calls.filter((a) => !a.startsWith("path("));
  assert.deepEqual(past, [], "GitSidebar.tsx/GitGraph.tsx: every api call begins with path( — these do not");

  const bar = readCode("src/components/chat/ChatRightSidebar.tsx");
  // The git state carries the TARGET of the choice: without a choice exactly the chat, with a choice exactly the chosen instance
  // (lib/bar-instance.ts; "never chat and instance together" and "without a choice exactly chat=activeId" are held by
  // web/test/bar-instance.test.mjs (a)/(c) on the executed computation).
  assert.ok(/useGitState\(gitApiBase, target\.chatId, target\.instance\)/.test(bar), "ChatRightSidebar.tsx: the git state of the bar does not carry the target of the choice (useGitState(gitApiBase, target.chatId, target.instance))");
  assert.ok(/choiceInput = \{[^}]*chatId: activeId[^}]*\};[^]*?barGitChoice\(\{ \.\.\.choiceInput/.test(bar), "ChatRightSidebar.tsx: the choice does not compute with the chat of the bar (chatId: activeId)");
  const gitStart = bar.search(/<GitSidebar\s+key=/);
  assert.ok(gitStart > 0, "ChatRightSidebar.tsx: the element <GitSidebar key=… is missing");
  const gitEl = bar.slice(gitStart, bar.indexOf("/>", gitStart));
  assert.ok(/chatId=\{target\.chatId\}/.test(gitEl) && /instance=\{target\.instance\}/.test(gitEl), "ChatRightSidebar.tsx: <GitSidebar …> does not get the target of the choice (chatId={target.chatId} instance={target.instance})");
  const ownStart = bar.indexOf("<BrowserPane key={`own:");
  assert.ok(ownStart > 0, "ChatRightSidebar.tsx: the own browser of the bar (<BrowserPane key={`own:…) is missing");
  const own = bar.slice(ownStart, bar.indexOf("/>", ownStart));
  assert.ok(/chatId=\{activeId\}/.test(own), "ChatRightSidebar.tsx: the own browser of the bar does not get the chat — ensure would go to main");
  // In the chat the own browser is the chat's browser — always the stream (`inChat ||`, guard browser-choice.test.mjs (h)).
  assert.ok(/onlyStream=\{inChat \|\| Boolean\(copy\)\}/.test(own), "ChatRightSidebar.tsx: in a copy chat the own browser does not show the copy's stream (onlyStream) — the native one would be the tab of the page");
  assert.ok(/key=\{`own:\$\{scopeApiBase\}:\$\{copy \?\? ""\}`\}/.test(own), "ChatRightSidebar.tsx: when the chat moves in or out, the own browser does not re-mount (key without the copy) — it would stay on the old instance");
  // From what the server last SAID (`git.read`), never from `git.tree`: a silent failure stands there as an empty tree without `instance`,
  // and "no answer" meant "main" ((e1) afterRetrieval, bar-instance (j)).
  assert.ok(/ownCopySaid\(git\.read\)/.test(bar) && bar.includes("data-bar-instance"), "ChatRightSidebar.tsx does not name the copy (ownCopySaid(git.read), data-bar-instance)");
  assert.ok(!/git\.tree\??\.instance/.test(bar), "ChatRightSidebar.tsx reads the chat's copy from git.tree — a silent failure would mean \"main\" there");

  const pane = readCode("src/components/BrowserPane.tsx");
  assert.ok(/chatPath\(apiBase, "\/browser\/ensure", chatId\)/.test(pane), "BrowserPane.tsx: ensure does not go through chatPath(apiBase, \"/browser/ensure\", chatId)");
  assert.ok(!/`\$\{apiBase\}\/browser\/ensure`/.test(pane), "BrowserPane.tsx still builds `${apiBase}/browser/ensure` itself");
  assert.ok(/native && scope && !props\.browserId && !props\.onlyStream/.test(pane), "BrowserPane.tsx: the switch takes the native browser for a copy too (onlyStream missing)");
  const page = readCode("src/app/browser/page.tsx");
  assert.ok(/chatId=\{target\.chat\}/.test(page), "the /browser page does not pass the chat of the extra window on to the BrowserPane");
});

test("(e3) Binding iOS: the git view of a chat (ChatGitButton) carries the chat on EVERY call — APIClient encodes itself", () => {
  const swift = code(fs.readFileSync(path.resolve(webDir, "..", "mobile", "CbaseMobile", "Code", "GitPane.swift"), "utf8"));
  const model = swift.slice(swift.indexOf("final class GitModel"), swift.indexOf("\nstruct GitStashEntry"));
  const calls = [...model.matchAll(/client\.(get|post)\(/g)].map((m) => {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < model.length; i++) { if (model[i] === "(") depth++; else if (model[i] === ")" && --depth === 0) break; }
    return model.slice(m.index, i + 1).replace(/\s+/g, " ");
  });
  assert.ok(calls.length >= 6, `GitModel: only ${calls.length} calls found — the count no longer measures anything`);
  assert.deepEqual(calls.filter((a) => !a.includes("chatQuery")), [], "GitModel: these calls do not carry the chat (chatQuery)");
  assert.ok(!/addingPercentEncoding/.test(model), "GitModel pre-encodes — APIClient.makeURL encodes itself (do not encode the path beforehand on mobile)");
  const button = swift.slice(swift.indexOf("struct ChatGitButton"));
  assert.ok(/chatId: chatId/.test(button), "ChatGitButton does not pass the chat on to the GitModel");
  const chatView = code(fs.readFileSync(path.resolve(webDir, "..", "mobile", "CbaseMobile", "Chat", "ChatView.swift"), "utf8"));
  const start = chatView.indexOf("ChatGitButton(");
  const call = chatView.slice(start, chatView.indexOf("runsFinished: runsFinished", start));
  assert.ok(/chatId: model\.isDraft \? nil : model\.chat\.id/.test(call), "ChatView does not give ChatGitButton the chat (chatId: model.isDraft ? nil : model.chat.id)");
});

// ── (c2) GitSidebar has ONE inventory and no route of the big view ──────────────────────────────────────────────────────────────
// The small view has NO route of its own and NO second poller — a second `useGitState` or the route of the big view would double `git` per
// tick without anything else turning red. What holds for the whole bar: exactly ONE `useGitState(`, no route of the big view, the repos
// from the tree of `useGitState` (no tick of its own: binding (c)). Checked on the source without comments; the counter-test is built in:
// two sabotages on a copy in memory. (At the end of the file because `readCode` only exists after the `await` above.)
function checkOneInventory(src) {
  assert.equal((src.match(/useGitState\(/g) ?? []).length, 1, "GitSidebar.tsx does not call useGitState( exactly once — a second inventory would be a second tick");
  assert.ok(!/fetchGitView|\/gitView/.test(src), "GitSidebar.tsx asks the route of the big view — the small one has none of its own (GA9)");
  assert.ok(/const repos = tree\?\.repos \?\? \[\];/.test(src), "GitSidebar.tsx does not take its repos from the tree of useGitState");
}

test("(c2) GitSidebar: exactly one inventory (useGitState), no route of the big view (with counter-test)", () => {
  const git = readCode("src/components/GitSidebar.tsx");
  checkOneInventory(git);
  const sabotages = {
    "second inventory": git.replace("  const repos = tree?.repos ?? [];", "  const second = useGitState(\"/x\");\n  const repos = tree?.repos ?? [];"),
    "route of the big view": git.replace("  const repos = tree?.repos ?? [];", "  void fetchGitView;\n  const repos = tree?.repos ?? [];"),
  };
  for (const [name, copy] of Object.entries(sabotages)) {
    assert.notEqual(copy, git, `sabotage "${name}" no longer applies (wording in GitSidebar.tsx changed?)`);
    assert.throws(() => checkOneInventory(copy), `sabotage "${name}" stays green — the check measures nothing`);
  }
});
