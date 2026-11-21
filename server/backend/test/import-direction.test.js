// Guard for the dependency direction in the server tree (`server/backend/electron/server/`).
//
// Why it exists: the split broke `server.js` into a facade, `runtime/`, `store/` and a dozen business domains. Snapshots
// pin the wording, but only an import line says WHAT something is made of. A reverse import `from "../server.js"` from a
// domain turns the facade into a cycle node - every domain would drag the whole server along on load, and none would be
// testable without it. The same on a small scale: `runtime/` and `store/` are the leaves under everything; if they import
// a business domain, the layering is only a claim. And `app-state.js` (depth 1) holds only `node:*`, because every reader
// loads it first.
//
// Three rules, purely mechanical over the import specifiers:
//   1. No file imports `server.js` back - unless it stands in `REVERSE_IMPORTS_ALLOWED` below (the list must be
//      empty at the end).
//   2. `runtime/**` and `store/**` import no business domain. A business domain is every folder except `runtime`,
//      `store`, `providers`. ROOT FILES (`../claude.js` ...) are no business domain. An edge may be tolerated
//      (`TOLERATED_EDGES`, with a reason) and is then PRINTED on every run, so that it is never silent. The list is EMPTY
//      today - the mechanism stays (counter-test 2 checks it with a list of its own), so that a future edge would stand
//      named and printed instead of silent in the tree.
//   3. `app-state.js` imports only `node:*`.
// Further, at the end of the file: `runs/` imports no business domain and no root business module - except `routes.js` (the
// hub asks the register, `runs/hooks.js` stays a leaf); the exception is PRINTED on every run (with the domains that
// routes.js pulls today) and `runtime/` is kept explicitly hub-free (no edge to runs/; rule 2 covers it, the line says it by
// name). And last: CYCLE FREEDOM. Direction says nothing about cycles - they arose silently because nothing counted them.
// Tarjan over the same edges against a named list that is printed on every run and may only shrink.
//
// What is NOT checked here: `main.js` and `headless.js` lie outside `electron/server` - they may import the facade, they are
// its callers. `providers/**` has no direction rule (the adapters are a contract of their own, providers/contract.js).
//
// The backend suite (`server/backend/test/*.test.js`) runs this file. The test counts folders that may not exist yet, so the
// rule must read "every folder except ..." and not "this list of folders": a future domain would otherwise be silently
// allowed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("../electron/server/", import.meta.url));
// The MCP server sits NEXT to the tree (server/backend/electron/mcp/) and no file set of any guard used to read it.
const MCP_DIR = fileURLToPath(new URL("../electron/mcp/", import.meta.url));

// The leaves that are no business domain. Everything else under electron/server WITH a folder is one.
const NO_BUSINESS_DOMAIN = new Set(["runtime", "store", "providers"]);

// Tolerated edges leaf -> business domain, each with a reason - NONE today. `runtime/sse.js` gets the run state through the
// setter `setRunState` from startServer (server.js), so the edges are out of the tree, and the real tree is checked below
// WITHOUT tolerance. Entering a new edge here reopens the contradiction: name the reason, name the follow-up.
const TOLERATED_EDGES = [];

const RULE_FACADE = "reverse import of the facade server.js";
const RULE_SHEET = "runtime/ and store/ import no business domain";
const RULE_APP_STATE = "app-state.js imports only node:*";

// Import specifiers of a source text. Three forms, each at the start of a line (comments with `//` or ` *` in front do not
// hit):
//   - `import x from "…"`, `import { a,\n b } from "…"`, `import * as ns from "…"`, `import "…"` (`[^}]*` runs across line
//     breaks, so the multi-line brace import is caught too),
//   - `export { … } from "…"` and `export * from "…"` - a re-export is the same edge,
//   - `import("…")` with a literal - a dynamic reverse import is the same edge, only later.
const RE_IMPORT = /^[ \t]*import\s*(?:(?:[\w$]+|\*\s*as\s+[\w$]+|\{[^}]*\}|[\w$]+\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))\s*from\s*)?["']([^"']+)["']/gm;
const RE_REEXPORT = /^[ \t]*export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/gm;
const RE_DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

// Strip block comments first: a `/* import x from "./y.js" */` is NO edge, but `[ \t]*` at the line start lets the continuation
// line of a block comment through if it does not begin with ` *`. A `//` line may contain a `/*` (permissions.js:
// "Read(src/**)"), hence line comments first. The direction of the error is intended: too much stripped means an OVERLOOKED
// edge, too little would mean a cycle that ESM never forms - and that nobody can resolve.
const withoutComments = (text) => text
  .split("\n").map((z) => z.replace(/\/\/.*$/, "")).join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

export function importSpecifier(text) {
  const body = withoutComments(text);
  const output = [];
  for (const re of [RE_IMPORT, RE_REEXPORT, RE_DYNAMIC]) {
    for (const m of body.matchAll(re)) output.push(m[1]);
  }
  return output;
}

const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");

// Target of a relative specifier as a path relative to electron/server (posix). If the way leads out of the tree, the result
// begins with `../`.
function resolved(file, spec) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
}

const folderOf = (rel) => (rel.includes("/") ? rel.split("/")[0] : "");

/**
 * The violations of a file set against the three rules. Pure: no file, no process state.
 * @param {{path: string, text: string}[]} files  paths relative to electron/server, posix
 * @param {{reverseImportsAllowed?: string[], toleratedEdges?: {from: string, to: string, reason?: string}[]}} [opts]
 * @returns {string[]}  "<file>: <rule> — <specifier>"
 */
export function importDirectionViolations(files, { reverseImportsAllowed = [], toleratedEdges = [] } = {}) {
  const allowed = new Set(reverseImportsAllowed);
  const tolerated = new Set(toleratedEdges.map((k) => `${k.from} → ${k.to}`));
  const violations = [];
  for (const { path: file, text } of files) {
    const rel = file.split(path.sep).join("/");
    for (const spec of importSpecifier(text)) {
      // Rule 3 first: for app-state.js EVERY non-node import is a violation, a package too.
      if (rel === "app-state.js") {
        if (!spec.startsWith("node:")) violations.push(`${rel}: ${RULE_APP_STATE} — ${spec}`);
        continue;
      }
      if (!isRelative(spec)) continue;                 // node:*, packages: no edge in the tree
      const target = resolved(rel, spec);
      // Rule 1: the facade. Checked via the file name, not via the resolved place - a `../../server.js` from `runs/` points out
      // of the tree and still means the facade.
      if (rel !== "server.js" && path.posix.basename(target) === "server.js") {
        if (!allowed.has(rel)) violations.push(`${rel}: ${RULE_FACADE} — ${spec}`);
        continue;
      }
      // Rule 2: leaves stay domain-free. Root files (no folder) and targets outside the tree (`../` stays) are no business
      // domain.
      const folder = folderOf(rel);
      if (folder !== "runtime" && folder !== "store") continue;
      const targetFolder = folderOf(target);
      if (!targetFolder || targetFolder === ".." || NO_BUSINESS_DOMAIN.has(targetFolder)) continue;
      if (tolerated.has(`${rel} → ${target}`)) continue;
      violations.push(`${rel}: ${RULE_SHEET} — ${spec}`);
    }
  }
  return violations;
}

