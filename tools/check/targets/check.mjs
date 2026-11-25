// Checks before every deploy. Deliberately the same ones that used to run by hand before every
// hand-over — only no longer optional and no longer from memory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "../config-repo.mjs";
import { probe, shProbe } from "../lib/sh.mjs";
import { treeFiles } from "../lib/asar.mjs";
import { locGate } from "../lib/loc-gate.mjs";
import { isTapResult, stillRunningFiles, valuesSuite } from "../lib/test-output.mjs";
import { SLEPT_REASON, lastSleep, sleptBetween } from "../lib/sleep-watch.mjs";
import { readRegister, guardInTree, guardRegister, guardRegisterText } from "../lib/guard-register.mjs";
import { backImports, hookRegistry, hookRegistryText, routeRegistry, routeRuleViolations, schemaRegistry, schemaRegistryText } from "../lib/tree-rules.mjs";
import { report, manifestDiff, manifestOpen, readManifest } from "../lib/manifest-diff.mjs";
import * as log from "../lib/log.mjs";
import { gateKey, writeGateMarker } from "../lib/gate-marker.mjs";
import { DEFAULT_PLAN, buildSuites, planGlobs, planSuiteNames, suiteContext } from "../lib/gate-plans.mjs";
import { backendParallelism, backendParallelismText, runSuites, shortParallelism, shortSelection, suiteDeadlines } from "../lib/gate-plan.mjs";
import { takeLock } from "../lib/gate-lock.mjs";
import { isFlat } from "../lib/git.mjs";
import { publicFiles } from "../cleanliness.mjs";
import { scanSecrets } from "../secrets.mjs";

const SERVER_DIR = path.join(REPO, "server/backend/electron/server");
// The MCP server lies next to it and is itself a tree (lib.js, toolsets.js, tools/*.js);
// it is started by PATH, never imported — the smoke test below does not see it, `node --check` must.
const MCP_DIR = path.join(REPO, "server/backend/electron/mcp");

// The environment pre-check. Three reasons why whole groups of tests turn red without anything being wrong in the code — each
// stands as a row of its own before any suite runs:
//   shallow clone     the counter-tests `git show <sha>:…` do not find their states ⇒ red, and the gate ends AT ONCE (one row
//                     instead of a dozen red tests); `git fetch --unshallow` fetches the history.
//   uid 0 (root)      `chmod` does not lock root out — the cases in ROOT_DEPENDENT check a file that must not be readable or
//                     writable and turn red under root ⇒ a warning that names them.
//   node-pty          `require('node-pty')` in server/backend/ does not load (binary for another Node ABI, after a Node
//                     jump) ⇒ red with the way: `npm rebuild node-pty` in server/backend/.
// `environmentVerdict` is pure (the probes come in — tools/check/test-output.test.mjs drives it with injected values);
// `environmentMeasure` measures them on the tree. Unknown (git cannot be asked, no uid) is a warning, never "fine".
export const ROOT_DEPENDENT = Object.freeze([
  "server/backend/test/hosts-file.test.js",
  "server/backend/test/projectbox-delete.test.js",
  "server/backend/test/stacks-clear-away.test.js",
  "server/backend/test/stacks-result.test.js",
  "server/backend/test/stacks-return-path-program.test.js",
]);
export const FLAT_SENTENCE = "shallow clone — run `git fetch --unshallow` first";
export function environmentVerdict({ flat, uid, pty }) {
  const rows = [];
  const failures = [];
  if (flat === true) {
    rows.push(["Environment: clone", FLAT_SENTENCE, "bad"]);
    failures.push(`Environment: ${FLAT_SENTENCE}`);
  } else if (flat === false) rows.push(["Environment: clone", "full history", "ok"]);
  else rows.push(["Environment: clone", "unknown (git rev-parse --is-shallow-repository cannot be asked)", "warn"]);
  if (uid === 0) {
    rows.push(["Environment: user", `uid 0 (root) — chmod does not lock root out, these turn red: ${ROOT_DEPENDENT.map((f) => path.basename(f)).join(", ")}`, "warn"]);
  } else if (Number.isInteger(uid)) rows.push(["Environment: user", `uid ${uid}`, "ok"]);
  else rows.push(["Environment: user", "unknown (no uid)", "warn"]);
  if (pty?.ok === true) rows.push(["Environment: node-pty", "loads", "ok"]);
  else {
    const reason = String(pty?.error || "unknown").split("\n").map((z) => z.trim()).find((z) => /Error|error|not/.test(z)) || String(pty?.error || "unknown").trim().split("\n")[0];
    const set = `require('node-pty') does not load (${reason.slice(0, 160)}) — \`npm rebuild node-pty\` in server/backend/`;
    rows.push(["Environment: node-pty", set, "bad"]);
    failures.push(`Environment: ${set}`);
  }
  return { rows, failures, flat: flat === true };
}
export async function environmentMeasure() {
  const flat = await isFlat(REPO);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const r = await probe("node", ["-e", "require('node-pty')"], { cwd: path.join(REPO, "server/backend"), timeout: 60000 });
  return { flat, uid, pty: r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || `Exit ${r.code}` } };
}

