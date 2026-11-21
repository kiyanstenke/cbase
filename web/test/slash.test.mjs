// The slash picker in the composer (src/lib/slash.ts): WHEN it opens, WHAT it shows and WHAT ends up in the field on
// insertion. No browser — this is the contract between typed text, caret and hit list, exactly where the picker can go
// wrong without a type error saying so.
//
// This file is the ONLY guard in the gate: `./check` runs `web/test/*.mjs`, no browser.
// The view itself is checked by hand in a real browser.
//
// Run:  node --test web/test/slash.test.mjs
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

// The source is compiled to JS with the local tsc and imported — the real module text is checked,
// not a replica of it (model: appearance.test.mjs).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-slash-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "slash.ts"), path.join(webDir, "src", "lib", "quotes.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { slashQuery, filterPalette, placeSlash, slashKey, targetText, isInsertion, TARGET_MAX, graphEntries } = await import(pathToFileURL(path.join(out, "slash.js")).href);
// The client's quote form and the server's mention rule (a leaf without imports) — see the test below.
const { withQuotes } = await import(pathToFileURL(path.join(out, "quotes.js")).href);
const { mentions } = await import(pathToFileURL(path.resolve(webDir, "..", "server", "backend", "electron", "server", "workflows", "shortName.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

const command = (name) => ({ name, description: "", group: "command" });
const skill = (name) => ({ name, description: "", group: "skill" });

test("The picker opens only at the start of the input — a path does not open it", () => {
  assert.equal(slashQuery("/", 1), "");
  assert.equal(slashQuery("/comp", 5), "comp");
  assert.equal(slashQuery("/mattpocock-skills:tdd", 22), "mattpocock-skills:tdd");

  // Exactly the cases the anchoring at the start is for.
  assert.equal(slashQuery("see src/lib/api.ts", 18), null, "a path in mid-sentence");
  assert.equal(slashQuery("on 8/9 done", 11), null, "a date");
  assert.equal(slashQuery(" /compact", 9), null, "a space before it is not a start");
  assert.equal(slashQuery("", 0), null);
  assert.equal(slashQuery("hello", 5), null);
});

test("After the space it is over — from there on the argument is typed", () => {
  assert.equal(slashQuery("/goal ", 6), null);
  assert.equal(slashQuery("/goal Finish login", 18), null);
  // Also with the caret IN THE MIDDLE of the argument it stays closed.
  assert.equal(slashQuery("/goal Login", 8), null);
});

test("The caret decides, not the end of the text", () => {
  // Anyone with something behind "/mod" who clicks back keeps typing the NAME.
  assert.equal(slashQuery("/mod Login", 4), "mod");
  // And behind the space, again not.
  assert.equal(slashQuery("/mod Login", 6), null);
});

test("Hits at the start come before hits in the middle", () => {
  const stock = [command("goal"), command("compact"), command("cost"), skill("docs-connector"), skill("code-review")];
  assert.deepEqual(filterPalette(stock, "co").map((e) => e.name), ["compact", "cost", "code-review", "docs-connector"]);
  // Empty search: everything, in the given order — commands before skills.
  assert.deepEqual(filterPalette(stock, "").map((e) => e.name), stock.map((e) => e.name));
  assert.deepEqual(filterPalette(stock, "nonexistent"), []);
});

test("Search ignores upper and lower case", () => {
  assert.deepEqual(filterPalette([skill("Code-Review")], "code").map((e) => e.name), ["Code-Review"]);
  assert.deepEqual(filterPalette([command("compact")], "COMP").map((e) => e.name), ["compact"]);
});

test("Inserting keeps what stood behind the search", () => {
  // The core: completing "/mod" to "/model" must not discard an argument already typed.
  // The caret then stands BEFORE the argument, not at the end of the text.
  assert.deepEqual(placeSlash("/mod Login done", "mod", "model"), { text: "/model Login done", caret: 7 });
  assert.deepEqual(placeSlash("/", "", "compact"), { text: "/compact ", caret: 9 });
  // No double space when one already stood behind the search.
  assert.deepEqual(placeSlash("/mod  Login", "mod", "model"), { text: "/model Login", caret: 7 });
});

test("What was inserted does not reopen the picker", () => {
  // Otherwise the panel would stay after every choice — the most common usability bug of this design.
  const { text, caret } = placeSlash("/", "", "compact");
  assert.equal(slashQuery(text, caret), null);
});

// ── The key rule with the picker open ("Tab inserts, Enter sends directly") ──
// Counter-test: if Enter sent ONLY with a fully typed name (`complete`) and inserted otherwise, "Enter with hits"
// would mean "place" and the first test here would be red.
const keyName = (key, hits, shiftKey = false) => slashKey({ key, shiftKey, hits });

test("Enter with hits sends — regardless of how much of the name is already there", () => {
  assert.equal(keyName("Enter", 1), "send");
  assert.equal(keyName("Enter", 7), "send");
});

test("Tab only inserts", () => {
  assert.equal(keyName("Tab", 3), "place");
});

test("Without hits Enter stays the composer's ordinary send", () => {
  // Unknown "/xyz" and paths like "/Users/…" open the panel with 0 hits — they must stay
  // sendable. null means: the picker does not interfere.
  assert.equal(keyName("Enter", 0), null);
  assert.equal(keyName("Tab", 0), null);
  assert.equal(keyName("ArrowDown", 0), null);
});

test("Shift+Enter is a line break, not a send", () => {
  assert.equal(keyName("Enter", 3, true), null);
});

test("Escape closes, arrows move", () => {
  assert.equal(keyName("Escape", 3), "close");
  assert.equal(keyName("Escape", 0), "close", "the panel closes even without hits");
  assert.equal(keyName("ArrowDown", 3), "down");
  assert.equal(keyName("ArrowUp", 3), "up");
  assert.equal(keyName("a", 3), null, "ordinary characters go into the field");
});

// "/goal" with a pasted insertion: the pasted text belongs IN the target — the conversion
// to a file is only a convenience of the composer.
test("The target text takes pasted texts along — behind the typed text, cut to the server cap", () => {
  assert.equal(targetText("fix the 5 things:", ["1 · Seam\n\n2 · Register"]), "fix the 5 things:\n\n1 · Seam\n\n2 · Register");
  assert.equal(targetText("typed only", []), "typed only");
  assert.equal(targetText("", ["pasted only"]), "pasted only", "without a typed word the insertion is the target");
  assert.equal(targetText("  ", ["  ", ""]), "", "empty stays empty — /goal then shows the current target as before");
  const lang = "x".repeat(TARGET_MAX + 500);
  assert.equal(targetText("short", [lang]).length, TARGET_MAX, "the server keeps 4,000 — anything above would never arrive there");
});

test("An insertion is recognised by its name — not every .txt is one", () => {
  assert.equal(isInsertion({ name: "pasted-text-mtwrqilf.txt" }), true);
  assert.equal(isInsertion({ name: "pasted-text.txt" }), true);
  assert.equal(isInsertion({ name: "PASTED-TEXT-1A.TXT" }), true);
  assert.equal(isInsertion({ name: "notes.txt" }), false);
  assert.equal(isInsertion({ name: "pasted-text-a b.txt" }), false);
  assert.equal(isInsertion({ name: "report.pdf" }), false);
});

// The picker's workflow group is the chat's graph workflows as `workflow:<shortName>`. The server computes the short
// name — the client only reads it.
const graph = [
  { name: "Job → Ship", description: "From ticket to merge", shortName: "job-ship" },
  { name: "Release", description: "", shortName: "release-2", originProject: "Checkout" },
  { name: "No short name", description: "a list that does not carry it" },
];

test("The workflow group: `workflow:<shortName>`, origin = real name (with project), description or the fallback sentence", () => {
  const e = graphEntries(graph, "This workflow has no description.");
  assert.deepEqual(e, [
    { name: "workflow:job-ship", description: "From ticket to merge", group: "workflow", origin: "Job → Ship" },
    { name: "workflow:release-2", description: "This workflow has no description.", group: "workflow", origin: "Release · Checkout" },
  ], "an entry without shortName is missing — otherwise the picker would offer `workflow:undefined`");
  assert.deepEqual(graphEntries([], "x"), []);
});

test("Inserting `workflow:job-ship`: \"/workflow:job-ship \" with the caret behind it, the panel does not reopen", () => {
  assert.equal(slashQuery("/workflow:a", 11), "workflow:a", "the colon is part of the name — the panel stays open while typing");
  const { text, caret } = placeSlash("/workflow:a", "workflow:a", "workflow:job-ship");
  assert.deepEqual({ text, caret }, { text: "/workflow:job-ship ", caret: 19 });
  assert.equal(slashQuery(text, caret), null);
  // A job already typed behind it stays.
  assert.deepEqual(placeSlash("/job please with tests", "job", "workflow:job-ship"), { text: "/workflow:job-ship please with tests", caret: 19 });
});

test("Search covers the whole name: \"workflow:j\" at the start, \"job\" as a hit in the middle — behind the hits at the start", () => {
  const stock = [command("goal"), skill("jobs-sync"), ...graphEntries(graph, "")];
  assert.deepEqual(filterPalette(stock, "workflow:j").map((e) => e.name), ["workflow:job-ship"]);
  assert.deepEqual(filterPalette(stock, "workflow:").map((e) => e.name), ["workflow:job-ship", "workflow:release-2"]);
  assert.deepEqual(filterPalette(stock, "job").map((e) => e.name), ["jobs-sync", "workflow:job-ship"], "an inside hit comes after the front hit");
  assert.deepEqual(filterPalette(stock, "JOB-SHIP").map((e) => e.name), ["workflow:job-ship"]);
});

// A quote is data, not an instruction — also for `/workflow:` IN THE MIDDLE of the text. The client assembles the text
// (lib/quotes.ts:withQuotes), the server reads the mentions (workflows/shortName.js:mentions, skipping every quote line
// "> …"). This probe holds both sides against each other: a different quote form (say only the first line with "> ") or a
// server rule that reads quotes again turns it red.
test("A quoted `/workflow:x` is no mention for the server — the form from lib/quotes.ts against its rule", () => {
  const agent = "If you like, start /workflow:ship afterwards — it builds and rolls out.\n/workflow:deploy-prod would also be conceivable.";
  assert.deepEqual(mentions(withQuotes([agent], "What exactly would that do? Do NOT start anything yet.")), []);
  assert.deepEqual(mentions(withQuotes([agent, "/workflow:two"], "/workflow:review please")), ["review"], "only the own line counts");
  assert.deepEqual(mentions(withQuotes([agent], "")), [], "also without own text");
  assert.deepEqual(mentions(withQuotes([], "/workflow:review please")), ["review"], "without a quote the mention counts as before");
});

// The second client: iOS assembles the quotes itself (`Chat/ChatViewModel+Quotes.swift`, twin of lib/quotes.ts). EVERY
// line — an empty one too — must get "> ", exactly where the SERVER cuts lines (`shortName.js:withoutQuotes`, at "\n");
// otherwise a line of a quote stands as the human's own line and counts as a mention. Checking only the source pattern
// `split(separator: "\n")` is not enough: in Swift "\r\n" is ONE Character and not equal to "\n", so after a CRLF no "> "
// came and a quoted `/workflow:ship` became an instruction again. Hence the Swift computation is EXECUTED (`xcrun swift`):
// `quoteBlock` and `withQuotes` cut from the source, the output held against the server's `mentions` and — where only
// "\n" occurs — byte for byte against the web's `withQuotes`. On Linux the title is listed under `onlyMacOS.tests` in
// tools/check/latch.json; if the toolchain is missing on a Mac, it fails loudly.
// Counter-test: splitting at "\n" instead turns it red — the CRLF message names ["ship"].
const ON_MAC = process.platform === "darwin";
function swiftBlock(source, header) {
  const i = source.indexOf(header);
  if (i < 0) throw new Error(`${header} not in ChatViewModel+Quotes.swift — renamed? Update the anchor, do NOT delete the test.`);
  let depth = 0;
  for (let j = source.indexOf("{", i); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && !--depth) return source.slice(i, j + 1);
  }
  throw new Error(`${header}: the brace does not close`);
}
test("iOS builds quotes in the same form — Swift executed: every quoted line, also after CRLF, and the server reads no mention in it", (t) => {
  if (!ON_MAC) { t.skip("xcrun swift exists only on macOS"); return; }
  const source = fs.readFileSync(path.resolve(webDir, "..", "mobile", "CbaseMobile", "Chat", "ChatViewModel+Quotes.swift"), "utf8");
  const agent = "If you like, start /workflow:ship afterwards — it builds and rolls out.\n/workflow:deploy-prod would also be conceivable.";
  // [quotes, own text, expected mentions, only "\n" (then byte-equal with the web)]
  const CASES = [
    [[agent], "What exactly would that do? Do NOT start anything yet.", [], true],
    [[agent, "/workflow:two"], "/workflow:review please", ["review"], true],
    [["First line\n\n/workflow:empty-beforehand"], "", [], true],
    [["Gladly.\r\n/workflow:ship starts the release."], "Do NOT start anything yet.", [], false],
    [["Gladly.\r\n\r\n/workflow:ship\r\nand /workflow:deploy-prod"], "/workflow:review please", ["review"], false],
    [["Old Mac line ending.\r/workflow:ship"], "", [], false],
  ];
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const program = `import Foundation
enum ChatViewModel {
${swiftBlock(source, "static func quoteBlock(_ text: String) -> String")}
${swiftBlock(source, "static func withQuotes(_ quotes: [String], _ text: String) -> String")}
}
func read(_ s: String) -> String { String(data: Data(base64Encoded: s)!, encoding: .utf8)! }
let cases: [([String], String)] = [
${CASES.map(([z, text]) => `    ([${z.map((x) => `read("${b64(x)}")`).join(", ")}], read("${b64(text)}")),`).join("\n")}
]
for (quotes, text) in cases { print(Data(ChatViewModel.withQuotes(quotes, text).utf8).base64EncodedString()) }
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-quotes-ios-"));
  const file = path.join(dir, "quotes.swift");
  fs.writeFileSync(file, program);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be executed (xcrun swift): ${e.stderr || e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const rows = output.split("\n").filter(Boolean).map((z) => Buffer.from(z, "base64").toString("utf8"));
  assert.equal(rows.length, CASES.length, `Swift returned ${rows.length} instead of ${CASES.length} messages`);
  CASES.forEach(([quotes, text, expected, onlyLf], i) => {
    const ios = rows[i];
    assert.deepEqual(mentions(ios), expected, `case ${i + 1}: iOS sent ${JSON.stringify(ios)}`);
    assert.deepEqual(mentions(withQuotes(quotes, text)), expected, `case ${i + 1}: the web`);
    if (onlyLf) assert.equal(ios, withQuotes(quotes, text), `case ${i + 1}: iOS and web assemble the same quote differently`);
    // Every line that is not the own message is a quote line — where the server cuts.
    const own = text.split("\n");
    const quoteRows = ios.split("\n").slice(0, ios.split("\n").length - (text ? own.length + 1 : 0));
    for (const z of quoteRows) assert.ok(z === "" || z.startsWith("> "), `case ${i + 1}: line without "> ": ${JSON.stringify(z)}`);
  });
});