// ── The real tree ───────────────────────────────────────────────────────────

function serverFiles() {
  return fs.readdirSync(SERVER_DIR, { recursive: true })
    .map((p) => String(p).split(path.sep).join("/"))
    .filter((p) => p.endsWith(".js") && !p.split("/").includes("node_modules"))
    .sort()
    .map((p) => ({ path: p, text: fs.readFileSync(path.join(SERVER_DIR, p), "utf8") }));
}

// Reverse imports of the facade that stay allowed: NONE (the split that tolerated some is finished). An entry would be a
// relative path under electron/server, with a reason named here.
const REVERSE_IMPORTS_ALLOWED = [];

test("dependency direction: no reverse import of the facade, leaves domain-free, app-state.js only node:*", () => {
  const files = serverFiles();
  assert.ok(files.some((f) => f.path === "server.js"), "server.js is missing from the tree - wrong directory?");
  const reverseImportsAllowed = REVERSE_IMPORTS_ALLOWED;
  // Print what is tolerated - and whether the tolerance applies at all today. An edge that never applies belongs struck; one
  // that applies is an open follow-up.
  const withoutTolerance = new Set(importDirectionViolations(files, { reverseImportsAllowed }));
  for (const k of TOLERATED_EDGES) {
    const applies = [...withoutTolerance].some((v) => v.startsWith(`${k.from}: ${RULE_SHEET} — `) && resolved(k.from, v.split(" — ").pop()) === k.to);
    console.log(`[import-direction] tolerated: ${k.from} → ${k.to} (${applies ? "applies" : "no hit today"}) — ${k.reason}`);
  }
  for (const r of reverseImportsAllowed) console.log(`[import-direction] reverse import allowed: ${r}`);
  const violations = importDirectionViolations(files, { reverseImportsAllowed, toleratedEdges: TOLERATED_EDGES });
  assert.deepEqual(violations, [], `dependency direction violated:\n  ${violations.join("\n  ")}`);
});

// ── Counter-tests: every rule once red, otherwise the guard would be a claim ─

const file = (p, ...rows) => ({ path: p, text: rows.join("\n") + "\n" });

test("counter-test 1: a domain that imports server.js back fails - until it is allowed", () => {
  const set = [
    file("server.js", 'import { running } from "./runs/state.js";'),
    file("runs/state.js", 'import { x } from "../server.js";'),
  ];
  assert.deepEqual(importDirectionViolations(set), [`runs/state.js: ${RULE_FACADE} — ../server.js`]);
  assert.deepEqual(importDirectionViolations(set, { reverseImportsAllowed: ["runs/state.js"] }), []);
  // Depth 2 and root: `../../server.js` from `mcp/tools/`, `./server.js` from a root file.
  assert.deepEqual(importDirectionViolations([file("mcp/tools/chats.js", 'import { a } from "../../server.js";')]),
    [`mcp/tools/chats.js: ${RULE_FACADE} — ../../server.js`]);
  assert.deepEqual(importDirectionViolations([file("manager.js", 'import { a } from "./server.js";')]),
    [`manager.js: ${RULE_FACADE} — ./server.js`]);
  // A re-export and a dynamic import are the same edge.
  assert.deepEqual(importDirectionViolations([file("runs/queue.js", 'export { headerBundle } from "../server.js";')]),
    [`runs/queue.js: ${RULE_FACADE} — ../server.js`]);
  assert.deepEqual(importDirectionViolations([file("runs/queue.js", 'const s = await import("../server.js");')]),
    [`runs/queue.js: ${RULE_FACADE} — ../server.js`]);
});

test("counter-test 2: runtime/ and store/ may use root and leaves, but no business domain - unless tolerated", () => {
  assert.deepEqual(importDirectionViolations([file("runtime/http.js", 'import { a } from "../chats/helpers.js";')]),
    [`runtime/http.js: ${RULE_SHEET} — ../chats/helpers.js`]);
  // store/chats.js: neighbor in the leaf and two root files - exactly what store.js does today.
  assert.deepEqual(importDirectionViolations([file("store/chats.js",
    'import { db } from "./db.js";',
    'import { episodeLabel } from "../ingest.js";',
    'import { SCHEDULE_TOOLS } from "../manager.js";',
    'import fs from "node:fs";',
  )]), []);
  // Leaf -> leaf (runtime -> store, runtime -> providers) is allowed.
  assert.deepEqual(importDirectionViolations([file("runtime/sse.js",
    'import * as store from "../store.js";',
    'import { getChat } from "../store/chats.js";',
    'import { providerFor } from "../providers/index.js";',
  )]), []);
  // The tolerance mechanism (with a list of ITS OWN - the real one is empty): red without tolerance, green with it - and only
  // EXACTLY this edge.
  const tolerance = [{ from: "runtime/sse.js", to: "runs/state.js", reason: "counter-test" }];
  const sse = [file("runtime/sse.js", 'import { running } from "../runs/state.js";')];
  assert.deepEqual(importDirectionViolations(sse), [`runtime/sse.js: ${RULE_SHEET} — ../runs/state.js`]);
  assert.deepEqual(importDirectionViolations(sse, { toleratedEdges: tolerance }), []);
  const sseOther = [file("runtime/sse.js", 'import { doRun } from "../runs/do-run.js";')];
  assert.deepEqual(importDirectionViolations(sseOther, { toleratedEdges: tolerance }),
    [`runtime/sse.js: ${RULE_SHEET} — ../runs/do-run.js`]);
  // And the real list is empty: the two sse edges of before are out of the tree, not only out of the list - the real tree is
  // checked above without tolerance.
  assert.deepEqual(TOLERATED_EDGES, []);
  // A domain may import domains; providers/ has no direction rule.
  assert.deepEqual(importDirectionViolations([
    file("managing/chat.js", 'import { doRun } from "../runs/do-run.js";'),
    file("providers/index.js", 'import * as store from "../store.js";'),
  ]), []);
});

