// Route detection of the deploy tool.
//
// After the bundle swap the tool probes a route that did NOT exist BEFORE — the only proof that the new process also runs
// the new code. So getRoutes must read TWO forms: the monolith (the old bundle at swap time) and the split tree. The counts
// 96/36 are the self-test: a detection that counts the monolith differently has changed without anyone wanting it.
// The monolith itself (1.27 MB) is not part of the public tree: fixtures/monolith-b686294.json carries what this guard needs from
// it — its GET routes and its literal sub-route tests. The maintainers' suite holds that file, the sha256 and the counts against the
// recorded monolith; here the form detection runs on synthetic monoliths and the working tree is held against the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getRoutes, routesForm, treeFiles, treeRoutesInput } from "./lib/asar.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = path.join(REPO, "server/backend/electron/server");

// The last monolith state before the split — frozen: 96 routes, 36 with {ws}.
const MONOLITH_COMMIT = "b686294";
const EXPECTED = { total: 96, ws: 36 };
const MONOLITH = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", `monolith-${MONOLITH_COMMIT}.json`), "utf8"));

const sorted = (set) => [...set].sort();
const withWs = (set) => [...set].filter((r) => r.includes("{ws}"));

// The monolith's GET routes (as getRoutes read them there, today's names) and whether it carried a literal sub-route test: the
// probe `sub === "<path>"` hits every test of that path, the probe `sub === "<path>" && m === "<method>"` only that method.
const monolithRoutes = new Set(MONOLITH.routes);
const monolithCarries = (probe) => MONOLITH.subRoutes.some((x) => x === probe || x.startsWith(`${probe} && m === `));

// ── Monolith ──

test(`Monolith ${MONOLITH_COMMIT}: ${EXPECTED.total} routes, ${EXPECTED.ws} with {ws}, three samples, only the two route shapes`, () => {
  assert.equal(MONOLITH.commit, MONOLITH_COMMIT);
  assert.equal(monolithRoutes.size, EXPECTED.total);
  assert.equal(MONOLITH.routes.length, EXPECTED.total, "a route twice in the fixture");
  assert.equal(withWs(monolithRoutes).length, EXPECTED.ws);
  // Three routes that certainly exist: a top-level one, one of the workspace family, a reading one.
  assert.ok(monolithRoutes.has("/api/health"));
  assert.ok(monolithRoutes.has("/api/workspaces/{ws}/overview"));
  assert.ok(monolithRoutes.has("/api/runs/active"));
  // No placeholder except {ws}, no route with a parameter of its own (those could not be guessed).
  for (const route of monolithRoutes) assert.match(route, /^\/api\/[a-z0-9\-/_.]+$|^\/api\/workspaces\/\{ws\}\/[a-z0-9\-/_.]+$/i, route);
  for (const x of MONOLITH.subRoutes) assert.match(x, /^sub === "[^"]*"(?: && m === "[A-Z]+")?$/, x);
  // The probe: a path hits all its methods, a path with a method only that one, a longer path never its prefix.
  assert.ok(monolithCarries('sub === "/projects/import"'));
  assert.ok(monolithCarries('sub === "/projects/import" && m === "POST"'));
  assert.ok(!monolithCarries('sub === "/projects/import" && m === "GET"'));
  assert.ok(!monolithCarries('sub === "/projects/imp"'));
});

// ── Tree form, synthetic ──
//
// Three files, each with a trap:
//  · server.js without the old marker — only the ROUTES literal and /api/health (stays there).
//  · toolchain/routes.js: a *WorkspaceRoutes function (its sub=== routes count), then mcpCatalogRoutes with a
//    `sub === "/trap"` that must NOT count — the function does not end in WorkspaceRoutes, its `sub` is something else.
//  · chats/routes.js: `sub === "/log"` under coreChatRoutes — there sub is the chat id, not the workspace; as a {ws}
//    route it would be a false proof.
const MARKER = String.raw`const wm = p.match(/^\/api\/workspaces\/([^/]+)(\/.*)?$/);`;

