// The translation of neutral blocks <-> wire format. Two silent defects sat exactly here: `openai-responses` reported
// vision:true and still dropped images, `openai-chat` reported vision:false although it translates images completely. Ten
// lines of test would have caught both.
//
// There is only ONE HTTP wire left: openai-chat, over which the built-in OpenRouter runs (connectors/openrouter.js). The clamps
// number three (claude, codex, openai-chat); the wire carries all five efforts, a model entry with `efforts` clamps.
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CAPS as CHAT_CAPS, makeOpenAiChatConnector, toOpenAiMessages } from "../electron/server/providers/connectors/openai-chat.js";
import { makeOpenRouterConnector } from "../electron/server/providers/connectors/openrouter.js";
import { openRouterBase } from "../electron/server/providers/openrouter-catalog.js";
import { OPENROUTER_BASE } from "../electron/server/account/usage-contract.js";
import { thinkingAsResponse } from "../electron/server/providers/engine.js";
import { buildClaudeChatArgs, claudeEfforts, mapClaudeEffort } from "../electron/server/providers/connectors/claude.js";
import { buildCodexChatArgs, codexEffortFallback, codexEfforts } from "../electron/server/providers/connectors/codex.js";
import { GAP, withGapsModel } from "./gaps-model.mjs";
// The order of the efforts and the ONE computation of the clamp.
import { EFFORT_LEVELS, effortFallback } from "../electron/server/workflows.js";

const IMG = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };

test("caps tell the truth — in both directions", () => {
  // What the wire promises it must also do (and vice versa).
  assert.equal(CHAT_CAPS.vision, true, "the wire translates images");
  assert.equal(CHAT_CAPS.effort, true, "it can send reasoning effort");
  assert.equal(CHAT_CAPS.ownsAgentLoop, false);
  // Two axes, not one: "can look at images" is not "accepts a PDF". Many providers stand behind OpenRouter, and an unknown part
  // type blows up the whole call — the `file` part stays off.
  assert.equal(CHAT_CAPS.documents, false, "stays off for OpenAI-compatible");
  const or = makeOpenRouterConnector({ access: () => ({ apiKey: "", extraBody: {} }) });
  assert.deepEqual([or.caps.vision, or.caps.documents, or.caps.effort, or.caps.ownsAgentLoop], [true, false, true, false], "OpenRouter carries the wire's caps");
});

test("openai-chat: images, tool calls and tool results", () => {
  const out = toOpenAiMessages([
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "What is this?" }, IMG] },
    { role: "assistant", content: [{ type: "text", text: "one moment" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "content" }] },
  ]);
  assert.equal(out[0].content, "sys");
  // Image as a data-URI part.
  const parts = out[1].content;
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,AAAA$/);
  // Tool call.
  assert.equal(out[2].tool_calls[0].function.name, "Read");
  assert.equal(JSON.parse(out[2].tool_calls[0].function.arguments).file_path, "/a");
  // Result as its own role:"tool" message.
  assert.deepEqual({ role: out[3].role, id: out[3].tool_call_id, c: out[3].content }, { role: "tool", id: "t1", c: "content" });
});

test("openai-chat: an image FROM a tool result reaches the model", () => {
  // role:"tool" may carry only text — so the screenshot must come as its own user message right behind it, or nobody sees it.
  const out = toOpenAiMessages([
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Screenshot taken" }, IMG] }] },
  ]);
  assert.equal(out[0].role, "tool");
  assert.equal(out[0].content, "Screenshot taken");
  assert.equal(out[1].role, "user");
  assert.equal(out[1].content.at(-1).type, "image_url");
});

/**
 * The guard against drift between the conversation path and the one-shot path.
 *
 * What it catches: a preset reports `vision: true` — its CONVERSATION translates images too — but its `runOnce` builds
 * `messages: [{role:"user", content: prompt}]`, a plain string. Images would be dropped silently there, while the prompt
 * builder writes "you see it as image 1 below" because of caps.vision. A prompt that refers to material that never arrived
 * is worse than one without material.
 *
 * So what is checked is not the FORM (it differs per API and is the translators' business) but the one statement that holds
 * for all: **the bytes must be on the wire — exactly when the caps promise it.** Table-driven over the wire's connectors
 * (openai-chat without a name and with the name of the built-in OpenRouter).
 */
const B64_IMAGE = "QUJDREVG";      // freely invented but unique payload …
const B64_DOC = "R0hJSktMTU5P";   // … and a second one so the axes are not confused
async function wireBody(conn, opts) {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try { await conn.runOnce("What is here?", opts); } finally { globalThis.fetch = origFetch; }
  return { raw: String(calls[0]?.init?.body || ""), body: JSON.parse(calls[0]?.init?.body || "{}") };
}