test("counter-test 3: app-state.js holds only node:* - no store, no package, no bare \"path\"", () => {
  assert.deepEqual(importDirectionViolations([file("app-state.js", 'import path from "node:path";', 'import { fileURLToPath } from "node:url";')]), []);
  assert.deepEqual(importDirectionViolations([file("app-state.js", 'import * as store from "./store.js";')]),
    [`app-state.js: ${RULE_APP_STATE} — ./store.js`]);
  assert.deepEqual(importDirectionViolations([file("app-state.js", 'import path from "path";')]),
    [`app-state.js: ${RULE_APP_STATE} — path`]);
});

test("counter-test 4: the multi-line brace import is read - otherwise every long import would be invisible", () => {
  const multiline = file("runtime/http.js",
    "import {",
    "  getChat,",
    "  listChats,",
    '} from "../chats/helpers.js";',
    "import fs from \"node:fs\";",
  );
  assert.deepEqual(importSpecifier(multiline.text), ["../chats/helpers.js", "node:fs"]);
  assert.deepEqual(importDirectionViolations([multiline]), [`runtime/http.js: ${RULE_SHEET} — ../chats/helpers.js`]);
  // Comments are no imports - the head of a file may name `../server.js`.
  const commented = file("runs/state.js", "// before: import { x } from \"../server.js\";", " * import { y } from \"../server.js\"", 'import { db } from "../store.js";');
  assert.deepEqual(importSpecifier(commented.text), ["../store.js"]);
});

// ── The hub `runs/` ──────────────────────────────────────────────────────────────
// No file in `runs/` except `routes.js` imports a BUSINESS DOMAIN (the folders of the coding side: workflows, projects,
// channels, dynworkflows, projectbox, stacks, outerloop, scheduled) or one of the ROOT BUSINESS MODULES
// (`workflows.js`). Cross-cutting stays allowed: runtime/, store/, providers/, account/, settings/, toolchain/ and the root
// files that are no business module (claude.js, i18n.js, cron.js, ...). The hub asks the register (`runs/hooks.js`, a leaf
// without imports) - whoever needs something from the business side registers it in server.js. `routes.js` is the named
// exception: the routes are callers of the domains, not the hub. The guard with the kind names (tools/check/lib/tree-rules.mjs
// `hookRegistry`) is the other half: it holds registrations and calls against each other; this check holds only the import
// direction, so that the promise does not silently grow back. `workflows.js` carries business knowledge (graph library) and
// stands in the list for that reason.
// Notes per domain: `dynworkflows` - the runtime of the dynamic workflows reaches runs/ only through the hook register.
// `projectbox` - runs/ reaches it only through setters from server.js (runs/instance.js, runtime/inProject.js), never through
// an import; `projectbox/` itself may read runs/. `stacks` - the copies are a domain ABOVE projectbox/; runs/ learns of them
// only through setters from server.js (the stricter rule stands below at "G3"). `outerloop` - runs/ learns of it only through
// hook consumers and setters from server.js; /api/runs/active reads its runs from the store, never from outerloop/.
// `scheduled` - the scheduled jobs in coding: runs/ reads the job of a chat through the store (system-prompt.js, do-run.js),
// the plain text of the rhythm through a setter from server.js, the run end through hook consumers; never through an import.
// The dropped managing folders and root modules are held by the guard "Teardown" below.
const BUSINESS_DOMAINS_HUB = new Set(["workflows", "projects", "channels", "dynworkflows", "projectbox", "stacks", "outerloop", "scheduled"]);
const ROOT_DOMAIN_MODULES = new Set(["workflows.js"]);
const RULE_HUB = "runs/ imports no business domain and no root business module (except routes.js)";
const RULE_RUNTIME_HUB = "runtime/ imports nothing from runs/ (hub-free)";
export function hubViolations(files) {
  const violations = [];
  for (const { path: file, text } of files) {
    const rel = file.split(path.sep).join("/");
    if (folderOf(rel) !== "runs" || rel === "runs/routes.js") continue;
    for (const spec of importSpecifier(text)) {
      if (!spec.startsWith(".")) continue;
      const target = resolved(rel, spec);
      const folder = folderOf(target);
      const businessDomain = BUSINESS_DOMAINS_HUB.has(folder);
      const rootDomain = !folder && ROOT_DOMAIN_MODULES.has(target);
      if (businessDomain || rootDomain) violations.push(`${rel}: ${RULE_HUB} — ${spec}`);
    }
  }
  return violations;
}

// The business imports of a file (folder or root business module), as specifiers - for the printed exception.
function domainImports(text, rel) {
  return importSpecifier(text).filter((spec) => {
    if (!spec.startsWith(".")) return false;
    const target = resolved(rel, spec);
    const folder = folderOf(target);
    return BUSINESS_DOMAINS_HUB.has(folder) || (!folder && ROOT_DOMAIN_MODULES.has(target));
  });
}

// `runtime/` (leaf under everything) imports nothing from `runs/` - the two edges of before (sse.js -> state.js, -> ask.js)
// would otherwise silently come back. Rule 2 above covers every business domain; here the hub stands by name.
export function runtimeHubViolations(files) {
  const violations = [];
  for (const { path: file, text } of files) {
    const rel = file.split(path.sep).join("/");
    if (folderOf(rel) !== "runtime") continue;
    for (const spec of importSpecifier(text)) {
      if (spec.startsWith(".") && folderOf(resolved(rel, spec)) === "runs") violations.push(`${rel}: ${RULE_RUNTIME_HUB} — ${spec}`);
    }
  }
  return violations;
}

test("hub: runs/ is domain-free except routes.js (the exception is printed), runtime/ hub-free, runs/hooks.js imports nothing", () => {
  const files = serverFiles();
  const violations = hubViolations(files);
  assert.deepEqual(violations, [], `hub violated:\n  ${violations.join("\n  ")}`);
  const runtime = runtimeHubViolations(files);
  assert.deepEqual(runtime, [], `runtime/ pulls the hub:\n  ${runtime.join("\n  ")}`);
  // The register is a leaf: zero imports - otherwise every registrant would drag the hub along on load.
  const hooks = files.find((f) => f.path === "runs/hooks.js");
  assert.ok(hooks, "runs/hooks.js is missing");
  assert.deepEqual(importSpecifier(hooks.text), []);
  // And the exception is REALLY one today: routes.js imports business domains (otherwise the exception would be dead) - and it
  // is printed on EVERY run, with what it pulls today: a silent exception cannot be told from a forgotten one (the same rule
  // as for the tolerated edges above and the guard in check.mjs).
  const routes = files.find((f) => f.path === "runs/routes.js");
  const pulled = domainImports(routes.text, "runs/routes.js");
  assert.ok(pulled.length > 0, "runs/routes.js no longer imports a business domain - the exception belongs struck");
  console.log(`[import-direction] exception: runs/routes.js imports ${pulled.length} business module(s) — ${pulled.join(", ")} (routes are the HTTP surface like every <domain>/routes.js)`);
});

