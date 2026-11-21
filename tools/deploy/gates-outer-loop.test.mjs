// The deploy waits for running outer-loop runs and says WHO it waits for.
//
// An outer-loop run is its own core without a journal: the backend counts it in `busy` and names it in the `outerLoop` field of
// /api/runs/active (agent, observed chat, start). The "Outer Loop" row (lib/gates.mjs outerLoopRow) appears per user container;
// the abort text of the gate and the wait lines mention it. Three states: empty means "none", a MISSING field (an old backend)
// means "unknown" — never "none" — and a running run names chat and agent plus the price of `--force` (the run aborts, the next
// start marks it "aborted", the next trigger catches up). That the backend counts the run in `busy` and `open` is held by
// server/backend/test/outerloop-idle.test.js.
//
// COUNTER-PROOF: delete the line `if (!Array.isArray(runs.outerLoop)) return …` in lib/gates.mjs => "a MISSING field means unknown"
// turns red (the old backend would show as "none"); remove `outerLoopRow(` from the remoteGate table => "gate (server) shows the
// row" turns red.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { outerLoopRow } from "./lib/gates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("outer loop: running names count, chat and agent, says the gate waits and what --force costs", () => {
  const runs = {
    busy: true, runs: 0, agents: [],
    outerLoop: [
      { runId: "l1", agentId: "a1", agentName: "Summarizer", chatId: "c1", title: "Login rework", startedAt: 1 },
      { runId: "l2", agentId: "a2", agentName: "", chatId: "c2", title: "", startedAt: 2 },
    ],
  };
  const [label, text, status] = outerLoopRow(runs);
  assert.equal(label, "Outer Loop");
  assert.match(text, /^2 running in Login rework \(Summarizer\), c2 \(a2\) — /, "count, then per run chat (title, else id) and agent (name, else id)");
  assert.match(text, /the gate waits/);
  assert.match(text, /--force/);
  assert.match(text, /aborted/);
  assert.match(text, /next trigger catches up/);
  assert.equal(status, "bad");
});

test("outer loop: empty means none, a MISSING field means unknown", () => {
  assert.deepEqual(outerLoopRow({ busy: false, runs: 0, outerLoop: [] }), ["Outer Loop", "none", "ok"]);
  const [, text, status] = outerLoopRow({ busy: false, runs: 0, agents: [] });
  assert.match(text, /unknown/, "an old backend says nothing about its runs — not \"none\"");
  assert.equal(status, "warn");
  const [, without] = outerLoopRow(null);
  assert.match(without, /unknown/, "without a backend never \"none\"");
  // A number instead of a list is not a valid field either — unknown.
  assert.match(outerLoopRow({ outerLoop: 2 })[1], /unknown/);
});

test("gate (server) shows the row and names the outer loop in the abort text and the wait lines", () => {
  const gates = fs.readFileSync(path.join(HERE, "lib/gates.mjs"), "utf8");
  const body = (name) => {
    const i = gates.search(new RegExp(`export (async )?function ${name}\\(`));
    assert.ok(i >= 0, `${name} missing`);
    const j = gates.indexOf("\nexport ", i + 1);
    return gates.slice(i, j < 0 ? undefined : j);
  };
    for (const name of ["remoteGate"]) {
    assert.match(body(name), /outerLoopRow\(/, `${name} shows the row`);
    assert.match(body(name), /Outer-loop runs are running/, `${name} names it in the abort text`);
  }
  assert.match(body("waitRemoteIdle"), /outerLoop=\$\{r\.runs\?\.outerLoop\?\.length \?\? "\?"\}/, "wait line per container");
  assert.match(gates, /const busyText = \(r\) => `[^`]*outerLoop=\$\{r\.runs\?\.outerLoop\?\.length \?\? "\?"\}/, "busyText");
});
