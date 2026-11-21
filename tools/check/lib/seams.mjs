// The seam between client and server: which field does the web client send, and does the server read it on the route it hits at all.
//
// The motive is measured and stands in the production code: for a while the web's 99-percent switch spoke `PUT /api/auto-continue`
// with the field `creditGate`. The backend reads only `enabled` there. Answer 200, `{ok:true}` — and for nine days every click
// toggled a DIFFERENT setting. No type error, no red test, no error message: the two sides are connected by nothing but a string.
//
// This file is the computation; the guard stands in `web/test/seams-fields.test.mjs`.
//
// The construction in three sentences:
//   1. SERVER — every `readBody(req)` place in the tree `server/backend/electron/server`. All of them bind the body to ONE
//      identifier, none destructures. From the surrounding `if` conditions (`p === "…"`, `sub === "…"`, regex match variables)
//      come path and method; from the accesses to the identifier the fields read — including hand-over to helpers (depth 3) and
//      fields that a loop over a constant array reads. In addition: a place in a helper to which the route passes `req`
//      inherits path and method from the ONLY call with `req`; `RE.exec(sub)` with `const RE = /…/` is a match variable; a
//      preceding `if (!(m === "POST" && …)) return NEXT;` contributes the method; and a query (`?archiveId=…`) in the web
//      path does not count for pairing.
//   2. WEB — every `JSON.stringify(x)` in a `body:` of a call with a path argument, read via `ts.createProgram` on
//      `web/tsconfig.json`. The fields come from the TYPE CHECKER (`getPropertiesOfType`), not from the source text: only
//      that way what an interface declares three files further counts too.
//   3. PAIRING — only EXACT (path AND method). Everything else is not measurable and is counted and printed, never concealed.
//
// What the guard does NOT catch is in the header of the test. In short: it catches the sent field that nobody reads — not the
// read field that nobody sends, and not the wrong VALUE in a right field (`reason === "gate"` against `reason: "credit"`, same
// tag, same family, another computation).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * TypeScript from `web/node_modules`. If it is missing, this function throws LOUDLY: a guard that silently reports green
 * without its tool is the most expensive kind of test (a skip in the gate is red anyway).
 * @param {string} repo  root of the working tree
 */
export function loadTs(repo) {
  const p = path.join(repo, "web", "node_modules", "typescript", "lib", "typescript.js");
  if (!fs.existsSync(p)) throw new Error(`TypeScript missing: ${p} — without node_modules this guard cannot measure (npm -C web install).`);
  return createRequire(import.meta.url)(p);
}

// ── 1. Server ───────────────────────────────────────────────────────────────────────────────────

const CHAT = "/api/chats/{x}", WS = "/api/workspaces/{x}", PROJ = "/api/projects/{x}";
const CF = "/api/chat-folders/{x}";

/**
 * The sub-slices of the dispatcher do not carry their path start in their source text but in the line that calls them
 * (`chatRoutes` passes `sub` on to nine sub-slices). This table is the substitute. It is a transcript — so the guard checks
 * that EVERY name here exists in the tree; if a route function disappears, the row stands out.
 */
export const ROUTES_PREFIX = {
  archiveChatRoutes: [CHAT], // archive — the FIRST sub-slice of chatRoutes
  coreChatRoutes: [CHAT], contextChatRoutes: [CHAT], itemChatRoutes: [CHAT], fileChatRoutes: [CHAT],
  runChatRoutes: [CHAT], autoContinueChatRoutes: [CHAT], messageChatRoutes: [CHAT],
  channelChatRoutes: [CHAT], workflowChatRoutes: [CHAT],
  outerLoopChatRoutes: [CHAT], outerLoopWorkspaceRoutes: [WS], outerLoopProjectRoutes: [PROJ], // outer loop
  coreWorkspaceRoutes: [WS], tailWorkspaceRoutes: [WS], toolchainWorkspaceRoutes: [WS],
  workflowWorkspaceRoutes: [WS], channelWorkspaceRoutes: [WS],
  scheduledWorkspaceRoutes: [WS], // scheduled jobs (geplant/routes.js)
  itemProjectRoutes: [PROJ], serviceProjectRoutes: [PROJ], contextProjectRoutes: [PROJ],
  codeProjectRoutes: [PROJ], codeRoute: [WS, PROJ], chatFolderRoutes: [CF],
  saveWorkflow: ["/api/workflows", "/api/workflows/{x}"],
  workflowTriggerRoute: [PROJ + "/workflows/{x}/trigger-test"],
  // Project setup (setup, upload afterwards): the sub-slice of projectRoutes.
  setupProjectRoutes: [PROJ],
  outputsChatRoutes: [CHAT], // outputs visible: the output location of a chat, read-only (chats/outputs-routes.js)
};