test("counter-test 5: a business import in runs/ fails - domain folder like root business module; routes.js and leaves do not", () => {
  // (The dropped managing folders and root modules used to stand here - their import falls under the guard "Teardown".)
  assert.deepEqual(hubViolations([file("runs/ask.js", 'import { deliverChannel } from "../channels/delivery.js";')]),
    [`runs/ask.js: ${RULE_HUB} — ../channels/delivery.js`]);
  assert.deepEqual(hubViolations([file("runs/resume.js", 'import * as wf from "../workflows.js";', 'import { driveWorkflow } from "../workflows/driver.js";')]),
    [`runs/resume.js: ${RULE_HUB} — ../workflows.js`, `runs/resume.js: ${RULE_HUB} — ../workflows/driver.js`]);
  assert.deepEqual(hubViolations([file("runs/do-run.js", 'import { startScript } from "../dynworkflows/sandbox.js";')]),
    [`runs/do-run.js: ${RULE_HUB} — ../dynworkflows/sandbox.js`]);
  // The project containers are a business domain - the instance comes through runs/instance.js (setter), never by import.
  assert.deepEqual(hubViolations([file("runs/do-run.js", 'import { runInstance } from "../projectbox/run-instance.js";')]),
    [`runs/do-run.js: ${RULE_HUB} — ../projectbox/run-instance.js`]);
  // The copies are a business domain - the hub learns of them only through setters from server.js.
  assert.deepEqual(hubViolations([file("runs/instance.js", 'import { liveCopy } from "../stacks/state.js";')]),
    [`runs/instance.js: ${RULE_HUB} — ../stacks/state.js`]);
  // The outer loop is a business domain - the core (runs/agents.js) knows it only as an option.
  assert.deepEqual(hubViolations([file("runs/agents.js", 'import { outerLoopSet } from "../outerloop/set.js";')]),
    [`runs/agents.js: ${RULE_HUB} — ../outerloop/set.js`]);
  // Allowed: neighbors in runs/, leaves, cross-cutting, root files that are no business module, packages.
  assert.deepEqual(hubViolations([file("runs/queue.js",
    'import { fireHooks } from "./hooks.js";',
    'import * as store from "../store.js";',
    'import { sse } from "../runtime/sse.js";',
    'import { providerFor } from "../providers/index.js";',
    'import { agentModelFor } from "../settings/agent-models.js";',
    'import { defaultModelFor } from "../account/providers.js";',
    'import { mcpConfigPath } from "../toolchain/mcp-config.js";',
    'import { T } from "../i18n.js";',
    'import { cronPeriodMs } from "../cron.js";',
    'import fs from "node:fs";',
  )]), []);
  // The exception: routes.js may.
  assert.deepEqual(hubViolations([file("runs/routes.js", 'import { answerWorkflow } from "../workflows/gates.js";')]), []);
  // Outside runs/ the rule does not apply (there the three rules above apply).
  assert.deepEqual(hubViolations([file("managing/chat.js", 'import { doRun } from "../runs/do-run.js";')]), []);
});

test("counter-test 6: runtime/ pulls the hub - the two edges of before would otherwise silently come back", () => {
  assert.deepEqual(runtimeHubViolations([file("runtime/sse.js", 'import { running } from "../runs/state.js";', 'import { openAskOf } from "../runs/ask.js";')]),
    [`runtime/sse.js: ${RULE_RUNTIME_HUB} — ../runs/state.js`, `runtime/sse.js: ${RULE_RUNTIME_HUB} — ../runs/ask.js`]);
  assert.deepEqual(runtimeHubViolations([file("runtime/http.js", 'import { db } from "../store.js";', 'import { NEXT } from "./http.js";', 'import fs from "node:fs";')]), []);
  // Rule 2 sees the same edge as "business domain" - two lines for one error, but the second names the hub.
  assert.deepEqual(importDirectionViolations([file("runtime/http.js", 'import { running } from "../runs/state.js";')]),
    [`runtime/http.js: ${RULE_SHEET} — ../runs/state.js`]);
  // Outside runtime/ it does not apply - store/ is covered by rule 2, the business side may use the hub.
  assert.deepEqual(runtimeHubViolations([file("managing/chat.js", 'import { doRun } from "../runs/do-run.js";')]), []);
});

// ── G3: the business folder stacks/ ─────────────────────────────────────────────────────────────────────────────────────
//
// The copies lie ABOVE the project containers: `stacks/` may reach down - projectbox/ (instance, creation, journal),
// workflows/storage-gate.js (the gate, not the rest of the workflow domain), runs/ and the store - and nothing below may
// reach up. `projectbox/`, `runs/` (ALSO runs/routes.js, unlike the hub above) and `workflows/` learn of copies only through
// setters from server.js; an import from there to stacks/ would be the first cycle of stage 2, and `CYCLES_ALLOWED` gets no
// entry for it. Also the cross-cutting leaves `runtime/` (broadcast of the event `project/copy`, like projectbox/instances.js)
// and `app-state.js` (DIRS), and `i18n.js` (the language switch `T` of the silent hints of the queue; a leaf without
// imports, as in projectbox/idle.js and workflows/storage-gate.js).
const RULE_STACKS_OFF = "stacks/ imports only projectbox/, workflows/storage-gate.js, runs/, store, runtime/, app-state.js, i18n.js (G3)";
const RULE_STACKS_ONE = "projectbox/, runs/ and workflows/ never import stacks/ - only setters from server.js (G3)";
const STACKS_FOLDER_ALLOWED = new Set(["stacks", "projectbox", "runs", "runtime", "store"]);
const STACKS_FILES_ALLOWED = new Set(["workflows/storage-gate.js", "store.js", "app-state.js", "i18n.js"]);
const WITHOUT_STACKS = new Set(["projectbox", "runs", "workflows"]);
export function stacksViolations(files) {
  const violations = [];
  for (const { path: file, text } of files) {
    const rel = file.split(path.sep).join("/");
    const folder = folderOf(rel);
    if (folder !== "stacks" && !WITHOUT_STACKS.has(folder)) continue;
    for (const spec of importSpecifier(text)) {
      if (!isRelative(spec)) continue;                 // node:*, packages: no edge in the tree
      const target = resolved(rel, spec);
      const targetFolder = folderOf(target);
      if (folder === "stacks") {
        if (!STACKS_FOLDER_ALLOWED.has(targetFolder) && !STACKS_FILES_ALLOWED.has(target)) violations.push(`${rel}: ${RULE_STACKS_OFF} — ${spec}`);
      } else if (targetFolder === "stacks") {
        violations.push(`${rel}: ${RULE_STACKS_ONE} — ${spec}`);
      }
    }
  }
  return violations;
}

