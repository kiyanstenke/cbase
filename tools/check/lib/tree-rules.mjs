// Guards over the server tree — pure functions over a file set [{ path, text }], so they can be
// checked WITHOUT a deploy (tree-rules.test.mjs shows each guard red once).
//
// Five rules, each from a measured trap:
//  (a) Route functions are hoisted declarations (`export async function xRoutes(ctx)`), NEVER
//      `export const x = async …` — in an import cycle that would be a TDZ while loading the ROUTES list.
//      And each ends with `return NEXT;` — without the sentinel a route that did not match falls through
//      as "matched", the dispatcher returns, and the client waits until the deadline.
//  (b) Every declared route function is registered (ROUTES literal in server.js or a sub-table of an
//      owner) and every registered name is declared — otherwise a route lies dead in the tree or the
//      dispatcher calls something that does not exist.
//  (c) No file under electron/server imports `../server.js` back — the facade is a pure consumer.
//      Named back imports may be allowed (manifest); the list is empty by default.
//  (d) The hook registry: every kind that `runs/` fires or asks has a registrant in server.js and every
//      registrant has a call site — statically from the source, and exactly for that reason kind names
//      are string literals in both places.
//  (e) The schema registry: every `store/` topic file that carries DDL is registered in the registration
//      list at the end of `store.js` — the signal is the SQL itself, not a declaration the same forgetful
//      person would also have forgotten. A missing registration does not throw, it stays silent: the
//      tables silently do not arise.

const ROUTE_FN = /^export async function (\w+Routes?)\(/gm;
const ARROW_ROUTE = /^export const (\w+Routes?) = async/gm;

// Body of a hoisted declaration: up to the first line that is exactly `}`.
function functionBody(text, start) {
  const rest = text.slice(start);
  const end = rest.search(/\n\}\s*$/m);
  return end < 0 ? rest : rest.slice(0, end);
}

// (a) Arrow routes and route functions without `return NEXT;` at the end.
export function routeRuleViolations(files) {
  const out = [];
  for (const f of files) {
    for (const m of f.text.matchAll(ARROW_ROUTE)) out.push(`${f.path}: ${m[1]} is an arrow route (export const … = async) — a TDZ in the cycle`);
    for (const m of f.text.matchAll(ROUTE_FN)) {
      const body = functionBody(f.text, m.index);
      const lines = body.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
      const last = lines[lines.length - 1] || "";
      if (!/^\s*return NEXT;$/.test(last)) out.push(`${f.path}: ${m[1]} does not end with \`return NEXT;\` (last line: ${last.trim().slice(0, 60)})`);
    }
  }
  return out;
}

// Names from an array literal that starts at `start` (up to the closing `]`).
// Comments are dropped BEFORE the bracket count — a `]` in `// see ]` otherwise closed the literal
// early (wrong red, but red).
function namesInArray(text, start) {
  const rest = text.slice(start).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const open = rest.indexOf("[");
  if (open < 0) return [];
  let depth = 0;
  let i = open;
  for (; i < rest.length; i++) {
    if (rest[i] === "[") depth++;
    else if (rest[i] === "]" && --depth === 0) break;
  }
  return rest.slice(open + 1, i).split(",").map((s) => s.trim()).filter((s) => /^\w+$/.test(s));
}

// A sub-table is an array of route names — `for (const n of [0, 1])` in the body of a route is
// not one (digits passed `^\w+$`).
const ROUTE_NAME = /^\w+Routes?$/;

