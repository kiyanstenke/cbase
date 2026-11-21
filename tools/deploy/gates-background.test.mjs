// The "Background agents" row in gate and status.
//
// A subagent can outlive its turn; it counts in `busy` in the backend and appears in the `agents` field of /api/runs/active.
// The idle gate therefore waits for it — and must SAY for whom, and that `--force` takes it along, or someone swaps blindly.
// Held here: the row itself, and that the gate (server) and status show it.
//
// Waiting approval cards: /api/runs/active lists EVERY card (gateway, permission question), not only a manager tool's; the gate
// names the chat with its title in the abort text ("decide in chat "…"") and calls `approvalsSentence` for it.
// Counter-proofs: the old sentence "decide in the manager chat" in approvalsSentence => red at the title; the call removed from
// remoteGate => red at the call site.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { approvalsSentence, approvalsText, backgroundAgentsRow, monitorRow } from "./lib/gates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("background agents: count and chat, the text says the gate waits and --force takes them along", () => {
  const runs = {
    busy: true, runs: 0, approvals: [],
    agents: [
      { chatId: "c1", title: "Login rework", agentId: "a1", name: "agent-1" },
      { chatId: "c1", title: "Login rework", agentId: "a2", name: "agent-2" },
      { chatId: "c2", title: "", agentId: "a3", name: "agent-1" },
    ],
  };
  const [label, text, status] = backgroundAgentsRow(runs);
  assert.equal(label, "Background agents");
  assert.match(text, /^3 in Login rework \(2\), c2 — /, "count, then per chat (title, else id) with a count from two");
  assert.match(text, /gate waits for them/);
  assert.match(text, /--force/);
  assert.equal(status, "bad");
});

test("background agents: empty means none, a MISSING field means unknown, no backend means —", () => {
  assert.deepEqual(backgroundAgentsRow({ busy: false, runs: 0, agents: [] }), ["Background agents", "none", "ok"]);
  const [, text, status] = backgroundAgentsRow({ busy: false, runs: 0 });
  assert.match(text, /unknown/, "an old backend says nothing about its agents — not \"none\"");
  assert.equal(status, "warn");
  assert.deepEqual(backgroundAgentsRow(null), ["Background agents", "—", null]);
});

test("gate (server) and status show the row", () => {
  const gates = fs.readFileSync(path.join(HERE, "lib/gates.mjs"), "utf8");
  const body = (name) => {
    const i = gates.indexOf(`export async function ${name}(`);
    assert.ok(i >= 0, `${name} missing`);
    const j = gates.indexOf("\nexport ", i + 1);
    return gates.slice(i, j < 0 ? undefined : j);
  };
    for (const name of ["remoteGate"]) {
    assert.match(body(name), /backgroundAgentsRow\(/, `${name} shows the row`);
    assert.match(body(name), /Background agents are running/, `${name} names it in the abort text`);
  }
  const status = fs.readFileSync(path.join(HERE, "targets/status.mjs"), "utf8");
  assert.equal((status.match(/backgroundAgentsRow\(runs\)/g) || []).length, 1, "status: per container");
});

test("waiting cards: a gateway card appears with the chat title — in the row and in the sentence \"decide in chat …\"", () => {
  const approvals = [
    { chatId: "c1", title: "Payment bug in checkout", toolName: "mcp__teams__teams_send" },
    { chatId: "c2", title: "", toolName: "Bash" },
  ];
  assert.equal(approvalsText({ approvals }), " — waiting for approval: Payment bug in checkout (mcp__teams__teams_send), c2 (Bash)");
  const set = approvalsSentence(approvals);
  assert.match(set, /decide in chat "Payment bug in checkout", "c2", then start again\./, "title, else the id");
  assert.doesNotMatch(set, /Manager/, "there is no manager chat any more to decide in");
  assert.equal(approvalsSentence([]), "");
  assert.equal(approvalsSentence(undefined), "", "a backend without the field says nothing about cards — no sentence");
});

test("gate (server) names the waiting cards in the abort text", () => {
  const gates = fs.readFileSync(path.join(HERE, "lib/gates.mjs"), "utf8");
  const body = (name) => {
    const i = gates.indexOf(`export async function ${name}(`);
    const j = gates.indexOf("\nexport ", i + 1);
    return gates.slice(i, j < 0 ? undefined : j);
  };
  assert.match(body("remoteGate"), /approvalsSentence\(busy\.flatMap\(\(r\) => r\.runs\?\.approvals/);
  assert.doesNotMatch(gates, /manager chat/i);
});

// A monitor belongs to the chat and counts in `busy`; the row says which one is waited for, and the gate shows it. COUNTER-PROOF:
// delete the line `monitorRow(r.runs)` in remoteGate => the call test turns red; delete `if (!Array.isArray(runs.monitors))` =>
// "missing field" throws.
test("monitors: name, chat and kind; empty means none, a missing field unknown — and the gate shows the row", () => {
  const [label, text, status] = monitorRow({ busy: true, monitors: [{ chatId: "c1", title: "Main GEO", taskId: "monitor_1", name: "vitest", report: "end" }] });
  assert.equal(label, "Monitors");
  assert.match(text, /^1: vitest in Main GEO \(end\) — the gate waits for them/);
  assert.equal(status, "bad");
  assert.deepEqual(monitorRow({ busy: false, monitors: [] }), ["Monitors", "none", "ok"]);
  // A persistent monitor (a watch) does not hold the gate: the row says the swap interrupts it (it starts again after it), as a
  // warning, not as a block.
  // COUNTER-PROOF: `holding` counting every monitor => "persistent alone is a warning" red.
  const [, lastingText, lastingStatus] = monitorRow({ busy: false, monitors: [{ chatId: "c2", title: "Teams", taskId: "m2", name: "watch", report: "rows", persistent: true }] });
  assert.match(lastingText, /^1 persistent: watch in Teams \(rows\) — the swap interrupts them, they start again after it/);
  assert.equal(lastingStatus, "warn", "persistent alone is a warning");
  assert.match(monitorRow({ busy: false })[1], /unknown/);
  const gates = fs.readFileSync(path.join(HERE, "lib", "gates.mjs"), "utf8");
  const i = gates.indexOf("export async function remoteGate(");
  assert.ok(i >= 0, "remoteGate missing");
  const body = gates.slice(i, gates.indexOf("\nexport ", i + 1));
  assert.match(body, /monitorRow\(r\.runs\)/, "the gate shows the row");
  assert.match(body, /Monitors are running/, "and names it in the abort text");
});