test("G3: stacks/ reaches only downward (projectbox/, storage-gate.js, runs/, store), and nothing below reaches up", () => {
  const files = serverFiles();
  const stacks = files.filter((f) => folderOf(f.path) === "stacks");
  assert.ok(stacks.some((f) => f.path === "stacks/state.js"), "stacks/state.js is missing - does the guard read the wrong tree?");
  const violations = stacksViolations(files);
  assert.deepEqual(violations, [], `G3 violated:\n  ${violations.join("\n  ")}`);
  // And the rule REALLY bites today: stacks/ pulls projektbox/ (otherwise it would check a folder without edges).
  const stackEdges = stacks.flatMap((f) => importSpecifier(f.text).filter(isRelative).map((s) => resolved(f.path, s)));
  assert.ok(stackEdges.some((z) => folderOf(z) === "projectbox"), "stacks/ imports nothing from projectbox/ - the rule checks nothing today");
});

test("counter-test G3: an upward import (also from runs/routes.js) and a sideways import from stacks/ fail", () => {
  assert.deepEqual(stacksViolations([file("projectbox/instance.js", 'import { copyRequests } from "../stacks/state.js";')]),
    [`projectbox/instance.js: ${RULE_STACKS_ONE} — ../stacks/state.js`]);
  assert.deepEqual(stacksViolations([file("runs/routes.js", 'import { copyRequests } from "../stacks/state.js";')]),
    [`runs/routes.js: ${RULE_STACKS_ONE} — ../stacks/state.js`]);
  assert.deepEqual(stacksViolations([file("workflows/graph-start.js", 'import("../stacks/state.js");')]),
    [`workflows/graph-start.js: ${RULE_STACKS_ONE} — ../stacks/state.js`]);
  assert.deepEqual(stacksViolations([file("stacks/queue.js",
    'import { driveWorkflow } from "../workflows/driver.js";',
    'import { managerPageOfChat } from "../managing/chat.js";',
    'import * as wf from "../workflows.js";',
  )]), [
    `stacks/queue.js: ${RULE_STACKS_OFF} — ../workflows/driver.js`,
    `stacks/queue.js: ${RULE_STACKS_OFF} — ../managing/chat.js`,
    `stacks/queue.js: ${RULE_STACKS_OFF} — ../workflows.js`,
  ]);
  // Allowed: downward, neighbors, cross-cutting, node:*; and server.js (the setters) like any other domain.
  assert.deepEqual(stacksViolations([
    file("stacks/queue.js",
      'import { storageSituation } from "../workflows/storage-gate.js";',
      'import { createInstance } from "../projectbox/instance.js";',
      'import { instanceForChat } from "../runs/instance.js";',
      'import * as store from "../store.js";',
      'import { broadcast } from "../runtime/sse.js";',
      'import { DIRS } from "../app-state.js";',
      'import { nameError } from "./names.js";',
      'import fs from "node:fs";'),
    file("server.js", 'import { copyRequests } from "./stacks/state.js";'),
    file("managing/chat.js", 'import { copyRequests } from "../stacks/state.js";'),
  ]), []);
});

// ── The language service (editor navigation) ───────────────────────────────────────────────────────────────────────────
// lsp/ never imports runs/ (the target of a file - instance, scope, project - is computed by the caller: devtools/code-route.js
// lspTargetFor, devtools/routes.js lspAgentTarget), and runs/ never imports lsp/ (not even runs/routes.js): the language
// service is no work of a run. projectbox/ reaches lsp/ only through the setter projectbox/idle.js setLanguageServiceEnd (server.js).
const RULE_LSP = "lsp/ and runs/ do not know each other, projectbox/ reaches lsp/ only through the setter";
export function lspViolations(files) {
  const violations = [];
  for (const { path: file, text } of files) {
    const rel = file.split(path.sep).join("/");
    const folder = folderOf(rel);
    if (folder !== "lsp" && folder !== "runs" && folder !== "projectbox") continue;
    for (const spec of importSpecifier(text)) {
      if (!isRelative(spec)) continue;
      const targetFolder = folderOf(resolved(rel, spec));
      if ((folder === "lsp" && targetFolder === "runs") || (folder !== "lsp" && targetFolder === "lsp")) violations.push(`${rel}: ${RULE_LSP} — ${spec}`);
    }
  }
  return violations;
}

test("language service: lsp/ and runs/ do not know each other, projectbox/ only through the setter", () => {
  const files = serverFiles();
  assert.ok(files.some((f) => f.path === "lsp/sessions.js"), "lsp/sessions.js is missing - does the guard read the wrong tree?");
  const violations = lspViolations(files);
  assert.deepEqual(violations, [], `violated:\n  ${violations.join("\n  ")}`);
});

test("counter-test language service: lsp/ → runs/, runs/routes.js → lsp/ and projectbox/ → lsp/ fail; devtools/ and server.js do not", () => {
  assert.deepEqual(lspViolations([
    file("lsp/sessions.js", 'import { instanceForProject } from "../runs/instance.js";'),
    file("runs/routes.js", 'import { statusOf } from "../lsp/sessions.js";'),
    file("projectbox/idle.js", 'export { endSessions } from "../lsp/sessions.js";'),
  ]), [
    `lsp/sessions.js: ${RULE_LSP} — ../runs/instance.js`,
    `runs/routes.js: ${RULE_LSP} — ../lsp/sessions.js`,
    `projectbox/idle.js: ${RULE_LSP} — ../lsp/sessions.js`,
  ]);
  assert.deepEqual(lspViolations([
    file("devtools/code-route.js", 'import { lspEditorResponse } from "../lsp/routes.js";'),
    file("server.js", 'import { endSessions } from "./lsp/sessions.js";'),
    file("lsp/limit.js", 'import { inProject } from "../runtime/inProject.js";', 'import { rememberExternal } from "./sessions.js";'),
  ]), []);
});