const SERVER_TREE = `import { toolchainWorkspaceRoutes, mcpCatalogRoutes } from "./toolchain/routes.js";
import { chatRoutes } from "./chats/routes.js";

const ROUTES = [
  toolchainWorkspaceRoutes,
  mcpCatalogRoutes,
  chatRoutes,
];

export function startServer() {
  if (p === "/api/health" && m === "GET") return send(res, 200, { ok: true });
  for (const route of ROUTES) if ((await route(ctx)) !== NEXT) return;
}
`;

const TOOLCHAIN = String.raw`export async function toolchainWorkspaceRoutes(ctx) {
  const { p, m, res } = ctx;
  ${MARKER}
  if (!wm) return NEXT;
  const sub = wm[2] || "";
  if (sub === "/mcp-servers" && m === "GET") {
    return send(res, 200, []);
  }
  if (sub.startsWith("/mcp-servers/") && m === "GET") {
    return send(res, 200, {});
  }
  if (sub === "/mcp-servers" && m === "POST") {
    return send(res, 201, {});
  }
  return NEXT;
}

export async function mcpCatalogRoutes(ctx) {
  const { p, m, res, sub } = ctx;
  if (p === "/api/mcp-catalog" && m === "GET") return send(res, 200, {});
  if (p === "/api/mcp-catalog/refresh" && m === "POST") return send(res, 200, {});
  if (sub === "/trap" && m === "GET") return send(res, 200, {});
  return NEXT;
}
`;

const CHATS = String.raw`export async function chatRoutes(ctx) {
  for (const s of [coreChatRoutes]) {
    const r = await s(ctx);
    if (r !== NEXT) return r;
  }
  return NEXT;
}

export async function coreChatRoutes(ctx) {
  const { p, m, res } = ctx;
  const cm = p.match(/^\/api\/chats\/([^/]+)(\/.*)?$/);
  if (!cm) return NEXT;
  const sub = cm[2] || "";
  if (sub === "/log" && m === "GET") return send(res, 200, []);
  if (p === "/api/chats" && m === "GET") return send(res, 200, []);
  return NEXT;
}
`;

const TREE_SET = [
  { path: "server.js", text: SERVER_TREE },
  { path: "toolchain/routes.js", text: TOOLCHAIN },
  { path: "chats/routes.js", text: CHATS },
];
const TREE_EXPECTED = ["/api/chats", "/api/health", "/api/mcp-catalog", "/api/workspaces/{ws}/mcp-servers"];

test("Tree form: p=== from all files, sub=== only from *WorkspaceRoutes functions", () => {
  assert.equal(routesForm(TREE_SET), "tree", "the marker in toolchain/routes.js makes no monolith — only server.js counts");
  const r = getRoutes(TREE_SET);
  assert.deepEqual(sorted(r), TREE_EXPECTED);
  // The three traps, named one by one:
  assert.ok(!r.has("/api/workspaces/{ws}/trap"), "sub=== outside a *WorkspaceRoutes function does not count");
  assert.ok(!r.has("/api/workspaces/{ws}/log"), "sub=== of a chat function is no workspace route");
  assert.ok(!r.has("/api/mcp-catalog/refresh"), "POST does not count — only GET is free of side effects");
  assert.ok(![...r].some((x) => x.includes("mcp-servers/")), "sub.startsWith carries a parameter and stays out");
});

// Counter-test of the form detection: the same tree set, but server.js carries the old marker. Then it is a monolith and
// the tree files are IGNORED — else the old bundle would suddenly count routes from a tree it does not contain at swap time.
const SERVER_MONOLITH = `export function startServer() {
      if (p === "/api/health" && m === "GET") return send(res, 200, { ok: true });
      ${MARKER}
      if (wm) {
        const sub = wm[2] || "";
        if (sub === "/overview" && m === "GET") return send(res, 200, {});
        if (sub.startsWith("/projects/") && m === "GET") return send(res, 200, {}); // startsWith carries a parameter: no route
      }
      const cm = p.match(/^\\/api\\/chats\\/([^/]+)(\\/.*)?$/);
      if (cm) {
        const sub = cm[2] || "";
        if (sub === "/log" && m === "GET") return send(res, 200, []);
      }
}
`;

