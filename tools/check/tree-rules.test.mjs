// The five guards over the server tree, each shown red once: (a) route functions, (b) declared == registered, (c) no back import onto the
// facade, (d) the hook register, (e) the schema register.
//
//  (a) Route functions are hoisted declarations and end with `return NEXT;` — without the sentinel a route that did not match falls
//      through as "matched", and the client waits until the deadline.
//  (b) Declared == registered — otherwise a route lies dead in the tree or the dispatcher calls something that does not exist.
//  (c) No back import onto the facade — only those named in the manifest.
//  (d) The hook register: every fired kind has a registrant in server.js, every registrant a call site, kind names are literals, the run
//      kinds are those of the spec — per check a red counter-test on the mini file set and a green one on the REAL tree (below).
//  (e) The schema register: every store/ topic file with DDL is registered in the registration list at the end of store.js — the signal is
//      the SQL, not a maintained list. A forgotten registration does not throw, it is silent (measured: 96 → 74 tables, no log).
//
// (a)–(c) synthetic: the rules are pure functions over [{ path, text }], which is what makes them checkable WITHOUT a deploy. (d) and (e)
// in addition on the working tree (treeRoutesInput like routes.test.mjs): the guard must be green on the tree the gate measures, otherwise
// the mini set's green would be a claim.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { treeRoutesInput } from "./lib/asar.mjs";
import { RUN_KINDS_SPEC, backImports, hookRegistry, hookRegistryText, routeRegistry, routeRuleViolations, schemaRegistry, schemaRegistryText } from "./lib/tree-rules.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = path.join(REPO, "server/backend/electron/server");

// A hoisted route function with an arbitrary body.
const fn = (name, body = "  if (ctx.p === \"/x\") return send(ctx.res, 200, {});\n") => `export async function ${name}(ctx) {\n${body}  return NEXT;\n}\n`;
const file = (path, text) => ({ path, text });

// ── (a) routeRuleViolations ──────────────────────────────────────────────────────────────────

test("(a) an arrow route is a violation — a TDZ in an import cycle", () => {
  const v = routeRuleViolations([file("a/routes.js", "export const aRoutes = async (ctx) => {\n  return NEXT;\n};\n")]);
  assert.equal(v.length, 1);
  assert.match(v[0], /^a\/routes\.js: aRoutes is an arrow route/);
  assert.match(v[0], /TDZ/);
});

test("(a) a function without `return NEXT;` at the end is a violation — and names the function", () => {
  const text = "export async function bRoutes(ctx) {\n  if (ctx.p === \"/x\") return send(ctx.res, 200, {});\n  return send(ctx.res, 404, {});\n}\n";
  const v = routeRuleViolations([file("b/routes.js", text)]);
  assert.equal(v.length, 1);
  assert.match(v[0], /^b\/routes\.js: bRoutes does not end with `return NEXT;`/);
  assert.match(v[0], /last line: return send\(ctx\.res, 404, \{\}\);/, "the last line is shown so one sees what stands there instead of the sentinel");
  // A sentinel in the middle of the body is not enough — it must be the last line.
  const middles = "export async function cRoutes(ctx) {\n  if (!ctx.p) return NEXT;\n  return send(ctx.res, 200, {});\n}\n";
  assert.equal(routeRuleViolations([file("c/routes.js", middles)]).length, 1);
});

test("(a) a correct function → no violations; several `return send(res, …)` in the body do not matter", () => {
  assert.deepEqual(routeRuleViolations([file("a/routes.js", fn("aRoutes"))]), []);
  // The sentinel only has to be the LAST line — before it any number of routes may return, also with blank lines and comments between.
  const body = [
    "  const { p, m, res } = ctx;",
    "  if (p === \"/api/a\" && m === \"GET\") return send(res, 200, { a: 1 });",
    "  if (p === \"/api/b\" && m === \"GET\") {",
    "    return send(res, 200, { b: 2 });",
    "  }",
    "",
    "  // Writing",
    "  if (p === \"/api/b\" && m === \"POST\") return send(res, 201, {});",
    "  if (p === \"/api/c\") return send(res, 405, {});",
    "",
  ].join("\n") + "\n";
  assert.deepEqual(routeRuleViolations([file("x/routes.js", fn("xRoutes", body))]), []);
  // Also with blank lines AFTER the sentinel (before the closing brace).
  assert.deepEqual(routeRuleViolations([file("y/routes.js", "export async function yRoute(ctx) {\n  return NEXT;\n\n\n}\n")]), []);
  // Two functions in one file: only the broken one is reported.
  const two = fn("goodRoutes") + "\nexport async function brokenRoutes(ctx) {\n  return send(ctx.res, 200, {});\n}\n";
  const v = routeRuleViolations([file("z/routes.js", two)]);
  assert.equal(v.length, 1);
  assert.match(v[0], /brokenRoutes/);
  assert.doesNotMatch(v[0], /goodRoutes/);
});

test("(a) functions that do not end in Route(s) are no route functions and are not checked", () => {
  const helper = "export async function readBody(ctx) {\n  return ctx.body;\n}\n";
  assert.deepEqual(routeRuleViolations([file("h/helpers.js", helper)]), []);
});

// ── (b) routeRegistry ────────────────────────────────────────────────────────────────────────