// ── Teardown: the dropped folders and root modules are imported by nobody ──
//
// The folders `managing/`, `curator/`, `knowledge/`, `documents/`, `todos/`, `intake/` and the root modules `manager.js`,
// `pipeline.js`, `administrator.js`, `ingest.js` are gone. An import that names one of them again is red - even if the target
// does not exist (then only the start would break, `node --check` does not see it) and also as a dynamic import or re-export.
// Also none of the folders and none of the files may stand in the tree: whoever creates one anew brings the managing back
// without saying so.
const DROPPED_FOLDER = Object.freeze(["managing", "curator", "knowledge", "documents", "todos", "intake"]);
const DROPPED_ROOTS = Object.freeze(["manager.js", "pipeline.js", "administrator.js", "ingest.js"]);
const RULE_TEARDOWN = "no import of a dropped folder or root module (managing/, curator/, knowledge/, documents/, todos/, intake/, manager.js, pipeline.js, administrator.js, ingest.js)";
const isDropped = (rel) => DROPPED_FOLDER.includes(folderOf(rel)) || DROPPED_ROOTS.includes(rel);
export function teardownViolations(files) {
  const violations = [];
  for (const { path: file, text } of files) {
    const rel = file.split(path.sep).join("/");
    if (isDropped(rel)) violations.push(`${rel}: is back in the tree — ${RULE_TEARDOWN}`);
    for (const spec of importSpecifier(text)) {
      if (!isRelative(spec)) continue;
      if (isDropped(resolved(rel, spec))) violations.push(`${rel}: ${RULE_TEARDOWN} — ${spec}`);
    }
  }
  return violations;
}

test("teardown: nobody imports the dropped folders and root modules, and none stands in the tree", () => {
  const files = serverFiles();
  assert.ok(files.length > 300, `only ${files.length} files - does the guard read the wrong tree?`);
  const violations = teardownViolations(files);
  assert.deepEqual(violations, [], `teardown violated:\n  ${violations.join("\n  ")}`);
  for (const o of DROPPED_FOLDER) assert.equal(fs.existsSync(path.join(SERVER_DIR, o)), false, `${o}/ is back in the tree`);
  for (const w of DROPPED_ROOTS) assert.equal(fs.existsSync(path.join(SERVER_DIR, w)), false, `${w} is back in the tree`);
});

test("counter-test teardown: an import fails - static, dynamic, as re-export, on a root, into the void; a file in the folder fails too", () => {
  assert.deepEqual(teardownViolations([file("channels/delivery.js", 'import { deliverToChat } from "../managing/proposal-ops.js";')]),
    [`channels/delivery.js: ${RULE_TEARDOWN} — ../managing/proposal-ops.js`]);
  assert.deepEqual(teardownViolations([file("runs/do-run.js", 'const m = await import("../administrator.js");')]),
    [`runs/do-run.js: ${RULE_TEARDOWN} — ../administrator.js`]);
  assert.deepEqual(teardownViolations([file("server.js", 'export { TOOL_CATALOG } from "./manager.js";')]),
    [`server.js: ${RULE_TEARDOWN} — ./manager.js`]);
  assert.deepEqual(teardownViolations([file("workspaces/routes.js", 'import { todoRoutes } from "../todos/routes.js";')]),
    [`workspaces/routes.js: ${RULE_TEARDOWN} — ../todos/routes.js`]);
  assert.deepEqual(teardownViolations([file("knowledge/facts.js", 'import * as store from "../store.js";')]),
    [`knowledge/facts.js: is back in the tree — ${RULE_TEARDOWN}`]);
  // Allowed: similar names that stay - the store topics, `ingest-schema` as a word.
  assert.deepEqual(teardownViolations([
    file("server.js", 'import * as store from "./store.js";'),
    file("store/managing.js", 'import { db } from "./db.js";'),
    file("projects/coding-jobs.js", 'import { x } from "../ingest-schema.js";'),
  ]), []);
});

// ── The MCP server and the store facade ──
//
// (j) `server/backend/electron/mcp/` is a PROCESS OF ITS OWN: the gateway starts it by path, it talks to the backend only
// over HTTP. A single `import` from `../server/…` would pull half the server into every tool call - and no guard would report
// it: the file set above reads ONLY SERVER_DIR. Counter-test 1 argues with the path "mcp/tools/chats.js", which the real run
// does not even reach (and which did not fit as `../../server.js` either - from `mcp/tools/` the way to the facade leads via
// `../../server/server.js`).
//
// The whole tree imports `node:process`, `../lib.js`, `./toolsets.js` and `./tools/*.js` - otherwise NOTHING. That is the promise.
function mcpFiles() {
  return fs.readdirSync(MCP_DIR, { recursive: true })
    .map((p) => String(p).split(path.sep).join("/"))
    .filter((p) => p.endsWith(".js") && !p.split("/").includes("node_modules"))
    .sort()
    .map((p) => ({ path: p, text: fs.readFileSync(path.join(MCP_DIR, p), "utf8") }));
}

test("MCP server: a process of its own - it imports only node:* and itself", () => {
  const files = mcpFiles();
  assert.ok(files.some((f) => f.path === "cbase-mcp.js"), "cbase-mcp.js is missing - wrong directory?");
  assert.ok(files.length >= 10, `only ${files.length} files under mcp/ - does the reader still work?`);
  console.log(`[import-direction] MCP tree: ${files.length} files, ${files.reduce((n, f) => n + importSpecifier(f.text).length, 0)} imports`);
  const violationsValue = [];
  for (const f of files) {
    for (const spec of importSpecifier(f.text)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        // Relative is allowed as long as it stays INSIDE the MCP tree.
        const targetValue = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), spec));
        if (!targetValue.startsWith("..")) continue;
        violationsValue.push(`${f.path}: leaves the MCP tree — ${spec}`);
        continue;
      }
      violationsValue.push(`${f.path}: foreign package — ${spec}`);
    }
  }
  assert.deepEqual(violationsValue, [],
    "The MCP server runs as a process of its own and talks to the backend over HTTP. An import " +
    "to the outside would pull the server into every tool call:\n  " + violationsValue.join("\n  "));
});

test("counter-test 9: an import from the server tree into mcp/ fails - also as a re-export", () => {
  // The same mechanics as the real run, only with a file set of its own.
  const check = (files) => {
    const out = [];
    for (const f of files) for (const spec of importSpecifier(f.text)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const targetValue = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), spec));
        if (!targetValue.startsWith("..")) continue;
        out.push(`${f.path}: leaves the MCP tree — ${spec}`);
        continue;
      }
      out.push(`${f.path}: foreign package — ${spec}`);
    }
    return out;
  };
  assert.deepEqual(check([file("tools/manager.js", 'import * as store from "../../server/store.js";')]),
    ["tools/manager.js: leaves the MCP tree — ../../server/store.js"]);
  assert.deepEqual(check([file("cbase-mcp.js", 'export { x } from "../server/manager.js";')]),
    ["cbase-mcp.js: leaves the MCP tree — ../server/manager.js"]);
  assert.deepEqual(check([file("lib.js", 'import express from "express";')]),
    ["lib.js: foreign package — express"]);
  // And what stands there today stays green.
  assert.deepEqual(check([file("tools/todos.js", 'import { api } from "../lib.js";', 'import process from "node:process";')]), []);
});

