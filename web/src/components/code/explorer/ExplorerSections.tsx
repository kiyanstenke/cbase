"use client";
// The explorer's sections as in VS Code: the folder (the tree with the root's header), below it OUTLINE and TIMELINE — each section with its
// own header (22 px, arrow, title in capitals, the actions on hover, like RootHeader), collapsible to the header; the open ones share the
// height, between two sections a drag bar (sash, components/code/panel/DragBar.tsx). The computation lives purely in
// lib/explorer-sections.ts; open/closed and sizes are remembered PER DEVICE (localStorage, every access in try/catch — private, full,
// blocked ⇒ the default, the size holds until reload).
//
// The outline IS the view from components/code/LayoutContent.tsx around LayoutTree — embedded, not copied; the timeline is
// components/code/explorer/TimeAxis.tsx. What a collapsed section does not show it does not ask for either (`open` goes to CodePane: the
// outline loads only when it is visible).
//
// A header's actions as in VS Code: visible while the pointer is over the WHOLE section or focus is inside (VS Code
// `.pane:hover > .pane-header .actions`), and while one of their menus is open. OUTLINE: "Collapse All" and "…" (Follow Cursor, Sort By —
// components/code/LayoutActions.tsx). TIMELINE: "Pin the Current Timeline" / "Unpin the Current Timeline" (VS Code
// `timeline.toggleFollowActiveEditor`: pinned, it no longer follows the active editor), "Refresh" and "Filter Timeline" (the sources, here
// only "Git History" — VS Code `timeline.excludeSources`, remembered); beside it the file's name (VS Code: the description in the header).
import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, MenuEntry } from "@/components/CbKit";
import {
  SECTIONS, SECTIONS_DEFAULT, sectionHeights, stateFrom, toggle as toggleSection, pull, pullPair, type SectionId, type SectionsStatus,
} from "@/lib/explorer-sections";
import { DragBar } from "@/components/code/panel/DragBar";
import { ArrowSymbol } from "@/components/code/explorer/ExplorerHeader";

const KEY = "cbase-explorer-sections";
const GIT_KEY = "cbase-time-axis-git";
type T = (key: string, params?: Record<string, string | number>) => string;

function readStatus(): SectionsStatus {
  try { return stateFrom(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { return SECTIONS_DEFAULT; }
}
function remember(s: SectionsStatus): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* not remembered — holds until reload */ }
}

/** A header's actions: visible on hover over the whole section (`group/section` on the section), with focus inside and while one of the
 *  actions' menus is open (otherwise its button would vanish under the sheet). */
export const HEADER_ACTIONS = "hidden shrink-0 items-center gap-px group-hover/section:flex group-focus-within/section:flex has-[[aria-expanded=true]]:flex";

/** A section's header as in VS Code (`.pane-header`): arrow and title as ONE button with `aria-expanded`, behind it the dimmed
 *  description, on the right the actions (HEADER_ACTIONS). The same shape as RootHeader (ExplorerHeader.tsx). */
export function SectionHeader({ title, description, open, onToggle, actions, data }: {
  title: string; description?: string; open: boolean; onToggle: () => void; actions?: React.ReactNode; data?: Record<`data-${string}`, string>;
}) {
  return (
    <div className="cb-tree-header flex h-[22px] shrink-0 items-center border-t border-edge pr-1" {...data}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex h-full min-w-0 flex-1 cursor-pointer items-center text-left outline-none focus-visible:outline-1 focus-visible:outline-accent" data-section-button>
        <span className="grid w-[22px] shrink-0 place-items-center text-fg"><ArrowSymbol open={open} /></span>
        <span className="shrink-0 truncate text-[11px] font-bold uppercase tracking-[0.04em] text-fg">{title}</span>
        {description && <span className="min-w-0 truncate pl-1.5 text-[11px] text-dim" data-section-description>{description}</span>}
        <span className="flex-1" />
      </button>
      {actions && open && <span className={HEADER_ACTIONS} data-section-actions>{actions}</span>}
    </div>
  );
}

// The codicon refresh (like the action in the root's header).
const RefreshSymbol = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 5v5h-5" /><path d="M19.5 10A8 8 0 1 0 20 14" /></svg>
);
// The codicons pin / pinned and filter.
const PinSymbol = ({ on }: { on: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden><path d="M6 2.5h4l-.6 4 2.1 2v1h-7v-1l2.1-2z" /><path d="M8 9.5v4" fill="none" /></svg>
);
const FilterSymbol = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden><path d="M2.5 3.5h11l-4.2 5v4.5l-2.6-1.3V8.5z" /></svg>
);
const ACTION = "grid h-[22px] w-[22px] place-items-center rounded-[5px] text-dim transition-colors hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg disabled:opacity-40";

function readGit(): boolean {
  try { return localStorage.getItem(GIT_KEY) !== "0"; } catch { return true; }
}

