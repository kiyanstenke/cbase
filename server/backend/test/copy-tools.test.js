// Guard for the copy tools, the "tools" part of the copies' tools/REST/fence/visibility (project container stage 2).
//
// THE FOUR TOOLS (cbase_copy_stack, _list, _fetch, _remove) call the copies' REST routes through the fence. Who SEES them is a matter of the
// MCP server (description side = execution side): the instance marker (`CBASE_INSTANCE`, toolchain/mcp-config.js) switches them, not the
// chat and not the project.
//
// The promises, each with the way that breaks it:
//   (1) Visibility on the REAL MCP process (tools/list): without a marker none of the four — not even with an explicit list, not as a
//       subagent of any depth (a chat of a project that is not relocated); in the main all four, also for a subagent of any depth; in a copy
//       without `cbase_copy_stack`; an agent of a dynamic workflow only `_list`, in the main as in the copy; the named set none; a called
//       but not offered name is an error.
//   (1b) The server's sets (runs/agent-set.js): the full set and a subagent's carry all four names, a workflow agent's only `_list` (the
//       MCP server's lock is computed from the same table).
//   (1c) writeMcpConfig writes the marker only with an instance — without one `CBASE_INSTANCE` is absent (golden runs byte-equal).
//   (1d) The wake call (stacks/inset.js moveInWakeText) and the copy paragraph of the system prompt (runs/system-prompt.js) name only tools
//        the turn sees afterwards: on "ready" (the turn runs IN the copy) _fetch and _remove, never the create; on "error" (the turn runs in
//        the main) first clearing away the failed copy, then the create (the `error` row occupies the chat's name, a create alone ended with
//        409 — the path itself: stacks-routes.test.js (7)).
//   (1e) The content of the copy paragraph: one anchor per sentence (code state with reflogs, index, stashes, AFTER the creation, EXDEV, git
//        add -A; branch space copy/<name>/<branch>; real targets), bound to the sentences of the tool result (stacks/result.js SET).
//   (2) Create from the main on the real server (real queue on the fake docker, the build held): the response names the state `build`, the
//       hint (end the turn, on "ready" cbase wakes) and the row; an invalid name and an invalid base are errors of the route and create
//       nothing; the second call of the same chat creates a FURTHER copy — it waits behind the first; the error of a waiting request is a
//       waiting state with its reason (`waiting_queue` with the name of the other copy in the build).
//   (2d) `baseInstance` of the tool arrives at the route — a ready copy (also a foreign chat's) becomes the template, the row carries it; an
//        unknown and an invalid instance are errors of THIS call with the route's sentence, without a row; an empty text, `null` and a field
//        the tool does not know give the default main.
//   (3) List, fetch and clear away on the real server: `thisChat` distinguishes the own copy; fetch puts the copy's commits under
//       `copy/<name>/…` into the main and is repeatable, an unknown name is the route's error (404); clearing away takes the copy (with a
//       backup), `all` shows it afterwards as removed. The agent IN the copy fetches itself.
//   (3b) The hint of cbase_copy_stack_remove depends on the copy: one NEVER built (`error`, never ready) is only dismantled — "never built …
//        nothing to fetch or save", never "first fetched and saved" —, and cleared away by the same condition (stacks/inset.js neverBuilt,
//        the route calls it `neverBuilt`): the instance row gone, no branch copy/k1/… in the main. The opposite case (work was done in the
//        copy) stands in (3).
//   (3c) A WAITING request is discarded by the call at once — the route calls it `discarded` (stacks/inset.js waitingStill), `neverBuilt`
//        stays false, and the hint says "discarded … nothing to fetch or save … no message any more", never "fetched and saved" or "system
//        message"; exactly one silent hint, no wake call.
//
// No clock: queue and build run as in stacks-creation.test.js over gates and states (waitForTruthy, without a deadline); the held build hangs
// on a promise the test resolves in finally. Every MCP process (withMcp) is ended in its finally.
//
// Counter-tests (which sabotage turns which test red):
//   mcp/visibility.js lockedForInstance does not lock the create in the copy         => (1) (1a) (3) red
//   mcp/visibility.js lockedForInstance: without a marker nothing locked              => (1) (1a) red
//   toolchain/mcp-config.js writeMcpConfig writes `CBASE_INSTANCE` also without instance => (1c) red
//   stacks/inset.js the wake call recommends the create instead of `_remove`          => (1d) red
//   stacks/request.js an invalid name is not checked                                  => (2) red
//   runs/system-prompt.js copy paragraph without COPY_REAL_TARGETS / without COPY_STATUS => (1e) red
//   the sources before the never-built distinction (stacks inset, remove, clear away, routes; mcp/tools/stacks) => (3) (3b) red
//   stacks/routes.js the response always carries `neverBuilt: false`                  => (3b) red
//   mcp/tools/stacks.js clearingHint always picks the sentence "first fetched and saved" => (3b) red
//   mcp/tools/stacks.js clearingHint without the `discarded` case                     => (3c) red ("system message")
//   stacks/routes.js the response without `discarded`                                 => (3c) red
//   mcp/tools/stacks.js the description of clearing away without "discarded at once"  => (3c) red
//   mcp/tools/stacks.js the description without "this call answers at once with an error" => (2) red
//   stacks/request.js without the call of baseInMain (a request arises)               => (2) red
//   mcp/tools/stacks.js the description with "no reflog specifications (`@{…}`)"      => (2) red
//   mcp/tools/stacks.js the handler does not pass `baseInstance` on                   => (2) red (the unknown template "copy-away" creates a copy from main)
//   mcp/tools/stacks.js the handler passes the text untrimmed (also empty)            => (2) red (400 BASE_INSTANCE_INVALID for " copy-k1 ")
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { CATALOG_NAMES, TOOLS } from "../electron/mcp/catalog.js";
import { COPY_TOOLS, ONLY_OUTER_LOOP, lockedForInstance } from "../electron/mcp/visibility.js";
import { agentToolset, workflowAgentSet } from "../electron/server/runs/agent-set.js";
import { projectFocusPrompt } from "../electron/server/runs/system-prompt.js";
import { tokenFor } from "../electron/server/projectbox/token.js";
import { moveInWakeText, newAttemptSet } from "../electron/server/stacks/inset.js";
import { SET } from "../electron/server/stacks/result.js";
import { REF_SPACE, nameError } from "../electron/server/stacks/names.js";
import { setCopyProcedure, buildAlive } from "../electron/server/stacks/queue.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { withMcp } from "./server-harness.mjs";
import { buildCopy, gitCopy, situationDefault, withCopy, refs, writeInCopy } from "./stacks-copy-harness.mjs";

