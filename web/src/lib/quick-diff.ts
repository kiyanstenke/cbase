// Port of: microsoft/vscode src/vs/workbench/contrib/scm/browser/quickDiffModel.ts (MIT)
// Port of: microsoft/vscode src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts (MIT)
// The quick-diff peek in the editor's git gutter, styled like VS Code 1.143: the computations behind components/code/quick-diff-peek.ts and
// components/code/git-gutter.ts; pure, EXECUTED in web/test/quick-diff.test.mjs (each with a sabotage).
//
// - THE CHANGE IN VS CODE'S SHAPE (`changes`): the gutter's blocks (lib/dirty-diff.ts, now against the index) as `IChange`: 1-based, a side
//   without lines has end 0 and as start the line BEFORE. Everything else computes as in VS Code on this shape
//   (Code - OSS, github.com/microsoft/vscode, tag 1.143.1: src/vs/workbench/contrib/scm/browser/quickDiffModel.ts, quickDiffWidget.ts):
//   `endRow` = getModifiedEndLineNumber (the peek sits there), `changeHeight` = getChangeHeight, `rowHits` = lineIntersectsChange,
//   `nextFrom`/`previousFrom` = findNextClosestChange/findPreviousClosestChange (inclusive).
// - NAVIGATION (`peekTarget`, QuickDiffController.next/previous + canNavigate): without an open peek (or with a row, the click into the
//   gutter) the next change from the row; with an open peek round-robin (index ± 1); with exactly one change and an open peek
//   Alt+F3/Shift+Alt+F3 do nothing. The click (`clickTarget`, onEditorMouseUp): on the open change it closes, otherwise `next(row)`.
// - WHEN THE LIST MOVES while a peek is open (`afterListSwitch`, onDidModelChange): if a difference begins at or before the open change
//   (sortedDiff + compareChanges), the peek jumps to the next one (round-robin, with cursor); otherwise it stays where it is; no change
//   left ⇒ close.
// - THE DIMENSIONS (`peekDimensions`, QuickDiffWidget.showChange + ZoneWidget/PeekViewWidget): height in rows min(change + 2 + 6, ⌊editor rows / 3⌋),
//   capped at max(12, 80 % of the editor rows), arrow ⌊row height / 3⌉, frame 1 px, header ⌈1.2 × row height⌉, below it the body.
// - WHAT THE PEEK SHOWS IN THE EMBEDDED DIFF (`peekView`, revealChange) and where the cursor jumps after stage/revert
//   (`cursorAfterAction`: VS Code sets `new Selection(modifiedStartLineNumber, 0)` with the 1-based number as a 0-based line, so one
//   line lower; reproduced as it is). Afterwards the peek closes (QuickDiffWidget: `onDidRun` closes after every error-free action except
//   next/previous).
// - WHICH CHANGE AN ACTION HITS (`findAgain`): the SHOWN one, found again in the freshly computed list at its place in the index (the
//   index side does not move while typing), never by number (the list may have shifted since it was shown).
// - STAGING (`stageBody`): the body of `POST …/git/stage-block` (server git.js `gitStageBlock`, guard server/backend/test/
//   git-stage-block.test.js): the block in lines of the INDEX, the lines from the BUFFER (unsaved, not the disk), the index's line count
//   and the checksum of the WHOLE base (`baseSha`, SHA-256 of the normalized text) it was computed against (if the index moves, the
//   server answers 409), and the new base the gutter takes over at once (and refetches afterwards).
//
// Only imports: `norm` (lib/file-status.ts), `sha256Hex` (lib/sha256.ts) and the type `DiffBlock` (lib/dirty-diff.ts). Origin and license of the
// ported parts: Code - OSS © Microsoft Corporation, MIT license (https://github.com/microsoft/vscode/blob/1.143.1/LICENSE.txt); the notice is in
// lib/thirdParty.ts.
import { norm } from "./file-status.js";
import type { DiffBlock } from "./dirty-diff.js";
import { sha256Hex } from "./sha256.js";

/** A change like VS Code `IChange` (1-based; end 0 = no lines on this side, start = the line before). */
export type Change = { originalStart: number; originalEnd: number; modifiedStart: number; modifiedEnd: number };
export type ChangeKind = "fresh" | "deleted" | "changed";

/** The gutter's blocks as changes in VS Code's shape; the index's lines from the offset of the blocks before. */
export function changes(blocks: readonly DiffBlock[]): Change[] {
  let offset = 0; // now − index, over all blocks before
  return blocks.map((b) => {
    const nowCount = b.kind === "deleted" ? 0 : b.until - b.from + 1;
    const beforeNow = b.kind === "deleted" ? b.from : b.from - 1; // lines in the current text before the block
    const beforeIndex = beforeNow - offset;
    offset += nowCount - b.old.length;
    if (b.kind === "fresh") return { originalStart: beforeIndex, originalEnd: 0, modifiedStart: b.from, modifiedEnd: b.until };
    const original = { originalStart: beforeIndex + 1, originalEnd: beforeIndex + b.old.length };
    return b.kind === "deleted" ? { ...original, modifiedStart: b.from, modifiedEnd: 0 } : { ...original, modifiedStart: b.from, modifiedEnd: b.until };
  });
}

