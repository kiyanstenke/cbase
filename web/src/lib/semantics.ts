// Semantic highlighting, styled like VS Code: the language service reports a kind per identifier (variable, function, class, …) and
// modifiers (readonly, defaultLibrary, …); VS Code lays the color over the syntax coloring: `const` values #4fc1ff, functions as value
// #dcdcaa, classes and namespaces #4ec9b0, where the grammar sees only "variable". The pure computations:
//
// - `decodeSemantics`: LSP `SemanticTokens.data` (five numbers per token: line delta, column (relative while the line stays), length,
//   kind index, modifier bits) with the server's legend → tokens with row/column/length (UTF-16) and names.
// - `semanticsRule`: the rule that applies to a token, computed like VS Code `ColorThemeData.getTokenStyle`: of the default rules
//   (src/vs/platform/theme/common/tokenClassificationRegistry.ts) the one with the highest score that has a color applies: kind in the
//   hierarchy (100 − level) plus 100 per modifier, tie: the later one. Without a rule with a color ⇒ null: the syntax coloring stays (as
//   in VS Code when the theme says nothing). `semanticsColor` is its color in Dark Modern or Light Modern, `semanticsClass` the class
//   on the text (components/code/lsp-semantics.ts colors it per mode).
// - `SEMANTICS_RULES`: per rule the color of both themes, computed from the rule's probes (`scopesToProbe`) against the tokenColors of
//   Dark Modern (← Dark+ ← Dark VS) and Light Modern (← Light+ ← Light VS) with VS Code's matching (colorThemeData.ts `nameMatcher`:
//   prefix at dot boundaries, score = length, tie: the later rule). Both themes switch `semanticHighlighting` on; their own
//   semanticTokenColors (newOperator, stringLiteral, customLiteral, numberLiteral) concern kinds that TypeScript and Python do not report.
// - `semanticsSpans`: tokens → spans in the text (ascending, without overlap, cut at the line end); `semanticsDelay`: the quiet time after
//   a change like VS Code (moving average of the last six request durations, 300–2,000 ms).
//
// Pure (no imports): EXECUTED in web/test/semantics.test.mjs (the spans against CodeMirror's real `Text` and `RangeSetBuilder`).

/** [selector "kind(.modifier)*", Dark Modern, Light Modern], in VS Code's registration order (a tie: the later one). */
export const SEMANTICS_RULES: readonly (readonly [string, string | null, string | null])[] = [
  ["comment", "#6a9955", "#008000"],
  ["string", "#ce9178", "#a31515"],
  ["keyword", "#c586c0", "#af00db"],
  ["number", "#b5cea8", "#098658"],
  ["regexp", "#646695", "#811f3f"],
  ["operator", "#d4d4d4", "#000000"],
  ["namespace", "#4ec9b0", "#267f99"],
  ["type", "#4ec9b0", "#267f99"],
  ["struct", "#4ec9b0", "#267f99"],
  ["class", "#4ec9b0", "#267f99"],
  ["interface", "#4ec9b0", "#267f99"],
  ["enum", "#4ec9b0", "#267f99"],
  ["typeParameter", "#4ec9b0", "#267f99"],
  ["function", "#dcdcaa", "#795e26"],
  ["method", "#dcdcaa", "#795e26"],
  ["macro", "#569cd6", "#0000ff"],
  ["variable", "#9cdcfe", "#001080"],
  ["parameter", "#9cdcfe", "#001080"],
  ["property", "#9cdcfe", "#001080"],
  ["enumMember", "#4fc1ff", "#0070c1"],
  ["event", "#9cdcfe", "#001080"],
  ["decorator", "#dcdcaa", "#795e26"],
  ["variable.readonly", "#4fc1ff", "#0070c1"],
  ["property.readonly", "#4fc1ff", "#0070c1"],
  ["type.defaultLibrary", "#4ec9b0", "#267f99"],
  ["class.defaultLibrary", "#4ec9b0", "#267f99"],
  ["interface.defaultLibrary", "#4ec9b0", "#267f99"],
  ["variable.defaultLibrary", "#9cdcfe", "#001080"],
  ["variable.defaultLibrary.readonly", null, null],
  ["property.defaultLibrary", "#9cdcfe", "#001080"],
  ["property.defaultLibrary.readonly", null, null],
  ["function.defaultLibrary", "#dcdcaa", "#795e26"],
  ["member.defaultLibrary", "#dcdcaa", "#795e26"],
];
/** Super types (VS Code `superType`): `member` is `method` (registered as deprecated); the parameters `self`/`cls` of Pylance/basedpyright. */
const SUPERTYPE: Readonly<Record<string, string>> = { member: "method", selfParameter: "parameter", clsParameter: "parameter" };

