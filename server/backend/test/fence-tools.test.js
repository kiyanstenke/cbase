// Guard "no offered tool runs into the fence". An agent in a project container once found a tool via ToolSearch (offered) whose
// every call failed with a fence rejection, and it then fetched a RAW token via `cbase_vars_get` and wrote it into its curl calls.
// The house rule "execution side and description side must give the same answer" was broken — for 27 tools that a coding chat in
// the project container was offered and whose route the fence always rejects.
//
// In B (no token) the fence does not apply — the break existed only in the project container.
//
// The repair: HIDDEN is everything the fence always rejects (mcp/visibility.js FENCE_LOCKED, filter in mcp/offering.js
// offeringNames): a run WITH token (`CBASE_TOKEN` — the fence judges the token, toolchain/mcp-config.js writes it only with an
// instance) is not offered them; a run without token sees everything as before.
//
// The promises, each with the way that breaks it:
//   (1) GUARD on the real offering: tools/list of the REAL MCP process with token — main agent, subagent at depth 1–3, subagent
//       with an explicit list (the full set, as runs/agent-set.js writes it from depth 2), agent of a dynamic workflow (with schema),
//       copy — against the calls per tool (fence-seam.mjs toolCalls, syntax tree, helpers transitively) and the fence table, judged
//       PER RUN (not over the union of all offerings). Red: an offered tool with a call without a row or with "rejected" (except a
//       named BRANCH_EXCEPTION) — and in the run of a COPY (token of an instance "…/copy-<name>") also with an `onlyFromMain` row,
//       which always answers 409 there; an entry in FENCE_LOCKED whose row no longer rejects it (the list may only shrink); an unused
//       exception; a FENCE_LOCKED tool that would NOT be in the coding catalog without token (the cut would be none); an offered tool
//       whose description or schema NAMES a hidden one (the description side explaining something).
//       With built-in sabotages (table without the row "chat-artifacts", cut without one entry, stale entry, unused exception,
//       `cbase_copy_stack` in the copy's offering, new tool through a new helper onto a rejected route in a copy of the MCP tree,
//       api( outside every unit).
//   (2) On the real server with a converted project: in B (no token) the hidden tools stay in the offering; in the project
//       container (instance token) they are not offered, a remembered name is "Unknown tool", and their route stays 403 for the
//       token directly.
//
// No clock: waiting is on answers (withMcp without deadline, ends with the child) and on the server; the stub service and the fake
// docker are closed in the finally.
//
// COUNTER-TESTS (each file reset from `git show HEAD:…`, the whole test file run, then restored):
//   offering.js without the filter lockedForFence      => (1) red ("mainAgent: cbase_project_delete is offered …"), (2) red
//   all three files in the state before the repair     => (1) red with 33 calls from 26 tools, (2) red
//   visibility.js: lockedForInstance no longer hides cbase_copy_stack in a copy
//                                                      => (1) red ("copy: cbase_copy_stack: POST /api/projects/…/stack-copies (row
//                                                         project-copy-create, main only — …409)"); the same sabotage against a
//                                                         guard that judged only "rejected" stays green (the gap)
//   visibility.js with FENCE_LOCKED still naming a tool no one calls any more
//                                                      => (1) red ("… (project-create)" — the row rejects, but no tool calls it),
//                                                         (2) red ("B: … stays in the offering as before")
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import * as view from "../electron/mcp/visibility.js";
import { FENCE_TABLE, rowFor } from "../electron/server/projectbox/fence-table.js";
import { BODY, TOKEN_HEADER } from "../electron/server/projectbox/fence.js";
import { tokenFor } from "../electron/server/projectbox/token.js";
import { instanceNameFromIdentifier } from "../electron/server/runs/instance.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { withMcp } from "./server-harness.mjs";
import { toolCalls } from "./fence-seam.mjs";