// (t) The store FACADE. Two guards touch it, neither says it: `schemaRegistry` (tree-rules.mjs) catches only `import { initStore }`
// from `store/db.js`, and counter-test 2 explicitly ALLOWS `runtime -> store/chats.js`. In the whole server tree there is
// exactly ONE importer of `store/<topic>.js`: the facade `store.js` itself. That is the promise - without a single exception
// today, and therefore the cheapest moment to pin it. Whoever breaks it bypasses `export *` and gets an import error at the
// next move of a function instead of a facade that follows.
test("store facade: outside store/ only store.js imports from store/<topic>.js", () => {
  const files = serverFiles();
  const violationsValue = [];
  for (const f of files) {
    if (f.path === "store.js" || f.path.startsWith("store/")) continue;
    for (const spec of importSpecifier(f.text)) {
      if (/(^|\/)store\/[a-z_-]+\.js$/.test(spec)) violationsValue.push(`${f.path}: bypasses the facade — ${spec}`);
    }
  }
  console.log(`[import-direction] store facade: ${files.filter((f) => f.path.startsWith("store/")).length} topic files, 1 importer (store.js)`);
  assert.deepEqual(violationsValue, [],
    "The data layer goes through the facade store.js (export * over store/). A direct import " +
    "bypasses it and breaks at the next move of a function:\n  " + violationsValue.join("\n  "));
});

test("counter-test 10: a direct import of store/<topic>.js fails - from the domain as from a leaf", () => {
  const check = (files) => {
    const out = [];
    for (const f of files) {
      if (f.path === "store.js" || f.path.startsWith("store/")) continue;
      for (const spec of importSpecifier(f.text)) if (/(^|\/)store\/[a-z_-]+\.js$/.test(spec)) out.push(`${f.path}: bypasses the facade — ${spec}`);
    }
    return out;
  };
  assert.deepEqual(check([file("chats/routes.js", 'import { getChat } from "../store/chats.js";')]),
    ["chats/routes.js: bypasses the facade — ../store/chats.js"]);
  assert.deepEqual(check([file("runtime/sse.js", 'import { getChat } from "../store/chats.js";')]),
    ["runtime/sse.js: bypasses the facade — ../store/chats.js"]);
  // The facade itself and the traffic INSIDE store/ stay green.
  assert.deepEqual(check([file("store.js", 'export * from "./store/chats.js";'), file("store/chats.js", 'import { db } from "./db.js";')]), []);
  // And anybody may use the facade as a whole.
  assert.deepEqual(check([file("chats/routes.js", 'import * as store from "../store.js";')]), []);
});

// ── Cycle freedom ──
// Direction is not cycle freedom. The three rules above and the hub measure WHERE an edge points - none of them sees that
// files lie in cycles (the test prints the count). They arose silently because nothing counted them, and the next one would
// get through the same way. A cycle is no error in itself (ESM loads it), it costs two things: none of the involved files is
// loadable alone any more and thus testable alone, and the TDZ turns a moved constant into a RUNTIME error instead of an
// error on reading (Tarjan, not grep).
//
// The build is that of `tools/check/loc-allow.json`: the stock stands NAMED (file set, reason, follow-up), it is PRINTED on
// every run, and it may only shrink. Red on a new cycle, on a grown known one, on two merged ones - and on an entry whose cycle
// no longer exists or has shrunk: a too wide entry would otherwise silently allow growing back. The edge set is the same as
// above (`importSpecifier`, relative, resolved); targets outside the file set are no edge IN it - otherwise the counter-tests
// below could not be built.
const CYCLES_ALLOWED = [
  {
    files: ["runs/auto-continue.js", "runs/do-run.js", "runs/limit-gate.js", "runs/post-run.js", "runs/queue.js"],
    reason: "DURATION-EXCEPTION: the mutually recursive turn machine. `do-run` calls `post-run`, `post-run` the follow-up run, `queue` enqueues, `limit-gate` parks, `auto-continue` wakes - 16 edges in both directions. Resolving it would mean rebuilding the turn, not tidying up.",
    followUpJob: "- (stays; given and undisputed)",
  },
  // Used to be ONE four-cycle via `delivery.js` -> a managing module; since the delivery lies in channels/deliver.js it has
  // split into pairs.
  {
    files: ["channels/delivery.js", "channels/messages.js"],
    reason: "`delivery.js` fetches files and origin text from `messages.js` (stageChannelFiles, channelOriginText), `messages.js` writes cards and delivers via `delivery.js` (channelCard, channelCapReached, deliverChannel) - intake and delivery of the same channel.",
    followUpJob: "- (stays; a pair inside one folder)",
  },
];

import { importCycles as cyclesFrom, cycleShort, cycleViolations } from "../../../tools/check/lib/import-cycles.mjs";

/**
 * The import cycles of the SERVER tree. The computation lives in `tools/check/lib/import-cycles.mjs` (the web has the same
 * guard, see web/test/import-cycles.test.mjs); only what is server-specific stays here: relative specifiers, resolved
 * against electron/server.
 * @param {{path: string, text: string}[]} files  paths relative to electron/server, posix
 * @returns {string[][]}
 */
export function importCycles(files) {
  return cyclesFrom(files, (f) => {
    const rel = f.path.split(path.sep).join("/");
    const targets = [];
    for (const spec of importSpecifier(f.text)) {
      if (!isRelative(spec)) continue;
      targets.push(resolved(rel, spec));
    }
    return targets;
  });
}

test("cycle freedom: Tarjan over the same edges - every cycle stands in CYCLES_ALLOWED, every entry has a cycle", () => {
  const files = serverFiles();
  const cycles = importCycles(files);
  // Printed on EVERY run, like the exception above: a silent list cannot be told from a forgotten one, and this one is a list
  // of debts - it should stand in the way on every run.
  for (const e of CYCLES_ALLOWED) {
    console.log(`[import-direction] cycle allowed ${cycleShort(e.files)}: ${e.files.join(", ")} — ${e.reason} FOLLOW-UP: ${e.followUpJob}`);
  }
  console.log(`[import-direction] measured: ${cycles.length} cycle(s) over ${cycles.reduce((n, k) => n + k.length, 0)} of ${files.length} files`);
  const violations = cycleViolations(cycles, CYCLES_ALLOWED);
  assert.deepEqual(violations, [], `cycle freedom violated:\n  ${violations.join("\n  ")}`);
});

