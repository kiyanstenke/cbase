// Size guideline and size warning of dynamic workflows (server/backend/electron/server/dynworkflows/size.js,
// settings/routes.js, toolchain/mcp-config.js, mcp/tools/dynworkflows.js `sizesSet`, run.js `checkSize`). Main seam with
// the agent harness.
//
// Counter-tests (which sabotage turns which test red):
//   - remove the suppression under ultracode (`if (ultracode) return null;` in size.js) => "warning" falls at the ultracode
//     case (and the "ultracode" unit);
//   - remove the environment CBASE_DYNWF_SIZE in toolchain/mcp-config.js => "guideline" falls (all stages see the preset's
//     sentence).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { SIZES, sizesWarning } from "../electron/server/dynworkflows/size.js";
import { SIZES_AGENTS } from "../electron/mcp/tools/dynworkflows.js";
import * as store from "../electron/server/store.js";

// ── The warning alone: axes, projection, ultracode ────────────────────────────────────────────────────────────
test("warning: more than 25 agents OR more than 1.5 million (projected) tokens — never under ultracode", () => {
  assert.equal(sizesWarning({ scheduled: 25, finished: 25, tokens: 250 }), null, "25 agents are not yet a warning");
  assert.deepEqual(sizesWarning({ scheduled: 26, finished: 26, tokens: 260 }), { axis: "agents", scheduled: 26, tokens: 260, projected: 260 });
  assert.deepEqual(sizesWarning({ scheduled: 1, finished: 1, tokens: 1_500_001 }), { axis: "tokens", scheduled: 1, tokens: 1_500_001, projected: 1_500_001 });
  assert.equal(sizesWarning({ scheduled: 1, finished: 1, tokens: 1_500_000 }), null, "exactly 1.5 million is not yet one");
  // Projection: average of the finished × scheduled.
  assert.deepEqual(sizesWarning({ scheduled: 2, finished: 1, tokens: 800_000 }), { axis: "tokens", scheduled: 2, tokens: 800_000, projected: 1_600_000 });
  assert.equal(sizesWarning({ scheduled: 1, finished: 1, tokens: 800_000 }), null);
  // Without finished agents: 70,000 per agent (as in the reference) — 22 × 70,000 = 1.54 million.
  assert.equal(sizesWarning({ scheduled: 21, finished: 0, tokens: 0 }), null);
  assert.deepEqual(sizesWarning({ scheduled: 22, finished: 0, tokens: 0 }), { axis: "tokens", scheduled: 22, tokens: 0, projected: 1_540_000 });
  assert.deepEqual(sizesWarning({ scheduled: 30, finished: 1, tokens: 2_000_000 }).axis, "both");
  for (const f of [{ scheduled: 26, finished: 26, tokens: 260 }, { scheduled: 2, finished: 1, tokens: 800_000 }, { scheduled: 30, finished: 1, tokens: 2_000_000 }]) {
    assert.equal(sizesWarning({ ...f, ultracode: true }), null, `ultracode suppresses: ${JSON.stringify(f)}`);
  }
});

test("stages: server and MCP description know the same ones (small · medium · large with agent count, unrestricted without)", () => {
  assert.deepEqual([...SIZES], ["small", "medium", "large", "unrestricted"]);
  assert.deepEqual(Object.keys(SIZES_AGENTS), SIZES.filter((g) => g !== "unrestricted"));
});