const MCP_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "electron", "mcp");
// Without the cut the guard turns red on its statements, not on the import.
const FENCE_LOCKED = view.FENCE_LOCKED || {};
// The full set, as runs/agent-set.js writes it from depth 2 (the catalog minus the outer-loop group).
const FULL_SET = CATALOG_NAMES.filter((n) => !view.ONLY_OUTER_LOOP.includes(n));
const INSTANCE = "0123456789abcdef0123456789abcdef/main";
const COPY = "0123456789abcdef0123456789abcdef/copy-k1";
// The environment of a run: inherit nothing from the test process that changes the cut.
const BASE = {
  CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, CBASE_SCHEMA: undefined,
  CBASE_SCHEMA_REFERENCE: undefined, CBASE_WORKFLOW_AGENT: undefined, CBASE_INSTANCE: undefined, CBASE_TOKEN: undefined,
  CBASE_PROJECT_ID: undefined, CBASE_WORKSPACE_ID: undefined, CBASE_CHAT_ID: undefined,
};
async function offered(env) {
  let names = [];
  await withMcp({ ...BASE, ...env }, async ({ listTools }) => { names = await listTools(); });
  return names;
}
// The full offering (name, description, schema) — for the question whether an offered tool NAMES a hidden one.
async function offeringFull(env) {
  let tools = [];
  await withMcp({ ...BASE, ...env }, async ({ rpc }) => { tools = (await rpc("tools/list", {})).result?.tools || []; });
  return tools;
}
/** Which names from `hidden` does the description or schema of a tool mention? */
const names2 = (tool, hidden) => {
  const text = JSON.stringify([tool.description, tool.inputSchema]);
  return hidden.filter((n) => new RegExp(`(^|[^a-z_])${n}([^a-z_]|$)`).test(text));
};

// A call the tool has in its source that never runs in the project container. Per entry tool, family, reason; the guard demands
// that every entry still covers something AND that the same call (file:line) has another path that goes through.
const BRANCH_EXCEPTIONS = Object.freeze([
  ...["cbase_vars_list", "cbase_vars_get"].map((tool) => Object.freeze({ tool, family: "workspace-accesses",
    reason: "varsBase (mcp/lib.js) takes /api/workspaces/:id only without a project — a run in the project container carries its project "
      + "(CBASE_PROJECT_ID or the working directory in the project), so /api/projects/:id/vars is used (row project-accesses)" })),
]);
// A row that lets through but whose body checker (fence.js BODY) rejects EVERY body the tool can send.
const BODY_LOCKS = Object.freeze({
  // tools/projects.js: `{ projectId: a.projectId ? … : null }` — the key is always there.
  cbase_chat_set_project: { body: "withoutProjectSwitch", bodies: [{ projectId: null }, { projectId: "own" }, { projectId: "foreign" }] },
});

/**
 * The guard's computation, pure — the sabotages run it with changed inputs. `runs` = `[{ run, offering: Set, copy }]`:
 * judged PER RUN: a row with `onlyFromMain` always answers a COPY's token 409 (fence.js checkScope, before any body) — for a copy run
 * it is fenced like a rejected row, for the main it is not. A union of all offerings would not see that: had a copy been offered
 * cbase_copy_stack, the suite would have stayed green.
 * @returns {{offeredFenced: string[], lockedWithoutReason: string[], exceptionUnused: string[], exceptionWithoutBranch: string[]}}
 */
function fenceFinding({ calls, runs, table = FENCE_TABLE, locked = FENCE_LOCKED, exceptions = BRANCH_EXCEPTIONS }) {
  const offeredFenced = [];
  const used = new Set();
  const verdict = (a, copy = false) => {
    const t = rowFor(a.method, a.path, table);
    const onlyMain = Boolean(copy && t?.row.onlyFromMain);
    return { family: t?.row.family || null, closed: !t || t.row.rule === "rejected" || onlyMain, onlyMain };
  };
  for (const { run, offering, copy } of runs) {
    for (const name of [...offering].sort()) {
      for (const a of calls.get(name) || []) {
        const u = verdict(a, copy);
        if (!u.closed) continue;
        const exception = exceptions.find((x) => x.tool === name && x.family === u.family);
        if (exception) { used.add(exception); continue; }
        const why = !u.family ? "no row" : u.onlyMain ? `row ${u.family}, main only — 409 with a copy's token` : `row ${u.family}, rejected`;
        offeredFenced.push(`${run}: ${name}: ${a.method} ${a.path} (${why}; ${a.file}:${a.place})`);
      }
    }
  }
  const offering = new Set(runs.flatMap((l) => [...l.offering]));
  const lockedWithoutReason = [];
  for (const [name, family] of Object.entries(locked)) {
    const hits = (calls.get(name) || []).map((a) => ({ a, t: rowFor(a.method, a.path, table) })).filter((x) => x.t?.row.family === family);
    const lock = BODY_LOCKS[name];
    const justified = hits.some(({ t }) => t.row.rule === "rejected")
      || (lock && hits.some(({ t }) => t.row.body === lock.body) && lock.bodies.every((b) => typeof BODY[lock.body]?.({}, b, { params: {} }) === "string"));
    if (!justified) lockedWithoutReason.push(`${name} (${family})`);
  }
  const exceptionUnused = exceptions.filter((x) => offering.has(x.tool) && !used.has(x)).map((x) => `${x.tool} (${x.family})`);
  // A BRANCH is an exception only if the SAME call (file:line) has another path that goes through — a read through a helper next
  // to it (resolve reads /api/projects in every tool) does not count.
  const place = (a) => `${a.file}:${a.place}`;
  const exceptionWithoutBranch = exceptions.filter((x) => {
    const all = calls.get(x.tool) || [];
    const fenced = new Set(all.filter((a) => verdict(a).closed && verdict(a).family === x.family).map(place));
    return !all.some((a) => fenced.has(place(a)) && !verdict(a).closed);
  }).map((x) => x.tool);
  return { offeredFenced, lockedWithoutReason, exceptionUnused, exceptionWithoutBranch };
}

