"use client";
// The lower panel like VS Code — ONE place for problems, debug console and terminal (formerly three separate boxes, each with its own header
// and ✕):
//
//   Header     35 px: the tabs PROBLEMS · DEBUG CONSOLE · TERMINAL in capitals (11 px), the front one bright and underlined in the focus
//              colour (`panelTitle.activeBorder`), PROBLEMS with the count as a badge (errors + warnings + infos of the open files like VS Code
//              `ActivityUpdater`); the tabs are a tab list (← → switch, ↵ focuses the view); on the right the view's actions (PROBLEMS: filter
//              field and "Collapse All", TERMINAL: "New terminal" and "Kill Terminal"), then "Maximize"/"Restore" and "Hide Panel" (tooltip AND
//              aria-label like VS Code 1.143: `tooltip` of the action `workbench.action.toggleMaximizedPanel`, `panelActions` ·
//              `maximizePanel`/`minimizePanel` — their title appears only in the palette).
//   Height     via the drag bar at the top edge: while dragging directly on the element (one write per frame — no CodePane redraw, no terminal
//              resize per frame), remembered on release; double click: 40 % of the work area; below half the minimum height the panel snaps
//              off (closes, the height stays remembered). Clamped like VS Code (lib/panel-layout.ts) — measured on the container before the first
//              frame: room = the column without its fixed parts (status bar), editor minimum = editor group header + 70. Maximised, the panel
//              takes the whole height; a rule in globals.css hides the editor groups above (`[data-panel-maximized]` on the column), they stay
//              mounted (undo, scroll position).
//   Content    the three views as `tabpanel`; the terminals stay mounted while they run — also behind another tab and with the panel closed
//              (VS Code ends no shell on closing); TerminalPanel does not measure itself while hidden (`display: none`).
//   Terminals  a list (lib/terminal-list.ts): the active one in front; from two on the terminal list stands on the right like VS Code
//              (`terminal.integrated.tabs.hideCondition: singleTerminal`, location right) — click selects, the trash can on hover. In the
//              TERMINAL header "New terminal" (+; the ⌃⇧` key is still missing) and "Kill Terminal".
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { snap, panelHeight, panelMaximized, panelBack, PANEL_MIN_HEIGHT, PANEL_TAB, type PanelAction, type PanelMass, type PanelTab, type PanelState } from "@/lib/panel-layout";
import { filterActive, badgesText, problemFilter, problemList, type FilterToggle, type ProblemEntry } from "@/lib/problems-list";
import { DragBar } from "@/components/code/panel/DragBar";
import { Badge, ProblemsFilter, ProblemsList } from "@/components/code/panel/ProblemsView";

type T = (key: string, params?: Record<string, string | number>) => string;

