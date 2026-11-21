// The agenda keeper in the web client's Outer Loop. It is the second built-in agent next to the summariser; until then the surface
// read "built in" off `summarizer`. Here, EXECUTED or on the source text:
//   (a) Wire (`lib/api/outerloop.ts` is an allow-list — a field that `normOuterLoopAgent` does not read never arrives): `agendaKeeper`,
//       `fixed` (if missing, the server's rule applies: summariser OR keeper), `markUpkeep` (only on the keeper, default on),
//       `upkeepTally` (only on the keeper, otherwise `null`, a missing one is unknown, never "0"), per run `upkeep`, in the chat info
//       `agendaKeeper`.
//   (b) Words (`components/outerloop/outerLoopText.ts`): "12 changes · 10 standing · 2 corrected" (standing = open + confirmed) and per
//       run "3 changes · 1 corrected" — every key translated.
//   (c) Surface: what "built in" means (no delete, reset, "new template", the marker in the editor) hangs on `fixed`; the keeper stands in
//       the fixed group directly below the summariser; `markUpkeep` goes into the body ONLY for the keeper (on any other agent the field
//       is a 400 at the server); the switch is the kit's; the runs name their tally; without a tally the editor says "Track record
//       unknown" — the rule stands ONCE in `upkeepTallyText`, no place has its own fallback.
//   (d) iOS on the source text: "built in" hangs on `fixed` — no delete in the list's context menu (`OuterLoopPane.menu`) and in the
//       editor's actions (`OuterLoopEditor.actionsSection`), the keeper stands in the fixed group below the summariser; `markUpkeep`
//       goes out only for the keeper (`OuterLoopEditor.requestBody()`, the body encodes it only if set), the "Agenda" section appears
//       only for the keeper, the tally without its own fallback.
//   (e) An intended end is no error (not only the abort at a turn but EVERY code of the ONE server constant `INTENDED_END` in
//       outerloop/intended-end.js — loaded directly, an empty anchor throws; plus `quiet`, the deferral of a woken run in a busy chat,
//       which used to stand there raw and red as a sentence): every key has a write path VIA the constant (`WRITE_PATHS`), the state
//       comes from store/outer-loop.js; web (`INTENDED_ENDS`, `runError`) and iOS (`OuterLoopWord.intendedEnd`) know exactly the same
//       codes, each quiet with its own translated text (a new code in the server without client text is red); both views (runs, chat
//       info) — web AND iOS — show a run's error only through this one calculation. That iOS gives the same answer is executed by
//       outerloop-set-binding.
//
// Counter-probes (one sabotage each, seen red):
//   lib/api/outerloop.ts: `fixed` only `a.fixed === true`                                        => (a) red
//   lib/api/outerloop.ts: `upkeepTally` also on other agents                                     => (a) red
//   OuterLoopEditor.tsx: `body.markUpkeep` without `base?.agendaKeeper`                          => (c) red
//   OuterLoopPane.tsx: delete again bound to `!a.summarizer`                                     => (c) red
//   outerLoopText.ts: `upkeepTallyText(null)` => "—"                                             => (b) red
//   outerLoopText.ts: the abort-at-turn code constant set to "Turn"                              => (e) red
//   OuterLoopEditor.tsx: `base.upkeepTally ? … : "—"` back                                       => (c) red
//   OuterLoopRuns.tsx: quiet also `text-danger`                                                  => (e) red
//   OuterLoopChatSheet.tsx: the raw red last-run error back                                      => (e) red
//   OuterLoopPane.swift: delete in the context menu also on the fixed agent                      => (d) red; the abort-at-turn constant "Turn" => (e) red
//   OuterLoopEditor.swift: actions bound to `summarizer` instead of `fixed`                      => (d) red; `r.markUpkeep` without `if base?.agendaKeeper == true` => (d) red
//   OuterLoopRuns.swift: the raw red error back                                                  => (e) red
//   OuterLoopChatPage.swift: `.foregroundStyle(Color.red)` also for quiet                        => (e) red
//   server anchors (in a copy of the repo): `agendaKeeperTurnStart` renamed / `SET state` gone    => (e) THROWS; reason "turn-begin"    => (e) red
//   intended-end.js: a new code `empty` without client text; run.js: `error: "quiet"` as a literal instead of via INTENDED_END.quiet;
//   OuterLoopPane.swift: `case "quiet"` gone; i18n-de.ts: the German line of "Postponed: the chat was not quiet" gone (also (b) red);
//   LocDEOuterLoop.swift: the same line on iOS gone                                              => each red in (e)
//
// Run:  node --test --test-reporter=tap web/test/outerloop-keeper.test.mjs
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
const src = path.join(webDir, "src");
const readIos = (rel) => fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", rel), "utf8");
const readServer = (rel) => fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", rel), "utf8");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");
// Comments drop before every measurement — history may stand there without colouring the test.
const withoutComments = (code) => code.split("\n").filter((z) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(z)).join("\n");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-outerloop-keeper-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
// The wire: lib/api/outerloop.ts together with core.ts — leaf modules with `.js` specifiers (README in lib/api/).
execFileSync(process.execPath, [
  tsc, path.join(src, "lib", "api", "outerloop.ts"), "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
], { cwd: webDir, stdio: "pipe" });
const wire = await import(pathToFileURL(path.join(out, "outerloop.js")).href);
// The words: outerLoopText.ts imports only types via the alias `@/lib/api` — transpiled without type checking (the project's tsc checks
// the types) so that the alias need not be resolved here.
const ts = (await import(pathToFileURL(path.join(webDir, "node_modules", "typescript", "lib", "typescript.js")).href)).default;
const textJs = ts.transpileModule(read("components/outerloop/outerLoopText.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
fs.writeFileSync(path.join(out, "outerLoopText.mjs"), textJs);
const word = await import(pathToFileURL(path.join(out, "outerLoopText.mjs")).href);
// A t() that fills the placeholders — the calculation, not the translation, is under test here.
const t = (k, p = {}) => k.replace(/\{(\w+)\}/g, (_, n) => String(p[n] ?? `{${n}}`));

test("(a) wire: agendaKeeper, fixed, markUpkeep and upkeepTally on the agent, upkeep per run, agendaKeeper in the chat info", () => {
  const keeper = wire.normOuterLoopAgent({
    id: "ws1-a9e0da", origin: "workspace", agendaKeeper: true,
    upkeepTally: { changes: 12, open: 7, confirmed: 3, corrected: 2 },
  });
  assert.equal(keeper.agendaKeeper, true);
  assert.equal(keeper.summarizer, false);
  assert.equal(keeper.fixed, true, "without `fixed` the server's rule applies: the keeper is built in");
  assert.equal(keeper.markUpkeep, true, "default on");
  assert.deepEqual(keeper.upkeepTally, { changes: 12, open: 7, confirmed: 3, corrected: 2 });
  assert.equal(wire.normOuterLoopAgent({ agendaKeeper: true, markUpkeep: false }).markUpkeep, false);
  assert.equal(wire.normOuterLoopAgent({ agendaKeeper: true }).upkeepTally, null, "a missing tally is unknown, never \"0 changes\"");
  assert.deepEqual(wire.normOuterLoopAgent({ agendaKeeper: true, upkeepTally: { open: 1, corrected: 2 } }).upkeepTally,
    { changes: 3, open: 1, confirmed: 0, corrected: 2 }, "without a total it is the sum of the three outcomes");

  const combined = wire.normOuterLoopAgent({ summarizer: true, markUpkeep: true, upkeepTally: { changes: 4 } });
  assert.equal(combined.fixed, true, "the summariser is built in");
  assert.equal(combined.markUpkeep, false, "the switch applies only to the keeper");
  assert.equal(combined.upkeepTally, null, "only the keeper has a tally");
  const normal = wire.normOuterLoopAgent({ origin: "workspace" });
  assert.deepEqual([normal.agendaKeeper, normal.fixed, normal.markUpkeep, normal.upkeepTally], [false, false, false, null]);
  assert.equal(wire.normOuterLoopAgent({ summarizer: true, fixed: false }).fixed, false, "if the server sends `fixed`, its value applies");

  assert.deepEqual(wire.normOuterLoopRun({ id: "l1", upkeep: { changes: 3, corrected: 1 } }).upkeep, { changes: 3, corrected: 1 });
  assert.equal(wire.normOuterLoopRun({ id: "l2" }).upkeep, null, "a run of another agent carries no tally");
  assert.equal(wire.normOuterLoopRun({ id: "l3", upkeep: [3, 1] }).upkeep, null, "a list is no tally");

  const status = wire.normOuterLoopChatState({ targetChat: true, agents: [{ id: "ws1-a9e0da", agendaKeeper: true }, { id: "z", summarizer: true }] });
  assert.deepEqual(status.agents.map((a) => [a.id, a.agendaKeeper, a.summarizer]), [["ws1-a9e0da", true, false], ["z", false, true]]);
});

test("(b) words: tally \"changes · standing · corrected\" with standing = open + confirmed, per run \"changes · corrected\", everything translated", (tt) => {
  assert.equal(word.upkeepTallyText({ changes: 12, open: 7, confirmed: 3, corrected: 2 }, t), "12 changes · 10 standing · 2 corrected");
  assert.equal(word.upkeepTallyText({ changes: 1, open: 1, confirmed: 0, corrected: 0 }, t), "1 change · 1 standing · 0 corrected");
  assert.equal(word.upkeepTallyText({ changes: 0, open: 0, confirmed: 0, corrected: 0 }, t), "No change yet");
  assert.equal(word.upkeepTallyText(null, t), "Track record unknown", "without a tally it is unknown, never \"No change yet\"");
  assert.equal(word.runUpkeepText({ changes: 3, corrected: 1 }, t), "3 changes · 1 corrected");
  assert.equal(word.runUpkeepText({ changes: 3, corrected: 0 }, t), "3 changes");
  assert.equal(word.runUpkeepText({ changes: 0, corrected: 0 }, t), "no change");
  assert.equal(word.fixedName({ summarizer: false, agendaKeeper: true }, t), "Agenda keeper");
  assert.equal(word.fixedName({ summarizer: false, agendaKeeper: false }, t), "");

  const en = read("lib/i18n-de.ts");
  const files = ["components/outerloop/outerLoopText.ts", "components/outerloop/OuterLoopPane.tsx", "components/outerloop/OuterLoopEditor.tsx",
    "components/outerloop/OuterLoopRuns.tsx", "components/outerloop/OuterLoopChatSheet.tsx", "components/chat/AgendaPanel.tsx"];
  const sets = [...new Set(files.flatMap((d) => [...read(d).matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1])))];
  tt.diagnostic(`sentences in the keeper views: ${sets.length}`);
  assert.deepEqual(sets.filter((k) => !en.includes(`\n  "${k}":`)), [], "without a German translation");
  const duplicate = [...en.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]).filter((k, i, all) => all.indexOf(k) !== i);
  assert.deepEqual(duplicate.filter((k) => sets.includes(k)), [], "duplicate keys (TS1117)");
});