const SERVER_WITH_ROUTES = "import { aRoutes } from \"./a/routes.js\";\n\nconst ROUTES = [\n  aRoutes, // 123\n  bRoutes,\n  chatRoutes,\n];\n\nfor (const route of ROUTES) if ((await route(ctx)) !== NEXT) return;\n";
const CHATS = [
  "export async function chatRoutes(ctx) {",
  "  const cm = ctx.p.match(/^\\/api\\/chats\\/([^/]+)(\\/.*)?$/);",
  "  if (!cm) return NEXT;",
  "  for (const s of [coreChatRoutes, fileChatRoutes]) {",
  "    const r = await s(ctx);",
  "    if (r !== NEXT) return r;",
  "  }",
  "  return NEXT;",
  "}",
  "",
  fn("coreChatRoutes"),
  fn("fileChatRoutes"),
].join("\n");
const TREE = [
  file("server.js", SERVER_WITH_ROUTES),
  file("a/routes.js", fn("aRoutes")),
  file("b/routes.js", fn("bRoutes")),
  file("chats/routes.js", CHATS),
];

test("(b) server.js without `const ROUTES = [` → null (monolith: nothing to count)", () => {
  assert.equal(routeRegistry([file("server.js", "const wm = p.match(/x/);\n"), file("a/routes.js", fn("aRoutes"))]), null);
  // Likewise without server.js in the set.
  assert.equal(routeRegistry([file("a/routes.js", fn("aRoutes"))]), null);
});

test("(b) ROUTES literal plus the owner's sub-table: 3 on top, 2 below, 5 == 5, ok", () => {
  const r = routeRegistry(TREE);
  assert.ok(r);
  assert.equal(r.top, 3, "the comment behind aRoutes does not count");
  assert.deepEqual(r.subTables, [{ owner: "chatRoutes", names: ["coreChatRoutes", "fileChatRoutes"] }]);
  assert.equal(r.declared, 5);
  assert.equal(r.registered, 5);
  assert.deepEqual(r.unregistered, []);
  assert.deepEqual(r.undeclared, []);
  assert.equal(r.ok, true);
});

test("(b) counter-test: a declared function is missing from ROUTES → `unregistered` names it", () => {
  const set = [...TREE, file("d/routes.js", fn("dRoutes"))];
  const r = routeRegistry(set);
  assert.deepEqual(r.unregistered, ["dRoutes"]);
  assert.deepEqual(r.undeclared, []);
  assert.equal(r.declared, 6);
  assert.equal(r.ok, false);
  // A sub-slice the owner does not take into its table also lies dead in the tree.
  const withoutFile = TREE.map((f) => (f.path === "chats/routes.js" ? file(f.path, f.text.replace(", fileChatRoutes]", "]")) : f));
  assert.deepEqual(routeRegistry(withoutFile).unregistered, ["fileChatRoutes"]);
});

test("(b) counter-test: a name in ROUTES without a declaration → `undeclared` names it", () => {
  const set = TREE.map((f) => (f.path === "server.js" ? file(f.path, f.text.replace("  chatRoutes,\n", "  chatRoutes,\n  ghostsRoutes,\n")) : f));
  const r = routeRegistry(set);
  assert.deepEqual(r.undeclared, ["ghostsRoutes"]);
  assert.deepEqual(r.unregistered, []);
  assert.equal(r.top, 4);
  assert.equal(r.ok, false);
  // The same in a sub-table.
  const sub = TREE.map((f) => (f.path === "chats/routes.js" ? file(f.path, f.text.replace("fileChatRoutes]", "fileChatRoutes, ghostsChatRoutes]")) : f));
  assert.deepEqual(routeRegistry(sub).undeclared, ["ghostsChatRoutes"]);
});

test("(b) a name in ROUTES and a sub-table is counted only once — sets, not lists", () => {
  // coreChatRoutes registered twice (on top AND at the owner): no error of the rule, only a double call — and the count stays at five names.
  const set = TREE.map((f) => (f.path === "server.js" ? file(f.path, f.text.replace("  chatRoutes,\n", "  chatRoutes,\n  coreChatRoutes,\n")) : f));
  const r = routeRegistry(set);
  assert.equal(r.top, 4);
  assert.equal(r.registered, 5);
  assert.equal(r.ok, true);
});

// ── (c) backImports ──────────────────────────────────────────────────────────────────────────

test("(c) `from \"../server.js\"` in runs/x.js is a violation", () => {
  const r = backImports([file("runs/x.js", "import { doRun } from \"../server.js\";\n")]);
  assert.deepEqual(r.hits, [{ path: "runs/x.js", allowed: false }]);
  assert.deepEqual(r.violations, ["runs/x.js"]);
});

test("(c) with a manifest entry: the hit stays visible but is no violation", () => {
  const r = backImports([file("runs/x.js", "import { doRun } from \"../server.js\";\n")], ["runs/x.js"]);
  assert.deepEqual(r.hits, [{ path: "runs/x.js", allowed: true }]);
  assert.deepEqual(r.violations, []);
  // The permission applies only to the named path — a second file next to it stays a violation.
  const two = backImports([
    file("runs/x.js", "import { doRun } from \"../server.js\";\n"),
    file("runs/y.js", "import { doRun } from '../server.js';\n"),
  ], ["runs/x.js"]);
  assert.deepEqual(two.violations, ["runs/y.js"]);
});

test("(c) server.js itself never counts; `../../server.js` and `./server.js` count; other imports do not", () => {
  const r = backImports([
    file("server.js", "import { x } from \"./server.js\";\nimport { y } from \"../server.js\";\n"),
    file("mcp/tools/z.js", "import { doRun } from \"../../server.js\";\n"),
    file("neighbor.js", "import { doRun } from \"./server.js\";\n"),
    file("runs/ok.js", "import { DIRS } from \"../app-state.js\";\nimport { db } from \"../store/server.js\";\n"),
  ]);
  assert.deepEqual(r.violations, ["mcp/tools/z.js", "neighbor.js"]);
  assert.ok(!r.hits.some((h) => h.path === "server.js"), "the facade is a pure consumer and is not checked against itself");
  assert.ok(!r.hits.some((h) => h.path === "runs/ok.js"), "store/server.js is not the facade");
  // A server.js in a subpath is skipped as a facade too.
  assert.deepEqual(backImports([file("electron/server/server.js", "import { y } from \"../server.js\";\n")]).hits, []);
});