/** All `.js` under a directory, sorted (so the order does not depend on the file system). */
export function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(f, out);
    else if (e.name.endsWith(".js")) out.push(f);
  }
  return out;
}

/** `/^\/api\/x\/([0-9a-f-]+)(\/y)?$/` → `/api/x/{1}{2}` — the groups stay numbered because the condition next to it
 *  (`mm[2] === "/y"`) pins them down individually. Counted as in JavaScript: EVERY capturing group (nested and named too), in the
 *  order of its opening bracket; a bracket in a character class opens none. A non-capturing group `(?:…)` without a `|` of its
 *  own is transparent — its content stands in the pattern (`/^\/upload\/(id)(?:\/(finished|cancel))?$/` → `/upload/{1}/{2}`);
 *  one with `|` and a lookaround (`(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)`) do not appear in it. */
function rxPattern(sourceCode) {
  const s = sourceCode.replace(/^\//, "").replace(/\/[gimsuy]*$/, "").replace(/^\^/, "").replace(/\$$/, "");
  let i = 0, g = 0;
  // One level up to its ")" (or the end); `show`: its characters stand in the pattern. → `{ out, alt }` (`alt`: a `|` on it).
  const level = (show, top) => {
    let out = "", old = false;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") { if (show) out += s[i + 1] ?? ""; i += 2; continue; }
      if (c === "[") {
        const a = i;
        i++;
        if (s[i] === "^") i++;
        if (s[i] === "]") i++;
        while (i < s.length && s[i] !== "]") i += s[i] === "\\" ? 2 : 1;
        i++;
        if (show) out += s.slice(a, i).replace(/\\(.)/g, "$1");
        continue;
      }
      if (c === ")") { i++; if (top) continue; return { out, old }; }
      if (c === "|" && !top) { old = true; i++; continue; }
      if (c === "(") {
        let kind = "fang", before = 1;
        if (s.startsWith("(?:", i)) { kind = "through"; before = 3; }
        else if (s.startsWith("(?=", i) || s.startsWith("(?!", i)) { kind = "anticipation"; before = 3; }
        else if (s.startsWith("(?<=", i) || s.startsWith("(?<!", i)) { kind = "anticipation"; before = 4; }
        else if (s.startsWith("(?<", i)) before = Math.max(3, s.indexOf(">", i) - i + 1);
        i += before;
        if (kind === "fang") {
          const n = ++g;
          level(false, false);
          if (show) out += "{" + n + "}";
        } else if (kind === "through") {
          const inside = level(show, false);
          if (show && !inside.old) out += inside.out;
        } else level(false, false);
        if (s[i] === "?") i++;
        continue;
      }
      if (show) out += c;
      i++;
    }
    return { out, old };
  };
  return level(true, true).out;
}

/**
 * `fm[2] || ""`, `fm[2] ?? ""` or `fm[2]` — the group of a match as a name of its own. Returns `{match, group}` or null.
 * (`chatFolderRoutes` checks `fsub === "/archive"`, and without this rule the archive's folder PUT dropped out of the
 * measurement as "no counterpart".)
 */
function groupsAlias(ts, e) {
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    && (ts.isStringLiteral(e.right) || ts.isNoSubstitutionTemplateLiteral(e.right)) && e.right.text === "") e = e.left;
  if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && e.argumentExpression && ts.isNumericLiteral(e.argumentExpression))
    return { match: e.expression.text, group: e.argumentExpression.text };
  return null;
}

/**
 * Reads ONE server file: constant arrays, match variables, group aliases, function declarations.
 * @returns {{sf: any, arrays: Record<string,string[]>, matches: Record<string,{pos:number,base:string,pattern:string}[]>, aliases: Record<string,{pos:number,match:string,group:string}[]>}}
 */