/** getChangeType */
export const kindOf = (a: Change): ChangeKind => (a.originalEnd === 0 ? "fresh" : a.modifiedEnd === 0 ? "deleted" : "changed");
/** getModifiedEndLineNumber: the peek sits below this line (a deletion before the first line: below line 1). */
export const endRow = (a: Change): number => (a.modifiedEnd === 0 ? (a.modifiedStart === 0 ? 1 : a.modifiedStart) : a.modifiedEnd);
/** getChangeHeight: lines of the change (changed: both sides). */
export function changeHeight(a: Change): number {
  const now = a.modifiedEnd - a.modifiedStart + 1, index = a.originalEnd - a.originalStart + 1;
  if (a.originalEnd === 0) return now;
  if (a.modifiedEnd === 0) return index;
  return now + index;
}
/** lineIntersectsChange: does a click in the gutter on row `row` hit this change? */
export const rowHits = (row: number, a: Change): boolean =>
  (row === 1 && a.modifiedStart === 0 && a.modifiedEnd === 0) || (row >= a.modifiedStart && row <= (a.modifiedEnd || a.modifiedStart));
/** findNextClosestChange(row, inclusive = true): the first change that ends at or after the row; otherwise the first. */
export function nextFrom(list: readonly Change[], row: number): number {
  const i = list.findIndex((a) => endRow(a) >= row);
  return i < 0 ? 0 : i;
}
/** findPreviousClosestChange(row, inclusive = true): the last change that begins at or before the row; otherwise the last. */
export function previousFrom(list: readonly Change[], row: number): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].modifiedStart <= row) return i;
  return list.length - 1;
}
const roundRobin = (i: number, n: number) => ((i % n) + n) % n;

/** Alt+F3/Shift+Alt+F3 or the click: which change the peek shows; null: do nothing. `row` (the click) computes from that row. */
export function peekTarget(o: { list: readonly Change[]; open: number | null; cursorRow: number; direction: 1 | -1; row?: number }): number | null {
  const n = o.list.length;
  if (!n) return null;
  if (o.row === undefined && o.open !== null && n <= 1) return null; // canNavigate
  if (o.row !== undefined || o.open === null) {
    const startAt = o.row ?? o.cursorRow;
    return o.direction > 0 ? nextFrom(o.list, startAt) : previousFrom(o.list, startAt);
  }
  return roundRobin((o.open < n ? o.open : -1) + o.direction, n);
}

/** The click into the gutter (onEditorMouseUp): "close" on the open change, otherwise the change from the row; null: no hit. */
export function clickTarget(list: readonly Change[], open: number | null, row: number): { kind: "close" } | { kind: "show"; index: number } | null {
  const i = list.findIndex((a) => rowHits(row, a));
  if (i < 0) return null;
  if (i === open) return { kind: "close" };
  const z = peekTarget({ list, open, cursorRow: row, direction: 1, row });
  return z === null ? null : { kind: "show", index: z };
}

/** compareChanges */
const compare = (a: Change, b: Change): number =>
  a.modifiedStart - b.modifiedStart || a.modifiedEnd - b.modifiedEnd || a.originalStart - b.originalStart || a.originalEnd - b.originalEnd;
/** sortedDiff(prior, after, compareChanges): the beginnings of the differences (indices into `prior`). */
export function differenceBeginnings(prior: readonly Change[], after: readonly Change[]): number[] {
  const beginnings: number[] = [];
  let end = -1; // end of the last difference (start + deleteCount), so adjacent ones coincide
  const fresh = (start: number, count: number) => {
    if (beginnings.length && end === start) { end += count; return; }
    beginnings.push(start);
    end = start + count;
  };
  let i = 0, j = 0;
  for (;;) {
    if (i === prior.length) { if (j < after.length) fresh(i, 0); break; }
    if (j === after.length) { fresh(i, prior.length - i); break; }
    const c = compare(prior[i], after[j]);
    if (c === 0) { i++; j++; } else if (c < 0) { fresh(i, 1); i++; } else { fresh(i, 0); j++; }
  }
  return beginnings;
}

/** Does the list move while a peek is open (onDidModelChange; not while the peek has focus): "close" without changes, "jump" to the
 *  next one (round-robin from the open one, with cursor) if a difference begins at or before it, otherwise "stay" (title and content
 *  refreshed); null: nothing moved. */
