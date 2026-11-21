"use client";

// Breadcrumbs (editor navigation as in VS Code): the symbols at the insertion point behind the path in the title row of a file tab
// (chat/ChatTabBar.tsx `ChatTabTitle`): path > class > function. A click on a segment opens the list of its siblings (the editor's
// Kit menu, components/code/EditorMenu.tsx); a choice jumps there. lib/symbol-chain.ts `symbolChain` computes the chain from the
// outline of the view (components/code/lsp-layout.ts); without a server or outline nothing is shown. The tab names the target and path
// of ITS view, the outline hangs on the (canonical) buffer, converted through the coordinates.
//
// `PathCrumbs`: the path before it as in VS Code: every segment is a button, the file with its file icon (folders carry none in the
// Seti theme, components/code/FileSymbol.tsx). A click on a segment, folder or file, shows its SIBLINGS as a small tree as in VS Code
// (`BreadcrumbsFilePicker`: input = the parent folder, the segment marked), the segment itself marked (`GET <apiBase>/files/tree?path=`
// with the instance of the view; folders expand and load on demand). A file from the list opens through `open`. The bar does not
// truncate; it scrolls horizontally in itself and rests at the end after every change (VS Code `BreadcrumbsWidget.reveal` of the last
// segment). The sheet hangs on the body via a portal (`cb-pop`); it closes via document `mousedown` + `closest`, Escape, scrolling
// elsewhere and window size, with no `fixed inset-0` catcher. An absolute path (a file outside the target) shows its segments without
// a list.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { api, symbolKind, type DirListing, type FileEntry } from "@/lib/api";
import { instancePath } from "@/lib/code-instance";
import type { BufferTarget } from "@/lib/buffer";
import { keyInView } from "@/lib/buffer-coordinates";
import { useCoordinates } from "@/components/code/coordinates";
import { useBreadcrumbs } from "@/components/code/lsp-layout";
import { openEditorMenu } from "@/components/code/EditorMenu";
import { FileSymbol } from "@/components/code/FileSymbol";
import { sortSymbols } from "@/lib/symbol-kinds";
import { popSurface, useFlat } from "@/components/CbKit";

/** `location`: the editor's chain at this location (`data-editor-location` of an editor group); without it, the chain of the view holding the word (chat). */
export function Breadcrumbs({ target, path, location }: { target: BufferTarget; path: string; location?: string }) {
  const t = useT();
  const k = useBreadcrumbs(keyInView(useCoordinates(target), path), location);
  if (!k?.chain.length) return null;
  return (
    <>
      {k.chain.map((g, i) => (
        <span key={i} className="flex shrink-0 items-center gap-1" data-breadcrumbs-segment={g.symbol.name}>
          <span aria-hidden className="text-dim/70">›</span>
          <button
            type="button"
            aria-haspopup="menu"
            title={t("Symbols on this level")}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openEditorMenu({
                x: r.left, y: r.bottom + 4,
                // Siblings by position as VS Code `breadcrumbs.symbolSortOrder` (default "position"); the language service
                // delivers them in its own order (typescript-language-server: alphabetical).
                groups: [sortSymbols(g.siblings, "position").map((s, j) => ({ id: `${j}:${s.name}`, label: s.name, right: symbolKind(s.kind), execute: () => k.jump(s.selectionRange ?? s.range) }))],
              });
            }}
            className="rounded px-0.5 transition-colors hover:bg-hover hover:text-fg"
          >
            {g.symbol.name}
          </button>
        </span>
      ))}
    </>
  );
}

// ── the path as segments, folders with their entries ─────────────────────────────────────────────────────────────────────────

type List = { status: "loading" } | { status: "error"; text: string } | { status: "loaded"; entries: FileEntry[] };
/** Reads the entries of a folder of the view (relative to its root; "" = the root), with the view's instance. */
const readFolder = (target: BufferTarget, folder: string) =>
  api<DirListing>(instancePath(`${target.apiBase}/files/tree?path=${encodeURIComponent(folder)}`, target.instance));