function serverFile(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const arrays = {}, matches = {}, aliases = {};
  // `const UPLOAD_RE = /…/` — a regex constant of the file; its `.exec(sub)` is a match variable like `sub.match(/…/)`.
  const regexes = {};
  const upfront = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isRegularExpressionLiteral(n.initializer))
      regexes[n.name.text] = n.initializer.getText(sf);
    n.forEachChild(upfront);
  };
  upfront(sf);
  const scan = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      // `const X = ["a","b"]` — the source of list-driven reading (`for (const k of X) b?.[k]`).
      if (ts.isArrayLiteralExpression(n.initializer) && n.initializer.elements.length
        && n.initializer.elements.every((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)))
        arrays[n.name.text] = n.initializer.elements.map((e) => e.text);
      // `const m = p.match(/…/)` — the source of the paths.
      if (ts.isCallExpression(n.initializer) && ts.isPropertyAccessExpression(n.initializer.expression)
        && n.initializer.expression.name.text === "match") {
        const a = n.initializer.arguments[0];
        if (a && ts.isRegularExpressionLiteral(a))
          // The same name occurs several times in a file (`psm` stands for two different regexes in projects/routes.js). So ALL
          // declarations with their position — later the one declared last BEFORE the place is resolved.
          (matches[n.name.text] ||= []).push({ pos: n.getStart(sf), base: n.initializer.expression.expression.getText(sf), pattern: rxPattern(a.getText(sf)) });
      }
      // `const m = RE.exec(sub)` resp. `const m = /…/.exec(sub)` — the same source, the base is the argument.
      if (ts.isCallExpression(n.initializer) && ts.isPropertyAccessExpression(n.initializer.expression)
        && n.initializer.expression.name.text === "exec" && n.initializer.arguments.length === 1) {
        const re = n.initializer.expression.expression;
        const source = ts.isRegularExpressionLiteral(re) ? re.getText(sf) : ts.isIdentifier(re) ? regexes[re.text] : null;
        if (source) (matches[n.name.text] ||= []).push({ pos: n.getStart(sf), base: n.initializer.arguments[0].getText(sf), pattern: rxPattern(source) });
      }
      // `const fsub = fm[2] || ""` — a name for group 2 of `fm`. Whether `fm` is a match variable is decided only by
      // `pathsFrom` (at the place, with the declaration valid there); here only the form.
      const al = groupsAlias(ts, n.initializer);
      if (al) (aliases[n.name.text] ||= []).push({ pos: n.getStart(sf), ...al });
    }
    n.forEachChild(scan);
  };
  scan(sf);
  return { sf, arrays, matches, aliases };
}

/**
 * `b?.[k]` with an identifier as index: only works if `k` is a loop variable over a constant array (`for (const k of FIELDS)`).
 * Then the fields read are exactly the array entries. Otherwise the edge stays open.
 * @returns {string[]|null}  the fields, or null if not resolvable
 */
function loopFields(ts, node, name, sf, arrays) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!ts.isForOfStatement(cur)) continue;
    const d = cur.initializer;
    const binds = ts.isVariableDeclarationList(d) && d.declarations.some((x) => ts.isIdentifier(x.name) && x.name.text === name);
    if (!binds) continue;
    const e = cur.expression;
    if (ts.isArrayLiteralExpression(e) && e.elements.length && e.elements.every((x) => ts.isStringLiteral(x)))
      return e.elements.map((x) => x.text);
    if (ts.isIdentifier(e) && arrays[e.text]) return arrays[e.text];
    return null;
  }
  return null;
}

/**
 * Which fields does the function `name` read at its parameter no. `pos`? Recursive over hand-overs, capped at depth 3 (beyond
 * that the edge is reported open, not guessed).
 */
