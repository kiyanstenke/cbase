// Recreating a project container (projectbox/recreate.js) and the follow-ups that hang on it (projectError in /api/runs/active, the
// recreate of a missing container, the resume after a crash).
//
// What holds here:
//   (1)  desiredActual as a table: equal · image differs · no label cbase.mounts(.v2) · mounts differ · both · container missing · image
//        unknown; the id with and without `sha256:`; without a desired value NO verdict (TypeError).
//   (1b) Hash transition: `cbase.mounts.v2` first; without it `cbase.mounts` against the old formula of now (⇒ `recognize`), else
//        against the recognised value of the row — one table.
//   (2)  The check-back knob (CBASE_RECREATE_CHECK_BACK_MS): default 60 s, whole number ≥ 100, anything else the default.
//   (3)  Without the ops mark nobody earmarks, nobody checks, and the fake docker sees no call.
//   (4)  /api/runs/active carries `projectError` as the NUMBER of converted instances in `error` — no ids, no reasons, not in `busy`;
//        an unconverted row in `error` and a ready one do not count.
//   (4b) /api/runs/active carries `converted` as the NUMBER of converted PROJECTS (rows with `converted_at`, once per project, whatever
//        the state) — no ids, not in `busy`, and 0 is there too (the deploy reads a missing field as "unknown").
//   (5)  The core: deviation (new image) and a running turn ⇒ the check at turn start earmarks, the attempt finds the turn open — NO
//        stop while the turn runs; after its end `docker stop -t 30 <old id>` → `docker rm <old id>` (without -f, by id) → `docker run`
//        with the same --ip, hostname, volume → the desired containers start (stages); a turn that arrives DURING the recreate waits
//        (`queued`, `locked`) and runs afterwards, in the new container. Before: without deviation a turn checks and earmarks nothing.
//        Also: doRun WAITS for the check at turn start — while the (wrapped) turn observer hangs at a gate, the turn runs (`runs: 1`)
//        and a second message queues up; and the recreate ends the project's terminals (`proj:<id>` and `chat:<chatId>` of a chat of
//        the project, with a notice), a foreign terminal (`ws:…`) lives on.
//   (6)  Container missing at restart: restore `error` ⇒ request via server.js ⇒ recreate at idle ⇒ `ready` with a new container at
//        the same IP — without stop and without rm.
//   (7)  Restart with three rows: a ready one with an old image (check time "restart": restore first, then recreate), an orphaned
//        `recreate` without container (resume: creation only) and an orphaned `recreate` whose container already matches (resume:
//        restore only). Right after the hook chain ALL three procedures live — "project-instances" put none on `error`.
//   (8)  If the recreate fails (the fresh container reports `phase=error`): `error` with reason, exactly ONE stop/rm/run — no loop,
//        no new earmark.
//   (9)  A resume (orphaned `recreate`, container "equal") whose restore finds `phase=error` at the OLD container recreates in the
//        SAME restart — exactly one stop/rm (old id) and one run, then `ready`; the request from this pass is accepted instead of
//        dropped (only for a resume without creation).
//  (10)  A new content IN PLACE of a read-only file (settings.json) ⇒ equal; a container with the label of the OLD formula
//        (mountsHashV1, state unchanged) ⇒ equal (transition); replacing by rename ⇒ "mounts differ", ONE recreate, and the new
//        container carries the hash of the new formula. A creation carries BOTH labels (v1 in `cbase.mounts` for the release before,
//        v2 in `cbase.mounts.v2`); the incident path — a container with ONLY the v1 label, the first check recognises it (the row
//        then carries v2 of now), THEN an appendFileSync on a read-only file (same inode) ⇒ equal, no recreate; only the rename
//        recreates.
//  (11)  A copy without container ⇒ the recreate creates ITS container (name, labels, copy root, never the project folder), the check
//        afterwards is equal; a second one keeps IP, hostname, volume; `recreateRestartGraceSeam.check` checks the copy; the main stays
//        untouched throughout.
//
// Wait only for events: gates of the fake docker and the fake CLI, states (`waitForTruthy` without deadline), the server's quiet, the
// promise of the check at turn start (runs/instance.js turnCheckOpen). The check-back beat is small (100 ms) — it is the product's way
// out when idle comes without a turn end, not a criterion.
//
// COUNTER-PROBES (one sabotage at a time, the affected tests run, each red WITHOUT a hang):
//   recreate.js: attemptsRecreate without idle (lock always ok)               ⇒ (5) red ("in another state in the middle of the turn")
//   recreate.js: `docker rm <name>` instead of `<id>`                          ⇒ (5), (7), (8) red ("rm by id, without -f")
//   recreate.js: recreateRequest without the "active" check                   ⇒ (8) red ("a second pass — the loop")
//   server.js: setTurnObserver removed                                         ⇒ (5) red ("no check at turn start")
//   server.js: setRecreateRestartGrace removed                                 ⇒ (7) red (the orphaned row stands on error)
//   server.js: earmarkRestore removed                                          ⇒ (6), (7) red ("not earmarked")
//   restore.js: the missing container without `recreate: true`                 ⇒ (6) red (stays error)
//   runs/routes.js: `projectError` removed from the answer                     ⇒ (4), (8) red
//   runs/do-run.js: not waiting for turnCheckOpen                              ⇒ (5) red ("the chat left running before its check ended")
//   recreate.js: projectLocks with terminalsLater                              ⇒ (5) red ("the project's shell still hangs …")
//   recreate.js: the exception of the resume removed                           ⇒ (9) red ("the resume stopped at the broken container")
//   recreate.js desiredValues without `desiredMountsHashV1` (no transition)    ⇒ (10) red ("label of the old formula": earmarked)
//   instance.js: creation and desired value with the old formula again         ⇒ (10) red ("new content in place": earmarked)
//   recreate.js desiredValues with the main's mounts (without `instance`)      ⇒ (11) red ("differs from its desired value")
//   recreate.js recreateRestartGraceSeam.check without `instance` (the main)   ⇒ (11) red ("the restart grace did not check the copy")
//   checkRecreate without comparing against the recognised value               ⇒ (10) red ("appendFileSync in place: … mounts differ")
//   checkRecreate without keeping (`store.changeProjectInstance` removed)      ⇒ (10) red ("the new hash of now is not recognised")
//   creation without `hashV1` (only the v2 label)                              ⇒ (10) red ("cbase.mounts does not carry the OLD formula")
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DIRS } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { procedureAlive, setInstanceState } from "../electron/server/projectbox/instances.js";
import { createInstance, desiredMounts } from "../electron/server/projectbox/instance.js";
import {
  CHECK_BACK_MS, recreateCheckBackMs, checkRecreate, recreateStatus, earmarkRecreate, recreateRequest,
  recreateRestartGraceSeam, recreateTurnObserver, setCreationOptions, desiredActual,
} from "../electron/server/projectbox/recreate.js";
import { advanceStagesCap } from "../electron/server/projectbox/restore.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { setTurnObserver, turnCheckOpen } from "../electron/server/runs/instance.js";
import { killTerminal } from "../electron/server/terminal.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

