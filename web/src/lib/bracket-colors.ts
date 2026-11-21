// Bracket-pair colorization in the code editor: pure, no DOM. Styled like VS Code `editor.bracketPairColorization` (ONE color pool for
// all bracket kinds `( ) [ ] { }`, color = depth, cycling):
//
// - A closing bracket that matches the most recently opened one closes it. If it matches one opened FURTHER OUT, it closes THAT one and
//   the skipped inner openers stay without a partner: MISMATCHED (red). If it matches no open bracket it is itself mismatched and closes
//   nothing (VS Code: the parser ends a list at any bracket that closes ANY open one).
// - An opener never closed before end of file is mismatched.
// - Depth counts every open pair, mismatched ones included (like VS Code `nestingLevel`).
//
// The computation is a `BracketRun` that advances in sections and remembers its stack every CHECKPOINT_GAP characters: after an edit it
// recomputes from the last checkpoint before it (`dismissFrom`), not from the file start. It only computes as far as the view needs: to
// the end of the visible range and beyond only until every VISIBLE opener is decided (`decide`, otherwise nobody knows whether it is red).
// No cap: a visible opener whose partner lies far below computes down to it (like VS Code, which knows the whole file).
//
// What is a string or comment (brackets do not count there) is told by the SYNTAX TREE through its highlight tags (`notCodeAreas`):
// anything that would be highlighted as string (also attributeValue, docString, character), comment or regexp. A `${…}` in a template
// and `{…}` in an f-string are their own nodes and thus code. In addition what the tags do not say: TS template types (`TemplateType`)
// and unquoted YAML values (VS Code: `string.unquoted`). Tested against real Lezer trees.
//
// The colors (Dark Modern / Light Modern) live here so the guard holds them; the theme (components/code/codeTheme.ts) sets them as
// variables, components/code/brackets.ts draws.
//
// Tested by execution in web/test/editor-look.test.mjs (with sabotage).
import { highlightTree, tags as t, type Highlighter } from "@lezer/highlight";
import type { SyntaxNodeRef, Tree } from "@lezer/common";

/** The run remembers its stack every this many characters; after an edit it recomputes from the last checkpoint before it. */
export const CHECKPOINT_GAP = 4000;

/** A bracket: `kind` 0 ( 1 [ 2 {, `depth` the number of open pairs around it, `ok` true paired, false mismatched, null still open. */
export type Bracket = { pos: number; kind: number; open: boolean; depth: number; ok: boolean | null };
export type Area = readonly [number, number];
type Checkpoint = { pos: number; count: number; stack: number[] };

/** The kind of a bracket by char code: 0–2 opening, 3–5 closing, -1 none. */
function kindOf(c: number): number {
  switch (c) {
    case 40: return 0; case 91: return 1; case 123: return 2;
    case 41: return 3; case 93: return 4; case 125: return 5;
    default: return -1;
  }
}

export class BracketRun {
  readonly findings: Bracket[] = [];
  /** The indices (into `findings`) of the open brackets, innermost last. */
  private stack: number[] = [];
  private checkpoints: Checkpoint[] = [{ pos: 0, count: 0, stack: [] }];
  /** Computed up to here (exclusive). */
  far = 0;
  constructor(readonly gap = CHECKPOINT_GAP) {}

  /** Everything from `pos` on is void (the text or its classification changed there): back to the last checkpoint before it. Brackets
   *  open there are undecided again. */
  dismissFrom(pos: number): void {
    let i = this.checkpoints.length - 1;
    while (i > 0 && this.checkpoints[i].pos > pos) i -= 1;
    const s = this.checkpoints[i];
    this.checkpoints.length = i + 1;
    this.findings.length = s.count;
    this.stack = s.stack.slice();
    for (const k of this.stack) this.findings[k].ok = null;
    this.far = s.pos;
  }

  /** Computes on up to `until` (at most `end`, the text length). If the run reaches the end, the brackets still open are mismatched. */
  further(until: number, end: number, text: (from: number, until: number) => string, notCode: (from: number, until: number) => readonly Area[]): void {
    const target = Math.min(until, end);
    while (this.far < target) {
      const checkpoint = (Math.floor(this.far / this.gap) + 1) * this.gap;
      const b = Math.min(target, checkpoint);
      this.section(this.far, text(this.far, b), notCode(this.far, b));
      this.far = b;
      if (b === checkpoint) this.checkpoints.push({ pos: b, count: this.findings.length, stack: this.stack.slice() });
    }
    if (this.far >= end) for (const k of this.stack) this.findings[k].ok = false;
  }

  /** Computes on until every open bracket from `start` on is decided (paired or mismatched), at most up to `end`. */
  decide(start: number, end: number, text: (from: number, until: number) => string, notCode: (from: number, until: number) => readonly Area[]): void {
    for (;;) {
      const top = this.stack[this.stack.length - 1];
      if (top === undefined || this.findings[top].pos < start || this.far >= end) return; // the stack is ordered by position
      this.further(this.far + this.gap, end, text, notCode);
    }
  }

