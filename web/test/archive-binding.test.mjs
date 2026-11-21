// The archive: ONE computation, two languages.
//
// `ArchiveGroups` in `mobile/CbaseMobile/Models/ArchiveModels.swift` carried in its header "the same computation as
// `archiveGroups`/`archiveSearch` in web/src/lib/archive.ts", but that was bound nowhere: no UI test checks order or
// search of the archive list, only the presence of single rows, and `web/test/archive.test.mjs` runs only the TS page.
// A reversed sort in Swift (`>` to `<`) stayed green in the whole gate ("a comment is not a guard").
//
// Model `geometry-binding.test.mjs`/`effort-ios.test.mjs`: the blocks are CUT from the Swift source, assembled with
// minimal stubs (`ChatFolder`, `L`) into one program and REALLY run with `xcrun swift`, against the same seed that
// runs here through `lib/archive.ts` compiled with tsc. If the toolchain is missing, the test fails LOUDLY (a silent
// skip would count as passed); on Linux the file does not run at all (`onlyMacOS` in tools/check/latch.json).
//
// Plus pure computations of the iOS page that are only EXECUTED here (their callers are bound by ios-archive.test.mjs
// through source text):
//   · `ArchiveQuestion.folderDelete`: the sentence of the delete question, singular "will be lost", against
//     `folderDeleteQuestion` in lib/archive.ts, also for the numbers the server did NOT name;
//   · `ArchiveNotices`: two notices before a render BOTH arrive.
//
// Counter-tests (each shown red once): `>` to `<` in the `mostRecent` order of `ArchiveGroups` turns it red; search without folder
// name turns it red; search without label turns it red (only since "second" in SEARCH; before, it stayed green);
// `return n == 1` to `return false` turns it red; `last = [:]` at the start of `report` (the old replaced set)
// turns it red; `formIntersection` removed turns it red.
//
// Run:  node --test web/test/archive-binding.test.mjs
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
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Models", "ArchiveModels.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// ── Cutting the block from the source (model effort-ios.test.mjs) ────────────────────────────────
// The type stands at the top level, its closing brace is the first `}` in column 0.
function swiftBlock(header) {
  const rows = fs.readFileSync(SOURCE_SWIFT, "utf8").split("\n");
  const start = rows.findIndex((z) => z.startsWith(header));
  assert.ok(start >= 0, `"${header}" is no longer in ArchiveModels.swift; moved or renamed? Then adjust this line.`);
  const end = rows.findIndex((z, i) => i > start && z === "}");
  assert.ok(end > start, `the closing brace of "${header}" is not in column 0`);
  return rows.slice(start, end + 1).join("\n");
}

// ── The seed: folders (archived, archived empty, active) and chats (in the folder, loose, loose with label, in an
// unknown folder). Timestamps without ties: the order on a tie is a promise in neither language (JS `sort` is
// stable, Swift's `sorted` only by implementation).
const FOLDER = [
  { id: "fa", name: "Research", archivedAt: 100 },
  { id: "fb", name: "Release Bugs", archivedAt: 300 },
  { id: "fl", name: "Empty archived", archivedAt: 200 },
  { id: "fx", name: "Active folder", archivedAt: null },
  { id: "fy", name: "Second active", archivedAt: null },
];
const CHATS = [
  { id: "a1", title: "Bug in checkout", folderId: "fa", archivedAt: 110 },
  { id: "a2", title: "Notes", folderId: "fa", archivedAt: 150 },
  { id: "a3", title: "Plan", folderId: "fa", archivedAt: 130 },
  { id: "b1", title: "Crash on start", folderId: "fb", archivedAt: 310 },
  { id: "l1", title: "Loose chat", folderId: null, archivedAt: 400 },
  { id: "l2", title: "From the active folder", folderId: "fx", archivedAt: 250 },
  { id: "l3", title: "Another active one", folderId: "fy", archivedAt: 50 },
  { id: "l4", title: "Unknown folder", folderId: "fz", archivedAt: 260 },
  { id: "l5", title: "", folderId: null, archivedAt: 5 },
];
// Searches: empty, spaces, title (upper/lower case), folder name (the whole group stays), ONLY the label of a loose
// chat ("second": its title does not match; the first seed hit label and title at once and let a removed label search
// stay green), hits in two groups, nothing.
const SEARCH = ["", "   ", "bug", "BUG", "research", "active", "second", "a", "ch", "  plan  ", "zzz", "Bugs"];