// The main agent: "DESCRIPTION" stores the description of cbase_dynamic_workflow as ITS MCP server delivers it (tools/list —
// what the model reads), with the environment that this run's configuration gave the server. "WF[<tag>]:{json}:FW" calls
// the tool.
const MAIN = `
  if (text.includes("DESCRIPTION")) {
    const m = await mcpRpc("tools/list", {});
    const d = ((m.result && m.result.tools) || []).find((t) => t.name === "cbase_dynamic_workflow");
    const env = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase.env || {};
    fs.appendFileSync(path.join(LOCATION, "descriptions.jsonl"), JSON.stringify({ d: d ? d.description : null, env: env.CBASE_DYNWF_SIZE ?? null }) + "\\n");
  }
  if (text.includes("WF[")) {
    const i = text.indexOf("WF[");
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2, text.indexOf(":FW", i)));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test only waits for the file to exist
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "main-session" });`;
// A workflow agent: {TAG:x}, {IN:n}/{OUT:n} are its tokens.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const field = (k, v) => (job.includes("{" + k + ":") ? job.split("{" + k + ":")[1].split("}")[0] : v);
    const tag = field("TAG", "x");
    say({ type: "assistant", message: { id: "s-" + tag, usage: { input_tokens: Number(field("IN", "1")), output_tokens: Number(field("OUT", "1")) }, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;
const claude = fakeClaude({ main: MAIN, sub: SUB });

async function route(base, method, body) {
  const res = await fetch(`${base}/api/dyn-workflow-size`, {
    method, headers: { "Content-Type": "application/json", Connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}
// The fakes (child processes) write the logs while the test reads — only completed lines (jsonl.mjs).
const descriptions = (root) => readJsonl(path.join(root, "descriptions.jsonl"));

test("guideline: the route requires its field; every stage reaches the model with its own wording — the preset without environment", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForIdle } = ctx;
    const prior = await route(base, "GET");
    assert.deepEqual(prior, { status: 200, body: { size: "medium", preset: "medium", stages: SIZES } }, "preset medium");
    for (const body of [{}, { size: null }, { size: "" }, { cap: 3 }]) {
      const r = await route(base, "PUT", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} => 400`);
      assert.match(r.body.error, /fehlt|missing/);
    }
    for (const body of [{ size: "huge" }, { size: 3 }, { size: "Medium" }]) assert.equal((await route(base, "PUT", body)).status, 400, JSON.stringify(body));
    assert.equal((await route(base, "GET")).body.size, "medium", "none of it set anything");

    const desired = {
      small: /set a size guideline for dynamic workflows: small — keep workflows under 5 agents\. Treat it as a recommendation, not a limit/,
      medium: /default size guideline for dynamic workflows applies: medium — keep workflows under 10 agents\..*Usage → Dynamic workflows/,
      large: /dynamic workflows: large — keep workflows under 50 agents\./,
      unrestricted: /No guideline applies to the size of dynamic workflows \(unrestricted\)/,
    };
    const seen = new Map();
    for (const g of ["small", "large", "unrestricted", "medium"]) {
      const r = await route(base, "PUT", { size: g });
      assert.deepEqual([r.status, r.body.size], [200, g], JSON.stringify(r.body));
      assert.equal((await route(base, "GET")).body.size, g);
      const n = descriptions(root).length;
      await post(base, chat.id, `DESCRIPTION ${g}`);
      await waitForTruthy(() => descriptions(root).length > n, `description (${g})`);
      await waitForIdle();
      const { d, env } = descriptions(root).at(-1);
      assert.match(d, desired[g], `${g}: ${d}`);
      for (const [other, re] of Object.entries(desired)) if (other !== g) assert.doesNotMatch(d, re, `${g} does not carry the sentence of ${other}`);
      assert.equal(env, g === "medium" ? null : g, "the environment only on deviation from the preset (spawn bytes of the preset unchanged)");
      seen.set(g, d);
    }
    assert.equal(new Set(seen.values()).size, 4, "four stages, four wordings");
  }, { claude });
});

const post = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Size', phases: [{ title: 'One' }] }\n${body}\n`;
async function run(ctx, chatId, tag, text) {
  await post(ctx.base, chatId, text);
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(r.status, "started", JSON.stringify(r));
  const end = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), `run ${r.runId}`);
  assert.equal(end.status, "finished", end.error);
  return end;
}
// Two agents: the first ends with 800,000 tokens (790,000 input + 10,000 output) — at the second call the run projects
// 2 × 800,000 = 1.6 million. Only 800,000 are spent by then: the warning comes from the projection.
const BODY = "await agent('x {TAG:g1}{IN:790000}{OUT:10000}');\nawait agent('x {TAG:g2}');\nreturn 'ok';";

test("warning: a run over 1.5 million PROJECTED tokens gets exactly one — none in ultracode mode", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, waitForIdle } = ctx;
    // Without the mode, with the keyword (opt-in): the warning appears.
    const including = await run(ctx, chat.id, "w", `ultracode please WF[w]:${JSON.stringify({ script: script("large", BODY) })}:FW`);
    const warnings = store.readDynEvents(including.runId).filter((e) => e.kind === "warning");
    assert.equal(warnings.length, 1, JSON.stringify(store.readDynEvents(including.runId)));
    assert.match(warnings[0].text, /Großer Workflow: 2 agent\(\)-Aufrufe, 800\.000 Token verbraucht, 1\.600\.000 projiziert|Large workflow: 2 agent\(\) calls, 800,000 tokens spent, 1,600,000 projected/);
    const file = JSON.parse(fs.readFileSync(including.outputPath, "utf8"));
    assert.deepEqual(file.events.filter((e) => e.kind === "warning").map(({ axis, scheduled, tokens, projected }) => ({ axis, scheduled, tokens, projected })),
      [{ axis: "tokens", scheduled: 2, tokens: 800_000, projected: 1_600_000 }], "in the output file, with the numbers");
    await waitForIdle();

    // In ultracode mode: the same run, no warning.
    await ultracodeOn(base, chat.id);
    const without = await run(ctx, chat.id, "u", `WF[u]:${JSON.stringify({ script: script("large-ultra", BODY) })}:FW`);
    assert.deepEqual(store.readDynEvents(without.runId).filter((e) => e.kind === "warning"), [], "suppressed under ultracode");
    await waitForIdle();
  }, { claude });
});