function fieldsOfParam(ts, index, name, pos, depth = 0, seen = new Set()) {
  const key = name + "#" + pos;
  if (depth > 3) return { fields: [], open: ["depth>3:" + name] };
  if (seen.has(key)) return { fields: [], open: [] };
  seen.add(key);
  const cand = index.fns[name.split(".").pop()] || [];
  if (!cand.length) return { fields: [], open: ["unknown target:" + name] };
  const fields = new Set(), open = [];
  for (const { fn, sf, arrays } of cand) {
    const pnode = (fn.parameters || [])[pos];
    if (!pnode) { open.push("parameter position:" + name + "@" + pos); continue; }
    if (ts.isObjectBindingPattern(pnode.name)) {
      for (const el of pnode.name.elements) fields.add((el.propertyName || el.name).getText(sf));
      continue;
    }
    if (!ts.isIdentifier(pnode.name)) { open.push("binding pattern:" + name); continue; }
    if (!fn.body) { open.push("without body:" + name); continue; }
    const r = accesses(ts, index, fn.body, pnode.name.text, sf, arrays, depth);
    r.fields.forEach((f) => fields.add(f));
    open.push(...r.open);
  }
  return { fields: [...fields], open };
}

/**
 * All accesses to the identifier `pn` within `root`: dot access, bracket access with a string, destructuring, loop over a
 * constant array — and every hand-over as an argument. What does not work out lands in `open` and makes the place unmeasurable.
 */
function accesses(ts, index, root, pn, sf, arrays, depth = 0) {
  const fields = new Set(), open = [];
  const rec = (n) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === pn)
      fields.add(n.name.text);
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === pn) {
      const a = n.argumentExpression;
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) fields.add(a.text);
      else if (a && ts.isIdentifier(a)) {
        const out = loopFields(ts, n, a.text, sf, arrays);
        if (out) out.forEach((f) => fields.add(f));
        else open.push("dynamic access:" + pn + "[" + a.text + "]");
      } else open.push("dynamic access:" + pn + "[?]");
    }
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer)
      && n.initializer.text === pn && ts.isObjectBindingPattern(n.name))
      for (const el of n.name.elements) fields.add((el.propertyName || el.name).getText(sf));
    if (ts.isCallExpression(n)) {
      for (let i = 0; i < n.arguments.length; i++) {
        const a = n.arguments[i];
        if (ts.isIdentifier(a) && a.text === pn) {
          const r = fieldsOfParam(ts, index, n.expression.getText(sf), i, depth + 1);
          r.fields.forEach((f) => fields.add(f));
          open.push(...r.open);
        }
        if (ts.isSpreadElement(a) && ts.isIdentifier(a.expression) && a.expression.text === pn)
          open.push("spread as argument:" + pn);
      }
    }
    if (ts.isSpreadAssignment(n) && ts.isIdentifier(n.expression) && n.expression.text === pn) {
      // `{...b}` in an object literal that goes straight into a call counts as a hand-over — otherwise every normalising
      // function would be an open edge.
      const o = n.parent;
      let resolved = false;
      if (o && ts.isObjectLiteralExpression(o) && o.parent && ts.isCallExpression(o.parent)) {
        const pos = o.parent.arguments.indexOf(o);
        if (pos >= 0) {
          const r = fieldsOfParam(ts, index, o.parent.expression.getText(sf), pos, depth + 1);
          r.fields.forEach((f) => fields.add(f));
          open.push(...r.open);
          resolved = true;
        }
      }
      if (!resolved) open.push("spread into object:" + pn);
    }
    n.forEachChild(rec);
  };
  rec(root);
  return { fields: [...fields], open };
}

const normPath = (s) => s.replace(/\{\d+\}/g, "{x}").replace(/(\{x\})+/g, "{x}");

/** The declaration of a match name valid at `pos`: the last one before it. */
function matchVar(matches, name, pos) {
  const k = matches[name];
  if (!k || !k.length) return null;
  const beforehand = k.filter((x) => x.pos < pos);
  return beforehand.length ? beforehand[beforehand.length - 1] : k[0];
}

