// The preview of a definition in the ⌘ hover (explorer and editor styled like VS Code) —
// which source rows stand at the target. Pure, no DOM; drawn in components/code/cmd-hover.ts. As in VS Code
// (`GotoDefinitionAtPositionEditorContribution`, `MAX_SOURCE_PREVIEW_LINES` = 8):
//
// - The RANGE of the definition, if it spans several rows and reaches fewer than PREVIEW_ROWS rows.
// - Otherwise — the server mostly reports only the name (server/backend/…/lsp/actions.js takes `targetSelectionRange`) — from the row of the
//   definition to the END OF ITS BLOCK by indentation: deeper indented rows and blank rows belong to it; the first row at
//   the same depth only if it closes the block (`}` `)` `]`), and if it reopens it at once (`): void {`, `} else {`), it goes on;
//   a shallower row never. A row without a deeper body (`const x = 1;`) stays alone. At most PREVIEW_ROWS rows (VS Code does not
//   show that it was truncated).
// - Indentation counts in CHARACTERS, not columns (VS Code `getLineFirstNonWhitespaceColumn`): a tab is one character, the preview needs
//   no tab width and is outdented by the smallest common number of leading spaces/tabs. Trailing blank rows drop; each row
//   at most `character` characters (a minified file would otherwise put a row of 100,000 characters in the hover), without splitting a character outside
//   the basic plane (surrogate pair).
//
// Tested by execution in web/test/editor-look.test.mjs (with sabotages).

export const PREVIEW_ROWS = 8;
type Pos = { line: number; character: number };
export type PreviewArea = { start: Pos; end: Pos };
/** `from`: the first row shown (0-based) in the target file. */
export type DefinitionsPreview = { rows: string[]; from: number };

const CLOSES = /^[}\])]/;
const OPENS_AGAIN = /(?:[{[(]|=>)\s*$/;
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(Math.floor(Number(x) || 0), lo), hi);
/** Leading spaces/tabs of a row in characters — -1: empty or only whitespace. */
export const insetCharacter = (z: string): number => { const m = /\S/.exec(z); return m ? m.index : -1; };
/** At most `n` UTF-16 units, without splitting a surrogate pair. */
function truncate(z: string, n: number): string {
  if (z.length <= n) return z;
  const up = z.charCodeAt(n - 1);
  return `${z.slice(0, up >= 0xd800 && up <= 0xdbff ? n - 1 : n)}…`;
}

export function definitionsPreview(rows: readonly string[], area: PreviewArea, o: { max?: number; character?: number } = {}): DefinitionsPreview {
  const max = Math.max(1, o.max ?? PREVIEW_ROWS), character = Math.max(20, o.character ?? 400);
  const n = rows.length;
  if (!n) return { rows: [], from: 0 };
  const from = clamp(area?.start?.line, 0, n - 1);
  let until = clamp(area?.end?.line, from, n - 1);
  if (until > from && Number(area?.end?.character) === 0) until -= 1; // ends at the start of the following row
  let end = from;
  if (until > from && until - from + 1 <= max) end = until;
  else {
    const start = insetCharacter(rows[from]);
    for (let i = from + 1; start >= 0 && i < n && i - from + 1 <= max; i++) {
      const e = insetCharacter(rows[i]);
      const closes = e === start && CLOSES.test(rows[i].trimStart());
      if (!(e < 0 || e > start || closes)) break; // shallower, or equally deep without closing: the block is over
      end = i;
      if (closes && !OPENS_AGAIN.test(rows[i].trimEnd())) break;
    }
  }
  const part = rows.slice(from, end + 1);
  while (part.length > 1 && insetCharacter(part[part.length - 1]) < 0) part.pop();
  const including = part.map(insetCharacter).filter((e) => e >= 0);
  const cut = including.length ? Math.min(...including) : 0;
  return { rows: part.map((z) => (insetCharacter(z) < 0 ? "" : truncate(z.slice(cut), character))), from };
}
