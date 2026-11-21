// The pure rules of the services pill (src/lib/services-status.ts). No browser: the source is compiled with the local tsc and
// imported, the real module text is checked.
//
// Why these are guards and not taste:
//  · The COLOUR is a statement about the machine. An edge that slips by a thousandth (">=" instead of ">") colours yellow at
//    exactly 70 %, and no type error says so. Hence the four edges 0.7 / 0.7001 / 0.9 / 0.9001 one by one.
//  · Swap does NOT count. A full swap next to free RAM is everyday on Linux; whoever adds it as a fourth input colours the
//    pill yellow permanently. The iOS revision is bound to exactly these inputs — the list `STAGES_INLETS` is therefore checked itself.
//  · "Empty is not unknown": without a machine value there is NO stage (`null`, neutral), and without a measured container there
//    is NO sum (`null`, no numbers) — never "0 % · 0 B".
//  · "measured: x of n" says openly how many of the running services are in the sum. A service without a container (host port only)
//    or in a project without a measured row does not count.
//
// Counter-tests (each red once): in `stageFrom` ">" to ">=" => "Edges" red; `swap` as a fourth candidate in `machineLevel` =>
// "Swap does not count" red; `servicesSum` returns `{cpu:0,…}` instead of `null` => "Sum null without container" red; `measured`
// without the container condition => "measured" red; `performanceTone` colouring warn only with services => "Performance tone" red;
// a runtime import in the leaf => the whole file red (Node no longer loads the compiled module — the leaf test is the named form of
// the same promise). The shares per input and "measured: 0 of n": the clamp `Math.max(0, …)` struck in `loadShare` => "Shares" red;
// `measureRow` without the condition `!loaded` => "measureRow" red; `measureRow` only with `measured > 0` (no row without a
// measurement) => "measureRow" red.
// Three promises of the pill once stood inline in ServicesPill.tsx without a way that breaks them — now one function each in the leaf:
// A) in `runningInScope` the project part `(!pid || d.projectId === pid)` struck => "Scope" red (3 instead of 2 in the project); the
//    workspace part struck => "Scope" red (a foreign workspace counts); `d.running` struck => "Scope" red (the stopped one counts);
// B) `triggerContent` always returns the number (`count: n`) => "Trigger" red ("0" at the trigger); `counts` without the count
//    condition => "Trigger" red (CPU/RAM next to "No services running");
// C) `machineRow` returns "" => "Tooltip" red (the reason of the colour is missing).
// The two ticks in the MENU: `resourcesSection` without the count condition (the old state `sum || measurement`) => "Resources
// section" red (CPU/RAM per project under "No services running."); without the measureRow (`count > 0 && sum != null`) => red
// ("measured: 0 of n" would vanish).
//
// Instances per project: the group exists only FROM TWO instances (`instanceGroups`), its heading is "Main · k1 (Chat X)", clearing
// away works only for a copy (never the main, never without a path), and the pill calls it via the identifier. Counter-tests:
// `instanceGroups` with `l.length >= 1` instead of `>= 2` => "Group only from two" red (group from one instance); `clearable`
// shortened to `!!i.name` (BOTH barriers `i.name !== MAIN_NAME` and `identifier.endsWith("/copy-…")` gone; each alone stays green, they
// secure each other) => "Clearing away" red (the main could be cleared away); `clearAwayResult` with `status === 202` to `status < 500`
// => "Result" red (a 409 would count as accepted).
//
// `switchoverPorts` and `occupiedOfText` fell with the exclusive choice; their lessons are carried by `instancePorts` (a service only
// in the copy belongs to the ports of the COPY) and `instanceTitle` (main => project name, copy => "<project> · k1 (Chat X)").
//
// EXCLUSIVE CHOICE (a radio button under the services pill: which project forwards the ports, below it the ports of the activated
// project). The rules of the pill in the leaf: `choiceRows` (projects of the ACTIVE workspace with port services, per main and living
// copy, the active one from another workspace appended, null before loading), `instancePorts` (running port services of THIS
// instance), `activeBySituation` (fallback: copy gone => main, project gone => "None", unknown => stays),
// `activeRows`/`needsBringAlong`/`otherForwardings`/`serviceStatus` (what stands under the choice and when the pill catches up).
// The rules which forwarding ends stand in the client (client/test/forwarding-rules.test.mjs).
// Counter-tests (each red once):
//   instancePorts       `d.running === true || state?.running === true` (the state of ANY instance, the computation of the old
//                      `switchoverPorts`) => "instancePorts" and "choiceRows" red (the main would get the port of the copy);
//   instanceTitle       the search over the group struck => "instanceTitle" red ("Checkout · k1" without chat);
//   choiceRows         without the condition `converted` => "choiceRows" red (a project mid-move would be up for choice);
//   activeBySituation      a deleted project "stays" => "Fallback" red;
//   needsBringAlong  "occupied" catches up => "Under the choice" red (a call per tick that does nothing);
//   ServicesPill.tsx    `choose(identifier, ports)` without `{ mode: "exclusive" }` => "Pill (by path), choice" red (the client
//                      would switch instead of ending the old choice); the lock "one attempt per state" struck => likewise.
//   choiceRows         the condition "project of the active instance" in the main loop struck => "choiceRows" red (a project
//                      without port service and without copy stood as `foreign` at the end); `foreign` again `true` for every
//                      appended row => likewise;
//   ServicesPill.tsx    `{ mode: target.mode }` without `ifActive: active` => "Pill (by path), choice" red.
//
// `choiceServices` computes the state per instance via `serviceInInstance` (start protection also in the copy, unknown is not
// stopped), `clearable` reads the state (never during `clearingAway`, then "is being cleared away"), `copyResource` takes the state
// from /api/projects, the question says what stays and what goes. Counter-tests:
//   choiceServices        the old computation (`main &&` in holds, missing entry = false) => "choiceServices" red; only `main &&`
//                      back => likewise; `running ?? false` => likewise;
//   clearable          the old computation (without state) => "Clearing away per state" red;
//   copyResource     the state from /api/projects ignored => "Not ready copy" red;
//   clearAwayQuestion     the old wording => "Question of clearing away" red;
//   ServicesPill.tsx    ▶ at `!d.running` => "Pill (by path), choice" red; without reload after 202 => "Pill (by path), instances" red; the
//                      group without "is being cleared away" => likewise.
//
// "Clear away" in the pill opens the SAME dialog as the instances tab (projects/InstanceDialogs.tsx `CopyDelete`: delete preview,
// 409 INSTANCE_WORKING with the chats). The question is thus no `ask(…)` of the pill any more, but the dialog — it carries
// `clearAwayQuestion` as a hint, and the DELETE stands ONLY in its delete button (`deleteCopy` in `const doDelete`). The pill sends no
// DELETE any more; it shows the ACCEPTED result (`clearAwayResult(202, …)`) and reloads at once. The test "Pill (by path), instances"
// holds that at these places; the counter-tests stand in the header of web/test/instances-ui.test.mjs.
//
// Run:  node --test web/test/services-status.test.mjs
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
const source = path.join(webDir, "src", "lib", "services-status.ts");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-services-status-"));
execFileSync(process.execPath, [
  tsc, source, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const {
  MACHINE_WARN, MACHINE_DANGER, STAGES_INLETS, stageFrom, machineLevel, servicesSum, measured,
  performanceTone, fmtBytes, sumText, ramCapacity, counts, ramShare, loadShare, diskShare, swapShare, measureRow,
  runningInScope, triggerContent, machineRow, tooltipRows, resourcesSection,
  forwardingKey, instancePerProject, projectOfTheInstance, serviceInstance, portRows,
  nullForwardingTarget, assignForwardings, forwardingsToLift,
  instanceGroups, instanceDesignation, groupsTitle, runningPerInstance, clearable, clearAwayPath, clearAwayQuestion,
  clearAwayResult, instanceMeasurement, projectOfTheIdentifier, copyResource, instanceTitle, instancePorts, choiceRows, activeBySituation,
  activeRows, otherForwardings, needsBringAlong, serviceStatus, choiceServices, copyNotReady, getsClearedAway,
  choiceServicesVisible, otherBesideTheList, notReadySet,
  CBASE_KINDS, cbasePart, progressBarParts, cbaseValueText,
} = await import(pathToFileURL(path.join(out, "services-status.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

const GB = 2 ** 30;
// A machine whose three inputs can be set one by one: RAM/disk as share OCCUPIED, load per core.
const calculator = ({ ram = 0.1, load = 0.1, disk = 0.1, swap = 0.0, cores = 4, withDisk = true, withSwap = true } = {}) => ({
  at: 1,
  cpu: { count: cores, load1: load * cores, load5: 0, load15: 0 },
  mem: { totalBytes: 16 * GB, availableBytes: 16 * GB * (1 - ram) },
  swap: withSwap ? { totalBytes: 4 * GB, freeBytes: 4 * GB * (1 - swap) } : null,
  disk: withDisk ? { path: "/", totalBytes: 500 * GB, freeBytes: 500 * GB * (1 - disk) } : null,
});
const row = (projectId, containers, cpu = 0, memBytes = 0, extra = {}) => ({
  projectId, name: projectId, dockerUp: true, containers, cpu, memBytes, memLimitBytes: 0, diskBytes: null, ...extra,
});
const service = (projectId, container, port = null) => ({ projectId, name: `${projectId}-svc`, port, container });

test("Thresholds: 70 % and 90 % — the same as rings and bars in the house", () => {
  assert.equal(MACHINE_WARN, 0.7);
  assert.equal(MACHINE_DANGER, 0.9);
});

test("Edges: strictly greater — 0.7 ok, 0.7001 warn, 0.9 warn, 0.9001 danger", () => {
  const cases = [[0, "ok"], [0.7, "ok"], [0.7001, "warn"], [0.9, "warn"], [0.9001, "danger"], [1.43, "danger"]];
  for (const [share, expected] of cases) assert.equal(stageFrom(share), expected, `stageFrom(${share})`);
  // The same edges through each of the three inputs — the edge must not be right at only one.
  for (const kind of ["ram", "load", "disk"]) {
    for (const [share, expected] of cases) {
      const r = machineLevel(calculator({ ram: 0, load: 0, disk: 0, [kind]: share }));
      assert.equal(r.stage, expected, `${kind} = ${share}`);
    }
  }
});

test("Stage: the HIGHEST of the three inputs decides — and the stage names it with value", () => {
  const ram = machineLevel(calculator({ ram: 0.92, load: 0.2, disk: 0.5 }));
  assert.equal(ram.stage, "danger");
  assert.equal(ram.kind, "ram");
  assert.ok(Math.abs(ram.share - 0.92) < 1e-9);
  assert.ok(Math.abs(ram.occupied - 0.92 * 16 * GB) < 1, "occupied is the OCCUPIED (total − available), not the free");
  assert.equal(ram.total, 16 * GB);
  const load = machineLevel(calculator({ ram: 0.2, load: 1.43, disk: 0.5 }));
  assert.equal(load.kind, "load");
  assert.equal(load.stage, "danger", "load above 100 % per core is the statement, not a display error");
  assert.equal(load.occupied, undefined, "load has no byte figure");
  const disk = machineLevel(calculator({ ram: 0.2, load: 0.2, disk: 0.75 }));
  assert.equal(disk.kind, "disk");
  assert.equal(disk.stage, "warn");
  assert.equal(disk.total, 500 * GB);
  // Tie: the earlier input in STAGES_INLETS wins.
  assert.equal(machineLevel(calculator({ ram: 0.5, load: 0.5, disk: 0.5 })).kind, "ram");
});

test("Swap does not count — the three inputs are RAM, load, disk", () => {
  assert.deepEqual([...STAGES_INLETS], ["ram", "load", "disk"]);
  const r = machineLevel(calculator({ ram: 0.1, load: 0.1, disk: 0.1, swap: 0.99 }));
  assert.equal(r.stage, "ok", "a full swap next to free RAM does not colour");
  assert.notEqual(r.kind, "swap");
  const withoutSwap = machineLevel(calculator({ ram: 0.1, load: 0.1, disk: 0.1, withSwap: false }));
  assert.deepEqual(withoutSwap, r, "with and without swap the same stage");
});

test("null without machine — and an input without denominator drops out instead of counting as 0", () => {
  assert.equal(machineLevel(null), null);
  assert.equal(machineLevel(undefined), null);
  // None of the three inputs has a denominator => no claim.
  const empty = { at: 1, cpu: { count: 0, load1: 3, load5: 0, load15: 0 }, mem: { totalBytes: 0, availableBytes: 0 }, swap: null, disk: null };
  assert.equal(machineLevel(empty), null);
  // Only the disk measured: it alone decides.
  const onlyDisk = { ...empty, disk: { totalBytes: 100, freeBytes: 5 } };
  assert.equal(machineLevel(onlyDisk).kind, "disk");
  assert.equal(machineLevel(onlyDisk).stage, "danger");
  // Broken numbers (NaN) are no measurement.
  const broken = { ...empty, mem: { totalBytes: NaN, availableBytes: 1 } };
  assert.equal(machineLevel(broken), null);
});

test("Shares: ONE function per input (machineLevel and the machine block call it) — null without denominator, never below 0", () => {
  const h = calculator({ ram: 0.25, load: 0.5, disk: 0.75, swap: 0.5 });
  assert.ok(Math.abs(ramShare(h) - 0.25) < 1e-9);
  assert.ok(Math.abs(loadShare(h) - 0.5) < 1e-9);
  assert.ok(Math.abs(diskShare(h) - 0.75) < 1e-9);
  assert.ok(Math.abs(swapShare(h) - 0.5) < 1e-9, "swap stands in the leaf — for the display only");
  // Clamp at 0: available > total, free > total, a negative load (broken report).
  assert.equal(ramShare({ ...h, mem: { totalBytes: 10, availableBytes: 12 } }), 0);
  assert.equal(diskShare({ ...h, disk: { totalBytes: 10, freeBytes: 11 } }), 0);
  assert.equal(swapShare({ ...h, swap: { totalBytes: 10, freeBytes: 11 } }), 0);
  assert.equal(loadShare({ ...h, cpu: { count: 4, load1: -1, load5: 0, load15: 0 } }), 0, "the machine block did not clamp the load");
  // Without denominator null — "not measured", not "empty".
  assert.equal(ramShare({ ...h, mem: { totalBytes: 0, availableBytes: 0 } }), null);
  assert.equal(loadShare({ ...h, cpu: { count: 0, load1: 1, load5: 0, load15: 0 } }), null);
  assert.equal(diskShare({ ...h, disk: null }), null);
  assert.equal(swapShare({ ...h, swap: null }), null);
  assert.equal(ramShare({ ...h, mem: { totalBytes: NaN, availableBytes: 1 } }), null);
  // The stage computes with the same numbers.
  for (const kind of ["ram", "load", "disk"]) {
    const hh = calculator({ ram: 0, load: 0, disk: 0, [kind]: 0.93 });
    const fn = { ram: ramShare, load: loadShare, disk: diskShare }[kind];
    assert.equal(machineLevel(hh).share, fn(hh), kind);
  }
});

test("Sum: only rows with containers — and null without containers, never \"0 % · 0 B\"", () => {
  assert.equal(servicesSum([]), null);
  assert.equal(servicesSum(null), null);
  assert.equal(servicesSum([row("a", 0, 5, 100), row("b", 0, 1, 1)]), null, "rows without containers do not count");
  assert.equal(sumText(null), null);
  const s = servicesSum([row("a", 2, 12.34, 1.5 * GB), row("b", 0, 99, 99 * GB), row("c", 1, 0.07, 0.5 * GB)]);
  assert.equal(s.cpu, 12.4, "CPU to one decimal place, only over counting rows");
  assert.equal(s.memBytes, 2 * GB);
  assert.deepEqual(s.projects.map((r) => r.projectId), ["a", "c"]);
  assert.equal(sumText(s), "12.4 % · 2.0 GB");
  assert.equal(counts(row("x", 1)), true);
  assert.equal(counts(row("x", 0)), false);
});

test("measured: container AND counting row — total is all passed running services", () => {
  const resources = [row("a", 2, 1, 1), row("b", 0)];
  const services = [
    service("a", "a-web", 3000), // measured
    service("a", "a-db"),        // measured (container without host port)
    service("a", "", 8080),      // port service without container: never measured
    service("b", "b-web", 3001), // project without counting row
    service("c", "c-web"),       // project without any row
  ];
  assert.deepEqual(measured(services, resources), { measured: 2, total: 5 });
  assert.deepEqual(measured(services, []), { measured: 0, total: 5 });
  assert.deepEqual(measured(services, null), { measured: 0, total: 5 });
  assert.deepEqual(measured([], resources), { measured: 0, total: 0 });
  assert.deepEqual(measured([service("a", "   ")], resources), { measured: 0, total: 1 }, "a space is no container");
});

test("measureRow: \"measured: 0 of n\" stands also without any measurement — but not before the first answer", () => {
  assert.deepEqual(measureRow({ measured: 0, total: 3 }, true), { measured: 0, total: 3 }, "no service measured: the row says so instead of staying silent");
  assert.deepEqual(measureRow({ measured: 1, total: 3 }, true), { measured: 1, total: 3 });
  assert.equal(measureRow({ measured: 3, total: 3 }, true), null, "all measured: nothing open to say");
  assert.equal(measureRow({ measured: 0, total: 0 }, true), null, "no services: no row");
  assert.equal(measureRow({ measured: 0, total: 3 }, false), null, "before the answer of the resources query no statement about a measurement");
  // Through the real chain: running services, no counting row => no sum, but the row.
  const services = [service("a", "a-web", 3000), service("b", "", 8080)];
  const resources = [row("a", 0), row("b", 0)];
  assert.equal(servicesSum(resources), null, "without measurement no numbers");
  assert.deepEqual(measureRow(measured(services, resources), true), { measured: 0, total: 2 });
});

test("Performance tone: only the machine colours — warn/danger, else neutral; the number of services does not enter", () => {
  // The colour belongs to the performance entry — and there ONLY the machine's: no colour as a permanent state (not even an accent
  // for "services are running").
  const st = (stage) => ({ stage, kind: "ram", share: 0.5 });
  assert.equal(performanceTone(null), "neutral", "without machine value no claim");
  assert.equal(performanceTone(st("ok")), "neutral", "ok is no reason for colour");
  assert.equal(performanceTone(st("warn")), "warn", "above 70 %: yellow");
  assert.equal(performanceTone(st("danger")), "danger", "above 90 %: red");
  assert.equal(performanceTone.length, 1, "performanceTone takes only the stage — the number of services does not colour (otherwise a full server without services of its own would hide its colour)");
  // Through the real chain: RAM 92 % occupied => danger; 75 % => warn; 50 % => neutral.
  assert.equal(performanceTone(machineLevel(calculator({ ram: 0.92 }))), "danger");
  assert.equal(performanceTone(machineLevel(calculator({ ram: 0.75 }))), "warn");
  assert.equal(performanceTone(machineLevel(calculator({ ram: 0.5 }))), "neutral");
});

test("Scope: running, in the workspace and — with an entered project — in the project; without workspace none", () => {
  // The same situation as the iOS test (ShellUITests: 2 in the project, 3 in the workspace), plus the edges.
  const raw = (id, workspaceId, projectId, running = true) => ({ id, workspaceId, projectId, running, name: `s${id}` });
  const all = [
    raw(1, "ws1", "P"), raw(2, "ws1", "P"),   // in project P
    raw(3, "ws1", "Q"),                        // in the workspace, another project
    raw(4, "ws1", "P", false),                 // stopped
    raw(5, "ws2", "P"),                        // foreign workspace, same project id
    raw(6, null, "P"),                         // without workspace
  ];
  const ids = (l) => l.map((d) => d.id);
  assert.deepEqual(ids(runningInScope(all, "ws1", "P")), [1, 2], "entered project: only its running services");
  assert.deepEqual(ids(runningInScope(all, "ws1", null)), [1, 2, 3], "whole workspace: all running of the workspace");
  assert.deepEqual(ids(runningInScope(all, "ws1", "")), [1, 2, 3], "empty project means whole workspace");
  assert.deepEqual(ids(runningInScope(all, "ws2", null)), [5]);
  assert.deepEqual(ids(runningInScope(all, "ws9", null)), [], "unknown workspace: none");
  assert.deepEqual(ids(runningInScope(all, null, null)), [], "without workspace NO scope — not the services with workspaceId null");
  assert.deepEqual(ids(runningInScope(all, undefined, "P")), []);
  assert.deepEqual(runningInScope(null, "ws1", null), [], "no services yet: empty list, no throw");
  assert.equal(runningInScope(all, "ws1", "P")[0], all[0], "the same objects — the pill reads further fields from them");
});

test("Trigger: number and CPU/RAM only from one running service — at 0 no number, no numbers, muted", () => {
  const sum = servicesSum([row("a", 2, 12.34, 1.5 * GB), row("c", 1, 0.07, 0.5 * GB)]);
  assert.deepEqual(triggerContent(3, sum), { count: 3, counts: "12.4 % · 2.0 GB", muted: false });
  assert.deepEqual(triggerContent(1, null), { count: 1, counts: null, muted: false }, "unmeasured: the number, no CPU/RAM counts");
  // The two ticks: resources (15 s) report the new container before the services (30 s) see it running.
  assert.deepEqual(triggerContent(0, sum), { count: null, counts: null, muted: true },
    "0 services: NO number (not \"0\") and NO CPU/RAM counts — otherwise \"● · 12.4 % · 2.0 GB\" next to \"No services running\"");
  assert.deepEqual(triggerContent(0, null), { count: null, counts: null, muted: true });
  assert.equal(triggerContent(Number.NaN, sum).count, null, "a broken count is no number at the trigger");
});

test("Resources section: only with running services — then with sum OR measureRow", () => {
  const sum = servicesSum([row("a", 2, 12.34, 1.5 * GB)]);
  const open = { measured: 0, total: 3 };
  assert.equal(resourcesSection(3, sum, null), true, "measured, all in the sum: the section with numbers");
  assert.equal(resourcesSection(3, sum, { measured: 1, total: 3 }), true);
  assert.equal(resourcesSection(3, null, open), true, "none measured: the section with \"measured: 0 of 3\", without numbers");
  assert.equal(resourcesSection(3, null, null), false, "before the answer of the resources: nothing");
  // The two ticks: the resources report the freshly started container before the services list it as running — then the block
  // with sum stood under "No services running.".
  assert.equal(resourcesSection(0, sum, null), false, "0 running services: NO resources block, even if the resources already measure");
  assert.equal(resourcesSection(0, null, null), false);
  assert.equal(resourcesSection(Number.NaN, sum, null), false, "a broken count is no running one");
  // Through the real chain: n = 0 => measureRow is null (total 0), the sum alone does not carry the block.
  const resList = [row("a", 1, 3, 210 * 2 ** 20)];
  const sample = measureRow(measured([], resList), true);
  assert.equal(sample, null);
  assert.equal(resourcesSection(0, servicesSum(resList), sample), false);
  // And the same count as at the trigger: where the section stands, a number stands at the trigger too.
  for (const n of [0, 1, 3]) for (const s of [null, sum]) for (const m of [null, open]) {
    if (resourcesSection(n, s, m)) assert.notEqual(triggerContent(n, s).count, null, `(${n}, ${!!s}, ${!!m})`);
  }
});

test("Tooltips (ports and performance separated): ports — number and scope, then the forwardings; performance — \"Performance · scope\", then at every stage the reason of the colour", () => {
  // Translator like `useT` in English: key = text, markers replaced. A missing marker stays visible.
  const t = (k, w = {}) => k.replace(/\{(\w+)\}/g, (_, n) => (n in w ? String(w[n]) : `{${n}}`));
  assert.equal(tooltipRows({ count: 0, scopeName: "", stage: null, forwarded: 0 }, t).ports, "No services running");
  assert.equal(tooltipRows({ count: 0, scopeName: "", stage: null, forwarded: 0 }, t).performance, "Performance");
  assert.equal(tooltipRows({ count: 1, scopeName: "Examplecorp", stage: null, forwarded: 0 }, t).row1, "1 service running · Examplecorp");
  const three = tooltipRows({ count: 3, scopeName: "Examplecorp › Portal", stage: null, forwarded: 0 }, t);
  assert.equal(three.row1, "3 services running · Examplecorp › Portal");
  assert.equal(three.row2, "", "without machine value no second row — no claim");
  assert.equal(three.ports, three.row1, "empty rows do not stand in the tooltip");
  assert.equal(three.performanceRow, "Performance · Examplecorp › Portal");
  assert.equal(three.performance, three.performanceRow, "without machine value the performance tooltip names no reason");
  // Every stage through every input: the second row names the input and its percentage.
  const word = { ram: "RAM", load: "load", disk: "disk" };
  for (const kind of ["ram", "load", "disk"]) {
    for (const [share, expected] of [[0.5, "ok"], [0.75, "warn"], [0.93, "danger"]]) {
      const stage = machineLevel(calculator({ ram: 0.05, load: 0.05, disk: 0.05, [kind]: share }));
      assert.equal(stage.stage, expected);
      assert.equal(stage.kind, kind);
      const z = tooltipRows({ count: 3, scopeName: "Examplecorp", stage, forwarded: 0 }, t);
      assert.equal(z.row2, machineRow(stage, t));
      assert.ok(z.row2.startsWith(`Machine: ${word[kind]} ${Math.round(share * 100)}%`),
        `${kind} ${expected}: the second row does not name the reason of the colour — "${z.row2}"`);
      assert.ok(!/\{\w+\}/.test(z.row2), `${kind}: a marker stayed unreplaced — "${z.row2}"`);
      assert.equal(z.performance.split("\n")[1], z.row2, "the second row of the performance tooltip IS the reason");
      // Separated: the reason of the colour stands ONLY at the performance entry, the number of services ONLY at the ports
      // entry — no longer 2 in 1.
      assert.ok(!z.ports.includes(z.row2), `the ports tooltip names the machine — "${z.ports}"`);
      assert.ok(!z.performance.includes(z.row1), `the performance tooltip names the number of services — "${z.performance}"`);
    }
  }
  const ram = machineRow(machineLevel(calculator({ ram: 0.92, load: 0.1, disk: 0.1 })), t);
  assert.equal(ram, "Machine: RAM 92% in use (15 GB / 16 GB)", "RAM names occupied and total");
  assert.equal(machineRow(null, t), "");
  const withPorts = tooltipRows({ count: 2, scopeName: "", stage: null, forwarded: 2 }, t);
  assert.equal(withPorts.ports, "2 services running\n2 port(s) forwarded");
  assert.ok(!withPorts.performance.includes("forwarded"), "the forwardings belong to the ports entry");
});

test("fmtBytes with null branch and ramCapacity backward compatible — as in the old ResourcesPill", () => {
  assert.equal(fmtBytes(null), "—");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(1.4 * GB), "1.4 GB");
  assert.equal(fmtBytes(456 * GB), "456 GB");
  // Old backend: shared limit added once PER container => divided. New: marked.
  assert.equal(ramCapacity(row("a", 4, 0, 0, { memLimitBytes: 8 * GB })), 2 * GB);
  assert.equal(ramCapacity(row("a", 4, 0, 0, { memLimitBytes: 8 * GB, memLimitShared: true })), 8 * GB);
  assert.equal(ramCapacity(row("a", 1, 0, 0, { memLimitBytes: 8 * GB })), 8 * GB);
  assert.equal(ramCapacity(row("a", 3, 0, 0, { memLimitBytes: 0 })), 0);
});

// ── The share of cbase in the server ─────────────────────────────────────────────────────────────
// The bar shows how much of the server's resources cbase claims (the part cbase claims is coloured differently). Counter-tests
// (each red once): the clamp `Math.min(occupied, …)` struck => "cbase part" red (the part would stand beyond the occupied); a
// `null` field read as 0 (`value ?? 0`) => likewise red (a part 0 instead of none); `progressBarParts` measures the cbase part
// against the TRACK instead of the occupied => "Bar" red.
const withCbase = (h, cbase) => ({ ...h, cbase: { at: 1, diskAt: 1, ...cbase } });

test("cbase part: value / total, clamped to the occupied — per kind; without state, without denominator or with null field no part, 0 is one", () => {
  assert.deepEqual([...CBASE_KINDS], ["ram", "load", "swap", "disk"]);
  const h = withCbase(calculator({ ram: 0.5, load: 0.5, disk: 0.4, swap: 0.25, cores: 4 }),
    { memBytes: 4 * GB, cpuCores: 1, swapBytes: 0.5 * GB, diskBytes: 50 * GB });
  const near = (x, y, what) => assert.ok(Math.abs(x - y) < 1e-9, `${what}: ${x} instead of ${y}`);
  near(cbasePart(h, "ram").share, 4 / 16, "RAM 4 of 16 GB");
  assert.equal(cbasePart(h, "ram").value, 4 * GB);
  near(cbasePart(h, "load").share, 1 / 4, "CPU 1 of 4 cores");
  near(cbasePart(h, "swap").share, 0.5 / 4, "swap 0.5 of 4 GB");
  near(cbasePart(h, "disk").share, 50 / 500, "disk 50 of 500 GB");
  // Clamp: cbase measures more than occupied (working set against MemAvailable) => the part ends at the occupied, the number stays.
  const much = withCbase(calculator({ ram: 0.2, load: 0.1, cores: 4 }), { memBytes: 8 * GB, cpuCores: 2, swapBytes: null, diskBytes: null });
  near(cbasePart(much, "ram").share, 0.2, "RAM clamped");
  assert.equal(cbasePart(much, "ram").value, 8 * GB, "the number is the measured one");
  near(cbasePart(much, "load").share, 0.1, "CPU clamped to the load");
  // null field (not measured) => no part — never a part 0. Per kind (the first answer of the gateway has no CPU, the disk
  // comes only after the first background measurement).
  assert.equal(cbasePart(much, "swap"), null);
  assert.equal(cbasePart(much, "disk"), null);
  const unmeasured = withCbase(calculator({ ram: 0.5, load: 0.5, disk: 0.5, swap: 0.5 }), { memBytes: null, cpuCores: null, swapBytes: null, diskBytes: null });
  for (const kind of CBASE_KINDS) assert.equal(cbasePart(unmeasured, kind), null, `${kind}: null is "not measured", no part 0`);
  // 0 is measured: a part of width 0.
  assert.deepEqual(cbasePart(withCbase(calculator(), { memBytes: 0, cpuCores: 0, swapBytes: 0, diskBytes: 0 }), "ram"), { share: 0, value: 0 });
  // Without cbase state (local, old gateway), without machine, without denominator: no part.
  for (const kind of CBASE_KINDS) {
    assert.equal(cbasePart(calculator(), kind), null, `${kind} without cbase`);
    assert.equal(cbasePart({ ...calculator(), cbase: null }, kind), null, `${kind} with cbase null`);
    assert.equal(cbasePart(null, kind), null);
  }
  const withoutDenominator = withCbase({ ...calculator({ withSwap: false, withDisk: false }), mem: { totalBytes: 0, availableBytes: 0 }, cpu: { count: 0, load1: 1, load5: 0, load15: 0 } },
    { memBytes: 1, cpuCores: 1, swapBytes: 1, diskBytes: 1 });
  for (const kind of CBASE_KINDS) assert.equal(cbasePart(withoutDenominator, kind), null, `${kind} without denominator`);
  // Broken numbers are no measurement.
  assert.equal(cbasePart(withCbase(calculator(), { memBytes: NaN, cpuCores: -1, swapBytes: null, diskBytes: null }), "ram"), null);
  assert.equal(cbasePart(withCbase(calculator(), { memBytes: NaN, cpuCores: -1, swapBytes: null, diskBytes: null }), "load"), null);
});

test("Bar: the occupied in % of the track (capped), in it cbase in % of the occupied — one-part without cbase", () => {
  assert.deepEqual(progressBarParts(0.5, null), { width: 50, cbase: null });
  assert.deepEqual(progressBarParts(0.5, undefined), { width: 50, cbase: null });
  assert.deepEqual(progressBarParts(0.5, 0.25), { width: 50, cbase: 50 });
  assert.deepEqual(progressBarParts(0.8, 0), { width: 80, cbase: 0 });
  assert.deepEqual(progressBarParts(0.4, 0.4), { width: 40, cbase: 100 });
  // Load above the cores: the bar is full, the ratio cbase : occupied stays (1 of 2 => half).
  assert.deepEqual(progressBarParts(2, 1), { width: 100, cbase: 50 });
  // Nothing occupied: no part of the width; broken numbers like 0.
  assert.deepEqual(progressBarParts(0, 0), { width: 0, cbase: 0 });
  assert.deepEqual(progressBarParts(NaN, 0.1), { width: 0, cbase: 0 });
  assert.deepEqual(progressBarParts(-1, null), { width: 0, cbase: null });
  // The clamp applies here too, in case a caller came unclamped.
  assert.deepEqual(progressBarParts(0.25, 0.5), { width: 25, cbase: 100 });
});

test("Text behind \"cbase\": bytes for RAM, swap, disk — for the CPU percent of the cores like the load above it", () => {
  const h = withCbase(calculator({ ram: 0.5, load: 0.9, cores: 4 }), { memBytes: 3.6 * GB, cpuCores: 0.61, swapBytes: 0, diskBytes: 53.8 * GB });
  assert.equal(cbaseValueText(h, "ram", cbasePart(h, "ram")), "3.6 GB");
  assert.equal(cbaseValueText(h, "load", cbasePart(h, "load")), "15%", "0.61 of 4 cores");
  assert.equal(cbaseValueText(h, "swap", cbasePart(h, "swap")), "0 B");
  assert.equal(cbaseValueText(h, "disk", cbasePart(h, "disk")), "54 GB");
});

// ── Forwarding per instance ───────────────────────────────────────────────────────────────────
// Counter-tests (each red once): `instancePerProject` without `converted` => "Instance per project" red (a project mid-move would
// get the forwarding into an empty container); `portRows` by port instead of by (namespace, port) => "Port list" red (the service in
// B would read "running" because a project container listens on the same port). The exclusive choice knows no conflict, only
// "not the active instance".
const P_A = "p-a/main";
const P_B = "p-b/main";
const projects = [
  { id: "p-a", name: "Alpha", instance: { identifier: P_A, converted: true } },
  { id: "p-b", name: "Beta", instance: { identifier: P_B, converted: true } },
  { id: "p-c", name: "Gamma", instance: { identifier: "p-c/main", converted: false } },
  { id: "p-d", name: "Delta" },
];

test("Instance per project: only CONVERTED projects have one; without an answer it is \"unknown\", not \"none\"", () => {
  const m = instancePerProject(projects);
  assert.deepEqual([...m.entries()], [["p-a", P_A], ["p-b", P_B]], "a project mid-move (converted: false) still lives in B");
  assert.equal(instancePerProject(null), null);
  assert.equal(instancePerProject(undefined), null);
  assert.deepEqual([...instancePerProject([]).entries()], []);
  // The instance of a service: only with a client that knows instances, and only after the answer.
  assert.equal(serviceInstance(m, "p-a", true), P_A);
  assert.equal(serviceInstance(m, "p-c", true), null);
  assert.equal(serviceInstance(m, "p-a", false), null, "a client before instance support does not know the parameter — the pill stays by port");
  assert.equal(serviceInstance(null, "p-a", true), null);
  assert.equal(projectOfTheInstance(projects, P_B), "Beta");
  assert.equal(projectOfTheInstance(projects, null), null);
  assert.equal(projectOfTheInstance(projects, "p-x/main"), null);
  // The same key as in the client (client/forwarding-rules.js forwardingKey).
  assert.equal(forwardingKey(P_A, 3000), "p-a/main:3000");
  assert.equal(forwardingKey(null, 3000), ":3000");
  assert.equal(forwardingKey(undefined, 3000), ":3000");
});

// Counter-tests (each red once): `assignForwardings` without the assignment of the null forwarding (each stays `instance: null`) =>
// "null forwarding" red (Alpha's own forwarding would stand among the foreign ones and never be lifted). The assignment stays for a
// client from before the choice.
test("null forwarding (remembered before instances): belongs to the ONE project that holds the port; two => honestly \"without project\"; B stays B", () => {
  const inst = instancePerProject(projects);
  const old = { port: 3000, localPort: 3000, connections: 0, instance: null };
  // Alpha runs alone on 3000 (the state after the move): the old forwarding is Alpha's — no conflict, nothing foreign,
  // and the client should lift it onto Alpha's instance.
  const onlyAlpha = [{ projectId: "p-a", port: 3000, running: true }, { projectId: "p-b", port: 8000, running: true }];
  assert.deepEqual(nullForwardingTarget(onlyAlpha, inst, 3000), { kind: "instance", instance: P_A });
  const z1 = assignForwardings([old], onlyAlpha, inst);
  assert.deepEqual(z1, [{ f: old, instance: P_A, withoutProject: false }]);
  assert.deepEqual(forwardingsToLift(z1), [{ port: 3000, instance: P_A }]);
  // A STOPPED service holds nothing.
  assert.deepEqual(nullForwardingTarget([...onlyAlpha, { projectId: "p-b", port: 3000, running: false }], inst, 3000), { kind: "instance", instance: P_A });
  // If Alpha already has its own forwarding on 3000, the old one stays without assignment and is not lifted.
  const real = { port: 3000, localPort: 3001, connections: 0, instance: P_A };
  const z2 = assignForwardings([old, real], onlyAlpha, inst);
  assert.deepEqual(z2.map((z) => [z.instance, z.withoutProject]), [[null, true], [P_A, false]]);
  assert.deepEqual(forwardingsToLift(z2), []);
  // Alpha AND Beta on 3000: the tunnel without instance ends in B — both rows see a conflict, honestly labelled.
  const both = [{ projectId: "p-a", port: 3000, running: true }, { projectId: "p-b", port: 3000, running: true }];
  const z3 = assignForwardings([old], both, inst);
  assert.deepEqual(z3, [{ f: old, instance: null, withoutProject: true }]);
  assert.deepEqual(forwardingsToLift(z3), []);
  // A project in B (Delta) on 3000: the forwarding is B's — for Alpha a conflict with ANOTHER project.
  const withB = [...both, { projectId: "p-d", port: 3000, running: true }];
  const z4 = assignForwardings([old], withB, inst);
  assert.deepEqual(z4, [{ f: old, instance: null, withoutProject: false }], "for Delta (B) it is its own");
  // Nobody holds the port: without project.
  assert.deepEqual(nullForwardingTarget([], inst, 3000), { kind: "without" });
});

test("without projects no assignment: before or without an answer of /api/projects nothing is lifted", () => {
  const own = { port: 3000, localPort: 3000, connections: 0, instance: P_A };
  // As long as `projects` is null, every service has "no instance" — an assignment from that would lift wrongly.
  assert.equal(nullForwardingTarget([{ projectId: "p-a", port: 3000, running: true }], null, 3000), null);
  assert.deepEqual(assignForwardings([own], [], null), [{ f: own, instance: P_A, withoutProject: false }], "a forwarding WITH instance stays its own");
  assert.deepEqual(forwardingsToLift(assignForwardings([{ ...own, instance: null }], [{ projectId: "p-a", port: 3000, running: true }], null)), []);
});

test("Port list: per (namespace, port) — the same port in B and in a project container are two rows with their own state", () => {
  const instances = instancePerProject(projects);
  const services = [
    { id: 1, projectId: "p-d", port: 3000 },   // Delta: in B
    { id: 2, projectId: "p-a", port: 3000 },   // Alpha: in the project container
    { id: 3, projectId: "p-b", port: 3000 },   // Beta: in the project container
    { id: 4, projectId: "p-d", port: null },
  ];
  // 3000 is open only at Alpha, plus an unknown port 9999 at Beta.
  const open = [{ port: 3000, instance: P_A, registered: null }, { port: 9999, instance: P_B, registered: null }];
  const findings = [{ kind: "unregistered", port: 9999, instance: P_B }, { kind: "unregistered", port: 9999, instance: null }];
  const rows = portRows({ services, open, findings, instances, conflictPorts: new Set([3000]) });
  assert.deepEqual(rows.map((r) => [r.port, r.instance, r.claims.map((c) => c.id), r.open, r.conflict]), [
    [3000, null, [1], false, true],
    [3000, P_A, [2], true, false],
    [3000, P_B, [3], false, false],
    [9999, P_B, [], true, false],
  ], "the service in B would read \"running\" because a project container listens on the same port — or a conflict of B would count in an instance");
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "two rows carry the same key (React key)");
  assert.equal(rows[1].info, open[0]);
  assert.deepEqual(rows[3].unreg, findings[0], "the finding does not hang on the row of its namespace");
  // Without an answer of /api/projects (null): by port as before — an open port in any namespace counts.
  const old = portRows({ services, open, findings, instances: null, conflictPorts: new Set([3000]) });
  assert.deepEqual(old.map((r) => [r.port, r.instance, r.claims.map((c) => c.id), r.open, r.conflict]), [
    [3000, null, [1, 2, 3], true, true],
    [9999, null, [], true, false],
  ]);
  // Before the first scan: open unknown (null), not "not running".
  assert.deepEqual(portRows({ services, open: null, instances, conflictPorts: new Set() }).map((r) => r.open), [null, null, null]);
});

test("Pill (by path): the forwarding goes to the instance of the service, stop names the instance, without choice as before", () => {
  const pill = fs.readFileSync(path.join(webDir, "src", "components", "pills", "ServicesPill.tsx"), "utf8");
  assert.ok(/const assigned = assignForwardings\(forwards, all, canInstance \? instances : null\);/.test(pill),
    "the pill assigns forwardings without instance to no project (finding 1)");
  assert.ok(/new Map\(assigned\.map\(/.test(pill) && /const foreignForwards = assigned\.filter\(/.test(pill),
    "row and \"Forwarded\" read the raw forwardings — the own old one would stand as a foreign one");
  assert.ok(/void b\.lift\(h\.port, h\.instance\)/.test(pill) && /forwardingsToLift\(assignForwardings\(forwards, all, inst\)\)/.test(pill),
    "the pill does not lift an assigned forwarding onto its instance (client before the choice)");
  assert.ok(/if \(!canInstance \|\| canChoice \|\| !b\?\.lift \|\| !inst \|\| all === null\) return;/.test(pill),
    "with the choice the pill still lifts — a forwarding by hand would not stay as it was created");
  assert.ok(/disabled=\{busy === d\.port \|\| \(canInstance && !instances\)\}/.test(pill),
    "\"Forward\" goes out without instance before the answer of /api/projects (finding 5)");
  assert.ok(/if \(alive && Array\.isArray\(l\)\) \{ projectsLoaded\.current = true; setProjects\(l\); \}/.test(pill),
    "\"loaded\" also stands after a failure (finding 5)");
  assert.ok(/onClick=\{\(\) => doForward\(d\.port!, inst\)\}/.test(pill), "\"Forward\" of a service goes without its instance");
  assert.ok(/await b\.forward\(port, undefined, instance\)/.test(pill), "doForward does not pass the instance to the bridge");
  assert.equal([...pill.matchAll(/bridge\(\)\?\.stop\(f\.port\)/g)].length, 0, "a stop without instance would hit the forwarding of B instead of the intended one");
  assert.ok(/typeof bridge\(\)\?\.select === "function"/.test(pill), "the version switch (client without instances) is missing");
  // No mark "in the project container".
  assert.ok(!/project container|projectbox|\bconverted\b|\bmoved\b/i.test(pill.replace(/^\s*\/\/.*$/gm, "")), "the pill shows which project has been moved (no surface for that)");
});

test("Leaf: services-status.ts imports nothing but types", () => {
  const text = fs.readFileSync(source, "utf8");
  const imports = [...text.matchAll(/^\s*import\s+(?!type\b)[^;]*;/gm)].map((m) => m[0].trim());
  assert.deepEqual(imports, [], "the leaf imports at runtime — then this test no longer runs without a browser");
});

// ── Instances per project ─────────────────────────────────────────────────────────────────────────────────────────────────
const ti = (k, w) => (w ? k.replace(/\{(\w+)\}/g, (_, n) => String(w[n])) : k);
const main = { identifier: "p1/main", name: "main", dnsName: "till.cbase", chatId: "", chatTitle: "", state: "ready", cpu: 1, memBytes: 100 };
const copy = { identifier: "p1/copy-k1", name: "k1", dnsName: "till-k1.cbase", chatId: "c1", chatTitle: "Chat X", state: "ready", cpu: 3.2, memBytes: 2048 };

test("Group only from two instances — no statement, null, one, two, three", () => {
  const z = (instances) => row("p1", 1, 0, 0, instances === undefined ? {} : { instances });
  assert.deepEqual(instanceGroups(null), []);
  assert.deepEqual(instanceGroups(undefined), []);
  assert.deepEqual(instanceGroups([z(undefined)]), [], "without `instances` (the server sends nothing for one instance) no group");
  assert.deepEqual(instanceGroups([z([])]), []);
  assert.deepEqual(instanceGroups([z([main])]), [], "ONE instance is no group");
  const two = instanceGroups([z([main, copy]), row("p2", 1, 0, 0, { instances: [main] })]);
  assert.equal(two.length, 1);
  assert.equal(two[0].projectId, "p1");
  assert.deepEqual(two[0].instances, [main, copy]);
  assert.equal(instanceGroups([z([main, copy, { ...copy, identifier: "p1/copy-k2", name: "k2" }])])[0].instances.length, 3);
  // An entry without identifier does not count: [main, broken] are not two.
  assert.deepEqual(instanceGroups([z([main, { name: "k9" }])]), []);
});

test("Designation and heading: \"Main · k1 (Chat X)\", the copy without chat title only with its name", () => {
  assert.equal(instanceDesignation(main, ti), "Main");
  assert.equal(instanceDesignation(copy, ti), "k1 (Chat X)");
  assert.equal(instanceDesignation({ ...copy, chatTitle: "" }, ti), "k1");
  assert.equal(groupsTitle({ projectId: "p1", name: "Checkout", instances: [main, copy] }, ti), "Main · k1 (Chat X)");
  assert.equal(instanceMeasurement(copy), "3.2 % · 2.0 KB");
  assert.equal(instanceMeasurement({ identifier: "p1/main", name: "main" }), "");
});

test("Clearing away: only a copy, never the main — the path is the DELETE of the copy, else null", () => {
  assert.equal(clearable(main), false, "the main cannot be cleared away");
  assert.equal(clearable(copy), true);
  assert.equal(clearable({ identifier: "p1/main", name: "k1" }), false, "name and identifier must fit together");
  assert.equal(clearAwayPath("p1", main), null, "no call goes out for the main");
  assert.equal(clearAwayPath("p1", copy), "/api/projects/p1/stack-copies/k1");
  assert.equal(clearAwayPath("", copy), null);
  assert.equal(clearAwayPath("a/b", copy), "/api/projects/a%2Fb/stack-copies/k1");
  assert.match(clearAwayQuestion(copy, "Checkout", ti), /k1 \(Chat X\).*Checkout/);
});

// "Clear away" also stood at a copy that had already been cleared away — a second click got the same question and "accepted". The
// button now hangs on the state; the path of the DELETE does not.
test("Clearing away per state: not during `clearAway` — then \"is being removed\"; error, ready and a missing state stay clearable", () => {
  const including = (state) => ({ ...copy, state });
  assert.equal(clearable(including("clearAway")), false, "a copy being cleared away offers \"Clear away\"");
  assert.equal(getsClearedAway(including("clearAway")), true);
  for (const z of ["ready", "error", "create", "start", "", undefined]) {
    assert.equal(clearable(including(z)), true, `state ${JSON.stringify(z)} stays clearable (error: new call; empty is not "clearAway")`);
    assert.equal(getsClearedAway(including(z)), false, `state ${JSON.stringify(z)}`);
  }
  // The main never — not even with a state "clearAway" ("is being removed" applies only to a copy).
  assert.equal(clearable({ ...main, state: "clearAway" }), false);
  assert.equal(getsClearedAway({ ...main, state: "clearAway" }), false);
  assert.equal(getsClearedAway(null), false);
  // The path of the DELETE stays at the name rule (the route itself says what happens to a copy being cleared away).
  assert.equal(clearAwayPath("p1", including("clearAway")), "/api/projects/p1/stack-copies/k1");
  assert.equal(clearAwayPath("p1", { ...main, state: "clearAway" }), null);
});

// The question promised loss ("Your changes that are not yet in the main instance are lost") although clearing away brings everything
// versioned under copy/<name>/… into the main — and did not name the two real losses.
test("Question of clearing away: what stays (copy/<name>/… in the main) and what goes (volumes, ignored files)", () => {
  const f = clearAwayQuestion(copy, "Checkout", ti);
  assert.match(f, /^Remove copy k1 \(Chat X\) of Checkout\?/);
  assert.match(f, /are kept in the main instance under copy\/k1\/…/, "the question does not say where commits and open changes stay");
  assert.match(f, /Docker volumes/, "the loss of the volumes is missing");
  assert.match(f, /ignored files/, "the loss of the ignored files is missing");
  assert.doesNotMatch(f, /not in the main instance yet are lost/, "the question promises loss across the board (nothing versioned is lost when clearing away)");
  // The name in copy/<name>/ is the NAME of the copy, never the designation with chat title.
  assert.match(clearAwayQuestion(copyResource("p2/copy-e2e1", null), "GEO", ti), /^Remove copy e2e1 of GEO\? .*copy\/e2e1\/…/);
});

test("Result of clearing away: 202 accepted, 404 gone, every other status with the reason of the server — no success from a no", () => {
  assert.equal(clearAwayResult(202, { copy: {} }, copy, ti).ok, true);
  assert.match(clearAwayResult(202, null, copy, ti).text, /k1 \(Chat X\)/);
  const no = clearAwayResult(409, { error: "Copy is busy" }, copy, ti);
  assert.equal(no.ok, false);
  assert.match(no.text, /Copy is busy/);
  for (const st of [400, 403, 404, 409, 500]) assert.equal(clearAwayResult(st, {}, copy, ti).ok, false, `status ${st}`);
  assert.equal(clearAwayResult(500, "no JSON", copy, ti).ok, false);
  assert.match(clearAwayResult(500, null, copy, ti).text, /500/);
});

test("runningJeInstance: services that run in THIS instance — a row without a statement does not count", () => {
  const d = [
    { projectId: "p1", instances: [{ identifier: "p1/main", running: false }, { identifier: "p1/copy-k1", running: true }] },
    { projectId: "p1", instances: [{ identifier: "p1/main", running: true }, { identifier: "p1/copy-k1", running: true }] },
    { projectId: "p1" },
    { projectId: "p2", instances: [{ identifier: "p1/copy-k1", running: true }] },
  ];
  assert.equal(runningPerInstance(d, "p1", "p1/main"), 1);
  assert.equal(runningPerInstance(d, "p1", "p1/copy-k1"), 2);
  assert.equal(runningPerInstance(d, "p9", "p9/main"), 0);
});

test("Pill (by path), instances: group from the leaf (only without choice), no switching any more, clearing away via the dialog of the tab, result in the menu", () => {
  const pill = fs.readFileSync(path.join(webDir, "src", "components", "pills", "ServicesPill.tsx"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const imp = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/services-status"/.exec(pill);
  for (const f of ["instanceGroups", "groupsTitle", "clearable", "clearAwayPath", "clearAwayResult"]) {
    assert.ok(new RegExp(String.raw`\b${f}\b`).test(imp[1]), `ServicesPill.tsx does not compute ${f} via the leaf`);
  }
  assert.ok(/const groups = instanceGroups\(resources\);/.test(pill) && /\{!choice && groups\.length > 0 && \(/.test(pill),
    "the group does not hang on instanceGroups (from two instances) — or stands next to the choice, which already carries its copies as rows");
  // The old switching (group and service row) is gone — no button, no identifier, no wording.
  assert.ok(!/Switch over|data-ports-toggle|data-instance-toggle|data-ports-conflict|occupied by/.test(pill), "the pill still carries the old switching or the conflict text");
  assert.ok(/\{clearable\(i\) \? clearAwayButton\(g\.projectId, g\.name, i\) : getsClearedAway\(i\) \? \(/.test(pill)
    && /clearAway: z\.copy && clearable\(z\.copy\) \? clearAwayButton\(z\.projectId, z\.projectName, z\.copy\) : null/.test(pill),
    "Clearing away does not stand behind clearable (never at the main, never while being cleared away) — in the group AND in the choice");
  // In the group "is being removed" stands in place of the button, in the choice the state word of the radio row.
  assert.ok(/data-instance-gets-cleared-away>\{t\("being removed"\)\}/.test(pill), "\"is being removed\" is missing in place of the button");
  assert.ok(/beside: z\.foreign \? t\("other workspace"\) : copyNotReady\(z\.copy\) \? stateWord\(copyNotReady\(z\.copy\), t\)/.test(pill),
    "the radio row of a not ready copy does not carry its state word");
  assert.ok(/data-instance-clear-away/.test(pill.slice(pill.indexOf("const clearAwayButton"))), "the clear-away button does not carry its identifier (the probes grab it)");
  // The question is the delete dialog of the tab — the pill opens it (never for the main), sends no DELETE itself, and the dialog
  // sends it only on its button, with the wording `clearAwayQuestion` as a hint.
  const start = pill.slice(pill.indexOf("const doClearAway"));
  const on = start.indexOf("setDelete({ projectId, projectName, i })");
  assert.ok(on > 0 && /if \(!path\) return;/.test(start.slice(0, on)), "without a path (the main) no delete dialog may open");
  assert.ok(/import \{ CopyDelete \} from "@\/components\/projects\/InstanceDialogs"/.test(pill) && /<CopyDelete\b/.test(pill),
    "the pill does not clear away via the dialog of the tab (ONE component)");
  assert.ok(!/method: "DELETE"/.test(pill), "the pill sends the DELETE itself — past the delete preview and the 409 with the chats");
  const dlg = fs.readFileSync(path.join(webDir, "src", "components", "projects", "InstanceDialogs.tsx"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const kl = dlg.slice(dlg.indexOf("export function CopyDelete"));
  assert.ok(/const hint = clearAwayQuestion\(/.test(kl) && /<ModalTitle hint=\{hint\}>/.test(kl), "the dialog does not name the wording of the question (what stays, what goes)");
  assert.ok(/const erase = async \(\) => \{[\s\S]*?await deleteCopy\(projectId, name\)/.test(kl) && (kl.match(/deleteCopy\(/g) ?? []).length === 1,
    "the DELETE does not stand alone in the delete button of the dialog");
  assert.ok(/setPullResult\(clearAwayResult\(202, body, i, t\)\)/.test(start) && /data-instance-result/.test(pill), "the result does not stand in the menu");
  // After an accepted clear-away resources and projects ask again at once — otherwise "Clear away" stood until the next tick.
  assert.ok(/setPullResult\(clearAwayResult\(202, body, i, t\)\);\s*setReload\(\(n\) => n \+ 1\);/.test(start), "after an accepted clear-away the pill does not reload at once");
  assert.ok(/\}, \[canInstance, canChoice, portsOpen, reload\]\);/.test(pill), "the projects do not reload after a clear-away");
  // The menu stays the cb-pop surface (MENU), the group stands in the PORTS menu.
  const portsMenu = pill.slice(pill.search(/\sdata-status-ports-menu\s/), pill.search(/\sdata-status-performance-pop\b/));
  assert.ok(/data-instance-group=/.test(portsMenu), "the group does not stand in the ports menu");
});

// ── Exclusive choice ────────────────────────────────────────────────────────────────────────────────────────────────────────
// The lessons live on here: `running` at /api/project-services is the state of the MAIN — a service that runs only in the copy belongs
// to the ports of the COPY (`instancePorts`); the own copy is called "Checkout · k1 (Chat X)", never "another project" (`instanceTitle`).
// New: the list of the choice, the fallback, the rows under the choice, when the pill catches up, and that the pill computes all
// of this via the leaf.
test("instancePorts: the running port services of THIS instance — a service only in the copy belongs to the copy", () => {
  const inMainFrom = { projectId: "p1", workspaceId: "w", port: 3000, running: false,
    instances: [{ identifier: "p1/main", running: false }, { identifier: "p1/copy-k1", running: true }] };
  // The scenario of the finding: nothing runs in the main, the copy runs the dev server.
  assert.deepEqual(runningInScope([inMainFrom], "w", "p1"), [], "precondition: in scope nothing runs (in the main)");
  assert.deepEqual(instancePorts([inMainFrom], "p1/copy-k1"), [3000], "the service of the copy is missing — choosing the copy would bind nothing");
  assert.deepEqual(instancePorts([inMainFrom], "p1/main"), [], "the state per instance takes precedence over `running`");
  const all = [
    inMainFrom,
    { projectId: "p1", port: 8000, running: true, instances: [{ identifier: "p1/main", running: true }, { identifier: "p1/copy-k1", running: false }] },
    { projectId: "p1", port: 9000, running: false },
    { projectId: "p1", port: null, running: true },
    // Without state per instance (one instance): `running` is the main; the duplicate counts once.
    { projectId: "p1", port: 3000, running: true },
    { projectId: "p1", port: 3000, running: true },
    { projectId: "p2", port: 4000, running: true },
  ];
  assert.deepEqual(instancePorts(all, "p1/main"), [3000, 8000]);
  assert.deepEqual(instancePorts(all, "p1/copy-k1"), [3000], "for a copy a missing state means \"not running\" — never the state of the main");
  assert.deepEqual(instancePorts(all, "p2/main"), [4000]);
  assert.deepEqual(instancePorts(all, "p9/main"), []);
  assert.deepEqual(instancePorts(all, null), [], "\"None\" has no ports");
  assert.deepEqual(instancePorts(null, "p1/main"), []);
  assert.deepEqual(instancePorts(all, "broken"), []);
  // Identifiers are split at the LAST slash (like `identifierParts` in net-targets.js).
  assert.equal(projectOfTheIdentifier("a/b/main"), "a/b");
  assert.equal(projectOfTheIdentifier("p1/"), null);
  assert.equal(projectOfTheIdentifier(null), null);
});

test("instanceTitle: the main is called like its project, the own copy \"Checkout · k1 (Chat X)\" — unknown stays unknown", () => {
  const projectsK = [
    { id: "p1", name: "Checkout", instance: { identifier: "p1/main", converted: true } },
    { id: "p2", name: "Warehouse", instance: { identifier: "p2/main", converted: true } },
  ];
  const groupsK = [{ projectId: "p1", name: "Checkout", instances: [main, copy] }];
  assert.equal(instanceTitle("p1/copy-k1", projectsK, groupsK, ti), "Checkout · k1 (Chat X)");
  assert.equal(instanceTitle("p1/main", projectsK, groupsK, ti), "Checkout");
  assert.equal(instanceTitle("p2/main", projectsK, groupsK, ti), "Warehouse", "the main of another project: its name");
  assert.equal(instanceTitle("p2/copy-k3", projectsK, groupsK, ti), "Warehouse · k3", "copy outside the scope (no group): project and name of the copy");
  assert.equal(instanceTitle("p1/copy-k1", projectsK, [], ti), "Checkout · k1", "before the answer of the resources: project and copy, never \"another project\"");
  assert.equal(instanceTitle("p9/copy-k1", projectsK, groupsK, ti), null, "unknown stays unknown — the caller shows the identifier");
  assert.equal(instanceTitle("p1/copy-k1", null, null, ti), null);
  assert.equal(instanceTitle(null, projectsK, groupsK, ti), null);
  // copyResource: the copy behind an identifier — from the group (with chat) or only with name; the main is none.
  assert.equal(copyResource("p1/copy-k1", groupsK), copy);
  assert.deepEqual(copyResource("p2/copy-k3", groupsK), { identifier: "p2/copy-k3", name: "k3" });
  assert.equal(copyResource("p1/main", groupsK), null);
  assert.equal(copyResource("p1/copy-", null), null);
  assert.equal(clearable(copyResource("p2/copy-k3", null)), true, "a copy without group can still be cleared away");
  assert.equal(clearAwayPath("p2", copyResource("p2/copy-k3", null)), "/api/projects/p2/stack-copies/k3");
});

test("choiceRows: the projects of the ACTIVE workspace with port services, per main and below it every living copy; null before loading", () => {
  const projectsW = [
    { id: "p1", name: "Checkout", workspaceId: "w1", instance: { identifier: "p1/main", converted: true, copies: [{ identifier: "p1/copy-k1", chatId: "c1" }, { identifier: "p1/copy-k2" }] } },
    { id: "p2", name: "Warehouse", workspaceId: "w1", instance: { identifier: "p2/main", converted: true } },
    { id: "p3", name: "Docs", workspaceId: "w1", instance: { identifier: "p3/main", converted: true } },
    { id: "p4", name: "Old", workspaceId: "w1", instance: { identifier: "p4/main", converted: false } },
    { id: "p5", name: "Foreign", workspaceId: "w2", instance: { identifier: "p5/main", converted: true } },
    { id: "p6", name: "Copy only", workspaceId: "w1", instance: { identifier: "p6/main", converted: true, copies: [{ identifier: "p6/copy-x" }] } },
  ];
  const services = [
    { projectId: "p1", workspaceId: "w1", name: "Web", port: 3000, running: false,
      instances: [{ identifier: "p1/main", running: false }, { identifier: "p1/copy-k1", running: true }, { identifier: "p1/copy-k2", running: false }] },
    { projectId: "p1", workspaceId: "w1", name: "API", port: 8000, running: true,
      instances: [{ identifier: "p1/main", running: true }, { identifier: "p1/copy-k1", running: true }, { identifier: "p1/copy-k2", running: false }] },
    { projectId: "p2", workspaceId: "w1", name: "Warehouse", port: 3000, running: false },
    { projectId: "p3", workspaceId: "w1", name: "Build", port: null, running: true },
    { projectId: "p4", workspaceId: "w1", name: "Old", port: 5000, running: true },
    { projectId: "p5", workspaceId: "w2", name: "Foreign", port: 3000, running: true },
  ];
  const groupsW = [{ projectId: "p1", name: "Checkout", instances: [main, copy] }];
  const z = choiceRows({ services, projects: projectsW, ws: "w1", active: null, groups: groupsW });
  // Docs has no port service, Old is mid-move (no instance to choose), Foreign lies in w2; "Copy only" stands because of its copy
  // (clearing it away stays reachable); Warehouse stands although nothing runs right now (registered suffices).
  assert.deepEqual(z.map((r) => [r.identifier, r.kind, r.ports, r.running, r.foreign]), [
    ["p1/main", "main", [8000], true, false],
    ["p1/copy-k1", "copy", [3000, 8000], true, false],
    ["p1/copy-k2", "copy", [], false, false],
    ["p2/main", "main", [], false, false],
    ["p6/main", "main", [], false, false],
    ["p6/copy-x", "copy", [], false, false],
  ]);
  assert.equal(z[1].copy, copy, "the copy carries name and chat from the group");
  assert.deepEqual(z[2].copy, { identifier: "p1/copy-k2", name: "k2" });
  assert.equal(z[0].copy, null);
  assert.equal(z[0].projectName, "Checkout");
  // The active instance from ANOTHER workspace stands at the end (otherwise no row would be chosen) — only it, not its project.
  const withForeign = choiceRows({ services, projects: projectsW, ws: "w1", active: "p5/main", groups: groupsW });
  assert.deepEqual(withForeign.slice(-1).map((r) => [r.identifier, r.foreign, r.ports]), [["p5/main", true, [3000]]]);
  assert.equal(withForeign.length, z.length + 1);
  assert.equal(choiceRows({ services, projects: projectsW, ws: "w1", active: "p1/copy-k1", groups: groupsW }).length, z.length, "the active one in the own workspace stands twice");
  // Without `workspaceId` at /api/projects (older server): the workspace comes from the services of the project.
  const withoutWs = projectsW.map(({ workspaceId, ...r }) => r);
  assert.deepEqual(choiceRows({ services, projects: withoutWs, ws: "w1", active: null }).map((r) => r.identifier), ["p1/main", "p1/copy-k1", "p1/copy-k2", "p2/main"]);
  // "Empty is not unknown": before the services or the projects null — not "no project".
  assert.equal(choiceRows({ services: null, projects: projectsW, ws: "w1", active: null }), null);
  assert.equal(choiceRows({ services, projects: null, ws: "w1", active: null }), null);
  assert.deepEqual(choiceRows({ services, projects: projectsW, ws: "w9", active: null }), []);
  // A copy whose identifier belongs to another project does not stand under this one.
  const skewed = [{ ...projectsW[1], instance: { ...projectsW[1].instance, copies: [{ identifier: "p1/copy-k1" }] } }];
  assert.deepEqual(choiceRows({ services, projects: skewed, ws: "w1", active: null }).map((r) => r.identifier), ["p2/main"]);
});

// `foreign` followed from the row MISSING in the main loop — a project in the own workspace without port service and without copy (the copy
// cleared away, the choice back to the main; or the services gone on re-scan) stood as "P · other workspace".
test("choiceRows: `foreign` comes from the workspace of the project — the active one of a project in the OWN workspace always stands, even without a port service", () => {
  const P = { id: "p", name: "Checkout", workspaceId: "w1", instance: { identifier: "p/main", converted: true, copies: [{ identifier: "p/copy-k1" }] } };
  const R = { id: "r", name: "Warehouse", workspaceId: "w1", instance: { identifier: "r/main", converted: true } };
  const F = { id: "f", name: "Foreign", workspaceId: "w2", instance: { identifier: "f/main", converted: true } };
  const services = [{ projectId: "r", workspaceId: "w1", name: "Warehouse", port: 3000, running: true }];
  const core = (z) => z.map((r) => [r.identifier, r.foreign]);
  // Before: P stands because of its copy, the copy is chosen.
  assert.deepEqual(core(choiceRows({ services, projects: [P, R], ws: "w1", active: "p/copy-k1" })), [["p/main", false], ["p/copy-k1", false], ["r/main", false]]);
  // The copy is cleared away, the choice fell back to the main: P still stands in ITS workspace, in its place, not "foreign".
  const withoutCopy = { ...P, instance: { identifier: "p/main", converted: true, copies: [] } };
  assert.deepEqual(core(choiceRows({ services, projects: [withoutCopy, R], ws: "w1", active: "p/main" })), [["p/main", false], ["r/main", false]],
    "the active instance of a project in the own workspace is called \"other workspace\"");
  // Without a choice a project without port service and without copy stays out (as before).
  assert.deepEqual(core(choiceRows({ services, projects: [withoutCopy, R], ws: "w1", active: null })), [["r/main", false]]);
  // The port services of the chosen project vanished on re-scan: the same.
  assert.deepEqual(core(choiceRows({ services: [], projects: [R], ws: "w1", active: "r/main" })), [["r/main", false]]);
  // Really another workspace: appended and `foreign`.
  assert.deepEqual(core(choiceRows({ services, projects: [R, F], ws: "w1", active: "f/main" })), [["r/main", false], ["f/main", true]]);
  // Unknown workspace (older server without `workspaceId`, no services): do not claim "other workspace".
  const { workspaceId: _w, ...withoutWs } = withoutCopy;
  assert.deepEqual(core(choiceRows({ services: [], projects: [withoutWs], ws: "w1", active: "p/main" })), [["p/main", false]]);
});

// The service list of the choice computed the state per instance itself — `holds` only for the main (a copy with start protection
// offered ▶ and ran into 409 SERVICE_RUNNING) and a missing entry as "stopped" (a copy being built offered ▶ and ran into 409
// COPY_NOT_READY). Now the same computation as the Apps page (`serviceInInstance`).
test("choiceServices: state per instance via serviceInInstance — start protection also in the copy, unknown is not stopped", () => {
  const svc = (id, name, extra = {}) => ({ id, projectId: "p1", workspaceId: "w1", name, port: 3000 + id, container: null, startCommand: "npm start", running: false, ...extra });
  const services = [
    // 1: runs in the main, in the copy a living run holds the start (port closed) — the case from the finding.
    svc(1, "Web", { running: true, instances: [{ identifier: "p1/main", running: true, holdsStart: false }, { identifier: "p1/copy-k1", running: false, holdsStart: true }] }),
    // 2: stopped in the copy, nothing holds — startable.
    svc(2, "API", { instances: [{ identifier: "p1/main", running: false }, { identifier: "p1/copy-k1", running: false }] }),
    // 3: without `instances` (the copy is not yet converted) — unknown in the copy, `running` in the main.
    svc(3, "Docs", { running: true }),
    // 4: in the main the start protection of the row holds.
    svc(4, "Worker", { holdsStart: true }),
    // 5: without start command.
    svc(5, "Cron", { startCommand: "", instances: [{ identifier: "p1/main", running: false }, { identifier: "p1/copy-k1", running: false }] }),
  ];
  const core = (l) => Object.fromEntries(l.map((d) => [d.name, [d.running, d.holds, d.startable]]));
  const copy1 = core(choiceServices({ active: "p1/copy-k1", services, forwards: [] }));
  assert.deepEqual(copy1.Web, [false, true, false], "copy with start protection: \"running, not reachable\", NO ▶ (otherwise 409 SERVICE_RUNNING)");
  assert.deepEqual(copy1.API, [false, false, true], "copy, measured stopped: ▶");
  assert.deepEqual(copy1.Docs, [null, false, false], "copy without entry: unknown, not stopped, NO ▶");
  assert.deepEqual(copy1.Cron, [false, false, false], "without start command no ▶");
  const main1 = core(choiceServices({ active: "p1/main", services, forwards: [] }));
  assert.deepEqual(main1.Web, [true, false, false]);
  assert.deepEqual(main1.Docs, [true, false, false], "the main without `instances` keeps `running` of the row");
  assert.deepEqual(main1.Worker, [false, true, false], "the main holds via `holdsStart` of the row");
  assert.deepEqual(main1.API, [false, false, true]);
  // Running first — an unknown state does not count as running.
  assert.deepEqual(choiceServices({ active: "p1/copy-k1", services, forwards: [] }).map((d) => d.name), ["API", "Cron", "Docs", "Web", "Worker"]);
  assert.deepEqual(choiceServices({ active: "p1/main", services, forwards: [] }).map((d) => d.name), ["Docs", "Web", "API", "Cron", "Worker"]);
  // The forwarding stands only at a RUNNING service.
  const fw = { instance: "p1/copy-k1", port: 3002, localPort: 3002, connections: 0, source: "selection" };
  const withFw = services.map((d) => (d.id === 2 ? { ...d, instances: [{ identifier: "p1/main", running: false }, { identifier: "p1/copy-k1", running: true }] } : d));
  assert.equal(choiceServices({ active: "p1/copy-k1", services: withFw, forwards: [fw] }).find((d) => d.id === 2).row.f, fw);
  assert.equal(choiceServices({ active: "p1/copy-k1", services, forwards: [fw] }).find((d) => d.id === 2).row, null);
  // Empty is not unknown: without services null, without choice empty.
  assert.equal(choiceServices({ active: "p1/main", services: null, forwards: [] }), null);
  assert.deepEqual(choiceServices({ active: null, services, forwards: [] }), []);
});

// The state of a copy also comes from `/api/projects` (`instance.copies[].state`) — a copy being built is missing in the resources,
// and without it it was called like a ready one in the choice.
test("Not ready copy: the state from /api/projects, where the resources name none; the choice carries it", () => {
  const groupsZ = [{ projectId: "p1", name: "Checkout", instances: [main, { ...copy, state: "clearAway" }, { identifier: "p1/copy-k4", name: "k4", state: "" }] }];
  assert.equal(copyResource("p1/copy-k1", groupsZ, "ready").state, "clearAway", "the state of the resources takes precedence (they come every 15 s)");
  assert.equal(copyResource("p1/copy-k4", groupsZ, "start").state, "start", "without state in the resources the one from /api/projects applies");
  assert.deepEqual(copyResource("p1/copy-k2", groupsZ, "create"), { identifier: "p1/copy-k2", name: "k2", state: "create" }, "a copy being built is missing in the resources");
  assert.deepEqual(copyResource("p1/copy-k2", groupsZ, null), { identifier: "p1/copy-k2", name: "k2" });
  // Which copy is not ready — missing is unknown, not "not ready".
  assert.equal(copyNotReady({ identifier: "p1/copy-k2", name: "k2", state: "create" }), "create");
  assert.equal(copyNotReady({ ...copy, state: "clearAway" }), "clearAway");
  assert.equal(copyNotReady({ ...copy, state: "error" }), "error");
  assert.equal(copyNotReady(copy), null, "ready");
  assert.equal(copyNotReady({ identifier: "p1/copy-k2", name: "k2" }), null, "without state (older server): do not guess");
  assert.equal(copyNotReady(null), null, "the main of the choice (copy: null)");
  // The choice: the copy being built stands there (choosable), WITH its state.
  const projectsZ = [{ id: "p1", name: "Checkout", workspaceId: "w1",
    instance: { identifier: "p1/main", converted: true, copies: [{ identifier: "p1/copy-k1", state: "ready" }, { identifier: "p1/copy-k2", name: "k2.till.cbase", state: "create" }] } }];
  const z = choiceRows({ services: [{ projectId: "p1", workspaceId: "w1", name: "Web", port: 3000, running: true }], projects: projectsZ, ws: "w1", active: null, groups: [] });
  assert.deepEqual(z.map((r) => [r.identifier, copyNotReady(r.copy)]), [["p1/main", null], ["p1/copy-k1", null], ["p1/copy-k2", "create"]]);
  assert.equal(z[2].copy.name, "k2", "the name of the copy comes from the identifier, not from `name` (the DNS name) at /api/projects");
});

// The first repair hid the WHOLE service list for a not ready copy — a running copy being cleared away (the services run until the last
// step) or in `error` stood with its forwarding nowhere in the menu, because `otherForwardings` (from `activeRows`) led it as "above".
// Now: only the start drops, the living services stay, and "Manual and browser" is everything the list does NOT show — every forwarding once.
test("Not ready copy: running services and their forwarding stay visible, no ▶; every forwarding stands exactly once", () => {
  const t = (k, w = {}) => k.replace(/\{(\w+)\}/g, (_, n) => (n in w ? String(w[n]) : `{${n}}`));
  const fw = (instance, port, localPort, source) => ({ instance, port, localPort, connections: 0, ...(source ? { source } : {}) });
  const svc = (id, name, port, instances, extra = {}) => ({ id, projectId: "p1", workspaceId: "w1", name, port, container: null, startCommand: "npm start", running: false, instances, ...extra });
  const K = "p1/copy-k1";
  // The setup of the probe: Web :3195 runs in k1 (forwarded, source "selection"), API :8000 stopped, Worker :9000 holds the start,
  // Docs :4000 without entry (unknown) — but with an old forwarding of the choice.
  const services = [
    svc(1, "Web", 3195, [{ identifier: "p1/main", running: false }, { identifier: K, running: true }]),
    svc(2, "API", 8000, [{ identifier: "p1/main", running: false }, { identifier: K, running: false }]),
    svc(3, "Worker", 9000, [{ identifier: "p1/main", running: false }, { identifier: K, running: false, holdsStart: true }]),
    svc(4, "Docs", 4000, [{ identifier: "p1/main", running: false }]),
  ];
  const web = fw(K, 3195, 3195, "selection");
  const docsOld = fw(K, 4000, 4000, "selection");
  const hand = fw(null, 7000, 7000);
  const forwards = [web, docsOld, hand];
  const raw = choiceServices({ active: K, services, forwards });
  const rows = activeRows({ active: K, services, forwards });
  // The situation of the finding: Web used to count as "above", but nothing stood above.
  assert.deepEqual(otherForwardings(forwards, rows), [hand], "anchor: activeRows leads Web AND the old Docs forwarding as \"above\"");

  for (const state of ["clearAway", "error", "create", "start", "recreate"]) {
    const nb = copyNotReady({ ...copy, state });
    assert.equal(nb, state);
    const view = choiceServicesVisible(raw, nb);
    assert.deepEqual(view.map((d) => [d.name, d.running, d.holds, d.startable]), [["Web", true, false, false], ["Worker", false, true, false]],
      `${state}: only the living services — Web (running) and Worker (holds) — without ▶; API (stopped) and Docs (unknown) drop`);
    assert.equal(view[0].row?.kind, "forwarded");
    assert.equal(view[0].row.f, web, `${state}: Web carries its forwarding (localhost:3195 ↗)`);
    assert.ok(!view.some((d) => d.startable), `${state}: a ▶ at a not ready copy ended in 409 COPY_NOT_READY`);
    const other = otherBesideTheList(forwards, view, rows);
    assert.deepEqual(other, [docsOld, hand], `${state}: Web stands above, the old Docs forwarding (above without row) and the one by hand below — with ×`);
    const top = view.flatMap((d) => (d.row?.kind === "forwarded" ? [d.row.f] : []));
    assert.deepEqual([...top, ...other].sort((a, b) => a.port - b.port), [...forwards].sort((a, b) => a.port - b.port), `${state}: every forwarding exactly once`);
  }
  // Ready, without state and the main: the whole list, unchanged (the same object).
  assert.equal(choiceServicesVisible(raw, copyNotReady(copy)), raw);
  assert.equal(choiceServicesVisible(raw, copyNotReady({ identifier: K, name: "k1" })), raw, "without state (older server): do not guess");
  assert.equal(choiceServicesVisible(raw, copyNotReady(null)), raw, "the main");
  assert.equal(choiceServicesVisible(null, "clearAway"), null, "not yet loaded stays \"not yet loaded\"");
  // Also ready: a forwarding of the choice at a service that is not (any more) measured as running stands below instead of nowhere.
  assert.deepEqual(otherBesideTheList(forwards, raw, rows), [docsOld, hand]);
  // Before the services load as before (from activeRows) — the forwardings of the choice do not jump down for one tick.
  assert.deepEqual(otherBesideTheList(forwards, null, activeRows({ active: K, services: null, forwards })), [hand]);
  // The sentence promises only what happens: on `error` the copy never becomes ready without a new clear-away/re-creation.
  const set = (state) => notReadySet({ ...copy, state }, `<${state}>`, t);
  assert.equal(set("clearAway"), "The copy k1 is being removed — its services no longer start here.");
  assert.equal(set("error"), "The copy k1 has an error — its services do not start here.");
  assert.ok(!/as soon as|once it is ready/.test(set("error")), "on `error` the sentence promises a becoming ready that never happens");
  assert.equal(set("create"), "The copy k1 is not ready right now (<create>) — its services start here only once it is ready.");
  assert.ok(!/stand here as soon as/.test(set("start")), "the sentence still claims the services would stand here only after \"ready\" — the living ones already stand below");
});

test("Fallback (activeBySituation): copy cleared away => main of its project, project deleted => \"None\", else and before loading the choice stays", () => {
  const pr = [{ id: "p1", name: "Checkout", instance: { identifier: "p1/main", converted: true, copies: [{ identifier: "p1/copy-k1" }] } }, { id: "p2", name: "Old" }];
  assert.deepEqual(activeBySituation("p1/copy-k1", pr), { kind: "stays" });
  assert.deepEqual(activeBySituation("p1/main", pr), { kind: "stays" });
  assert.deepEqual(activeBySituation("p1/copy-k2", pr), { kind: "main", identifier: "p1/main" }, "a cleared-away copy would stay chosen — its ports would go nowhere");
  assert.deepEqual(activeBySituation("p9/main", pr), { kind: "no" }, "a deleted project would stay chosen");
  assert.deepEqual(activeBySituation("p9/copy-k1", pr), { kind: "no" });
  assert.deepEqual(activeBySituation("p2/main", pr), { kind: "stays" }, "a project without instance statement (server without operating mark): do not guess");
  assert.deepEqual(activeBySituation(null, pr), { kind: "stays" });
  assert.deepEqual(activeBySituation("p1/copy-k1", null), { kind: "stays" }, "before the answer of /api/projects nothing falls back");
  assert.deepEqual(activeBySituation("p1/copy-k1", []), { kind: "no" }, "an EMPTY answer is an answer: the project no longer exists");
});

test("Under the choice: the ports of the active instance (forwarded · occupied by hand · pending), the rest for itself; catch up only where it does something", () => {
  const fw = (instance, port, localPort, source) => ({ instance, port, localPort, connections: 0, ...(source ? { source } : {}) });
  const services = [
    { projectId: "p1", name: "Web", port: 3000, running: true },
    { projectId: "p1", name: "API", port: 8000, running: true },
    { projectId: "p1", name: "Docs", port: 4000, running: true },
    { projectId: "p1", name: "Off", port: 5000, running: false },
    { projectId: "p2", name: "Warehouse", port: 3000, running: true },
  ];
  const selection3000 = fw("p1/main", 3000, 3000, "selection");
  const hand8000 = fw(null, 9999, 8000);                  // by hand, without instance, holds localhost:8000
  const alt5000 = fw("p1/main", 5000, 5000, "selection");  // belongs to the choice, the service no longer runs
  const browser = fw("p2/main", 3000, 3001, "browser");
  const foreignHand = fw("p2/main", 7000, 7000);
  const forwards = [selection3000, hand8000, alt5000, browser, foreignHand];
  const z = activeRows({ active: "p1/main", services, forwards });
  assert.deepEqual(z.map((r) => [r.kind, r.port, r.service]), [
    ["forwarded", 3000, "Web"],
    ["pending", 4000, "Docs"],
    ["forwarded", 5000, "Off"],
    ["occupied", 8000, "API"],
  ]);
  assert.equal(z[0].f, selection3000);
  assert.equal(z[0].running, true);
  assert.equal(z[2].running, false, "the forwarding of a stopped service stands there, but not as running");
  assert.equal(z[3].from, hand8000, "\"occupied\" names the forwarding by hand");
  assert.deepEqual(otherForwardings(forwards, z), [hand8000, browser, foreignHand], "the rest — by hand, browser, other instances — stands for itself, with ×");
  assert.equal(needsBringAlong(z), true, "Docs runs without forwarding — catch up");
  // Only "occupied" does NOT catch up (catching up never removes one by hand) — otherwise the pill would ask every tick for nothing.
  assert.equal(needsBringAlong(activeRows({ active: "p1/main", services: services.filter((d) => d.port !== 4000), forwards })), false);
  // A forwarding of the instance from the browser on a running port: catching up takes it over into the choice.
  const zb = activeRows({ active: "p1/main", services, forwards: [fw("p1/main", 3000, 3000, "browser"), fw("p1/main", 4000, 4000, "selection"), hand8000] });
  assert.deepEqual(zb.map((r) => r.kind), ["forwarded", "forwarded", "occupied"]);
  assert.equal(needsBringAlong(zb), true);
  assert.equal(needsBringAlong(activeRows({ active: "p1/main", services, forwards: [selection3000, fw("p1/main", 4000, 4000, "selection"), hand8000] })), false,
    "everything belongs to the choice, the rest is by hand — nothing to do");
  // A dodged forwarding of the choice (localhost:3001 <- :3000) counts as forwarded — no catching up per tick.
  assert.equal(needsBringAlong(activeRows({ active: "p1/main", services: services.slice(0, 1), forwards: [fw("p1/main", 3000, 3001, "selection")] })), false);
  // One by hand of the SAME instance on a port without a running service stays with those by hand.
  const handOwn = fw("p1/main", 6000, 6000);
  assert.deepEqual(otherForwardings([handOwn], activeRows({ active: "p1/main", services, forwards: [handOwn] })), [handOwn]);
  // Without a choice: nothing below, everything in the own section.
  assert.deepEqual(activeRows({ active: null, services, forwards }), []);
  assert.deepEqual(otherForwardings(forwards, []), forwards);
  // The service rows: their state, without button — no "occupied by …", no switching.
  assert.equal(serviceStatus(3000, "p1/main", "p1/main", forwards).f, selection3000);
  assert.equal(serviceStatus(3000, "p2/main", "p1/main", [selection3000]).kind, "not-active", "Warehouse on 3000 is not forwarded as long as Checkout is chosen");
  assert.equal(serviceStatus(3000, "p2/main", "p1/main", forwards).kind, "forwarded", "a forwarding of the instance (here from the browser) shows the row, whatever the source");
  assert.equal(serviceStatus(4000, "p1/main", "p1/main", forwards).kind, "pending");
  assert.equal(serviceStatus(8000, "p1/main", "p1/main", forwards).kind, "occupied");
  assert.equal(serviceStatus(8000, "p1/main", "p1/main", forwards).from, hand8000);
  assert.equal(serviceStatus(4000, "p1/main", null, forwards).kind, "not-active", "without a choice nothing is pending");
});

test("Pill (by path), choice: radio list from the leaf, exclusive via the identifier, catching up and fallback once per state, version switch", () => {
  const pill = fs.readFileSync(path.join(webDir, "src", "components", "pills", "ServicesPill.tsx"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const imp = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/services-status"/.exec(pill);
  for (const f of ["choiceRows", "instancePorts", "activeBySituation", "activeRows", "needsBringAlong", "otherBesideTheList", "serviceStatus", "instanceTitle",
    "choiceServicesVisible", "notReadySet"]) {
    assert.ok(new RegExp(String.raw`\b${f}\b`).test(imp[1]), `ServicesPill.tsx does not compute ${f} via the leaf`);
  }
  // Version switch: the choice only with a client that knows `active` — otherwise the pill stays as it was.
  assert.ok(/const \[canChoice\] = useState\(\(\) => typeof bridge\(\)\?\.active === "function"\);/.test(pill), "the version switch of the choice is missing");
  assert.ok(/const choice = available && canChoice;/.test(pill), "the choice would also stand in the web without a bridge");
  // Choosing: exclusive, with the ports of THIS instance; "None" is null.
  assert.ok(/await b\.select\(identifier, ports, \{ mode: "exclusive" \}\)/.test(pill), "the choice does not go exclusively to the client");
  assert.ok(/radio\(\{ identifier: null, title: t\("None"\), ports: \[\] \}\)/.test(pill), "\"None\" is missing in the list");
  assert.ok(/role="radiogroup"/.test(pill) && /role="radio"/.test(pill) && /aria-checked=\{on\}/.test(pill), "the list is no radio group (keyboard, screen reader)");
  assert.ok(/const rowsChoice = choice \? choiceRows\(\{ services: all, projects, ws, active, groups \}\) : null;/.test(pill));
  assert.ok(/ports: z\.ports,/.test(pill), "a row does not choose with its own ports");
  // Catching up and fallback: in ONE effect, only with a read choice, once per state, never two at once.
  const end = pill.indexOf("}, [canChoice, active, all, projects, forwards]);");
  const eff = pill.slice(pill.lastIndexOf("useEffect(", pill.indexOf("const situation = activeBySituation(active, projects);")), end);
  assert.ok(end > 0 && eff.length > 200, "anchor: the effect of the choice cannot be found — update");
  assert.ok(/if \(!canChoice \|\| !b\?\.select \|\| active === undefined \|\| all === null \|\| selectionRunning\.current\) return;/.test(eff), "catching up runs before loading or twice");
  assert.ok(/if \(v && v\.active === active && v\.all === all && v\.projects === projects\) return;/.test(eff),
    "more than one attempt per state — a port that does not bind asked the client at every change");
  assert.ok(/: active && needsBringAlong\(activeRowsOf\(\{ active, services: all, forwards \}\)\) \? \{ identifier: active, mode: "bringAlong" as const \}/.test(eff),
    "catching up does not go via needsBringAlong");
  assert.ok(/situation\.kind === "main" \? \{ identifier: situation\.identifier, mode: "exclusive" as const \}/.test(eff) && /situation\.kind === "no" \? \{ identifier: null, mode: "exclusive" as const \}/.test(eff),
    "the fallback does not choose exclusively (main or \"None\")");
  // Fallback and catching up are computed from THIS `active` — the client chooses only if it still applies at execution.
  assert.ok(/b\.select\(target\.identifier, instancePorts\(all, target\.identifier\), \{ mode: target\.mode, ifActive: active \}\)/.test(eff),
    "the fallback of the pill applies without condition — a choice made in the meantime would be replaced again at once");
  assert.ok(/type ChoiceMode = \{ mode: "exclusive" \| "bringAlong"; ifActive\?: string \| null \};/.test(pill), "the type of the options does not know the condition");
  // The projects with the choice every 30 s (fallback without open menu); the choice follows the client (fallback in the main process).
  assert.ok(/const iv = canChoice \? setInterval\(load, 30_000\) : null;/.test(pill), "without a tick a cleared-away copy would fall back only when the menu opens");
  assert.ok(/const off = b\.onActive\?\.\(\(k\) => setActive\(k \?\? null\)\);/.test(pill) && /off\?\.\(\);/.test(pill), "the pill does not follow the choice of the client");
  // With the choice no buttons on the service rows of an instance; × only in the own section.
  assert.ok(/const st = choice && d\.port && inst \? serviceStatus\(d\.port, inst, active, forwards\) : null;/.test(pill));
  assert.ok(/\{!st && <button onClick=\{\(\) => bridge\(\)\?\.stop\(/.test(pill) && /\) : !st && \(/.test(pill), "a service row with choice still carries × or \"Forward\"");
  assert.ok(/\{choice && other\.length > 0 && \(/.test(pill) && /\{other\.map\(fwdRow\)\}/.test(pill), "the section \"Manual and browser\" is missing");
  // ▶ only at a MEASURED stopped service (unknown is not stopped), and a not ready chosen copy shows a sentence instead of its services
  // (a start there ended in 409 COPY_NOT_READY).
  assert.ok(/\{d\.running === false && !d\.holds && !starting\[key\] && \(/.test(pill), "▶ also stands at a service with unknown state");
  // What is taken away is the START, not the view — the living services of a not ready copy (with their forwarding with ↗) stay under the
  // sentence; the list runs through `choiceServicesVisible` and does NOT stand behind `!activeNotReady`.
  assert.ok(/const activeNotReady = copyNotReady\(activeCopy\);/.test(pill)
    && /const choiceList = choice \? choiceServicesVisible\(choiceServices\(\{ active, services: all, forwards \}\), activeNotReady\) : \[\];/.test(pill),
    "the service list of a not ready copy does not go through choiceServicesVisible (▶ that ends in 409 — or no row at all)");
  assert.ok(/\{choiceList\?\.map\(\(d\) => \{/.test(pill) && !/!activeNotReady && choiceList\?\.map/.test(pill),
    "the service list stands behind !activeNotReady — the running services of a copy being cleared away/in error stand nowhere");
  assert.ok(/const other = otherBesideTheList\(forwards, choiceList, activeRows\);/.test(pill),
    "\"Manual and browser\" does not compute from the SHOWN rows — a forwarding can then stand neither above nor below");
  assert.ok(/\{notReadySet\(activeCopy, stateWord\(activeNotReady, t\), t\)\}/.test(pill), "the sentence of the not ready copy does not come from the leaf");
  // Order in the ports menu: choice, the services of the active instance (every registered service, stopped ones with "Start"),
  // running services (only without choice), manual and browser.
  const portsMenu = pill.slice(pill.search(/\sdata-status-ports-menu\s/), pill.search(/\sdata-status-performance-pop\b/));
  const queue = [/data-ports-choice-list/, /t\("Services · \{instance\}"/, /t\("Running services"\)/, /t\("Manual and browser"\)/].map((re) => portsMenu.search(re));
  assert.ok(queue.every((x, i) => x > 0 && (i === 0 || x > queue[i - 1])), `order in the ports menu: ${queue.join(" < ")}`);
});