const CREATE = "cbase_copy_stack";
const INSTANCE_MAIN = "0123456789abcdef0123456789abcdef/main";
const INSTANCE_COPY = "0123456789abcdef0123456789abcdef/copy-k1";
// The full set of a coding chat is the whole catalog.
const FULL_SET = [...CATALOG_NAMES];
// The group of the instance tools (COPY_TOOLS, with cbase_switch_instance) — no longer just the prefix.
const copyNames = (names) => names.filter((n) => COPY_TOOLS.includes(n)).sort();
// The description of a tool from the catalog — a missing one THROWS (an anchor that finds nothing is no green case).
const description = (name) => {
  const d = TOOLS.find((t) => t.name === name)?.description;
  if (typeof d !== "string" || !d) throw new Error(`${name}: no description in the catalog`);
  return d;
};
const ALL_FOUR = [...COPY_TOOLS].sort();
const WITHOUT_CREATE = ALL_FOUR.filter((n) => n !== CREATE);

// ── (1) Visibility on the real MCP process ──────────────────────────────────────────────────
// The environment of a run: inherit nothing from the user that changes the cut.
const BASE = { CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, CBASE_SCHEMA: undefined, CBASE_WORKFLOW_AGENT: undefined, CBASE_INSTANCE: undefined };
async function offered(env) {
  let names = [];
  await withMcp({ ...BASE, ...env }, async ({ listTools }) => { names = await listTools(); });
  return names;
}

test("(1) visibility: without a marker none of the four, in the main all, in the copy without the create — also as a subagent and with an explicit list", async () => {
  const full = JSON.stringify(FULL_SET);
  // A chat of a project that is NOT relocated: no marker => none of the four, with and without a list, at every depth.
  assert.deepEqual(copyNames(await offered({})), [], "main agent without a marker");
  assert.deepEqual(copyNames(await offered({ CBASE_TOOLS: full })), [], "explicit list without a marker (subagent of a project that is not relocated)");
  for (const depth of ["1", "2", "3"]) assert.deepEqual(copyNames(await offered({ CBASE_TOOLS: full, CBASE_AGENT_DEPTH: depth })), [], `subagent depth ${depth} without a marker`);
  assert.deepEqual(copyNames(await offered({ CBASE_TOOLS: JSON.stringify([CREATE, "cbase_copy_stack_list"]) })), [], "a list that NAMES them changes nothing without a marker");
  // In the main of a relocated project: all four — the main agent, a subagent of any depth, the explicit list.
  assert.deepEqual(copyNames(await offered({ CBASE_INSTANCE: INSTANCE_MAIN })), ALL_FOUR, "main agent in the main");
  for (const depth of ["1", "2", "3"]) assert.deepEqual(copyNames(await offered({ CBASE_INSTANCE: INSTANCE_MAIN, CBASE_TOOLS: full, CBASE_AGENT_DEPTH: depth })), ALL_FOUR, `subagent depth ${depth} in the main`);
  assert.deepEqual(copyNames(await offered({ CBASE_INSTANCE: INSTANCE_MAIN, CBASE_TOOLS: JSON.stringify(["cbase_copy_stack_list"]) })), ["cbase_copy_stack_list"], "the list still cuts");
  // In a copy: never the create — for the main agent, the subagent and the list.
  assert.deepEqual(copyNames(await offered({ CBASE_INSTANCE: INSTANCE_COPY })), WITHOUT_CREATE, "main agent in the copy");
  assert.deepEqual(copyNames(await offered({ CBASE_INSTANCE: INSTANCE_COPY, CBASE_TOOLS: full, CBASE_AGENT_DEPTH: "2" })), WITHOUT_CREATE, "subagent in the copy");
  assert.deepEqual(copyNames(await offered({ CBASE_INSTANCE: INSTANCE_COPY, CBASE_TOOLS: JSON.stringify([CREATE]) })), [], "the create is absent even if the list names it");
  // An agent of a dynamic workflow: only `_list` — in the main as in the copy, with and without a list.
  for (const instance of [INSTANCE_MAIN, INSTANCE_COPY]) {
    assert.deepEqual(copyNames(await offered({ CBASE_INSTANCE: instance, CBASE_WORKFLOW_AGENT: "agent-1" })), ["cbase_copy_stack_list"], `Workflow-Agent in ${instance}`);
    assert.deepEqual(copyNames(await offered({ CBASE_INSTANCE: instance, CBASE_WORKFLOW_AGENT: "agent-1", CBASE_TOOLS: full })), ["cbase_copy_stack_list"], `workflow agent with a list in ${instance}`);
  }
  assert.deepEqual(copyNames(await offered({ CBASE_WORKFLOW_AGENT: "agent-1" })), [], "workflow agent without a marker");
});

