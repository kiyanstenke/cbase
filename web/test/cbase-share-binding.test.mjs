// cbase's share of the server, bound: web and iOS compute the same. Requirement: the performance overview shows the server at the top,
// including how much of the server's resources cbase uses (the bar could be coloured differently for the part cbase uses, per category
// CPU, RAM, etc.).
//
// Two versions of the same computation: `cbasePart`/`progressBarParts` in `web/src/lib/services-status.ts` (performance menu in the web)
// and `enum CbaseRules` in `mobile/CbaseMobile/Shell/ServicesStatus.swift` (the same menu on the iPhone). If one drifts away — the clamp to
// the used amount is missing, a `null` field counts as 0, the split measures against the track instead of the used amount — the iPhone
// and the desktop show different bars for the same server. Bound by RUNNING (model running-tasks-binding.test.mjs): the web is compiled
// with `tsc`; `struct MachineStatus`, `enum CbaseRules` and the three shares from `ServicesRules` (ramShare, loadShare, diskShare) are cut
// out of the Swift source, compiled with a driver via `xcrun swiftc` and run on the same machines. Without the toolchain the test fails
// LOUDLY (hence under `onlyMacOS` in tools/check/latch.json). The text guards (server first, optional decoder, every bar with its
// part) live in statusBar.test.mjs and run everywhere.
//
// COUNTER-TESTS (each seen red once):
//   iOS  in `CbaseRules.part` `min(used, value / total)` → `value / total` (no clamp) ⇒ "part" red;
//   iOS  in `CbaseRules.progressBar` `max(0, cbase) / a * 100` → `max(0, cbase) * 100` (measured against the track) ⇒ "bar" red;
//   iOS  `case .load` with `host.cpu.load1` instead of `Double(host.cpu.count)` as total ⇒ "part" red;
//   Web  clamp removed from `cbasePart` ⇒ "part" red (and the sheet test in services-status.test.mjs).
// Run:  node --test web/test/cbase-share-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "services-status.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Shell", "ServicesStatus.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleaning up says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-share-binding-")));

// ── The cases ───────────────────────────────────────────────────────────────────────────────
// 60 machines from a fixed randomness (the same on every run) and the edges: no cbase figure, null fields, no denominator,
// cbase above the used amount (clamp), load above the cores, 0 measured, negative values (broken), without swap/disk.
const GB = 2 ** 30;
function machineCases() {
  let s = 20261001;
  const random = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const or = (value) => (random() < 0.15 ? null : value);
  const cases = [];
  for (let i = 0; i < 60; i++) {
    const total = Math.round((1 + random() * 63) * GB);
    const count = 1 + Math.floor(random() * 32);
    const disk = Math.round((10 + random() * 1990) * GB);
    const swapTotal = Math.round(random() * 8 * GB);
    cases.push({
      cpu: { count, load1: Math.round(random() * 2.5 * count * 100) / 100 },
      mem: { totalBytes: total, availableBytes: Math.round(random() * 1.1 * total) },
      swap: random() < 0.2 ? null : { totalBytes: swapTotal, freeBytes: Math.round(random() * 1.05 * swapTotal) },
      disk: random() < 0.1 ? null : { totalBytes: disk, freeBytes: Math.round(random() * 1.05 * disk) },
      cbase: random() < 0.1 ? null : {
        memBytes: or(Math.round(random() * 1.2 * total)),
        cpuCores: or(Math.round(random() * 1.5 * count * 100) / 100),
        swapBytes: or(Math.round(random() * 1.2 * swapTotal)),
        diskBytes: or(Math.round(random() * 1.1 * disk)),
      },
    });
  }
  const base = { cpu: { count: 4, load1: 2 }, mem: { totalBytes: 16 * GB, availableBytes: 8 * GB }, swap: { totalBytes: 4 * GB, freeBytes: 3 * GB }, disk: { totalBytes: 500 * GB, freeBytes: 300 * GB } };
  cases.push({ ...base, cbase: { memBytes: 0, cpuCores: 0, swapBytes: 0, diskBytes: 0 } });
  cases.push({ ...base, cbase: { memBytes: 20 * GB, cpuCores: 9, swapBytes: 5 * GB, diskBytes: 900 * GB } }); // above the used amount
  cases.push({ ...base, cpu: { count: 4, load1: 9 }, cbase: { memBytes: 1, cpuCores: 3, swapBytes: 1, diskBytes: 1 } }); // load > cores
  cases.push({ ...base, cbase: { memBytes: -1, cpuCores: -0.5, swapBytes: -2, diskBytes: -3 } }); // broken
  cases.push({ ...base, cbase: { memBytes: null, cpuCores: null, swapBytes: null, diskBytes: null } });
  cases.push({ ...base, cbase: null });
  cases.push({ cpu: { count: 0, load1: 1 }, mem: { totalBytes: 0, availableBytes: 0 }, swap: null, disk: null, cbase: { memBytes: 1, cpuCores: 1, swapBytes: 1, diskBytes: 1 } });
  cases.push({ ...base, swap: { totalBytes: 0, freeBytes: 0 }, disk: { totalBytes: 0, freeBytes: 0 }, cbase: { memBytes: 1, cpuCores: 1, swapBytes: 1, diskBytes: 1 } });
  cases.push({ ...base, mem: { totalBytes: 16 * GB, availableBytes: 16 * GB }, cbase: { memBytes: 2 * GB, cpuCores: 1, swapBytes: 0, diskBytes: 1 } }); // nothing used
  return cases;
}
const PROGRESS_BAR = [
  [0.5, null], [0.5, 0.25], [0.8, 0], [0.4, 0.4], [2, 1], [0, 0], [0, null], [-1, null], [-1, 0.2], [1, 1], [0.25, 0.5],
  [0.731, 0.123], [1.43, 0.7], [0.0001, 0.00005], [0.999, 0.998],
];

