// Behaviour gate for the slash switch. The contract test in composer-contract.test.mjs counts NAMES (panel == branches,
// map == type); a skeptic got two body sabotages past it AND past tsc: `pickPerm` -> `pickBrowser` in the /mode branch (all
// 21 names stay in the body, same signature), and `/effort auto` -> `pickEffort("auto")` instead of `pickEffort("")`.
// Only the slash-picker probe (not in the gate) would see it. The switch is a PURE function `runSlash(text, attachments, h)`
// — exactly the form that can run without a browser: a handler map that logs every call, and a swap matrix (per setting
// command exactly ONE picker with the resolved id).
// Loading as in reducer.test.mjs (tsc --noCheck into a folder under web/node_modules so react/jsx-runtime resolves for
// ChatCatalog/ChatIcons); `@/` imports are rewritten to relative paths, `@/lib/api` to a stub. `src/lib/effort.ts` runs
// along: `/effort` checks against the levels of the CURRENT model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".slash-test-"));
let mod;
try {
  execFileSync(process.execPath, [
    tsc,
    path.join(webDir, "src", "components", "chat", "chatSlash.ts"),
    path.join(webDir, "src", "components", "chat", "ChatCatalog.tsx"),
    path.join(webDir, "src", "components", "chat", "ChatIcons.tsx"),
    path.join(webDir, "src", "lib", "slash.ts"),
    path.join(webDir, "src", "lib", "effort.ts"),
    "--outDir", out, "--rootDir", path.join(webDir, "src"), "--module", "es2022", "--target", "es2022",
    "--moduleResolution", "bundler", "--jsx", "react-jsx", "--noCheck", "--isolatedModules", "--skipLibCheck",
  ], { cwd: webDir, stdio: "pipe" });
  // Stub for @/lib/api: `api` logs and answers from a table, API_BASE is empty.
  fs.mkdirSync(path.join(out, "lib"), { recursive: true });
  fs.writeFileSync(path.join(out, "lib", "api.js"), `export const API_BASE = "";\nexport async function api(apiPath, init) { return globalThis.__slashApi(apiPath, init); }\n`);
  // `@/…` -> relative (tsc does not rewrite paths)
  const rewrite = (file, depth) => {
    let s = fs.readFileSync(file, "utf8");
    s = s.replace(/from "@\/lib\/api"/g, `from "${depth}lib/api.js"`).replace(/from "@\/lib\/slash"/g, `from "${depth}lib/slash.js"`).replace(/from "@\/lib\/effort"/g, `from "${depth}lib/effort.js"`)
      .replace(/from "@\/components\/chat\/ChatCatalog"/g, `from "./ChatCatalog.js"`).replace(/from "@\/components\/chat\/ChatIcons"/g, `from "./ChatIcons.js"`);
    fs.writeFileSync(file, s);
  };
  for (const f of ["chatSlash.js", "ChatCatalog.js", "ChatIcons.js"]) rewrite(path.join(out, "components", "chat", f), "../../");
  mod = await import(pathToFileURL(path.join(out, "components", "chat", "chatSlash.js")).href);
} finally {
  try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { console.warn("cleanup:", e.message); }
}
const { runSlash } = mod;