/** Path and method from the surrounding `if` conditions. */
function pathsFrom(place, prefix, matches, pos, aliases = {}) {
  const insideFirst = [...new Set(place.conds)].reverse();
  for (const c of insideFirst) {
    let mm;
    if ((mm = c.match(/\bp === "([^"]+)"/))) return [mm[1]];
    if ((mm = c.match(/\bsub === "([^"]*)"/)) && prefix.length) return prefix.map((q) => q + mm[1]);
    if ((mm = c.match(/\bsub\.startsWith\("([^"]+)"\)/)) && prefix.length) return prefix.map((q) => q + mm[1] + "*");
    if ((mm = c.match(/\bsub\.endsWith\("([^"]+)"\)/)) && prefix.length) return prefix.map((q) => q + "*" + mm[1]);
    // Group alias (`fsub === "/archive"` with `const fsub = fm[2] || ""`): like `fm[2] === "/archive"`. The last declaration
    // BEFORE the place is valid, and its match must be a match variable — otherwise nothing is guessed.
    for (const [name, list] of Object.entries(aliases)) {
      const lit = c.match(new RegExp("(?<![\\w$.])" + name.replace(/\$/g, "\\$") + ' === "([^"]*)"'));
      if (!lit) continue;
      const beforehand = list.filter((x) => x.pos < pos);
      const a = beforehand[beforehand.length - 1];
      const v = a && matchVar(matches, a.match, a.pos);
      if (!v || !v.pattern.includes("{" + a.group + "}")) continue;
      const pattern = v.pattern.replace("{" + a.group + "}", lit[1]);
      if (v.base === "p") return [normPath(pattern)];
      return prefix.length ? prefix.map((q) => normPath(q + pattern)) : null;
    }
    // Match variable: `wm`, `!wm[2]`, `wm[2] === "/x"` — indexed matches first, they are more precise.
    const raw = [...c.matchAll(/\b([a-zA-Z_$][\w$]*)(?:\[(\d+)\])?/g)];
    for (const k of [...raw.filter((x) => x[2]), ...raw.filter((x) => !x[2])]) {
      const v = matchVar(matches, k[1], pos);
      if (!v) continue;
      let pattern = v.pattern;
      const lit = c.match(new RegExp("\\b" + k[1] + "\\[" + (k[2] || "\\d") + "\\] === \"([^\"]*)\""));
      if (k[2] && lit) pattern = pattern.replace("{" + k[2] + "}", lit[1]);
      else if (k[2] && new RegExp("!" + k[1] + "\\[" + k[2] + "\\]").test(c)) pattern = pattern.replace("{" + k[2] + "}", "");
      if (v.base === "p") return [normPath(pattern)];
      return prefix.length ? prefix.map((q) => normPath(q + pattern)) : null;
    }
  }
  return null;
}

// The readers of a JSON body in runtime/http.js — `readBodyOrEmpty` is readBody with `{}` for empty/broken.
const BODY_READER = new Set(["readBody", "readBodyOrEmpty"]);

/** The surrounding `if` conditions of a node up to its function, its name, and the innermost block under an `if`.
 *  `watchdog`: the conditions of a preceding `if (!(…)) return NEXT;` in an enclosing block — after it `…` holds
 *  (`if (!(m === "POST" && (qm || …))) return NEXT;`); they contribute only the METHOD. */
function environment(ts, sf, node) {
  const conds = [], watchdog = [];
  let cur = node.parent, block = null, fnName = "?", kind = node;
  while (cur) {
    if (ts.isBlock(cur)) {
      for (const st of cur.statements) {
        if (st === kind || st.pos >= kind.pos) break;
        if (!ts.isIfStatement(st) || st.elseStatement) continue;
        const then = ts.isBlock(st.thenStatement) && st.thenStatement.statements.length === 1 ? st.thenStatement.statements[0] : st.thenStatement;
        if (!ts.isReturnStatement(then) || !then.expression || then.expression.getText(sf) !== "NEXT") continue;
        let x = st.expression;
        if (!ts.isPrefixUnaryExpression(x) || x.operator !== ts.SyntaxKind.ExclamationToken) continue;
        x = x.operand;
        while (ts.isParenthesizedExpression(x)) x = x.expression;
        // only the members of a top-level and-chain (`m === "POST" && (…)`), never from an or
        const segments = [];
        const and = (e) => { if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) { and(e.left); and(e.right); } else segments.push(e); };
        and(x);
        for (const gl of segments) watchdog.push(gl.getText(sf).replace(/\s+/g, " "));
      }
    }
    kind = cur;
    if (ts.isIfStatement(cur)) conds.unshift(cur.expression.getText(sf).replace(/\s+/g, " "));
    if (ts.isBlock(cur) && cur.parent && ts.isIfStatement(cur.parent) && cur.parent.thenStatement === cur) {
      conds.unshift(cur.parent.expression.getText(sf).replace(/\s+/g, " "));
      if (!block) block = cur;
    }
    if (ts.isFunctionDeclaration(cur) && cur.name) { fnName = cur.name.text; break; }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) { fnName = cur.name.text; break; }
    cur = cur.parent;
  }
  return { conds, fnName, block, fn: cur, watchdog };
}
const methodsFrom = (conds) => [...new Set([...conds.join(" ").matchAll(/m === "([A-Z]+)"/g)].map((q) => q[1]))];

/**
 * All `readBody` places of the server tree (also `readBodyOrEmpty`), with path, method, fields read and open edges.
 * @param {any} ts
 * @param {{repo: string}} opt
 */
export function serverPlaces(ts, { repo }) {
  const root = path.join(repo, "server", "backend", "electron", "server");
  const mcp = path.join(repo, "server", "backend", "electron", "mcp");
  const index = { fns: {} };
  const parsed = [];
  for (const f of [...jsFiles(root), ...(fs.existsSync(mcp) ? jsFiles(mcp) : [])]) {
    const text = fs.readFileSync(f, "utf8");
    const d = serverFile(ts, f, text);
    parsed.push({ file: f, text, ...d, underRoot: f.startsWith(root + path.sep) });
    const note = (name, fn) => (index.fns[name] ||= []).push({ fn, sf: d.sf, arrays: d.arrays });
    const scan = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name) note(n.name.text, n);
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
        && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) note(n.name.text, n.initializer);
      else if (ts.isMethodDeclaration(n) && n.name) note(n.name.getText(d.sf), n);
      else if (ts.isPropertyAssignment(n) && n.initializer
        && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) note(n.name.getText(d.sf), n.initializer);
      n.forEachChild(scan);
    };
    scan(d.sf);
  }

  // Every call `f(…, req, …)` in the tree, per name — the inheritance of a helper (below); built only on demand.
  let calls = null;
  const callIndex = () => {
    if (calls) return calls;
    calls = {};
    for (const g of parsed) {
      if (!g.underRoot || !/\breq\b/.test(g.text)) continue;
      const rel = path.relative(repo, g.file);
      const search = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.some((x) => ts.isIdentifier(x) && x.text === "req"))
          (calls[n.expression.text] ||= []).push({ file: rel, sf: g.sf, node: n, matches: g.matches, aliases: g.aliases });
        n.forEachChild(search);
      };
      search(g.sf);
    }
    return calls;
  };

  const places = [];
  for (const { file, text, sf, arrays, matches, aliases, underRoot } of parsed) {
    // Both readers of a JSON body (`readBodyOrEmpty` for a body that may be absent — without it nine places silently dropped out).
    if (!underRoot || !/\breadBody(?:OrEmpty)?\(req\)/.test(text)) continue;
    const rel = path.relative(repo, file);
    const scan = (node) => {
      if (ts.isVariableStatement(node)) {
        const d = node.declarationList.declarations[0];
        let found = false;
        const su = (n) => { if (ts.isCallExpression(n) && BODY_READER.has(n.expression.getText(sf))) found = true; n.forEachChild(su); };
        if (d && d.initializer) su(d.initializer);
        if (found) {
          const varName = ts.isIdentifier(d.name) ? d.name.text : null;
          const u = environment(ts, sf, node);
          const { conds, fnName } = u;
          let { block } = u;
          if (!block) { let b = node.parent; while (b && !ts.isBlock(b)) b = b.parent; block = b; }
          let fields = [], open = ["body not bound to an identifier"];
          if (varName && block) ({ fields, open } = accesses(ts, index, block, varName, sf, arrays));
          const st = {
            file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fnName, varName, conds,
            fields: [...fields].sort(), open: [...new Set(open)],
            methods: methodsFrom(conds),
          };
          if (!st.methods.length) st.methods = methodsFrom(u.watchdog.filter((w) => /^m === "[A-Z]+"$/.test(w)));
          st.paths = pathsFrom(st, ROUTES_PREFIX[fnName] || [], matches, node.getStart(sf), aliases);
          // A helper to which the route passes `req` (`() => startUpload(pid, proj, req)` under `if (sub === "…" && m === "POST")`):
          // path and method come from the ONLY call with `req` — with several, the inheritance stays silent (it would otherwise
          // pair every path with every method).
          if (!st.paths && u.fn && (u.fn.parameters || []).some((q) => ts.isIdentifier(q.name) && q.name.text === "req")) {
            const calls = (callIndex()[fnName] || []);
            if (calls.length === 1) {
              const a = calls[0];
              const ua = environment(ts, a.sf, a.node);
              const pf = pathsFrom({ conds: ua.conds }, ROUTES_PREFIX[ua.fnName] || [], a.matches, a.node.getStart(a.sf), a.aliases);
              if (pf) {
                st.paths = pf;
                st.methods = [...new Set([...methodsFrom(ua.conds), ...st.methods])];
                if (!st.methods.length) st.methods = methodsFrom(ua.watchdog.filter((w) => /^m === "[A-Z]+"$/.test(w)));
                st.over = `${a.file}:${a.sf.getLineAndCharacterOfPosition(a.node.getStart(a.sf)).line + 1}`;
              }
            }
          }
          places.push(st);
        }
      }
      node.forEachChild(scan);
    };
    scan(sf);
  }
  return { places, fnNames: new Set(Object.keys(index.fns)) };
}