export function ExplorerSections({ t, tree, layout, layoutActions, activeFile, timeAxis, onOpen }: {
  t: T;
  /** The tree with its header (RootHeader) — collapsed under control from here. */
  tree: (o: { collapsed: boolean; toggle: () => void }) => React.ReactNode;
  layout: React.ReactNode;
  /** "Collapse All" and "…" of the outline (components/code/LayoutActions.tsx). */
  layoutActions: React.ReactNode;
  /** The active file (project-relative) or null — the timeline follows it as long as it is not pinned. */
  activeFile: string | null;
  /** The timeline of the file `file`; `seq` grows with "Refresh" in the header (VS Code `timeline.refresh`), `gitOn`: the source
   *  "Git History" is not filtered out. */
  timeAxis: (o: { seq: number; file: string | null; gitOn: boolean }) => React.ReactNode;
  /** Which sections are open (CodePane loads the outline only when it is visible). */
  onOpen?: (open: Readonly<Record<SectionId, boolean>>) => void;
}) {
  const [status, setStatusRaw] = useState<SectionsStatus>(SECTIONS_DEFAULT);
  // Read what was remembered only after mounting (built statically — there is no localStorage while hydrating).
  useEffect(() => { setStatusRaw(readStatus()); }, []);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => { onOpenRef.current?.(status.open); }, [status.open]);
  const set = useCallback((s: SectionsStatus, persist: boolean) => { setStatusRaw(s); if (persist) remember(s); }, []);

  const root = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setSlot(el.clientHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const heights = sectionHeights(status, slot);
  const turn = useRef<{ status: SectionsStatus; heights: Record<SectionId, number> } | null>(null);
  const drag = (i: number) => (distance: number, finished: boolean) => {
    if (!turn.current) turn.current = { status, heights };
    set(pull(turn.current.status, turn.current.heights, i, distance), finished);
    if (finished) turn.current = null;
  };
  const toggle = (id: SectionId) => set(toggleSection(status, id), true);
  const [timeSeq, setTimeSeq] = useState(0);
  // VS Code `timeline.toggleFollowActiveEditor`: pinned, the timeline stays on THIS file (only until reload, as in VS Code).
  const [pinned, setPinned] = useState<string | null>(null);
  const timeFile = pinned ?? activeFile;
  const [gitOn, setGitOnRaw] = useState(true);
  useEffect(() => { setGitOnRaw(readGit()); }, []);
  const setGitOn = (on: boolean) => {
    setGitOnRaw(on);
    try { localStorage.setItem(GIT_KEY, on ? "1" : "0"); } catch { /* not remembered — holds until reload */ }
  };

  const content: Record<SectionId, React.ReactNode> = {
    files: tree({ collapsed: !status.open.files, toggle: () => toggle("files") }),
    layout: (<>
      <SectionHeader title={t("Outline")} open={status.open.layout} onToggle={() => toggle("layout")} data={{ "data-section-header": "layout" }}
        actions={layoutActions} />
      {status.open.layout && <div className="flex min-h-0 flex-1 flex-col" data-section-content="layout">{layout}</div>}
    </>),
    timeAxis: (<>
      <SectionHeader title={t("Timeline")} description={timeFile ? timeFile.slice(timeFile.lastIndexOf("/") + 1) : undefined}
        open={status.open.timeAxis} onToggle={() => toggle("timeAxis")} data={{ "data-section-header": "timeAxis" }}
        actions={<>
          <button type="button" className={ACTION} disabled={!pinned && !activeFile} aria-pressed={Boolean(pinned)}
            title={pinned ? t("Unpin the Current Timeline") : t("Pin the Current Timeline")} aria-label={pinned ? t("Unpin the Current Timeline") : t("Pin the Current Timeline")}
            onClick={() => setPinned(pinned ? null : activeFile)} data-time-axis-pin={pinned ? "on" : "off"}><PinSymbol on={Boolean(pinned)} /></button>
          <button type="button" className={ACTION} title={t("Refresh")} aria-label={t("Refresh")} onClick={() => setTimeSeq((n) => n + 1)} data-time-axis-refresh><RefreshSymbol /></button>
          <Menu label={t("Filter Timeline")} width={200} button={{ content: <FilterSymbol />, className: ACTION, data: { "data-time-axis-filter": "" } }}>
            <MenuEntry label={t("Git History")} selected={gitOn} onClick={() => setGitOn(!gitOn)} data={{ "data-time-axis-source": "git" }} />
          </Menu>
        </>} />
      {status.open.timeAxis && <div className="flex min-h-0 flex-1 flex-col" data-section-content="timeAxis">{timeAxis({ seq: timeSeq, file: timeFile, gitOn })}</div>}
    </>),
  };
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" data-explorer-sections>
      {SECTIONS.map((id, i) => (
        <div key={id} className="group/section relative flex min-h-0 shrink-0 flex-col overflow-hidden" style={{ height: slot ? heights[id] : undefined }} data-section={id} data-section-open={status.open[id] ? "" : undefined}>
          {/* The drag bar ABOVE this section's header — only where it moves two open sections (VS Code: otherwise off). */}
          {i > 0 && pullPair(status, i - 1) && (
            <DragBar direction="horizontal" className="absolute inset-x-0 top-0 z-20" label={id === "layout" ? t("Outline") : t("Timeline")} onDrag={drag(i - 1)} onBack={() => undefined} data={{ "data-section-drag-bar": id }} />
          )}
          {content[id]}
        </div>
      ))}
    </div>
  );
}