const ID_NEW = "5e".repeat(32);
const IMAGES = { "cbase-projectbox:latest": ID, "cbase-projectbox:new": ID_NEW };

// ── (1) desiredActual ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) desiredActual: equal, image, label missing, mounts, both, container missing, image unknown; id with/without sha256:; without desired value no verdict", () => {
  const A = "a1".repeat(32);
  const B = "b2".repeat(32);
  // Compared is `cbase.mounts.v2` (the cases without it: (1b)).
  const c = (image, hash) => ({ Image: image, Config: { Labels: hash === undefined ? {} : { "cbase.mounts.v2": hash } } });
  const cases = [
    ["equal", c(`sha256:${A}`, "h1"), `sha256:${A}`, "h1", { equal: true, fresh: [] }],
    ["equal, desired without sha256:", c(`sha256:${A}`, "h1"), A, "h1", { equal: true, fresh: [] }],
    ["equal, actual without sha256:", c(A, "h1"), `sha256:${A}`, "h1", { equal: true, fresh: [] }],
    ["image differs", c(`sha256:${A}`, "h1"), `sha256:${B}`, "h1", { equal: false, fresh: [`image ${A.slice(0, 12)} instead of ${B.slice(0, 12)}`] }],
    ["no label", c(`sha256:${A}`), `sha256:${A}`, "h1", { equal: false, fresh: ["without label cbase.mounts.v2 or cbase.mounts"] }],
    ["empty label", c(`sha256:${A}`, ""), `sha256:${A}`, "h1", { equal: false, fresh: ["without label cbase.mounts.v2 or cbase.mounts"] }],
    ["mounts differ", c(`sha256:${A}`, "h0"), `sha256:${A}`, "h1", { equal: false, fresh: ["mounts differ (cbase.mounts.v2)"] }],
    ["both", c(`sha256:${B}`, "h0"), `sha256:${A}`, "h1", { equal: false, fresh: [`image ${B.slice(0, 12)} instead of ${A.slice(0, 12)}`, "mounts differ (cbase.mounts.v2)"] }],
    ["container missing", null, `sha256:${A}`, "h1", { equal: false, fresh: ["the project container is missing"] }],
    ["image unknown", c("", "h1"), `sha256:${A}`, "h1", { equal: false, fresh: ["image of the container unknown"] }],
  ];
  for (const [fall, inspect, desiredImageId, desiredMountsHash, expected] of cases) {
    assert.deepEqual(desiredActual({ inspect, desiredImageId, desiredMountsHash }), expected, fall);
  }
  // Empty is not unknown: without a desired value no "equal" and no "fresh".
  for (const desired of [{ desiredImageId: "", desiredMountsHash: "h1" }, { desiredImageId: A, desiredMountsHash: "" }, {}]) {
    assert.throws(() => desiredActual({ inspect: c(A, "h1"), ...desired }), TypeError, JSON.stringify(desired));
  }
});

// ── (1b) The hash transition ────────────────────────────────────────────────────────────────────────────────────────

test("(1b) hash transition: cbase.mounts.v2 first; without it cbase.mounts against the old formula of now (⇒ recognize) or against the recognised value of the row", () => {
  const A = "a1".repeat(32);
  const c = (labels) => ({ Image: `sha256:${A}`, Config: { Labels: labels } });
  const desired = { desiredImageId: A, desiredMountsHash: "v2-now", desiredMountsHashV1: "v1-now" };
  const deviates = (k) => ({ equal: false, fresh: [`mounts differ (${k})`] });
  const cases = [
    ["v2 equal (v1 old)", c({ "cbase.mounts": "v1-old", "cbase.mounts.v2": "v2-now" }), {}, { equal: true, fresh: [] }],
    ["v2 differs, v1 equal", c({ "cbase.mounts": "v1-now", "cbase.mounts.v2": "v2-old" }), {}, deviates("cbase.mounts.v2")],
    ["v2 differs, recognised equal", c({ "cbase.mounts.v2": "v2-old" }), { recognized: "v2-now" }, deviates("cbase.mounts.v2")],
    ["only v1, old formula of now", c({ "cbase.mounts": "v1-now" }), {}, { equal: true, fresh: [], recognize: "v2-now" }],
    ["empty v2 counts as missing", c({ "cbase.mounts": "v1-now", "cbase.mounts.v2": "" }), {}, { equal: true, fresh: [], recognize: "v2-now" }],
    ["only v1, different, recognised equal", c({ "cbase.mounts": "v1-old" }), { recognized: "v2-now" }, { equal: true, fresh: [] }],
    ["only v1, different, recognised different", c({ "cbase.mounts": "v1-old" }), { recognized: "v2-old" }, deviates("cbase.mounts")],
    ["only v1, different, nothing recognised", c({ "cbase.mounts": "v1-old" }), {}, deviates("cbase.mounts")],
    ["none", c({}), { recognized: "v2-now" }, { equal: false, fresh: ["without label cbase.mounts.v2 or cbase.mounts"] }],
    // A container of an intermediate version carried the v2 value in the old label — never rolled out, no special path.
    ["only v1 with the v2 value", c({ "cbase.mounts": "v2-now" }), {}, deviates("cbase.mounts")],
  ];
  for (const [fall, inspect, extra, expected] of cases) assert.deepEqual(desiredActual({ inspect, ...desired, ...extra }), expected, fall);
  // Without the old formula (desiredMountsHashV1 empty) nothing is recognised — empty is not unknown.
  assert.deepEqual(desiredActual({ inspect: c({ "cbase.mounts": "v1-now" }), desiredImageId: A, desiredMountsHash: "v2-now" }), deviates("cbase.mounts"));
});

// ── (2) knob ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) CBASE_RECREATE_CHECK_BACK_MS: default 60 s; a whole number ≥ 100 applies, anything else is the default", () => {
  const saved = process.env.CBASE_RECREATE_CHECK_BACK_MS;
  try {
    assert.equal(CHECK_BACK_MS, 60_000);
    for (const [raw, ms] of [[undefined, 60_000], ["", 60_000], ["100", 100], ["150", 150], ["99", 60_000], ["0", 60_000], ["-5", 60_000], ["1.5", 60_000], ["abc", 60_000]]) {
      if (raw === undefined) delete process.env.CBASE_RECREATE_CHECK_BACK_MS; else process.env.CBASE_RECREATE_CHECK_BACK_MS = raw;
      assert.equal(recreateCheckBackMs(), ms, String(raw));
    }
  } finally {
    if (saved === undefined) delete process.env.CBASE_RECREATE_CHECK_BACK_MS; else process.env.CBASE_RECREATE_CHECK_BACK_MS = saved;
  }
});

// ── Shared parts of the integration (shape of projectbox-restore.test.js — a test file imports no other) ───────────────

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const valueValue = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const volumeMount = (args) => args.filter((a, i) => args[i - 1] === "--mount" && a.startsWith("type=volume"));