// The models of both providers. `efforts` (the MEASURED levels) stand ONLY in this list — it is `allProviders`, the catalogue
// of ALL providers. `pickerProviders` (only the connected ones, source of /model) gets the same models WITHOUT `efforts`: if the
// /effort branch reads from there, it silently falls back to the five default levels — and then the tests below turn red
// instead of green.
const MODELS = {
  claude: [{ id: "", label: "Default" }, { id: "claude-sonnet-5", label: "Sonnet 5" }, { id: "claude-opus-5", label: "Opus 5" }],
  // gpt-5.5: no max (measured HTTP 400). Sol carries it.
  codex: [{ id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"] }, { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["low", "medium", "high", "xhigh", "max"] }],
};
const withoutLevels = (models) => models.map(({ efforts, ...rest }) => rest); // eslint-disable-line no-unused-vars

// A handler map that logs every call. `goal`/`activeId` can be set per case.
// `connected`: which providers the model picker sees — `allProviders` always carries both.
function fake({ goal = "", goalPaused = false, activeId = "c1", outcome = "applied", provider = "claude", model = "claude-sonnet-5", connected = ["claude", "codex"], ultracode = false } = {}) {
  const calls = [];
  const h = {
    t: (key, params) => key + (params ? " " + JSON.stringify(params) : ""),
    pushInfo: (title, body) => { calls.push(["pushInfo", title, body]); },
    showCost: () => { calls.push(["showCost"]); },
    clearContext: async () => { calls.push(["clearContext"]); },
    goal,
    goalPaused,
    clearGoal: async () => { calls.push(["clearGoal"]); },
    activeIdRef: { current: activeId },
    ensureChat: async () => { calls.push(["ensureChat"]); return "new1"; },
    setGoal: (z) => { calls.push(["setGoal", z]); },
    loadList: async () => { calls.push(["loadList"]); },
    compact: async (instruction) => { calls.push(["compact", instruction]); },
    pickerProviders: [
      { id: "claude", label: "Claude", models: withoutLevels(MODELS.claude) },
      { id: "codex", label: "Codex", models: withoutLevels(MODELS.codex) },
    ].filter((pv) => connected.includes(pv.id)),
    currentModelLabel: "Sonnet 5", currentProvider: provider,
    pickModel: async (p, id) => { calls.push(["pickModel", p, id]); return outcome; },
    effectiveModel: model,
    allProviders: [
      { id: "claude", label: "Claude", models: MODELS.claude },
      { id: "codex", label: "Codex", models: MODELS.codex },
    ],
    currentEffortLabel: "Effort: high",
    ultracode,
    setUltracode: async (on) => { calls.push(["setUltracode", on]); },
    pickEffort: async (id) => { calls.push(["pickEffort", id]); },
    currentPermLabel: "Full", pickPerm: async (id) => { calls.push(["pickPerm", id]); },
  };
  return { h, calls, names: () => calls.map((c) => c[0]) };
}
const apiCalls = [];
globalThis.__slashApi = async (filePath, init) => { apiCalls.push([filePath, init?.method ?? "GET", init?.body ?? null]); if (/\/attachments\//.test(filePath)) return "PASTED TEXT"; return {}; };
const PICKER = ["pickModel", "pickEffort", "pickPerm", "setUltracode"];

test("runSlash: no command — false, no handler runs", async () => {
  for (const text of ["hello", "/Users/maintainer/x", "/xyz foo", "/goa", "", " /goal x"]) {
    const { h, calls } = fake();
    assert.equal(await runSlash(text, [], h), false, `"${text}" is no command`);
    assert.deepEqual(calls, [], `"${text}" calls nothing`);
  }
});

test("runSlash: every setting command calls EXACTLY its handler with the resolved id — swap matrix", async () => {
  // [text, expected handler, expected arguments, info title afterwards]
  const cases = [
    ["/mode plan", "pickPerm", ["plan"], "Mode set"],
    ["/mode voll", "pickPerm", ["bypassPermissions"], "Mode set"],
    ["/mode fragen", "pickPerm", ["default"], "Mode set"],
    ["/effort high", "pickEffort", ["high"], "Effort set"],
    ["/effort XHigh", "pickEffort", ["xhigh"], "Effort set"],
    ["/effort ultracode", "setUltracode", [true], "Effort"], // flips the SWITCH, the level stays
    ["/effort UltraCode", "setUltracode", [true], "Effort"],
    // Short forms from the bound table (ChatCatalog.tsx EFFORT_ALIAS <-> iOS, list binding).
    ["/effort mid", "pickEffort", ["medium"], "Effort set"],
    ["/effort med", "pickEffort", ["medium"], "Effort set"],
    ["/effort x-high", "pickEffort", ["xhigh"], "Effort set"],
    ["/effort X-High", "pickEffort", ["xhigh"], "Effort set"],
    // `sonnet`/`haiku` point to the 5.5 models like the CLI aliases; `sonnet5` stays Sonnet 5.
    ["/model sonnet", "pickModel", ["claude", "claude-sonnet-5-5"], "Model set"], // Alias
    ["/model sonnet5", "pickModel", ["claude", "claude-sonnet-5"], "Model set"],
    ["/model haiku", "pickModel", ["claude", "claude-haiku-5-5"], "Model set"],
    ["/model haiku4.5", "pickModel", ["claude", "claude-haiku-4-5-20251001"], "Model set"],
    ["/model Opus 5", "pickModel", ["claude", "claude-opus-5"], "Model set"], // label, spaces do not matter
    // `opus` points to Opus 5.5 like the CLI alias; `opus5` stays Opus 5.
    ["/model opus", "pickModel", ["claude", "claude-opus-5-5"], "Model set"],
    ["/model opus5.5", "pickModel", ["claude", "claude-opus-5-5"], "Model set"],
    ["/model opus4.8", "pickModel", ["claude", "claude-opus-4-8"], "Model set"],
    ["/model gpt-5.6-sol", "pickModel", ["codex", "gpt-5.6-sol"], "Model set"], // another provider
    ["/model standard", "pickModel", ["claude", ""], "Model set"],
    ["/MODE plan", "pickPerm", ["plan"], "Mode set"], // the command is case-insensitive
  ];
  for (const [text, handler, args, title] of cases) {
    const { h, calls, names } = fake();
    assert.equal(await runSlash(text, [], h), true, `"${text}" handled locally`);
    const picks = calls.filter((c) => PICKER.includes(c[0]));
    assert.deepEqual(picks, [[handler, ...args]], `"${text}" calls exactly ${handler}(${args.map((a) => JSON.stringify(a)).join(", ")}) — and no other picker`);
    assert.deepEqual(names().filter((n) => n === "pushInfo").length, 1, `"${text}": one info afterwards`);
    assert.equal(calls.find((c) => c[0] === "pushInfo")[1], title, `"${text}": info title`);
    assert.ok(!names().some((n) => ["clearContext", "clearGoal", "compact", "showCost", "setGoal"].includes(n)), `"${text}" calls no foreign handler`);
  }
});

// "Auto" is gone. `/effort auto` used to be `pickEffort("")` — the chat went back to "no level". Now it is a word like any
// other outside the list: "Unknown", no picker, and the list no longer names "auto". Counter-test: with the old branch
// (`key !== "auto" && …`) the case calls `pickEffort("")` and the display invites "auto" — both checks red.
test("runSlash: /effort auto reports \"Unknown\" and sets nothing; no display offers \"auto\"", async () => {
  for (const text of ["/effort auto", "/effort Auto", "/effort"]) {
    const { h, calls, names } = fake();
    assert.equal(await runSlash(text, [], h), true, `"${text}" handled locally — the CLI never sees the word`);
    assert.deepEqual(names(), ["pushInfo"], `"${text}": only an info, no picker`);
    // The fake `t` appends the parameters as JSON to the key.
    const info = String(calls[0][2] ?? "");
    const seam = info.lastIndexOf(' {"');
    const template = info.slice(0, seam);
    const params = JSON.parse(info.slice(seam + 1));
    if (text !== "/effort") {
      assert.match(template, /^Unknown: /, `"${text}": Unknown`);
      assert.equal(params.arg.toLowerCase(), "auto");
    }
    assert.ok(!/auto/i.test(template), `"${text}": the template no longer names "auto": ${template}`);
    assert.ok(!/auto/i.test(params.listValue), `"${text}": the list no longer names "auto": ${params.listValue}`);
  }
});

test("runSlash: unknown argument — info, NO picker; without argument — display, NO picker", async () => {
  for (const [text, title] of [["/mode xyz", "Mode"], ["/browser xyz", "Browser"], ["/browser visible", "Browser"], ["/browser background", "Browser"], ["/effort xyz", "Effort"], ["/effort auto", "Effort"], ["/model doesnotexist", "Model"], ["/mode", "Mode"], ["/browser", "Browser"], ["/effort", "Effort"], ["/model", "Model"]]) {
    const { h, calls, names } = fake();
    assert.equal(await runSlash(text, [], h), true, `"${text}" handled locally`);
    assert.ok(!names().some((n) => PICKER.includes(n)), `"${text}" calls no picker (${names()})`);
    assert.deepEqual(names(), ["pushInfo"], `"${text}": exactly one info`);
    assert.equal(calls[0][1], title, `"${text}": title ${title}`);
  }
});

// ── /effort checks against the levels of the CURRENT model ──────────────────────────────────────
//
// A fixed list of five used to stand in the branch — it offered "max" on gpt-5.5 (measured HTTP 400, the turn is lost
// before it begins). The list now comes from `efforts` on the model (allProviders -> lib/effort.ts). Counter-test: with
// the old fixed list "/effort max" on gpt-5.5 is a picker call again — the test fails.
test("runSlash: /effort takes only the levels of the model — max drops out on gpt-5.5", async () => {
  // Catalogue model WITHOUT max: the command runs into nothing instead of ordering a 400.
  { const { h, calls, names } = fake({ provider: "codex", model: "gpt-5.5" });
    assert.equal(await runSlash("/effort max", [], h), true);
    assert.ok(!names().includes("pickEffort"), "\"/effort max\" sets nothing on gpt-5.5");
    assert.equal(calls[0][1], "Effort", "an info instead");
    assert.match(calls[0][2], /"list":"low, medium, high, xhigh"\}$/, "the info names the levels of THIS model — without max"); }
  // The same command on a model that carries max.
  { const { h, calls } = fake({ provider: "codex", model: "gpt-5.6-sol" });
    assert.equal(await runSlash("/effort max", [], h), true);
    assert.deepEqual(calls.filter((c) => PICKER.includes(c[0])), [["pickEffort", "max"]], "on Sol max goes through"); }
  // A model WITHOUT catalogue entry (Claude) keeps the five default levels — and does not know ultra.
  { const { h, calls, names } = fake();
    assert.equal(await runSlash("/effort max", [], h), true);
    assert.deepEqual(calls.filter((c) => PICKER.includes(c[0])), [["pickEffort", "max"]], "without catalogue entry max stays"); }
  { const { h, calls, names } = fake();
    assert.equal(await runSlash("/effort ultra", [], h), true);
    assert.ok(!names().includes("pickEffort"), "without catalogue entry ultra is unknown");
    assert.match(calls[0][2], /low, medium, high, xhigh, max/, "the info names the five default levels"); }
});

// ── The levels hang on the MODEL, not on the login and not on an empty chat choice ──
//
// Two cases that silently fell back to the five default levels — both measured:
//   • The provider reports `connected:false`. The model picker rightly does not show it; its levels still apply. If /effort
//     read from the filtered list, the new choice was PERMANENTLY the old one for that user.
//   • The chat carries no model of its own ('' = new chat or old chat). '' stands in no catalogue — the most common case
//     never had the levels of its model. Hence the switch receives the EFFECTIVE model and does not resolve it itself.
test("runSlash: /effort takes the levels also for a disconnected provider — the list is allProviders, not the picker", async () => {
  // Codex is NOT connected: pickerProviders knows only Claude, allProviders both.
  // The level that DISTINGUISHES the lists is max: the default levels carry it, gpt-5.5 does not. If the branch read the
  // filtered list, "/effort max" would go through.
  { const { h, calls } = fake({ provider: "codex", model: "gpt-5.5", connected: ["claude"] });
    assert.equal(await runSlash("/effort xhigh", [], h), true);
    assert.deepEqual(calls.filter((c) => PICKER.includes(c[0])), [["pickEffort", "xhigh"]], "xhigh goes through although codex is logged out"); }
  { const { h, calls, names } = fake({ provider: "codex", model: "gpt-5.5", connected: ["claude"] });
    assert.equal(await runSlash("/effort max", [], h), true);
    assert.ok(!names().includes("pickEffort"), "max stays blocked even with codex logged out");
    assert.match(calls[0][2], /"list":"low, medium, high, xhigh"\}$/, "the info names the levels of THIS model — without max"); }
});

// ── The sixth level is gone, none/minimal never existed ─────────────────────────────────────────
// "/effort ultra" used to be a picker call on every Codex model. Now NO model knows the level, and Codex' lower steps
// `none`/`minimal` are offered by no list: all three are "Unknown" everywhere and set nothing — on catalogue models as in
// the fallback without catalogue entry.
test("runSlash: /effort ultra, none and minimal are \"Unknown\" on every model", async () => {
  for (const location of [{ provider: "codex", model: "gpt-5.5" }, { provider: "codex", model: "gpt-5.6-sol" }, {}]) {
    for (const word of ["ultra", "none", "minimal"]) {
      const { h, calls, names } = fake(location);
      assert.equal(await runSlash(`/effort ${word}`, [], h), true);
      assert.ok(!names().includes("pickEffort"), `"/effort ${word}" sets nothing on ${location.model || "Claude"}`);
      // The fake translator appends the parameters as JSON (see `fake`): wording + {arg, list}.
      const text = calls[0][2];
      assert.ok(text.startsWith("Unknown: \"{arg}\"."), `"/effort ${word}" reports "Unknown"`);
      const params = JSON.parse(text.slice(text.lastIndexOf(" {") + 1));
      assert.equal(params.arg, word);
      for (const gone of ["ultra", "none", "minimal"]) assert.ok(!params.list.split(", ").includes(gone), `the named list carries "${gone}"`);
    }
  }
});

test("runSlash: /effort computes with the EFFECTIVE model — ChatPane resolves '' beforehand", async () => {
  // What ChatPane passes is never '' (effectiveModel = currentModel || providerDefault): with default model gpt-5.5 it is
  // gpt-5.5 that arrives here, and "max" is blocked there.
  { const { h, calls, names } = fake({ provider: "codex", model: "gpt-5.5" });
    assert.equal(await runSlash("/effort max", [], h), true);
    assert.ok(!names().includes("pickEffort"), "max drops out even if the chat chose no model of its own");
    assert.equal(calls[0][1], "Effort"); }
  // The counter-proof to the repair: a raw '' knows no catalogue model and would get the five default levels — then "max"
  // would go through. That was the bug.
  { const { h, calls } = fake({ provider: "codex", model: "" });
    assert.equal(await runSlash("/effort max", [], h), true);
    assert.deepEqual(calls.filter((c) => PICKER.includes(c[0])), [["pickEffort", "max"]], "a raw '' would fall back to the default levels — hence ChatPane resolves"); }
});

test("runSlash: /model on \"deferred\" does NOT report \"Model set\" (the warning modal takes over)", async () => {
  const { h, calls } = fake({ outcome: "deferred" });
  assert.equal(await runSlash("/model gpt-5.6-sol", [], h), true);
  assert.deepEqual(calls, [["pickModel", "codex", "gpt-5.6-sol"]], "picker runs, no info");
});

test("runSlash: /cost, /clear, /compact, /help call exactly their handler", async () => {
  { const { h, calls } = fake(); assert.equal(await runSlash("/cost", [], h), true); assert.deepEqual(calls, [["showCost"]]); }
  { const { h, calls } = fake(); assert.equal(await runSlash("/clear", [], h), true); assert.deepEqual(calls, [["clearContext"]]); }
  { const { h, calls } = fake(); assert.equal(await runSlash("/compact", [], h), true); assert.deepEqual(calls, [["compact", ""]]); }
  // /compact <instruction> (as in the model, Claude Code: customInstructions) — the instruction goes to the handler.
  { const { h, calls } = fake(); assert.equal(await runSlash("/compact  Only the tests ", [], h), true); assert.deepEqual(calls, [["compact", "Only the tests"]]); }
  { const { h, calls } = fake({ activeId: null }); assert.equal(await runSlash("/compact", [], h), true); assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["pushInfo", "Note"]], "without an open chat: note instead of compact"); }
  { const { h, calls } = fake(); assert.equal(await runSlash("/help", [], h), true); assert.equal(calls.length, 1); assert.equal(calls[0][1], "Commands");
    for (const b of ["goal", "compact", "clear", "model", "effort", "mode", "browser", "cost", "help"]) assert.ok(calls[0][2].includes(`**/${b}**`), `/help names /${b}`); }
});

