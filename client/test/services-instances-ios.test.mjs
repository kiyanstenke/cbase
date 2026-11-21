// The iOS rules for instances in the services pill.
// Without Xcode: the binding is by TEXT (like the web ↔ iOS section of web/test/statusBar.test.mjs); the one pure rule
// (`ServicesRules.group`) is read from the Swift text, translated to JS and run against a table. ONE test really
// executes Swift (`xcrun swift`, macOS only; on Linux its title is listed under `onlyMacOS.tests` in
// tools/check/latch.json): copy target, instance name, path of the removal, instance groups.
//
// The promises and what breaks them:
//  · A group only from TWO instances on (a project with main alone stays as before). Counter-check: `count >= 2` to
//    `count >= 1` in ServicesStatus.swift ⇒ "group" red.
//  · The UI reads `instances` only through this rule: any other place in ServicesButton.swift reading `.instances` is a
//    detour. Counter-check: `ServicesRules.groupRows(row.instances)` replaced by `row.instances ?? []` ⇒ "detour" red.
//  · The fields are OPTIONAL (an older server and a project with one instance omit them): `try?` + `decodeIfPresent`,
//    never a hard decoder. Counter-check: `decodeIfPresent` to `decode` ⇒ "fields" red.
//  · Removing only for a copy, only after confirmation, on the copy's route, under the copy's NAME (`k1` from
//    `p1/copy-k1`); NO switchover. The button is absent while a copy is already being removed.
//  · Every new text has its dictionary entry.
//  · ONE place for the DELETE of a copy: `CopyDeleteModel.erase` (Code/CopyDelete.swift). Pill and apps page open the
//    same sheet (`CopyDeleteSheet`) and send no request to the copy themselves; the last test reads EVERY Swift file of
//    the app for a DELETE that names `stack-copies` elsewhere.
//
// What this guard CANNOT do: compile the whole app, see the view, tap the dialog.
//
// Run:  cd client && node --test test/services-instances-ios.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const APP = "mobile/CbaseMobile";
const read = (r) => fs.readFileSync(path.join(repo, r), "utf8");
// Strip comment lines (// and ///), strings stay — enough for the anchors here.
const withoutComments = (t) => t.split("\n").map((z) => (/^\s*\/\//.test(z) ? "" : z)).join("\n");

const rules = withoutComments(read(`${APP}/Shell/ServicesStatus.swift`));
const button = withoutComments(read(`${APP}/Shell/ServicesButton.swift`));
const models = withoutComments(read(`${APP}/Models/ServiceModels.swift`));
const sheet = withoutComments(read(`${APP}/Code/CopyDelete.swift`));

// Body of a Swift function or type: from the header to the matching closing brace.
function body(source, header) {
  const i = source.indexOf(header);
  assert.ok(i >= 0, `${header} not found — renamed? Update the anchor here, do NOT delete the test.`);
  const on = source.indexOf("{", i);
  let depth = 0;
  for (let j = on; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && !--depth) return source.slice(on + 1, j).trim();
  }
  assert.fail(`${header}: the brace does not close`);
}

test("group: only from two instances on — the rule from the Swift text, executed", () => {
  const expression = body(rules, "static func group(count: Int) -> Bool");
  assert.ok(!/\b(let|var|guard|nil|return)\b/.test(expression), `group is more than an expression — update the translation here: ${expression}`);
  const group = new Function("count", `"use strict"; return (${expression});`);
  const table = [[0, false], [1, false], [2, true], [3, true], [10, true]];
  for (const [n, desired] of table) assert.equal(group(n), desired, `${n} instances: group ${desired ? "yes" : "no"}`);
  // The group's rows go through the same rule; a missing field is not a group.
  const rows = body(rules, "static func groupRows(_ raw: [ProjectInstance]?) -> [ProjectInstance]");
  assert.match(rows, /guard let raw, group\(count: raw\.count\) else \{ return \[\] \}/, "groupRows does not ask the rule");
  assert.match(rows, /return raw$/, "groupRows does not return the instances");
});

test("detour: `instances` is only read through the rule (resource group, where services run)", () => {
  const places = [...button.matchAll(/^.*\.instances\b.*$/gm)].map((m) => m[0].trim());
  assert.equal(places.length, 2, `ServicesButton.swift reads \`.instanzen\` at ${places.length} places (expected 2):\n  ${places.join("\n  ")}`);
  assert.ok(places.some((z) => /ServicesRules\.groupRows\(row\.instances\)/.test(z)), "the resource group does not read `instances` through groupRows");
  assert.ok(places.some((z) => /service\.instances, ServicesRules\.group\(count: list\.count\)/.test(z)), "the run location does not read `instances` through group(count:)");
});

test("fields: decoded optionally, never hard — and exactly the fields of the JSON contract", () => {
  assert.match(models, /var instances: \[ServiceInstance\]\?/);
  assert.match(models, /var instances: \[ProjectInstance\]\?/);
  assert.match(models, /instances = \(try\? c\.decodeIfPresent\(\[ServiceInstance\]\.self, forKey: \.instances\)\) \?\? nil/, "ProjectServiceRow does not decode `instances` tolerantly");
  assert.match(models, /instances = \(try\? c\.decodeIfPresent\(\[ProjectInstance\]\.self, forKey: \.instances\)\) \?\? nil/, "ProjectResourceRow does not decode `instances` tolerantly");
  const fields = (type) => [...body(models, `struct ${type}: Codable`).matchAll(/^\s*var (\w+): [\w[\]?]+\s*$/gm)].map((m) => m[1]);
  // /api/project-services: per service instances: [{identifier, running, holdsStart}] — with `holdsStart` (the start
  // guard of THIS instance) the apps page offers "Stop" instead of a "Start" that would end in a 409. Missing ⇒ false.
  assert.deepEqual(fields("ServiceInstance"), ["identifier", "running", "holdsStart"]);
  assert.match(body(models, "struct ServiceInstance: Codable"), /holdsStart = c\.bool\(\.holdsStart, false\)/, "holdsStart (missing ⇒ false)");
  // /api/project-resources: per project instances: [{identifier, name, dnsName, chatId, chatTitle, state, cpu, memBytes,
  // containers}] — the apps page reads "running" from `containers` (the instance's running containers).
  assert.deepEqual(fields("ProjectInstance"), ["identifier", "name", "dnsName", "chatId", "chatTitle", "state", "cpu", "memBytes", "containers"]);
  // Every field is read with the tolerant helper (a missing field never empties the list).
  const decoding = body(models, "struct ProjectInstance: Codable");
  for (const f of ["identifier", "name", "dnsName", "state"]) assert.match(decoding, new RegExp(`${f} = c\\.str\\(\\.${f}\\)`), f);
  for (const f of ["chatId", "chatTitle"]) assert.match(decoding, new RegExp(`${f} = c\\.strOpt\\(\\.${f}\\)`), f);
  for (const f of ["cpu", "memBytes"]) assert.match(decoding, new RegExp(`${f} = c\\.dbl\\(\\.${f}\\)`), f);
  assert.match(decoding, /containers = c\.intOpt\(\.containers\)/, "containers (missing on older servers ⇒ nil)");
});

test("removing: only a copy, only after confirmation, on the copy's route — and no switchover", () => {
  // The route (stacks/routes.js): DELETE /api/projects/:pid/stack-copies/:name.
  const routes = read("server/backend/electron/server/stacks/routes.js");
  assert.match(routes, /DELETE \/api\/projects\/:pid\/stack-copies\/:name/, "the copy's route has a different name — update iOS");
  const model = body(sheet, "func erase() async -> String?");
  assert.match(model, /client\.send\("\/api\/projects\/\\\(target\.project\)\/stack-copies\/\\\(target\.name\)", method: \.delete\)/, "path or method differ from the route");
  assert.match(model, /guard let target = ServicesRules\.copyTarget\(identifier: identifier\) else/, "main could be removed (no check before the request)");
  // Main is not a copy: an identifier without a slash and `<project>/main` yield no target.
  const target = body(rules, "static func copyTarget(identifier: String) -> (project: String, name: String)?");
  for (const anchor of [/identifier\.lastIndex\(of: "\/"\)/, /name != "main"/, /!project\.isEmpty/, /!name\.isEmpty/]) assert.match(target, anchor, String(anchor));
  // The button exists only for a copy; it opens the delete sheet, the call happens only in its destructive confirmation.
  assert.match(button, /\.sheet\(item: \$toClearAway\) \{ instance in\s*if let client = state\.client \{\s*CopyDeleteSheet\(client: client, identifier: instance\.identifier\)/,
    "\"Remove\" does not open the tab's delete sheet (CopyDeleteSheet)");
  assert.equal([...button.matchAll(/CopyDeleteSheet\(/g)].length, 1, "the pill opens the delete sheet in more than one place");
  assert.doesNotMatch(button + rules, /stack-copies/, "the pill sends a request to the copy itself again — the DELETE belongs in the sheet");
  assert.doesNotMatch(button, /\.confirmationDialog\(/, "the pill's old own confirmation is still there");
  // The button exists only while the copy is not already being removed — otherwise "being removed" takes its place.
  assert.match(button, /if ServicesRules\.copyTarget\(identifier: instance\.identifier\) != nil \{\s*if ServicesRules\.offerClearAway\(state: instance\.state\) \{\s*Button \{\s*toClearAway = instance/,
    "the remove button also shows for main or for a copy being removed, or it does not ask first");
  const otherwise = button.slice(button.indexOf("if ServicesRules.offerClearAway(state: instance.state) {"));
  assert.match(otherwise, /\} else \{\s*Text\(L\("being removed"\)\)/, "the button's place does not say \"being removed\"");
  // The confirmation's message is the rule with the web's wording.
  assert.match(sheet, /Text\(verbatim: ServicesRules\.clearAwayHint\(name: model\.name\)\)/,
    "the delete sheet does not say what stays and what goes (ServicesRules.clearAwayHint)");
  const hint = body(rules, "static func clearAwayHint(name: String) -> String");
  assert.match(hint, /are kept in the main instance under copy\/\{name\}\/…\./, "the hint does not say where commits and open changes stay");
  assert.match(hint, /Docker volumes/);
  assert.match(hint, /ignored files/);
  assert.doesNotMatch(button, /Die Kopie wird entfernt, sobald sie leer ist/, "the old confirmation is still in the pill");
  assert.match(sheet, /Button\(L\("Delete copy"\), role: \.destructive\) \{\s*Task \{\s*if let text = await model\.erase\(\)/, "the call is not in the confirmation's destructive button");
  assert.equal([...sheet.matchAll(/model\.erase\(/g)].length, 1, "erase is called in more than one place — only the confirmation may");
  // NO switchover — iOS has no port forwarding.
  assert.doesNotMatch(button + rules, /umschalt|selectInstance|ports:waehle/i, "iOS switches instances — there must be no switchover");
});

test("texts: every new key has its dictionary entry and is used as L(…) in the code", () => {
  // Both dictionaries: L(…) looks in LocDEBase AND LocDEMobile (mobile/tools/loc-audit.sh).
  const dictionary = read(`${APP}/Kit/LocDEMobile.swift`) + read(`${APP}/Kit/LocDEBase.swift`) + read(`${APP}/Kit/LocDEInstances.swift`);
  // Title, button and success sentence of the old confirmation are gone with it; the sheet carries its own.
  const key = [
    "Instances", "Main", "in {instances}", "Remove copy",
    "Commits and open changes are kept in the main instance under copy/{name}/…. Lost are the data in the copy's Docker volumes and its ignored files (e.g. .env, build output) — only the report lists them.",
    "being removed",
    "Removing “{name}” failed: {msg}", "The main instance is never removed.",
    "Delete copy", "Delete copy “{name}”",
  ];
  const code = button + rules + sheet;
  for (const k of key) {
    assert.ok(dictionary.includes(`"${k}":`), `LocDE dictionaries: key "${k}" is missing — the German screen would show English`);
    assert.ok(code.includes(`L("${k}"`), `"${k}" is no longer used as L(…) in the code — the key is dead`);
  }
});

// ── Executed Swift ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The text guard above only holds the TEMPLATE of the path; which name goes in was unchecked. The server delivers the
// identifier `p1/copy-k1` (instance `copy-k1`), the route looks up the name `k1`. So `copyTarget`, the displayed instance
// name and the path template of the DELETE are cut from the Swift sources, assembled into a program with stubs and REALLY
// executed with `xcrun swift`. If the toolchain is missing on a Mac the test fails loudly; on Linux its title is in
// tools/check/latch.json under `onlyMacOS.tests` (the rest of the file still runs there).
// Also: the instance group (and with it the only remove button on iOS) must not depend on services running IN MAIN —
// hence one rule `ServicesRules.instanceGroups` over ALL resource rows (executed below) and a section of its own.
const ON_MAC = process.platform === "darwin";

// A whole block from the header to its closing brace (header included) — to cut out for xcrun swift.
function block(source, header) {
  const i = source.indexOf(header);
  assert.ok(i >= 0, `${header} not found — renamed? Update the anchor here, do NOT delete the test.`);
  const on = source.indexOf("{", i + header.length);
  let depth = 0;
  for (let j = on; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && !--depth) return source.slice(i, j + 1);
  }
  assert.fail(`${header}: the brace does not close`);
}
const swiftLit = (s) => JSON.stringify(s);

// Identifier → [project, name, path] (null = not a copy) and the displayed name. The server's form: an instance is
// called `main` or `copy-<name>`; anything else is not a copy — never guess.
const COPIES = [
  ["p1/copy-k1", ["p1", "k1", "/api/projects/p1/stack-copies/k1"], "k1"],
  ["p1/copy-k12", ["p1", "k12", "/api/projects/p1/stack-copies/k12"], "k12"],
  ["a/b/copy-k2", ["a/b", "k2", "/api/projects/a/b/stack-copies/k2"], "k2"],
  ["p1/main", null, "Main"],
  ["p1/k1", null, "p1/k1"],
  ["p1/copy-", null, "p1/copy-"],
  ["p1/copy-main", null, "p1/copy-main"],
  ["copy-k1", null, "copy-k1"],
  ["/copy-k1", null, "/copy-k1"],
];
const IG_HEADER = "static func instanceGroups(_ resources: [ProjectResourceRow]) -> [ProjectResourceRow]";
// Per state, whether "Remove" is offered — the same table as in the web: only the removing state takes the button; error,
// ready, the build states and an empty state (older server) leave it.
const AA_HEADER = "static func offerClearAway(state: String) -> Bool";
const CLEAR_AWAY_PER_STATE = [["clearAway", false], ["ready", true], ["error", true], ["create", true], ["start", true], ["", true]];

let swiftResult = null;
function runSwift() {
  if (swiftResult) return swiftResult;
  const parts = [
    block(rules, "static func group(count: Int) -> Bool"),
    block(rules, "static func groupRows(_ raw: [ProjectInstance]?) -> [ProjectInstance]"),
    block(rules, "static func copyTarget(identifier: String) -> (project: String, name: String)?"),
  ];
  const withGroups = rules.includes(IG_HEADER);
  if (withGroups) parts.push(block(rules, IG_HEADER));
  const withOffer = rules.includes(AA_HEADER);
  if (withOffer) parts.push(block(rules, AA_HEADER));
  const filePath = /client\.send\(("[^"\n]*"), method: \.delete\)/.exec(body(sheet, "func erase() async -> String?"));
  assert.ok(filePath, "CopyDeleteModel.erase: the path template of the DELETE can no longer be found — update the anchor");
  const groupsDriver = withGroups
    ? `let rows = [
    ProjectResourceRow(projectId: "without", instances: nil),
    ProjectResourceRow(projectId: "empty", instances: []),
    ProjectResourceRow(projectId: "one", instances: [ProjectInstance(identifier: "one/main")]),
    ProjectResourceRow(projectId: "two", instances: [ProjectInstance(identifier: "two/main"), ProjectInstance(identifier: "two/copy-k1")]),
    ProjectResourceRow(projectId: "three", instances: [ProjectInstance(identifier: "three/main"), ProjectInstance(identifier: "three/copy-k1"), ProjectInstance(identifier: "three/copy-k2")]),
]
print("IG\\t" + ServicesRules.instanceGroups(rows).map(\\.projectId).joined(separator: ","))`
    : `print("IG\\tfehlt")`;
  const program = `
func L(_ s: String) -> String { s }
struct ProjectInstance { var identifier: String }
struct ProjectResourceRow { var projectId: String; var instances: [ProjectInstance]? }
enum ServicesRules {
${parts.join("\n")}
}
${block(button, "func servicesInstanceName(_ identifier: String) -> String")}
let identifiers: [String] = [${COPIES.map(([k]) => swiftLit(k)).join(", ")}]
for k in identifiers {
    if let target = ServicesRules.copyTarget(identifier: k) {
        print("Z\\t\\(k)\\t\\(target.project)\\t\\(target.name)\\t" + ${filePath[1]})
    } else {
        print("Z\\t\\(k)\\t-")
    }
    print("N\\t\\(k)\\t" + servicesInstanceName(k))
}
${groupsDriver}
${withOffer
    ? `for z in [${CLEAR_AWAY_PER_STATE.map(([z]) => swiftLit(z)).join(", ")}] { print("AA\\t" + z + "\\t" + (ServicesRules.offerClearAway(state: z) ? "yes" : "no")) }`
    : `print("AA\\tfehlt")`}
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-services-ios-"));
  const file = path.join(dir, "rules.swift");
  fs.writeFileSync(file, program);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be executed (xcrun swift): ${e.stderr || e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const out = { Z: new Map(), N: new Map(), IG: null, AA: new Map() };
  for (const z of output.split("\n").filter(Boolean)) {
    const t = z.split("\t");
    if (t[0] === "Z") out.Z.set(t[1], t[2] === "-" ? null : t.slice(2));
    else if (t[0] === "N") out.N.set(t[1], t.slice(2).join("\t"));
    else if (t[0] === "IG") out.IG = t[1] ?? "";
    else if (t[0] === "AA") out.AA.set(t[1], t[2] ?? null);
  }
  swiftResult = out;
  return out;
}

test("Swift executed: p1/copy-k1 removes /stack-copies/k1 and is named k1 — only `copy-<name>` is a copy; groups from two instances across ALL rows", (t) => {
  if (!ON_MAC) { t.skip("xcrun swift exists only on macOS"); return; }
  const out = runSwift();
  for (const [identifier, target, name] of COPIES) {
    assert.deepEqual(out.Z.get(identifier), target, `copyTarget(${identifier}): ${target ? `project ${target[0]}, name ${target[1]}, path ${target[2]}` : "no copy (no DELETE)"}`);
    assert.equal(out.N.get(identifier), name, `servicesInstanceName(${identifier})`);
  }
  assert.notEqual(out.IG, "missing", "ServicesRules.instanceGroups is missing — the group would still depend on the resources section");
  assert.equal(out.IG, "two,three", "instanceGroups: exactly the rows with two or more instances, in their order");
  // Only a copy being removed loses the button.
  assert.ok(!out.AA.has("missing"), "ServicesRules.offerClearAway is missing — the button would only depend on copyTarget");
  for (const [state, desired] of CLEAR_AWAY_PER_STATE) {
    assert.equal(out.AA.get(state), desired ? "yes" : "no", `offerClearAway(${JSON.stringify(state)}): ${desired ? "Button" : "\"being removed\""}`);
  }
});

test("instance group independent of the resources section: from all resource rows, never under \"running services in main\"", () => {
  // The resources section exists only with services running IN MAIN — the group must not be inside it.
  const res = body(button, "private func resources(_ sum: ServicesRules.Sum?) -> some View");
  assert.doesNotMatch(res, /instancesGroup\(/, "the instance group is in the resources section again — without a running service in main it would be missing (and removing with it)");
  // The groups come from ALL resource rows (not only from rows that have containers).
  assert.match(button, /ServicesRules\.instanceGroups\(model\.resources\)/, "the groups do not come from ServicesRules.instanceGroups(model.resources)");
  // No call sits in a branch whose condition depends on the resources section or on the running services.
  const calls = [...button.matchAll(/instancesGroup\(|instancesSection\(|ServicesRules\.instanceGroups\(/g)].map((m) => m.index)
    .filter((i) => !button.slice(Math.max(0, i - 20), i).includes("func "));
  assert.ok(calls.length >= 3, `too few calls found (${calls.length}) — update the anchor`);
  for (const m of button.matchAll(/\bif ([^{\n]*)\{/g)) {
    if (!/resourcesSection|running|abschnitt/i.test(m[1])) continue;
    const on = m.index + m[0].length - 1;
    let depth = 0;
    let to = -1;
    for (let j = on; j < button.length; j++) {
      if (button[j] === "{") depth++;
      else if (button[j] === "}" && !--depth) { to = j; break; }
    }
    for (const a of calls) assert.ok(!(a > on && a < to), `the instance group is in the branch \`if ${m[1].trim()}\` — it would depend on the running services in main`);
  }
});

// ── ONE place for the DELETE of a copy ───────────────────────────────────────────────────────────────────────────────────────────
// The guard below looks for every method `.delete` (also `HTTPMethod.delete`, `method: .delete`) in every Swift file of
// the app, cuts out the call it is in (the parenthesis before it up to its closing one), and counts it as a DELETE on a
// copy if it names `stack-copies` or a variable of the same file that is assigned a path with `stack-copies`. What it
// does NOT see: a path passed across file boundaries or assembled from parts.
const APP_ROOT = path.join(repo, APP);
function swiftFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...swiftFiles(full));
    else if (e.name.endsWith(".swift")) out.push(full);
  }
  return out;
}

// The call in whose parentheses position `i` sits: from the open parenthesis before it to its closing one
// (interpolations `\(…)` are balanced and do not interfere). null if the position is in no parenthesis.
function callAround(source, i) {
  let depth = 0;
  let on = -1;
  for (let j = i - 1; j >= 0; j--) {
    if (source[j] === ")") depth++;
    else if (source[j] === "(") {
      if (depth === 0) { on = j; break; }
      depth--;
    }
  }
  if (on < 0) return null;
  depth = 0;
  for (let j = on; j < source.length; j++) {
    if (source[j] === "(") depth++;
    else if (source[j] === ")" && !--depth) return source.slice(on, j + 1);
  }
  return source.slice(on);
}

// Per file the DELETE calls on a copy: [{ file, call }].
function copyDeletes() {
  const hits = [];
  for (const file of swiftFiles(APP_ROOT)) {
    const source = withoutComments(fs.readFileSync(file, "utf8"));
    if (!/stack-copies/.test(source)) continue;
    const pathNames = [...source.matchAll(/\b(?:let|var)\s+(\w+)\s*(?::\s*String\s*)?=\s*"[^"\n]*stack-copies/g)].map((m) => m[1]);
    for (const m of source.matchAll(/\.delete\b/g)) {
      const call = callAround(source, m.index);
      if (!call) continue;
      if (/stack-copies/.test(call) || pathNames.some((n) => new RegExp(`\\b${n}\\b`).test(call))) {
        hits.push({ file: path.relative(APP_ROOT, file), call: call.replace(/\s+/g, " ").slice(0, 160) });
      }
    }
  }
  return hits;
}

test("one place for the DELETE of a copy: only CopyDeleteModel.erase — apps page and pill open the sheet", () => {
  const hits = copyDeletes();
  const foreign = hits.filter((t) => t.file !== "Code/CopyDelete.swift");
  assert.deepEqual(foreign, [], `DELETE on stack-copies outside Code/CopyDelete.swift — removing belongs in the delete sheet (CopyDeleteSheet):\n  ${foreign.map((t) => `${t.file}: ${t.call}`).join("\n  ")}`);
  assert.equal(hits.length, 1, `expected exactly ONE DELETE on stack-copies in the app (CopyDeleteModel.erase), found ${hits.length} — update the anchor if the call was rebuilt`);
  // The apps page opens the sheet (like the pill) and has no confirmation of its own; the sheet reports back.
  const apps = withoutComments(read(`${APP}/Shell/AppsPage.swift`));
  assert.match(apps, /\.sheet\(item: \$toClearAway\) \{ target in\s*CopyDeleteSheet\(client: model\.client, identifier: target\.identifier\) \{ set in\s*model\.clearAwayAssigned\(target\.identifier, set: set\)/,
    "the apps page does not open the delete sheet (CopyDeleteSheet) when removing");
  assert.equal([...apps.matchAll(/CopyDeleteSheet\(/g)].length, 1, "the apps page opens the delete sheet in more than one place");
  assert.doesNotMatch(apps, /\.confirmationDialog\(/, "the apps page has a confirmation of its own again — it belongs in the delete sheet");
  assert.doesNotMatch(apps, /stack-copies/, "the apps page names the copy's route itself again");
});
