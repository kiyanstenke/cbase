// Lists that the server keeps and a client copies.
//
// The house rule is "two places for the same list: delete one" — and where deleting is not possible (a client cannot reach a
// server constant), it is: bind. This file holds server lists against their client copies, which are measured nowhere else.
//
// The BETTER design stands next to it and is not replaced here, only secured: delivering a list via `/api` has NO second copy at
// all. Where a copy is still needed today because it applies before the first server response or is purely editorial, it stands
// under a guard.
//
// Bound here: the node kinds and turn kinds of the workflow editor, the alias/mode tables of the composer (web <-> iOS <-> server),
// the default-model fallback, the permission pickers, the language sample, the reserved names of the workflow library and the
// channel system kinds and wait reasons.
//
// Read BY PATH — whoever moves one of the files updates the line here.
//
// Run:  node --test web/test/list-binding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EFFORT_LEVELS, NODE_TYPES, PERMISSION_MODES, countsAsStep } from "../../server/backend/electron/server/workflows.js";
import { DEFAULT_MODEL_FALLBACK as DEFAULT_MODEL_FALLBACK_SERVER } from "../../server/backend/electron/server/providers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOURCE_EDITOR = path.join(repo, "web", "src", "components", "workflow", "WorkflowEditor.tsx");
const editor = fs.readFileSync(SOURCE_EDITOR, "utf8");
// The type table and the two palette lists sit in the sheet WorkflowBadge.tsx — the editor imports them from there.
const SOURCE_BADGE = path.join(repo, "web", "src", "components", "workflow", "WorkflowBadge.tsx");
const badge = fs.readFileSync(SOURCE_BADGE, "utf8");

const list = (name, source, location) => {
  const m = source.match(new RegExp(`^export const ${name}: WorkflowNodeType\\[\\] = \\[([^\\]]*)\\];$`, "m"));
  assert.ok(m, `the declaration of ${name} is in ${location} — renamed? Move the anchor, do not delete the test`);
  const values = m[1].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);
  assert.ok(values.length, `${name} is empty — does the regex still match?`);
  return values;
};

// ── Node kinds ──────────────────────────────────────────────────────────────────────────────
//
// `NODE_TYPES` (workflows.js) is the truth: the server normalizes every graph against it. The editor splits the same nine
// kinds into two palettes (entry / steps). If a kind is missing there, it can no longer be CREATED — the graph would stay valid,
// only unreachable; if one is too many, the editor creates nodes that the server throws away on saving.
test("workflow editor: entries + steps are exactly the node kinds of the server", () => {
  const entries = list("ENTRIES", badge, "WorkflowBadge.tsx");
  const steps = list("STEPS", badge, "WorkflowBadge.tsx");
  const inEditor = [...entries, ...steps];
  console.log(`  [node kinds] server ${NODE_TYPES.length}, editor ${entries.length} entries + ${steps.length} steps`);
  assert.deepEqual([...inEditor].sort(), [...NODE_TYPES].sort(), "Editor-Paletten != NODE_TYPES");
  assert.equal(new Set(inEditor).size, inEditor.length, "a kind is in both palettes");
});

// ── Kinds with their own turn ───────────────────────────────────────────────────────────────────
//
// `TURN_TYPES` (workflows.js, read via `countsAsStep`) says which kind costs one turn of the agent. The step counter of the
// editor ("N steps") computes with the same set — as a bare literal. If it drifts apart, the UI shows a different number than the
// run counts, without anything breaking anywhere. On the server the set exists exactly once.
test("workflow editor: the step counter counts exactly the kinds with their own turn", () => {
  const m = editor.match(/graph\.nodes\.filter\(\(n\) => \[([^\]]*)\]\.includes\(n\.type\)\)\.length/);
  assert.ok(m, "the step counter in WorkflowEditor.tsx can no longer be found — move the anchor");
  const inEditor = m[1].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);
  assert.ok(inEditor.length, "step counter list empty — does the regex still match?");
  const inServer = NODE_TYPES.filter((t) => countsAsStep({ type: t }));
  console.log(`  [turn kinds] server ${inServer.join("/")} · editor ${inEditor.join("/")}`);
  assert.deepEqual([...inEditor].sort(), [...inServer].sort(), "the editor step counter != TURN_TYPES of the server");
});