// The package the backend prewarms and starts (`@playwright/mcp@<pin>`), read from its source by text: importing
// toolchain/playwright.js would open the store. An anchor that finds nothing throws — a renamed pin must not let the gate warm
// nothing and report green.
export function playwrightMcpPackage(source = fs.readFileSync(path.join(SERVER_DIR, "toolchain", "playwright.js"), "utf8")) {
  const pin = /^const PLAYWRIGHT_MCP_VERSION = "([^"]+)";$/m.exec(source)?.[1];
  if (!pin || !/const playwrightMcpPkg = `@playwright\/mcp@\$\{PLAYWRIGHT_MCP_VERSION\}`;/.test(source)) {
    throw new Error("toolchain/playwright.js: PLAYWRIGHT_MCP_VERSION / playwrightMcpPkg not found — update playwrightMcpPackage in tools/check/targets/check.mjs");
  }
  return `@playwright/mcp@${pin}`;
}

// RECURSIVE: a one-level check would be blind for providers/connectors/ and for everything that the feature folders
// produce.
function serverSources() {
  return [SERVER_DIR, MCP_DIR].flatMap((dir) => (treeFiles(dir) || []).map((f) => path.join(dir, f.rel)));
}

/**
 * Clean up orphaned test temp folders BEFORE the suite runs.
 *
 * The tests create their fixtures with `mkdtemp` under `cbase-<prefix>-XXXXXX` and clean up at the
 * end — but a still-writing child process causes `ENOTEMPTY`, and that only WARNS (rightly: a test
 * must not fail on cleanup). Nobody threw the leftovers away later; they pile up to thousands of
 * folders and tens of GB, each fixture folder carrying a data root with a database.
 *
 * Here and not in the test itself, because a test cannot clean up its own leftover (it fails on
 * exactly that) and a foreign one must not touch it while it runs. Before the run is the only
 * moment when nothing of it is surely in use.
 *
 * Careful: only the temp directory, only the `cbase-` prefix, only folders, and errors are
 * swallowed — foreign or root-owned leftovers are no reason to hold up a deploy.
 *
 * TWO SAFEGUARDS: several Claude sessions work on the same repo at once on this machine. A
 * blindly cleaning version pulled the floor from under the fixture folders of a PARALLEL suite.
 *   1. If `node --test` runs anywhere, NOTHING is cleaned. A foreign run matters more
 *      than a few cleaned gigabytes.
 *   2. Only what has not been touched for an hour is cleaned. A suite run takes
 *      minutes; what lies still for an hour belongs to no run any more.
 */
const REST_MIN_AGE_MS = 60 * 60 * 1000;
async function cleanTestLeftovers() {
  // A running test — no matter whose — makes cleaning an act of sabotage.
  // Character class in the pattern (`--tes[t]`): `pgrep -f` reads the command line of EVERY process, also
  // that of the shell running this command — with the bare pattern it always found itself, and the
  // cleaning was silently off (same trap as with the gateway restart in server.mjs).
  const running = await shProbe("pgrep -f 'node --tes[t]' | wc -l");
  if (Number(String(running.stdout).trim()) > 0) return { removed: 0, skipped: true };
  let removed = 0;
  const now = Date.now();
  for (const dir of new Set([os.tmpdir(), "/tmp"])) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.startsWith("cbase-")); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (!st.isDirectory() || now - st.mtimeMs < REST_MIN_AGE_MS) continue;
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      } catch { /* root-owned or in use right now — not our problem */ }
    }
  }
  return { removed, skipped: false };
}