test("runSlash: /goal — set (PATCH + setGoal + loadList + {send, display}), show, remove, fold in a pasted text", async () => {
  { apiCalls.length = 0; const { h, calls } = fake();
    assert.deepEqual(await runSlash("/goal  All green ", [], h), { send: "All green", display: "/goal  All green" }, "return: send = argument, display = input trimmed");
    assert.deepEqual(apiCalls, [["/api/chats/c1", "PATCH", JSON.stringify({ goal: "All green" })]], "PATCH on the open chat");
    assert.deepEqual(calls, [["setGoal", "All green"], ["loadList"]], "setGoal, then loadList — no ensureChat when a chat is open"); }
  { apiCalls.length = 0; const { h, calls } = fake({ activeId: null });
    await runSlash("/goal New", [], h);
    assert.equal(calls[0][0], "ensureChat", "without an open chat one is created");
    assert.equal(apiCalls[0][0], "/api/chats/new1", "… and the PATCH goes to the new id"); }
  { apiCalls.length = 0; const { h, calls } = fake({ goal: "Old goal" });
    assert.equal(await runSlash("/goal", [], h), true);
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["pushInfo", "Goal"]], "without text: display, no PATCH"); assert.deepEqual(apiCalls, []); }
  // A paused goal says so — a running one does not.
  { const { h, calls } = fake({ goal: "Old goal", goalPaused: true }); await runSlash("/goal", [], h);
    assert.match(calls[0][2], /^Current goal of this chat \(paused\):/, "paused: the display names the pause");
    assert.ok(calls[0][2].includes("Old goal")); }
  { const { h, calls } = fake({ goal: "Old goal" }); await runSlash("/goal", [], h);
    assert.ok(!calls[0][2].includes("paused"), "not paused: no word of it"); }
  { const { h, calls } = fake({ goal: "" }); await runSlash("/goal clear", [], h); assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["pushInfo", "Goal"]], "clear without goal: note, no clearGoal"); }
  { const { h, calls } = fake({ goal: "x" }); await runSlash("/goal löschen", [], h); assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["clearGoal"], ["pushInfo", "Goal cleared"]], "delete with goal: clearGoal, then info"); }
  { apiCalls.length = 0; const { h, calls } = fake();
    const r = await runSlash("/goal Head", [{ name: "pasted-text-ab12.txt", file: "pasted-text-ab12.txt" }, { name: "image.png", file: "image.png" }], h);
    assert.deepEqual(r, { send: "Head", display: "/goal Head" });
    assert.deepEqual(apiCalls.map((a) => a[0]), ["/api/chats/c1/attachments/pasted-text-ab12.txt", "/api/chats/c1"], "only the insertion is fetched, not the image");
    assert.equal(JSON.parse(apiCalls[1][2]).goal, "Head\n\nPASTED TEXT", "the insertion is folded into the goal");
    assert.deepEqual(calls[0], ["setGoal", "Head\n\nPASTED TEXT"]); }
});