// The environment of a test in ops mode: the marks of projectbox-scenario.mjs, the stage cap set high, the root of the network mark
// (for the restart hook without options) and the check-back beat small. `values` wins.
async function inOps(fd, s, fn, values = {}) {
  const desired = { CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: s?.root, CBASE_RECREATE_CHECK_BACK_MS: "100", ...values };
  const saved = Object.fromEntries(Object.keys(desired).map((x) => [x, process.env[x]]));
  try {
    for (const [x, v] of Object.entries(desired)) { if (v === undefined) delete process.env[x]; else process.env[x] = v; }
    return await withOps(fd, async () => {
      try { return await fn(); } finally { await carryOut(fd); }
    }, values);
  } finally {
    for (const [x, v] of Object.entries(saved)) { if (v === undefined) delete process.env[x]; else process.env[x] = v; }
  }
}

// After the body, STILL in ops mode: a procedure that is still alive (a failure in the middle of it, a counter-probe) is carried to its
// end — every gate of the fake docker opens, every stage cap expires through the clock seam. Cleanup only.
async function carryOut(fd) {
  const alive = () => store.projectInstances().some((z) => procedureAlive(z.projectId, z.instance));
  while (alive()) {
    const gates = path.join(fd.dir, "gates");
    for (const f of fs.existsSync(gates) ? fs.readdirSync(gates) : []) {
      if (f.endsWith(".waiting")) fd.openGate(decodeURIComponent(f.slice(0, -".waiting".length)));
    }
    advanceStagesCap();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function cleanUpRows() {
  for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) {
    try { setInstanceState(z.projectId, z.instance, "ready"); } catch (e) { console.warn(`[recreate] cleanup ${z.identifier}: ${e?.message || e}`); }
  }
}

// Without an account (shape of project-lock.test.js): waking checks the limit — without this the server would read the keychain and ask
// the usage endpoint of the REAL account; `npx` as idle.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-recreate-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, NPX_BIN: process.env.NPX_BIN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(shim, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    process.env.NPX_BIN = path.join(shim, "npx");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`Cleanup of ${root}: ${e.code || e.message}`); }
  }
}

