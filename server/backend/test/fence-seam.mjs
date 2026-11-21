// The seam MCP ↔ fence: reads every `api("<METHOD>", <path>)` call from the sources of the cbase MCP server (`mcp/lib.js` and
// `mcp/tools/*.js`) and turns the path expression into the concrete paths it can take. Harness (not a test): used by
// fence.test.js (the seam guard "every call has a row, every mcp row has a call"), by fence-tools.test.js ("no offered tool
// runs into the fence"), and by hand for recounting.
//
// THE FORMS (any other one THROWS, so a new form shows up instead of being overlooked silently):
//   "…"                       a fixed path
//   `…${x}…`                  every insertion becomes a segment "X"; `${qs(…)}` and a literal `?…` are the query (dropped);
//                             `${await varsBase()}` becomes BOTH prefixes (`/api/projects/X` and `/api/workspaces/X`, lib.js)
//   cond ? a : b              both branches (tools/projects.js: context entry by id or by slug)
// The method must be a literal (`api("GET", …)`); an `api(` with another method also throws.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { STRUCTURE_TOOL } from "../electron/mcp/visibility.js";

function string(src, i) {
  const q = src[i];
  i++;
  while (src[i] !== q) {
    if (i >= src.length) throw new Error("open string");
    if (src[i] === "\\") i++;
    i++;
  }
  return i + 1;
}
function regex(src, i) {
  i++;
  let kind = false;
  for (;;) {
    const c = src[i];
    if (i >= src.length) throw new Error("open regular expression");
    if (c === "\\") { i += 2; continue; }
    if (c === "[") kind = true;
    else if (c === "]") kind = false;
    else if (c === "/" && !kind) break;
    i++;
  }
  i++;
  while (/[a-z]/.test(src[i] || "")) i++;
  return i;
}
function untilBracket(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = string(src, i); continue; }
    if (c === "`") { i = template(src, i); continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return i; depth--; }
    i++;
  }
  throw new Error("open insertion");
}
function template(src, i) {
  i++;
  while (src[i] !== "`") {
    if (i >= src.length) throw new Error("open template");
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "$" && src[i + 1] === "{") { i = untilBracket(src, i + 2) + 1; continue; }
    i++;
  }
  return i + 1;
}
// An expression from `i` to the first `,` or `)` at top level.
function expression(src, i) {
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = string(src, i); continue; }
    if (c === "`") { i = template(src, i); continue; }
    if (c === "/" && /(^|[(,=:?!&|])\s*$/.test(src.slice(start, i))) { i = regex(src, i); continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
    else if (c === "," && depth === 0) break;
    i++;
  }
  return src.slice(start, i).trim();
}