// ── 2. Web ──────────────────────────────────────────────────────────────────────────────────────

/** The first argument of a call as a path pattern. Unresolvable becomes `{x}` — and a path that begins with `{x}` never pairs
 *  exactly and is thus not measurable (class "path too unspecific"). */
function pathFrom(ts, checker, node, depth = 0) {
  if (depth > 4) return "{x}";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const sp of node.templateSpans) s += pathFrom(ts, checker, sp.expression, depth + 1) + sp.literal.text;
    return s;
  }
  if (ts.isIdentifier(node)) {
    const sym = checker.getSymbolAtLocation(node);
    const decl = sym && sym.declarations && sym.declarations.find((d) => ts.isVariableDeclaration(d) && d.initializer);
    return decl ? pathFrom(ts, checker, decl.initializer, depth + 1) : "{x}";
  }
  if (ts.isCallExpression(node)) {
    // Base helper like `base(ws)`: a body of exactly one `return <template>`.
    const sym = checker.getSymbolAtLocation(node.expression);
    const d = sym && sym.declarations && sym.declarations[0];
    let fn = null;
    if (d && ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) fn = d.initializer;
    if (d && ts.isFunctionDeclaration(d)) fn = d;
    if (fn && fn.body && !ts.isBlock(fn.body)) return pathFrom(ts, checker, fn.body, depth + 1);
    if (fn && fn.body && ts.isBlock(fn.body) && fn.body.statements.length === 1
      && ts.isReturnStatement(fn.body.statements[0]) && fn.body.statements[0].expression)
      return pathFrom(ts, checker, fn.body.statements[0].expression, depth + 1);
    return "{x}";
  }
  // Ternary: two paths in one call. Both stay, so that the place is visibly unpairable.
  if (ts.isConditionalExpression(node)) return pathFrom(ts, checker, node.whenTrue, depth + 1) + "||" + pathFrom(ts, checker, node.whenFalse, depth + 1);
  return "{x}";
}