test("(1a) A called but not offered name is an error: the create in the copy, every tool without a marker, three in the workflow agent", async () => {
  const error = async (env, name, args = {}) => {
    let r;
    await withMcp({ ...BASE, ...env }, async ({ call }) => { r = await call(name, args); });
    return r;
  };
  for (const [env, name] of [
    [{ CBASE_INSTANCE: INSTANCE_COPY }, CREATE],
    [{}, CREATE], [{}, "cbase_copy_stack_list"], [{}, "cbase_copy_stack_fetch"], [{}, "cbase_copy_stack_remove"],
    [{ CBASE_INSTANCE: INSTANCE_MAIN, CBASE_WORKFLOW_AGENT: "a" }, CREATE], [{ CBASE_INSTANCE: INSTANCE_MAIN, CBASE_WORKFLOW_AGENT: "a" }, "cbase_copy_stack_fetch"],
    [{ CBASE_INSTANCE: INSTANCE_MAIN, CBASE_WORKFLOW_AGENT: "a" }, "cbase_copy_stack_remove"],
  ]) {
    const r = await error(env, name, { name: "k1" });
    assert.equal(r.isError, true, `${name} with ${JSON.stringify(env)}: ${r.text}`);
    assert.match(r.text, /^Unknown tool: cbase_copy_stack/, `${name}: ${r.text}`);
  }
});

test("(1b) The server's sets: full and subagent carry all four names, the workflow agent only _list (runs/agent-set.js)", () => {
  for (const n of COPY_TOOLS) {
    assert.ok(FULL_SET.includes(n), `${n} is missing in the full set`);
  }
  // Behind them stand the outer-loop group (cbase_chat_analyse, only with a marker), the agenda group (cbase_agenda, cbase_agenda_write,
  // cbase_agenda_maintain), the skill group (cbase_skill_write) and the timeline
  // (cbase_timeline, cbase_timeline_write, only with a marker) — named in mcp-catalog.test.js.
  assert.deepEqual(CATALOG_NAMES.slice(-(COPY_TOOLS.length + 7), -7), [...COPY_TOOLS], "the four stand before the outer-loop, agenda, skill and timeline groups (cache prefix)");
  assert.deepEqual(CATALOG_NAMES.slice(-7, -6), [...ONLY_OUTER_LOOP]);
  assert.deepEqual(CATALOG_NAMES.slice(-6, -3), ["cbase_agenda", "cbase_agenda_write", "cbase_agenda_maintain"]);
  assert.deepEqual(CATALOG_NAMES.slice(-3, -2), ["cbase_skill_write"]);
  assert.deepEqual(CATALOG_NAMES.slice(-2), ["cbase_timeline", "cbase_timeline_write"]);
  for (const depth of [1, 2, 3]) {
    const s = agentToolset({ parent: { cbase: FULL_SET, builtin: null }, depth });
    assert.deepEqual(copyNames(s.cbase), ALL_FOUR, `subagent depth ${depth}`);
  }
  assert.deepEqual(copyNames(agentToolset({ parent: { cbase: null, builtin: null }, required: ["mcp__cbase__cbase_copy_stack_remove", "Read"], depth: 1 }).cbase), ["cbase_copy_stack_remove"], "a required list cuts");
  const w = workflowAgentSet({ parent: { cbase: FULL_SET, builtin: null } });
  assert.deepEqual(copyNames(w.cbase), ["cbase_copy_stack_list"]);
});

test("(1c) writeMcpConfig writes the marker CBASE_INSTANCE only with an instance — without one it is absent", async () => {
  // writeMcpConfig needs the state of a running server (folder, settings) — so inside the test's server.
  await withAgentsServer(async (ctx) => {
    const read = (name, options) => {
      const file = path.join(ctx.root, name);
      writeMcpConfig(file, { projectId: "p", workspaceId: "w", chatId: "c", ...options });
      return JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.cbase.env;
    };
    assert.equal("CBASE_INSTANCE" in read("without.json", {}), false, "no marker without an instance");
    assert.equal(read("main.json", { instance: INSTANCE_MAIN }).CBASE_INSTANCE, INSTANCE_MAIN);
    assert.equal(read("copy.json", { instance: INSTANCE_COPY }).CBASE_INSTANCE, INSTANCE_COPY);
  });
});