// The main agent writes one line per turn to main.jsonl; "{GATE:x}" holds it at gate x (until the test opens it).
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ turn, text }) + "\\n");
  const m = text.match(/\\{GATE:([^}]+)\\}/);
  if (m && !text.includes("<task-notification>")) await gate(m[1]);
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Answer " + turn }] } });
  finished();
  say({ type: "result", result: "Answer " + turn, session_id: "main-session" });`;
const CLAUDE_GATE = fakeClaude({ main: MAIN });
const turns = (root) => readJsonl(path.join(root, "main.jsonl"));

// The environment of the CLI in the project container (shape of projectbox-restore.test.js (11)).
const cliEnvironment = (fd) => ({
  CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
});

// A converted project with a REALLY created project container (createInstance through the fake docker) — recreate learns its creation
// options through the test seam (`options`, per project).
async function created(s, options) {
  options.set(s.projectId, s.opts);
  const row = await createInstance(s.projectId, s.opts);
  assert.equal(row.state, "ready", JSON.stringify(row));
  return store.changeProjectInstance(s.projectId, "main", { convertedAt: Date.now() }).after;
}

// Quiet, and in addition: no earmark and no recreate open any more (an attempt that has not found idle yet waits for the check-back
// beat — the server's quiet does not know the earmark).
async function everythingPasses(ctx, pids) {
  await ctx.waitForQuiet();
  await waitForTruthy(() => pids.every((pid) => !recreateStatus(pid).earmarked && !recreateStatus(pid).active), "recreate done");
  await ctx.waitForQuiet();
}

// Read the stream of a terminal to its end — `event: exit` ends it (shape of project-lock.test.js (9)).
function terminalReader(base, id) {
  let text = "";
  const done = (async () => {
    const res = await fetch(`${base}/api/terminal/${id}/stream`, { headers: { Connection: "close" } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) return;
      text += decoder.decode(value, { stream: true });
    }
  })();
  return { text: () => text, end: done };
}

// ── (3) without the ops mark ────────────────────────────────────────────────────────────────────────────────────────

test("(3) without the ops mark: no earmark, no check, no docker — even with a converted row", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await fakeDocker({ images: IMAGES });
    const prior = process.env.CBASE_DOCKER_BIN;
    try {
      process.env.CBASE_DOCKER_BIN = fd.bin; // the seam points at the fake docker — only the ops mark is missing
      store.createProjectInstance({ projectId: "p-g1", state: "ready", convertedAt: Date.now(), containerId: "cbase-p-p-g1" });
      assert.equal(earmarkRecreate("p-g1", { reason: "Test" }), false);
      assert.equal(recreateRequest({ projectId: "p-g1", reason: "Test" }), false);
      assert.equal(await checkRecreate("p-g1", { cause: "Test" }), null);
      assert.deepEqual(recreateStatus("p-g1"), { earmarked: null, active: false, last: null });
      assert.deepEqual(fd.calls(), [], "no docker without ops mode");
      assert.equal(store.projectInstance("p-g1").state, "ready");
    } finally {
      if (prior === undefined) delete process.env.CBASE_DOCKER_BIN; else process.env.CBASE_DOCKER_BIN = prior;
      store.deleteProjectInstance("p-g1");
      fd.cleanUp();
    }
  });
});

// ── (4) projectError ────────────────────────────────────────────────────────────────────────────────────────────────

test("(4) /api/runs/active: projectError is the NUMBER of converted instances in error — without ids and reasons, not in busy", async () => {
  await withAgentsServer(async (ctx) => {
    const rows = [
      ["p-f-conv-1", "error", true], ["p-f-conv-2", "error", true],
      ["p-f-old", "error", false], ["p-f-ready", "ready", true],
    ];
    try {
      const empty = await json(`${ctx.base}/api/runs/active`);
      assert.equal(empty.projectError, 0);
      for (const [pid, state, converted] of rows) {
        store.createProjectInstance({ projectId: pid, state, ...(converted ? { convertedAt: Date.now() } : {}) });
        if (state === "error") store.changeProjectInstance(pid, "main", { error: `SECRET-REASON-${pid}` });
      }
      const r = await json(`${ctx.base}/api/runs/active`);
      assert.equal(r.projectError, 2, JSON.stringify(r));
      assert.equal(typeof r.projectError, "number");
      assert.equal(r.busy, false, "error is no work");
      assert.deepEqual(r.projectWork, []);
      const text = JSON.stringify(r);
      assert.ok(!/p-f-|SECRET-REASON/.test(text), `ids or reasons in /api/runs/active: ${text}`);
    } finally {
      for (const [pid] of rows) store.deleteProjectInstance(pid);
    }
  });
});

test("(4b) /api/runs/active: converted is the NUMBER of converted projects — once per project, without ids, not in busy, also 0", async () => {
  await withAgentsServer(async (ctx) => {
    const rows = [
      ["p-u-1", "main", "ready", true], ["p-u-1", "copy-a", "ready", true], ["p-u-2", "main", "error", true],
      ["p-u-old", "main", "ready", false],
    ];
    try {
      const empty = await json(`${ctx.base}/api/runs/active`);
      assert.equal(empty.converted, 0, "0 must be there — a missing field means \"unknown\" to the deploy");
      for (const [pid, instance, state, converted] of rows) store.createProjectInstance({ projectId: pid, instance, state, ...(converted ? { convertedAt: Date.now() } : {}) });
      const r = await json(`${ctx.base}/api/runs/active`);
      assert.equal(r.converted, 2, JSON.stringify(r));
      assert.equal(r.busy, false, "converted is no work");
      assert.ok(!/p-u-/.test(JSON.stringify(r)), `ids in /api/runs/active: ${JSON.stringify(r)}`);
    } finally {
      for (const pid of new Set(rows.map((z) => z[0]))) store.deleteProjectInstance(pid);
    }
  });
});

// ── (5) The core: deviation, running turn, recreate at idle ──────────────────────────────────────────────────────────

test("(5) deviation in the middle of a turn: earmarked, NO stop until the turn ends; then stop -t 30 <id> → rm <id> → run with the same --ip/hostname/volume → desired containers start; a turn during the recreate waits and runs afterwards; the check at turn start keeps the chat in running; the project's shells end", async () => {
  let fd = null;
  const terminals = [];
  const options = new Map();
  setCreationOptions((pid) => options.get(pid) || {});
  try {
    await withoutAccount(() => withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      fd = await fakeDocker({ images: IMAGES, programs: s.programs, stopsInside: true });
      const chatId = ctx.chat.id;
      const pid = s.projectId;
      try {
        await json(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
        await inOps(fd, s, async () => {
          const row = await created(s, options);
          const name = `cbase-p-${pid}`;
          const oldId = dx(fd, "inspect", "--format", "{{.Id}}", name);
          const firstCreation = fd.calls({ daemon: "host" }).find((a) => a.args[0] === "run").args;
          assert.equal(row.mountsHash, desiredMounts(pid, s.opts).hash, "the test seam computes the same desired value as the creation");
          // The inner stack: db (healthy only at the gate) and app (depends on db).
          for (const [n, service, extra] of [["n-db-1", "db", ["--health-cmd", "true"]], ["n-app-1", "app", ["--label", "com.docker.compose.depends_on=db:service_healthy:false"]]]) {
            dx(fd, "exec", name, "docker", "run", "-d", "--name", n, "--label", "com.docker.compose.project=p", "--label", `com.docker.compose.service=${service}`, ...extra, "img");
          }

          // Without deviation: the turn checks at its start (image inspect) and earmarks nothing. Counted from here — the creation also
          // reads the desired image.
          const beforeWithout = fd.calls().length;
          const r0 = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "WITHOUT {GATE:o}" });
          assert.equal(r0.queued, false, JSON.stringify(r0));
          await ctx.gate.reached("o");
          // The check at turn start belongs to the turn (runs/instance.js turnCheckOpen): if it is still running, wait for it here;
          // if it is done, its read of the desired image is in the log.
          const p0 = turnCheckOpen(chatId);
          if (p0) await p0;
          assert.ok(fd.calls().slice(beforeWithout).some((a) => a.daemon === "host" && a.args.join(" ") === "image inspect --format {{.Id}} cbase-projectbox:latest"), "no check at turn start (setTurnObserver not wired?)");
          assert.deepEqual(recreateStatus(pid), { earmarked: null, active: false, last: null });
          ctx.gate.open("o");
          await ctx.waitForQuiet();

          // The check at turn start BELONGS to the turn — runs/do-run.js waits for it in finally before the chat leaves `running`. A
          // gate BEFORE the real check (the observer, rewired from here; the wiring in server.js is checked by the section above)
          // keeps it open: after `run_done` the chat is still running and a second message queues up; only the gate frees it.
          let checkGateOn = () => {};
          const checkGate = new Promise((r) => { checkGateOn = r; });
          setTurnObserver({ beginning: (a) => checkGate.then(() => recreateTurnObserver.beginning(a)), end: (a) => recreateTurnObserver.end(a) });
          const metas = () => store.listMessages(chatId).filter((m) => m.role === "meta").length;
          try {
            const metaPrior = metas();
            const rt = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "CHECK {GATE:p}" });
            assert.equal(rt.queued, false, JSON.stringify(rt));
            await ctx.gate.reached("p");
            ctx.gate.open("p");
            // `meta` stands in the same synchronous step as `run_done` — without waiting for the check the chat would be free afterwards.
            await waitForTruthy(() => metas() > metaPrior, "run_done of the turn");
            const activeNow = await json(`${ctx.base}/api/runs/active`);
            assert.equal(activeNow.runs, 1, `the chat left running before its check ended: ${JSON.stringify(activeNow)}`);
            const rz = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "AFTER-THE-CHECK" });
            assert.equal(rz.queued, true, `the second message did not wait for the check: ${JSON.stringify(rz)}`);
          } finally {
            checkGateOn();
          }
          await waitForTruthy(() => turns(ctx.root).some((t) => String(t.text).includes("AFTER-THE-CHECK")), "the queued turn after the check");
          await ctx.waitForQuiet();
          setTurnObserver(recreateTurnObserver);
          assert.deepEqual(recreateStatus(pid), { earmarked: null, active: false, last: null });

          // The new image (like a deploy with a distributed project box): :latest points elsewhere.
          dx(fd, "tag", "cbase-projectbox:new", "cbase-projectbox:latest");
          const marker = fd.calls().length;
          const r1 = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "MIDDLE {GATE:m}" });
          assert.equal(r1.queued, false, JSON.stringify(r1));
          await ctx.gate.reached("m");
          const p1 = turnCheckOpen(chatId);
          if (p1) await p1;
          const status = recreateStatus(pid);
          // The promise first: in the middle of a turn no recreate begins (no state, no procedure, no stop/rm/run).
          assert.equal(store.projectInstance(pid).state, "ready", "in another state in the middle of the turn");
          assert.equal(status.active, false, `a recreate began in the middle of the turn: ${JSON.stringify(status)}`);
          assert.deepEqual(fd.calls().slice(marker).filter((a) => a.daemon === "host" && ["stop", "rm", "run"].includes(a.args[0])), [], "touched in the middle of the turn");
          assert.ok(status.earmarked, `not earmarked: ${JSON.stringify(status)}`);
          assert.match(status.earmarked.reason, new RegExp(`^turn start: image ${ID.slice(0, 12)} instead of ${ID_NEW.slice(0, 12)}$`));
          assert.equal(status.last?.ok, false, `the attempt did not find the turn open: ${JSON.stringify(status)}`);
          assert.ok((status.last.open || []).some((o) => o.chatId === chatId), JSON.stringify(status.last));

          // One shell each of the project and of the chat (and a foreign one) — the recreate ends the two with its notice (idle.js
          // projectLocks without `terminalsLater`); the attempt in the middle of the turn, which did not find idle, left them standing.
          const shell = async (tag) => {
            const r = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/terminal`, { cols: 80, rows: 24, tag });
            assert.equal(r.available, true, `node-pty missing: ${JSON.stringify(r)}`);
            terminals.push(r.id);
            return r.id;
          };
          const tProj = await shell(`proj:${pid}`);
          const tChat = await shell(`chat:${chatId}`);
          const tForeign = await shell("ws:foreign");
          const reader = terminalReader(ctx.base, tProj);
          await post(`${ctx.base}/api/terminal/${tProj}/input`, { data: "echo READY\r" });
          await waitForTruthy(() => reader.text().includes("READY"), "terminal connected");
          const alive = async (tid) => (await json(`${ctx.base}/api/terminal/${tid}/exists`)).exists;
          assert.equal(await alive(tProj), true, "the attempt in the middle of the turn ended the shell");

          // The turn end frees idle: the recreate begins. It holds in stage 1 (db becomes healthy only at the gate) — a second turn
          // arrives there and waits.
          ctx.gate.open("m");
          await waitForTruthy(() => { const z = store.projectInstance(pid); return z.state === "recreate" && /^stage 1\//.test(z.phase) ? z : null; }, "recreate in stage 1"); // the phase marker "stufe n/m" stays German
          const turnsPrior = turns(ctx.root).length;
          const r2 = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "DURING" });
          assert.equal(r2.queued, true, `the turn did not wait: ${JSON.stringify(r2)}`);
          assert.equal(r2.locked, true, JSON.stringify(r2));
          assert.equal(turns(ctx.root).length, turnsPrior);
          fd.openGate("healthy-n-db-1");
          await waitForTruthy(() => turns(ctx.root).slice(turnsPrior).some((t) => String(t.text).includes("DURING")), "turn after the recreate");
          await everythingPasses(ctx, [pid]);

          // The log from the marker (host): exactly one stop and one rm, both by the OLD id, rm without -f; one run with the same IP,
          // hostname and volume as the first creation.
          const host = fd.calls().map((a, i) => ({ ...a, i })).filter((a) => a.i >= marker && a.daemon === "host");
          const stops = host.filter((a) => a.args[0] === "stop");
          const rms = host.filter((a) => a.args[0] === "rm");
          const runs = host.filter((a) => a.args[0] === "run");
          assert.deepEqual(stops.map((a) => a.args), [["stop", "-t", "30", oldId]]);
          assert.deepEqual(rms.map((a) => a.args), [["rm", oldId]], "rm by id, without -f");
          assert.equal(runs.length, 1, JSON.stringify(runs.map((a) => a.args)));
          const run = runs[0].args;
          assert.ok(stops[0].i < rms[0].i && rms[0].i < runs[0].i, "stop → rm → run");
          for (const f of ["--ip", "--hostname", "--name", "--network"]) assert.equal(valueValue(run, f), valueValue(firstCreation, f), f);
          assert.deepEqual(volumeMount(run), volumeMount(firstCreation), "the same volume");
          // The image by id (the creation pins the checked desired image): the new one; the first creation ran with the old one.
          assert.equal(run.at(-1), `sha256:${ID_NEW}`);
          assert.equal(firstCreation.at(-1), `sha256:${ID}`);
          // Inside: the desired containers start after the run, db before app.
          const inside = fd.calls().map((a, i) => ({ ...a, i })).filter((a) => a.i > runs[0].i && a.daemon === name && a.args[0] === "start");
          const idOf = Object.fromEntries(JSON.parse(dx(fd, "exec", name, "docker", "inspect", "n-db-1", "n-app-1")).map((c) => [c.Id, c.Name.replace(/^\//, "")]));
          assert.deepEqual(inside.flatMap((a) => a.args.slice(1)).map((x) => idOf[x] || x), ["n-db-1", "n-app-1"]);
          // The waiting turn ran IN THE NEW container and only after the stack started.
          const cli = fd.calls().map((a, i) => ({ ...a, i })).filter((a) => a.daemon === "host" && a.args[0] === "exec" && a.args.includes(process.env.CLAUDE_BIN));
          assert.ok(cli.at(-1).i > Math.max(...inside.map((a) => a.i)), `the turn ran before the stack (CLI ${cli.at(-1).i}, inside ${inside.map((a) => a.i)})`);
          const fresh = store.projectInstance(pid);
          assert.equal(fresh.state, "ready", JSON.stringify(fresh));
          assert.equal(fresh.ip, row.ip);
          assert.equal(fresh.hostname, row.hostname);
          assert.notEqual(fresh.containerId, oldId);
          assert.equal(dx(fd, "inspect", "--format", "{{.Image}}", name), `sha256:${ID_NEW}`);
          // No loop: the turn afterwards checked against the new container and earmarked nothing.
          assert.deepEqual(recreateStatus(pid).earmarked, null);
          assert.equal(fd.calls().filter((a) => a.daemon === "host" && a.args[0] === "rm").length, 1);
          // The shells of the project and of the chat ended with the notice of the recreate, the foreign one lives.
          assert.equal(await alive(tProj), false, "the project's shell still hangs on a removed container");
          assert.equal(await alive(tChat), false, "the chat's shell still hangs on a removed container");
          assert.equal(await alive(tForeign), true, "a foreign shell stays");
          await reader.end;
          assert.match(reader.text(), /Der Projekt-Container wird neu angelegt — dieses Terminal wurde beendet\./);
        }, cliEnvironment(fd));
      } finally {
        fd.openGate("healthy-n-db-1");
        cleanUpRows();
      }
    }, { claude: CLAUDE_GATE }));
  } finally {
    // Directly on the module (the server is already closed here): a living login shell would hold the event loop open.
    for (const id of terminals) killTerminal(id);
    setTurnObserver(recreateTurnObserver);
    setCreationOptions(null);
    fd?.cleanUp();
  }
});