// (b) Declared against registered route functions. `null` while server.js carries no ROUTES literal
// (monolith) — then there is nothing to count.
//
// The pattern used to be `const ROUTES = [`, CHARACTER-EXACT. Measured cost: `const ROUTES =  [` (two
// spaces, behaviour-neutral) gave `null`, the gate line reported NEUTRAL, not bad — and a declared,
// never registered route slipped through in the same move, answered 404 in operation, and nothing went
// red. Likewise with `let`, `var` and `Object.freeze([`. Hence tolerant in the whitespace, and hence
// `tools/check/tree-rules.test.mjs` also pins the rule on the REAL tree (`assert.ok(r)`) — as (d) and
// (e) already do. `null` stays the answer for a tree WITHOUT a table; it must just no longer be the
// answer for a differently formatted one.
export function routeRegistry(files) {
  const server = files.find((f) => /(^|\/)server\.js$/.test(f.path));
  if (!server) return null;
  const at = server.text.search(/\b(?:const|let|var)\s+ROUTES\s*=\s*(?:Object\.freeze\(\s*)?\[/);
  if (at < 0) return null;
  const registered = new Set(namesInArray(server.text, at));
  const declared = new Set();
  const subTables = [];
  for (const f of files) {
    for (const m of f.text.matchAll(ROUTE_FN)) {
      declared.add(m[1]);
      const body = functionBody(f.text, m.index);
      // Sub-table of an owner: `for (const s of [a, b, …])`.
      for (const t of body.matchAll(/for \(const \w+ of \[/g)) {
        const names = namesInArray(body, t.index);
        if (!names.length || !names.every((n) => ROUTE_NAME.test(n))) continue;
        subTables.push({ owner: m[1], names });
        for (const n of names) registered.add(n);
      }
    }
  }
  const unregistered = [...declared].filter((n) => !registered.has(n));
  const undeclared = [...registered].filter((n) => !declared.has(n));
  return {
    top: namesInArray(server.text, at).length,
    subTables,
    declared: declared.size,
    registered: registered.size,
    unregistered,
    undeclared,
    ok: !unregistered.length && !undeclared.length,
  };
}

// (c) Back imports onto the facade. `allowed` are relative paths (to electron/server) that may
// carry them temporarily.
export function backImports(files, allowed = []) {
  const ok = new Set(allowed);
  const hits = [];
  for (const f of files) {
    if (/(^|\/)server\.js$/.test(f.path)) continue;
    if (/from\s+["'](\.\.\/)+server\.js["']|from\s+["']\.\/server\.js["']/.test(f.text)) {
      hits.push({ path: f.path, allowed: ok.has(f.path) });
    }
  }
  return { hits, violations: hits.filter((h) => !h.allowed).map((h) => h.path) };
}

// ── (d) The hook registry ────────────────────────────────────────────────────────────────────
// What the guard reads: in `runs/hooks.js` the frozen lists `HOOK_KINDS`/`SWITCHES_KINDS`, in
// `server.js` the registrations `registerHook("<kind>", fn, { name })`, `registerSwitch("<kind>", fn,
// { name })`, `registerRunKind("<name>", fn, …)`, and in the whole tree the calls `fireHooks("<kind>", …)`,
// `turnout("<kind>", …)`, `runKindProvider("<name>")`. Why static: a typo in a kind would only throw at
// run time, at the place where it is fired — for `afterLimitCancel` that is a discarded wait row at the
// usage limit, not the start. The guard sees it in the gate.
//
// Nine checks:
//   (1) every fired hook kind and every asked switch kind is in its list;
//   (2) every fired/asked kind has at least one registrant — a declared, fired kind without a taker is
//       red (whoever only declares a kind registers it or deletes it);
//   (3) every registered kind has at least one call site — otherwise a registrant lies dead in the tree;
//       and a kind in the list that is neither fired nor registered is a dead kind;
//   (4) every registered kind is in its list;
//   (5) `runKindProvider("<name>")` in `runs/` is red — the hub knows no run kind names (doRun asks
//       `runKindFor(chat)`); the registered run kinds are EXACTLY those of RUN_KINDS_SPEC (currently none;
//       testing the mechanism passes `{ runKindsSpec }` in);
//   (6) a NON-literal first parameter (variable, template, concatenation) to one of the six functions
//       is red with file:line — the guard could not read it, and exactly that typo would slip through;
//   (7) `name` unique per kind and present as a literal (at run time that throws anyway — static here,
//       so it stands in the gate and not at the first start after the deploy);
//   (8) registrations stand ONLY in server.js — the registration list is ONE place (no module registers
//       itself on load, otherwise the order would be the import order);
//   (9) a run kind is registered only once (a double registration throws at run time; static here).
//
// Comments are dropped BEFORE searching (withoutComments) — the head of hooks.js quotes
// `fireHooks("<kind>", …)` as an example, a topic module may mention `registerRunKind("<name>", …)`
// in a comment; either would otherwise count as a call or as a registration outside the list (an
// example in explanatory text counts as a use). The register file itself (the one with `HOOK_KINDS`)
// is NOT read for calls: it DECLARES the six functions (`export function fireHooks(kind, …)` — first
// parameter a variable) and names them in its error texts (`registerHook(${kind}): …`); both would be
// a false red under (6). Limit of the promise: a call with a literal INSIDE hooks.js itself would stay
// invisible — the registry does not call itself, and import-direction.test.js keeps it a leaf without imports.

// The run kinds of the spec: currently none. A further one is entered here — and only here: the
// registration in server.js alone turns the guard red, so a new run kind does not arise silently. A name
// that is missing here but still registered in server.js is equally red (a deleted run kind must not
// live on silently).
export const RUN_KINDS_SPEC = Object.freeze([]);

// Call and registration functions with their genus. `turnout` only lowercase and as its own word —
// `registerSwitch`, `approvalSwitch`, `verdictSwitch` carry the capital S and are no calls of the switch.
const CALL_FN = { fireHooks: "hook", turnout: "turnout", runKindProvider: "runKind" };
const REGISTER_FN = { registerHook: "hook", registerSwitch: "turnout", registerRunKind: "runKind" };
// Not part of a longer name, not the declaration (`function fireHooks(` — that one stands in the
// register file, which is skipped anyway, and in a mini file set of the tests). After `.` the call
// counts too: `reg.fireHooks("…")` via a namespace import is the same call — only the generic
// `turnout` does not (`obj.turnout(x)` is the method of a foreign object, see placesIn).
const CALL_RE = /(?<![\w$])(?<!function\s+)(fireHooks|turnout|runKindProvider|registerHook|registerSwitch|registerRunKind)\(\s*/g;
// A literal is only what stands ALONE up to the comma or the parenthesis — `"chat" + "-place"` starts with a
// literal and is still a concatenation (counter-test d6).
const LITERAL_RE = /^(?:"([^"\\\n]*)"|'([^'\\\n]*)')\s*(?=[,)])/;
const GENUS = { hook: "Hook kind", turnout: "Switch kind", runKind: "Run kind" };
const LIST = { hook: "HOOK_KINDS", turnout: "SWITCHES_KINDS" };

// Comments gone, line breaks stay (the messages name file:line). Order with a reason: first
// the `//` lines, then `/* … */` — a `//` line may contain `/**` (permissions.js: "Read(src/**)")
// and would otherwise open a block comment that swallows real code up to the next `*/`.
// Block comments only if they start at the line start or end on the same line — a `**/*.ts`
// in a string (tool-runtime.js) is no comment. A ` // …` after code goes with it; `http://`
// has no space before it and stays.
function withoutComments(text) {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (m) => m.replace(/[^\n]/g, ""));
}

const rowOf = (text, index) => text.slice(0, index).split("\n").length;

// The text of a call's arguments whose opening parenthesis already lies behind us: up to the closing
// one at depth zero. Parentheses in strings count too — kind and hook names carry none.
function argsValue(to) {
  let depth = 1;
  for (let i = 0; i < to.length; i++) {
    if (to[i] === "(") depth++;
    else if (to[i] === ")" && --depth === 0) return to.slice(0, i);
  }
  return to;
}

// The literals of an `export const NAME = Object.freeze([ … ])` — `null` if the list does not exist.
function literalsTheList(text, name) {
  const at = text.search(new RegExp(`export const ${name} = `));
  if (at < 0) return null;
  const rest = text.slice(at);
  const open = rest.indexOf("[");
  const close = rest.indexOf("]", open);
  if (open < 0 || close < 0) return null;
  return [...rest.slice(open + 1, close).matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

// All calls and registrations of a file: `{ fn, kind, type, literal, path, line, name }` — `type` is the first
// parameter (for a non-literal the start of the expression), `name` the `{ name: "…" }` of a registration.
function placesIn(f) {
  const text = withoutComments(f.text);
  const out = [];
  for (const m of text.matchAll(CALL_RE)) {
    const fn = m[1];
    if (fn === "turnout" && text[m.index - 1] === ".") continue;
    const to = text.slice(m.index + m[0].length);
    const lit = to.match(LITERAL_RE);
    const place = {
      fn,
      kind: CALL_FN[fn] || REGISTER_FN[fn],
      login: fn in REGISTER_FN,
      literal: !!lit,
      type: lit ? (lit[1] ?? lit[2]) : to.split(/[,)\n]/)[0].trim().slice(0, 40),
      path: f.path,
      line: rowOf(text, m.index),
      name: null,
    };
    if (place.login && fn !== "registerRunKind") {
      // The name stands in THIS call — up to the parenthesis that closes it (counted, not the first `);`:
      // an inline taker `(p) => { tu(p); }` would otherwise have faked the end).
      const n = argsValue(to).match(/\bname:\s*(?:"([^"\n]*)"|'([^'\n]*)')/);
      place.name = n ? (n[1] ?? n[2]) : null;
    }
    out.push(place);
  }
  return out;
}

const isRuns = (p) => /(^|\/)runs\/[^/]+$/.test(p);
const location = (s) => `${s.path}:${s.line}`;

export function hookRegistry(files, { runKindsSpec = RUN_KINDS_SPEC } = {}) {
  const server = files.find((f) => /(^|\/)server\.js$/.test(f.path));
  const register = files.find((f) => /export const HOOK_KINDS = /.test(f.text));
  if (!server || !register) return null;
  const registerText = withoutComments(register.text);
  const kinds = { hooks: literalsTheList(registerText, "HOOK_KINDS") || [], switches: literalsTheList(registerText, "SWITCHES_KINDS") || [] };
  const listen = { hook: new Set(kinds.hooks), turnout: new Set(kinds.switches) };

  const places = files.filter((f) => f !== register).flatMap(placesIn);
  const violations = [];
  // (6) first: what is no literal cannot stand in any set below — the message names the expression.
  for (const s of places.filter((s) => !s.literal)) {
    violations.push(`${location(s)}: ${s.fn}(${s.type || "…"}, …) — first parameter is not a string literal (variable, template or concatenation); the guard reads kind names statically, a typo in one would otherwise slip through`);
  }
  const literal = places.filter((s) => s.literal);
  const registrations = literal.filter((s) => s.login);
  const calls = literal.filter((s) => !s.login);

  // (8) The registration list is ONE place.
  for (const s of registrations.filter((s) => s.path !== server.path)) {
    violations.push(`${location(s)}: ${s.fn}("${s.type}", …) outside the registration list in server.js — the list is ONE place, no module registers itself`);
  }

  // Hooks and switches: (1) (2) (3) (4) (7).
  for (const kind of ["hook", "turnout"]) {
    const list = listen[kind];
    const fired = new Map();
    const registered = new Map();
    for (const s of calls.filter((s) => s.kind === kind)) (fired.get(s.type) || fired.set(s.type, []).get(s.type)).push(s);
    for (const s of registrations.filter((s) => s.kind === kind)) (registered.get(s.type) || registered.set(s.type, []).get(s.type)).push(s);
    const verb = kind === "hook" ? "fired" : "asked";
    for (const [kindName, ss] of fired) {
      if (!list.has(kindName)) for (const s of ss) violations.push(`${location(s)}: ${s.fn}("${kindName}", …) — "${kindName}" is not in ${LIST[kind]} (runs/hooks.js)`);
    }
    for (const [kindName, ss] of registered) {
      if (!list.has(kindName)) for (const s of ss) violations.push(`${location(s)}: ${s.fn}("${kindName}", …) — "${kindName}" is not in ${LIST[kind]} (runs/hooks.js)`);
      // (7) Name unique per kind, and present.
      const seen = new Map();
      for (const s of ss) {
        if (s.name == null) { violations.push(`${location(s)}: ${s.fn}("${kindName}", …) without { name: "…" } — the name appears in the log, in the trace and here`); continue; }
        if (seen.has(s.name)) violations.push(`${location(s)}: ${s.fn}("${kindName}", …, { name: "${s.name}" }) — name "${s.name}" is already registered under this kind (${location(seen.get(s.name))})`);
        else seen.set(s.name, s);
      }
    }
    for (const kindName of list) {
      const g = fired.get(kindName) || [];
      const a = registered.get(kindName) || [];
      if (g.length && !a.length) violations.push(`${GENUS[kind]} "${kindName}" is ${verb} (${g.map(location).join(", ")}), but has no registrant in server.js — register or delete`);
      else if (!g.length && a.length) violations.push(`${GENUS[kind]} "${kindName}" is registered (${a.map((s) => `${s.name} ${location(s)}`).join(", ")}), but is ${verb} nowhere — dead registrant`);
      else if (!g.length && !a.length) violations.push(`${GENUS[kind]} "${kindName}" is in ${LIST[kind]}, but is neither ${verb} nor registered — dead kind, register or delete`);
    }
  }

  // Run kinds: (5) and (9).
  for (const s of calls.filter((s) => s.kind === "runKind" && isRuns(s.path))) {
    violations.push(`${location(s)}: runKindProvider("${s.type}") in runs/ — the hub knows no run kind names (doRun asks runKindFor(chat); the names stand only at the registration)`);
  }
  const runKinds = [];
  for (const s of registrations.filter((s) => s.kind === "runKind")) {
    if (runKinds.includes(s.type)) violations.push(`${location(s)}: registerRunKind("${s.type}", …) — run kind is already registered (two providers would mean: one wins silently)`);
    else runKinds.push(s.type);
  }
  for (const n of runKindsSpec) if (!runKinds.includes(n)) violations.push(`Run kind "${n}" (RUN_KINDS_SPEC) is not registered in server.js — a chat of this kind would silently run as an ordinary one`);
  for (const n of runKinds) if (!runKindsSpec.includes(n)) violations.push(`Run kind "${n}" is registered, but is not in RUN_KINDS_SPEC (tree-rules.mjs) — a further run kind is entered there so that it does not arise silently`);

  const outsideRuns = calls.filter((s) => !isRuns(s.path));
  return {
    ok: violations.length === 0,
    kinds,
    runKinds,
    registrations: registrations.map(({ kind, type, name, path, line }) => ({ kind, type, name, path, line })),
    calls: calls.map(({ kind, type, path, line }) => ({ kind, type, path, line })),
    outsideRuns: outsideRuns.map(location),
    violations,
  };
}

// The line for the gate (check.mjs) — green names the numbers, red the first violation and how many follow.
export function hookRegistryText(r) {
  if (!r.ok) return `${r.violations[0]}${r.violations.length > 1 ? ` (+${r.violations.length - 1} more)` : ""}`;
  const registrar = r.registrations.filter((a) => a.kind !== "runKind").length;
  const outside = r.outsideRuns.length ? `, ${r.outsideRuns.length} of them outside runs/: ${r.outsideRuns.join(", ")}` : ", all in runs/";
  return `${r.kinds.hooks.length} hook kinds / ${r.kinds.switches.length} switches / ${r.runKinds.length} run kinds — registrants == calls (${registrar} registrants, ${r.calls.length} call sites${outside})`;
}

// ── (e) The schema registry ──────────────────────────────────────────────────────────────────
// `store/db.js` creates the core and then calls `runSchemata()`; WHICH schemas those are stands in
// the registration list at the end of the facade `store.js`. The guard against a forgotten
// registration is exactly what the forgetful person CANNOT forget: the SQL itself. A topic file with
// `CREATE TABLE`/`ALTER TABLE` that appears in no registration is red — without registration its
// schema function would never run, and a database without tables does not throw, it stays silent
// (measured: 96 → 74 tables, no log, no exception).
//
// Seven checks:
//   (1) CARRYING — every `store/*.js` except db.js and schema.js that carries DDL is registered;
//   (2) reverse — every registered function is imported in store.js from a store/ file;
//   (3) `registerSchema(` stands ONLY in store.js (the registration list is ONE place);
//   (4) first parameter ALWAYS a string literal — the guard reads the names statically;
//   (5) name present and unique per registration, second argument a function name;
//   (6) `runSchemata()` exactly once in the tree, namely in store/db.js; and no registered function
//       is called by hand (otherwise the order would stand in two places);
//   (7) no `import { initStore } … from "…/store/db.js"` outside store/ — that would be the way past
//       the facade, and with it past the registration list.
//
// Comments are dropped BEFORE searching (withoutComments): `store/db.js:317` carries "CREATE TABLE IF NOT
// EXISTS adds no columns" in a comment, and a commented-out `// CREATE TABLE …`
// in a topic file would otherwise be a false alarm. The register file itself is not read: it
// DECLARES `registerSchema`/`runSchemata` and names both in its error texts.
const DDL_RE = /\b(?:CREATE\s+(?:VIRTUAL\s+)?TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+TRIGGER|ALTER\s+TABLE)\b/i;
const SCHEMA_LOGIN_RE = /(?<![\w$])registerSchema\(\s*/g;
const SCHEMA_RUN_RE = /(?<![\w$])(?<!function\s+)runSchemata\(\s*\)/g;
// A topic file is a file DIRECTLY under store/ — there are no subfolders there, and db.js and
// schema.js are the two that are no topic.
const TOPIC_FILE_RE = /^store\/(?!db\.js$|schema\.js$)[^/]+\.js$/;

// Target of a relative specifier, as a path relative to electron/server. Without node:path, so the
// rules work purely over [{ path, text }] (and do not compute differently under Windows paths).
function targetPath(file, spec) {
  const parts = file.split("/").slice(0, -1);
  for (const t of spec.split("/")) {
    if (t === "" || t === ".") continue;
    else if (t === "..") parts.pop();
    else parts.push(t);
  }
  return parts.join("/");
}

// `{ name: target }` of all named imports of a file (relative as well as bare specifiers).
function importsOf(text, file) {
  const map = new Map();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const spec = m[2];
    const target = spec.startsWith(".") ? targetPath(file, spec) : spec;
    for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) map.set(n.split(/\s+as\s+/).pop(), target);
  }
  return map;
}

export function schemaRegistry(files) {
  const facade = files.find((f) => /(^|\/)store\.js$/.test(f.path));
  const register = files.find((f) => /(^|\/)store\/schema\.js$/.test(f.path));
  if (!facade || !register) return null;
  const facadeText = withoutComments(facade.text);
  const imports = importsOf(facadeText, facade.path);
  const violations = [];

  // All registrations in the whole tree — only so (3) is noticed.
  const registrations = [];
  for (const f of files) {
    if (f === register) continue;
    const text = withoutComments(f.text);
    for (const m of text.matchAll(SCHEMA_LOGIN_RE)) {
      const to = text.slice(m.index + m[0].length);
      const lit = to.match(LITERAL_RE);
      const args = argsValue(to);
      const fn = (args.split(",")[1] || "").trim();
      registrations.push({
        path: f.path,
        line: rowOf(text, m.index),
        literal: !!lit,
        kind: lit ? (lit[1] ?? lit[2]) : to.split(/[,)\n]/)[0].trim().slice(0, 40),
        fn: /^\w+$/.test(fn) ? fn : "",
        raw: fn.slice(0, 40),
      });
    }
  }

  // (3) and (4) first: what is not in the list or not readable cannot cover anything below.
  for (const a of registrations.filter((a) => a.path !== facade.path)) {
    violations.push(`${location(a)}: registerSchema("${a.kind}", …) outside the registration list in ${facade.path} — the list is ONE place, no module registers itself`);
  }
  for (const a of registrations.filter((a) => !a.literal)) {
    violations.push(`${location(a)}: registerSchema(${a.kind || "…"}, …) — first parameter is not a string literal (variable, template or concatenation); the guard reads the names statically, a typo in one would otherwise slip through`);
  }
  // (5) Name unique, second argument a function name.
  const seen = new Map();
  for (const a of registrations.filter((a) => a.literal)) {
    if (seen.has(a.kind)) violations.push(`${location(a)}: registerSchema("${a.kind}", …) — the name is already registered (${location(seen.get(a.kind))}); at run time that throws, here it stands in the gate`);
    else seen.set(a.kind, a);
    if (!a.fn) violations.push(`${location(a)}: registerSchema("${a.kind}", ${a.raw || "…"}) — second argument is not a function name; the guard cannot read its source file`);
  }

  const valid = registrations.filter((a) => a.literal && a.fn && a.path === facade.path);
  // (2) Every registrant comes from a store/ file — otherwise it points nowhere.
  for (const a of valid) {
    const target = imports.get(a.fn);
    if (!target) violations.push(`${location(a)}: registerSchema("${a.kind}", ${a.fn}) — ${a.fn} is not imported in ${facade.path}; the registrant points nowhere`);
    else if (!/^store\//.test(target)) violations.push(`${location(a)}: registerSchema("${a.kind}", ${a.fn}) — ${a.fn} comes from ${target}, not from store/; schemas belong in their topic file`);
  }
  const registeredFiles = new Set(valid.map((a) => imports.get(a.fn)).filter((z) => z && /^store\//.test(z)));

  // (1) CARRYING: DDL without registration.
  const carrier = [];
  for (const f of files.filter((f) => TOPIC_FILE_RE.test(f.path))) {
    if (!DDL_RE.test(withoutComments(f.text))) continue;
    carrier.push(f.path);
    if (!registeredFiles.has(f.path)) {
      violations.push(`${f.path} carries schema (CREATE/ALTER TABLE), but is not registered in the schema registry — without registration its tables silently do not arise (registration list: ${facade.path})`);
    }
  }

  // (6) The one call, and none by hand.
  const runs = [];
  for (const f of files) {
    if (f === register) continue;
    const text = withoutComments(f.text);
    for (const m of text.matchAll(SCHEMA_RUN_RE)) runs.push({ path: f.path, line: rowOf(text, m.index) });
  }
  const inDb = runs.filter((l) => /(^|\/)store\/db\.js$/.test(l.path));
  if (runs.length !== 1 || inDb.length !== 1) {
    violations.push(`runSchemata() appears ${runs.length} times in the tree (${runs.map(location).join(", ") || "nowhere"}) — exactly once, at the end of initStore in store/db.js; otherwise the schemas do not run at all or run twice`);
  }
  for (const a of valid) {
    const homeBase = imports.get(a.fn);
    const call = new RegExp(`(?<![\\w$])(?<!function\\s+)${a.fn}\\s*\\(`, "g");
    for (const f of files) {
      if (f.path === homeBase || f.path === facade.path || f === register) continue;
      const text = withoutComments(f.text);
      for (const m of text.matchAll(call)) {
        violations.push(`${f.path}:${rowOf(text, m.index)}: ${a.fn}() called by hand — schemas run via runSchemata(), otherwise the order stands in two places`);
      }
    }
  }

  // (7) The way past the facade.
  for (const f of files.filter((f) => !/^store\//.test(f.path))) {
    const text = withoutComments(f.text);
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      if (!/(^|\/)store\/db\.js$/.test(m[2])) continue;
      if (!/\binitStore\b/.test(m[1])) continue;
      violations.push(`${f.path}:${rowOf(text, m.index)}: import { initStore } from store/db.js — past the store.js facade, and with it past the registration list (the registry would be empty)`);
    }
  }

  return {
    ok: violations.length === 0,
    schemata: valid.map(({ kind, fn, path, line }) => ({ kind, fn, path, line, file: imports.get(fn) || null })),
    topicFiles: [...registeredFiles].sort(),
    carrier,
    violations,
  };
}

// The line for the gate (check.mjs) — green names the numbers, red the first violation and how many follow.
export function schemaRegistryText(r) {
  if (!r.ok) return `${r.violations[0]}${r.violations.length > 1 ? ` (+${r.violations.length - 1} more)` : ""}`;
  return `${r.schemata.length} schemas from ${r.topicFiles.length} topic files — DDL == registration`;
}