// ── (1) The guard on the real offering ────────────────────────────────────────────────────────────────────────────────────────────
test("(1) guard: no tool offered to a run in the project container runs into a rejected fence row — main agent, subagents, workflow agent, copy; with built-in sabotages", async (t) => {
  const calls = toolCalls(MCP_DIR);
  assert.deepEqual([...calls.keys()].sort(), [...CATALOG_NAMES].sort(), "the analysis knows exactly the tools of the catalog");
  // The analysis sees the helpers: cbase_project_delete checks the scope via assertInScope (lib.js), which reads the project list.
  assert.ok(calls.get("cbase_project_delete").some((a) => a.path === "/api/projects" && a.file === "lib.js"), "helpers are read transitively");
  // A run in the project container — with skills and (for the workflow agent) with schema, so the tools outside the sets
  // (cbase_skill, StructuredOutput) are checked too.
  const withToken = { CBASE_TOKEN: "t".repeat(64), CBASE_INSTANCE: INSTANCE, CBASE_SKILLS: JSON.stringify(["x"]) };
  const environments = {
    mainAgent: withToken,
    "subagent-1": { ...withToken, CBASE_AGENT_DEPTH: "1" },
    "subagent-2-list": { ...withToken, CBASE_AGENT_DEPTH: "2", CBASE_TOOLS: JSON.stringify(FULL_SET) },
    "subagent-3": { ...withToken, CBASE_AGENT_DEPTH: "3" },
    "workflow-agent": { ...withToken, CBASE_AGENT_DEPTH: "1", CBASE_WORKFLOW_AGENT: "a1", CBASE_SCHEMA: JSON.stringify({ type: "object", properties: {} }), CBASE_SCHEMA_REFERENCE: "b" },
    copy: { ...withToken, CBASE_INSTANCE: COPY },
  };
  // Per run its offering and whether its token is a COPY's — the same question as fence.js checkScope (`instanceNameFromIdentifier`).
  const runs = [];
  const hidden = Object.keys(FENCE_LOCKED);
  for (const [run, env] of Object.entries(environments)) {
    const tools = await offeringFull(env);
    const names = tools.map((x) => x.name);
    assert.ok(names.length > 10, `${run}: tools/list`);
    t.diagnostic(`${run}: ${names.length} tools offered`);
    for (const n of hidden) assert.ok(!names.includes(n), `${run}: ${n} is offered although the fence rejects it`);
    // The description side in its most dangerous form: an offered tool that EXPLAINS a hidden one ("check first with
    // cbase_project_delete …") — the agent then searches for it via ToolSearch and runs into it.
    const explained = tools.flatMap((x) => names2(x, hidden).map((n) => `${x.name} names ${n}`));
    assert.deepEqual(explained, [], `${run}: an offered tool names a hidden one`);
    runs.push({ run, offering: new Set(names), copy: instanceNameFromIdentifier(env.CBASE_INSTANCE) !== "main" });
  }
  assert.deepEqual(runs.filter((l) => l.copy).map((l) => l.run), ["copy"], "exactly the copy run carries a copy's token");
  /** The runs in which `run` would additionally be offered `names` — for the sabotages. */
  const including = (run, ...names) => runs.map((l) => (l.run === run ? { ...l, offering: new Set([...l.offering, ...names]) } : l));
  // The description checker finds what it looks for (otherwise the empty list above would say nothing).
  assert.deepEqual(names2({ description: "first cbase_project_delete, then cbase_project_deleter", inputSchema: {} }, hidden), ["cbase_project_delete"]);

  const finding = fenceFinding({ calls, runs });
  assert.deepEqual(finding.offeredFenced, [], "offered, but the fence rejects (or, with a copy's token: main only) — hide it (mcp/visibility.js FENCE_LOCKED, lockedForInstance) or open the row");
  assert.deepEqual(finding.lockedWithoutReason, [], "FENCE_LOCKED names a tool whose row no longer rejects it — remove the entry");
  assert.deepEqual(finding.exceptionUnused, [], "a BRANCH_EXCEPTION covers nothing any more — remove it");
  assert.deepEqual(finding.exceptionWithoutBranch, [], "a BRANCH_EXCEPTION without a second branch on the same call that goes through — then the tool is locked entirely");
  t.diagnostic(`hidden in the project container: ${Object.keys(FENCE_LOCKED).length} tools; exceptions: ${BRANCH_EXCEPTIONS.length}; runs: ${runs.length}, of which with copy token: ${runs.filter((l) => l.copy).length}`);

  // Without token (B): the cut does not apply — every hidden tool is in the coding catalog as before.
  const withoutToken = await offered({ CBASE_INSTANCE: INSTANCE });
  for (const n of Object.keys(FENCE_LOCKED)) assert.ok(withoutToken.includes(n), `${n} is missing even without token — the cut would not be the fence's`);
  assert.ok(Object.keys(FENCE_LOCKED).length > 0, "the cut is empty");
  for (const n of Object.keys(FENCE_LOCKED)) assert.ok(CATALOG_NAMES.includes(n), `${n} is not in the catalog`);

  // ── Built-in sabotages (in memory or on a copy of the MCP tree) ──
  // a) The table without the row chat-artifacts: cbase_artifacts_list would run into the default (no row = rejected).
  const withoutArtifacts = FENCE_TABLE.filter((z) => z.family !== "chat-artifacts");
  assert.match(fenceFinding({ calls, runs, table: withoutArtifacts }).offeredFenced.join("\n"), /^mainAgent: cbase_artifacts_list: GET \S+ \(no row/m);
  // b) A hidden tool would be in the offering again (the filter is missing): the guard names it.
  const withDelete = including("mainAgent", "cbase_project_delete");
  assert.ok(fenceFinding({ calls, runs: withDelete }).offeredFenced.some((z) => z.startsWith("mainAgent: cbase_project_delete: DELETE /api/projects/X")));
  // c) A stale entry: cbase_artifacts_list reads through (row chat-artifacts) — a cut without reason.
  assert.deepEqual(fenceFinding({ calls, runs, locked: { ...FENCE_LOCKED, cbase_artifacts_list: "chat-artifacts" } }).lockedWithoutReason, ["cbase_artifacts_list (chat-artifacts)"]);
  // d) An exception that covers nothing, and one without a second branch (the call of cbase_project_delete has only the locked path;
  //    that it also reads /api/projects via assertInScope does not make that a branch).
  const empty = { tool: "cbase_artifacts_list", family: "workspace-accesses", reason: "x" };
  assert.deepEqual(fenceFinding({ calls, runs, exceptions: [...BRANCH_EXCEPTIONS, empty] }).exceptionUnused, ["cbase_artifacts_list (workspace-accesses)"]);
  const whole = { tool: "cbase_project_delete", family: "project-delete", reason: "x" };
  assert.deepEqual(fenceFinding({ calls, runs: withDelete, exceptions: [...BRANCH_EXCEPTIONS, whole] }).exceptionWithoutBranch, ["cbase_project_delete"]);
  // f) Judged PER RUN: the copy would be offered cbase_copy_stack (the hiding in mcp/visibility.js lockedForInstance is missing).
  //    The row project-copy-create is "allowed" but carries `onlyFromMain`: with a copy's token always 409 => fenced for the copy
  //    run, not for the main (where the catalog offers it).
  assert.ok(runs.find((l) => l.run === "mainAgent").offering.has("cbase_copy_stack"), "the main offers cbase_copy_stack");
  assert.ok(!runs.find((l) => l.run === "copy").offering.has("cbase_copy_stack"), "the copy does not offer cbase_copy_stack");
  const copyWithCreate = fenceFinding({ calls, runs: including("copy", "cbase_copy_stack") }).offeredFenced;
  assert.deepEqual(copyWithCreate.map((z) => z.replace(/; [^;]*\)$/, ")")),
    ["copy: cbase_copy_stack: POST /api/projects/X/stack-copies (row project-copy-create, main only — 409 with a copy's token)"],
    "a copy that is offered cbase_copy_stack must be named by the guard — and only it");
  // e) On a copy of the MCP tree: a new tool calls a rejected route through a NEW helper in lib.js — the analysis follows the helper,
  //    the guard names the tool; an api( at top level throws.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fence-tools-"));
  try {
    fs.mkdirSync(path.join(d, "tools"));
    fs.copyFileSync(path.join(MCP_DIR, "lib.js"), path.join(d, "lib.js"));
    for (const f of fs.readdirSync(path.join(MCP_DIR, "tools"))) fs.copyFileSync(path.join(MCP_DIR, "tools", f), path.join(d, "tools", f));
    fs.appendFileSync(path.join(d, "lib.js"), '\nasync function newHelper(id) { return api("DELETE", `/api/projects/${enc(id)}`); }\n');
    const file = path.join(d, "tools", "projects.js");
    const source = fs.readFileSync(file, "utf8");
    assert.ok(source.includes("const projectTools = [\n"));
    fs.writeFileSync(file, source.replace("const projectTools = [\n", 'const projectTools = [\n  { name: "cbase_new", handler: async (a) => newHelper(a.id) },\n'));
    const copy = toolCalls(d);
    assert.deepEqual(copy.get("cbase_new").map((a) => `${a.method} ${a.path}`), ["DELETE /api/projects/X"]);
    assert.deepEqual(fenceFinding({ calls: copy, runs: including("mainAgent", "cbase_new") }).offeredFenced.filter((z) => z.startsWith("mainAgent: cbase_new:")).length, 1);
    fs.appendFileSync(file, '\napi("GET", "/api/health");\n');
    assert.throws(() => toolCalls(d), /outside every tool and helper/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── (2) The hidden tools on the real server ─────────────────────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200" });

test("(2) in B the hidden tools stay in the offering; in the project container they are unknown and their route stays closed for the token", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      // A converted project with a container in the fake docker, a chat in it; the harness chat stays without project (B).
      const filePath = path.join(ctx.root, "workspace", "orbit2");
      fs.mkdirSync(filePath, { recursive: true });
      execFileSync("git", ["init", "-q", filePath]);
      const A = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "orbit2", path: filePath }) });
      const cA = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: A.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
      const name = `cbase-p-${A.id}`;
      execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
      const iA = store.createProjectInstance({ projectId: A.id, state: "ready", convertedAt: Date.now(), containerId: name,
        subnet: "10.230.5.0/24", gateway: "127.0.0.1", ip: "10.230.5.2", bridge: "cbp-5", hostname: "cbp-5" });
      const token = tokenFor(iA);

      await withEnvironment(ops(fd), async () => {
        // B: a coding chat without project, without token — the hidden tools are there.
        await withMcp({ ...BASE, CBASE_BASE_URL: base, CBASE_WORKSPACE_ID: ws.id, CBASE_CHAT_ID: ctx.chat.id }, async ({ listTools }) => {
          const names = await listTools();
          for (const n of Object.keys(FENCE_LOCKED)) assert.ok(names.includes(n), `B: ${n} is in the offering as before`);
        });

        // Project container: the run carries token and instance (what writeMcpConfig writes with its backend access).
        const inProject = { ...BASE, CBASE_BASE_URL: base, CBASE_TOKEN: token, CBASE_INSTANCE: `${A.id}/main`, CBASE_PROJECT_ID: A.id, CBASE_WORKSPACE_ID: ws.id, CBASE_CHAT_ID: cA.id };
        await withMcp(inProject, async ({ listTools, call }) => {
          const names = await listTools();
          // What the fence always rejects is not offered — and a remembered name runs into "unknown", not into the fence.
          for (const n of Object.keys(FENCE_LOCKED)) assert.ok(!names.includes(n), `project container: ${n} offered`);
          assert.ok(Object.keys(FENCE_LOCKED).includes("cbase_project_delete"), "removing a project is hidden");
          const erase = await call("cbase_project_delete", { projectId: A.id });
          assert.equal(erase.isError, true);
          assert.match(erase.text, /^Unknown tool: cbase_project_delete$/);
        });

        // With the token directly: removing the project stays 403.
        const res = await fetch(`${base}/api/projects/${A.id}`, { method: "DELETE", headers: { [TOKEN_HEADER]: token, Connection: "close" } });
        const text = await res.text();
        assert.equal(res.status, 403, text);
        assert.ok(store.getProject(A.id), "the project is still there");
      });
    });
  } finally {
    fd.cleanUp();
  }
});