/**
 * All send places of the web client: `{ …, body: JSON.stringify(x) }` as an argument of a call whose first argument is the path.
 * @param {any} ts
 * @param {{repo: string, addition?: {path: string, text: string}[]}} opt  `addition` are files that exist only in memory (the
 *   guard's self-probe) — they are read with the same program and the same type checker as the real tree.
 */
export function webPlaces(ts, { repo, addition = [] }) {
  const webDir = path.join(repo, "web");
  const raw = ts.readConfigFile(path.join(webDir, "tsconfig.json"), ts.sys.readFile);
  const conf = ts.parseJsonConfigFileContent(raw.config, ts.sys, webDir);
  const virtual = new Map(addition.map((z) => [path.join(webDir, z.path), z.text]));
  const host = ts.createCompilerHost({ ...conf.options, noEmit: true });
  const readOriginal = host.readFile.bind(host), existsOriginal = host.fileExists.bind(host);
  host.readFile = (f) => (virtual.has(path.normalize(f)) ? virtual.get(path.normalize(f)) : readOriginal(f));
  host.fileExists = (f) => virtual.has(path.normalize(f)) || existsOriginal(f);
  const program = ts.createProgram([...conf.fileNames, ...virtual.keys()], { ...conf.options, noEmit: true }, host);
  const checker = program.getTypeChecker();

  const places = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(path.join(webDir, "src")) || !sf.text.includes("JSON.stringify")) continue;
    const rel = path.relative(repo, sf.fileName);
    const scan = (node) => {
      if (ts.isCallExpression(node)) {
        for (const a of node.arguments) {
          if (!ts.isObjectLiteralExpression(a)) continue;
          const bp = a.properties.find((pp) => ts.isPropertyAssignment(pp) && pp.name.getText(sf) === "body");
          if (!bp || !(ts.isCallExpression(bp.initializer) && bp.initializer.expression.getText(sf) === "JSON.stringify")) continue;
          const arg0 = bp.initializer.arguments[0];
          let fields = null, kind = "no argument";
          if (arg0) {
            const t = checker.getTypeAtLocation(arg0);
            const props = checker.getPropertiesOfType(t);
            fields = props.map((s) => s.getName()).sort();
            kind = props.length ? "type-resolved" : "type without properties";
            if (checker.getIndexInfoOfType(t, ts.IndexKind.String)) kind = "Index-Signatur";
            if (t.flags & ts.TypeFlags.Any) kind = "any";
          }
          const mp = a.properties.find((pp) => ts.isPropertyAssignment(pp) && pp.name.getText(sf) === "method");
          places.push({
            file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            path: node.arguments[0] ? pathFrom(ts, checker, node.arguments[0]) : "{x}",
            method: mp ? mp.initializer.getText(sf).replace(/["'`]/g, "").toUpperCase() : "?",
            kind, fields,
          });
        }
      }
      node.forEachChild(scan);
    };
    scan(sf);
  }
  return places;
}