// Two findings of the first test session, both falsely red: the gate would have rejected valid code. Repaired in tree-rules.mjs; pinned here so they do not come back.
test("(b) a `]` in a comment does NOT close the ROUTES literal early", () => {
  const server = file("server.js", "const ROUTES = [\n  aRoutes, // see ]\n  bRoutes,\n];\n");
  const r = routeRegistry([server, file("a/routes.js", fn("aRoutes")), file("b/routes.js", fn("bRoutes"))]);
  assert.equal(r.top, 2, "bRoutes stands behind the comment and belongs in the literal");
  assert.deepEqual(r.unregistered, []);
  assert.equal(r.ok, true);
});

test("(b) `for (const n of [0, 1])` in the body of a route is no sub-table", () => {
  const server = file("server.js", "const ROUTES = [\n  aRoutes,\n];\n");
  const a = file("a/routes.js", fn("aRoutes", "  for (const n of [0, 1]) { if (n) return send(ctx.res, 200, {}); }\n"));
  const r = routeRegistry([server, a]);
  assert.deepEqual(r.subTables, []);
  assert.deepEqual(r.undeclared, []);
  assert.equal(r.ok, true);
});

// ── (d) hookRegistry ────────────────────────────────────────────────────────────────────────
// A mini tree in the form of the real one: the register file with the two lists and the declarations (whose first parameter is a
// VARIABLE — the file must not be read as a call site), server.js with the spec's run kinds (RUN_KINDS_SPEC) and one registrant per kind,
// three runs/ files with the calls. Two hook kinds, two switches — enough that every check has a neighbour that must stay green.
const HOOKS_JS = [
  "// Head: `fireHooks(\"<kind>\", …)` and `registerRunKind(\"ghost\", …)` as an example — does not count.",
  'export const HOOK_KINDS = Object.freeze(["afterRun", "end"]);',
  'export const SWITCHES_KINDS = Object.freeze(["verdict", "chat-location"]);',
  "export function registerHook(kind, fn, { name } = {}) { if (!name) throw new Error(`registerHook(${kind}): name`); }",
  "export function registerSwitch(kind, fn, { name } = {}) {}",
  "export function registerRunKind(name, provider, { detects } = {}) {}",
  "export async function fireHooks(kind, payload) {}",
  "export function turnout(kind, payload) {}",
  "export function runKindProvider(name) { throw new Error(`runKindProvider(${name})`); }",
].join("\n") + "\n";
const RUN_KIND_ROWS = RUN_KINDS_SPEC.map((n) => `registerRunKind("${n}", preparation, { detects });`);
// The lines of server.js depend on the number of run kinds (line 1 import, then one per run kind): `Z(k)` is the k-th line AFTER the last
// run kind — curate Z(1), end Z(3), verdict Z(4), an appended line Z(7). They are computed so that a dropped run kind does not shift
// six expectations.
const Z = (k) => 1 + RUN_KINDS_SPEC.length + k;
const SERVER_JS = [
  'import { registerHook, registerRunKind, registerSwitch } from "./runs/hooks.js";',
  ...RUN_KIND_ROWS,
  'registerHook("afterRun", curateHook, { name: "curate" });                    // do-run.js 1692',
  'registerHook("afterRun", autoTitleHook, { name: "auto-title" });',
  'registerHook("end", eventEndHook, { name: "chat-event" });',
  'registerSwitch("verdict", verdictSwitch, { name: "workflow" });',
  'registerSwitch("chat-location", managerLocationSwitch, { name: "manager-page" });',
  'registerSwitch("chat-location", secondLocationSwitch, { name: "second" });',
].join("\n") + "\n";
const DO_RUN = [
  'import { fireHooks } from "./hooks.js";',
  "/* Block comment with fireHooks(\"ghost\", {}) in it",
  "   across two lines */",
  'fireHooks("afterRun", { chat, cwd }); // behind the code: fireHooks("ghost", {})',
  "try { x(); } catch { /* fireHooks(\"ghost\") */ }",
  'fireHooks("end", { chat });',
].join("\n") + "\n";
const AUTO_CONTINUE = 'import { turnout } from "./hooks.js";\nconst answer = turnout("verdict", { at, chatId });\n';
const ASK = 'import { turnout } from "./hooks.js";\nconst place = turnout("chat-location", { chat }) || {};\n';
// Sorted bytewise by path like treeFiles — the call list comes back in file order.
const MINI = [
  file("runs/ask.js", ASK),
  file("runs/auto-continue.js", AUTO_CONTINUE),
  file("runs/do-run.js", DO_RUN),
  file("runs/hooks.js", HOOKS_JS),
  file("server.js", SERVER_JS),
];
// Replace one file of the mini set — replacement via a text function.
const including = (filePath, f) => MINI.map((d) => (d.path === filePath ? file(filePath, f(d.text)) : d));

test("(d) mini tree: 2 hook kinds / 2 switches / the spec's run kinds, registrants == calls, ok — comments do not count", () => {
  const r = hookRegistry(MINI);
  assert.ok(r);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.kinds, { hooks: ["afterRun", "end"], switches: ["verdict", "chat-location"] });
  assert.deepEqual(r.runKinds, [...RUN_KINDS_SPEC]);
  // Four call sites — the three "ghost" mentions (line comment, comment behind code, block comment across two lines, block comment in the
  // line) are none; and the line numbers are right DESPITE stripped lines.
  assert.deepEqual(r.calls, [
    { kind: "turnout", type: "chat-location", path: "runs/ask.js", line: 2 },
    { kind: "turnout", type: "verdict", path: "runs/auto-continue.js", line: 2 },
    { kind: "hook", type: "afterRun", path: "runs/do-run.js", line: 4 },
    { kind: "hook", type: "end", path: "runs/do-run.js", line: 6 },
  ]);
  assert.equal(r.registrations.length, 6 + RUN_KINDS_SPEC.length);
  assert.deepEqual(r.outsideRuns, []);
  assert.equal(hookRegistryText(r), `2 hook kinds / 2 switches / ${RUN_KINDS_SPEC.length} run kinds — registrants == calls (6 registrants, 4 call sites, all in runs/)`);
});

