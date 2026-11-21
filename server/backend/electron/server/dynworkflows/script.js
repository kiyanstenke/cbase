// Read a workflow script BEFORE it runs: `meta` as a pure literal, syntax, the static prohibitions.
//
// The rules follow the workflow tool of the pinned Claude Code: every script starts with `export const meta = {...}`,
// whose value is a literal only (nothing computed, called, spread or interpolated); `name` and `description` are
// required, `title`, `whenToUse`, `phases` optional. The validation messages are short and name the offending construct;
// the node names in "non-literal node type in meta: …" are ESTree names (as acorn reports them), mapped here from the
// TypeScript nodes.
//
// Reading uses the shipped TypeScript parser (`typescript` from server/backend/package.json); nothing is evaluated.
// A syntax error is decided by V8, not by this parser — it repairs silently (a bare `...` is swallowed, `const x = ;`
// gets an empty expression). That is why `checkScript` compiles the WHOLE text with V8 (compile only, never run)
// before it reads `meta`.
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let tsModule = null;
const tsParser = () => (tsModule ??= require("typescript"));

export class MetaError extends Error {}
export class ScriptError extends Error {}

// Wordings of the baseline.
export const ERROR_FIRST_INSTRUCTION = "`export const meta = { name, description, phases }` must be the FIRST statement in the script";
const HINT_PARSE = "Workflow scripts must be plain JavaScript — common causes are TypeScript syntax (type annotations, interfaces, generics) and broken string quoting or escaping.";
export const PROHIBITION_WITH = "'with' statements are not supported in workflow scripts.";
export const PROHIBITION_IMPORT = "import() is not available in workflow scripts.";
export const PROHIBITION_AWAIT_USING = "'await using' declarations are not supported in workflow scripts.";
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

// TypeScript node → ESTree name as acorn reports it in the baseline. What is missing here is named as in TypeScript.
function estreeName(t, node) {
  const K = t.SyntaxKind;
  switch (node.kind) {
    case K.Identifier: return "Identifier";
    case K.PropertyAccessExpression:
    case K.ElementAccessExpression: return "MemberExpression";
    case K.ArrowFunction: return "ArrowFunctionExpression";
    case K.ThisKeyword: return "ThisExpression";
    case K.PostfixUnaryExpression: return "UpdateExpression";
    case K.BinaryExpression: {
      const op = node.operatorToken.kind;
      if (op === K.CommaToken) return "SequenceExpression";
      if (op === K.AmpersandAmpersandToken || op === K.BarBarToken || op === K.QuestionQuestionToken) return "LogicalExpression";
      if (op >= K.FirstAssignment && op <= K.LastAssignment) return "AssignmentExpression";
      return "BinaryExpression";
    }
    default: return K[node.kind];
  }
}

const withoutBrackets = (t, k) => { while (k.kind === t.SyntaxKind.ParenthesizedExpression) k = k.expression; return k; };

/** Build the value of a pure literal — or throw with the baseline's wording (without the "meta must be …" prefix). */
function literalValue(t, node) {
  const K = t.SyntaxKind;
  node = withoutBrackets(t, node);
  switch (node.kind) {
    case K.StringLiteral:
    case K.NoSubstitutionTemplateLiteral: return node.text;
    case K.NumericLiteral: return Number(node.text);
    case K.BigIntLiteral: return BigInt(node.text.slice(0, -1));
    case K.RegularExpressionLiteral: {
      const i = node.text.lastIndexOf("/");
      return new RegExp(node.text.slice(1, i), node.text.slice(i + 1));
    }
    case K.TrueKeyword: return true;
    case K.FalseKeyword: return false;
    case K.NullKeyword: return null;
    case K.TemplateExpression: throw new Error("template interpolation not allowed in meta");
    case K.PrefixUnaryExpression: {
      if (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken) break;
      const arg = withoutBrackets(t, node.operand);
      if (node.operator === K.MinusToken && arg.kind === K.NumericLiteral) return -Number(arg.text);
      throw new Error("only negative-number unary allowed in meta");
    }
    case K.TypeOfExpression:
    case K.VoidExpression:
    case K.DeleteExpression: throw new Error("only negative-number unary allowed in meta");
    case K.ArrayLiteralExpression:
      return node.elements.map((e) => {
        if (e.kind === K.OmittedExpression) throw new Error("sparse arrays not allowed");
        if (e.kind === K.SpreadElement) throw new Error("spread not allowed in meta");
        return literalValue(t, e);
      });
    case K.ObjectLiteralExpression: return objectValue(t, node);
    default: break;
  }
  throw new Error(`non-literal node type in meta: ${node.kind === K.PrefixUnaryExpression ? "UpdateExpression" : estreeName(t, node)}`);
}

