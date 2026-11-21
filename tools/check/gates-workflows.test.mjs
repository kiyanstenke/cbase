// The deploy does not wait for dynamic workflows but shows them.
//
// Two promises of the deploy tool:
//  - the oneshot detection (in the container) lets an agent process of a dynamic workflow through and keeps holding for a
//    subagent process (lib/processes.mjs; the marker stands in the command line);
//  - gate (server) and status show an information row "Dynamische Workflows" with count, name and state, over ALL user
//    containers, and a backend that stays silent is "unknown", never "none".
// That the REAL command lines of the agent starts carry the marker (or not) is held by server/backend/test/active-runs.test.js
// with the agent harness: there the argv of a workflow agent and a subagent are held against this module.
//
// COUNTER-TEST (shown red): replace WORKFLOW_AGENT_RE in lib/processes.mjs with /$^/ (every `claude … stream-json` holds) =>
// "oneshot detection" red: the gate waits for the workflow agent.
//
// A start in the project container stands in the user container as a wrapper line (`docker exec … cbase-wrapper … -- claude …`)
// and, when B sees the project container's processes, next to it as an inner line: ONE process, not two; the values behind
// `-e X=`/`env.X=` never go into the log (mask, at the detail line of gates.mjs). COUNTER-TESTS (shown red): lib/processes.mjs
// from 7fcf1ff => "wrapper line" red (2 instead of 1); in gates.mjs `mask(l)` back to `l` => "masking … detail line" red.
// Split: this file holds what only needs lib/processes.mjs and the connectors; everything that reads lib/gates.mjs (the rows, the gate,
// the fake container) stands in the maintainer's private suite. Shared command lines: lib/gates-workflows-fixture.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import { ONESHOT_RE, wrappersInner, isWorkflowAgent, mask, partsProcesses, isProviderRow, providerRows } from "./lib/processes.mjs";
import { PROCESS_LIST, PROJ, SCRATCH, claudeSub, claudeWf, codexSub, codexWf, claudeWfBox, claudeSubBox, wrapper, psRow, REAL, LIST } from "./lib/gates-workflows-fixture.mjs";

test("oneshot detection: a workflow agent does not hold the gate, a subagent does; local ({cmd}) and in the container (pgrep rows)", () => {
  for (const c of [claudeSub, claudeWf, codexSub, codexWf]) assert.ok(ONESHOT_RE.test(c), `a provider process: ${c}`);
  // Local: descendants of the app as {pid, cmd}.
  const local = [{ pid: 11, cmd: claudeSub }, { pid: 12, cmd: claudeWf }, { pid: 13, cmd: codexSub }, { pid: 14, cmd: codexWf }];
  const l = partsProcesses(local);
  assert.deepEqual(l.holds.map((p) => p.pid), [11, 13], "subagents hold the gate");
  assert.deepEqual(l.workflow.map((p) => p.pid), [12, 14], "workflow agents do not");
  // Container: `pgrep -af` returns "<pid> <command line>".
  const r = partsProcesses([`101 ${claudeSub}`, `102 ${claudeWf}`, `103 ${codexWf}`]);
  assert.deepEqual(r.holds, [`101 ${claudeSub}`]);
  assert.deepEqual(r.workflow, [`102 ${claudeWf}`, `103 ${codexWf}`]);
  // The marker is the file or the environment key, not a word somewhere in the prompt.
  assert.equal(isWorkflowAgent(`codex exec --json Explain CBASE_WORKFLOW_AGENT and c1.agent-x.workflow.mcp.json.bak`), false);
});