test("Counter-test form detection: old marker in server.js → monolith, tree files are ignored", () => {
  const set = [{ path: "server.js", text: SERVER_MONOLITH }, ...TREE_SET.slice(1)];
  assert.equal(routesForm(set), "monolith");
  const r = getRoutes(set);
  assert.deepEqual(sorted(r), ["/api/health", "/api/workspaces/{ws}/overview"]);
  assert.ok(!r.has("/api/mcp-catalog"), "p=== from toolchain/routes.js is not read in the monolith");
  assert.ok(!r.has("/api/workspaces/{ws}/mcp-servers"), "nor is sub=== from toolchain/routes.js");
  // And inside the monolith: the chat family (next p.match on the same level) does not count as a workspace route — the
  // block ends at the family boundary.
  assert.ok(!r.has("/api/workspaces/{ws}/log"));
  // The same set WITHOUT the marker is a tree, and the same tree routes appear again.
  const without = [{ path: "server.js", text: SERVER_MONOLITH.replace(MARKER, "") }, ...TREE_SET.slice(1)];
  assert.equal(routesForm(without), "tree");
  assert.ok(getRoutes(without).has("/api/workspaces/{ws}/mcp-servers"));
});

test("Backward compatible: getRoutes(string) returns the same as getRoutes([{path:'server.js', text}])", () => {
  const text = SERVER_MONOLITH;
  const old = getRoutes(text);
  const fresh = getRoutes([{ path: "server.js", text }]);
  assert.deepEqual(sorted(old), sorted(fresh));
  assert.deepEqual(sorted(old), ["/api/health", "/api/workspaces/{ws}/overview"]);
  // The shape of a treeFiles entry ({ rel, buf }) is understood too.
  assert.deepEqual(sorted(getRoutes([{ rel: "server.js", buf: Buffer.from(text) }])), sorted(old));
});

test("Form detection: a marker in a file other than server.js makes no monolith", () => {
  // The marker is the OLD router in server.js; in a workspace slice the same line is legitimate and must not flip the form.
  assert.equal(routesForm([{ path: "workspaces/routes.js", text: MARKER }]), "tree");
  assert.equal(routesForm([{ path: "server.js", text: MARKER }]), "monolith");
  assert.equal(routesForm([{ path: "electron/server/server.js", text: MARKER }]), "monolith");
});