test("(1d) The wake call names only tools the turn SEES afterwards: on \"ready\" (the turn runs IN the copy) _fetch and _remove, never the create; on \"error\" (the turn runs in the main) _remove and the create", () => {
  const k = { projectId: "0123456789abcdef0123456789abcdef", name: "k1", result: null, error: "no space" };
  const names = (t) => [...new Set(t.match(/cbase_copy_stack\w*/g) || [])].sort();
  const ready = moveInWakeText(k, "ready");
  assert.deepEqual(names(ready), ["cbase_copy_stack_fetch", "cbase_copy_stack_remove"], "the wake call into the copy names fetch and clear away, not the create");
  for (const n of names(ready)) {
    assert.ok(CATALOG_NAMES.includes(n), `${n} is not in the catalog`);
    assert.equal(lockedForInstance(n, INSTANCE_COPY), false, `${n} is locked in the copy, the wake call recommends it there`);
  }
  // Likewise the copy paragraph in the system prompt of a chat IN the copy (runs/system-prompt.js copyParagraph).
  const paragraph = projectFocusPrompt({ id: "p", name: "p", path: "/p" }, { converted: true, copy: { name: "k1" } });
  assert.deepEqual(names(paragraph), ["cbase_copy_stack_fetch", "cbase_copy_stack_remove"], "the copy paragraph names fetch and clear away, not the create");
  for (const n of names(paragraph)) assert.equal(lockedForInstance(n, INSTANCE_COPY), false, `${n} is locked in the copy, the copy paragraph recommends it there`);
  // The copy belongs to no chat any more — the paragraph says so and names the way back.
  assert.ok(paragraph.includes("belongs to no chat"), "the copy paragraph still promises that the copy lives as long as the chat");
  assert.ok(paragraph.includes("cbase_switch_instance") && CATALOG_NAMES.includes("cbase_switch_instance"), "the copy paragraph does not name the switch");
  assert.equal(lockedForInstance("cbase_switch_instance", INSTANCE_COPY), false, "cbase_switch_instance is locked in the copy");
  // "error": the turn runs in the main. The new attempt ALWAYS goes directly with the create (a further copy); the sentence also names
  // cbase_copy_stack_remove — cleanly failed, to release the name; with leftovers, to clear them away.
  const error = moveInWakeText(k, "error");
  assert.deepEqual(names(error), [CREATE, "cbase_copy_stack_remove"], "the wake call after a cleanly failed build names the create and releasing the name");
  assert.match(error, /cbase_copy_stack_remove with name "k1" releases the name\. A new attempt goes directly with cbase_copy_stack at any time/);
  const rest = newAttemptSet(k, { worked: false, instance: { state: "error" }, job: null, procedure: false });
  assert.deepEqual(names(rest), [CREATE, "cbase_copy_stack_remove"], "with leftovers the sentence names clearing away and the create");
  assert.match(rest, /cbase_copy_stack_remove with name "k1" removes the leftovers\. A new attempt goes directly with cbase_copy_stack at any time/, "the new attempt does not depend on clearing away");
  for (const n of new Set([...names(error), ...names(rest)])) {
    assert.ok(CATALOG_NAMES.includes(n), `${n} is not in the catalog`);
    assert.equal(lockedForInstance(n, INSTANCE_MAIN), false, `${n} is locked in the main, the wake call recommends it there`);
  }
});

// ── The tools on the real server ──────────────────────────────────────────────────────────────────────────────────────────
async function chatInProject(ctx, pid, title) {
  const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, projectId: pid, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return c;
}
// The environment of an MCP run in an instance of the project (what writeMcpConfig would write): address, token, chat, project, marker.
function runEnvironment(ctx, pid, instance, chatId) {
  const row = store.projectInstance(pid, instance);
  assert.ok(row, `instance ${instance} of the project exists`);
  return { ...BASE, CBASE_BASE_URL: ctx.base, CBASE_TOKEN: tokenFor(row), CBASE_CHAT_ID: chatId, CBASE_PROJECT_ID: pid, CBASE_WORKSPACE_ID: ctx.ws.id, CBASE_INSTANCE: `${pid}/${instance}` };
}