// ── Tool: fetching blocks from source text ─────────────────────────────────────────────────────
//
// Every anchor is a DECLARATION, not a line number, and every one throws instead of returning an empty set — an empty set
// would silently pass every comparison below.
const sourceOf = (...parts) => fs.readFileSync(path.join(repo, ...parts), "utf8");

// Text INSIDE the bracket on which the anchor ends. Counts brackets and skips strings; this carries nested literals
// (Record<string, string[]>, [String: [String]]).
function bracketBlock(source, anchor, location, what) {
  const m = source.match(anchor);
  assert.ok(m, `${what} not found in ${location} — renamed or reformatted? Move the anchor here, do NOT delete the test.`);
  const i = m.index + m[0].length - 1;
  const on = source[i];
  const to = on === "[" ? "]" : "}";
  let depth = 0;
  let str = null;
  for (let j = i; j < source.length; j++) {
    const c = source[j];
    if (str) {
      if (c === "\\") j++;
      else if (c === str) str = null;
      continue;
    }
    if (c === "/" && source[j + 1] === "/") { j = source.indexOf("\n", j); if (j < 0) break; continue; }
    if (c === "/" && source[j + 1] === "*") { j = source.indexOf("*/", j) + 1; if (j < 1) break; continue; }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if (c === on) depth++;
    else if (c === to && !--depth) return source.slice(i + 1, j);
  }
  assert.fail(`${what} in ${location}: the bracket does not close — check the anchor`);
}
const withoutComments = (text) => text.replace(/^[ \t]*\/\/.*$/gm, "");
// `key: "value"` (TS as well as Swift) in source order.
function pairs(text, location, what) {
  const out = [];
  const re = /(?:^|[,{[\s])"?([A-Za-z_][\w.-]*)"?\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (let m; (m = re.exec(text)); ) out.push([m[1], m[2]]);
  assert.ok(out.length, `${what} in ${location} is empty — does the regex still match?`);
  return out;
}
// `key: ["a", "b"]`.
function listPairs(text, location, what) {
  const out = [];
  const re = /"?([A-Za-z_][\w]*)"?\s*:\s*\[([^\]]*)\]/g;
  for (let m; (m = re.exec(text)); ) out.push([m[1], words(m[2])]);
  assert.ok(out.length, `${what} in ${location} is empty — does the regex still match?`);
  return out;
}
const words = (text) => (text.match(/"((?:[^"\\]|\\.)*)"/g) || []).map((x) => x.slice(1, -1));
function stringList(text, location, what) {
  const out = words(text);
  assert.ok(out.length, `${what} in ${location} is empty — does the regex still match?`);
  return out;
}
// Swift tuple `("id", "Label")` in source order.
function tuple(text, location, what) {
  const out = [];
  const re = /\(\s*"([^"]*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
  for (let m; (m = re.exec(text)); ) out.push([m[1], m[2]]);
  assert.ok(out.length, `${what} in ${location} is empty — does the regex still match?`);
  return out;
}
// Object literals `{ id: "x", label: "y" }` of a TS list, each as a map.
function objList(text, location, what) {
  const out = (text.match(/\{[^{}]*\}/g) || []).map((b) => Object.fromEntries(pairs(b, location, what)));
  assert.ok(out.length, `${what} in ${location} is empty — does the regex still match?`);
  return out;
}
const key = (pp) => pp.map(([k]) => k);