// ── The working tree ──
//
// getRoutes(new tree) == getRoutes(old server.js) — 96 routes, 36 with {ws}, set equality — plus the named additions, minus the
// named removals. The working tree is the tree form (route functions in many routes.js plus eventStreamRoute in
// runtime/sse.js); a tree that loses a route (a sub-slice that does not end in `WorkspaceRoutes`) shows up here.
// Literal GET routes added since the split — each with its reason. The tree carries those of the monolith PLUS exactly these;
// whoever builds a new route lists it here.
const NEW_SINCE_SPLIT = [
  "/api/workspaces/{ws}/dyn-workflows", // the library of dynamic workflows
  "/api/dyn-workflow-cap", // the per-user cap of the workflow agents (settings/routes.js)
  "/api/dyn-workflow-size", // the size guideline of dynamic workflows (settings/routes.js)
  "/api/projectbox/ops-status", // ops status for the operator's status check (projectbox/relocation/routes.js projectboxOpsRoutes) — never a probe
  "/api/projectCreation/rules", // the rules for web and iOS (projectbox/setup/routes.js) — answers even without operation
  "/api/preview-links", // list of the links (preview/routes.js) — answers even without operation and access (200), fits as a probe after the bundle swap
  "/api/integrations/ngrok", // the ngrok access as truth values (preview/routes.js), never the values
  "/api/workspaces/{ws}/outer-loop", // outer-loop agents, catalog, trigger, template of the workspace (outerloop/routes.js outerLoopWorkspaceRoutes) — the chat route `/api/chats/:id/outer-loop` and the project routes are not counted by getRoutes (no literal p===/WorkspaceRoutes form)
  "/api/usage/openrouter-prices", // dynamic OpenRouter prices: price range per model over the endpoints (account/routes.js) — failures remembered 5 min, total deadline CBASE_OR_PRICES_DEADLINE_MS (10 s)
  "/api/workspaces/{ws}/skill-catalog", // count and token cost of the catalog of a level (toolchain/routes.js) — 400 on an unknown `area`, never 404
  "/api/cpu-saver", // the switch "save compute" (settings/routes.js) — always 200 with { enabled }
  "/api/chat-auto-archive", // the setting of the auto-archive (settings/routes.js) — always 200 with { enabled, days }
  "/api/workspaces/{ws}/skill-history", // the history of the skill changes (toolchain/skill-routes.js)
  "/api/workspaces/{ws}/skill-deleted", // "recently deleted": the delete entries whose skill is missing
  "/api/workspaces/{ws}/skill-requests", // the delete requests of the agents
  "/api/workspaces/{ws}/skill-settings", // the switch "agents may change skills"
  "/api/openrouter", // access of the built-in OpenRouter as truth values and switch (account/routes.js) — never the key, always 200
  "/api/usage/consumption", // consumption of a provider per window (account/routes.js → account/usage-report.js) — 400 without `provider`
  "/api/usage/history", // the history per calendar day, gapless (400 without `provider`)
  "/api/usage/claude-limits", // the limits from the stored snapshot — never a fetch
  "/api/usage/openrouter-credit", // credit and key limit of OpenRouter (live, cached 60 s; without a key `known: false`)
  "/api/workspaces/{ws}/approval-marks", // the approval marks of the built-in tools (toolchain/routes.js → toolchain/approval-marks.js) — always 200
  "/api/workspaces/{ws}/scheduled", // the list of scheduled jobs (scheduled/routes.js) — always 200
  "/api/workspaces/{ws}/instructions", // the instruction sections per workspace/project (workspaces/instructions-routes.js) — always 200
  "/api/version", // product version and API level (version.js) — always 200, reads no store
];
// Routes of the monolith REMOVED since the split — each with its reason. The tree no longer carries them.
const GONE_SINCE_SPLIT = [
  "/api/miro", // whiteboard teardown: the Miro access only served the board export (settings/routes.js)
  "/api/workspaces/{ws}/whiteboards", // the boards per workspace (whiteboards/routes.js, file gone)
  "/api/profiles", // the personas of the profile files are gone — replaced by /api/workspaces/{ws}/instructions (settings/routes.js memoryProfileRoutes)
  "/api/memory", // MEMORY.md and its block in the system prompt are gone (settings/routes.js)
  "/api/workspaces/{ws}/detect-projects", // "detect" is gone — it turned first-level folders into projects (workspaces/routes.js tailWorkspaceRoutes)
  "/api/skills", // the page /skills across all workspaces is gone, with `skillListRoute` (toolchain/routes.js)
  "/api/presets", // the preset list of free providers and providers/presets.js are gone (account/routes.js)
  "/api/provider-configs", // the free provider configurations (GET/POST/PATCH/DELETE) are gone — the built-in OpenRouter access is under /api/openrouter; POST /api/provider-models is not counted by getRoutes (no GET route)
  "/api/usage/subscription", // the subscription report is gone — replaced by /api/usage/consumption (account/routes.js)
  "/api/usage/thirdparty", // the third-party cost report (GET and DELETE) and the price table are gone — OpenRouter is under /api/usage/consumption?provider=openrouter
  "/api/usage/prices", // the manual price table (GET and PUT) is gone
  "/api/workspaces/{ws}/manager/gitlab", // the GitLab passthrough: moved to Coding with the managing teardown, gone entirely since D2
  "/api/ingest/episodes", // managing teardown: the extractor delivery (machine token) falls with intake/
  "/api/ingest/workspaces", // ditto: the workspace list of the extractors
  "/api/todos", // ditto: the task list falls with todos/
  "/api/todos/counts", // ditto: the counters of the task list
  "/api/workspaces/{ws}/manager/deposit", // ditto: the managing routes fall with managing/, curator/, intake/, knowledge/, documents/
  "/api/workspaces/{ws}/manager/deposit/runs", // ditto
  "/api/workspaces/{ws}/manager/agents", // ditto
  "/api/workspaces/{ws}/manager/areas", // ditto
  "/api/workspaces/{ws}/manager/chat", // ditto
  "/api/workspaces/{ws}/manager/chats", // ditto
  "/api/workspaces/{ws}/manager/files", // ditto
  "/api/workspaces/{ws}/manager/docs", // ditto
  "/api/workspaces/{ws}/manager/episodes", // ditto
  "/api/workspaces/{ws}/manager/facts", // ditto
  "/api/workspaces/{ws}/manager/approval/cbase", // ditto
  "/api/workspaces/{ws}/manager/mcp-server", // ditto
  "/api/workspaces/{ws}/manager/overview", // ditto
  "/api/workspaces/{ws}/manager/project-facts", // ditto
  "/api/workspaces/{ws}/manager/prompt", // ditto
  "/api/workspaces/{ws}/manager/proposals", // ditto
  "/api/workspaces/{ws}/manager/sources", // ditto
  "/api/workspaces/{ws}/manager/administrator/audit", // ditto
  "/api/workspaces/{ws}/manager/administrator/runs", // ditto
  "/api/workspaces/{ws}/manager/schedules", // ditto
  "/api/workspaces/{ws}/manager/schedules/templates", // ditto
  "/api/agent-chats", // the list of the orb dock falls with the dock (projects/routes.js); its jobs are normal coding chats (projects/coding-jobs.js)
];
// Removed routes of the monolith that getRoutes does NOT count (it reads only literal GET routes) — each with its reason. They are
// not in GONE_SINCE_SPLIT (there the test demands that the monolith carried them as a GET route, and the counts include them); the
// test below holds them one by one: the monolith carried `sub === "<path>" && m === "<method>"`, no part of the tree carries
// `sub === "<path>"` any more.
// COUNTER-TEST: workspaces/routes.js in the state before the removal turns this test and "treeRoutesInput(working tree) …" red.
const GONE_WITHOUT_GET = [
  { sub: "/projects/import", method: "POST", cause: "the second step of \"detect\" (register detected folders as projects, in operation without a container)" },
];
const carriesSub = (set, sub) => set.filter((f) => f.text.includes(`sub === ${JSON.stringify(sub)}`)).map((f) => f.path);