  private section(from: number, s: string, notCode: readonly Area[]): void {
    const findings = this.findings, stack = this.stack;
    let r = 0;
    for (let i = 0; i < s.length; i++) {
      const a = kindOf(s.charCodeAt(i));
      if (a < 0) continue;
      const pos = from + i;
      while (r < notCode.length && notCode[r][1] <= pos) r += 1;
      if (r < notCode.length && notCode[r][0] <= pos) continue; // inside a string or comment
      if (a < 3) { stack.push(findings.push({ pos, kind: a, open: true, depth: stack.length, ok: null }) - 1); continue; }
      let j = stack.length - 1;
      while (j >= 0 && findings[stack[j]].kind !== a - 3) j -= 1;
      if (j < 0) { findings.push({ pos, kind: a - 3, open: false, depth: stack.length, ok: false }); continue; }
      while (stack.length - 1 > j) findings[stack.pop()!].ok = false; // skipped: no partner
      findings[stack.pop()!].ok = true;
      findings.push({ pos, kind: a - 3, open: false, depth: stack.length, ok: true });
    }
  }
}

/** The index of the first bracket at or after `pos` (binary search). */
export function firstFrom(findings: readonly Bracket[], pos: number): number {
  let lo = 0, hi = findings.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (findings[m].pos < pos) lo = m + 1; else hi = m; }
  return lo;
}

/** A whole text at once (for tests and small texts). */
export function bracketsOf(text: string, notCode: readonly Area[] = []): Bracket[] {
  const run = new BracketRun();
  run.further(text.length, text.length, (a, b) => text.slice(a, b), (a, b) => notCode.filter(([x, y]) => y > a && x < b));
  return run.findings;
}

/** The color of a bracket: 0, 1, 2 cycling by depth; -1: mismatched (red). */
export const bracketColor = (k: Pick<Bracket, "depth" | "ok">): number => (k.ok === false ? -1 : k.depth % 3);

// ── What is not code in the syntax tree ────────────────────────────────────────────────────────────────────────────────────────────────────
const NOT_CODE_TAGS = new Set([t.string, t.comment, t.regexp]);
/** A highlighter that only says “not code”: tags together with their parent tags (`attributeValue` ⊂ `string`, `lineComment` ⊂ `comment`, …). */
const NOT_CODE: Highlighter = { style: (tags) => (tags.some((x) => x.set.some((s) => NOT_CODE_TAGS.has(s))) ? "x" : null) };

function add(out: [number, number][], a: number, b: number) {
  const l = out[out.length - 1];
  if (l && a <= l[1]) l[1] = Math.max(l[1], b);
  else out.push([a, b]);
}
function isYaml(n: SyntaxNodeRef): boolean {
  for (let p = n.node.parent; p; p = p.parent) if (p.type.isTop) return p.name === "Stream";
  return false;
}

/** The ranges in [from, until) that are string, comment or regular expression — sorted and merged. */
export function notCodeAreas(tree: Tree, from: number, until: number): Area[] {
  const raw: [number, number][] = [];
  highlightTree(tree, NOT_CODE, (a, b) => { raw.push([a, b]); }, from, until);
  // What the tags do not say: a TS template type (without its `${…}`), unquoted YAML values and block contents.
  tree.iterate({
    from: from, to: until,
    enter: (n) => {
      if (n.name === "TemplateType") {
        let a = n.from;
        for (let c = n.node.firstChild; c; c = c.nextSibling) if (c.name === "Interpolation") { if (c.from > a) raw.push([a, c.from]); a = c.to; }
        if (n.to > a) raw.push([a, n.to]);
        return false;
      }
      if ((n.name === "Literal" && n.node.parent?.name !== "Key" && isYaml(n)) || n.name === "BlockLiteralContent") { raw.push([n.from, n.to]); return false; }
      return undefined;
    },
  });
  raw.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of raw) add(out, Math.max(a, from), Math.min(b, until));
  return out.filter(([a, b]) => b > a);
}

/** The first position BEFORE `until` where two trees of the SAME text differ (-1: none). After a new tree without a text change (the
 *  parser advanced, an embedded language loaded) only the part from there needs recomputing, and only if it lies before what is already
 *  computed (`until`). Both trees are read in lockstep over their named nodes (type, start, end; an end beyond `until` counts as `until`);
 *  a subtree both carry as the same object is skipped. Unnamed nodes (Lezer's balancing) do not count: a subtree from a buffer and the
 *  finished tree of balanced nodes describe the same text equally. */
export function firstDeviation(old: Tree, fresh: Tree, until: number = Math.max(old.length, fresh.length)): number {
  if (old === fresh) return -1;
  const a = old.cursor(), b = fresh.cursor();
  let limit = until, aEnd = false, bEnd = false;
  for (;;) {
    const af = aEnd ? Infinity : a.from, bf = bEnd ? Infinity : b.from;
    if (af >= limit && bf >= limit) return limit < until ? limit : -1;
    if (af !== bf || a.type !== b.type) return Math.min(af, bf, limit); // no longer in lockstep from here
    const at = Math.min(a.to, limit), bt = Math.min(b.to, limit);
    if (at !== bt) limit = Math.min(at, bt); // a node ends differently: it may differ from there on, before that comparison continues
    const equal = a.tree !== null && a.tree === b.tree;
    aEnd = !a.next(!equal);
    bEnd = !b.next(!equal);
  }
}

/** VS Code `editorBracketHighlight.foreground1–3` and `.unexpectedBracket.foreground` (Dark Modern / Light Modern). */
export const BRACKET_COLORS = {
  dark: ["#ffd700", "#da70d6", "#179fff"],
  light: ["#0431fa", "#319331", "#7b3814"],
  mismatched: "#ff1212cc",
} as const;