// ── Alias names and modes of the composer ────────────────────────────────────────────────────────
//
// `/model`, `/mode` and `/effort` each have an alias table, and it sits in the CLIENT: a slash command is resolved locally before
// anything goes to the server (even mandatory — whatever reaches the CLI, it executes). Web and iOS both carry it, so whoever adds
// a model shorthand in only one place does not have it on the other device: "/model astra" would run into the search over id and
// label there.
//
// The permission modes additionally have a server truth (`workflows.js:PERMISSION_MODES`) — the set a run may store at all.
test("composer: the alias tables of /model, /mode and /effort are the same on web and iOS, /browser has none", () => {
  const catalog = sourceOf("web", "src", "components", "chat", "ChatCatalog.tsx");
  const slash = sourceOf("mobile", "CbaseMobile", "Chat", "ChatViewModel+Slash.swift");
  const webTab = (anchor, what) => Object.fromEntries(pairs(withoutComments(bracketBlock(catalog, anchor, "ChatCatalog.tsx", what)), "ChatCatalog.tsx", what));
  const iosTab = (anchor, what) => Object.fromEntries(pairs(withoutComments(bracketBlock(slash, anchor, "ChatViewModel+Slash.swift", what)), "ChatViewModel+Slash.swift", what));

  const webModel = webTab(/const MODEL_ALIAS: Record<string, string> = \{/, "MODEL_ALIAS");
  const iosModel = iosTab(/case "model":[\s\S]*?let aliases = \[/, "aliases (/model)");
  // "standard"/"default" means on the web the provider default (empty value); iOS resolves the same two words one line above
  // instead of writing them into the table. So checked separately.
  const wordOnDefault = Object.entries(webModel).filter(([, v]) => v === "").map(([k]) => k).sort();
  assert.deepEqual(wordOnDefault, ["default", "standard"], "MODEL_ALIAS: shorthands other than standard/default point to the provider default");
  assert.ok(/\["standard", "default"\]\.contains\(key\)/.test(slash), "iOS no longer resolves standard/default separately — then they belong in the comparison below.");
  const webReal = Object.fromEntries(Object.entries(webModel).filter(([, v]) => v !== ""));
  assert.deepEqual(iosModel, webReal, "/model: the model shorthands drift apart between web and iOS");
  // The Claude aliases of an agent() in dynamic workflows ("table like /model on the web", dynworkflows/model.js): the same
  // shorthands, the same targets.
  const modelJs = sourceOf("server", "backend", "electron", "server", "dynworkflows", "model.js");
  const wfAliases = Object.fromEntries(pairs(withoutComments(bracketBlock(modelJs, /export const CLAUDE_ALIASES = Object\.freeze\(\{/, "dynworkflows/model.js", "CLAUDE_ALIASES")), "dynworkflows/model.js", "CLAUDE_ALIASES"));
  assert.deepEqual(wfAliases, Object.fromEntries(Object.keys(wfAliases).map((k) => [k, webModel[k]])),
    "agent({ model }): the Claude aliases of dynamic workflows drift apart from /model");

  const webMode = webTab(/const MODE_ALIAS: Record<string, string> = \{/, "MODE_ALIAS");
  const iosMode = iosTab(/case "mode":[\s\S]*?let aliases = \[/, "aliases (/mode)");
  assert.deepEqual(iosMode, webMode, "/mode: the shorthands drift apart between web and iOS");

  // /browser has NO table any more (the browser always runs headless, the command only says how it is) — on neither side,
  // otherwise a device would set a mode again that the server no longer runs.
  assert.doesNotMatch(catalog, /BROWSER_ALIAS/, "web: /browser carries an alias table again");
  const iosBrowser = slash.slice(slash.indexOf('case "browser":'), slash.indexOf('case "model":', slash.indexOf('case "browser":')));
  assert.ok(iosBrowser.length > 0, "iOS: case \"browser\" is no longer before case \"model\" — move the anchor");
  assert.doesNotMatch(iosBrowser, /let aliases = \[/, "iOS: /browser carries an alias table again");

  // /effort: only short forms — every target a level of the order, no shorthand itself a level (otherwise the table would hide
  // it), and `ultracode` stays the mode, no shorthand.
  const webEffort = webTab(/const EFFORT_ALIAS: Record<string, string> = \{/, "EFFORT_ALIAS");
  const iosEffort = iosTab(/case "effort":[\s\S]*?let aliases = \[/, "aliases (/effort)");
  assert.deepEqual(iosEffort, webEffort, "/effort: the short forms drift apart between web and iOS");
  assert.deepEqual(Object.values(webEffort).filter((z) => !EFFORT_LEVELS.includes(z)), [], "EFFORT_ALIAS points to a level the server does not know");
  assert.deepEqual(Object.keys(webEffort).filter((k) => EFFORT_LEVELS.includes(k) || k === "ultracode"), [], "EFFORT_ALIAS hides a level or the mode");

  console.log(`  [composer aliases] /model ${Object.keys(webReal).length} + 2 on default · /mode ${Object.keys(webMode).length} · /browser none · /effort ${Object.keys(webEffort).length}`);
  // Every target of a mode shorthand must be a mode the server knows.
  const targets = [...new Set(Object.values(webMode))];
  assert.deepEqual(targets.filter((z) => !PERMISSION_MODES.includes(z)), [], "MODE_ALIAS points to a mode the server does not know");
});

// ── Fallback of the default model ─────────────────────────────────────────────────────────────
//
// As long as `/api/providers` is not loaded yet, the composer shows the web fallback (`ChatCatalog.tsx`
// DEFAULT_MODEL_FALLBACK); what runs is that of the server (`providers/index.js`) — bound so that the next jump does not hit only
// one of the two places.
test("default model: the web fallback is that of the server", () => {
  const catalog = sourceOf("web", "src", "components", "chat", "ChatCatalog.tsx");
  const web = Object.fromEntries(pairs(withoutComments(bracketBlock(catalog, /const DEFAULT_MODEL_FALLBACK: Record<string, string> = \{/, "ChatCatalog.tsx", "DEFAULT_MODEL_FALLBACK")), "ChatCatalog.tsx", "DEFAULT_MODEL_FALLBACK"));
  assert.deepEqual(web, { ...DEFAULT_MODEL_FALLBACK_SERVER }, "DEFAULT_MODEL_FALLBACK: web and server name different fallbacks");
  console.log(`  [default model] fallback ${Object.entries(web).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
});

// The same four permissions stand in several pickers: the mode picker of the composer, its iOS counterpart in `/mode` without
// argument, and the run settings of a workflow (web and iOS). The workflow ones additionally carry "As in chat" (empty id) —
// that is no mode but its absence.
test("permission modes: all pickers show the four modes of the server", () => {
  const catalog = sourceOf("web", "src", "components", "chat", "ChatCatalog.tsx");
  const slash = sourceOf("mobile", "CbaseMobile", "Chat", "ChatViewModel+Slash.swift");
  // The iOS list is `PermissionsOptions` and sits with the run settings of a workflow.
  const proposal = sourceOf("mobile", "CbaseMobile", "Workflows", "WorkflowSettings.swift");
  const wfSettings = sourceOf("web", "src", "components", "workflow", "WorkflowSettings.tsx");
  // A second permission picker in the editor would be unbound — the move must not leave a copy behind.
  assert.ok(!/const PERM_OPTIONS\b/.test(editor), "WorkflowEditor.tsx carries its own PERM_OPTIONS again — the picker is in the modal WorkflowSettings.tsx");

  const composer = objList(
    bracketBlock(catalog, /const PERM_MODES: \{ id: string; label: string; hint: string; codexHint\?: string \}\[\] = \[/, "ChatCatalog.tsx", "PERM_MODES"),
    "ChatCatalog.tsx", "PERM_MODES",
  ).map((x) => [x.id, x.label]);
  const composerIos = pairs(
    bracketBlock(slash, /case "mode":[\s\S]*?let labels = \[/, "ChatViewModel+Slash.swift", "labels (/mode)"),
    "ChatViewModel+Slash.swift", "labels (/mode)",
  );
  assert.deepEqual(composerIos.map(([k]) => k).sort(), composer.map(([k]) => k).sort(), "the composer mode picker and the iOS list name different modes");
  assert.deepEqual(Object.fromEntries(composerIos), Object.fromEntries(composer), "composer modes: web and iOS label differently");
  assert.deepEqual(composer.map(([id]) => id).sort(), [...PERMISSION_MODES].sort(), "the composer mode picker != PERMISSION_MODES");

  // The form pickers with "As in chat". The model is the picker of the workflow run settings.
  const withEmpty = [
    // In the modal WorkflowSettings.tsx (tab "Execution"), not in the editor.
    ["WorkflowSettings.tsx", objList(bracketBlock(wfSettings, /const PERM_OPTIONS: \{ id: WorkflowRunSettings\["permissionMode"\]; label: string \}\[\] = \[/, "WorkflowSettings.tsx", "PERM_OPTIONS"), "WorkflowSettings.tsx", "PERM_OPTIONS").map((x) => [x.id, x.label])],
    ["WorkflowSettings.swift (PermissionsOptions)", tuple(bracketBlock(proposal, /enum PermissionsOptions \{\s*static let permissions: \[\(id: String, label: String\)\] = \[/, "WorkflowSettings.swift", "PermissionsOptions.permissions"), "WorkflowSettings.swift", "PermissionsOptions.permissions")],
  ];
  const [, baseline] = withEmpty[0];
  for (const [location, list] of withEmpty) {
    assert.deepEqual(list, baseline, `the permission picker in ${location} deviates from that in WorkflowSettings.tsx`);
    assert.deepEqual(list.map(([id]) => id).filter(Boolean).sort(), [...PERMISSION_MODES].sort(), `the permission picker in ${location} != PERMISSION_MODES`);
    assert.equal(list[0][0], "", `the permission picker in ${location} does not start with "As in chat" (empty id)`);
  }
  console.log(`  [permissions] server ${PERMISSION_MODES.length} modes · composer picker 2 versions · forms ${withEmpty.length} versions with "As in chat"`);
});

// The browser visibility per chat is gone (it always stays headless): no picker in the composer, no alias table, and the server runs
// every chat headless (toolchain/playwright.js).
test("browser: no mode any more — no picker, no table, the server always runs headless", () => {
  const catalog = sourceOf("web", "src", "components", "chat", "ChatCatalog.tsx");
  assert.doesNotMatch(catalog, /BROWSER_MODES|BROWSER_ALIAS/, "ChatCatalog.tsx carries browser modes again");
  const pw = sourceOf("server", "backend", "electron", "server", "toolchain", "playwright.js");
  assert.match(pw, /const playwrightHeadless = \(\) => true;/, "the server no longer always runs headless");
  assert.match(pw, /const resolveChatHeadless = \(_chat\) => playwrightHeadless\(\);/, "a chat can run visibly again");
});

// The language sample of the settings. Both clients show on the language page, per card, ONE real sentence from the UI, once in
// German and once in English — the user sees what they get instead of reading it. The sentence stands as a literal in BOTH
// clients (it is the sample itself, not a label; a route for it would be the intermediate layer that is merely cheaper). If one of
// the two drifts away, web and iOS show different samples — and nothing would be red. The sentence must also be in both
// dictionaries, otherwise the English card shows German text.
test("language sample: web and iOS show the same sentence, and it is in both dictionaries", () => {
  const web = sourceOf("web", "src", "components", "settings", "LanguageSettings.tsx");
  const ios = sourceOf("mobile", "CbaseMobile", "Settings", "LanguageSettings.swift");
  const mWeb = web.match(/^const EXAMPLE = "([^"]+)";$/m);
  assert.ok(mWeb, "the declaration of EXAMPLE is in LanguageSettings.tsx — renamed? Move the anchor, do not delete the test");
  const mIos = ios.match(/^private let languageProbe = "([^"]+)"$/m);
  assert.ok(mIos, "the declaration of languageProbe is in LanguageSettings.swift — renamed? Move the anchor, do not delete the test");
  assert.equal(mIos[1], mWeb[1], "web and iOS show different language samples");

  // The sentence is looked up on the web via i18n-de.ts, on mobile via LocDE (which assembles the three tables) — a failure here
  // means: the English card shows German text.
  const set = mWeb[1];
  const enWeb = sourceOf("web", "src", "lib", "i18n-de.ts");
  assert.ok(enWeb.includes(`"${set}"`), `the language sample is missing in i18n-de.ts: "${set}"`);
  const enIos = ["LocDE.swift", "LocDEBase.swift", "LocDEMobile.swift"]
    .map((d) => sourceOf("mobile", "CbaseMobile", "Kit", d))
    .join("\n");
  assert.ok(enIos.includes(`"${set}"`), `the language sample is missing in the mobile dictionaries: "${set}"`);
  console.log(`  [language sample] "${set}" — web == iOS, in both dictionaries`);
});

// The library of dynamic workflows. A stored workflow is called via `/name`; if it carries the name of a local slash command,
// `/name` would run the OTHER command. The server rejects such names on saving — from a copy (`LOCAL_SLASH_COMMANDS` in
// dynworkflows/names.js), because it cannot reach the clients' tables. This copy is bound here to BOTH tables: web
// `SLASH_COMMANDS` (ChatCatalog.tsx), iOS `slashCatalog` (ChatViewModel+Slash.swift). If a client gains a command, this test is
// red until the server reserves it as well.
test("library: the reserved names of the server are exactly the slash commands of web and iOS (plus `workflows`)", async () => {
  const { LOCAL_SLASH_COMMANDS, CLI_COMMANDS, RESERVED_NAMES } = await import("../../server/backend/electron/server/dynworkflows/names.js");
  const catalog = sourceOf("web", "src", "components", "chat", "ChatCatalog.tsx");
  const board = bracketBlock(catalog, /const SLASH_COMMANDS: SlashCommand\[\] = \[/, "ChatCatalog.tsx", "SLASH_COMMANDS");
  const web = [...withoutComments(board).matchAll(/\{ name: "([a-z]+)"/g)].map((m) => m[1]);
  const slash = sourceOf("mobile", "CbaseMobile", "Chat", "ChatViewModel+Slash.swift");
  const iosBlock = bracketBlock(slash, /var slashCatalog: \[SlashCommand\] \{[\s\S]*?return \[/, "ChatViewModel+Slash.swift", "slashCatalog");
  const ios = [...withoutComments(iosBlock).matchAll(/SlashCommand\(name: "([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(web.length >= 5 && ios.length >= 5, `the tables were read empty (web ${web.length}, iOS ${ios.length}) — does the anchor still match?`);
  assert.deepEqual([...LOCAL_SLASH_COMMANDS].sort(), [...web].sort(), "server copy != web SLASH_COMMANDS");
  assert.deepEqual([...LOCAL_SLASH_COMMANDS].sort(), [...ios].sort(), "server copy != iOS slashCatalog");
  assert.deepEqual([...RESERVED_NAMES], [...LOCAL_SLASH_COMMANDS, ...CLI_COMMANDS]);
  assert.ok(CLI_COMMANDS.includes("workflows"), "the same-named CLI command is not reserved");
  console.log(`  [library] ${LOCAL_SLASH_COMMANDS.length} local commands — server == web == iOS, plus ${CLI_COMMANDS.join(", ")}`);
});

// ── Channel: system kinds and wait reason ──
// A channel system note carries a kind (`systemKind`) that web (`SYSTEM_MARKERS` in ChannelCard.tsx) and iOS
// (`ChannelCard.systemMarker` in Chat/ChannelPane.swift) translate into a marker — an unknown kind silently becomes
// "System message" ("archived" was known to nobody). The server does not keep the kinds as a list but writes them at the call
// sites; so it is read FROM THE SOURCES (`systemKind: "x"`, `channelSystemNote(…, "x"`). Both markers pass as a VARIABLE through
// t()/L() — no translation audit sees them; this test checks the English version. COUNTER-TEST (shown red): ChannelCard.tsx or
// ChannelPane.swift from before the markers were bound.
function serverSources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) serverSources(p, out);
    else if (e.name.endsWith(".js")) out.push(fs.readFileSync(p, "utf8"));
  }
  return out;
}
const englishIos = () => fs.readdirSync(path.join(repo, "mobile", "CbaseMobile", "Kit"))
  .filter((d) => /^LocDE.*\.swift$/.test(d)).map((d) => sourceOf("mobile", "CbaseMobile", "Kit", d)).join("\n");

test("channel system kinds: every kind the server writes has the same marker on web and iOS, and the marker is translated", () => {
  const server = new Set();
  for (const text of serverSources(path.join(repo, "server", "backend", "electron", "server"))) {
    for (const m of text.matchAll(/systemKind:\s*"([a-z_]+)"/g)) server.add(m[1]);
    for (const m of text.matchAll(/channelSystemNote\([^"\n]*?,\s*"([a-z_]+)"/g)) server.add(m[1]);
  }
  // The reader itself: it must find the kinds that certainly exist — otherwise it checks nothing. (`hook_ask`, `hook_end` and
  // `rejected` are no longer written by the server; web and iOS keep their markers for stored rows.)
  for (const kind of ["cap", "pause", "resumed", "closed", "archived"]) {
    assert.ok(server.has(kind), `the system kind "${kind}" was not found in the server sources — does the reader still match?`);
  }
  const card = sourceOf("web", "src", "components", "ChannelCard.tsx");
  const from = card.indexOf("const SYSTEM_MARKERS");
  const board = card.slice(from, card.indexOf("};", from));
  const web = Object.fromEntries([...withoutComments(board).matchAll(/^\s*([a-z_]+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  const pane = sourceOf("mobile", "CbaseMobile", "Chat", "ChannelPane.swift");
  const ofS = pane.indexOf("static func systemMarker");
  const swift = pane.slice(ofS, pane.indexOf("default:", ofS));
  const ios = Object.fromEntries([...swift.matchAll(/case "([a-z_]+)": return "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  assert.ok(Object.keys(web).length >= 7 && Object.keys(ios).length >= 7, `the tables were read empty (web ${Object.keys(web).length}, iOS ${Object.keys(ios).length})`);
  for (const kind of server) {
    assert.ok(web[kind], `web SYSTEM_MARKERS does not know the system kind "${kind}" — it would be "System message"`);
    assert.ok(ios[kind], `iOS systemMarker does not know the system kind "${kind}" — it would be "System message"`);
  }
  assert.deepEqual(ios, web, "web and iOS translate the system kinds differently");
  const enWeb = sourceOf("web", "src", "lib", "i18n-de.ts");
  const enIos = englishIos();
  for (const marker of [...Object.values(web), "System message"]) {
    assert.ok(enWeb.includes(`"${marker}":`), `i18n-de.ts: "${marker}" missing`);
    assert.ok(enIos.includes(`"${marker}":`), `LocDE*.swift: "${marker}" missing`);
  }
  console.log(`  [channel system kinds] server ${server.size} ⊆ web == iOS (${Object.keys(web).length}), translated`);
});

// The wait reason at "{n} waiting": web `channelWaitReason` (lib/channel-card.ts, behavior checked in reducer.test.mjs) and iOS
// `ChannelParticipant.waitReason` name the same reasons in the same order.
// COUNTER-TEST (shown red): ChannelPane.swift without `waitReason`.
test("channel wait reason: web and iOS name the same reasons in the same order, translated", () => {
  const lib = sourceOf("web", "src", "lib", "channel-card.ts");
  const ofW = lib.indexOf("export function channelWaitReason");
  assert.ok(ofW >= 0, "channelWaitReason missing in lib/channel-card.ts");
  const web = [...lib.slice(ofW, lib.indexOf("\n}\n", ofW)).matchAll(/return "([^"]+)"/g)].map((m) => m[1]);
  const pane = sourceOf("mobile", "CbaseMobile", "Chat", "ChannelPane.swift");
  const ofI = pane.indexOf("var waitReason: String {");
  assert.ok(ofI >= 0, "ChannelParticipant.waitReason missing in Chat/ChannelPane.swift");
  const ios = [...pane.slice(ofI, pane.indexOf("\n    }\n", ofI)).matchAll(/return "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(web.length, 5, `five reasons expected, read: ${web.length}`);
  assert.deepEqual(ios, web);
  const enWeb = sourceOf("web", "src", "lib", "i18n-de.ts");
  const enIos = englishIos();
  for (const reason of web) {
    assert.ok(enWeb.includes(`"${reason}":`), `i18n-de.ts: "${reason}" missing`);
    assert.ok(enIos.includes(`"${reason}":`), `LocDE*.swift: "${reason}" missing`);
  }
});

// The counterpart at the sender ("to {name}") comes ONLY from `recipient.name` of the card — which the server writes for exactly one
// counterpart. The prop `opposite` of ChannelCard was passed by no caller; it was a second, dead path that never replaced "sent".
// COUNTER-TEST (shown red): ChannelCard.tsx with the prop `opposite`.
test("channel card: \"to {name}\" is read by web and iOS from `recipient.name`, there is no prop `opposite`", () => {
  const card = withoutComments(sourceOf("web", "src", "components", "ChannelCard.tsx"));
  assert.ok(!/opposite/.test(card), "ChannelCard no longer carries a prop `opposite`");
  assert.ok(card.includes('card.recipient?.name ? t("to {name}", { name: card.recipient.name }) : t("sent")'), "web: to {name} from recipient.name, otherwise sent");
  const pane = sourceOf("mobile", "CbaseMobile", "Chat", "ChannelPane.swift");
  assert.ok(pane.includes('recipientName = json["recipient"]?["name"]?.stringValue ?? ""'), "iOS reads recipient.name");
  assert.ok(pane.includes('card.recipientName.isEmpty ? L("sent") : L("to {name}", ["name": card.recipientName])'), "iOS: to {name}, otherwise sent");
});