const svg = (children: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
// The header's codicons: chevron-up / chevron-down, close, collapse-all, trash.
const MaximizeSymbol = () => svg(<path d="M4 10l4-4 4 4" />);
const RestoreSymbol = () => svg(<path d="M4 6l4 4 4-4" />);
const CloseSymbol = () => svg(<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />);
const CollapseSymbol = () => svg(<><rect x="2.5" y="2.5" width="11" height="11" rx="0.5" /><path d="M5.5 8h5" /></>);
const EndSymbol = () => svg(<><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></>);
const NewSymbol = () => svg(<path d="M8 3v10M3 8h10" />);
const TerminalSymbol = () => svg(<><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M4 6l2 2-2 2M8 10.5h4" /></>);
/** A running terminal of the panel: `node` is the TerminalPanel, `title` the name in the list. */
export type PanelTerminal = { seq: number; title: string; node: React.ReactNode };

const ACTION = "grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[5px] text-fg transition-colors hover:bg-hover";
const TOGGLE_DEFAULT: Required<FilterToggle> = { error: true, warnings: true, infos: true, onlyActiveFile: false, excludedShow: true };

/** Measures what editor and panel share — on the container (the editor's column), never on the window (lib/panel-layout.ts `PanelMass`). */
function measure(column: HTMLElement, panel: HTMLElement | null, editorMinPrior: number): PanelMass {
  let fixed = 0;
  for (const c of Array.from(column.children) as HTMLElement[]) {
    if (c === panel || c.hasAttribute("data-editor-groups")) continue;
    fixed += c.offsetHeight;
  }
  let header = -1;
  for (const g of column.querySelectorAll<HTMLElement>("[data-editor-group]")) {
    const f = g.querySelector<HTMLElement>(":scope > [data-editor-group-surface]");
    if (f && g.offsetHeight > 0) header = Math.max(header, f.getBoundingClientRect().top - g.getBoundingClientRect().top);
  }
  return { slot: Math.max(0, column.clientHeight - fixed), work: column.clientHeight, editorMin: header >= 0 ? 70 + header : editorMinPrior };
}

export function LowerPanel({ t, panelRef, state, height, setHeight, onAction, problems, activeFile, badge, onJump, debug, terminals, activeTerminal, onTerminalSelect, onTerminalEnd, onNewTerminal }: {
  t: T;
  panelRef: React.RefObject<HTMLDivElement | null>;
  state: PanelState;
  /** The remembered height (null: the default, a third of the work area). */
  height: number | null;
  setHeight: (h: number, remember: boolean) => void;
  /** Tab, maximise, close — `focus`: the tab click gives the view focus. */
  onAction: (a: PanelAction, focus?: boolean) => void;
  /** null: not loaded yet — then nothing is shown (empty is not unknown). */
  problems: readonly ProblemEntry[] | null;
  activeFile: string | null;
  /** Errors + warnings + infos of the open files (the count on the PROBLEMS tab). */
  badge: number;
  onJump: (p: ProblemEntry, o: { fixed: boolean; focus: boolean }) => void;
  debug: React.ReactNode;
  /** The running terminals — empty while none runs (one starts on first show). */
  terminals: readonly PanelTerminal[];
  activeTerminal: number | null;
  onTerminalSelect: (seq: number) => void;
  /** Without `seq`: the active one. */
  onTerminalEnd: (seq?: number) => void;
  onNewTerminal: () => void;
}) {
  const terminal = terminals.length > 0;
  // What editor and panel share — measured before the first frame (otherwise the panel jumped after the first paint).
  const [mass, setMass] = useState<PanelMass>({ slot: 0, work: 0, editorMin: 105 });
  const visible = state.open || terminal;
  useLayoutEffect(() => {
    const column = panelRef.current?.parentElement;
    if (!column) return;
    const fresh = () => setMass((m) => { const n = measure(column, panelRef.current, m.editorMin); return n.slot === m.slot && n.work === m.work && n.editorMin === m.editorMin ? m : n; });
    const ro = new ResizeObserver(fresh);
    ro.observe(column);
    fresh();
    return () => ro.disconnect();
  }, [panelRef, visible, state.open, state.maximized]);
  const h = panelHeight(height, mass);

  // Dragging: on the element, at most once per frame; state (and storage) on release.
  const turn = useRef<{ start: number; wish: number; frame: number } | null>(null);
  const drag = (distance: number, finished: boolean) => {
    const z = turn.current ?? (turn.current = { start: h, wish: h, frame: 0 });
    z.wish = z.start - distance;
    const el = panelRef.current;
    if (!finished) {
      if (!z.frame) z.frame = requestAnimationFrame(() => {
        z.frame = 0;
        if (!el) return;
        el.style.height = `${panelHeight(z.wish, mass)}px`;
        el.style.visibility = snap(z.wish, PANEL_MIN_HEIGHT) === "off" ? "hidden" : "";
      });
      return;
    }
    if (z.frame) cancelAnimationFrame(z.frame);
    turn.current = null;
    if (el) { el.style.visibility = ""; el.style.height = `${h}px`; }
    if (snap(z.wish, PANEL_MIN_HEIGHT) === "off") { onAction({ kind: "close" }); return; } // snapped off: closed, the height stays remembered
    setHeight(panelHeight(z.wish, mass), true);
  };

  // Problems: filter, collapsed files and single-line messages live here (the panel stays mounted — they survive closing and
  // tab switching).
  const [filterText, setFilterText] = useState("");
  const [toggle, setToggle] = useState<Required<FilterToggle>>(TOGGLE_DEFAULT);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [singleLine, setSingleLine] = useState<ReadonlySet<string>>(new Set());
  const filter = useMemo(() => problemFilter(filterText, toggle), [filterText, toggle]);
  const list = useMemo(() => problemList(problems, filter, { activeFile }), [problems, filter, activeFile]);
  const set = filterActive(filter);
  const filterClear = () => { setFilterText(""); setToggle(TOGGLE_DEFAULT); };

  const tabButtons = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  // IDs per panel (two panels — files and a chat — must not cross).
  const base = useId();
  const tabId = (r: PanelTab) => `${base}-tab-${r}`, contentId = (r: PanelTab) => `${base}-content-${r}`;
  useEffect(() => () => { if (turn.current?.frame) cancelAnimationFrame(turn.current.frame); }, []);
  const title: Record<PanelTab, string> = { problems: t("Problems"), debug: t("Debug Console"), terminal: t("Terminal") };
  const front = state.tab;
  const open = state.open;
  if (!visible) return null;
  // The tabs as a tab list: ← → (Home/End) switch and show, focus moves along (VS Code: the panel's tabs).
  const tabKey = (e: React.KeyboardEvent, r: PanelTab) => {
    const i = PANEL_TAB.indexOf(r);
    const target = e.key === "ArrowRight" ? PANEL_TAB[(i + 1) % PANEL_TAB.length] : e.key === "ArrowLeft" ? PANEL_TAB[(i + PANEL_TAB.length - 1) % PANEL_TAB.length]
      : e.key === "Home" ? PANEL_TAB[0] : e.key === "End" ? PANEL_TAB[PANEL_TAB.length - 1] : null;
    if (!target) return;
    e.preventDefault();
    onAction({ kind: "show", tab: target });
    tabButtons.current[target]?.focus();
  };
  return (
    <div
      ref={panelRef}
      className={`relative flex shrink-0 flex-col border-t border-edge ${open ? "" : "hidden"} ${panelMaximized(state) ? "min-h-0 flex-1" : ""}`}
      style={panelMaximized(state) ? undefined : { height: h }}
      data-lower-panel={front}
      data-maximized={panelMaximized(state) ? "" : undefined}
    >
      {!state.maximized && (
        <DragBar direction="horizontal" className="absolute inset-x-0 -top-[3px] z-20" label={t("Panel height")}
          value={{ now: h, min: PANEL_MIN_HEIGHT, max: mass.slot - mass.editorMin }}
          onDrag={drag}
          onBack={() => setHeight(panelBack(mass), true)}
          data={{ "data-panel-drag-bar": "" }} />
      )}
      <div className="flex h-[35px] shrink-0 items-center gap-1 pl-2 pr-2" data-panel-header>
        <div role="tablist" aria-label={t("Panel")} className="flex h-full shrink-0 items-stretch">
          {PANEL_TAB.map((r) => (
            <button key={r} type="button" role="tab" id={tabId(r)} aria-controls={contentId(r)} aria-selected={front === r}
              tabIndex={front === r ? 0 : -1}
              ref={(el) => { tabButtons.current[r] = el; }}
              onClick={() => onAction({ kind: "show", tab: r }, true)}
              onKeyDown={(e) => tabKey(e, r)}
              className={`relative flex items-center gap-1 px-2 text-[11px] uppercase tracking-[0.02em] outline-none transition-colors focus-visible:outline-1 focus-visible:outline-accent ${front === r ? "text-fg" : "text-dim hover:text-fg"}`}
              data-panel-tab={r}>
              {title[r]}
              {r === "problems" && <Badge text={badgesText(badge)} data={{ "data-panel-badge": String(badge) }} />}
              {front === r && <span aria-hidden className="absolute bottom-[4px] left-2 right-2 h-px bg-accent" />}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
          {front === "problems" && (<>
            <ProblemsFilter t={t} text={filterText} setText={setFilterText} toggle={toggle} setToggle={setToggle} list={list} set={set} />
            <button type="button" className={ACTION} title={t("Collapse All")} aria-label={t("Collapse All")} onClick={() => setClosed(new Set(list.groups.map((g) => g.file)))} data-panel-action="collapse"><CollapseSymbol /></button>
          </>)}
          {front === "terminal" && (
            <button type="button" className={ACTION} title={t("New terminal")} aria-label={t("New terminal")} onClick={onNewTerminal} data-panel-action="terminal-new"><NewSymbol /></button>
          )}
          {front === "terminal" && terminal && (
            <button type="button" className={ACTION} title={t("Kill Terminal")} aria-label={t("Kill Terminal")} onClick={() => onTerminalEnd()} data-panel-action="terminal-end"><EndSymbol /></button>
          )}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-edge" />
          <button type="button" className={ACTION} onClick={() => onAction({ kind: "maximize" })}
            title={state.maximized ? t("Restore Panel") : t("Maximize Panel")} aria-label={state.maximized ? t("Restore Panel") : t("Maximize Panel")}
            data-panel-action="maximize">{state.maximized ? <RestoreSymbol /> : <MaximizeSymbol />}</button>
          <button type="button" className={ACTION} onClick={() => onAction({ kind: "close" })} title={t("Hide Panel")} aria-label={t("Hide Panel")} data-panel-action="close"><CloseSymbol /></button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {open && front === "problems" && (
          <div className="absolute inset-0 outline-none" role="tabpanel" id={contentId("problems")} aria-labelledby={tabId("problems")} tabIndex={-1} data-panel-content="problems">
            <ProblemsList t={t} list={list} filter={filter} onFilterClear={filterClear} closed={closed} setClosed={setClosed} singleLine={singleLine} setSingleLine={setSingleLine} onJump={onJump} />
          </div>
        )}
        {open && front === "debug" && <div className="absolute inset-0 outline-none" role="tabpanel" id={contentId("debug")} aria-labelledby={tabId("debug")} tabIndex={-1} data-panel-content="debug">{debug}</div>}
        {terminal && (
          <div className={`absolute inset-0 flex outline-none ${open && front === "terminal" ? "" : "hidden"}`} role="tabpanel" id={contentId("terminal")} aria-labelledby={tabId("terminal")} tabIndex={-1} data-panel-content="terminal">
            <div className="relative min-w-0 flex-1">
              {terminals.map((x) => (
                <div key={x.seq} className={`absolute inset-0 ${x.seq === activeTerminal ? "" : "hidden"}`} data-terminal-seq={x.seq} data-terminal-inactive={x.seq === activeTerminal ? undefined : ""}>{x.node}</div>
              ))}
            </div>
            {terminals.length > 1 && (
              <div role="tablist" aria-orientation="vertical" aria-label={t("Terminals")} className="cb-scroll w-[150px] shrink-0 overflow-y-auto border-l border-edge py-0.5" data-terminal-list>
                {terminals.map((x) => (
                  <div key={x.seq} role="tab" aria-selected={x.seq === activeTerminal} tabIndex={-1}
                    onClick={() => { onTerminalSelect(x.seq); requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`[data-terminal-seq="${x.seq}"] textarea`)?.focus()); }}
                    className={`group flex h-[22px] cursor-pointer items-center gap-1.5 pl-2 pr-1 text-[13px] ${x.seq === activeTerminal ? "bg-hover text-fg" : "text-dim hover:bg-hover hover:text-fg"}`}
                    title={x.title} data-terminal-entry={x.seq}>
                    <TerminalSymbol />
                    <span className="min-w-0 flex-1 truncate">{x.title}</span>
                    <button type="button" className={`${ACTION} hidden group-hover:grid`} title={t("Kill Terminal")} aria-label={t("Kill Terminal")}
                      onClick={(e) => { e.stopPropagation(); onTerminalEnd(x.seq); }} data-terminal-end={x.seq}><EndSymbol /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