test("(1e) The copy paragraph of the system prompt carries its anchor per sentence — code state, branch space, real targets — and the same sentences as the tool result (stacks/result.js SET)", () => {
  const paragraph = projectFocusPrompt({ id: "p", name: "p", path: "/p" }, { converted: true, copy: { name: "k1" } });
  const section = paragraph.slice(paragraph.indexOf("# Your copy"));
  assert.ok(paragraph.includes("# Your copy"), "the paragraph is missing");
  // Anchors that also stand in the tool result's sentence: an anchor missing there throws (the test never checks against emptiness).
  const bound = [
    [SET.reflogs, "reflogs"], [SET.index, "index state"],
    [SET.translucent, "AFTER the creation"], [SET.translucent, "EXDEV"], [SET.translucent, "git add -A"], [SET.translucent, "git status"],
  ];
  for (const [set, anchor] of bound) {
    assert.ok(set.includes(anchor), `the anchor "${anchor}" no longer stands in the tool result's sentence`);
    assert.ok(section.includes(anchor), `the copy paragraph does not carry the anchor "${anchor}"`);
  }
  assert.ok(section.includes("stashes"), "the copy paragraph does not say that stashes did not come along");
  // Branch space: the copy's fetch path, bound to SET.branchSpace.
  const fetch = `${REF_SPACE}/k1/<branch>`;
  assert.ok(SET.branchSpace("k1").includes(fetch), "SET.branchSpace no longer names the fetch path that way");
  assert.ok(section.includes(fetch), `the copy paragraph does not name the fetch path ${fetch}`);
  assert.ok(!section.includes("main/<branch>"), "the copy paragraph names a wrong fetch path");
  // Real targets (the paragraph words it for the agent, the core: the same as in the main).
  assert.ok(SET.realTargets.includes("the same account as the main instance"), "SET.realTargets lost its core");
  for (const anchor of ["External targets are the real ones in the copy too", "the same as in the main instance"]) {
    assert.ok(section.includes(anchor), `the copy paragraph does not carry the anchor "${anchor}"`);
  }
  // Stable per copy (prompt cache): the same name, the same text.
  assert.equal(projectFocusPrompt({ id: "p", name: "p", path: "/p" }, { converted: true, copy: { name: "k1" } }), paragraph);
});
test("(2) Create from the main: the response names build and the hint; the route checks name and base; the chat's second call creates a further copy; the waiting state carries its reason", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    // k1 lives (ready, a foreign chat) — the list's row; the main's chat cH creates k2.
    await buildCopy(b);
    const cH = await chatInProject(ctx, pid, "Main chat");
    // The build hangs on a gate: the request begins (`build`), but ends only when the test wants it.
    let gate; const open = new Promise((r) => { gate = r; });
    let begun; const begunWait = new Promise((r) => { begun = r; });
    setCopyProcedure(async () => { begun(); await open; throw new Error("test end (held build)"); });
    try {
      await withMcp(runEnvironment(ctx, pid, "main", cH.id), async ({ call }) => {
        // An invalid name and an invalid base are errors of the route (400) — they create nothing.
        let r = await call(CREATE, { name: "Invalid!" });
        assert.equal(r.isError, true, r.text);
        assert.match(r.text, /1–24 Zeichen/);
        r = await call(CREATE, { base: 42 });
        assert.equal(r.isError, true, r.text);
        // A base that no repo of the main knows is an error of this call AT ONCE — as the description says.
        r = await call(CREATE, { base: "exists-not-e2e" });
        assert.equal(r.isError, true, r.text);
        assert.match(r.text, /kein Repo der Kopie kennt diesen Commit/, r.text);
        assert.match(description(CREATE), /THIS call answers at once with an error, and no request is created/);
        // `@{u}`, `@{upstream}`, `@{push}` are accepted by the route (stacks-routes.test.js (8)) — the rule does not exclude them with
        // "no reflog specifications (`@{…}`)", and the description names the caveat of relative refs.
        // The ref rules stand in the route's ERROR (stacks/request.js (main-only check)), which comes exactly when one applies — the
        // description says that it names the rule.
        r = await call(CREATE, { base: "main@{1}" });
        assert.equal(r.isError, true, r.text);
        assert.match(r.text, /\(`@\{u\}`, `@\{upstream\}` und `@\{push\}` gehen\)/, r.text);
        assert.match(description(CREATE), /the error names the rule, also for refs that never exist in a copy/);
        assert.doesNotMatch(description(CREATE), /\(`@\{…\}`\)/);
        assert.match(description(CREATE), /relative ref like `HEAD~2` in the project folder/);
        assert.equal(store.stackCopiesOf(pid).filter((k) => k.chatId === cH.id).length, 0, "an error of the route created a row");

        r = await call(CREATE, { name: "k2", base: { app: "feature" } });
        assert.equal(r.isError, false, r.text);
        await begunWait; // the build runs — the route's answer came after the queue pass
        assert.equal(r.data.copy.name, "k2");
        assert.equal(r.data.copy.chatId, cH.id, "the creator is the caller's chat");
        assert.equal(r.data.copy.inset, true, "the tool creates with inset");
        assert.equal(r.data.copy.state, "build", JSON.stringify(r.data.copy));
        assert.match(r.data.hint, /The copy is being built/);
        assert.match(r.data.hint, /End your turn now/);
        assert.match(r.data.hint, /cbase wakes this chat/);
        assert.match(r.data.hint, /If the build fails/);
        assert.equal("journal" in r.data.copy, false, "the journal is mechanics of the procedure and does not go out");

        // The second call of the same chat creates a further copy — it waits behind k2.
        r = await call(CREATE, { name: "k3" });
        assert.equal(r.isError, false, r.text);
        assert.deepEqual([r.data.copy.name, r.data.copy.chatId, r.data.copy.state], ["k3", cH.id, "waiting_queue"], JSON.stringify(r.data.copy));
        assert.match(r.data.copy.reason, /k2/, "the reason names the copy in the build");

        // The list sees the own copies (thisChat) and the foreign one; the journal is absent there too.
        r = await call("cbase_copy_stack_list");
        assert.deepEqual(r.data.instances.slice(1).map((k) => [k.name, k.thisChat, k.state]), [["k1", false, "ready"], ["k2", true, "build"], ["k3", true, "waiting_queue"]]);
        assert.ok(r.data.instances.every((k) => !("journal" in k)));
        // Without `baseInstance` they arise from the main (the route's default).
        assert.deepEqual(r.data.instances.slice(1).map((k) => k.baseInstance), ["main", "main", "main"]);

        // (2d) `baseInstance` arrives at the route — a ready copy (k1, a foreign chat's) is the new one's template; an unknown and an
        // invalid instance are errors of THIS call (the route's sentence), and no row arises; an empty text does not go out (the route's
        // default: main), nor does a field the tool does not know.
        const rows = () => store.stackCopiesOf(pid).length;
        const beforeErrors = rows();
        r = await call(CREATE, { name: "k5", baseInstance: "copy-away" });
        assert.equal(r.isError, true, r.text);
        assert.match(r.text, /„away“ gibt es in Projekt|"away" does not exist in project/, r.text);
        r = await call(CREATE, { name: "k5", baseInstance: "Kopie K1" });
        assert.equal(r.isError, true, r.text);
        assert.match(r.text, /`baseInstance`: „Kopie K1“ ist keine Instanz/, r.text);
        assert.equal(rows(), beforeErrors, "an error of the template created a row");
        r = await call(CREATE, { name: "k5", baseInstance: " copy-k1 " });
        assert.equal(r.isError, false, r.text);
        assert.deepEqual([r.data.copy.name, r.data.copy.baseInstance, r.data.copy.chatId, r.data.copy.inset], ["k5", "copy-k1", cH.id, true], JSON.stringify(r.data.copy));
        assert.equal(store.liveStackCopy(pid, "k5")?.baseInstance, "copy-k1", "the row does not carry the template");
        for (const [name, args] of [["k6", { baseInstance: "" }], ["k7", { baseInstance: "   " }], ["k8", { baseInstance: null }], ["k9", { template: "copy-k1" }]]) {
          r = await call(CREATE, { name, ...args });
          assert.equal(r.isError, false, `${name}: ${r.text}`);
          assert.equal(r.data.copy.baseInstance, "main", `${name} (${JSON.stringify(args)}): without a non-empty text the default applies`);
        }
      });
      // A second request WAITS behind the build (one at a time per project): state and reason stand in the response.
      const cH2 = await chatInProject(ctx, pid, "Second main chat");
      await withMcp(runEnvironment(ctx, pid, "main", cH2.id), async ({ call }) => {
        const r = await call(CREATE, { name: "k4" });
        assert.equal(r.isError, false, r.text);
        assert.equal(r.data.copy.state, "waiting_queue", JSON.stringify(r.data.copy));
        assert.match(r.data.copy.reason, /k2/, "the reason names the copy in the build");
        assert.match(r.data.hint, /WAITING \(waiting_queue: /);
        assert.match(r.data.hint, /starts by itself/);
        assert.match(r.data.hint, /End your turn now/);
        assert.doesNotMatch(r.data.hint, /and there is enough storage/, "the storage addition only at the storage gate");
      });
    } finally {
      gate(); // the held build ends with its error; the queue takes the waiting request, the procedure throws there as well
      await waitForTruthy(() => (store.liveStackCopies(pid).some((k) => buildAlive(k)) ? null : true), "no build lives any more");
    }
  });
});