test("runOnce carries material onto the wire — exactly as far as the caps promise", async () => {
  for (const presetId of ["openai-chat", "openrouter"]) {
    const conn = presetConn(presetId);
    const caps = conn.caps;

    const including = await wireBody(conn, {
      model: "m1",
      images: [{ mime: "image/png", dataB64: B64_IMAGE }],
      documents: [{ mime: "application/pdf", dataB64: B64_DOC, name: "template.pdf" }],
    });
    assert.equal(including.raw.includes(B64_IMAGE), caps.vision,
      `${presetId}: caps.vision=${caps.vision}, but the image ${including.raw.includes(B64_IMAGE) ? "is" : "is NOT"} on the wire`);
    assert.equal(including.raw.includes(B64_DOC), caps.documents,
      `${presetId}: caps.documents=${caps.documents}, but the document ${including.raw.includes(B64_DOC) ? "is" : "is NOT"} on the wire`);
    // The prompt must not get lost — material ADDS to it, it does not replace it.
    assert.ok(including.raw.includes("What is here?"), `${presetId}: the prompt is missing next to the material`);

    // And without material the wire format of the normal case stays unchanged: a string, not a block list. Otherwise this
    // extension would have changed every existing one-shot.
    const without = await wireBody(conn, { model: "m1" });
    const content = without.body.messages?.[0]?.content ?? without.body.input;
    assert.equal(typeof content, "string", `${presetId}: without material the content must stay a string`);
  }
});

test("OpenRouter (built-in): extraBody travels along, core fields win, X-Title set, base from the contract", async () => {
  // The base is in the contract (account/usage-contract.js), only the test seam CBASE_OPENROUTER_BASE overrides it.
  const seam = process.env.CBASE_OPENROUTER_BASE;
  delete process.env.CBASE_OPENROUTER_BASE;
  try { assert.equal(openRouterBase(), OPENROUTER_BASE); } finally { if (seam !== undefined) process.env.CBASE_OPENROUTER_BASE = seam; }
  // The access comes per call from the providers.openrouter row (here a callback) — model in extraBody is the sabotage attempt:
  // core fields must win.
  const conn = makeOpenRouterConnector({
    access: () => ({ apiKey: "sk-test", extraBody: { provider: { sort: "price" }, usage: { include: true }, model: "malicious/override" } }),
  });

  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal(await conn.runOnce("hi", { model: "z-ai/glm-5.3-flash" }), "ok");
  } finally { globalThis.fetch = origFetch; }
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, `${openRouterBase()}/chat/completions`);
  assert.equal(body.provider.sort, "price", "routing object travels in the body");
  assert.deepEqual(body.usage, { include: true }, "further extra fields likewise");
  assert.equal(body.model, "z-ai/glm-5.3-flash", "extraBody does not override core fields");
  assert.equal(calls[0].init.headers["X-Title"], "cbase", "OpenRouter attribution is set");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(conn.reportsCost, true, "the built-in OpenRouter always reads the amount — also behind the test seam");
});

// ── Effort clamp per provider ─────────────────────────────────────────────────────────────────
//
// A chat could once store a sixth effort that only Codex knew, and a provider switch does NOT rewrite the chosen effort — the
// user chose it. A chat on codex/Sol with that effort, then `/model opus`, and the effort ended up at Claude. Without the clamp
// that was a SILENT regression three times over, the worst case being the highest effort:
//   • claude.js passed it raw to the CLI — which drops it with a stderr warning nobody reads (measured with 2.1.273, exit 0),
//     and thinks with the default.
//   • a wire with `THINKING_BUDGET[effort] || 0` => 0 => the `thinking` block dropped ENTIRELY — the highest effort switched
//     thinking OFF, i.e. less than low.
//   • openai-chat: `EFFORT_MAP[effort]` => undefined => `reasoning_effort` was not sent at all, although `max` used to map to "high".
// That effort is gone, the order has five; stored old values migrate to max at start (store/chats.js, guard ultra-gone.test.js).
// The clamps stay — they are the promise that a future effort a table does not carry does not silently vanish again.
//
// All clamps compute the same rule, and it stands once: `effortFallback` in workflows.js, right next to the order of the efforts
// (EFFORT_LEVELS). The rule is "the highest carried effort that is NOT ABOVE the wanted one; if none is below, the lowest
// carried" — downwards, never upwards: one more effort costs thinking tokens against the subscription limit, and nobody asked
// for it. An earlier version took the LAST element of the carried list; for a model with a GAP (then gpt-5.5: no `max`, but the
// sixth effort) that jumped over the carried `xhigh` one effort ABOVE the wish, while the others clamped downwards.
//
// What is no effort at all (not in EFFORT_LEVELS) drops out everywhere: no flag, no field, no budget. Before, the clamps gave
// THREE answers — codex dropped it, claude sent `--effort max`, the presets their maximum. The case is unreachable (stored via
// `effortSavable`, run via `effortRunning`), but a sign with two inscriptions is one even when nobody stands in front of it.
//
// And every clamp says what it does — one that deviates silently cannot be told from one that hits.
// Catch the body of a complete() call without building a response: fetch remembers the call and throws. The wire streams SSE,
// a real response object would be one more variant.
async function completeBody(conn, args) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(init); throw new Error("intercepted — the body is available"); };
  try { await conn.complete({ messages: [{ role: "user", content: "hi" }], ...args }).catch(() => {}); }
  finally { globalThis.fetch = orig; }
  return JSON.parse(calls[0]?.body || "{}");
}
// Collect the console lines of ONE call. `await fn()` instead of `fn()`: the presets' clamp sits before the first `await` in
// complete(), but relying on that would let a harmless change there make this test silently blind — it counts the lines, and
// zero is also a value.
async function withWarnings(fn) {
  const rows = [];
  const original = console.warn;
  console.warn = (...a) => rows.push(a.map(String).join(" "));
  try { return { value: await fn(), rows }; } finally { console.warn = original; }
}
// The connectors of the one HTTP wire: "openai-chat" = the factory without a name of its own, "openrouter" = the same factory with the name
// and header of the built-in OpenRouter (connectors/openrouter.js) — both on example.test.
function presetConn(presetId) {
  return makeOpenAiChatConnector({
    id: presetId, label: presetId, baseUrl: "https://example.test/v1", apiKey: "sk-test",
    models: [{ id: "m1", label: "M1", context: 1000 }],
    ...(presetId === "openrouter" ? { wire: "openrouter", headers: { "X-Title": "cbase" } } : {}),
  });
}