test("(c) surface: \"built in\" hangs on `fixed`, the keeper stands below the summariser, markUpkeep only for the keeper in the body", () => {
  const pane = withoutComments(read("components/outerloop/OuterLoopPane.tsx"));
  assert.match(pane, /\{opts\.editable && !a\.fixed && \(/, "delete only on an agent that is not built in");
  assert.match(pane, /\{opts\.editable && a\.fixed && <MenuEntry label=\{t\("Reset to template"\)\}/, "reset on every fixed one");
  assert.match(pane, /\{a\.fixed && a\.templateNew && /, "\"new template\" on every fixed one");
  assert.match(pane, /workspace: items\.filter\(\(a\) => a\.origin === "workspace" && !a\.fixed\)/, "the fixed ones do not stand under workspace");
  assert.match(pane, /keeper: items\.find\(\(a\) => a\.agendaKeeper\) \?\? null/);
  const fixed = pane.slice(pane.indexOf("data-outerloop-fixed"), pane.indexOf("<OriginSection kind=\"workspace\""));
  assert.ok(fixed.indexOf("groups.summarizer") >= 0 && fixed.indexOf("groups.keeper") > fixed.indexOf("groups.summarizer"),
    "the keeper stands in the fixed group directly below the summariser");
  assert.match(pane, /a\.agendaKeeper \? SYM\.check\(16\)/, "own symbol from the same SYM source");
  assert.ok(!/a\.summarizer && <MenuEntry/.test(pane) && !/!a\.summarizer && \(/.test(pane), "no \"built in\" on summarizer any more");

  const editor = withoutComments(read("components/outerloop/OuterLoopEditor.tsx"));
  assert.match(editor, /if \(base\?\.agendaKeeper\) body\.markUpkeep = draft\.markUpkeep;/, "markUpkeep only for the keeper in the body");
  assert.equal((editor.match(/markUpkeep =/g) || []).length, 1, "no second way that writes markUpkeep into a body");
  assert.match(editor, /\{base\?\.fixed && <span[^>]*>\{t\("built in"\)\}<\/span>\}/, "the \"built in\" marker on `fixed`");
  assert.match(editor, /\{base\?\.fixed && \(\s*<div className="flex flex-wrap items-center gap-2 px-1">\s*<button type="button" onClick=\{\(\) => \{ void reset\(\); \}\}/,
    "reset in the editor on `fixed`");
  const upkeep = editor.slice(editor.indexOf("data-outerloop-upkeep=\"\""), editor.indexOf("data-outerloop-upkeep=\"\"") + 1500);
  assert.match(upkeep, /<Toggle on=\{draft\.markUpkeep\}/, "the switch is the kit's");
  assert.match(upkeep, /upkeepTallyText\(base\.upkeepTally, t\)/, "the tally stands in the editor");
  // Empty is not unknown: the editor passes the tally on UNCHECKED — "Track record unknown" is said by upkeepTallyText (b), an own
  // fallback here (`base.upkeepTally ? … : …`) would be a second version of the same rule.
  assert.match(upkeep, /data-outerloop-upkeep-tally="">\s*\{upkeepTallyText\(base\.upkeepTally, t\)\}\s*<\/p>/, "the tally without its own fallback");
  assert.ok(!/base\.upkeepTally \?/.test(editor), "no second fallback for a missing tally in the editor");
  assert.match(editor, /\{base\?\.agendaKeeper && \(\s*<div className=\{pane\} data-outerloop-upkeep="">/, "switch and tally only for the keeper");

  const runs = withoutComments(read("components/outerloop/OuterLoopRuns.tsx"));
  assert.match(runs, /\{l\.upkeep && \(/);
  assert.match(runs, /runUpkeepText\(l\.upkeep, t\)/, "the tally per run");
  const sheet = withoutComments(read("components/outerloop/OuterLoopChatSheet.tsx"));
  // The timeline agent too.
  assert.match(sheet, /a\.summarizer \|\| a\.agendaKeeper \|\| a\.timeline \? <Marker tone="accent">\{fixedName\(a, t\)\}<\/Marker>/, "the chat info names the role");
});

// The block of a Swift function: from the header line to the first line `end` after it (same indentation). A missing anchor throws.
function swiftBlock(text, header, end, location) {
  const rows = text.split("\n");
  const start = rows.findIndex((z) => z === header);
  assert.ok(start >= 0, `\`${header.trim()}\` is missing in ${location} — update the anchor, do not delete the test`);
  const end2 = rows.findIndex((z, i) => i > start && z === end);
  assert.ok(end2 > start, `the end of \`${header.trim()}\` is missing in ${location}`);
  return rows.slice(start, end2 + 1).join("\n");
}
const withoutSwiftComments = (code) => code.split("\n").filter((z) => !/^\s*\/\//.test(z)).join("\n");

test("(d) iOS: \"built in\" hangs on `fixed` (no delete in list and editor), markUpkeep goes out only for the keeper", () => {
  const pane = withoutSwiftComments(readIos("Code/OuterLoopPane.swift"));
  const menu = swiftBlock(pane, "    private func menu(_ a: OuterLoopAgent) -> some View {", "    }", "OuterLoopPane.swift");
  assert.match(menu, /\n {8}if a\.fixed \{\n {12}Button \{ resetQuestion = a \}[^\n]*\n {8}\} else \{\n {12}Button\(role: \.destructive\) \{ deleteQuestion = a \}/,
    "context menu: reset on `fixed`, delete only in the branch beside it");
  assert.equal((pane.match(/deleteQuestion = a\b/g) || []).length, 1, "no second way in the list that asks for deletion");
  assert.match(pane, /private var wsAgents: \[OuterLoopAgent\] \{ items\.filter \{ \$0\.origin == "workspace" && !\$0\.fixed \} \}/, "the fixed ones do not stand under workspace");
  assert.match(pane, /private var agendaKeeper: OuterLoopAgent\? \{ items\.first \{ \$0\.agendaKeeper \} \}/);
  const list = swiftBlock(pane, "    private var workspaceList: some View {", "    }", "OuterLoopPane.swift");
  assert.ok(list.indexOf("if let z = summarizer") >= 0 && list.indexOf("if let p = agendaKeeper") > list.indexOf("if let z = summarizer")
    && list.indexOf("if let p = agendaKeeper") < list.indexOf("CbTileHeader(origin: .workspace"), "the keeper stands in the fixed group directly below the summariser");

  const editor = withoutSwiftComments(readIos("Code/OuterLoopEditor.swift"));
  const actions = swiftBlock(editor, "    private var actionsSection: some View {", "    }", "OuterLoopEditor.swift");
  assert.match(actions, /\n {16}if base\.fixed \{\n {20}Button\(L\("Reset to template"\)\) \{ resetQuestion = true \}[\s\S]*?\n {16}\} else \{\n {20}Button\(L\("Delete"\), role: \.destructive\) \{ deleteQuestion = true \}/,
    "editor: reset on `fixed`, delete only in the branch beside it");
  assert.equal((editor.match(/deleteQuestion = true/g) || []).length, 1, "no second way in the editor that asks for deletion");
  const body = swiftBlock(editor, "    private func requestBody() -> OuterLoopBody {", "    }", "OuterLoopEditor.swift");
  assert.match(body, /\n {8}if base\?\.agendaKeeper == true \{ r\.markUpkeep = markUpkeep \}\n/, "markUpkeep only for the keeper in the body");
  assert.ok(!/markUpkeep:/.test(body), "markUpkeep is not an argument in building the body (there it would go to every agent)");
  assert.equal((editor.match(/\.markUpkeep = /g) || []).length, 1, "no second way that writes markUpkeep into a body");
  assert.match(editor, /if let base, base\.agendaKeeper \{ upkeepSection\(base\) \}/, "the \"Agenda\" section only for the keeper");
  assert.match(editor, /Text\(OuterLoopWord\.upkeepTally\(a\.upkeepTally\)\)/, "the tally without its own fallback — \"Track record unknown\" is said by OuterLoopWord");
  // The body itself: `markUpkeep` is optional, default nil, and goes out only if set (otherwise a 400 on every other agent).
  const models = withoutSwiftComments(readIos("Models/OuterLoopModels.swift"));
  const bodyType = swiftBlock(models, "struct OuterLoopBody: Encodable, Sendable {", "}", "OuterLoopModels.swift");
  assert.match(bodyType, /\n {4}var markUpkeep: Bool\? = nil\n/);
  assert.match(bodyType, /\n {8}if let markUpkeep \{ try c\.encode\(markUpkeep, forKey: \.markUpkeep\) \}\n/);
  // Only the editor builds a body — a second place to build it would need the same rule.
  const buildLocations = fs.readdirSync(path.join(repo, "mobile", "CbaseMobile"), { recursive: true }).filter((d) => String(d).endsWith(".swift"))
    .filter((d) => /OuterLoopBody\(/.test(readIos(String(d)).replace(/struct OuterLoopBody/, "")));
  assert.deepEqual(buildLocations.map(String), ["Code/OuterLoopEditor.swift"]);
});

// The intended ends, read from the ONE server constant (outerloop/intended-end.js, a leaf without imports — loaded directly), and the
// state the store writes with it. An anchor that finds nothing THROWS.
const { INTENDED_END } = await import(pathToFileURL(path.join(repo, "server", "backend", "electron", "server", "outerloop", "intended-end.js")).href);
function intendedEnds() {
  const codes = INTENDED_END && typeof INTENDED_END === "object" ? Object.entries(INTENDED_END) : [];
  if (!codes.length || codes.some(([, c]) => typeof c !== "string" || !c)) {
    throw new Error(`Server: outerloop/intended-end.js INTENDED_END carries no codes (${JSON.stringify(INTENDED_END)}) — update the anchor, do not delete the test`);
  }
  const abort = readServer("store/outer-loop.js").match(/function outerLoopRunsAbortIds\([\s\S]*?SET state = '(\w+)'/);
  if (!abort) throw new Error("Server source: store/outer-loop.js outerLoopRunsAbortIds (SET state = '…') not found — update the anchor");
  return { codes, state: abort[1] };
}
// Where the server writes a code — every key of the constant has a write path VIA it (no code stands as a literal beside it), and at
// each one stands the clients' state.
const WRITE_PATHS = {
  turn: ["outerloop/abort.js", /abortOuterLoop\(\{ runIds, reason: INTENDED_END\.turn \}\)/],
  quiet: ["outerloop/run.js", /store\.outerLoopRunState\(runId, "aborted", \{ error: INTENDED_END\.quiet \}\)/],
};

test("(e) intended ends: EVERY server code appears quietly with its own text in web and iOS — web calculation executed, both views through it", (tt) => {
  const server = intendedEnds();
  tt.diagnostic(`Server: state "${server.state}", codes ${JSON.stringify(Object.fromEntries(server.codes))}`);
  assert.equal(server.state, "aborted", "the state both clients compare is the server's");
  for (const [key, code] of server.codes) {
    const way = WRITE_PATHS[key];
    assert.ok(way, `INTENDED_END.${key}: no known write path — update WRITE_PATHS (where does the server write "${code}"?)`);
    assert.match(readServer(way[0]), way[1], `${way[0]}: "${code}" is written via INTENDED_END.${key}`);
  }
  const codes = server.codes.map(([, c]) => c);

  // Web: the same set (a code there without text here is red, a text here without a code there too), executed per code quiet with its
  // own text, translated.
  const en = read("lib/i18n-de.ts");
  assert.deepEqual([...word.INTENDED_ENDS].sort(), [...codes].sort(), "the web knows exactly the server's intended ends");
  const webTexts = {};
  for (const code of codes) {
    const f = word.runError({ state: server.state, error: code }, t);
    assert.equal(f?.quiet, true, `"${code}": quiet in the web — ${JSON.stringify(f)}`);
    assert.ok(f.text && f.text !== code, `"${code}": an own text, not the code — ${JSON.stringify(f)}`);
    assert.ok(en.includes(`\n  "${f.text}": "`), `"${f.text}" without a German translation`);
    assert.deepEqual(word.runError({ state: "error", error: code }, t), { text: code, quiet: false }, `"${code}" alone is no intended end`);
    webTexts[code] = f.text;
  }
  assert.equal(webTexts[INTENDED_END.turn], "Stopped: the chat went back to work");
  assert.equal(webTexts[INTENDED_END.quiet], "Postponed: the chat was not quiet");
  assert.match(en, /\n {2}"Stopped: the chat went back to work": "Abgebrochen: der Chat hat weitergearbeitet",\n/);
  assert.match(en, /\n {2}"Postponed: the chat was not quiet": "Verschoben: der Chat war nicht ruhig",\n/);
  assert.deepEqual(word.runError({ state: "aborted", error: "Agent deleted" }, t), { text: "Agent deleted", quiet: false }, "every other reason stays as it is");
  assert.equal(word.runError({ state: "finished", error: "" }, t), null);

  // Web: both views show the error ONLY via runError, quiet in grey.
  for (const file of ["components/outerloop/OuterLoopRuns.tsx", "components/outerloop/OuterLoopChatSheet.tsx"]) {
    const code = withoutComments(read(file));
    assert.match(code, /const f = [^\n]*runError\([^\n]*, t\)/, `${file}: the error via runError`);
    assert.match(code, /\$\{f\.quiet \? "text-dim" : "text-danger"\}/, `${file}: quiet grey, otherwise red`);
    assert.ok(!/\.error && </.test(code) && !/\{[^}\n]*\.error\}/.test(code), `${file}: no raw \`error\` in the view any more`);
  }

  // iOS: the same set in `intendedEnd`, per code the same text (key) as in the web and translated; runError goes through it (executed
  // in outerloop-set-binding).
  const wordIos = withoutSwiftComments(readIos("Code/OuterLoopPane.swift"));
  const intended = swiftBlock(wordIos, "    static func intendedEnd(_ code: String) -> String? {", "    }", "OuterLoopPane.swift");
  const cases = Object.fromEntries([...intended.matchAll(/\n {8}case "([^"]+)": return L\("([^"]+)"\)/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(cases).sort(), [...codes].sort(), "iOS knows exactly the server's intended ends");
  assert.match(intended, /\n {8}default: return nil\n/, "another code is no intended end");
  const enIos = readIos("Kit/LocDEOuterLoop.swift");
  for (const code of codes) {
    assert.equal(cases[code], webTexts[code], `"${code}": iOS says the same as the web`);
    assert.ok(enIos.includes(`\n    "${cases[code]}": "`), `iOS: "${cases[code]}" without a German translation`);
  }
  assert.match(wordIos, /if l\.state == "aborted", let text = intendedEnd\(l\.error\) \{ return \(text, true\) \}/);
  for (const file of ["Code/OuterLoopRuns.swift", "Chat/OuterLoopChatPage.swift"]) {
    const code = withoutSwiftComments(readIos(file));
    assert.match(code, /let f = OuterLoopWord\.runError\(l\)/, `${file}: the error via OuterLoopWord.runError`);
    assert.match(code, /\.foregroundStyle\(f\.quiet \? Color\.secondary : Color\.red\)/, `${file}: quiet grey, otherwise red`);
    assert.ok(!/error\)\.cbFont|Text\(f\)\.cbFont/.test(code), `${file}: no raw \`error\` in the view any more`);
  }
});