test("(d) without the register file or without server.js → null (nothing to count)", () => {
  assert.equal(hookRegistry(MINI.filter((d) => d.path !== "runs/hooks.js")), null);
  assert.equal(hookRegistry(MINI.filter((d) => d.path !== "server.js")), null);
});

test("(d1) a fired kind that is not in HOOK_KINDS → red with file:line; the same for a switch", () => {
  const r = hookRegistry(including("runs/do-run.js", (t) => t + 'fireHooks("afterRunn", { chat });\n'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["runs/do-run.js:7: fireHooks(\"afterRunn\", …) — \"afterRunn\" is not in HOOK_KINDS (runs/hooks.js)"]);
  const w = hookRegistry(including("runs/ask.js", (t) => t + 'turnout("chatplace", { chat });\n'));
  assert.deepEqual(w.violations, ["runs/ask.js:3: turnout(\"chatplace\", …) — \"chatplace\" is not in SWITCHES_KINDS (runs/hooks.js)"]);
});

test("(d2) a fired kind without a registrant in server.js → red and names the call site", () => {
  const r = hookRegistry(including("server.js", (t) => t.replace('registerHook("end", eventEndHook, { name: "chat-event" });\n', "")));
  assert.deepEqual(r.violations, ["Hook kind \"end\" is fired (runs/do-run.js:6), but has no registrant in server.js — register or delete"]);
  // A switch without a responder likewise — even if at run time it would only deliver `undefined`.
  const w = hookRegistry(including("server.js", (t) => t.replace('registerSwitch("verdict", verdictSwitch, { name: "workflow" });\n', "")));
  assert.deepEqual(w.violations, ["Switch kind \"verdict\" is asked (runs/auto-continue.js:2), but has no registrant in server.js — register or delete"]);
});

test("(d3) a registered kind without a call site → dead registrant; a kind in the list with neither → dead kind", () => {
  const r = hookRegistry(including("runs/do-run.js", (t) => t.replace('fireHooks("end", { chat });\n', "")));
  assert.deepEqual(r.violations, [`Hook kind "end" is registered (chat-event server.js:${Z(3)}), but is fired nowhere — dead registrant`]);
  const tot = hookRegistry(including("runs/hooks.js", (t) => t.replace('["verdict", "chat-location"]', '["verdict", "chat-location", "ghost"]')));
  assert.deepEqual(tot.violations, ["Switch kind \"ghost\" is in SWITCHES_KINDS, but is neither asked nor registered — dead kind, register or delete"]);
});

test("(d4) a registered kind that is not in the list → red with file:line", () => {
  const r = hookRegistry(including("server.js", (t) => t + 'registerHook("afterLimit", fn, { name: "x" });\n'));
  assert.deepEqual(r.violations, [`server.js:${Z(7)}: registerHook("afterLimit", …) — "afterLimit" is not in HOOK_KINDS (runs/hooks.js)`]);
});

test("(d5) runKindProvider(\"…\") in runs/ → red; outside not red but counted; the run kinds are EXACTLY those of the spec", () => {
  const r = hookRegistry(including("runs/do-run.js", (t) => t + 'const v = runKindProvider("manager");\n'));
  assert.deepEqual(r.violations, ["runs/do-run.js:7: runKindProvider(\"manager\") in runs/ — the hub knows no run kind names (doRun asks runKindFor(chat); the names stand only at the registration)"]);
  // Outside the hub (a test helper, a feature module) the name is allowed — it then stands as a call outside runs/.
  const outside = hookRegistry([...MINI, file("managing/runKinds.js", 'const v = runKindProvider("manager");\n')]);
  assert.deepEqual(outside.violations, []);
  assert.deepEqual(outside.outsideRuns, ["managing/runKinds.js:1"]);
  assert.match(hookRegistryText(outside), /1 of them outside runs\/: managing\/runKinds\.js:1/);
  // A run kind of the spec that is not registered is named. The spec is empty — the mechanism is shown with a probe spec (the same
  // check a real spec would hit).
  const five = hookRegistry(MINI, { runKindsSpec: ["context"] });
  assert.deepEqual(five.violations, ["Run kind \"context\" (RUN_KINDS_SPEC) is not registered in server.js — a chat of this kind would silently run as an ordinary one"]);
  // A further one: red until it is in RUN_KINDS_SPEC.
  const seven = hookRegistry(including("server.js", (t) => t + 'registerRunKind("sparring", preparation, { detects });\n'));
  assert.deepEqual(seven.violations, ["Run kind \"sparring\" is registered, but is not in RUN_KINDS_SPEC (tree-rules.mjs) — a further run kind is entered there so that it does not arise silently"]);
  // The dropped "registration" run kind does not silently come back: its old registration line in server.js is red — it is no longer in
  // the spec.
  assert.ok(!RUN_KINDS_SPEC.includes("registration"), "\"registration\" is no longer in RUN_KINDS_SPEC");
  const back = hookRegistry(including("server.js", (t) => t + 'registerRunKind("registration", preparationRegistration, { detects: isRegistrationAgent });\n'));
  assert.deepEqual(back.violations, ["Run kind \"registration\" is registered, but is not in RUN_KINDS_SPEC (tree-rules.mjs) — a further run kind is entered there so that it does not arise silently"]);
  // (d9) The same twice: a throw at run time, here one line.
  const duplicate = hookRegistry(including("server.js", (t) => t + 'registerRunKind("context", preparation, { detects });\nregisterRunKind("context", preparation, { detects });\n'), { runKindsSpec: ["context"] });
  assert.deepEqual(duplicate.violations, [`server.js:${Z(8)}: registerRunKind("context", …) — run kind is already registered (two providers would mean: one wins silently)`]);
  // The dropped "context" and "ingest" do not silently come back.
  for (const n of ["context", "ingest"]) {
    assert.ok(!RUN_KINDS_SPEC.includes(n), `"${n}" is no longer in RUN_KINDS_SPEC`);
    assert.equal(hookRegistry(including("server.js", (t) => t + `registerRunKind("${n}", preparation, { detects });\n`)).ok, false, `${n}: registered ⇒ red`);
  }
});

test("(d6) a NON-literal first parameter is red — variable, template, concatenation, at call as at registration", () => {
  const cases = [
    ["runs/do-run.js", 'const KIND = "end";\nfireHooks(KIND, { chat });\n', "runs/do-run.js:8: fireHooks(KIND, …) — first parameter"],
    ["runs/ask.js", 'turnout(`chat-${place}`, { chat });\n', "runs/ask.js:3: turnout(`chat-${place}`, …) — first parameter"],
    ["runs/ask.js", 'turnout("chat" + "-place", { chat });\n', "runs/ask.js:3: turnout(\"chat\" + \"-place\", …) — first parameter"],
    ["server.js", 'registerHook(END, fn, { name: "x" });\n', `server.js:${Z(7)}: registerHook(END, …) — first parameter`],
    ["server.js", 'registerSwitch(kind, fn, { name: "x" });\n', `server.js:${Z(7)}: registerSwitch(kind, …) — first parameter`],
    ["server.js", 'for (const n of NAMES) registerRunKind(n, preparation, { detects });\n', `server.js:${Z(7)}: registerRunKind(n, …) — first parameter`],
  ];
  for (const [filePath, addition, expected] of cases) {
    const r = hookRegistry(including(filePath, (t) => t + addition));
    assert.equal(r.ok, false, filePath + " " + addition);
    assert.ok(r.violations.some((v) => v.startsWith(expected)), `expected "${expected}", got:\n  ${r.violations.join("\n  ")}`);
    assert.ok(r.violations.every((v) => /not a string literal/.test(v)), "only the literal check fails — the kind is unknown, not wrong");
  }
  // The guard does NOT read the register file as a call site: `function fireHooks(kind, …)` and the error text `registerHook(${kind})` would otherwise be two false reds. `obj.turnout(x)` is the method of a foreign object and does not count — `reg.fireHooks(…)` via a namespace import does (the name is unambiguous).
  const foreign = hookRegistry(including("runs/ask.js", (t) => t + 'obj.turnout(x, {});\nmySwitch(y);\n'));
  assert.deepEqual(foreign.violations, []);
  const namespace = hookRegistry(including("runs/ask.js", (t) => t + 'import * as reg from "./hooks.js";\nreg.fireHooks(ART, {});\n'));
  assert.deepEqual(namespace.violations, ["runs/ask.js:4: fireHooks(ART, …) — first parameter is not a string literal (variable, template or concatenation); the guard reads kind names statically, a typo in one would otherwise slip through"]);
  const namespaceOk = hookRegistry(including("runs/ask.js", (t) => t + 'import * as reg from "./hooks.js";\nreg.fireHooks("afterRun", {});\n'));
  assert.equal(namespaceOk.calls.filter((a) => a.type === "afterRun").length, 2, "the namespace call is a second call site of afterRun");
});

test("(d7) `name` is unique per kind — the same name under two kinds is allowed; without a name red", () => {
  const r = hookRegistry(including("server.js", (t) => t + 'registerHook("afterRun", thirdHook, { name: "curate" });\n'));
  assert.deepEqual(r.violations, [`server.js:${Z(7)}: registerHook("afterRun", …, { name: "curate" }) — name "curate" is already registered under this kind (server.js:${Z(1)})`]);
  // "chat-event" stands in the real tree under `end` AND `afterAsk` — one name per kind, not global.
  const twoKinds = hookRegistry([...including("server.js", (t) => t + 'registerHook("afterAsk", fn, { name: "chat-event" });\n')]
    .map((d) => (d.path === "runs/hooks.js" ? file(d.path, d.text.replace('["afterRun", "end"]', '["afterRun", "end", "afterAsk"]')) : d))
    .map((d) => (d.path === "runs/ask.js" ? file(d.path, d.text + 'fireHooks("afterAsk", { chat });\n') : d)));
  assert.deepEqual(twoKinds.violations, []);
  const without = hookRegistry(including("server.js", (t) => t.replace('{ name: "workflow" }', "{ wait: false }")));
  assert.deepEqual(without.violations, [`server.js:${Z(4)}: registerSwitch("verdict", …) without { name: "…" } — the name appears in the log, in the trace and here`]);
  // A name in single quotes and a registration across two lines are read.
  const two = hookRegistry(including("server.js", (t) => t.replace('registerSwitch("verdict", verdictSwitch, { name: "workflow" });', "registerSwitch('verdict', verdictSwitch,\n  { name: 'workflow' });")));
  assert.deepEqual(two.violations, []);
  // An inline receiver with its own `);` in the body: the name stands BEHIND it and is still found.
  const inline = hookRegistry(including("server.js", (t) => t.replace('registerSwitch("verdict", verdictSwitch, { name: "workflow" });', 'registerSwitch("verdict", (p) => { const r = tu(p); return r; }, { name: "workflow" });')));
  assert.deepEqual(inline.violations, []);
});

test("(d8) a registration outside server.js is red — the registration list is ONE place", () => {
  const r = hookRegistry([...MINI, file("managing/chat.js", 'import { registerHook } from "../runs/hooks.js";\nregisterHook("afterRun", ownHook, { name: "own" });\n')]);
  assert.deepEqual(r.violations, ["managing/chat.js:2: registerHook(\"afterRun\", …) outside the registration list in server.js — the list is ONE place, no module registers itself"]);
  // Mentioned in a comment (as in a feature module of the real tree) is no registration.
  const comment = hookRegistry([...MINI, file("projects/coding-jobs.js", '// Registered in server.js (`registerRunKind("context", …)`), the form is in runs/hooks.js.\nexport const x = 1;\n')]);
  assert.deepEqual(comment.violations, []);
});

test("(d) several violations: the gate row names the first and the number of the others", () => {
  const r = hookRegistry(including("server.js", (t) => t + 'registerHook("afterLimit", fn, { name: "x" });\nregisterHook("afterRun", fn, { name: "curate" });\n'));
  assert.equal(r.violations.length, 2);
  assert.equal(hookRegistryText(r), `${r.violations[0]} (+1 more)`);
});

// ── (b) on the REAL tree ─────────────────────────────────────────────────────────────────────
//
// (d) and (e) were pinned on the real tree from the start, (b) was not: all (b) checks ran on synthetic file sets, and the guard reports
// `null` for a tree without a recognised ROUTES literal — which `check.mjs` prints as a NEUTRAL row, neither ok nor bad. Four behaviour-neutral
// spellings (`let`, `var`, two spaces, `Object.freeze([`) made the guard silent, and an unregistered route slipped through with it. The
// spellings are covered now; this check holds the link to the real tree so that the next, fifth spelling is LOUD instead of neutral.
test("(b) real tree: the ROUTES literal is found, registered == declared", () => {
  const r = routeRegistry(treeRoutesInput(SERVER_DIR));
  assert.ok(r, "no ROUTES literal found in the working tree — the route register would be silently OFF (gate row: neutral)");
  assert.deepEqual(r.unregistered, [], `declared but never registered (answers 404 in operation): ${r.unregistered.join(", ")}`);
  assert.deepEqual(r.undeclared, [], `registered but declared nowhere: ${r.undeclared.join(", ")}`);
  assert.equal(r.ok, true);
  assert.ok(r.registered >= 60, `only ${r.registered} registered routes — does the count still bite?`);
  console.log(`  [(b) real tree] ${r.registered} registered, ${r.declared} declared, ${r.subTables.length} sub-tables`);
});

test("(b) counter-test: four behaviour-neutral spellings of the table stay VISIBLE", () => {
  const files = treeRoutesInput(SERVER_DIR);
  const server = files.find((f) => /(^|\/)server\.js$/.test(f.path));
  assert.ok(server, "server.js is missing from the tree");
  const variants = [
    ["two spaces", (t) => t.replace("const ROUTES = [", "const ROUTES =  [")],
    ["let instead of const", (t) => t.replace("const ROUTES = [", "let ROUTES = [")],
    ["var instead of const", (t) => t.replace("const ROUTES = [", "var ROUTES = [")],
    ["without spaces", (t) => t.replace("const ROUTES = [", "const ROUTES=[")],
  ];
  for (const [name, edit] of variants) {
    const set = files.map((f) => (f === server ? { path: f.path, text: edit(f.text) } : f));
    const r = routeRegistry(set);
    assert.ok(r, `spelling "${name}" makes the guard silent (null) — the gate row would be neutral`);
    assert.equal(r.ok, true, `spelling "${name}" changes the verdict`);
  }
  // And in EVERY one of these spellings the guard still sees a missing registration. Sabotaged via `settingsRoutes` (the settings stay as
  // long as there is a UI). If the line is not in the real tree, the test is red instead of silent: without a hit the sabotage would be ineffective.
  assert.match(server.text, /\n\s*settingsRoutes,/, "settingsRoutes is no longer in ROUTES — the sabotage target needs a new name");
  for (const [name, edit] of variants) {
    const set = files.map((f) => (f === server ? { path: f.path, text: edit(f.text).replace(/\n\s*settingsRoutes,/, "\n") } : f));
    const r = routeRegistry(set);
    assert.ok(r, `"${name}" + missing registration: the guard is silent`);
    assert.equal(r.ok, false, `"${name}" + missing registration: the guard notices nothing`);
    assert.ok(r.unregistered.includes("settingsRoutes"), `"${name}": settingsRoutes not reported as unregistered — ${r.unregistered.join(", ")}`);
  }
});

// Pinned. The gate prints the numbers in its row.
test("(d) real tree: 18 hook kinds / 3 switches / 0 run kinds, registrants == calls, all calls in runs/", () => {
  const r = hookRegistry(treeRoutesInput(SERVER_DIR));
  assert.ok(r, "no register in the working tree — runs/hooks.js without HOOK_KINDS?");
  assert.deepEqual(r.violations, [], `hook register violated:\n  ${r.violations.join("\n  ")}`);
  assert.equal(r.ok, true);
  // The numbers are pins, not measurements — they move only with their cause (a kind added or dropped is updated here, deliberately).
  assert.equal(r.kinds.hooks.length, 18);
  // The switch count is a pin as well.
  assert.equal(r.kinds.switches.length, 3);
  // So is the run kind count.
  assert.equal(r.runKinds.length, 0);
  assert.deepEqual([...r.runKinds].sort(), [...RUN_KINDS_SPEC].sort());
  // Measured: today only the hub fires and asks. A call from the feature side would be no violation (warn in the gate), but a decision — hence the measurement stands here and not silently in a number.
  assert.deepEqual(r.outsideRuns, []);
  assert.match(hookRegistryText(r), /^18 hook kinds \/ 3 switches \/ 0 run kinds — registrants == calls \(\d+ registrants, \d+ call sites, all in runs\/\)$/);
  // And every registration is in server.js — the list is ONE place.
  assert.ok(r.registrations.every((a) => a.path === "server.js"));
});

// ── (e) schemaRegistry ───────────────────────────────────────────────────────────────────────
// A mini tree in the form of the real one: the register file (which DECLARES `registerSchema`/`runSchemata` — it must be read neither as a registration nor as a call site), the facade with the registration list, `store/db.js` with the one `runSchemata()` at the end of `initStore`, two topic files with DDL and two without. `store/todos.js` carries a COMMENTED-OUT `CREATE TABLE` — the false alarm that `withoutComments` must prevent.
const SCHEMA_JS = [
  "// Head: `registerSchema(\"intake\", initIngestSchema)` as an example — does not count.",
  "const schemata = [];",
  "export function registerSchema(name, fn) { schemata.push([name, fn]); }",
  "export function runSchemata() { for (const [, fn] of schemata) fn(); }",
  "export function schemaNames() { return schemata.map(([n]) => n); }",
].join("\n") + "\n";
const STORE_JS = [
  'export { initStore, nowMs } from "./store/db.js";',
  'export * from "./store/channels.js";',
  'export * from "./store/todos.js";',
  'import { registerSchema } from "./store/schema.js";',
  'import { initIngestSchema } from "./store/ingest-schema.js";',
  'import { initChannelSchema, migrateChannelHooksCleared } from "./store/channels.js";',
  'registerSchema("intake", initIngestSchema);',
  'registerSchema("channels", initChannelSchema);',
  'registerSchema("channel-hooks-cleared", migrateChannelHooksCleared);',
].join("\n") + "\n";
const DB_JS = [
  'import { runSchemata } from "./schema.js";',
  "export function initStore(dataDir) {",
  '  db.exec("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY)");',
  "  // CREATE TABLE IF NOT EXISTS adds no columns — they stand below as ALTER TABLE.",
  "  runSchemata();",
  "}",
].join("\n") + "\n";
const INGEST_SCHEMA_JS = 'import { db } from "./db.js";\nexport function initIngestSchema() {\n  db.exec("CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY)");\n}\n';
const CHANNELS_JS = 'import { db } from "./db.js";\nexport function initChannelSchema() {\n  db.exec("CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY)");\n}\nexport function migrateChannelHooksCleared() {\n  db.exec("ALTER TABLE channels ADD COLUMN hooks TEXT");\n}\n';
const TODOS_JS = 'import { db } from "./db.js";\n// Formerly here: CREATE TABLE IF NOT EXISTS todos_old (…) — the table is gone.\nexport function listTodos() { return db.prepare("SELECT * FROM todos").all(); }\n';
const UTIL_JS = "export const TS = (v) => Math.trunc(Number(v) || 0);\n";
const MINI_STORE = [
  file("store.js", STORE_JS),
  file("store/_util.js", UTIL_JS),
  file("store/channels.js", CHANNELS_JS),
  file("store/db.js", DB_JS),
  file("store/ingest-schema.js", INGEST_SCHEMA_JS),
  file("store/schema.js", SCHEMA_JS),
  file("store/todos.js", TODOS_JS),
];
const withStore = (filePath, f) => MINI_STORE.map((d) => (d.path === filePath ? file(filePath, f(d.text)) : d));

test("(e) mini tree: 3 schemas from 2 topic files, DDL == registration, ok — a commented-out CREATE TABLE is no carrier", () => {
  const r = schemaRegistry(MINI_STORE);
  assert.ok(r);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.carrier, ["store/channels.js", "store/ingest-schema.js"]);
  assert.deepEqual(r.topicFiles, ["store/channels.js", "store/ingest-schema.js"]);
  assert.deepEqual(r.schemata.map((s) => [s.kind, s.fn, s.file]), [
    ["intake", "initIngestSchema", "store/ingest-schema.js"],
    ["channels", "initChannelSchema", "store/channels.js"],
    ["channel-hooks-cleared", "migrateChannelHooksCleared", "store/channels.js"],
  ]);
  assert.equal(schemaRegistryText(r), "3 schemas from 2 topic files — DDL == registration");
});