test("counter-test 7: an edge back turns a chain into a cycle - red without an entry, with a too small entry too", () => {
  const chain = [
    file("runtime/http.js", 'import { db } from "../store.js";'),
    file("store.js", 'export * from "./store/db.js";'),
    file("store/db.js", 'import fs from "node:fs";'),
  ];
  assert.deepEqual(importCycles(chain), []);
  // The same chain, one edge back: a cycle over three files - and without an entry it is NEW.
  const cycle = [chain[0], chain[1], file("store/db.js", 'import { serveStatic } from "../runtime/http.js";')];
  assert.deepEqual(importCycles(cycle), [["runtime/http.js", "store.js", "store/db.js"]]);
  const fresh = cycleViolations(importCycles(cycle), []);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0], /^NEW cycle \[3\] runtime\/http\.js … store\/db\.js: runtime\/http\.js, store\.js, store\/db\.js — no entry/);
  // An entry over TWO of the three files does not cover it: the cycle has grown, the third stands there.
  const tooSmall = [{ files: ["runtime/http.js", "store.js"], reason: "counter-test", followUpJob: "counter-test" }];
  const grown = cycleViolations(importCycles(cycle), tooSmall);
  assert.equal(grown.length, 1);
  assert.match(grown[0], /GREW by 1: store\/db\.js/);
  // And with the full entry it is green - otherwise the list would be no permission, only an alarm.
  assert.deepEqual(cycleViolations(importCycles(cycle), [{ files: ["runtime/http.js", "store.js", "store/db.js"], reason: "counter-test", followUpJob: "counter-test" }]), []);
  // An edge that connects two known cycles is neither of them - it is named separately.
  const connected = [
    file("a/1.js", 'import { x } from "./2.js";'), file("a/2.js", 'import { x } from "./1.js";', 'import { y } from "../b/1.js";'),
    file("b/1.js", 'import { y } from "./2.js";'), file("b/2.js", 'import { y } from "./1.js";', 'import { x } from "../a/1.js";'),
  ];
  const two = [
    { files: ["a/1.js", "a/2.js"], reason: "counter-test", followUpJob: "counter-test" },
    { files: ["b/1.js", "b/2.js"], reason: "counter-test", followUpJob: "counter-test" },
  ];
  const together = cycleViolations(importCycles(connected), two);
  assert.equal(together.length, 1);
  assert.match(together[0], /pulls 2 known cycles together/);
  // A self-import is a cycle of one file - otherwise it would vanish between the components.
  assert.deepEqual(importCycles([file("runs/state.js", 'import { x } from "./state.js";')]), [["runs/state.js"]]);
  // An import on something outside the set is no edge IN it.
  assert.deepEqual(importCycles([file("runs/state.js", 'import { x } from "../store.js";')]), []);
  // An import IN A COMMENT is no edge - otherwise the guard would name a cycle that ESM never forms and that nobody can
  // resolve (the lesson from tools/check/lib/tree-rules.mjs).
  assert.deepEqual(importCycles([
    file("a/1.js", '/* import { x } from "./2.js"; */', 'import fs from "node:fs";'),
    file("a/2.js", '// import { x } from "./1.js";'),
  ]), []);
});

test("counter-test 8: the list may only shrink - an entry without a cycle and a too wide entry fail", () => {
  const cycle = [file("a/1.js", 'import { x } from "./2.js";'), file("a/2.js", 'import { x } from "./1.js";')];
  const full = { files: ["a/1.js", "a/2.js"], reason: "counter-test", followUpJob: "counter-test" };
  assert.deepEqual(cycleViolations(importCycles(cycle), [full]), []);
  // The cycle is resolved, the entry still stands: red, otherwise the debt would stand forever.
  const way = cycleViolations(importCycles([cycle[0], file("a/2.js", 'import fs from "node:fs";')]), [full]);
  assert.equal(way.length, 1);
  assert.match(way[0], /^Entry \[2\] a\/1\.js … a\/2\.js has no cycle anymore — remove it/);
  // The cycle has become smaller, the entry has not: also red - a too wide entry silently allows growing back, and exactly
  // that is what "the list may only shrink" protects against.
  const three = [file("a/1.js", 'import { x } from "./2.js";'), file("a/2.js", 'import { x } from "./1.js";'), file("a/3.js", 'import { x } from "./1.js";')];
  const shrunk = cycleViolations(importCycles(three), [{ files: ["a/1.js", "a/2.js", "a/3.js"], reason: "counter-test", followUpJob: "counter-test" }]);
  assert.equal(shrunk.length, 1);
  assert.match(shrunk[0], /SHRANK by 1: a\/3\.js are in no cycle anymore/);
  // BREAK-UP - the case this promise used to miss: an entry over four files, and the cycle breaks up into two pairs. Both
  // together still cover the full set, so "GREW" and "SHRANK" would both be silent - and the too wide entry would have
  // allowed the cycles to silently grow together again.
  const brokenUp = [
    file("a/1.js", 'import { x } from "./2.js";'), file("a/2.js", 'import { x } from "./1.js";'),
    file("a/3.js", 'import { y } from "./4.js";'), file("a/4.js", 'import { y } from "./3.js";'),
  ];
  assert.equal(importCycles(brokenUp).length, 2, "precondition: two separate cycles");
  const toFar = [{ files: ["a/1.js", "a/2.js", "a/3.js", "a/4.js"], reason: "counter-test", followUpJob: "counter-test" }];
  const breakup = cycleViolations(importCycles(brokenUp), toFar);
  assert.equal(breakup.length, 1, `the break-up must give EXACTLY one message: ${JSON.stringify(breakup)}`);
  assert.match(breakup[0], /BROKE UP into 2 cycles — one entry per cycle/);
  // And with two entries the same tree is green: the split is the cure, not the error.
  assert.deepEqual(cycleViolations(importCycles(brokenUp), [
    { files: ["a/1.js", "a/2.js"], reason: "counter-test", followUpJob: "counter-test" },
    { files: ["a/3.js", "a/4.js"], reason: "counter-test", followUpJob: "counter-test" },
  ]), []);
  // An entry without reason or without follow-up is none - that is the whole difference to a suppression. And the same file
  // in two entries makes the assignment ambiguous.
  assert.deepEqual(cycleViolations([], [{ files: ["a/1.js"], reason: "without follow-up" }]).slice(0, 1),
    ["Entry 1 incomplete — every cycle needs a file set, reason and follow-up job"]);
  const duplicate = cycleViolations(importCycles(cycle), [full, { files: ["a/2.js"], reason: "counter-test", followUpJob: "counter-test" }]);
  assert.ok(duplicate.some((v) => v.startsWith("a/2.js is in two entries")), duplicate.join("\n"));
});
