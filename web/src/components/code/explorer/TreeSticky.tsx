"use client";
// Sticky scroll in the tree as in VS Code: the parent folders of the topmost visible row stick on top over the scrolling tree, at most 7
// (VS Code `workbench.tree.stickyScrollMaxItemCount`); below them the shadow (VS Code `scrollbar.shadow`,
// `.monaco-tree-sticky-container-shadow`). A click scrolls the tree so that the folder stands in its place, and selects it. Which rows
// stick and where is computed by lib/tree-sticky.ts; the rows carry the tree's form (indent, arrow, name in the decoration's colour).
import type { EntryRow } from "@/lib/explorer-tree";
import type { StickyNode } from "@/lib/tree-sticky";
import type { Decoration } from "@/lib/explorer-decoration";
import { ArrowSymbol } from "@/components/code/explorer/ExplorerHeader";
import { inset } from "@/components/code/explorer/TreeRow";

export function TreeSticky({ node, rows, h, margin, deco, onClick }: {
  node: readonly StickyNode[];
  rows: readonly EntryRow[];
  /** The tree's row height. */
  h: number;
  /** The width of the scrollbar on the right (the sticky rows do not cover it). */
  margin: number;
  deco: (path: string) => Decoration | undefined;
  /** Click on the sticky row at slot `slot` (0 = top). */
  onClick: (k: StickyNode, slot: number) => void;
}) {
  if (!node.length) return null;
  const last = node[node.length - 1];
  const height = Math.max(0, last.top + h);
  return (
    <div className="cb-tree-sticky absolute left-0 top-0 z-10 overflow-hidden" style={{ right: margin, height: height }} role="presentation" data-tree-sticky>
      {node.map((k, slot) => {
        const z = rows[slot];
        const d = deco(z.path);
        return (
          <div key={z.path} className="cb-tree-row absolute inset-x-0" style={{ top: k.top, height: h, paddingLeft: inset(z.depth), zIndex: node.length - slot }}
            title={z.path} onClick={() => onClick(k, slot)} data-tree-sticky-row={z.path}>
            <span className="grid w-4 shrink-0 place-items-center text-fg"><ArrowSymbol open /></span>
            <span className="w-1.5 shrink-0" />
            <span className="cb-tree-name min-w-0 flex-1 truncate" style={{ color: d?.color ?? undefined }}>{z.chain.map((g) => g.name).join("/")}</span>
          </div>
        );
      })}
      <div aria-hidden className="cb-tree-sticky-shadow" style={{ top: height - 3 }} />
    </div>
  );
}