// ── Web ─────────────────────────────────────────────────────────────────────────────────────
let web = null;
async function webRules() {
  if (web) return web;
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  web = await import(pathToFileURL(path.join(out, "services-status.js")).href);
  return web;
}

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────
// A block from its head to its closing brace (head included); `//` comments and strings do not count.
function block(source, header) {
  const i = source.indexOf(header);
  assert.ok(i >= 0, `${header} not found in ${path.relative(repo, SOURCE_SWIFT)} — renamed? Update the anchor here, do NOT delete the test.`);
  let depth = 0;
  let str = false;
  for (let j = source.indexOf("{", i + header.length - 1); j < source.length; j++) {
    const c = source[j];
    if (str) { if (c === "\\") j++; else if (c === '"') str = false; continue; }
    if (c === "/" && source[j + 1] === "/") { j = source.indexOf("\n", j); if (j < 0) break; continue; }
    if (c === '"') { str = true; continue; }
    if (c === "{") depth++;
    else if (c === "}" && !--depth) return source.slice(i, j + 1);
  }
  assert.fail(`${header}: the brace does not close`);
}
const swiftCount = (n) => {
  assert.ok(Number.isFinite(n), `not a finite number: ${n}`);
  return Number.isInteger(n) ? `${n}.0` : String(n);
};
const swiftOpt = (n) => (n == null ? "nil" : swiftCount(n));
const swiftMachine = (h) => `MachineStatus(at: 0, cpu: .init(count: ${h.cpu.count}, load1: ${swiftCount(h.cpu.load1)}, load5: 0, load15: 0), ` +
  `mem: .init(totalBytes: ${swiftCount(h.mem.totalBytes)}, availableBytes: ${swiftCount(h.mem.availableBytes)}), ` +
  `swap: ${h.swap ? `.init(totalBytes: ${swiftCount(h.swap.totalBytes)}, freeBytes: ${swiftCount(h.swap.freeBytes)})` : "nil"}, ` +
  `disk: ${h.disk ? `.init(totalBytes: ${swiftCount(h.disk.totalBytes)}, freeBytes: ${swiftCount(h.disk.freeBytes)})` : "nil"}, ` +
  `cbase: ${h.cbase ? `.init(memBytes: ${swiftOpt(h.cbase.memBytes)}, cpuCores: ${swiftOpt(h.cbase.cpuCores)}, swapBytes: ${swiftOpt(h.cbase.swapBytes)}, diskBytes: ${swiftOpt(h.cbase.diskBytes)})` : "nil"})`;