// `plan` (lib/gate-plans.mjs) says WHAT is run: the suites, the register file, the line-count exceptions, the manifest-diff step
// and the marker scope. The default is the merged plan = what the gate has always run.
export async function check({ quick = false, quickReason = "--quick", plan = DEFAULT_PLAN, short = false } = {}) {
  log.step("Checks");
  // The load before the gate itself does anything — the one measurement that contains only FOREIGN work
  // (reasoning at the backend width below, computation in lib/gate-plan.mjs).
  let lastStart = os.loadavg()[0];
  const failures = [];
  // The tree is hashed BEFORE the suites: if someone changes it during the run, the marker no longer fits
  // the tree afterwards — and the next `deploy` runs the full gate again. Right so.
  const treeHash = quick ? "" : await gateKey();
  let registerRaw = null;
  let registerFiles = null;

  // 0. Leftovers of earlier runs. Only one row if there was something to say — otherwise noise.
  // The skipped word is deliberately visible: it means "something else is still running", and
  // you want to know that when reading a failed run.
  const leftovers = await cleanTestLeftovers();
  if (leftovers.skipped) log.table([["Test leftovers", "skipped — another test run is active", "ok"]]);
  else if (leftovers.removed) log.table([["Test leftovers cleaned", `${leftovers.removed} temp folders`, "ok"]]);

  // 0b. The environment pre-check (see environmentVerdict): shallow clone ⇒ red at once, with this one row.
  const environment = environmentVerdict(await environmentMeasure());
  log.table(environment.rows);
  if (environment.flat) throw new Error(`Checks failed:\n  - Environment: ${FLAT_SENTENCE}`);
  failures.push(...environment.failures);

  // 1. Syntax of every backend file — cheap and catches half the trouble before building.
  const sources = serverSources();
  const bad = [];
  for (const f of sources) {
    const r = await probe("node", ["--check", f]);
    if (r.code !== 0) bad.push(`${path.relative(REPO, f)}: ${r.stderr.trim().split("\n")[0]}`);
  }
  if (bad.length) failures.push(...bad);
  log.table([[`node --check (${sources.length} files)`, bad.length ? bad[0] : "clean", bad.length ? "bad" : "ok"]]);

  // 1b. Import smoke test. `node --check` sees neither a missing named export nor a TDZ in an import
  // cycle nor a forgotten import at module level — only a real import does. Low side effects
  // (two unref intervals in sse.js), main.js and headless.js import server.js at start the same way.
  const smoke = await probe("node", [
    "--input-type=module", "-e",
    `await import(${JSON.stringify(path.join(SERVER_DIR, "server.js"))}); await import(${JSON.stringify(path.join(SERVER_DIR, "store.js"))});`,
  ], { cwd: REPO, timeout: 60000 });
  const smokeErr = smoke.code === 0 ? "" : (smoke.stderr.split("\n").find((l) => /Error|error/.test(l)) || smoke.stderr.trim().split("\n")[0] || "Exit " + smoke.code);
  log.table([["Import smoke test (server.js, store.js)", smoke.code === 0 ? "importable" : smokeErr, smoke.code === 0 ? "ok" : "bad"]]);
  if (smoke.code !== 0) failures.push(`Import smoke test: ${smokeErr}`);

  // 1c. Guards over the tree. Pure functions over the file set; each has its red counter-test in
  // tree-rules.test.mjs.
  const tree = (treeFiles(SERVER_DIR) || []).map((f) => ({ path: f.rel, text: f.buf.toString("utf8") }));
  const MANIFEST = plan.manifest ? path.join(REPO, plan.manifest) : null;
  const manifest = MANIFEST && fs.existsSync(MANIFEST) ? readManifest(MANIFEST) : null;
  const rv = routeRuleViolations(tree);
  log.table([["Route functions (function, return NEXT)", rv.length ? rv[0] : "no violations", rv.length ? "bad" : "ok"]]);
  if (rv.length) failures.push(...rv);
  const reg = routeRegistry(tree);
  if (reg) {
    const txt = reg.ok
      ? `${reg.top} in ROUTES + ${reg.subTables.map((t) => t.names.length).join("/")} in sub-tables = ${reg.registered} registered, ${reg.declared} declared`
      : `not registered: ${reg.unregistered.join(", ") || "—"}; not declared: ${reg.undeclared.join(", ") || "—"}`;
    log.table([["Routes registered == declared", txt, reg.ok ? "ok" : "bad"]]);
    if (!reg.ok) failures.push(`Route registry: ${txt}`);
  } else {
    log.table([["Routes registered == declared", "no ROUTES literal (monolith) — nothing to count", null]]);
  }
  const bi = backImports(tree, manifest?.reverseImportsAllowed || []);
  const biTxt = bi.violations.length
    ? `forbidden: ${bi.violations.join(", ")}`
    : bi.hits.length
      ? `${bi.hits.length} allowed (Manifest): ${bi.hits.map((h) => h.path).join(", ")}`
      : "none";
  log.table([["Back imports onto server.js", biTxt, bi.violations.length ? "bad" : bi.hits.length ? "warn" : "ok"]]);
  if (bi.violations.length) failures.push(`Back imports onto server.js: ${bi.violations.join(", ")}`);
  // The hook registry: every fired kind has a registrar in server.js, every registrar a call site, kind names are
  // literals, the run kinds are those of the spec. Red means: a turn would run without its consumer or throw only at the
  // place that fires it — after the deploy, not here.
  // A call outside runs/ is no error, but never silent (warn): measured, today only the hub fires.
  const hr = hookRegistry(tree);
  if (hr) {
    log.table([["Hook registry (registrar == calls)", hookRegistryText(hr), hr.ok ? (hr.outsideRuns.length ? "warn" : "ok") : "bad"]]);
    if (!hr.ok) failures.push(...hr.violations.map((v) => `Hook registry: ${v}`));
  } else {
    log.table([["Hook registry (registrar == calls)", "no registry (runs/hooks.js without HOOK_KINDS) — nothing to count", null]]);
  }
  // The schema registry: every store/ topic file with CREATE/ALTER TABLE is registered in the
  // registration list at the end of store.js, and the schema runner is called exactly once — in initStore.
  // Red means: the tables of this file silently no longer come into being. No throw, no log, a database
  // without tables. That is why the signal is the SQL, not a maintained list.
  const sr = schemaRegistry(tree);
  if (sr) {
    log.table([["Schema registry (DDL == registration)", schemaRegistryText(sr), sr.ok ? "ok" : "bad"]]);
    if (!sr.ok) failures.push(...sr.violations.map((v) => `Schema registry: ${v}`));
  } else {
    log.table([["Schema registry (DDL == registration)", "no registry (store/schema.js missing) — nothing to count", null]]);
  }

  // 1d. Manifest diff: every moved file against its line ranges from the source at the pinned
  // commit — the proof that the move was byte-identical. Runs as long as a slice is open.
  if (MANIFEST && manifest && manifestOpen(manifest)) {
    const md = manifestDiff(REPO, MANIFEST);
    const rows = report(md);
    log.table([["Manifest-Diff (Split)", rows[0].replace(/^Manifest-Diff: /, ""), md.ok ? "ok" : "bad"]]);
    if (!md.ok) {
      failures.push(`Manifest-Diff: ${rows[0]}`);
      for (const l of rows.slice(1, 25)) log.detail(l);
    }
  }

  // 1e. The guard: no source file over 2,000 lines. The exceptions are printed EVERY time —
  // a silent exception could not be told from a forgotten one.
  const loc = locGate(REPO, path.join(REPO, plan.locAllowFile));
  const locTxt = loc.violations.length
    ? `${loc.violations[0].rel} (${loc.violations[0].rows} lines)${loc.violations.length > 1 ? ` and ${loc.violations.length - 1} more` : ""}`
    : loc.tot.length
      ? `dead exception: ${loc.tot[0].file} (${loc.tot[0].rows ?? "missing"}) — the list may only shrink`
      : `no file over ${loc.limit} lines except ${loc.covered.length} exception(s)`;
  log.table([["Line-count guard ≤ 2,000 lines", locTxt, loc.ok ? "ok" : "bad"]]);
  for (const g of loc.covered) log.detail(`${String(g.rows).padStart(6)}  ${g.rel} — ${g.fallsOutWith}`);
  if (!loc.ok) failures.push(`Line-count guard: ${locTxt}`);

  // 1f. The guard register: every file the gate runs is registered — and every
  // registration has its file. Red means in one direction "a test bench has vanished"
  // (the glob then silently finds one file fewer and reports green — the same kind as the
  // omitted bench sections), in the other "a new test bench is not registered".
  // The second direction COSTS one row per new test, and that is intended: it is the one moment
  // in the flow where the question asks itself — which guard catches the change I am building?
  // The register is a repo file, not an accessory: if it is missing, that is an error and not
  // "then without". Without this row `registerFiles` would be empty, the web suite would fall back to
  // `echo 'none'` and the gate would report GREEN because it ran nothing — exactly the kind
  // the register is built against, one floor up.
  const regRel = [].concat(plan.registerFile);
  const reg2Files = regRel.map((f) => path.join(REPO, f));
  const regMissing = regRel.find((f, i) => !fs.existsSync(reg2Files[i]));
  if (regMissing) {
    log.table([["Guard register (file == registration)", `${regMissing} missing — without it the gate does not know what to run`, "bad"]]);
    failures.push(`Guard register: ${regMissing} missing`);
  } else {
    const read = readRegister(reg2Files, planGlobs(plan));
    registerRaw = read.raw;
    registerFiles = read.files;
    // A suite directory that is gone is an error of its own (guardInTree throws), never an empty tree.
    let tree = null;
    try { tree = guardInTree(REPO, planGlobs(plan)); } catch (e) {
      log.table([["Guard register (file == registration)", e.message, "bad"]]);
      failures.push(`Guard register: ${e.message}`);
    }
    if (tree) {
      const rr = guardRegister(tree, registerFiles);
      log.table([["Guard register (file == registration)", guardRegisterText(rr), rr.ok ? "ok" : "bad"]]);
      if (!rr.ok) {
        failures.push(`Guard register: ${rr.violations[0]}`);
        for (const v of rr.violations.slice(1, 10)) log.detail(v);
      }
    }
  }

  // 2. Whitespace errors in the diff.
  const ws = await shProbe("git diff --check", { cwd: REPO });
  log.table([["git diff --check", ws.code === 0 ? "clean" : ws.stdout.trim().split("\n")[0], ws.code === 0 ? "ok" : "bad"]]);
  if (ws.code !== 0) failures.push("git diff --check reports whitespace errors");

  // 2b. Type check of the web client. It is the only guard against a whole family of errors: a client that
  // compares a value the server never sends. With a literal union in the API types tsc reports TS2367
  // ("no overlap") for it. Costs under a second, so it also runs in `--quick` and thus in the pre-push hook.
  //
  // Its limit: most declared properties in `web/src/lib/api/` are a bare `string` (tsc catches nothing there). And
  // a union is a CLAIM about the server, not a guard against it — the values stand on the server side
  // as bare literals in several places without a constant.
  const tscBin = path.join(REPO, "web/node_modules/.bin/tsc");
  if (fs.existsSync(tscBin)) {
    const t = await probe(tscBin, ["--noEmit", "-p", "web"], { cwd: REPO, timeout: 300000 });
    const first = (t.stdout + t.stderr).split("\n").find((l) => /error TS\d+/.test(l)) || "";
    log.table([["tsc --noEmit -p web", t.code === 0 ? "no type errors" : first.trim() || `exit ${t.code}`, t.code === 0 ? "ok" : "bad"]]);
    if (t.code !== 0) failures.push(`tsc: ${first.trim() || `Exit ${t.code}`}`);
  } else {
    // Not silently skipped: a missing check cannot be told from a passed one — exactly the trap
    // the skip guard stands against one row further down.
    log.table([["tsc --noEmit -p web", "web/node_modules missing — not checked (npm ci --prefix web)", "warn"]]);
  }

  // 2c. The second, foreign secret scanner (gitleaks, tools/check/secrets.mjs) over the public files — a few seconds, so it also runs
  // in `--quick` (the pre-push hook) and in the export's own gate. Missing is red: an unchecked tree is not a clean one.
  const sec = scanSecrets({ root: REPO, files: publicFiles(REPO) });
  if (sec.missing) {
    log.table([["Secrets (gitleaks)", "gitleaks is not installed — not checked (brew install gitleaks, see CONTRIBUTING)", "bad"]]);
    failures.push("gitleaks is not installed: the public tree is not scanned for secrets");
  } else {
    const first = sec.findings[0];
    log.table([[`Secrets (gitleaks ${sec.version})`, sec.findings.length ? `${sec.findings.length} finding(s), first: ${first.rule} ${first.file}:${first.line}` : `0 findings in ${sec.scanned} public files`, sec.findings.length ? "bad" : "ok"]]);
    if (sec.findings.length) failures.push(`gitleaks: ${sec.findings.map((f) => `${f.rule} ${f.file}:${f.line}`).slice(0, 10).join(", ")}`);
  }

  if (quick) {
    if (failures.length) throw new Error(`Checks failed:\n  - ${failures.join("\n  - ")}`);
    log.ok(`Quick check passed (tests skipped: ${quickReason})`);
    return;
  }

  // 3. Test suites.
  //
  // `--test-concurrency=3` is no cosmetic wish: every backend file starts a real server with fake CLI
  // child processes, and several suites wait for REAL deadlines (the auto-continue waits at least 20 s
  // before continuing). With the default (cores − 1, here nine files at once) these runs starve on the
  // CPU and miss their deadlines — measured: fully parallel 1–3 changing failures, at 3 all green.
  // A gate that ends this way one time and that way the next checks nothing.
  // The limit deadlines as a knob: ten tests run through the auto-continue path and waited 45 s of REAL
  // wall clock each — the lion's share of every check phase. 2 s are enough to still observe the waiting
  // state (at 0 the run would continue before a test can even see it "waiting"). In production 45 s still
  // apply; limits.js reads both values at every call, not at import.
  // Third knob: the auto-continue sweeper runs every minute in production, and a row that meets a running chat
  // when woken is pushed on by exactly one beat. In the test that means 60 s of wall clock for one second of
  // substance. In production it stays at 60 s — `autoContinueSweepMs()` reads at every call.
  // Fourth knob, in the OTHER direction: the stall deadline of the subagents (600 s in production) stands at one hour in
  // the gate. A fake child waiting at a gate shows no progress — under load that must never become a stall abort. A stall
  // is triggered in the gate only by the test seam (`advanceStallClock`, runs/agents.js); `agentStallDeadline()` reads at every turn.
  // Fifth knob: the limit per section of a dynamic workflow (30 s in production) stands FIXED at 5 s in the gate — the
  // guard loop would otherwise hold the test process for half a minute; real scripts of the suite take milliseconds per
  // section. `sectionDeadline()` (dynworkflows/sandbox.js) reads at every start.
  // Three more: the caps of the workflow agents FIXED — 16 per run (instead of the CPU formula — otherwise a test
  // with many agent() calls would run differently on a Mac than on a 4-vCPU runner), 8 per user (the default) — and the
  // prompt-cache staggering at 0 (in production up to 5 s per agent of the same kind, which cost every test wave). A test
  // that checks a cap or the staggering sets it itself. The stall deadline of the workflow agents (180 s in production) stands,
  // like that of the subagents, at one hour — in the gate only the test seam (advanceStallClock) triggers a stall, never a
  // fake child waiting at a gate under load.
  const fastDeadlines = "CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 CBASE_DYNWF_SECTION_MS=5000"
    + " CBASE_DYNWF_RUN_CAP=16 CBASE_DYNWF_USER_CAP=8 CBASE_DYNWF_STAGGER_MS=0 CBASE_DYNWF_STALL_MS=3600000"
    // The cap per recovery stage (300 s in production) in the OPPOSITE direction like the stall deadlines — a fake
    // service waiting at a gate for "healthy" must never fail at the cap under load; the cap case is triggered in the
    // gate only by the clock seam (projectbox/restore.js advanceStagesCap).
    + " CBASE_PROJECT_STAGE_MS=3600000"
    // The main agent never waits (agent-wait.js; 0 in production): in the gate in the OPPOSITE direction like the stall
    // deadlines — most agent tests fetch the report in the call (`run_in_background: false`, cbase_agent_output)
    // because they measure something else. What holds in the product is held by main-agent-waiting-never.test.js, which removes the knob itself.
    + " CBASE_MAIN_AGENT_WAIT_MS=3600000";

  // The reporter EXPLICITLY, on every suite. Up to Node 22 `node --test` writes TAP by itself without a
  // terminal, and only TAP can be read by `valuesSuite` (totals AND skip titles). From Node 23 the default
  // without a terminal is the spec format too — a skipped test came as `ℹ skipped 1`, and the verdict
  // was green. Under Node 22 the flag changes no byte of the output. A spec output is red in
  // `valuesSuite` itself; here is why it does not arise at all.
  // Guard: `test-output.test.mjs` ("EVERY node --test call in check.mjs carries …").
  //
  // And the stdout guard (`--import`, passed on to every test file's child through the runner's execArgv): plain text a test prints
  // on stdout goes to stderr, so it can no longer share a read with the runner's framed messages — Node 22 reads such text as a frame
  // and fails the file with "Unable to deserialize cloned data" (lib/test-stdout-guard.mjs; it struck tools/deploy/init.test.mjs
  // under load). Relative to the repository root, the cwd of every suite. Guard: `test-stdout-guard.test.mjs`.
  const NODE_TEST = "node --test --test-reporter=tap --import=./tools/check/lib/test-stdout-guard.mjs";

  // When a suite is aborted (lib/gate-plan.mjs `suiteDeadlines`): the same rule for EVERY suite — stall
  // (300 s without a test result on the TAP stream, `isTapResult`) and an emergency cap of one hour over the total duration.
  // A total deadline (900 s, growing with the width for the backend) would abort a backend without a red test.
  // Knobs: `CBASE_SUITE_STALL_MS` (the silence), `CBASE_SUITE_TIMEOUT_MS` (the emergency cap).
  const deadlines = suiteDeadlines({ defaultStillMs: process.env.CBASE_SUITE_STALL_MS, defaultCapMs: process.env.CBASE_SUITE_TIMEOUT_MS });
  // The 3 dates from the early days and was fixed at 173 tests; today it is far more. Measured on a 14-core Mac,
  // one full backend run each:
  //
  //     3 → 466 s     6 → 329–346 s     10 → 212 s     14 → 163 s     20 → 155 s
  //
  // Beyond 10 every doubling still brings a tenth, and the margins shrink (the golden runs
  // 34.8 → 62.7 s, the storage wake-up once 6.5 s). So 10 as the cap, and four cores stay free:
  // every server test spawns a server and a fake CLI.
  //
  // Derived instead of nailed down: on 4 vCPU the 3 was measured. The formula gives this Mac 10 and a 4-core
  // machine 3, without one number having to guess for both. `CBASE_TEST_CONCURRENCY` overrides it.
  //
  // On top, the LOAD counts: what other builders occupy on this machine is missing for the backend
  // (computation and base load in lib/gate-plan.mjs). Measured twice — at the gate start (anew after waiting
  // at the lock) and immediately before the backend —, the SMALLER counted. Reason: `loadavg[0]` is a mean over the
  // last minute, and the short suites beforehand lift it within 10–12 s from 6.5 to 15–27. Measured before the backend alone,
  // the gate would count its own, already ended processes as foreign load and always run with 3. The gate-start
  // measurement sees only what ran before us; its limit: foreign work that starts only during the short
  // suites is not counted.
  const cores = os.availableParallelism?.() || os.cpus().length || 4;
  let backend = null;
  // Every SHORT suite gets its width explicitly (otherwise: the default of node --test, cores − 1
  // per suite, six suites side by side). Counted from the register, which was already held against the tree above.
  // The suites themselves (commands, the register globs, the platform-bound benches of latch.json → onlyMacOS) are the PLAN's
  // (lib/gate-plans.mjs); this is the context their builders are measured against. The order here is that of the OUTPUT.
  // Running happens in two phases (lib/gate-plan.mjs, `runSuites`): all short ones together, then the backend — whose command is
  // therefore a function, built only at the moment it starts.
  const ctx = suiteContext({
    plan, repo: REPO, NODE_TEST, fastDeadlines, cores, registerRaw, registerFiles,
    getBackend: () => backend, onMac: process.platform === "darwin",
  });
  const built = buildSuites(plan, ctx);
  // `--short`: the long suite stays out, in ONE row that says so (never a silent gap), and no marker is written below.
  const selection = short ? shortSelection(built.suites) : { run: built.suites, leftOut: [] };
  const suites = selection.run;
  for (const name of selection.leftOut) log.table([[`${name} tests`, "left out (--short: only the full gate runs it)", "warn"]]);
  // A suite that cannot be built (directory gone, no files) is a red row with its reason — never a silent "none".
  for (const e of built.errors) {
    log.table([[`${e.name} tests`, e.message, "bad"]]);
    failures.push(`${e.name} tests: ${e.message}`);
  }
  // The RECORDING switches of the anchor tests do not belong in a gate. If one stands in the shell — after a deliberate
  // re-recording it easily stays —, the run WRITES the anchors anew against which it should check, and reports green:
  // the golden runs, code-scopes and reducer tests read them at start. A guard that measures itself against what it just
  // wrote itself checks nothing. So strike them from the child environment — and say that it happened;
  // silent could not be told from "was never set".
  const RECORDER = ["CBASE_GOLDEN_RECORD", "CBASE_CODE_SCOPES_RECORD", "CBASE_BUBBLES_RECORD"];
  const testEnv = { ...process.env };
  const struck = RECORDER.filter((k) => testEnv[k]);
  for (const k of RECORDER) delete testEnv[k];
  if (struck.length) log.detail(`Recording switches struck from the test environment: ${struck.join(", ")} — a gate measures, it writes no anchors`);
  // And `NODE_TEST_CONTEXT`: it stands in the environment of every process a `node --test` starts.
  // If the gate itself runs under a test runner, the suites would inherit it — and `node --test` then writes
  // NOTHING and ends with exit 0, even for a failure. `valuesSuite` is red on an empty output;
  // here the cause is removed.
  delete testEnv.NODE_TEST_CONTEXT;
  // And the installation's deploy.local.json (host, root, port of the maintainer's server — present only in a rollout clone):
  // the suites test the code, not one installation. Without it a development clone and a rollout clone run the same suites,
  // which is what lets a marker serve both (lib/gate-marker.mjs). config.mjs reads the file only when this is not "off".
  testEnv.CBASE_DEPLOY_LOCAL = "off";
  // And the network: `embeddings.js` caches the model under `$HOME/.cache/cbase-models`, and
  // almost every test file sets HOME to a fresh temp directory — every test process loaded the model
  // (~130 MB) from Hugging Face. On a fast line 13 s in the background, on a slow one 15 min: a test
  // that waited first for the model hung that long, and the backend ran into the suite deadline. Offline
  // it loads from the cache under node_modules — the same model, without network; if the cache is missing, the
  // lexical fallback applies. A gate measures the code, not the line.
  testEnv.CBASE_EMBED_OFFLINE = "1";
  testEnv.CBASE_UI_LANG = "de";   // the backend tests read the German output of the translation table (i18n.js: English otherwise)
  // The same trap with the OpenRouter catalog: every server start with its own data folder has no
  // catalog file and would otherwise fetch it from openrouter.ai (≈ 1 MB, per test process). Offline blocks
  // only the REAL base — the agent harness sets `CBASE_OPENROUTER_BASE` to its fake endpoint, which stays
  // reachable (providers/openrouter-catalog.js). Guards: tools/check/test-output.test.mjs (set and read),
  // server/backend/test/openrouter-catalog.test.js (what it blocks).
  testEnv.CBASE_OPENROUTER_OFFLINE = "1";
  // The browser of a chat: every turn of a coding chat starts it — in the suites that would mean a real Chromium per test turn
  // (over a hundred files with turns, ≈ 1 s and several hundred MB per start) and a trace `browser-profiles/chat-<id>` in
  // every test that counts the traces of a chat. Off; the guards of the chat browser
  // (server/backend/test/agent-user-browser.test.js, chat-browser.test.js) switch it on again for themselves.
  testEnv.CBASE_CHAT_BROWSER_OFF = "1";
  // And the account: `account/usage.js` reads the keychain on macOS
  // (`security find-generic-password … "Claude Code-credentials"`). A test without its own substitute thus read
  // the REAL account state of this Mac — and if its session window stood at 100 %, a test turn parked at the limit gate
  // until the reset. A `security` that finds nothing, up front in PATH, and no token from the shell: a test that
  // needs an account builds its own substitute (like the roughly twenty with their own `security` shim, which put their
  // directory BEFORE this PATH), all others see none. A gate measures the code, not the quota of whoever runs it.
  // Guard: tools/check/test-output.test.mjs.
  const fakeAccount = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-account-"));
  fs.writeFileSync(path.join(fakeAccount, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  testEnv.PATH = `${fakeAccount}${path.delimiter}${testEnv.PATH || ""}`;
  delete testEnv.CLAUDE_CODE_OAUTH_TOKEN;
  // And the machine's git-lfs. The tests that run git with LFS bring their own fake git-lfs (server/backend/test/fake-lfs.mjs, in
  // a directory BEFORE this PATH), and "without git-lfs" is the state of every other test — the Mac has none, the product finds
  // out by git's own answer (runtime/git-run.js lfsFetch: "'lfs' is not a git command"). A machine with git-lfs installed (the
  // GitHub ubuntu runner: /usr/bin/git-lfs and `filter.lfs.process` in /etc/gitconfig) changed that under the tests: the clone of
  // project-clone handed its checkout to the fake's missing filter protocol and waited for ever (the backend's 300 s stall in
  // CI), "without git-lfs" cases took the LFS path, copy checkouts died with "smudge filter lfs failed". So: git without the
  // system file (the tests build their own configuration: HOME, GIT_CONFIG_GLOBAL, `-c`), and a `git-lfs` here that answers like
  // a git without it. Guard: tools/check/test-output.test.mjs.
  testEnv.GIT_CONFIG_NOSYSTEM = "1";
  fs.writeFileSync(path.join(fakeAccount, "git-lfs"), "#!/bin/sh\necho \"git: 'lfs' is not a git command. See 'git --help'.\" >&2\nexit 1\n", { mode: 0o755 });

  // Only one gate at a time, machine-wide (lib/gate-lock.mjs): a second `./check`
  //  — or the gate of a a full deploy — waits here until the first has its suites through,
  // and says so in ONE row. Only here and not at the start: the quick checks above cost
  // seconds and should report a syntax error at once, not after eleven minutes of a foreign gate. The
  // quick path (`--quick`, the pre-push hook) has already returned above and never takes it.
  const lock = await takeLock({
    who: REPO,
    report: (z) => log.info(`waiting for the gate of pid ${z.pid}${z.who ? ` (${z.who})` : ""}${z.since ? ` since ${new Date(z.since).toLocaleTimeString("en-GB")}` : ""} — only one gate at a time on this machine`),
  });
  if (lock.taken) {
    const like = lock.waited
      ? `taken after waiting ${log.mmss(lock.waitTimeMs)}`
      : lock.takenOver
        ? `taken — leftover of pid ${lock.takenOver.pid} (${lock.takenOver.reason}) cleared`
        : "taken";
    log.table([["Gate lock", `${like} (${lock.file})`, "ok"]]);
    // Whoever waited measures anew: the number from the start contained the gate that was waited for.
    if (lock.waited) lastStart = os.loadavg()[0];
  } else {
    log.table([["Gate lock", `without lock — ${lock.reason}`, "warn"]]);
  }

  // The npx cache of the pinned Playwright MCP, filled ONCE before the suites. Every server start prewarms it in the background
  // (toolchain/playwright.js prewarmPlaywrightMcp: `npx -y @playwright/mcp@<pin> --version`) — in the suites that is hundreds of
  // starts at once. On a warm cache that is a lookup; on a cold one (a fresh CI runner) the concurrent npx installs write into the
  // same `_npx/<hash>` folder, and a real MCP start in between died with MODULE_NOT_FOUND (playwright-core half written; Linux CI,
  // 21.11.2026). Here sequentially, before the first test; the pin is read from the source, so the two cannot drift apart.
  const mcp = playwrightMcpPackage();
  const warm = await probe(process.env.NPX_BIN || "npx", ["-y", mcp, "--version"], { cwd: REPO, timeout: 300_000, env: testEnv });
  const warmNote = warm.code === 0 ? `${mcp} ready (${String(warm.stdout).trim().split("\n").pop()})` : `${mcp}: ${(String(warm.stderr).trim().split("\n").pop() || `exit ${warm.code}`).slice(0, 200)}`;
  log.table([["Playwright MCP in the npx cache", warmNote, warm.code === 0 ? "ok" : "bad"]]);
  if (warm.code !== 0) failures.push(`Playwright MCP in the npx cache: ${warmNote} — the real-MCP tests would start it cold and concurrently`);

  // Two phases, output in a fixed order (lib/gate-plan.mjs): the short suites
  // together, THEN the backend.
  const start = (name, cmd) => shProbe(cmd, { cwd: REPO, timeout: deadlines.capMs, stall: { ms: deadlines.stillMs, progress: isTapResult }, env: testEnv });
  const shortBegin = Date.now();
  // Between the phases: the backend width from the load, chosen number AND measurement in the row.
  const beforeLang = () => {
    log.detail(`short suites first: ${((Date.now() - shortBegin) / 1000).toFixed(1)} s`);
    const lastBackend = os.loadavg()[0];
    backend = backendParallelism({ cores, last: Math.min(lastStart, lastBackend), preset: process.env.CBASE_TEST_CONCURRENCY });
    log.table([["Backend parallelism", backendParallelismText(backend, { lastStart, lastBackend, deadlines }), null]]);
  };
  let results;
  const sleepBefore = lastSleep();   // lib/sleep-watch.mjs: a sleep during the suites makes every red row below about the sleep
  try {
    results = await runSuites(suites, start, { beforeLang });
  } finally {
    if (lock.taken) lock.release();
  }
  if (sleptBetween(sleepBefore, lastSleep())) {
    log.table([["System sleep", SLEPT_REASON, "bad"]]);
    failures.push(SLEPT_REASON);
  }
  const resultsValue = [];
  for (const [i, [name]] of suites.entries()) {
    const r = results[i];
    // The four guards (readable form — TAP or `none` —, exit code, `# fail N`, `# skipped N`)
    // stand in lib/test-output.mjs and run there under a test of their own against REAL
    // node --test output.
    // `abort` only if a deadline REALLY struck (lib/sh.mjs `stall` / `timedOut`): then the output is cut off,
    // and the row says so — which deadline, how many tests reported, which one last.
    const abort = r.stall ? { kind: "stall", ms: deadlines.stillMs } : r.timedOut ? { kind: "cap", ms: deadlines.capMs } : null;
    const { line, skips, red, reason } = valuesSuite(name, r.stdout, r.code, { expectedSkips: ctx.skipsFor(name), abort });
    log.table([[`${name} tests`, !red ? line || "passed" : line || "failed", !red ? "ok" : "bad"]]);
    resultsValue.push(`${name} ${(line || "").replace(/\s*#\s*/g, " ").trim() || (red ? "red" : "green")}`);
    if (red) {
      failures.push(reason);
      // A stall names the files that still ran (lib/sh.mjs `running`): the culprit, not the file before it.
      if (r.stall) {
        const files = stillRunningFiles(r.running).map((f) => path.relative(REPO, path.resolve(REPO, f)));
        log.detail(files.length ? `still running at the stall: ${files.join(", ")}` : "still running at the stall: no test file found in the process group");
        if (files.length) failures.push(`${name} tests: still running at the stall: ${files.join(", ")}`);
      }
      // Name the skipped — otherwise only a number stands there and nobody knows which guard
      // did not run.
      for (const l of r.stdout.split("\n").filter((l) => /^ok .*# SKIP/.test(l)).slice(0, 8)) log.detail(l.trim());
      for (const l of r.stdout.split("\n").filter((l) => /^not ok |^\s+error:/.test(l)).slice(0, 8)) log.detail(l);
    }
  }

  if (failures.length) throw new Error(`Checks failed:\n  - ${failures.join("\n  - ")}`);
  log.ok("all checks passed");
  // The marker only AFTER the verdict and only for a full gate (see lib/gate-marker.mjs) — `--short` is none.
  if (short) return;
  // The key was taken at the start, before the wait at the lock and the suites. Whatever changed since (an edit, a pull, an npm
  // ci) was tested in part or not at all: the marker vouches for nothing then. Same key at the end, or no marker.
  const keyAfter = treeHash ? await gateKey() : "";
  if (treeHash && keyAfter !== treeHash) {
    log.detail(`No gate marker: the tree or its environment changed during the gate (${treeHash.slice(0, 12)} → ${keyAfter.slice(0, 12) || "unknown"}) — the next deploy runs the suites.`);
    return;
  }
  const marker = writeGateMarker({ hash: treeHash, result: resultsValue.join(" · "), scope: plan.markerScope, suites: planSuiteNames(plan) });
  if (marker?.notWritten) log.detail(`Gate marker not written (${marker.notWritten}) — the gate stays green; the next deploy runs the suites.`);
  else if (marker) log.detail(`Gate marker written (${treeHash.slice(0, 12)}) — a deploy with the same tree and environment within an hour, from any clone on this machine, does not repeat the suites (--recheck forces it).`);
}
