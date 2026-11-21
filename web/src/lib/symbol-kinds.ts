// The outline as a tree styled like VS Code: color and glyph per symbol kind (VS Code `symbolIcon.*Foreground`: classes/enums/events
// orange, methods/functions/constructors violet, variables/fields/interfaces/enum members blue, the rest — also properties, structs,
// constants — in the text color; the glyph is the codicon of VS Code `SymbolKinds.toIcon`, paths in lib/codicon-symbols.ts), the
// order as VS Code's `DocumentSymbolComparator` (position · name · category), the visible rows of the tree after collapsing, and the
// chain of symbols at the cursor (the tree follows the cursor: the chain is expanded, its innermost segment marked).
//
// Pure (no imports): EXERCISED in web/test/editor-status.test.mjs.

/** A symbol in the shape of LSP `DocumentSymbol` (lib/api/lsp.ts `LspSymbol`) — only what the tree needs. */
export type TreeSymbol = {
  name: string;
  /** LSP SymbolKind as a number — or already as a name ("class", "enum member"; lib/api/lsp.ts `symbolKind`). */
  kind: number | string;
  detail?: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
  children?: TreeSymbol[];
};

export type SymbolGroup = "kind" | "method" | "variable" | "otherwise";
// LSP SymbolKind: 1 File, 2 Module, 3 Namespace, 4 Package, 5 Class, 6 Method, 7 Property, 8 Field, 9 Constructor, 10 Enum, 11 Interface,
// 12 Function, 13 Variable, 14 Constant, 15 String, 16 Number, 17 Boolean, 18 Array, 19 Object, 20 Key, 21 Null, 22 EnumMember, 23 Struct,
// 24 Event, 25 Operator, 26 TypeParameter.
// Property (7), struct (23) and constant (14) use the text color in VS Code (`symbolIcon.propertyForeground` etc. = foreground).
const GROUP: Record<number, SymbolGroup> = {
  5: "kind", 10: "kind", 24: "kind",
  6: "method", 9: "method", 12: "method",
  8: "variable", 11: "variable", 13: "variable", 22: "variable",
};
const NAMES = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface",
  "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum member", "struct", "event",
  "operator", "type parameter"];
/** The kind as an LSP count (a name is translated; unknown: 0). */
export const kindNumber = (kind: number | string): number => (typeof kind === "number" ? kind : Math.max(0, NAMES.indexOf(String(kind).toLowerCase())));
export const symbolGroup = (kind: number | string): SymbolGroup => GROUP[kindNumber(kind)] ?? "otherwise";

/** The group's color (VS Code Dark/Light Modern); null: the text color. */
export const GROUPS_COLOR: Readonly<Record<SymbolGroup, { dark: string; light: string } | null>> = {
  kind: { dark: "#ee9d28", light: "#d67e00" },
  method: { dark: "#b180d7", light: "#652d90" },
  variable: { dark: "#75beff", light: "#007acc" },
  otherwise: null,
};
export function symbolColor(kind: number | string, dark: boolean): string | null {
  const f = GROUPS_COLOR[symbolGroup(kind)];
  return f ? (dark ? f.dark : f.light) : null;
}

/** The codicon of a kind as VS Code `SymbolKinds.toIcon`: `symbol-<kind>` (space as dash: "enum member" → `symbol-enum-member`);
 *  unknown `symbol-property`. The path comes from lib/codicon-symbols.ts `codiconPath`. */
export function symbolIcon(kind: number | string): string {
  const n = kindNumber(kind);
  return n > 0 && n < NAMES.length ? `symbol-${NAMES[n].replace(/ /g, "-")}` : "symbol-property";
}

/** The outline's order as in VS Code (Outline "…" → Sort by: position · name · category; default position). */
export type SymbolOrdering = "position" | "name" | "kind";
export const SYMBOL_ORDERINGS: readonly SymbolOrdering[] = ["position", "name", "kind"];
type Pos = { line: number; character: number };
const comparePos = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;
/** VS Code `Range.compareRangesUsingStarts`: start, on equal start the end. */
const compareArea = (a: TreeSymbol["range"], b: TreeSymbol["range"]) => comparePos(a.start, b.start) || comparePos(a.end, b.end);
let collator: Intl.Collator | null = null;
/** Names as in VS Code (`Intl.Collator` with `numeric`: "a2" before "a10"). */
const compareName = (a: string, b: string) => (collator ??= new Intl.Collator(undefined, { numeric: true })).compare(a, b);
/** VS Code `DocumentSymbolComparator`: compareByPosition · compareByName · compareByType. */
const COMPARISON: Readonly<Record<SymbolOrdering, (a: TreeSymbol, b: TreeSymbol) => number>> = {
  position: (a, b) => compareArea(a.range, b.range) || compareName(a.name, b.name),
  name: (a, b) => compareName(a.name, b.name) || compareArea(a.range, b.range),
  kind: (a, b) => kindNumber(a.kind) - kindNumber(b.kind) || compareName(a.name, b.name),
};
/** The symbols in the order, at every depth (a copy; an unknown value orders by position). */
export function sortSymbols(symbols: readonly TreeSymbol[] | null | undefined, ordering: SymbolOrdering): TreeSymbol[] {
  const f = COMPARISON[ordering] ?? COMPARISON.position;
  return [...(symbols ?? [])].sort(f).map((s) => (s.children?.length ? { ...s, children: sortSymbols(s.children, ordering) } : s));
}
/** A stored value as an order (else the default, position). */
export const asOrdering = (v: unknown): SymbolOrdering => (SYMBOL_ORDERINGS.includes(v as SymbolOrdering) ? (v as SymbolOrdering) : "position");

export type TreeRow = { id: string; symbol: TreeSymbol; depth: number; hasChildren: boolean; open: boolean };
/** The visible rows: pre-order, children of a collapsed symbol are missing. `id` = the path of indexes ("0.2.1") — stable as long as
 *  the outline above the symbol does not change. */
export function treeRows(symbols: readonly TreeSymbol[] | null | undefined, closed: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const go = (list: readonly TreeSymbol[], depth: number, prefix: string) => {
    list.forEach((s, i) => {
      const id = prefix ? `${prefix}.${i}` : String(i);
      const hasChildren = Boolean(s.children?.length);
      const open = hasChildren && !closed.has(id);
      out.push({ id, symbol: s, depth, hasChildren, open });
      if (open) go(s.children ?? [], depth + 1, id);
    });
  };
  go(symbols ?? [], 0, "");
  return out;
}

const beforeOrEqual = (a: { line: number; character: number }, b: { line: number; character: number }) => a.line < b.line || (a.line === b.line && a.character <= b.character);
/** The ids of the symbols containing the position — outermost first (the tree expands them, the last is marked). */
export function chainsIds(symbols: readonly TreeSymbol[] | null | undefined, pos: { line: number; character: number }): string[] {
  const out: string[] = [];
  let level = symbols ?? [], prefix = "";
  for (;;) {
    const i = level.findIndex((s) => beforeOrEqual(s.range.start, pos) && beforeOrEqual(pos, s.range.end));
    if (i < 0) return out;
    const id = prefix ? `${prefix}.${i}` : String(i);
    out.push(id);
    prefix = id;
    level = level[i].children ?? [];
  }
}

/** All ids with children (for "Collapse all"). */
export function allWithChildren(symbols: readonly TreeSymbol[] | null | undefined): string[] {
  return treeRows(symbols, new Set()).filter((z) => z.hasChildren).map((z) => z.id);
}