let ios = null;
function iosRules() {
  if (ios) return ios;
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const parts = [
    block(source, "struct MachineStatus: Equatable, Sendable {"),
    `enum ServicesRules {\n${["static func ramShare(_ host: MachineStatus) -> Double?", "static func loadShare(_ host: MachineStatus) -> Double?",
      "static func diskShare(_ host: MachineStatus) -> Double?"].map((k) => block(source, k)).join("\n")}\n}`,
    block(source, "enum CbaseRules {"),
  ];
  const cases = machineCases();
  const program = `import Foundation
${parts.join("\n\n")}

let cases: [MachineStatus] = [
${cases.map((h) => `    ${swiftMachine(h)},`).join("\n")}
]
print("KINDS\\t" + CbaseRules.Kind.allCases.map(\\.rawValue).joined(separator: ","))
for (i, h) in cases.enumerated() {
    for kind in CbaseRules.Kind.allCases {
        if let t = CbaseRules.part(h, kind) {
            print("T\\t\\(i)\\t\\(kind.rawValue)\\t\\(t.share)\\t\\(t.value)")
        } else {
            print("T\\t\\(i)\\t\\(kind.rawValue)\\t-\\t-")
        }
    }
}
let progressBar: [(Double, Double?)] = [${PROGRESS_BAR.map(([a, h]) => `(${swiftCount(a)}, ${swiftOpt(h)})`).join(", ")}]
for (i, b) in progressBar.enumerated() {
    let r = CbaseRules.progressBar(share: b.0, cbase: b.1)
    print("B\\t\\(i)\\t\\(r.width)\\t" + (r.cbase.map { "\\($0)" } ?? "-"))
}
`;
  const file = path.join(tmpDir(), "cbase.swift");
  const bin = path.join(tmpDir(), "cbase");
  fs.writeFileSync(file, program);
  try {
    execFileSync("xcrun", ["swiftc", "-o", bin, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be compiled (xcrun swiftc): ${e.stderr || e.message}`);
  }
  const output = execFileSync(bin, { encoding: "utf8" });
  const result = { kinds: null, parts: new Map(), progressBar: new Map() };
  for (const z of output.split("\n").filter(Boolean)) {
    const t = z.split("\t");
    if (t[0] === "KINDS") result.kinds = t[1].split(",");
    else if (t[0] === "T") result.parts.set(`${t[1]}/${t[2]}`, t[3] === "-" ? null : { share: Number(t[3]), value: Number(t[4]) });
    else if (t[0] === "B") result.progressBar.set(Number(t[1]), { width: Number(t[2]), cbase: t[3] === "-" ? null : Number(t[3]) });
  }
  ios = result;
  return ios;
}

const equal = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
const show = (t) => (t == null ? "no part" : JSON.stringify(t));

test("Part: on 69 machines web (cbasePart) and iOS (CbaseRules.part) compute the same per kind — clamp, null, denominator", async () => {
  const w = await webRules();
  const i = iosRules();
  assert.deepEqual(i.kinds, [...w.CBASE_KINDS], `kinds: web ${w.CBASE_KINDS.join(", ")} · iOS ${i.kinds?.join(", ")}`);
  const cases = machineCases();
  const deviations = [];
  let withPart = 0;
  let clamped = 0;
  cases.forEach((h, n) => {
    for (const kind of w.CBASE_KINDS) {
      const tw = w.cbasePart({ at: 0, ...h, cpu: { ...h.cpu, load5: 0, load15: 0 } }, kind);
      const ti = i.parts.get(`${n}/${kind}`);
      assert.ok(ti !== undefined, `iOS printed nothing for case ${n}/${kind}`);
      const matches = tw === null || ti === null ? tw === ti : equal(tw.share, ti.share) && equal(tw.value, ti.value);
      if (!matches) deviations.push(`case ${n} ${kind}: web ${show(tw)} · iOS ${show(ti)} — ${JSON.stringify(h)}`);
      if (tw) {
        withPart++;
        const total = { ram: h.mem.totalBytes, last: h.cpu.count, swap: h.swap?.totalBytes, disk: h.disk?.totalBytes }[kind];
        if (tw.share < tw.value / total - 1e-12) clamped++;
      }
    }
  });
  console.log(`  [cbase web↔iOS] ${cases.length} machines × 4 kinds: ${withPart} with part, of which ${clamped} clamped, ${cases.length * 4 - withPart} without`);
  assert.deepEqual(deviations, [], "web and iOS compute cbase's part differently");
  // The cases say something: there are parts, clamped ones and none.
  assert.ok(withPart > 100 && clamped > 10 && cases.length * 4 - withPart > 30, `the cases do not cover the branches (${withPart} / ${clamped})`);
});

test("Bar: web (progressBarParts) and iOS (CbaseRules.progressBar) split the same — used amount capped, cbase in % of the used amount", async () => {
  const w = await webRules();
  const i = iosRules();
  const deviations = [];
  PROGRESS_BAR.forEach(([share, cbase], n) => {
    const bw = w.progressBarParts(share, cbase);
    const bi = i.progressBar.get(n);
    if (!bi || !equal(bw.width, bi.width) || !equal(bw.cbase, bi.cbase)) deviations.push(`(${share}, ${cbase}): web ${JSON.stringify(bw)} · iOS ${JSON.stringify(bi)}`);
  });
  console.log(`  [cbase web↔iOS] ${PROGRESS_BAR.length} bars`);
  assert.deepEqual(deviations, [], "web and iOS split the bar differently");
});