function hierarchy(kind: string): string[] {
  const out = [kind];
  for (let a = SUPERTYPE[kind]; a && !out.includes(a); a = SUPERTYPE[a]) out.push(a);
  return out;
}
const RULES = SEMANTICS_RULES.map(([sel, dark, light]) => { const [kind, ...mods] = sel.split("."); return { sel, kind, mods, dark, light }; });

/** The rule that applies to a token (its selector), or null (no rule with a color; the syntax coloring stays). Both themes have
 *  colors on the same rules (web/test/semantics.test.mjs holds that), so the rule is independent of the mode, the color is not. */
export function semanticsRule(kind: string, modifiers: readonly string[]): string | null {
  const stages = hierarchy(kind);
  let best: string | null = null, score = -1;
  for (const r of RULES) {
    if (!r.dark) continue;
    const stage = stages.indexOf(r.kind);
    if (stage < 0 || !r.mods.every((m) => modifiers.includes(m))) continue;
    const w = 100 - stage + 100 * r.mods.length;
    if (w >= score) { score = w; best = r.sel; }
  }
  return best;
}
/** The color of a token in the mode (null: none). */
export function semanticsColor(kind: string, modifiers: readonly string[], dark: boolean): string | null {
  const sel = semanticsRule(kind, modifiers);
  const r = sel ? RULES.find((x) => x.sel === sel) : null;
  return r ? (dark ? r.dark : r.light) : null;
}

export type SemanticsToken = { row: number; column: number; length: number; kind: string; modifiers: string[] };
/** LSP `data` + legend → tokens. A kind index outside the legend yields the kind "" (no rule applies); incomplete groups of five at the
 *  end are dropped. */
export function decodeSemantics(data: readonly number[], legend: { types: readonly string[]; modifiers: readonly string[] }): SemanticsToken[] {
  const out: SemanticsToken[] = [];
  let row = 0, column = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dz = data[i], ds = data[i + 1];
    row += dz;
    column = dz === 0 ? column + ds : ds;
    const bits = data[i + 4];
    const modifiers: string[] = [];
    for (let b = 0; b < legend.modifiers.length && b < 31; b++) if (bits & (1 << b)) modifiers.push(legend.modifiers[b]);
    out.push({ row, column, length: data[i + 2], kind: legend.types[data[i + 3]] ?? "", modifiers });
  }
  return out;
}

/** The lines of a text; CodeMirror's `Text` satisfies it. */
export interface SemanticsRows { readonly lines: number; line(n: number): { from: number; to: number } }
export type SemanticsSpan = { from: number; until: number; rule: string };
/** Tokens → spans in the text (offsets, row/column in UTF-16 like CodeMirror), ascending and without overlap, as CodeMirror's
 *  `RangeSetBuilder` demands (components/code/lsp-semantics.ts). What reaches past the line end ends there; a line beyond the text, an
 *  empty span, a token without a rule (the syntax coloring stays) and one that begins inside the previous span are dropped. */
export function semanticsSpans(doc: SemanticsRows, data: readonly number[], legend: { types: readonly string[]; modifiers: readonly string[] }): SemanticsSpan[] {
  const out: SemanticsSpan[] = [];
  let last = -1;
  for (const t of decodeSemantics(data, legend)) {
    if (t.row >= doc.lines || t.length <= 0) continue;
    const rule = semanticsRule(t.kind, t.modifiers);
    if (!rule) continue;
    const z = doc.line(t.row + 1);
    const from = Math.min(z.to, z.from + t.column), until = Math.min(z.to, from + t.length);
    if (until <= from || from < last) continue;
    out.push({ from, until, rule });
    last = until;
  }
  return out;
}

/** How long after a change until the next request: VS Code `ModelSemanticColoring` (REQUEST_MIN_DELAY 300, REQUEST_MAX_DELAY 2,000)
 *  via `LanguageFeatureDebounceInformation`: the moving average of the last six request durations, clamped; without measurement min · 1.5. */
export const SEMANTICS_TICK = Object.freeze({ min: 300, max: 2000, window: 6, without: 450 });
export function semanticsDelay(durations: readonly number[]): number {
  const last = durations.slice(-SEMANTICS_TICK.window).filter((x) => Number.isFinite(x) && x >= 0);
  if (!last.length) return SEMANTICS_TICK.without;
  const cut = last.reduce((a, b) => a + b, 0) / last.length;
  return Math.round(Math.min(SEMANTICS_TICK.max, Math.max(SEMANTICS_TICK.min, cut)));
}

/** The class on the editor for a rule (`variable.readonly` → `cm-sem-variable-readonly`); the color per mode is set by the base theme
 *  (components/code/lsp-semantics.ts) from SEMANTICS_RULES. */
export const semanticsClass = (rule: string): string => `cm-sem-${rule.replace(/\./g, "-")}`;