test("wrapper line: docker exec … cbase-wrapper … -- claude plus the inner line are ONE workflow agent, as a multiset", () => {
  assert.equal(wrappersInner(wrapper(claudeWfBox)), claudeWfBox);
  assert.equal(wrappersInner(claudeWfBox), null, "an inner line is no wrapper");
  // Wrapper + inner line (pgrep -af in the user container): ONE workflow agent.
  const r = partsProcesses([`201 ${wrapper(claudeWfBox)}`, `202 ${claudeWfBox}`]);
  assert.deepEqual(r, { holds: [], workflow: [`202 ${claudeWfBox}`] });
  // If B does not see the inner line, the wrapper stands for it.
  assert.deepEqual(partsProcesses([`201 ${wrapper(claudeWfBox)}`]).workflow.length, 1);
  // A subagent in the container still holds, once, not twice.
  assert.deepEqual(partsProcesses([`203 ${wrapper(claudeSubBox, "u2")}`, `204 ${claudeSubBox}`]), { holds: [`204 ${claudeSubBox}`], workflow: [] });
  // Multiset: two starts with the same command line are two; each inner line consumes exactly one wrapper.
  const two = partsProcesses([`201 ${wrapper(claudeSubBox, "a")}`, `202 ${wrapper(claudeSubBox, "b")}`, `203 ${claudeSubBox}`, `204 ${claudeSubBox}`]);
  assert.equal(two.holds.length, 2);
  const oneInner = partsProcesses([`201 ${wrapper(claudeSubBox, "a")}`, `202 ${wrapper(claudeSubBox, "b")}`, `203 ${claudeSubBox}`]);
  assert.equal(oneInner.holds.length, 2, "the second wrapper has no visible inner line, it counts itself");
  // The same pgid file (docker exec in B and, until the exec, perl in the container) is ONE start.
  const perl = `/usr/bin/perl /usr/sbin/cbase-wrapper --pgid-file ${PROJ}/processes/u1.pgid -- ${claudeWfBox}`;
  assert.equal(partsProcesses([`201 ${wrapper(claudeWfBox)}`, `205 ${perl}`]).workflow.length, 1);
  // Local (`{cmd}`) with an interpreter before the inner line (node script): the same computation.
  const local = partsProcesses([{ pid: 1, cmd: wrapper(`/opt/fake-claude ${claudeWfBox.slice(7)}`) }, { pid: 2, cmd: `/usr/local/bin/node /opt/fake-claude ${claudeWfBox.slice(7)}` }]);
  assert.deepEqual(local.workflow.map((p) => p.pid), [2]);
  // Codex in the container: the marker stands in the inner line as in the wrapper.
  assert.deepEqual(partsProcesses([`301 ${wrapper(codexWf, "c")}`, `302 ${codexWf}`]), { holds: [], workflow: [`302 ${codexWf}`] });
});

test("masking: values behind -e X=, --env X= and env.X= become ***, the names stay", () => {
  const row = `docker exec -e SECRET=abc --env TOKEN="x y" -e ONLY_NAME cbase-p-p1 codex exec -c mcp_servers.cbase.env.CBASE_TOKEN="s3cr3t" -c mcp_servers.cbase.env.CBASE_WORKFLOW_AGENT="a9" x`;
  const m = mask(row);
  for (const w of ["abc", "x y", "s3cr3t", "a9"]) assert.ok(!m.includes(w), `value ${w} is still there: ${m}`);
  assert.match(m, /-e SECRET=\*\*\* --env TOKEN=\*\*\* -e ONLY_NAME cbase-p-p1/);
  assert.match(m, /env\.CBASE_TOKEN=\*\*\* /);
  assert.equal(mask(claudeWf), claudeWf, "without values the line stays as it is");
  // Classification runs on the RAW line: the workflow agent's marker survives masking as a name.
  assert.ok(isWorkflowAgent(row) && isWorkflowAgent(m));
});

// ── The oneshot detection in the container hits the real starts ─────────────────────────────────────────────────────────
// In the container `pgrep -af "claude [-]-|[c]odex exec"` used to select, i.e. "claude --". But cbase always starts Claude
// with `-p` first (providers/connectors/claude.js): not a single Claude start hit, and a deploy ended extraction, compaction
// and title midway. Now the gate reads the WHOLE process list (`ps -ww -eo pid=,args=`) and decides in JS with the same rule as
// locally (lib/processes.mjs providerRows); in addition the backend's count applies (`open.oneshots`, also the loop engine,
// which has no process of its own). The guard builds the command lines from the REAL argument builders of the connectors, puts
// them into the process list of a fake container (ssh -> bash, docker -> node; `ps` shows control characters as `?`, `pgrep`
// is emulated with its own pattern) and runs the real remoteProcesses/remoteBusyOf.
// BUILT-IN COUNTER-TEST: lib/gates.mjs at state BEFORE_M35 (imports pointed at today's modules) finds only the Codex starts
// and does not hold for a backend oneshot without a process.
test("providerRows hits every real start (Claude oneshot, material, chat, both Codex, wrapper) and nothing else", () => {
  for (const [name, argv] of Object.entries(REAL)) assert.ok(isProviderRow(psRow(argv)), `${name}: ${psRow(argv).slice(0, 80)}`);
  assert.deepEqual(providerRows(LIST).map((z) => Number(z.split(" ")[0])), [812, 813, 814, 815, 816, 817]);
  assert.ok(LIST.includes(PROCESS_LIST), "the list carries the command of the gate itself, which must not count");
});