export function PathCrumbs({ target, path: filePath, open, after }: {
  target: BufferTarget;
  /** The path in the view (relative to its root). */
  path: string;
  open: (path: string) => void;
  /** What follows the path (the symbols at the insertion point, `Breadcrumbs`). */
  after?: React.ReactNode;
}) {
  const t = useT();
  const [openMenu, setOpen] = useState<{ folder: string; marked: string; x: number; y: number } | null>(null);
  const absolute = filePath.startsWith("/");
  const parts = filePath.split("/").filter(Boolean);
  const close = useCallback(() => setOpen(null), []);
  // The bar scrolls in itself and rests at the end after every change (path, symbols at the insertion point, width).
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const toEnd = () => { const z = el.scrollWidth - el.clientWidth; if (z > 0 && el.scrollLeft !== z) el.scrollLeft = z; };
    toEnd();
    const mo = new MutationObserver(toEnd);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(toEnd);
    ro?.observe(el);
    return () => { mo.disconnect(); ro?.disconnect(); };
  }, [filePath]);
  const show = (e: React.MouseEvent<HTMLButtonElement>, folder: string, marked: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setOpen((o) => (o && o.marked === marked ? null : { folder, marked, x: r.left, y: r.bottom + 2 }));
  };
  return (
    <div ref={bar} className="cb-strip flex h-[22px] min-w-0 shrink-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden whitespace-nowrap px-3 text-[12.5px] text-dim" data-path-crumbs>
      {parts.map((g, i) => {
        const file = i === parts.length - 1;
        const itself = parts.slice(0, i + 1).join("/");
        const folder = parts.slice(0, i).join("/");
        return (
          <span key={i} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0 text-dim/70"><path d="M6 4l4 4-4 4" /></svg>}
            <button
              type="button"
              disabled={absolute}
              aria-haspopup="tree"
              aria-expanded={openMenu?.marked === itself}
              title={file ? t("Files in this folder") : t("Entries next to {name}", { name: g })}
              onClick={(e) => show(e, folder, itself)}
              className={`flex items-center gap-1 rounded-[3px] px-0.5 transition-colors enabled:hover:bg-hover enabled:hover:text-fg ${file ? "text-fg" : ""}`}
              data-path-segment={itself}
            >
              {file && <FileSymbol path={g} />}
              <span>{g}</span>
            </button>
          </span>
        );
      })}
      {after}
      {openMenu && !absolute && <CrumbsSheet t={t} target={target} folder={openMenu.folder} marked={openMenu.marked} x={openMenu.x} y={openMenu.y} open={(p) => { setOpen(null); open(p); }} close={close} />}
    </div>
  );
}