// ── (6) The missing container ───────────────────────────────────────────────────────────────────────────────────────

test("(6) container missing at the restart grace: restore error ⇒ request (server.js) ⇒ recreate at idle ⇒ ready at the same IP, without stop and rm", async () => {
  const options = new Map();
  setCreationOptions((pid) => options.get(pid) || {});
  let fd = null;
  try {
    await withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      fd = await fakeDocker({ images: IMAGES, programs: s.programs });
      const pid = s.projectId;
      try {
        await inOps(fd, s, async () => {
          const row = await created(s, options);
          const name = `cbase-p-${pid}`;
          const firstCreation = fd.calls({ daemon: "host" }).find((a) => a.args[0] === "run").args;
          dx(fd, "stop", name);
          dx(fd, "rm", name); // gone — removed by hand, say, or a docker that lost it
          await ctx.restart();
          assert.equal(store.projectInstance(pid).state, "start", "not earmarked");
          const marker = fd.calls().length;
          await fireHooks("restartGrace", {});
          await everythingPasses(ctx, [pid]);
          const fresh = store.projectInstance(pid);
          assert.equal(fresh.state, "ready", `no recreate after the missing container: ${JSON.stringify(fresh)}`);
          assert.equal(fresh.ip, row.ip);
          const status = recreateStatus(pid);
          assert.equal(status.last?.ok, true, JSON.stringify(status));
          assert.match(status.last.reason, /the project container cbase-p-\S+ is missing/);
          const host = fd.calls().slice(marker).filter((a) => a.daemon === "host");
          assert.deepEqual(host.filter((a) => ["stop", "rm"].includes(a.args[0])), [], "nothing to stop, nothing to remove");
          const runs = host.filter((a) => a.args[0] === "run");
          assert.equal(runs.length, 1);
          for (const f of ["--ip", "--hostname", "--name"]) assert.equal(valueValue(runs[0].args, f), valueValue(firstCreation, f), f);
          assert.deepEqual(volumeMount(runs[0].args), volumeMount(firstCreation));
        });
      } finally {
        cleanUpRows();
      }
    });
  } finally {
    setCreationOptions(null);
    fd?.cleanUp();
  }
});