test("Effort clamp Claude: the five efforts pass through, the former sixth is none any more — and the clamp says so", async () => {
  const spec = (effort) => ({
    cwd: "/tmp/x", input: "hi", systemPrompt: "", addDirs: [], permissionMode: "bypassPermissions",
    mcpConfigPath: "/tmp/mcp.json", allowedTools: [], model: "claude-opus-5", effort,
  });
  const flag = (args) => args[args.indexOf("--effort") + 1];

  // The CLI's five efforts pass through character for character — the clamp is no conversion.
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    const { value: args, rows } = await withWarnings(() => buildClaudeChatArgs(spec(level)));
    assert.equal(flag(args), level);
    assert.deepEqual(rows, [], `${level} must not produce a warning`);
  }
  // No effort chosen => no flag at all, as before.
  assert.ok(!buildClaudeChatArgs(spec("")).includes("--effort"));

  // The former sixth effort (clamped to max until then) is NO effort any more: no flag, one line.
  // It can only reach the clamp as a leak — the migration at start turns stored values into max.
  const { value: args, rows } = await withWarnings(() => buildClaudeChatArgs(spec("ultra")));
  assert.ok(!args.includes("--effort"), "a non-effort must not produce a flag");
  assert.equal(rows.length, 1);
  assert.match(rows[0], /\[claude\]/);
  assert.match(rows[0], /not an effort level at all/);

  // What is no effort at all drops OUT — no flag. Before, this place sent `--effort max` for it: an invented effort, and the
  // most expensive one at that.
  const nonsense = await withWarnings(() => buildClaudeChatArgs(spec("cozy")));
  assert.ok(!nonsense.value.includes("--effort"), "a non-effort must not produce a flag");
  assert.equal(nonsense.rows.length, 1);
  assert.match(nonsense.rows[0], /\[claude\]/);
  assert.match(nonsense.rows[0], /cozy/);
});

test("Ultracode is a mode, not an effort: the word never reaches the CLI, not even as an effort", async () => {
  // Measured: as a further entry of the effort order the substitution rule clamped "ultracode" to max — above the xhigh that
  // Claude Code understands. The mode therefore stands next to the effort (`chats.ultracode`), independent of it — only the
  // chat's effort arrives as effort.
  const spec = (effort, model = "claude-opus-5-5") => ({
    cwd: "/tmp/x", input: "hi", systemPrompt: "", addDirs: [], permissionMode: "bypassPermissions",
    mcpConfigPath: "/tmp/mcp.json", allowedTools: [], model, effort,
  });
  const { value: args } = await withWarnings(() => buildClaudeChatArgs(spec("ultracode")));
  assert.ok(!args.includes("--effort"), "\"ultracode\" as an effort must not produce a flag — certainly not max");
  assert.ok(!args.some((a) => /ultracode/i.test(String(a))));
  assert.equal(effortFallback("ultracode", claudeEfforts("claude-opus-5-5")), "", "the substitution rule does not know the mode");
  // The chat's effort passes as effort, also in the mode (the mode sets no effort any more).
  const x = buildClaudeChatArgs(spec("xhigh"));
  assert.equal(x[x.indexOf("--effort") + 1], "xhigh");
  assert.ok(!buildClaudeChatArgs(spec("xhigh", "claude-haiku-4-5-20251001")).includes("--effort"), "without efforts no --effort");
});

