// What is being dragged right now: a tab (and from which group) or entries of the explorer. Drop targets of the tab bars
// (components/code/TabBar.tsx `CodeTabBar`) and of the group surfaces (EditorGroups.tsx) read it. While dragging, the browser
// withholds the drag data (only its types are readable); this slot says WHERE the drag comes from. Only drags from the SAME area
// (`area`: ONE CodePane) are accepted, not drags from another code area or from the chat. Set on `dragstart`, cleared on `dragend`;
// Alt while dragging turns a move into a copy (as in VS Code).
export type Transaction =
  | { area: string; kind: "tab"; group: string; path: string; copy: boolean }
  | { area: string; kind: "tree" };

let turn: Transaction | null = null;
let end: (() => void) | null = null;
let seq = 0;
/** Remember a drag (at start) or forget it. A moved tab takes its source element with it (often the whole group), so its `dragend` never
 *  arrives. Hence every drag also ends at the document: after the drop (once all handlers have read it) and on any `dragend` that still
 *  reaches the document. */
export function rememberDrag(z: Transaction | null): void {
  turn = z;
  seq += 1;
  end?.();
  end = null;
  if (!z || typeof document === "undefined") return;
  const mine = seq;
  const past = () => { if (seq === mine) turn = null; }; // `copyInTransaction` replaces the object — the drag is counted, not the object
  const afterDrop = () => { setTimeout(past, 0); };
  document.addEventListener("drop", afterDrop, true);
  document.addEventListener("dragend", past, true);
  end = () => { document.removeEventListener("drop", afterDrop, true); document.removeEventListener("dragend", past, true); };
}
export function runningDrag(): Transaction | null { return turn; }
/** The drag of one area — null if none is running or it comes from another area. */
export function dragFrom(area: string): Transaction | null { return turn && turn.area === area ? turn : null; }
/** Alt pressed (on every `dragover`): a tab is copied instead of moved. */
export function copyInTransaction(alt: boolean): void { if (turn?.kind === "tab" && turn.copy !== alt) turn = { ...turn, copy: alt }; }
/** The paths of a drop from the explorer (its data type carries `{ apiBase, instance, paths }` as JSON, explorer/ExplorerTree.tsx `DRAG_TYPE`);
 *  unreadable data yields none. Where the drop comes from is told by `dragFrom(area)` (only THIS CodePane), not by the content. */
export function pathsFrom(json: string): string[] {
  try {
    const raw = JSON.parse(json) as unknown;
    const list = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { paths?: unknown }).paths : null;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && p !== "") : [];
  } catch { return []; }
}