// ── (7) Restart: check and resume ───────────────────────────────────────────────────────────────────────────────────

test("(7) restart grace: ready with an old image ⇒ restore, then recreate; orphaned recreate ⇒ resumed (without container: creation; equal: restore only); none lands on error", async () => {
  const options = new Map();
  setCreationOptions((pid) => options.get(pid) || {});
  let fd = null;
  try {
    await withAgentsServer(async (ctx) => {
      const sc = scenario(ctx); // ready, old image
      const sa = scenario(ctx); // recreate, container gone
      const sb = scenario(ctx); // recreate, container already new
      fd = await fakeDocker({ images: IMAGES, programs: sc.programs });
      const name = (s) => `cbase-p-${s.projectId}`;
      try {
        await inOps(fd, sc, async () => {
          await created(sc, options);
          await created(sa, options);
          dx(fd, "tag", "cbase-projectbox:new", "cbase-projectbox:latest");
          await created(sb, options);
          const idC = dx(fd, "inspect", "--format", "{{.Id}}", name(sc));
          const idB = dx(fd, "inspect", "--format", "{{.Id}}", name(sb));
          for (const s of [sc, sa, sb]) dx(fd, "stop", name(s));
          dx(fd, "rm", name(sa));
          setInstanceState(sa.projectId, "main", "recreate", { phase: "creation" });
          setInstanceState(sb.projectId, "main", "recreate", { phase: "creation" });
          // Two rows in `recreate` are work (`busy`) — the restart waits only for the end of the turns (there are none).
          await ctx.restart({ withBackground: true });
          assert.deepEqual([sc, sa, sb].map((s) => store.projectInstance(s.projectId).state), ["start", "recreate", "recreate"]);
          const marker = fd.calls().length;
          await fireHooks("restartGrace", {});
          // Right after the chain: every row has a living procedure, none stands on error.
          for (const s of [sc, sa, sb]) {
            const z = store.projectInstance(s.projectId);
            assert.notEqual(z.state, "error", `${s.projectId}: ${JSON.stringify(z)}`);
            assert.ok(procedureAlive(s.projectId, "main"), `${s.projectId}: no procedure after the chain (${z.state})`);
          }
          await everythingPasses(ctx, [sc, sa, sb].map((s) => s.projectId));
          for (const s of [sc, sa, sb]) {
            const z = store.projectInstance(s.projectId);
            assert.equal(z.state, "ready", `${s.projectId}: ${JSON.stringify(z)}`);
            assert.equal(dx(fd, "inspect", "--format", "{{.Image}}", name(s)), `sha256:${ID_NEW}`, s.projectId);
          }
          const host = fd.calls().slice(marker).filter((a) => a.daemon === "host");
          // C: started first (restore), then stop/rm by the old id, then run.
          assert.deepEqual(host.filter((a) => a.args[0] === "stop").map((a) => a.args), [["stop", "-t", "30", idC]]);
          assert.deepEqual(host.filter((a) => a.args[0] === "rm").map((a) => a.args), [["rm", idC]]);
          assert.equal(host.filter((a) => a.args[0] === "run" && valueValue(a.args, "--name") === name(sc)).length, 1);
          assert.match(recreateStatus(sc.projectId).last?.reason || "", /^restart grace: image /);
          // A: creation only (no container to stop).
          assert.equal(host.filter((a) => a.args[0] === "run" && valueValue(a.args, "--name") === name(sa)).length, 1);
          // B: no run, no rm — only the start of the existing container.
          assert.equal(host.filter((a) => a.args[0] === "run" && valueValue(a.args, "--name") === name(sb)).length, 0);
          assert.ok(host.some((a) => a.args[0] === "start" && a.args.includes(idB)), "B was not started");
        });
      } finally {
        cleanUpRows();
      }
    });
  } finally {
    setCreationOptions(null);
    fd?.cleanUp();
  }
});

// ── (8) Failure without a loop ──────────────────────────────────────────────────────────────────────────────────────

// A `cat` of the project container that COUNTS reads of the entrypoint's status file: the third read reports phase=error, every other
// one the file from `inside`. It is read exactly once per creation and per restore (waitForInside returns at the first finished phase):
// 1 = the first creation, 2 = the creation in the recreate, 3 = the restore afterwards. From the fourth on `ready` again — a loop (the
// counter-probe) ends so in a second pass instead of a hang.
function countingCat(s, at = 3) {
  const file = path.join(s.inside, "..", "counting-cat");
  const counter = path.join(s.inside, "..", "status-readings");
  fs.writeFileSync(file, [
    "#!/bin/sh",
    `if [ "$1" = "/run/cbase-projectbox.status" ]; then`,
    `  n=$(/bin/cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'`,
    `  if [ "$n" = ${at} ]; then printf 'phase=error\\nnotice=cgroup: EBUSY\\n'; exit 0; fi`,
    "fi",
    `exec /bin/cat '${s.inside}'"$1"`,
    "",
  ].join("\n"));
  fs.chmodSync(file, 0o755);
  return { cat: file, readings: () => Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").trim() : 0) };
}

test("(8) if the restore fails AFTER the recreate (phase=error): error with reason, exactly one stop/rm/run — the request from this pass does not earmark again (no loop)", async () => {
  const options = new Map();
  setCreationOptions((pid) => options.get(pid) || {});
  let fd = null;
  try {
    await withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      const zc = countingCat(s);
      fd = await fakeDocker({ images: IMAGES, programs: { ...s.programs, cat: zc.cat } });
      const pid = s.projectId;
      try {
        await inOps(fd, s, async () => {
          await created(s, options);
          assert.equal(zc.readings(), 1);
          const oldId = dx(fd, "inspect", "--format", "{{.Id}}", `cbase-p-${pid}`);
          const marker = fd.calls().length;
          assert.equal(earmarkRecreate(pid, { reason: "Test" }), true);
          await everythingPasses(ctx, [pid]);
          const host = fd.calls().slice(marker).filter((a) => a.daemon === "host");
          assert.deepEqual(host.filter((a) => a.args[0] === "stop").map((a) => a.args), [["stop", "-t", "30", oldId]], "a second pass — the loop");
          assert.deepEqual(host.filter((a) => a.args[0] === "rm").map((a) => a.args), [["rm", oldId]]);
          assert.equal(host.filter((a) => a.args[0] === "run").length, 1);
          assert.equal(zc.readings(), 3, "creation and restore did not read the status file once each");
          const z = store.projectInstance(pid);
          assert.equal(z.state, "error", JSON.stringify(z));
          assert.match(z.error, /the entrypoint reports phase=error: cgroup: EBUSY/);
          assert.deepEqual(recreateStatus(pid).earmarked, null, "earmarked again — the loop");
          const r = await json(`${ctx.base}/api/runs/active`);
          assert.equal(r.projectError, 1);
        });
      } finally {
        cleanUpRows();
      }
    });
  } finally {
    setCreationOptions(null);
    fd?.cleanUp();
  }
});

