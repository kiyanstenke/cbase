"use client";
// A row of the explorer as in VS Code: 22 px, full width without rounding, indent 8 px per level + 16 px arrow, font 13 px (shape in
// app/globals.css `.cb-tree-row`); indent lines per level (visible on hover over the tree, the selection folder's lighter); file icon ONLY
// from FileSymbol.tsx (Seti), folders without icon; name and on the right "2, M" or ● in the colour from lib/explorer-decoration.ts; a
// compact row ("src/components") with each segment clickable and droppable on its own. The row stands ABSOLUTE at `top` in the window
// (TreeWindow.tsx, only the visible rows) and carries `aria-setsize`/`aria-posinset` from lib/tree-window.ts `ariaSet` — without them a
// screen reader would read only the drawn rows.
//
// `data-tree-path`/`data-tree-kind` are carried by the row AND each segment — the drop (`depositTarget` in ExplorerTree.tsx) and DOM
// probes in a real browser read them. Selection/focus/drop as data attributes, the surfaces for them stand unlayered in globals.css.
// The row carries an `id` (the tree names it in `aria-activedescendant`); in the field InlineField draws the file icon (it follows the typed
// extension); on the right ⤷ stands for a symlink (VS Code `ExplorerDecorationsProvider`); a folder with problems VS Code shows with ● in the
// problem colour, without a number. The search widget's hits are highlighted in the name (VS Code `list.highlightForeground`, bold —
// `.cb-tree-hits`); `hits` is the search's map (lib/tree-search.ts), set only on rows with a hit (otherwise null: `memo` holds).
import { memo } from "react";
import { FileSymbol } from "@/components/code/FileSymbol";
import { ArrowSymbol } from "@/components/code/explorer/ExplorerHeader";
import type { EntryRow } from "@/lib/explorer-tree";
import type { Decoration } from "@/lib/explorer-decoration";
import type { Area } from "@/lib/tree-search";

/** The name with its hits as highlighted pieces. */
function marked(text: string, b: readonly Area[] | undefined): React.ReactNode {
  if (!b?.length) return text;
  const out: React.ReactNode[] = [];
  let start = 0;
  for (const [from, until] of b) {
    if (from > start) out.push(text.slice(start, from));
    out.push(<span key={from} className="cb-tree-hits">{text.slice(from, until)}</span>);
    start = until;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** The left edge of a row of depth `depth` (8 px + 8 px per level, before it the 16 px arrow). */
export const inset = (depth: number) => 8 + depth * 8;
/** The indent line of level `i` — under the middle of its folder's arrow. */
export const lineAt = (i: number) => inset(i) + 8;

export const TreeRow = memo(function TreeRow({ id, top, setsize, posinset, row, selected, focus, cut, deposit, deco, activeFolder, hits = null, field, onClick, onDouble, onMenu, onDrag }: {
  id: string;
  /** The position in the window (index × row height, TreeWindow.tsx). */
  top: number;
  /** VS Code `AbstractTree` `getSetSize`/`getPosInSet`: siblings in the same folder, the place among them (from 1). */
  setsize: number; posinset: number;
  row: EntryRow;
  /** Individually (not as an object) so that `memo` holds: while typing in the editor the tree redraws only the rows that change. */
  selected: boolean; focus: boolean; cut: boolean; deposit: boolean;
  deco: Decoration;
  /** The folder whose line stands lighter (the selection's). */
  activeFolder: string | null;
  /** The search's hits per segment (only on rows with a hit). */
  hits?: ReadonlyMap<string, Area[]> | null;
  /** Instead of the name: the field for renaming. */
  field?: React.ReactNode;
  onClick: (e: React.MouseEvent, path: string, row: EntryRow) => void;
  onDouble: (path: string, row: EntryRow) => void;
  onMenu: (e: React.MouseEvent, path: string) => void;
  onDrag: (e: React.DragEvent, path: string) => void;
}) {
  const folder = row.type === "dir";
  const compact = row.chain.length > 1;
  const name = row.chain[row.chain.length - 1].name;
  const color = deco.color ?? undefined;
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={setsize}
      aria-posinset={posinset}
      aria-expanded={folder ? row.open : undefined}
      aria-selected={selected}
      data-tree-path={row.path}
      data-tree-kind={row.type}
      data-selected={selected ? "" : undefined}
      data-focus={focus ? "" : undefined}
      data-cut={cut ? "" : undefined}
      data-deposit={deposit ? "" : undefined}
      data-ignored={deco.dimmed ? "" : undefined}
      title={row.path}
      draggable={!field}
      onDragStart={(e) => onDrag(e, row.path)}
      onClick={(e) => onClick(e, row.path, row)}
      onDoubleClick={() => onDouble(row.path, row)}
      onContextMenu={(e) => onMenu(e, row.path)}
      className="cb-tree-row"
      style={{ top, paddingLeft: inset(row.depth) }}
    >
      {row.ancestors.map((a, i) => (
        <span key={a} aria-hidden className="cb-tree-line" data-active={a === activeFolder ? "" : undefined} style={{ left: lineAt(i) }} />
      ))}
      <span className="grid w-4 shrink-0 place-items-center text-fg">{folder ? <ArrowSymbol open={row.open} /> : null}</span>
      {!folder && !field && <FileSymbol path={row.path} className="ml-0.5 mr-1.5" />}
      {folder && <span className="w-1.5 shrink-0" />}
      {field ?? (
        <span className={`cb-tree-name min-w-0 flex-1 truncate ${deco.through ? "line-through" : ""}`} style={{ color: color }}>
          {compact ? row.chain.map((g, i) => (
            <span key={g.path}>
              <span
                data-tree-path={g.path}
                data-tree-kind="dir"
                data-tree-segment
                className="cb-tree-segment"
                onClick={(e) => { e.stopPropagation(); onClick(e, g.path, row); }}
                onContextMenu={(e) => { e.stopPropagation(); onMenu(e, g.path); }}
              >{marked(g.name, hits?.get(g.path))}</span>
              {i < row.chain.length - 1 && <span aria-hidden className="px-px opacity-70">/</span>}
            </span>
          )) : marked(name, hits?.get(row.path))}
        </span>
      )}
      {!field && deco.character && <span className="shrink-0 pl-2 pr-3 text-[12px]" style={{ color: color }} data-tree-character>{deco.character}</span>}
      {!field && deco.point && <span className="shrink-0 pl-2 pr-3 text-[9px]" style={{ color: color }} aria-hidden data-tree-point>●</span>}
    </div>
  );
});