// ── 3. Pairing ──────────────────────────────────────────────────────────────────────────────────

const norm = (s) => s.replace(/\?.*$/, "").replace(/\{[^}]*\}/g, "{x}").replace(/(\{x\})+/g, "{x}").replace(/\/{2,}/g, "/").replace(/\/$/, "");

/**
 * Holds the web send places against the server places. Scored ONLY on exact pairing (path AND method) and only if none of the
 * server places hit has an open edge. Everything else is a `notMeasurable` entry with a reason — counted and printed, never concealed.
 */
export function pairing(serverList, webList) {
  const pairs = [];
  for (const s of serverList) {
    if (!s.paths) continue;
    for (const pf of s.paths) for (const m of (s.methods.length ? s.methods : ["*"])) pairs.push({ pf: norm(pf), m, s });
  }
  const findings = [], notMeasurable = [], measured = [];
  for (const w of webList) {
    const filePath = norm(w.path), hits = pairs.filter((x) => x.pf === filePath && x.m === w.method);
    const entry = { ...w, pathNorm: filePath, server: [...new Set(hits.map((h) => h.s.file + ":" + h.s.line))] };
    if (w.kind !== "type-resolved") { notMeasurable.push({ ...entry, reason: w.kind }); continue; }
    if (!hits.length) { notMeasurable.push({ ...entry, reason: filePath.includes("||") ? "ternary path" : filePath.startsWith("{x}") ? "path too unspecific" : "no counterpart" }); continue; }
    const open = [...new Set(hits.flatMap((h) => h.s.open))];
    if (open.length) { notMeasurable.push({ ...entry, reason: "open edge at the server: " + open.join(", ") }); continue; }
    const read = [...new Set(hits.flatMap((h) => h.s.fields))];
    entry.read = read.sort();
    measured.push(entry);
    const orphans = w.fields.filter((f) => !read.includes(f));
    if (orphans.length) findings.push({ ...entry, orphans });
  }
  return { pairs: pairs.length, measured, findings, notMeasurable };
}

/** One row per finding — the text the guard prints when red. */
export function findingRow(b) {
  return `${b.file}:${b.line} sends ${b.orphans.join(", ")} to ${b.method} ${b.pathNorm}, only ${b.read.join(", ") || "(nothing)"} is read there — ${b.server.join(" ")}`;
}