// ── (9) The resume at the old, broken container ────────────────────────────────────────────────────────────────────

test("(9) if B crashed after the stop and before the rm, the resume finds the OLD (broken) container — if its restore fails (phase=error), there is ONE pass: stop/rm by id, run, ready", async () => {
  const options = new Map();
  setCreationOptions((pid) => options.get(pid) || {});
  let fd = null;
  try {
    await withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      // 1 = the creation, 2 = the restore of the resume (phase=error), 3 = the creation in the recreate, 4 = the restore afterwards.
      const zc = countingCat(s, 2);
      fd = await fakeDocker({ images: IMAGES, programs: { ...s.programs, cat: zc.cat } });
      const pid = s.projectId;
      const name = `cbase-p-${pid}`;
      try {
        await inOps(fd, s, async () => {
          await created(s, options);
          const oldId = dx(fd, "inspect", "--format", "{{.Id}}", name);
          // The state after the crash: a recreate stood in "stop"; the old container is stopped, not removed, and matches the desired
          // image and mounts — the resume takes it for the new one.
          dx(fd, "stop", name);
          setInstanceState(pid, "main", "recreate", { phase: "stop" });
          await ctx.restart({ withBackground: true });
          const marker = fd.calls().length;
          await fireHooks("restartGrace", {});
          await everythingPasses(ctx, [pid]);
          const z = store.projectInstance(pid);
          assert.equal(z.state, "ready", `the resume stopped at the broken container: ${JSON.stringify(z)}`);
          assert.equal(zc.readings(), 4, "creation, resume, creation in the recreate, restore");
          const host = fd.calls().slice(marker).filter((a) => a.daemon === "host");
          assert.deepEqual(host.filter((a) => a.args[0] === "stop").map((a) => a.args), [["stop", "-t", "30", oldId]]);
          assert.deepEqual(host.filter((a) => a.args[0] === "rm").map((a) => a.args), [["rm", oldId]], "rm by id, without -f");
          assert.equal(host.filter((a) => a.args[0] === "run").length, 1, "exactly ONE pass");
          assert.notEqual(z.containerId, oldId);
          assert.deepEqual(recreateStatus(pid).earmarked, null, "earmarked again — the loop");
        });
      } finally {
        cleanUpRows();
      }
    });
  } finally {
    setCreationOptions(null);
    fd?.cleanUp();
  }
});

// ── (10) Inode instead of content, and the transition of the old labels ────────────────────────────────────────────────

// Compared is the new label; the old one carries the formula of the release before.
const labelMounts = (fd, name) => JSON.parse(dx(fd, "inspect", name))[0]?.Config?.Labels?.["cbase.mounts.v2"];
const labelMountsV1 = (fd, name) => JSON.parse(dx(fd, "inspect", name))[0]?.Config?.Labels?.["cbase.mounts"];

test("(10) a new content IN PLACE of a read-only file does not recreate, a replace by rename does; a container with the label of the OLD formula (state unchanged) does not recreate", async () => {
  const options = new Map();
  setCreationOptions((pid) => options.get(pid) || {});
  let fd = null;
  try {
    await withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      fd = await fakeDocker({ images: IMAGES, programs: s.programs });
      const pid = s.projectId;
      const name = `cbase-p-${pid}`;
      const settings = path.join(s.home, ".claude", "settings.json");
      try {
        await inOps(fd, s, async () => {
          await created(s, options);
          assert.ok(desiredMounts(pid, s.opts).mounts.some((m) => m.source === settings && m.kind === "file" && !m.rw),
            "settings.json is no read-only file mount — the guard checked nothing");
          const equal = async (fall) => {
            const r = await checkRecreate(pid, { cause: fall });
            assert.deepEqual([r.checked, r.equal, recreateStatus(pid).earmarked], [true, true, null], `${fall}: ${JSON.stringify(r)}`);
          };
          await equal("freshly created");
          const initialLabel = labelMounts(fd, name);
          assert.equal(initialLabel, desiredMounts(pid, s.opts).hash, "a new creation writes the hash of the NEW formula");
          // and the old one in `cbase.mounts` — the release before reads that (a rollback recreates nothing).
          assert.equal(labelMountsV1(fd, name), desiredMounts(pid, s.opts).hashV1, "cbase.mounts does not carry the OLD formula");

          // In place (same inode): the file bind shows the new content — no recreate.
          fs.writeFileSync(settings, "{\"a\":2}\n");
          await equal("new content in place");

          // The transition: a container of an older version carries ONLY `cbase.mounts` with the OLD formula (computed here on the
          // state of now), and its row the old value (as the creation wrote it before).
          const old = desiredMounts(pid, s.opts).hashV1;
          assert.notEqual(old, initialLabel, "old and new formula equal — the transition checked nothing");
          fd.setLabel(name, "cbase.mounts.v2", null);
          fd.setLabel(name, "cbase.mounts", old);
          store.changeProjectInstance(pid, "main", { mountsHash: old });
          await equal("label of the old formula");
          assert.equal(store.projectInstance(pid).mountsHash, desiredMounts(pid, s.opts).hash, "the new hash of now is not recognised");

          // The incident path: THEN a write in place (appendFileSync, as the codex trust entry does; same inode) — the old formula
          // follows the content and would differ; the recognised new hash does not.
          const inode = fs.statSync(settings).ino;
          fs.appendFileSync(settings, "\n");
          assert.equal(fs.statSync(settings).ino, inode, "appendFileSync changed the inode — the guard checked something else");
          assert.notEqual(desiredMounts(pid, s.opts).hashV1, old, "the old formula does not follow the content — the guard checked nothing");
          await equal("appendFileSync in place");
          await equal("appendFileSync in place, second check");

          // Replace by rename (new inode): the bind would hold the old file — recreate.
          const prior = dx(fd, "inspect", "--format", "{{.Id}}", name);
          fs.writeFileSync(`${settings}.new`, "{\"a\":3}\n");
          fs.renameSync(`${settings}.new`, settings);
          const marker = fd.calls().length;
          const r = await checkRecreate(pid, { cause: "rename" });
          assert.deepEqual([r.checked, r.equal, r.fresh], [true, false, ["mounts differ (cbase.mounts)"]], JSON.stringify(r));
          await everythingPasses(ctx, [pid]);
          const host = fd.calls().slice(marker).filter((a) => a.daemon === "host");
          assert.deepEqual(host.filter((a) => a.args[0] === "rm").map((a) => a.args), [["rm", prior]]);
          assert.equal(host.filter((a) => a.args[0] === "run").length, 1);
          assert.equal(store.projectInstance(pid).state, "ready");
          assert.equal(labelMounts(fd, name), desiredMounts(pid, s.opts).hash, "the new container does not carry the hash of the new formula");
          assert.equal(labelMountsV1(fd, name), desiredMounts(pid, s.opts).hashV1, "the new container does not carry the old formula in cbase.mounts");
          assert.equal(store.projectInstance(pid).mountsHash, desiredMounts(pid, s.opts).hash);
        });
      } finally {
        cleanUpRows();
      }
    });
  } finally {
    setCreationOptions(null);
    fd?.cleanUp();
  }
});