test("Effort clamp openai-chat: max reaches the wire's maximum, a non-effort disappears audibly", async () => {
  const chat = presetConn("openai-chat");
  const level = (body) => body.reasoning_effort;

  // Without an entry the wire carries all five efforts (OpenRouter maps to the model's level itself). The details are held by
  // preset-wire.test.js.
  for (const [name, conn, maximum] of [["openai-chat", chat, "max"]]) {
    assert.equal(level(await completeBody(conn, { model: "m1", effort: "medium" })), "medium", name);
    await withWarnings(async () => assert.equal(level(await completeBody(conn, { model: "m1", effort: "max" })), maximum, name));

    // Something that is no effort at all leaves the field OUT — the same answer as for Codex and Claude. `= ""` would be worse
    // than nothing: the API would get an empty string. It is reported anyway.
    const foreign = await withWarnings(() => completeBody(conn, { model: "m1", effort: "cozy" }));
    assert.equal(level(foreign.value), undefined, `${name}: a non-effort must not invent a field`);
    assert.equal(foreign.rows.length, 1, `${name}: an unknown effort must write one line`);
    assert.match(foreign.rows[0], new RegExp(`\\[${name}\\]`));

    // Without an effort the field stays out — the clamp must not invent one.
    assert.equal(level(await completeBody(conn, { model: "m1", effort: "" })), undefined, name);
  }
});

// The guard under the computation: ONE computation, three clamps (claude, codex, openai-chat). Before, several versions of the
// same question stood in the tree, giving three answers to a non-effort and, for `max` at gpt-5.5, one that lay ABOVE the wish.
test("One rule, three clamps: a non-effort drops out everywhere, and clamping goes DOWNWARDS", async () => {
  const rang = (g) => EFFORT_LEVELS.indexOf(g);
  const claudeSpec = (effort) => ({
    cwd: "/tmp/x", input: "hi", systemPrompt: "", addDirs: [], permissionMode: "bypassPermissions",
    mcpConfigPath: "/tmp/mcp.json", allowedTools: [], model: "claude-opus-5", effort,
  });
  const codexFlag = (args) => args.filter((a, i) => args[i - 1] === "-c" && /^model_reasoning_effort=/.test(a));

  // 1) A value that is not in EFFORT_LEVELS is NO effort — and drops out everywhere.
  //    Before: codex dropped it, claude sent `--effort max`, the presets their maximum.
  //    The pure computations stay silent first — the SPAWN paths are counted next, each exactly once (mapClaudeEffort also
  //    reports when buildClaudeChatArgs calls it).
  await withWarnings(() => {
    assert.equal(codexEffortFallback("cozy", "gpt-5.6-sol"), "");
    assert.equal(mapClaudeEffort("cozy"), "", "claude: no --effort");
  });
  const { rows } = await withWarnings(async () => {
    assert.deepEqual(codexFlag(buildCodexChatArgs({ cwd: "/tmp/x", model: "gpt-5.6-sol", effort: "cozy", permissionMode: "bypassPermissions" })), [],
      "codex: no -c model_reasoning_effort");
    assert.ok(!buildClaudeChatArgs(claudeSpec("cozy")).includes("--effort"));
    assert.equal((await completeBody(presetConn("openai-chat"), { model: "m1", effort: "cozy" })).reasoning_effort, undefined,
      "openai-chat: no reasoning_effort");
  });
  // Dropped does not mean concealed: each of the three clamps writes exactly one line.
  assert.equal(rows.length, 3, `three clamps, three lines — counted: ${rows.length}`);
  for (const marker of ["[codex]", "[claude]", "[openai-chat]"]) {
    assert.equal(rows.filter((z) => z.includes(marker)).length, 1, `${marker} does not report the non-effort`);
  }

  // 2) The substitute NEVER lies above the wish — over all five efforts and all carrier lists that really exist in the tree.
  //    One more effort costs thinking tokens against the subscription limit, and nobody asked for it. (The one case in which
  //    the rule would go upwards — the model carries nothing below the wish — does not occur here: every list carries `low`.)
  const listen = [
    // No Codex catalog model carries a gap any more — the test model carries its list.
    [`codex/${GAP}`, withGapsModel(() => codexEfforts(GAP))],
    ["codex/gpt-5.4", codexEfforts("gpt-5.4")],
    ["codex/gpt-5.6-sol", codexEfforts("gpt-5.6-sol")],
    ["claude-cli", ["low", "medium", "high", "xhigh", "max"]],
    ["openai-chat (REASONING_EFFORT)", presetConn("openai-chat").efforts("m1")],
    ["openai-chat, entry without xhigh/max", ["low", "medium", "high"]],
  ];
  for (const [name, supported] of listen) {
    assert.ok(supported.includes("low"), `${name}: precondition — the list carries low`);
    for (const level of EFFORT_LEVELS) {
      const e = effortFallback(level, supported);
      assert.ok(supported.includes(e), `${name}/${level}: the substitute "${e}" is not carried at all`);
      assert.ok(rang(e) <= rang(level), `${name}/${level}: the substitute "${e}" lies ABOVE the wish`);
    }
  }

  // 3) And the numbers the client named — each measured at the clamp itself.
  assert.equal(withGapsModel(() => codexEffortFallback("max", GAP)), "xhigh", "model without max + max => xhigh");
  assert.equal(codexEffortFallback("max", "gpt-5.4"), "max");
  await withWarnings(async () => {
    assert.equal(mapClaudeEffort("max"), "max");
    // The wire carries max (the generic maximum high is gone).
    const body = await completeBody(presetConn("openai-chat"), { model: "m1", effort: "max" });
    assert.equal(body.reasoning_effort, "max", "openai-chat: max is the wire's maximum");
  });

  // 4) The former sixth effort is no effort at any clamp any more: no flag, no field, no budget — no table carries it as "like
  //    max". A stored old value does not reach the clamps: the migration turns it into max.
  await withWarnings(async () => {
    assert.equal(codexEffortFallback("ultra", "gpt-5.4"), "");
    assert.equal(mapClaudeEffort("ultra"), "");
    const body = await completeBody(presetConn("openai-chat"), { model: "m1", effort: "ultra" });
    assert.equal(body.reasoning_effort, undefined, "openai-chat: the former sixth effort must not produce a field any more");
  });
});