test("GONE_WITHOUT_GET: removed non-GET routes are in the monolith and in no file of the tree any more — with built-in sabotage", () => {
  const set = treeRoutesInput(SERVER_DIR);
  for (const { sub, method, cause } of GONE_WITHOUT_GET) {
    assert.ok(cause, `${sub}: no reason`);
    assert.ok(monolithCarries(`sub === ${JSON.stringify(sub)} && m === ${JSON.stringify(method)}`), `${method} ${sub} was in the monolith — else it does not belong in GONE_WITHOUT_GET`);
    assert.deepEqual(carriesSub(set, sub), [], `${method} …${sub} is back`);
  }
  // Sabotage: a sub-slice with the fallen route is found (else the empty list above would say nothing).
  const sabotaged = [...set, { path: "workspaces/fresh.js", text: 'export async function newWorkspaceRoutes(ctx) {\n  if (sub === "/projects/import" && m === "POST") {}\n  return NEXT;\n}\n' }];
  assert.deepEqual(carriesSub(sabotaged, "/projects/import"), ["workspaces/fresh.js"]);
});

// Routes added since the split that getRoutes does not count — non-GET routes and sub-routes of projectRoutes (counterpart of
// GONE_WITHOUT_GET) — each with its reason and the file that carries it. The test below holds them one by one: the monolith did
// not carry `sub === "<path>"`, EXACTLY ONE file of the tree carries `sub === "<path>" && m === "<method>"` (two files with the
// same sub-route would mean one of them lies dead in the dispatcher).
// COUNTER-TEST: without projectbox/lfs-access.js in the set ⇒ red ("… missing in the tree"), with a second file ⇒ red.
const NEW_WITHOUT_GET = [
  { sub: "/scheduled", method: "POST", file: "scheduled/routes.js", cause: "create a scheduled job with its chat" },
  { sub: "/skill-write", method: "POST", file: "toolchain/skill-routes.js", cause: "the route behind cbase_skill_write, only the main agent of a coding chat" },
  { sub: "/skill-settings", method: "PUT", file: "toolchain/skill-routes.js", cause: "set the switch \"agents may change skills\"" },
  { sub: "/lfs-access", method: "POST", file: "projectbox/lfs-access.js", cause: "the git access for LFS in agent shells (POST /api/projects/:id/lfs-access, sub-slice of projectRoutes)" },
  { sub: "/upload/begin", method: "POST", file: "projectbox/setup/routes.js", cause: "upload afterwards — operation and staging (sub-slice setupProjectRoutes); finish/cancel/DELETE …/upload/:operation carry an id and are therefore not literal" },
  { sub: "/archive/check", method: "POST", file: "projectbox/setup/routes.js", cause: "check the later archive against the root (setup `liste`)" },
  { sub: "/archive/unpack", method: "POST", file: "projectbox/setup/routes.js", cause: "unpack and insert the later archive (`modus` mandatory)" },
  // A GET route belongs here too when it is a sub-route of projectRoutes — getRoutes counts only literal `p === …` routes and
  // WorkspaceRoutes. `GET …/layout/check/:check` is a RegExp and cannot be shown that way (the guard looks for the form
  // `sub === "<path>" && m === "<method>"`).
  { sub: "/layout", method: "GET", file: "projectbox/layout/routes.js", cause: "one level of the layout of an existing project (GET /api/projects/:id/layout?path=, sub-slice of projectRoutes)" },
  { sub: "/layout/check", method: "POST", file: "projectbox/layout/routes.js", cause: "the check operation of the layout (POST /api/projects/:id/layout/check → 202 { check })" },
  { sub: "/layout/takeOver", method: "POST", file: "projectbox/layout/routes.js", cause: "take over the checked plan — the job waits for quiet (→ 202 { job })" },
  { sub: "/layout/job", method: "GET", file: "projectbox/layout/routes.js", cause: "state, step, holder and report of the job" },
  { sub: "/layout/job", method: "DELETE", file: "projectbox/layout/routes.js", cause: "\"withdraw\" — only in `waiting` and `error` before the turn" },
  { sub: "/layout/job/again", method: "POST", file: "projectbox/layout/routes.js", cause: "\"try again\" after an error" },
  { sub: "/layout/holders/stop", method: "POST", file: "projectbox/layout/routes.js", cause: "\"stop\" per holder over the existing path" },
  { sub: "/superseded", method: "GET", file: "projectbox/layout/routes.js", cause: "the inventory of the old containers of renamed stacks with sizes and `stays`" },
  { sub: "/superseded/remove", method: "POST", file: "projectbox/layout/routes.js", cause: "after the confirmation remove only what was confirmed (→ 202)" },
];
const carriesRoute = (set, sub, method) => set.filter((f) => f.text.includes(`sub === ${JSON.stringify(sub)} && m === ${JSON.stringify(method)}`)).map((f) => f.path);