// ── (11) Recreate per instance ──────────────────────────────────────────────────────────────────────────────────────

const recreateThrough = (pid, instance) => waitForTruthy(() => !recreateStatus(pid, instance).earmarked && !recreateStatus(pid, instance).active, `recreate ${pid}/${instance} done`);

test("(11) a copy is recreated per instance — if its container is missing, the recreate creates IT (copy root instead of project folder), the check afterwards is equal (its desired value, not the main's), a second recreate keeps IP, hostname and volume; the main stays untouched", async () => {
  const options = new Map();
  setCreationOptions((pid) => options.get(pid) || {});
  let fd = null;
  try {
    await withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      fd = await fakeDocker({ images: IMAGES, programs: s.programs });
      const pid = s.projectId;
      const inst = "copy-k1";
      const kname = `cbase-k-${pid}-k1`;
      const copyData = path.join(DIRS.data, "copies", pid, "k1");
      try {
        await inOps(fd, s, async () => {
          await created(s, options);
          const mainId = dx(fd, "inspect", "--format", "{{.Id}}", `cbase-p-${pid}`);
          fs.mkdirSync(copyData, { recursive: true });
          store.createProjectInstance({ projectId: pid, instance: inst, state: "ready", convertedAt: Date.now(), chatId: "c1", copyName: "k1" });

          // The copy's container is missing: the check earmarks the COPY, not the main.
          const marker = fd.calls().length;
          const r0 = await checkRecreate(pid, { cause: "Test", instance: inst });
          assert.deepEqual([r0.checked, r0.equal, r0.fresh], [true, false, [`the project container ${kname} is missing`]], JSON.stringify(r0));
          await recreateThrough(pid, inst);
          await ctx.waitForQuiet();
          const copy = store.projectInstance(pid, inst);
          assert.equal(copy.state, "ready", JSON.stringify(copy));
          const host = fd.calls().slice(marker).filter((a) => a.daemon === "host");
          const runs = host.filter((a) => a.args[0] === "run");
          assert.equal(runs.length, 1);
          const run = runs[0].args;
          const all = (flag) => run.flatMap((a, i) => (run[i - 1] === flag ? [a] : []));
          assert.equal(valueValue(run, "--name"), kname);
          assert.deepEqual(all("--label").slice(0, 3), [`cbase.project=${pid}`, `cbase.instance=${inst}`, "cbase.chat=c1"]);
          assert.ok(all("--mount").includes(`type=bind,src=${copyData},dst=/cbase-copy`), "without the copy root (mountRulesCopy)");
          assert.ok(!all("--mount").some((m) => m.includes(`dst=${s.path},`) || m.endsWith(`dst=${s.path}`)), "the project folder at the original path");
          assert.deepEqual(host.filter((a) => ["stop", "rm"].includes(a.args[0])), [], "nothing to stop — and certainly not the main");
          assert.equal(dx(fd, "inspect", "--format", "{{.Id}}", `cbase-p-${pid}`), mainId, "the main was touched");
          assert.deepEqual(recreateStatus(pid), { earmarked: null, active: false, last: null }, "the main was earmarked");

          // The check afterwards measures the copy against ITS desired value — equal.
          const r1 = await checkRecreate(pid, { cause: "Test", instance: inst });
          assert.deepEqual([r1.checked, r1.equal], [true, true], `the freshly created copy differs from its desired value: ${JSON.stringify(r1)}`);

          // A second recreate: stop/rm by the copy's id, run with the same IP, hostname, volume.
          const kid = dx(fd, "inspect", "--format", "{{.Id}}", kname);
          const marker2 = fd.calls().length;
          assert.equal(earmarkRecreate(pid, { instance: inst, reason: "Test" }), true);
          await recreateThrough(pid, inst);
          await ctx.waitForQuiet();
          const host2 = fd.calls().slice(marker2).filter((a) => a.daemon === "host");
          assert.deepEqual(host2.filter((a) => a.args[0] === "rm").map((a) => a.args), [["rm", kid]]);
          const run2 = host2.filter((a) => a.args[0] === "run").map((a) => a.args);
          assert.equal(run2.length, 1);
          for (const f of ["--ip", "--hostname", "--name"]) assert.equal(valueValue(run2[0], f), valueValue(run, f), f);
          assert.deepEqual(volumeMount(run2[0]), volumeMount(run));
          assert.equal(store.projectInstance(pid, inst).state, "ready");
          assert.equal(dx(fd, "inspect", "--format", "{{.Id}}", `cbase-p-${pid}`), mainId, "the main was touched");

          // The restart-grace seam checks per instance (not always the main — a deviating copy went unnoticed).
          fd.setLabel(kname, "cbase.mounts.v2", "stale");
          const r3 = await recreateRestartGraceSeam.check({ projectId: pid, instance: inst });
          assert.deepEqual([r3?.checked, r3?.equal], [true, false], `the restart grace did not check the copy: ${JSON.stringify(r3)}`);
          await recreateThrough(pid, inst);
          await ctx.waitForQuiet();
          assert.equal(labelMounts(fd, kname), desiredMounts(pid, { ...s.opts, instance: inst }).hash, "the copy does not carry its desired value after the recreate");
          assert.equal(store.projectInstance(pid, inst).state, "ready");
          assert.equal(dx(fd, "inspect", "--format", "{{.Id}}", `cbase-p-${pid}`), mainId, "the main was touched");
          assert.deepEqual(recreateStatus(pid), { earmarked: null, active: false, last: null }, "the main was earmarked");
        });
      } finally {
        cleanUpRows();
        fs.rmSync(path.join(DIRS.data, "copies"), { recursive: true, force: true });
      }
    });
  } finally {
    setCreationOptions(null);
    fd?.cleanUp();
  }
});