test("(e) without store/schema.js or without store.js → null (no register, nothing to count)", () => {
  assert.equal(schemaRegistry(MINI_STORE.filter((d) => d.path !== "store/schema.js")), null);
  assert.equal(schemaRegistry(MINI_STORE.filter((d) => d.path !== "store.js")), null);
});

test("(e1) a NEW topic file with CREATE TABLE, registration forgotten → red: the case from the origin", () => {
  const r = schemaRegistry([...MINI_STORE, file("store/subscriptions.js", 'import { db } from "./db.js";\nexport function initSubscriptionSchema() {\n  db.exec("CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY)");\n}\n')]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["store/subscriptions.js carries schema (CREATE/ALTER TABLE), but is not registered in the schema registry — without registration its tables silently do not arise (registration list: store.js)"]);
});

test("(e2) a dropped registration → the same message for the topic file that thereby becomes homeless", () => {
  const r = schemaRegistry(withStore("store.js", (t) => t.replace('registerSchema("intake", initIngestSchema);\n', "")));
  assert.deepEqual(r.violations, ["store/ingest-schema.js carries schema (CREATE/ALTER TABLE), but is not registered in the schema registry — without registration its tables silently do not arise (registration list: store.js)"]);
});

test("(e3) a registration outside the facade → red; the registration list is ONE place", () => {
  const r = schemaRegistry(withStore("store/channels.js", (t) => 'import { registerSchema } from "./schema.js";\nregisterSchema("channels", initChannelSchema);\n' + t));
  assert.ok(r.violations.some((v) => v === "store/channels.js:2: registerSchema(\"channels\", …) outside the registration list in store.js — the list is ONE place, no module registers itself"), r.violations.join("\n"));
});