test("(3) List, fetch, clear away on the real server: thisChat, fetch to copy/<name>/…, fetch again, 404 for an unknown name, clearing away with a backup; the agent IN the copy fetches itself", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const cK = ctx.chat;
    await json(`${ctx.base}/api/chats/${cK.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    const cH = await chatInProject(ctx, pid, "Main chat");
    await buildCopy(b, { chatId: cK.id });
    const app = b.app;
    const beforeFetch = refs(app);

    // The agent IN the copy (the copy's marker): three tools, its chat is thisChat, it fetches itself.
    await withMcp(runEnvironment(ctx, pid, "copy-k1", cK.id), async ({ call, listTools }) => {
      assert.deepEqual(copyNames(await listTools()), WITHOUT_CREATE);
      let r = await call("cbase_copy_stack_list");
      assert.equal(r.isError, false, r.text);
      // ALL instances — the main first, then the copy with createdBy; this chat works in the copy (inset).
      assert.deepEqual(r.data.instances.map((k) => [k.instance, k.name ?? null, k.thisChat ?? null, k.thisChatWorksHere, k.state]),
        [["main", null, null, false, "ready"], ["copy-k1", "k1", true, true, "ready"]]);
      assert.deepEqual(r.data.instances[1].createdOf, { chatId: cK.id, title: store.getChat(cK.id).title });
      assert.ok(r.data.instances[1].result && typeof r.data.instances[1].result === "object", "a ready copy carries its result");
      writeInCopy(b, path.join(app, "fresh.txt"), "neu\n");
      gitCopy(b, app, "add", "fresh.txt");
      gitCopy(b, app, "commit", "-q", "-m", "in the copy");
      const commit = gitCopy(b, app, "rev-parse", "HEAD");
      r = await call("cbase_copy_stack_fetch", { name: "k1" });
      assert.equal(r.isError, false, r.text);
      assert.ok(r.data.result && Array.isArray(r.data.result.repos), JSON.stringify(r.data));
      assert.match(r.data.hint, /copy\/k1\/…/);
      assert.equal(refs(app)["refs/heads/copy/k1/main"], commit, "the copy's commit lies under copy/k1/main in the main");
      assert.deepEqual(Object.keys(beforeFetch), [], "before, nothing lay under copy/… in the main");
      // Repeatable: nothing new, the same refs.
      const after = refs(app);
      r = await call("cbase_copy_stack_fetch", { name: "k1" });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(refs(app), after, "fetching again changed refs");
      r = await call("cbase_copy_stack_fetch", { name: "exists-not" });
      assert.equal(r.isError, true);
      assert.match(r.text, /keine lebende Kopie „exists-not“/);
    });

    // The agent in the MAIN (the same copy of another chat): all four, thisChat false; it clears the copy away.
    await withMcp(runEnvironment(ctx, pid, "main", cH.id), async ({ call, listTools }) => {
      assert.deepEqual(copyNames(await listTools()), ALL_FOUR);
      let r = await call("cbase_copy_stack_list");
      assert.deepEqual(r.data.instances.map((k) => [k.instance, k.thisChat ?? null, k.thisChatWorksHere]), [["main", null, true], ["copy-k1", false, false]]);
      // Also a FOREIGN copy (cK created it) is fetched by the agent in the main.
      r = await call("cbase_copy_stack_fetch", { name: "k1" });
      assert.equal(r.isError, false, r.text);
      r = await call("cbase_copy_stack_remove", { name: "exists-not" });
      assert.equal(r.isError, true);
      assert.match(r.text, /keine lebende Kopie „exists-not“/);
      r = await call("cbase_copy_stack_remove", { name: "k1", retrieve: [] });
      assert.equal(r.isError, false, r.text);
      assert.match(r.data.hint, /accepted/);
      // A copy in which work was done: first fetch and save (the opposite case of a never-built one stands in (3b)).
      assert.equal(r.data.neverBuilt, false, JSON.stringify(r.data));
      assert.match(r.data.hint, /First it is fetched and saved, then removed/);
      assert.ok(r.data.job, JSON.stringify(r.data));
      // Clearing away happens in the background (fetch, save, remove): the state is waited for, never a clock.
      await waitForTruthy(() => (store.stackCopiesOf(pid).find((k) => k.name === "k1")?.state === "removed" ? true : null), "copy k1 removed");
      // The job in the journal carries the tool's trigger (stacks/remove.js TRIGGER) — not that of the REST acceptance in B.
      const job = store.stackCopiesOf(pid).find((k) => k.name === "k1").journal?.data?.trigger;
      assert.equal(job?.reason, "tool", JSON.stringify(job));
      assert.equal(job?.from?.who, "agent", JSON.stringify(job));
      // The tool names the own chat — the wake call with the result goes to it (cH), not to the creator (cK).
      assert.equal(job?.from?.chatId, cH.id, JSON.stringify(job));
      await ctx.waitForLog(cH.id, (l) => JSON.stringify(l).includes("<task-id>copy-k1</task-id>"));
      r = await call("cbase_copy_stack_list");
      assert.deepEqual(r.data.instances.map((k) => k.instance), ["main"], "the list shows only living copies (and always the main)");
      r = await call("cbase_copy_stack_list", { all: true });
      assert.deepEqual(r.data.instances.slice(1).map((k) => [k.name, k.state]), [["k1", "removed"]], "`all` shows it as removed");
      assert.ok(refs(app)["refs/heads/copy/k1/main"], "the backup lies in the main under copy/k1/…");
    });
  });
});

test("(3b) Clearing away a NEVER-built copy (`error`, never ready): the hint says \"never built\" — only the leftovers of its build, nothing to fetch or save —, not \"first fetched and saved\"; cleared away by the same condition (stacks/inset.js neverBuilt)", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const cH = await chatInProject(ctx, pid, "Main chat");
    // The build failed (pattern stacks-new-attempt.test.js `failed`): `build` creates the instance row, then `error` —
    // it still stands, a leftover. The marker of the wake call "not built" in advance: it is not the subject here.
    const k = copyRequests({ projectId: pid, name: "k1", chatId: cH.id });
    setCopyState(k.id, "build", { phase: "clone1" });
    setCopyState(k.id, "build", { phase: "prepare" });
    store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "error", at: 0 } } } });
    setCopyState(k.id, "error", { error: "prepare: a ref points to a missing object (COPY_REF_MISSING)" });
    assert.ok(store.projectInstance(pid, "copy-k1"), "the failed copy's instance row does not stand");

    await withMcp(runEnvironment(ctx, pid, "main", cH.id), async ({ call }) => {
      const r = await call("cbase_copy_stack_remove", { name: "k1" });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.neverBuilt, true, JSON.stringify(r.data));
      assert.match(r.data.hint, /accepted/);
      assert.match(r.data.hint, /never built/, r.data.hint);
      assert.match(r.data.hint, /nothing (in it )?to fetch or save/, r.data.hint);
      assert.doesNotMatch(r.data.hint, /fetched and saved/, `the hint promises fetching and saving, which do not exist for a never-built copy: ${r.data.hint}`);
    });
    // Cleared away as announced: only the dismantling (stacks/clearAway.js) — the instance row gone, no branch copy/k1/… in the main.
    await waitForTruthy(() => (store.stackCopy(k.id)?.state === "removed" ? true : null), "the never-built copy is removed");
    const e = store.stackCopy(k.id).result;
    assert.ok(e && "dismantling" in e, `it was not cleared away via the dismantling: ${JSON.stringify(e)}`);
    assert.equal(store.projectInstance(pid, "copy-k1"), null, "the rest of the instance row stayed");
    assert.deepEqual(refs(b.app), {}, "something was fetched to copy/k1/… for a never-built copy");
    await ctx.waitForQuiet();
  });
});

// A request that is still WAITING is discarded by the call at once (`removed`, never built, no wake call, only a silent hint). The tool's
// hint used to take the general sentence — "first fetched and saved … the result comes as a system message" — and the agent announced a
// message that never came. The guard goes the agent's way: create (the queue starts nothing without a procedure), then clear away —
// both through the tools on the real server.
test("(3c) Clearing away a WAITING request: `discarded`, `removed`, the hint without fetch, save and system message; exactly one silent hint, no wake call", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const cH = await chatInProject(ctx, pid, "Main chat");
    setCopyProcedure(null); // the queue starts nothing — the request stays `waiting_queue` (withCopy restores the procedure)
    await withMcp(runEnvironment(ctx, pid, "main", cH.id), async ({ call }) => {
      let r = await call(CREATE, { name: "k1" });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.copy.state, "waiting_queue", JSON.stringify(r.data.copy));
      assert.deepEqual(store.openHints(cH.id), [], "a hint already existed before clearing away");
      r = await call("cbase_copy_stack_remove", { name: "k1" });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.dismissed, true, JSON.stringify(r.data));
      assert.equal(r.data.neverBuilt, false, "a waiting request is not \"never built\" (that means leftovers of a build)");
      assert.equal(r.data.copy.state, "removed", JSON.stringify(r.data.copy));
      assert.match(r.data.hint, /dismissed/, r.data.hint);
      assert.match(r.data.hint, /nothing (in it )?to fetch or save/, r.data.hint);
      assert.match(r.data.hint, /no message will follow/, r.data.hint);
      assert.doesNotMatch(r.data.hint, /system message/, `the hint announces a system message that never comes: ${r.data.hint}`);
      assert.doesNotMatch(r.data.hint, /fetched and saved/, `the hint promises fetching and saving: ${r.data.hint}`);
      // The request was THIS chat's: it works in the main, where the create is offered.
      assert.match(r.data.hint, /This chat keeps working in the main; a new copy goes with cbase_copy_stack\./, r.data.hint);
      assert.equal(lockedForInstance(CREATE, INSTANCE_MAIN), false);
      // The description says the same as the execution (description side = execution side).
      assert.match(description("cbase_copy_stack_remove"), /still WAITING \(`waiting_queue`, `waiting_storage`\) is dismissed at once instead[^.]*no system message comes/);
    });
    const k = store.stackCopiesOf(pid).find((x) => x.name === "k1");
    assert.equal(k.state, "removed");
    assert.equal(k.result?.dismissed, true, JSON.stringify(k.result));
      // Exactly one silent hint, no wake call.
    await ctx.waitForQuiet();
    const hints = store.openHints(cH.id);
    assert.equal(hints.length, 1, JSON.stringify(hints));
    assert.equal(hints[0].source, "stack-copy");
    assert.match(hints[0].text, /verworfen/);
    const log = await json(`${ctx.base}/api/chats/${cH.id}/log`);
    assert.equal(JSON.stringify(log).includes("<task-id>copy-k1</task-id>"), false, "a wake call for a discarded request");
  });
});

// cbase_switch_instance sets the binding of the OWN chat — column, separator, wake call (system message, trigger "event": the next turn
// begins in the new instance; here copy -> main); the same value changes nothing and wakes nothing; an unknown instance is the route's error;
// a token changes no chat outside its instance (fence "chat-instance", `:chat`); a missing field is 400.
// Sabotage: the route without deliverUserPrompt => red as a hang (waitForLog waits for the wake call, "[waiting] for 90 s" — no wake call in
// the history); the fence row without `:chat` (/api/chats/:entry/instance) => red (200 instead of 403).
test("(4) cbase_switch_instance: sets the own chat's instance including separator and wake call; equal => nothing; unknown => error; a foreign chat => 403; without field => 400", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const cH = await chatInProject(ctx, pid, "Switch chat");
    const cX = await chatInProject(ctx, pid, "Foreign chat");
    await buildCopy(b);
    // cH already works in the copy (set without a turn — a turn IN the copy recreates its container in this harness, and that fails here
    // for the missing network marker). Switching back into the main: the same path, a turn that can run here.
    store.updateChat(cH.id, { instance: "copy-k1" });
    await withMcp(runEnvironment(ctx, pid, "copy-k1", cH.id), async ({ call, listTools }) => {
      assert.ok((await listTools()).includes("cbase_switch_instance"), "the tool is missing in the copy");
      let r = await call("cbase_switch_instance", { instance: "copy-zz" });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, /keine lebende Instanz/);
      assert.equal(store.chatInstance(cH.id), "copy-k1");
      // The same value: nothing changed, no wake call (below: no system message for copy-k1 in the history).
      r = await call("cbase_switch_instance", { instance: "copy-k1" });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual([r.data.instance, r.data.changed], ["copy-k1", false]);
      r = await call("cbase_switch_instance", { instance: "main" });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual([r.data.instance, r.data.changed], ["main", true]);
      assert.match(r.data.hint, /End your turn now/);
      assert.equal(store.chatInstance(cH.id), null);
    });
    // Separator and wake call (system message with the instance) in the history — exactly one, for the main.
    const log = await ctx.waitForLog(cH.id, (l) => JSON.stringify(l).includes("<task-id>main</task-id>"));
    assert.match(JSON.stringify(log), /Dieser Chat arbeitet jetzt in main/);
    assert.equal(JSON.stringify(log).includes("<task-id>copy-k1</task-id>"), false, "the call without change woke");
    await ctx.waitForQuiet();
    // A token changes no chat outside its instance: the copy token with cX (in the main) => 403, the binding stays.
    const tokenK = runEnvironment(ctx, pid, "copy-k1", cX.id).CBASE_TOKEN;
    const foreign = await fetch(`${ctx.base}/api/chats/${cX.id}/instance`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close", "x-cbase-token": tokenK }, body: JSON.stringify({ instance: "copy-k1" }) });
    assert.equal(foreign.status, 403, await foreign.text());
    assert.equal(store.chatInstance(cX.id), null);
    // A missing field is no statement: 400, nothing changed.
    const empty = await fetch(`${ctx.base}/api/chats/${cX.id}/instance`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: "{}" });
    assert.equal(empty.status, 400, await empty.text());
    assert.equal(store.chatInstance(cX.id), null);
    await ctx.waitForQuiet();
  });
});

// Length guard: three consequences the model must know BEFORE the call had been weakened or lost when shortening. They stand again
// where it reads them before the call — and the name rule is the server's (stacks/names.js).
test("Description: the consequences before the call — ignored files drop with the copy, a failed one stays, no \"-\" at the edge", () => {
  assert.match(description("cbase_copy_stack_remove"), /ignored by git[\s\S]*?otherwise they appear only in the report and fall with the copy/);
  assert.match(description(CREATE), /a failed copy stays until it is cleared/);
  const field = TOOLS.find((t) => t.name === CREATE)?.inputSchema?.properties?.name?.description;
  assert.match(String(field), /“-” \(not at the edge\)/, "the name field names the edge rule");
  assert.ok(nameError("-k1") && nameError("k1-"), "the server rejects \"-\" at the edge — otherwise the rule in the field is wrong");
  assert.equal(nameError("k-1"), null, "\"-\" in the middle is fine");
});