// ── TS side ─────────────────────────────────────────────────────────────────────────────────────────
let tmpTs = null;
async function tsPage() {
  tmpTs = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-archivbind-"));
  execFileSync(process.execPath, [
    tsc, path.join(webDir, "src", "lib", "archive.ts"),
    "--outDir", tmpTs, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
  ], { stdio: "pipe" });
  return import(pathToFileURL(path.join(tmpTs, "archive.js")).href);
}
function tsRows(web, q) {
  const g = web.archiveSearch(q, web.archiveGroups(CHATS.map((c) => ({ ...c })), FOLDER.map((o) => ({ ...o }))));
  return [
    ...g.folder.map((o) => `O\t${o.folder.id}\t${o.chats.map((c) => c.id).join(",")}`),
    ...g.loose.map((l) => `L\t${l.chat.id}\t${l.label}`),
  ];
}

// ── Swift side: all cases in ONE run (`swift` compiles anew in script mode each time, ≈ 3 s cold) ─────
const swiftLit = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const optLit = (s) => (s == null ? "nil" : swiftLit(s));
const optNum = (n) => (n == null ? "nil" : String(n));

// The question: (name, chats, context files); the wording stands HERE as the expectation, the key is at the same time
// the text (the stub `L` replaces only the placeholders, like Kit/Localization.swift). And the same table runs through
// `folderDeleteQuestion` in lib/archive.ts: both clients ask the SAME question from the same numbers. `null` = the
// server did not name the number ("empty is not unknown"): without a chat number NO question (and no delete), without
// a context-file number the sentence without number; never a guessed 0.
const QUESTIONS = [
  ["Research", 1, 0, "Delete folder \"Research\" permanently? 1 chat will be lost.##one"],
  ["Research", 3, 0, "Delete folder \"Research\" permanently? 3 chats will be lost."],
  ["Research", 0, 0, "Delete folder \"Research\" permanently? 0 chats will be lost."],
  ["Research", 1, 1, "Delete folder \"Research\" permanently? 1 chat and 1 context file will be lost."],
  ["Research", 2, 3, "Delete folder \"Research\" permanently? 2 chats and 3 context files will be lost."],
  ["Läufe", 1, 2, "Delete folder \"Läufe\" permanently? 1 chat and 2 context files will be lost."],
  ["Research", 2, null, "Delete folder \"Research\" permanently? 2 chats and all of the folder's context files will be lost (number unknown)."],
  ["Research", null, 2, null],
  ["Läufe", null, null, null],
];

let tmpSwift = null;
let measured = null;
function swiftPage() {
  if (measured) return measured;
  tmpSwift = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-archivbind-swift-"));
  const file = path.join(tmpSwift, "archive.swift");
  // Stubs: exactly the foreign types the blocks touch, deliberately MINIMAL.
  const mocks = `import Foundation

struct ChatFolder: Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var projectId: String? = nil
    var archivedAt: Double?
}
func L(_ key: String) -> String { key }
func L(_ key: String, _ params: [String: CustomStringConvertible]) -> String {
    var s = key
    for (k, v) in params { s = s.replacingOccurrences(of: "{" + k + "}", with: v.description) }
    return s
}
`;
  const blocks = [
    "struct ArchiveEntry: Identifiable, Hashable, Sendable {",
    "struct ArchiveInventory: Sendable {",
    "struct ArchiveGroups: Sendable {",
    "enum ArchiveQuestion {",
    "struct ArchiveNotices: Sendable {",
  ].map(swiftBlock).join("\n\n");
  const folder = FOLDER.map((o) => `    ChatFolder(id: ${swiftLit(o.id)}, name: ${swiftLit(o.name)}, archivedAt: ${optNum(o.archivedAt)}),`).join("\n");
  const chats = CHATS.map((c) => `    ArchiveEntry(id: ${swiftLit(c.id)}, title: ${swiftLit(c.title)}, folderId: ${optLit(c.folderId)}, projectId: nil, archivedAt: ${c.archivedAt}),`).join("\n");
  const main = `
let inventory = ArchiveInventory(chats: [
${chats}
], folder: [
${folder}
])
let groups = ArchiveGroups(inventory)
for (i, q) in [${SEARCH.map(swiftLit).join(", ")}].enumerated() {
    let g = groups.filtered(q)
    for o in g.folder { print("G\\t\\(i)\\tO\\t\\(o.id)\\t" + o.chats.map(\\.id).joined(separator: ",")) }
    for l in g.loose { print("G\\t\\(i)\\tL\\t\\(l.chat.id)\\t\\(l.label)") }
}

let questions: [(String, Int?, Int?)] = [
${QUESTIONS.map(([n, c, m]) => `    (${swiftLit(n)}, ${optNum(c)}, ${optNum(m)}),`).join("\n")}
]
for (i, f) in questions.enumerated() {
    print("F\\t\\(i)\\t" + (ArchiveQuestion.folderDelete(name: f.0, chats: f.1, contextFiles: f.2) ?? "<no question>"))
}

// Two notices BEFORE the next render: the reader sees them together with the old state 0.
var m = ArchiveNotices()
let prior = m.revision
m.report(["A"])
m.report(["B", "C"])
print("M\\tstate\\t\\(m.revision)")
for (id, since) in [("A", prior), ("B", prior), ("C", prior), ("X", prior), ("A", 1), ("B", 1), ("B", 2)] {
    print("M\\t\\(id)@\\(since)\\t\\(m.named(id, since: since))")
}
let afterEmpty = m.revision
m.report([])
print("M\\tempty\\t\\(m.revision)\\t\\(m.named("B", since: afterEmpty))")
`;
  fs.writeFileSync(file, mocks + blocks + "\n" + main);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  const out = { G: new Map(), F: new Map(), M: new Map() };
  for (const z of output.split("\n").filter(Boolean)) {
    const t = z.split("\t");
    if (t[0] === "G") {
      const k = Number(t[1]);
      if (!out.G.has(k)) out.G.set(k, []);
      out.G.get(k).push(t.slice(2).join("\t"));
    } else out[t[0]]?.set(t[1], t.slice(2).join("\t"));
  }
  measured = out;
  return out;
}