export function afterListSwitch(prior: readonly Change[], after: readonly Change[], open: number): { kind: "close" } | { kind: "jump"; index: number } | { kind: "stay"; index: number } | null {
  const beginnings = differenceBeginnings(prior, after);
  if (!beginnings.length) return null;
  if (!after.length) return { kind: "close" };
  if (beginnings.some((s) => s <= open)) return { kind: "jump", index: roundRobin((open < after.length ? open : -1) + 1, after.length) };
  return { kind: "stay", index: Math.min(open, after.length - 1) };
}

/** The peek's dimensions in pixels (`rowHeight` and `editorHeight` in px). */
export type PeekDimensions = { rows: number; height: number; arrow: number; frame: number; holder: number; header: number; body: number };
/** `rowsDefault`: the height the handle set (ZoneWidget._relayout, without the cap of `show`). */
export function peekDimensions(a: Change, rowHeight: number, editorHeight: number, rowsDefault?: number): PeekDimensions {
  const lh = rowHeight;
  const editorRows = Math.floor(editorHeight / lh);
  // showChange: change + 2 + 6 rows, at most a third of the editor, plus 1 px (`h + 1 / lineHeight`); ZoneWidget.show caps at
  // 80 % of the editor (at least 12 rows).
  const rows = rowsDefault ?? Math.min(Math.min(changeHeight(a) + 2 + 6, Math.floor(editorRows / 3)) + 1 / lh, Math.max(12, (editorHeight / lh) * 0.8));
  const arrow = Math.round(lh / 3), frame = 1;
  const height = rows * lh;
  const holder = height - (2 * arrow + 2 * frame);
  const header = Math.ceil(lh * 1.2);
  const body = Math.max(0, Math.round(holder - (header + 1)));
  return { rows, height, arrow, frame, holder, header, body };
}
/** The handle at the bottom of the peek (ZoneWidget, isResizeable): the new height in rows; whole rows, only between 5 and 35 (otherwise null). */
export function dragHeight(startRows: number, dy: number, rowHeight: number): number | null {
  const delta = dy / rowHeight;
  const fresh = startRows + (delta < 0 ? Math.ceil(delta) : Math.floor(delta));
  return fresh > 5 && fresh < 35 ? fresh : null;
}

/** revealChange: the rows (1-based, in the current text) the embedded diff shows in the middle. */
export function peekView(a: Change): { from: number; until: number } {
  if (a.modifiedEnd === 0) return { from: a.modifiedStart, until: a.modifiedStart + 1 };
  if (a.originalEnd > 0) return { from: a.modifiedStart - 1, until: a.modifiedEnd + 1 };
  return { from: a.modifiedStart, until: a.modifiedEnd };
}
/** Where the cursor jumps after "Stage Change"/"Revert Change" (git.stageChange/revertChange): row modifiedStart + 1, column 1,
 *  clamped to the text's rows. */
export const cursorAfterAction = (a: Change, rows: number): number => Math.max(1, Math.min(a.modifiedStart + 1, rows));
/** The shown change in a freshly computed list: the same place in the index (`originalStart`/`originalEnd`); the index is fixed
 *  while typing, the buffer is not. -1: it no longer exists (two blocks merged, it is gone). */
export const findAgain = (list: readonly Change[], shown: Change): number =>
  list.findIndex((a) => a.originalStart === shown.originalStart && a.originalEnd === shown.originalEnd);

/** The peek's title (renderTitle, without selection list): "<source> - n of m changes"; the singular for exactly one change. */
export const titleKey = (count: number): string => (count > 1 ? "{source} - {n} of {m} changes" : "{source} - {n} of {m} change");

const rowsOf = (t: string): string[] => { const n = norm(t); return n === "" ? [] : n.split("\n"); };
export type StageBody = { from: number; until: number; old: string[]; rows: string[]; rowCount: number; lineEnding: "\n" | "\r\n"; baseSha: string };
/** The body of `POST …/git/stage-block` for block `index` (against `base` = the index, `now` = the buffer) and the base afterwards. */
export function stageBody(base: string, now: string, blocks: readonly DiffBlock[], index: number, lineEnding: "\n" | "\r\n"): { body: StageBody; newBase: string } | null {
  const b = blocks[index], a = changes(blocks)[index];
  if (!b || !a) return null;
  const indexRows = rowsOf(base), nowRows = rowsOf(now);
  const from = a.originalEnd === 0 ? a.originalStart : a.originalStart - 1; // 0-based, half-open
  const until = from + b.old.length;
  const rows = a.modifiedEnd === 0 ? [] : nowRows.slice(a.modifiedStart - 1, a.modifiedEnd);
  const newBase = [...indexRows.slice(0, from), ...rows, ...indexRows.slice(until)].join("\n");
  const baseSha = sha256Hex(norm(base)); // the WHOLE base; the server compares it with the index before it writes
  return { body: { from, until, old: indexRows.slice(from, until), rows, rowCount: indexRows.length, lineEnding, baseSha }, newBase };
}