function objectValue(t, node) {
  const K = t.SyntaxKind;
  const o = {};
  for (const p of node.properties) {
    if (p.kind === K.SpreadAssignment) throw new Error("only plain properties allowed in meta");
    if (p.name && p.name.kind === K.ComputedPropertyName) throw new Error("computed keys not allowed in meta");
    if (p.kind === K.MethodDeclaration || p.kind === K.GetAccessor || p.kind === K.SetAccessor) {
      throw new Error("methods/accessors not allowed in meta");
    }
    let key;
    const n = p.name;
    if (n.kind === K.Identifier) key = n.text;
    else if (n.kind === K.StringLiteral) key = n.text;
    else if (n.kind === K.NumericLiteral) key = String(Number(n.text));
    else if (n.kind === K.BigIntLiteral) key = String(BigInt(n.text.slice(0, -1)));
    else throw new Error(`unsupported key type in meta: ${estreeName(t, n)}`);
    if (RESERVED.has(key)) throw new Error(`reserved key name not allowed in meta: ${key}`);
    // `{ name }` is a Property with an Identifier as value in ESTree.
    o[key] = p.kind === K.ShorthandPropertyAssignment ? literalValue(t, p.name) : literalValue(t, p.initializer);
  }
  return o;
}

// The baseline's normalisation: check the required fields, cut the rest down to the known fields.
function normMeta(raw) {
  if (typeof raw.name !== "string" || raw.name.length === 0) throw new MetaError("meta.name must be a non-empty string");
  if (typeof raw.description !== "string" || raw.description.length === 0) {
    throw new MetaError("meta.description must be a non-empty string");
  }
  let phases;
  if (Array.isArray(raw.phases)) {
    phases = [];
    for (const p of raw.phases) {
      if (p && typeof p === "object" && "title" in p && typeof p.title === "string") {
        phases.push({
          title: p.title,
          detail: typeof p.detail === "string" ? p.detail : undefined,
          model: typeof p.model === "string" ? p.model : undefined,
        });
      }
    }
    if (phases.length === 0) phases = undefined;
  }
  return {
    name: raw.name,
    description: raw.description,
    title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : undefined,
    whenToUse: typeof raw.whenToUse === "string" ? raw.whenToUse : undefined,
    phases,
  };
}

function metaInstruction(t, source) {
  const first = source.statements[0];
  if (!first || first.kind !== t.SyntaxKind.VariableStatement) return null;
  if (!first.modifiers?.some((m) => m.kind === t.SyntaxKind.ExportKeyword)) return null;
  const list = first.declarationList;
  if ((list.flags & t.NodeFlags.BlockScoped) !== t.NodeFlags.Const || list.declarations.length !== 1) return null;
  const decl = list.declarations[0];
  if (decl.name.kind !== t.SyntaxKind.Identifier || decl.name.text !== "meta" || !decl.initializer) return null;
  if (withoutBrackets(t, decl.initializer).kind !== t.SyntaxKind.ObjectLiteralExpression) return null;
  return first;
}