after(() => {
  for (const d of [tmpTs, tmpSwift]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } }
});

test("ArchiveGroups (Swift) groups, sorts and searches like archiveGroups/archiveSearch (lib/archive.ts)", async () => {
  const web = await tsPage();
  const sw = swiftPage();
  const deviations = [];
  let rows = 0;
  SEARCH.forEach((q, i) => {
    const t = tsRows(web, q);
    const s = sw.G.get(i) ?? [];
    rows += t.length;
    if (JSON.stringify(t) !== JSON.stringify(s)) deviations.push(`search ${JSON.stringify(q)}\n    web:   ${t.join(" | ")}\n    Swift: ${s.join(" | ")}`);
  });
  // Without content the equation of two empty lists would be a green test without a statement.
  assert.ok(rows > SEARCH.length, `the seed yielded hardly any rows (${rows}); does the comparison still measure anything?`);
  assert.ok((sw.G.get(0) ?? []).some((z) => z.startsWith("O\tfl\t")), "the empty archived folder is missing; the seed no longer covers it");
  console.log(`  [archive] ${SEARCH.length} searches, ${rows} rows: web == Swift`);
  assert.deepEqual(deviations, [], `archive groups diverge:\n  ${deviations.join("\n  ")}`);
});

test("the sentence of the folder delete question (Swift) == folderDeleteQuestion (lib/archive.ts): singular \"is\", plural \"are\", unknown numbers", async () => {
  const web = await tsPage();
  const sw = swiftPage();
  QUESTIONS.forEach(([name, chats, contextFiles, expected], i) => {
    const counts = {};
    if (chats !== null) counts.chats = chats;
    if (contextFiles !== null) counts.contextFiles = contextFiles;
    const w = web.folderDeleteQuestion(counts, name) ?? "<no question>";
    const s = sw.F.get(String(i));
    assert.equal(w, expected ?? "<no question>", `case ${i} (web)`);
    assert.equal(s, w, `case ${i}: Swift deviates from the web`);
  });
});

test("ArchiveNotices: two notices before a render, and both chats are \"named since the old state\"", () => {
  const { M } = swiftPage();
  assert.equal(M.get("state"), "2");
  assert.equal(M.get("A@0"), "true", "the FIRST notice was lost (the old replaced id set)");
  assert.equal(M.get("B@0"), "true");
  assert.equal(M.get("C@0"), "true");
  assert.equal(M.get("X@0"), "false", "a never-named chat counts as named");
  assert.equal(M.get("A@1"), "false", "a notice BEFORE the old state counts as new: every later event would reload the chat");
  assert.equal(M.get("B@1"), "true");
  assert.equal(M.get("B@2"), "false");
  assert.equal(M.get("empty"), "3\tfalse", "an empty notice counts, but names nobody");
});

// A test for the folder reload and `ArchiveKind` stood here until the managing teardown; the computation went with the manager list.