// ── The answer in the thinking channel ─────────────────────────────────────────────────────────
//
// GLM-5.2 at Nebius (SGLang with a reasoning parser) answered "Answer with exactly the word: ready" by writing the word into
// `reasoning_content` and leaving `content` empty: the model did not close its thinking block, and the parser then assigns
// EVERYTHING to thinking (usage 7776/2, finish_reason stop, no tool call). The connector returned `text: ""`, the engine ended
// the turn without an answer, the agent core wrote "(no report)" — and in an ordinary chat the answer stood only in the
// collapsed thinking block. The rule: when a round ends REGULARLY (stop) without answer text and without a tool call, the
// thinking text is the answer. Not on a cut at the token limit (truncated thinking is no answer) and not next to tool calls.
//
// In the conversation (`complete`) the connector does not swap by itself: it reports `thinkingWithoutResponse` (with the round's
// self-report in `diagnostic`), leaves text and thinking as they came, and sends NO second text delta; whether the thinking text
// is the answer or an intention never carried out is decided by the engine (follow up, else `thinkingAsResponse`). The two tests
// below hold the rule itself — when a round is "thinking only" and what the answer would then be —, as report plus
// `thinkingAsResponse`; the path through the engine stands in engine-harness.test.js and engine-task-core.test.js. `runOnce`
// is unchanged (no tool, nobody who follows up).
//
// Sabotage: connectors/openai-chat.js without the swap rule => all three fail (`text` empty, the blank lines as answer,
// runOnce empty).
const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } });
async function withResponse(response, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => response();
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
// The form Nebius delivers for GLM-5.2 (raw body as the model: role chunk, content chunk, final chunk with finish_reason, usage
// chunk without choices) — here with the word in the thinking channel.
const nebiusChunks = ({ content = "", thinking = null, finish = "stop", toolCalls = null } = {}) => [
  { choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: null }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content, reasoning_content: thinking, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: null }, finish_reason: finish }] },
  { choices: [], usage: { prompt_tokens: 7776, completion_tokens: 2 } },
];

test("openai-chat: a round that ends regularly with thinking text only is reported by the connector — and the thinking text would be the answer", async () => {
  const conn = presetConn("openai-chat");
  const deltas = [];
  const r = await withResponse(() => sse(nebiusChunks({ thinking: "ready" })),
    () => conn.complete({ messages: [{ role: "user", content: "Answer with exactly the word: ready" }], model: "m1", onDelta: (d) => deltas.push(d) }));
  assert.equal(r.thinkingWithoutResponse, true, "the form \"thinking only, ended regularly\" is reported");
  assert.deepEqual({ text: r.text, thinking: r.thinking }, { text: "", thinking: "ready" }, "the connector no longer swaps by itself");
  assert.equal(r.stop, "stop");
  assert.deepEqual(r.toolCalls, []);
  assert.deepEqual(r.usage, { input: 7776, output: 2, cached: 0 });
  // Live only the thinking delta — the second delta of the same text as an answer (before: `{ text: "ready" }` afterwards) is sent,
  // if at all, by the engine in the fallback.
  assert.deepEqual(deltas, [{ thinking: "ready" }]);
  // The fallback's rule: the model's answer does not get lost in the thinking channel and does not stand there twice.
  assert.deepEqual((({ text, thinking }) => ({ text, thinking }))(thinkingAsResponse(r)), { text: "ready", thinking: "" });
  // The round's self-report (for stderr): here the raw body carries no id — it stays empty, not invented.
  assert.deepEqual(r.diagnostic, { id: "", provider: "", native_finish_reason: "", reasoning_tokens: null });
});