// V8 compiles, nothing runs. The wrapper is the baseline's (`async function _check() {'use strict'; …}`): a body that
// tries to close the run's wrapper is caught here because the two wrappers differ.
function v8Check(text) {
  new vm.Script(`async function _check() {'use strict';\n${text}\n}`, { filename: "workflow.js" });
}

/** The baseline's static prohibitions: `with`, `import()`, `await using`. */
export function prohibitionsInBody(body) {
  const t = tsParser();
  const source = t.createSourceFile("workflow.js", `(async () => {'use strict';\n${body}\n})()`, t.ScriptTarget.Latest, true, t.ScriptKind.JS);
  let fund = null;
  const visits = (k) => {
    if (fund) return;
    if (k.kind === t.SyntaxKind.WithStatement) fund = PROHIBITION_WITH;
    else if (k.kind === t.SyntaxKind.CallExpression && k.expression.kind === t.SyntaxKind.ImportKeyword) fund = PROHIBITION_IMPORT;
    else if (k.kind === t.SyntaxKind.VariableDeclarationList && (k.flags & t.NodeFlags.BlockScoped) === t.NodeFlags.AwaitUsing) {
      fund = PROHIBITION_AWAIT_USING;
    }
    if (!fund) t.forEachChild(k, visits);
  };
  visits(source);
  return fund;
}

/**
 * Check a body WITHOUT meta (a fragment from the guide, or the rest after `checkScript`).
 * @throws {ScriptError} `SyntaxError: …` like the baseline's translator
 */
export function checkBody(body) {
  try {
    v8Check(body);
  } catch (e) {
    throw new ScriptError(`SyntaxError: ${e?.message || e}`);
  }
  const prohibition = prohibitionsInBody(body);
  if (prohibition) throw new ScriptError(`SyntaxError: ${prohibition}`);
}

/**
 * Read a whole script: syntax (V8), `meta` (pure literal), static prohibitions.
 *
 * @param {string} text  the script as it arrived
 * @returns {{ meta: Object, body: string }}  `body` = the script with the meta statement replaced by spaces — the
 *          lines stay in place so that V8 reports the same line numbers the author sees.
 * @throws {ScriptError} syntax errors (V8) and forbidden constructs
 * @throws {MetaError}   meta is missing, not first, or not a pure literal
 */
export function checkScript(text) {
  text = String(text);
  const t = tsParser();
  const source = t.createSourceFile("workflow.js", text, t.ScriptTarget.Latest, true, t.ScriptKind.JS);
  const instruction = metaInstruction(t, source);
  // For V8 `export` has to go (a function body does not know it) — on every top-level statement, so that a meta in
  // second position is reported as "FIRST statement" as in the baseline (which parses as a module), not as a syntax
  // error. The columns stay because it is replaced by spaces.
  let forV8 = text;
  const exports = source.statements.flatMap((s) => (s.modifiers || []).filter((m) => m.kind === t.SyntaxKind.ExportKeyword));
  for (const exp of exports.reverse()) {
    const from = exp.getStart(source);
    forV8 = forV8.slice(0, from) + " ".repeat(exp.getEnd() - from) + forV8.slice(exp.getEnd());
  }
  try {
    v8Check(forV8);
  } catch (e) {
    throw new ScriptError(`Script parse error: ${e?.message || e}. ${HINT_PARSE}`);
  }
  if (!instruction) throw new MetaError(ERROR_FIRST_INSTRUCTION);
  let raw;
  try {
    raw = objectValue(t, withoutBrackets(t, instruction.declarationList.declarations[0].initializer));
  } catch (e) {
    throw new MetaError(`meta must be a pure literal: ${e.message}`);
  }
  const meta = normMeta(raw);
  const from = instruction.getStart(source);
  const until = instruction.getEnd();
  const body = text.slice(0, from) + text.slice(from, until).replace(/[^\n]/g, " ") + text.slice(until);
  const prohibition = prohibitionsInBody(body);
  if (prohibition) throw new ScriptError(`SyntaxError: ${prohibition}`);
  return { meta, body };
}