// ── Ultracode is a switch, and `/effort ultracode` ends LOCALLY (independent of the level) ──
//
// The CLI knows `--effort ultracode` and would run its own mode if the word reached it — a known slash that gets through is
// the `/goal` case. Hence: the switch ends `/effort ultracode` with `true` (never `{send}`), also with an attachment and
// also on a model without levels, and flips ONLY the switch — no `pickEffort`. A level leaves the switch alone.
// Counter-test: `setUltracode(!ultracode)` replaced by `pickEffort(ULTRACODE)` (the old branch) => this test red.
test("runSlash: /effort ultracode flips the switch locally — also with attachment and without levels; a level leaves it alone", async () => {
  const attachment = [{ name: "pasted-text-ab12.txt", file: "pasted-text-ab12.txt" }, { name: "image.png", file: "image.png" }];
  for (const [provider, model] of [["claude", "claude-opus-5"], ["codex", "gpt-5.5"]]) {
    for (const attach of [[], attachment]) {
      for (const ultracode of [false, true]) {
        const prior = apiCalls.length;
        const { h, calls } = fake({ provider, model, ultracode });
        assert.equal(await runSlash("/effort ultracode", attach, h), true, `${model}, ${attach.length} attachments: handled locally, nothing goes to the CLI`);
        assert.deepEqual(calls.filter((c) => PICKER.includes(c[0])), [["setUltracode", !ultracode]], "flipped, no level set");
        assert.equal(apiCalls.length, prior, "no attachment is read or folded");
      }
    }
  }
  // With the switch on: "/effort high" sets only the level.
  const { h, calls } = fake({ ultracode: true });
  assert.equal(await runSlash("/effort high", [], h), true);
  assert.deepEqual(calls.filter((c) => PICKER.includes(c[0])), [["pickEffort", "high"]]);
  // Without argument the command names level and switch.
  const on = fake({ ultracode: true });
  assert.equal(await runSlash("/effort", [], on.h), true);
  assert.match(on.calls[0][2], / · Ultracode"/);
});

// ── Without levels: `/effort` says "no thinking levels", `/effort ultracode` still flips the switch ───────────────────
test("runSlash: /effort without levels — no level set, but /effort ultracode switches", async () => {
  const WITHOUT = "This model has no thinking levels — /effort sets nothing here.";
  const withHaiku = (fall) => {
    fall.h.allProviders = [{ id: "claude", label: "Claude", models: [...MODELS.claude, { id: "haiku", label: "Haiku", efforts: [] }] }];
    return fall;
  };
  for (const ultracode of [true, false]) {
    for (const text of ["/effort", "/effort high"]) {
      const { h, calls, names } = withHaiku(fake({ model: "haiku", ultracode }));
      assert.equal(await runSlash(text, [], h), true, `"${text}" ends locally`);
      assert.ok(!names().includes("pickEffort") && !names().includes("setUltracode"), `"${text}" sets nothing without levels`);
      assert.deepEqual(calls.filter((c) => c[0] === "pushInfo"), [["pushInfo", "Effort", WITHOUT]]);
    }
    const { h, calls } = withHaiku(fake({ model: "haiku", ultracode }));
    assert.equal(await runSlash("/effort ultracode", [], h), true);
    assert.deepEqual(calls.filter((c) => PICKER.includes(c[0])), [["setUltracode", !ultracode]], "Haiku: the switch flips anyway");
  }
});

// ── Short forms end LOCALLY, also with an attachment ─────────────────────────────────────────────
// "/effort mid" is a known slash: if it reached the CLI, it would run its own command (the `/goal` case). The switch ends
// with `true`, the attachments stay untouched, the level of the table is set. A word outside the table and the levels is
// "Unknown" as before. Counter-test: without the table lookup in chatSlash.ts the matrix and this test are red.
test("runSlash: /effort with a short form sets the level locally — also with attachment; the short form follows the levels of the model", async () => {
  const attachment = [{ name: "pasted-text-ab12.txt", file: "pasted-text-ab12.txt" }, { name: "image.png", file: "image.png" }];
  for (const [text, level] of [["/effort mid", "medium"], ["/effort med", "medium"], ["/effort x-high", "xhigh"]]) {
    for (const attach of [[], attachment]) {
      const prior = apiCalls.length;
      const { h, calls } = fake({ provider: "codex", model: "gpt-5.5" });
      assert.equal(await runSlash(text, attach, h), true, `"${text}", ${attach.length} attachments: handled locally, nothing goes to the CLI`);
      assert.deepEqual(calls.filter((c) => PICKER.includes(c[0])), [["pickEffort", level]]);
      assert.equal(apiCalls.length, prior, "no attachment is read or folded");
    }
  }
  for (const text of ["/effort middle", "/effort x high2"]) {
    const { h, calls, names } = fake();
    assert.equal(await runSlash(text, [], h), true);
    assert.ok(!names().includes("pickEffort"), `"${text}" sets nothing`);
    assert.equal(calls.find((c) => c[0] === "pushInfo")[1], "Effort");
  }
});

// `/workflow:<shortName>` is NOT a command of the switch — it returns `false`, calls no handler and writes nothing; the line
// goes as an ordinary message to the server (which reads the mention, the model starts the workflow). A name like "/goal-x -y"
// is `/goal` with the argument "-x -y". Counter-test: `workflow` in SLASH_COMMANDS => red (the switch would have a branch, or
// "panel command without branch" in the contract test).
test("runSlash: `/workflow:<shortName>` is no command — false, no handler, no writing; also with job and in every spelling", async () => {
  for (const text of ["/workflow:job-ship", "/workflow:job-ship please with tests", "/Workflow:Release-2", "/workflow:x", "/workflows", "/workflow"]) {
    apiCalls.length = 0;
    const { h, calls } = fake();
    assert.equal(await runSlash(text, [], h), false, `"${text}" goes to the server`);
    assert.deepEqual(calls, [], `"${text}" calls no handler`);
    assert.deepEqual(apiCalls, [], `"${text}" writes nothing`);
  }
  // Intercepting dynamic workflows is gone: the switch reads "/goal-x -y" as /goal again.
  const { h, calls } = fake();
  assert.deepEqual(await runSlash("/goal-x -y", [], h), { send: "-x -y", display: "/goal-x -y" });
  assert.equal(calls[0][0], "setGoal");
});