test("openai-chat: thinking next to answer text, at the token limit or next to tool calls stays thinking", async () => {
  const conn = presetConn("openai-chat");
  const round = (chunks) => withResponse(() => sse(chunks), () => conn.complete({ messages: [{ role: "user", content: "hi" }], model: "m1" }));
  // The normal case of a reasoning model: thinking, then answer — unchanged.
  const normal = await round([
    { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I think." } }] },
    { choices: [{ index: 0, delta: { content: "ready" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
  assert.deepEqual({ text: normal.text, thinking: normal.thinking }, { text: "ready", thinking: "I think." });
  assert.equal(normal.thinkingWithoutResponse, undefined);
  // Truncated: the thinking is incomplete and no answer — the engine reports the truncation itself.
  const lang = await round(nebiusChunks({ thinking: "First I check", finish: "length" }));
  assert.deepEqual({ text: lang.text, thinking: lang.thinking, stop: lang.stop }, { text: "", thinking: "First I check", stop: "length" });
  assert.equal(lang.thinkingWithoutResponse, undefined);
  // Next to a tool call the thinking is the reason for the call, not an answer.
  const tool = await round(nebiusChunks({ thinking: "I read the file.", finish: "tool_calls",
    toolCalls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/a\"}" } }] }));
  assert.deepEqual({ text: tool.text, thinking: tool.thinking, stop: tool.stop }, { text: "", thinking: "I read the file.", stop: "tool_calls" });
  assert.equal(tool.thinkingWithoutResponse, undefined);
  // Whitespace is no answer text: a "\n\n" before the end changes nothing about the rule.
  const empty = await round(nebiusChunks({ content: "\n\n", thinking: "ready" }));
  assert.equal(empty.thinkingWithoutResponse, true);
  assert.equal(thinkingAsResponse(empty).text, "ready");
});

// The self-report of an OpenRouter round: generation id, provider behind the router, its finish reason and the thinking tokens.
// cbase used to discard all four, and afterwards it could not be decided whether the provider had dropped a call. The form
// (fields on the chunk, `native_finish_reason` on the choice, thinking tokens under `completion_tokens_details`) is the
// documented one of the OpenRouter chat API.
test("openai-chat: thinking only at OpenRouter — the round reports generation id, provider, native finish reason and thinking tokens", async () => {
  const conn = presetConn("openai-chat");
  const header = { id: "gen-1790406-abc", provider: "Z.AI", model: "z-ai/glm-5.3-flash", object: "chat.completion.chunk" };
  const r = await withResponse(() => sse([
    { ...header, choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning: "I'll attempt the stop call." }, finish_reason: null, native_finish_reason: null }] },
    { ...header, choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop", native_finish_reason: "stop" }] },
    { ...header, choices: [], usage: { prompt_tokens: 25510, completion_tokens: 205, prompt_tokens_details: { cached_tokens: 19691 }, completion_tokens_details: { reasoning_tokens: 180 } } },
  ]), () => conn.complete({ messages: [{ role: "user", content: "stop the workflows" }], model: "m1" }));
  assert.equal(r.thinkingWithoutResponse, true);
  assert.deepEqual(r.diagnostic, { id: "gen-1790406-abc", provider: "Z.AI", native_finish_reason: "stop", reasoning_tokens: 180 });
  assert.deepEqual(r.usage, { input: 25510, output: 205, cached: 19691 });
});

// The provider behind the router in EVERY round that names it — not only next to "thinking only": the engine puts it on
// message_start (`message.provider`, contract.js), runs/do-run.js shows it with ITS window in the context bar. Without
// `provider` on the chunk the field is absent altogether (the engine's event then stays identical). Sabotage: the return line
// `provider` removed => `undefined !== 'DeepInfra'`.
test("openai-chat: every round reports the provider behind the router when the response names it — without a mention the field is absent", async () => {
  const conn = presetConn("openrouter");
  const header = { id: "gen-1790407-def", provider: "DeepInfra", model: "z-ai/glm-5.3-flash", object: "chat.completion.chunk" };
  const r = await withResponse(() => sse([
    { ...header, choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }] },
    { ...header, choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "stop" }] },
    { ...header, choices: [], usage: { prompt_tokens: 26000, completion_tokens: 1 } },
  ]), () => conn.complete({ messages: [{ role: "user", content: "hi" }], model: "m1" }));
  assert.equal(r.provider, "DeepInfra");
  assert.equal(r.text, "ready");
  assert.equal(r.thinkingWithoutResponse, undefined, "no \"thinking only\" — the diagnostic stays where it was");
  assert.equal("diagnostic" in r, false);
  const without = await withResponse(() => sse(nebiusChunks({ content: "ready" })),
    () => conn.complete({ messages: [{ role: "user", content: "hi" }], model: "m1" }));
  assert.equal("provider" in without, false, "without `provider` on the chunk no field");
});