test("(e4) first parameter as variable, template or concatenation → red with file:row", () => {
  for (const [addition, expected] of [
    ['const NAME = "intake";\nregisterSchema(NAME, initIngestSchema);\n', "store.js:11: registerSchema(NAME, …) — first parameter"],
    ["registerSchema(`in${x}`, initIngestSchema);\n", "store.js:10: registerSchema(`in${x}`, …) — first parameter"],
    ['registerSchema("in" + "take", initIngestSchema);\n', 'store.js:10: registerSchema("in" + "take", …) — first parameter'],
  ]) {
    const r = schemaRegistry(withStore("store.js", (t) => t + addition));
    assert.equal(r.ok, false, addition);
    assert.ok(r.violations.some((v) => v.startsWith(expected)), `expected "${expected}", got:\n  ${r.violations.join("\n  ")}`);
  }
});

test("(e5) runSchemata() dropped from db.js → red; twice likewise", () => {
  const way = schemaRegistry(withStore("store/db.js", (t) => t.replace("  runSchemata();\n", "")));
  assert.deepEqual(way.violations, ["runSchemata() appears 0 times in the tree (nowhere) — exactly once, at the end of initStore in store/db.js; otherwise the schemas do not run at all or run twice"]);
  const twice = schemaRegistry(withStore("store/todos.js", (t) => t + "runSchemata();\n"));
  assert.ok(twice.violations.some((v) => v.startsWith("runSchemata() appears 2 times in the tree")), twice.violations.join("\n"));
});