const SAME_NAME_IN_MONOLITH = new Set(["/layout"]);
function checkNewWithoutGet(set) {
  for (const { sub, method, file, cause } of NEW_WITHOUT_GET) {
    assert.ok(cause, `${sub}: no reason`);
    // "/layout" is the renamed layout sub-route; in the monolith that name belonged to a DIFFERENT route (POST, the layout of a
    // workflow). Only for this named sub-route do sub-route + method count.
    const probe = SAME_NAME_IN_MONOLITH.has(sub) ? `sub === ${JSON.stringify(sub)} && m === ${JSON.stringify(method)}` : `sub === ${JSON.stringify(sub)}`;
    assert.ok(!monolithCarries(probe), `${sub} was already in the monolith — then it is not new`);
    const carrier = carriesRoute(set, sub, method);
    assert.ok(carrier.length > 0, `${method} …${sub} missing in the tree`);
    assert.deepEqual(carrier, [file], `${method} …${sub}: not exactly in ${file}`);
  }
}

test("NEW_WITHOUT_GET: new non-GET routes are not in the monolith and in exactly one file of the tree — with built-in sabotage", () => {
  const set = treeRoutesInput(SERVER_DIR);
  checkNewWithoutGet(set);
  // Sabotage in both directions: red without the carrying file, red with a second file of the same sub-route.
  assert.throws(() => checkNewWithoutGet(set.filter((f) => f.path !== "projectbox/lfs-access.js")), /missing in the tree/);
  assert.throws(() => checkNewWithoutGet(set.filter((f) => f.path !== "projectbox/layout/routes.js")), /missing in the tree/);
  const duplicate = [...set, { path: "projects/fresh.js", text: 'export async function newProjectRoutes(ctx) {\n  if (sub === "/lfs-access" && m === "POST") {}\n  return NEXT;\n}\n' }];
  assert.throws(() => checkNewWithoutGet(duplicate), /not exactly in/);
});