// The window of the provider that delivered a response (`providerWindow`, providers/openrouter-endpoints.js): from
// `GET <base>/models/<id>/endpoints` with the provider's key, the name case-insensitive, active endpoints before disturbed ones,
// several numbers => the smallest; an unknown name => 0; an alias asks its target (from the catalog, `alias_target.slug`); a
// failed retrieval THROWS (do-run.js catches it and names the provider without a window).
test("openai-chat providerWindow: the window of the named provider from the endpoints — active before disturbed, the smallest number, unknown => 0, alias => target", async () => {
  const conn = presetConn("openrouter");
  const orig = globalThis.fetch;
  const retrievals = [];
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init) => {
    const u = decodeURIComponent(String(url));
    retrievals.push({ u, auth: init?.headers?.Authorization || "" });
    if (u === "https://example.test/v1/models") return response({ data: [{ id: "~w/alias-latest", alias_target: { slug: "w/target" } }] });
    const t = u.match(/\/models\/(.+)\/endpoints$/);
    if (t?.[1] === "w/window") return response({ data: { endpoints: [
      { provider_name: "DeepInfra", context_length: 1048576, status: 0 },
      { provider_name: "Reka", context_length: 262144, status: 0 },
      { provider_name: "BaseTen", context_length: 1048576, status: 0 },
      { provider_name: "BaseTen", context_length: 524288, status: 0 },
      { provider_name: "Inceptron", context_length: 1048576, status: -2 },
      { provider_name: "Inceptron", context_length: 131072, status: 0 },
      { provider_name: "Degraded", context_length: 200000, status: -5 },
    ] } });
    if (t?.[1] === "w/target") return response({ data: { endpoints: [{ provider_name: "Z.AI", context_length: 1048576, status: 0 }] } });
    if (t?.[1] === "~w/alias-latest") return response({ data: { endpoints: [] } });
    if (t?.[1] === "w/broken") return response({ error: "broken" }, 500);
    return response({}, 404);
  };
  try {
    assert.equal(await conn.providerWindow("w/window", "DeepInfra"), 1048576);
    assert.equal(await conn.providerWindow("w/window", "reka"), 262144, "case does not matter");
    assert.equal(await conn.providerWindow("w/window", "BaseTen"), 524288, "two numbers => the smallest");
    assert.equal(await conn.providerWindow("w/window", "Inceptron"), 131072, "active before disturbed");
    assert.equal(await conn.providerWindow("w/window", "Degraded"), 200000, "only disturbed => their number");
    assert.equal(await conn.providerWindow("w/window", "Unknown"), 0);
    assert.equal(await conn.providerWindow("w/window", ""), 0);
    assert.equal(retrievals.filter((a) => a.u.endsWith("/w/window/endpoints")).length, 1, "cached for 1 h");
    assert.ok(retrievals.every((a) => a.auth === "Bearer sk-test"), "with the provider's key");
    assert.equal(await conn.providerWindow("~w/alias-latest", "Z.AI"), 1048576, "an alias asks its target");
    await assert.rejects(conn.providerWindow("w/broken", "DeepInfra"), /HTTP 500/);
  } finally { globalThis.fetch = orig; }
});

test("openai-chat runOnce: the same rule for the one-shot (message.reasoning_content, content null)", async () => {
  const conn = presetConn("openai-chat");
  const json = (message, finish_reason = "stop") => () => new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason }] }),
    { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await withResponse(json({ role: "assistant", content: null, reasoning_content: "ready" }), () => conn.runOnce("Answer with: ready", { model: "m1" })), "ready");
  assert.equal(await withResponse(json({ role: "assistant", content: "yes", reasoning_content: "I think." }), () => conn.runOnce("hi", { model: "m1" })), "yes");
  assert.equal(await withResponse(json({ role: "assistant", content: null, reasoning_content: "Zuerst" }, "length"), () => conn.runOnce("hi", { model: "m1" })), "");
});