test("(e6) a registered function called by hand → red: the order would stand in two places", () => {
  const r = schemaRegistry(withStore("store/todos.js", (t) => t + 'import { initIngestSchema } from "./ingest-schema.js";\ninitIngestSchema();\n'));
  assert.deepEqual(r.violations, ["store/todos.js:5: initIngestSchema() called by hand — schemas run via runSchemata(), otherwise the order stands in two places"]);
});

test("(e7) duplicate registration name and a registrant pointing nowhere → red", () => {
  const duplicate = schemaRegistry(withStore("store.js", (t) => t + 'registerSchema("channels", migrateChannelHooksCleared);\n'));
  assert.deepEqual(duplicate.violations, ["store.js:10: registerSchema(\"channels\", …) — the name is already registered (store.js:8); at run time that throws, here it stands in the gate"]);
  const empty = schemaRegistry(withStore("store.js", (t) => t + 'registerSchema("ghost", initGhostSchema);\n'));
  assert.deepEqual(empty.violations, ["store.js:10: registerSchema(\"ghost\", initGhostSchema) — initGhostSchema is not imported in store.js; the registrant points nowhere"]);
});

test("(e8) `import { initStore }` from store/db.js outside store/ → red: the way past the registration list", () => {
  const r = schemaRegistry([...MINI_STORE, file("managing/chat.js", 'import { initStore } from "../store/db.js";\ninitStore("/tmp/x");\n')]);
  assert.deepEqual(r.violations, ['managing/chat.js:1: import { initStore } from store/db.js — past the store.js facade, and with it past the registration list (the registry would be empty)']);
});