// An expression → the strings it can take (WITH query). Throws on an unknown form.
function valuesFrom(text) {
  let depth = 0;
  let question = -1;
  let double = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { i = string(text, i) - 1; continue; }
    if (c === "`") { i = template(text, i) - 1; continue; }
    if (c === "/" && /(^|[(,=:?!&|])\s*$/.test(text.slice(0, i))) { i = regex(text, i) - 1; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "?" && question < 0) question = i;
    else if (depth === 0 && c === ":" && question >= 0 && double < 0) double = i;
  }
  if (question >= 0 && double > question) return [...valuesFrom(text.slice(question + 1, double).trim()), ...valuesFrom(text.slice(double + 1).trim())];
  if (/^"[^"\\]*"$/.test(text)) return [text.slice(1, -1)];
  if (text.startsWith("`") && text.endsWith("`") && template(text, 0) === text.length) {
    let out = [""];
    let i = 1;
    while (i < text.length - 1) {
      if (text[i] === "$" && text[i + 1] === "{") {
        const e = untilBracket(text, i + 2);
        const inside = text.slice(i + 2, e).trim();
        let parts;
        if (/^qs\(/.test(inside)) parts = ["?"];
        else if (/^await varsBase\(\)$/.test(inside)) parts = ["/api/projects/X", "/api/workspaces/X"];
        else {
          // An insertion that is itself a literal or a ternary (`${a ? `?x=${y}` : ""}`) is expanded; anything else is a
          // value ("X").
          try { parts = valuesFrom(inside); } catch { parts = ["X"]; }
        }
        out = out.flatMap((a) => parts.map((t) => a + t));
        i = e + 1;
        continue;
      }
      out = out.map((a) => a + text[i]);
      i++;
    }
    return out;
  }
  throw new Error(`unbekannte Form eines api()-Pfads: ${text}`);
}

/** A path expression → the paths it can take (without query). Throws on an unknown form. */
export const pathsFrom = (text) => [...new Set(valuesFrom(text).map((p) => p.split("?")[0]))];

/** All `api(` calls under `mcpDir` (lib.js and tools/*.js): `{ file, place, method, path }` per possible path. */
export function mcpApiCalls(mcpDir) {
  const files = ["lib.js", ...fs.readdirSync(path.join(mcpDir, "tools")).filter((f) => f.endsWith(".js")).sort().map((f) => `tools/${f}`)];
  const out = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(mcpDir, file), "utf8");
    // Every `api(` in the code (comments and the definition excluded) must have the literal form.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (k) => k.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, (k) => " ".repeat(k.length));
    const apiCallRe = /(?<![\w.])api\(/g;
    let m;
    while ((m = apiCallRe.exec(code))) {
      if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
      const lit = /^api\(\s*"([A-Z]+)"\s*,/.exec(code.slice(m.index));
      const place = src.slice(0, m.index).split("\n").length;
      if (!lit) throw new Error(`${file}:${place}: api( ohne Methoden-Literal`);
      const text = expression(src, m.index + lit[0].length);
      for (const filePath of pathsFrom(text)) out.push({ file, place, method: lit[1], path: filePath });
    }
  }
  return out;
}

// ── Calls per tool ───────────────────────────────────────────────────────────────────────────────────────────────────────
// The seam guard asks per api( CALL whether the table has a row; whether an OFFERED tool runs into a rejected row it does not
// ask, which needs the calls per tool. Read through the syntax tree (typescript, runtime package of server/backend/, the same
// parser as in instance-resolution.test.js), not through text:
//   UNITS   the tool objects of the top-level arrays in tools/*.js (property `name`: a literal or one of the known constants;
//           any other form throws) and the top-level helpers (`function x` or `const x = …`): those from lib.js apply in every
//           file, those of a tool file only in it.
//   CALLS   per unit its `api("<METHOD>", <path>)` (paths as mcpApiCalls via pathsFrom) and, transitively, those of the helpers it
//           NAMES; every mention counts, even without parentheses (`.map(chatInScope)`): an overestimate becomes visible in the
//           guard, an underestimate would stay silent.
//   THROW   an api( call outside every unit (e.g. at top level) or without a method literal.
/** → Map tool name → [{ method, path, file, place }] (per tool without duplicates; a tool without a call with an empty list). */
export function toolCalls(mcpDir, { constants = { STRUCTURE_TOOL } } = {}) {
  const ts = createRequire(import.meta.url)("typescript");
  const files = ["lib.js", ...fs.readdirSync(path.join(mcpDir, "tools")).filter((f) => f.endsWith(".js")).sort().map((f) => `tools/${f}`)];
  const units = [];
  const sources = [];
  const isNameProp = (sf) => (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "name";
  for (const file of files) {
    const sf = ts.createSourceFile(file, fs.readFileSync(path.join(mcpDir, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    sources.push({ file, sf });
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) { units.push({ kind: "helper", name: st.name.text, file, node: st, sf }); continue; }
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const tools = ts.isArrayLiteralExpression(d.initializer)
          ? d.initializer.elements.filter((el) => ts.isObjectLiteralExpression(el) && el.properties.some(isNameProp(sf)))
          : [];
        if (!tools.length) { units.push({ kind: "helper", name: d.name.text, file, node: d, sf }); continue; }
        for (const el of tools) {
          const value = el.properties.find(isNameProp(sf)).initializer;
          let name;
          if (ts.isStringLiteral(value)) name = value.text;
          else if (ts.isIdentifier(value) && Object.hasOwn(constants, value.text)) name = constants[value.text];
          else throw new Error(`${file}: unknown form of a tool name: ${value.getText(sf)}`);
          units.push({ kind: "tool", name, file, node: el, sf });
        }
      }
    }
  }
  const helperLib = new Map(units.filter((e) => e.kind === "helper" && e.file === "lib.js").map((e) => [e.name, e]));
  const place = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const apiCall = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "api";
  const direct = new Map();
  for (const e of units) {
    const local = new Map(units.filter((x) => x.kind === "helper" && x.file === e.file).map((x) => [x.name, x]));
    const calls = [];
    const names = new Set();
    const visits = (n) => {
      if (apiCall(n)) {
        const [m, p] = n.arguments;
        if (!m || !ts.isStringLiteral(m) || !p) throw new Error(`${e.file}:${place(e.sf, n)}: api( ohne Methoden-Literal`);
        for (const filePath of pathsFrom(p.getText(e.sf))) calls.push({ method: m.text, path: filePath, file: e.file, place: place(e.sf, n) });
      } else if (ts.isIdentifier(n) && n !== e.node.name) {
        const parent = n.parent;
        const onlyProperty = (ts.isPropertyAccessExpression(parent) && parent.name === n) || (ts.isPropertyAssignment(parent) && parent.name === n);
        const h = onlyProperty ? null : local.get(n.text) || helperLib.get(n.text);
        if (h && h !== e) names.add(h);
      }
      ts.forEachChild(n, visits);
    };
    ts.forEachChild(e.node, visits);
    direct.set(e, { calls, names });
  }
  // Completeness: every api( call of every file lies in a unit.
  const node = new Set(units.map((e) => e.node));
  for (const { file, sf } of sources) {
    const search = (n) => {
      if (apiCall(n)) {
        let a = n.parent;
        while (a && !node.has(a)) a = a.parent;
        if (!a) throw new Error(`${file}:${place(sf, n)}: api( call outside every tool and helper`);
      }
      ts.forEachChild(n, search);
    };
    search(sf);
  }
  const transitive = (e, seen = new Set()) => {
    if (seen.has(e)) return [];
    seen.add(e);
    const d = direct.get(e);
    return [...d.calls, ...[...d.names].flatMap((h) => transitive(h, seen))];
  };
  const out = new Map();
  for (const e of units.filter((x) => x.kind === "tool")) {
    if (out.has(e.name)) throw new Error(`duplicate tool name: ${e.name}`);
    const unique = new Map();
    for (const a of transitive(e)) unique.set(`${a.method} ${a.path}`, a);
    out.set(e.name, [...unique.values()]);
  }
  return out;
}