const MARGIN = 8;
function CrumbsSheet({ t, target, folder, marked, x, y, open, close: closed }: {
  t: (k: string, p?: Record<string, string | number>) => string;
  target: BufferTarget;
  folder: string;
  marked: string;
  x: number;
  y: number;
  open: (path: string) => void;
  close: () => void;
}) {
  const flat = useFlat();
  const sheet = useRef<HTMLDivElement>(null);
  const [situation, setSituation] = useState<{ left: number; top: number } | null>(null);
  const [listen, setListen] = useState<Record<string, List>>({});
  const [on, setOn] = useState<ReadonlySet<string>>(new Set());
  const load = useCallback((o: string) => {
    setListen((l) => (l[o] ? l : { ...l, [o]: { status: "loading" } }));
    readFolder(target, o).then(
      (r) => setListen((l) => ({ ...l, [o]: { status: "loaded", entries: r.entries } })),
      (e: unknown) => setListen((l) => ({ ...l, [o]: { status: "error", text: String((e as Error)?.message ?? e) } })),
    );
  }, [target]);
  useEffect(() => { load(folder); }, [load, folder]);
  // Closing: pointer press elsewhere (a segment toggles itself), Escape, scrolling elsewhere, window size.
  useEffect(() => {
    const beside = (e: MouseEvent) => { const el = e.target as Element | null; if (!el?.closest?.("[data-path-crumbs-pop]") && !el?.closest?.("[data-path-segment]")) closed(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closed(); } };
    const scrolled = (e: Event) => { if (!(e.target instanceof Element && e.target.closest("[data-path-crumbs-pop]"))) closed(); };
    document.addEventListener("mousedown", beside, true);
    window.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", closed);
    return () => {
      document.removeEventListener("mousedown", beside, true);
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", closed);
    };
  }, [closed]);
  const rows: { e: FileEntry; depth: number }[] = [];
  const collect = (o: string, depth: number) => {
    const l = listen[o];
    if (l?.status !== "loaded") return;
    const sorted = [...l.entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    for (const e of sorted) { rows.push({ e, depth }); if (e.type === "dir" && on.has(e.path)) collect(e.path, depth + 1); }
  };
  collect(folder, 0);
  const root = listen[folder];
  // Position: below the segment, kept inside the window (recomputed after every load, since the height grows).
  useLayoutEffect(() => {
    const b = sheet.current?.getBoundingClientRect();
    if (!b) return;
    setSituation({ left: Math.max(MARGIN, Math.min(x, window.innerWidth - b.width - MARGIN)), top: Math.max(MARGIN, Math.min(y, window.innerHeight - b.height - MARGIN)) });
  }, [x, y, rows.length]);
  // Focus goes to the segment's entry (otherwise the first) once the list is there, once.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || root?.status !== "loaded") return;
    focused.current = true;
    const b = sheet.current;
    (b?.querySelector<HTMLElement>("[data-crumbs-marked]") ?? b?.querySelector<HTMLElement>('[role="treeitem"]'))?.focus();
  }, [root?.status]);
  const toggle = (p: string) => setOn((a) => { const n = new Set(a); if (n.has(p)) n.delete(p); else { n.add(p); load(p); } return n; });
  const select = (e: FileEntry) => (e.type === "dir" ? toggle(e.path) : open(e.path));
  const key = (ev: React.KeyboardEvent, i: number) => {
    const z = rows[i];
    const go = (j: number) => sheet.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
    if (ev.key === "ArrowDown") go(i + 1);
    else if (ev.key === "ArrowUp") go(i - 1);
    else if (ev.key === "ArrowRight" && z.e.type === "dir" && !on.has(z.e.path)) toggle(z.e.path);
    else if (ev.key === "ArrowLeft" && z.e.type === "dir" && on.has(z.e.path)) toggle(z.e.path);
    else if (ev.key === "Enter" || ev.key === " ") select(z.e);
    else return;
    ev.preventDefault();
  };
  return createPortal(
    <div className="cb-kit" data-path-crumbs-pop>
      <div
        ref={sheet}
        role="tree"
        aria-label={t("Entries of {folder}", { folder: folder || "/" })}
        className={`${popSurface}${flat} fixed max-h-[min(60vh,420px)] w-[280px] overflow-y-auto py-1`}
        style={situation ? { left: situation.left, top: situation.top } : { left: x, top: y, visibility: "hidden" }}
      >
        {root?.status === "loading" && <div className="px-3 py-1 text-dim">{t("Loading…##inline")}</div>}
        {root?.status === "error" && <div className="px-3 py-1 text-danger">{root.text}</div>}
        {root?.status === "loaded" && !rows.length && <div className="px-3 py-1 text-dim">{t("Empty folder")}</div>}
        {rows.map(({ e, depth }, i) => {
          const isMarked = e.path === marked;
          return (
            <div
              key={e.path}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={e.type === "dir" ? on.has(e.path) : undefined}
              aria-selected={isMarked}
              tabIndex={-1}
              onClick={() => select(e)}
              onKeyDown={(ev) => key(ev, i)}
              title={e.path}
              style={{ paddingLeft: 8 + depth * 8 }}
              className={`flex h-[22px] cursor-pointer select-none items-center gap-1 pr-2 outline-none hover:bg-hover focus-visible:bg-hover ${isMarked ? "bg-hover text-fg" : ""}`}
              data-crumbs-entry={e.path}
              data-crumbs-marked={isMarked ? "" : undefined}
            >
              <span aria-hidden className="grid w-4 shrink-0 place-items-center text-dim">
                {e.type === "dir" && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={on.has(e.path) ? "rotate-90" : ""}><path d="M6 3l5 5-5 5" /></svg>}
              </span>
              {e.type === "file" && <FileSymbol path={e.name} />}
              <span className="min-w-0 truncate">{e.name}</span>
              {e.type === "dir" && listen[e.path]?.status === "loading" && <span className="ml-auto text-[11px] text-dim">…</span>}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