// The REAL tree: what `./check` measures. Pinned are the CARRIERS (the files with DDL) and the number of registrations;
// whoever registers another one updates the number here, deliberately. The numbers stand only in the assertions, not in the title.
test("(e) real tree: DDL == registration, the named schemas and topic files", () => {
  const r = schemaRegistry(treeRoutesInput(SERVER_DIR));
  assert.ok(r, "no register in the working tree — store/schema.js missing?");
  assert.deepEqual(r.violations, [], `schema register violated:\n  ${r.violations.join("\n  ")}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.carrier, ["store/account.js", "store/agenda-upkeep.js", "store/agenda.js", "store/channels.js", "store/chat-search.js", "store/chats.js", "store/dynworkflow-runs.js", "store/dynworkflows.js", "store/graph-starts.js", "store/instructions.js", "store/outer-loop.js", "store/preview-links.js", "store/project-instances.js", "store/project-layout.js", "store/project-relocations.js", "store/project-setup.js", "store/runs.js", "store/scheduled.js", "store/skill-history.js", "store/stack-copies.js", "store/subagents.js", "store/timeline.js", "store/toolchain.js", "store/ultracode-reminder.js"]);
  assert.deepEqual(r.topicFiles, ["store/account.js", "store/agenda-upkeep.js", "store/agenda.js", "store/channels.js", "store/chat-search.js", "store/chats.js", "store/dynworkflow-runs.js", "store/dynworkflows.js", "store/graph-starts.js", "store/instructions.js", "store/outer-loop.js", "store/preview-links.js", "store/project-instances.js", "store/project-layout.js", "store/project-relocations.js", "store/project-setup.js", "store/runs.js", "store/scheduled.js", "store/skill-history.js", "store/stack-copies.js", "store/subagents.js", "store/timeline.js", "store/toolchain.js", "store/ultracode-reminder.js"]);
  assert.equal(r.schemata.length, 37);
  assert.ok(r.schemata.every((s) => s.path === "store.js"), "every registration is in the facade — the list is ONE place");
  assert.equal(schemaRegistryText(r), "37 schemas from 24 topic files — DDL == registration");
});