test(`treeRoutesInput(working tree): tree form, the ${EXPECTED.total}/${EXPECTED.ws} routes of the monolith ${MONOLITH_COMMIT} plus the named new ones, minus the named removed ones`, () => {
  const set = treeRoutesInput(SERVER_DIR);
  assert.ok(set.length > 1, "the tree has more than one file");
  assert.equal(routesForm(set), "tree");
  const r = getRoutes(set);
  const old = monolithRoutes;
  for (const x of GONE_SINCE_SPLIT) assert.ok(old.has(x), `${x} was in the monolith — else it does not belong in GONE_SINCE_SPLIT`);
  const ws = (list) => list.filter((x) => x.includes("{ws}")).length;
  assert.equal(r.size, EXPECTED.total + NEW_SINCE_SPLIT.length - GONE_SINCE_SPLIT.length);
  assert.equal(withWs(r).length, EXPECTED.ws + ws(NEW_SINCE_SPLIT) - ws(GONE_SINCE_SPLIT));
  assert.deepEqual(sorted(r), sorted(new Set([...old, ...NEW_SINCE_SPLIT].filter((x) => !GONE_SINCE_SPLIT.includes(x)))));
  // treeFiles entries ({ rel, buf }) are the same set.
  assert.deepEqual(sorted(getRoutes(treeFiles(SERVER_DIR))), sorted(r));
});

// The marker was once read from a COMMENT too. After the split server.js may quote the old router — then the form would flip to
// "monolith", getRoutes would lose all tree routes, and the "new route" probe would silently fall back to /api/health.
test("Form detection: the marker only in a comment does NOT flip the form", () => {
  const tree = [
    { path: "server.js", text: "// The old router was: const wm = p.match(/^\\/api\\/workspaces\\/([0-9a-f-]+)(\\/.*)?$/);\nconst ROUTES = [x];\nif (p === \"/api/health\" && m === \"GET\") {}\n" },
    { path: "workspaces/routes.js", text: "export async function coreWorkspaceRoutes(ctx) {\n  if (sub === \"/overview\" && m === \"GET\") {}\n  return NEXT;\n}\n" },
  ];
  assert.equal(routesForm(tree), "tree");
  assert.deepEqual([...getRoutes(tree)].sort(), ["/api/health", "/api/workspaces/{ws}/overview"]);
  // The same marker as a real code line (indented, as in the handler) → monolith.
  const mono = [{ ...tree[0], text: tree[0].text.replace("// The old router was: ", "      ") }, tree[1]];
  assert.equal(routesForm(mono), "monolith");
});