// ── The start of a tool call in the stream ────────────────────────────────────────────────────
//
// With GLM-5.3-flash at OpenRouter (loop engine), after "I'm starting a test workflow …" NOTHING appeared for several seconds —
// the cbase_dynamic_workflow call (3,848 characters of script) streamed its arguments for 32 s, and the connectors collected
// them silently. The Claude CLI reports the same call with `content_block_start` as soon as it begins. The contract:
// `onDelta({ toolStart: { id, name } })`, ONCE per call, as soon as id and name are in the stream, with the id of the final form —
// and not at all without an id in the stream (the final form then assigns its own).
//
// The gate: the fake endpoint delivers chunk by chunk only what the connector reads (`highWaterMark: 0` — the next one is
// pulled only when the previous one is processed), and behind the first call chunk only continues when the start has been
// reported. If it did not come, the stream aborts with an error — red instead of hanging, no clock.
// Sabotage: the three connectors without the start report => the three tests with a gate fail at the gate ("Gate: ... no
// toolStart"), the three without an id stay green (they hold the opposite).
function gateStream(sseLines, { gateAfter = Infinity, seen = () => true } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
if (i > gateAfter && !seen()) { c.error(new Error(`Gate: after chunk ${gateAfter} no toolStart came — the connector collects the call silently`)); return; }
      if (i >= sseLines.length) { c.close(); return; }
      c.enqueue(enc.encode(sseLines[i++]));
    },
  }, { highWaterMark: 0 });
  return { stream, supplied: () => i };
}
const asSse = (objects, end = "") => [...objects.map((o) => `data: ${JSON.stringify(o)}\n\n`), ...(end ? [end] : [])];
// A round against the gate stream: `gateAfter` is the index of the FIRST call chunk. Returns the round, the deltas and, for
// each start, how many chunks had been delivered by then.
async function gateRound(conn, sseLines, gateAfter = Infinity) {
  const deltas = [];
  const starts = [];
  let t = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    t = gateStream(sseLines, { gateAfter, seen: () => starts.length > 0 });
    return { ok: true, status: 200, statusText: "OK", body: t.stream, text: async () => "" };
  };
  try {
    const r = await conn.complete({
messages: [{ role: "user", content: "start a test workflow" }], model: "m1",
      tools: [{ name: "mcp__cbase__cbase_dynamic_workflow", inputSchema: { type: "object" } }, { name: "Read", inputSchema: { type: "object" } }],
      onDelta: (d) => { deltas.push(d); if (d.toolStart) starts.push({ ...d.toolStart, afterChunks: t.supplied() }); },
    });
    return { r, deltas, starts, total: sseLines.length };
  } finally { globalThis.fetch = orig; }
}
const WF = "mcp__cbase__cbase_dynamic_workflow";

test("toolStart openai-chat/openrouter: once per call, before the rest of the stream, with the id of the final form — also when id and name come in different chunks", async () => {
  for (const preset of ["openai-chat", "openrouter"]) {
    const header = { id: "gen-1", provider: "Z.AI", object: "chat.completion.chunk" };
    const rows = asSse([
      { ...header, choices: [{ index: 0, delta: { role: "assistant", content: "I am starting a test workflow." } }] },
      // OpenRouter repeats the id in every chunk of a call — it stays one start anyway.
      { ...header, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_wf", type: "function", function: { name: WF, arguments: "" } }] } }] },
      { ...header, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_wf", function: { arguments: "{\"script\":\"" } }] } }] },
      { ...header, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "export default 1\"}" } }] } }] },
      // The second call names only the name first, the id comes one chunk later: reported as soon as BOTH are there.
      { ...header, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, type: "function", function: { name: "Read", arguments: "" } }] } }] },
      { ...header, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_read", function: { arguments: "{\"file_path\":\"/a\"}" } }] } }] },
      { ...header, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { ...header, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ], "data: [DONE]\n\n");
    const { r, deltas, starts, total } = await gateRound(presetConn(preset), rows, 1);
    assert.deepEqual(starts.map(({ id, name }) => ({ id, name })), [{ id: "call_wf", name: WF }, { id: "call_read", name: "Read" }], `${preset}: exactly one start per call`);
    assert.equal(starts[0].afterChunks, 2, `${preset}: the start came right after the first call chunk`);
    assert.equal(starts[1].afterChunks, 6, `${preset}: the second start came as soon as the id was there`);
    assert.ok(starts.every((s) => s.afterChunks < total), `${preset}: every start came before the end of the round`);
    assert.deepEqual(r.toolCalls.map((c) => c.id), starts.map((s) => s.id), `${preset}: the final form carries the ids of the starts`);
    assert.deepEqual(r.toolCalls[0].input, { script: "export default 1" });
    assert.equal(r.stop, "tool_calls");
    // The text came earlier and unchanged; the deltas are exactly text + two starts.
    assert.deepEqual(deltas.map((d) => Object.keys(d)[0]), ["text", "toolStart", "toolStart"], `${preset}: ${JSON.stringify(deltas)}`);
  }
});

test("toolStart openai-chat: without an id in the stream NO early start — the final form assigns call_<i>", async () => {
  const rows = asSse([
    { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/a\"}" } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ], "data: [DONE]\n\n");
  const { r, starts } = await gateRound(presetConn("openai-chat"), rows);
  assert.deepEqual(starts, [], "a start with an id other than the final form's would give a second row");
  assert.deepEqual(r.toolCalls.map((c) => c.id), ["call_0"]);
});
