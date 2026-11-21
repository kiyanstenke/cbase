"use client";

// The short info card of a chat row. ONE block for the Coding chat list (ChatListPane): `useRowsTooltip` holds state and
// handlers (once per list, not per Dock/preview instance), `ChatTooltipCard` draws the card; WHAT it shows is computed by
// the caller (`content`), with the words in lib/chat-tooltip.ts.
//
// The state lives in a small store OUTSIDE React (`TooltipStorage`, subscribed only by the card): hovering a row does not
// re-render the list, only the card. As `useState` in the list, every row change and every close re-rendered Dock AND
// preview with all rows. The handlers of a row are the same objects per id.
//
// Form: a popover (`cb-pop`, flat: #2d2d2d in dark, 10 % white edge, radius 16) portalled to the body with `cb-kit` on
// the node, 300 px wide, to the right of the row, its title level with the row title. If there is no room on the right it
// does not appear (it never covers the row). Silent for pointer and screen reader (`pointer-events-none`, `aria-hidden`).
// It is measured when the row changes, when the list changes (`remeasureAt`) and when the card itself changes height
// (ResizeObserver), not on every render: the list re-renders with every streamed token. The height is the layout height
// (`offsetHeight`): on appearing, `cb-pop-in-fast` starts at `scale(0.96)` and `getBoundingClientRect` measured 4 % too
// little. The clamping edge is that of the CONTENT CARD (`data-content-card`, app/layout.tsx), not the window: the card
// sits a few px in from the window's bottom and right edge, and clamped to the window the info ended short of its outer
// edge. Without a content card (embedding, test rig) the window applies.
//
// Timing: after 450 ms of dwelling (level with the row's marquee; a swipe across the list shows nothing); while shown it
// moves to the next row without a pause (same node, no new fade-in); 150 ms linger on leaving. Closes at once on press or
// right-click on the row, window resize, window switch, Esc, and on scroll ONLY if the scrolled element contains the row
// (otherwise it would close on every streamed token in the history). While a menu of the list is open, none appears;
// after closing, the row it was opened on stays locked until the pointer has left it: the ... menu and the context menu
// open exactly where the card would sit. If the pointer is over ANOTHER row on closing, that row's card appears: after
// the click catcher goes away Chrome reports only a native `pointerover` and React's `onPointerEnter` never arrives, so
// the store determines the row under the pointer itself (`elementFromPoint`, the same solution as the preview of the
// collapsed list). Touch shows nothing (no hover).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ActiveRun } from "@/lib/api";
import { useFlat } from "@/components/CbKit";
import { subscribeActiveRuns, activeRunsStatus, runsOfTheChat, loadActiveRuns } from "@/lib/active-runs-status";
import { ProviderMark } from "@/components/ProviderMarks";
import { FolderIcon } from "@/components/chat/ChatIcons";
import type { ModelRow } from "@/components/chat/chatModelChoice";
import type { StateSet } from "@/lib/chat-tooltip";

const LAG_MS = 450;
const LINGER_MS = 150;
const WIDTH = 300;
const GAP = 8;
// Older than this the status is "unknown": the pill reloads every 20 s, and a status from a minute ago would be a
// claim about the present that nobody checks any more.
const STATUS_APPLIES_MS = 60_000;
// Preload if the status is older than this.
const PRELOAD_FROM_MS = 5_000;

type State = { id: string; el: HTMLElement };

// Preload as soon as the pointer enters a row and the status is older than 5 s: after the 450 ms lag it is there and the
// state line does not jump. It joins a running fetch (lib/active-runs-status.ts): swiping across the whole list stays at one.
function preload() {
  const s = activeRunsStatus();
  if (!s || Date.now() - s.at > PRELOAD_FROM_MS) loadActiveRuns({ carryOver: true }).catch(() => {});
}

export type TooltipHandles = {
  onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onMouseDown: () => void;
  onContextMenu: () => void;
};
export type TooltipButtonHandles = {
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
};

/** State and handlers of the short info of ONE list: a store outside React, subscribed by the card. */
export class TooltipStorage {
  private state: State | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private open = false;
  private menuOpen = false;
  // The row that was pressed or had a menu opened: it shows no card until the pointer has left it.
  private locked: string | null = null;
  private pointer = { x: -1, y: -1 };
  private handlesById = new Map<string, TooltipHandles>();
  private buttonsById = new Map<string, TooltipButtonHandles>();

  subscribe = (h: () => void) => {
    this.listeners.add(h);
    return () => { this.listeners.delete(h); };
  };
  read = (): State | null => this.state;

  private set(s: State | null) {
    if (s === this.state || (s && this.state && s.id === this.state.id && s.el === this.state.el)) return;
    const prior = this.state;
    this.state = s;
    if (s && !prior) this.listen(true);
    if (!s && prior) this.listen(false);
    for (const h of [...this.listeners]) h();
  }

  close = () => {
    clearTimeout(this.timer);
    this.open = false;
    this.set(null);
  };
  private hide() {
    clearTimeout(this.timer); // a card not yet shown no longer appears
    if (this.open) this.timer = setTimeout(this.close, LINGER_MS);
  }
  private on(s: State, immediately: boolean) {
    clearTimeout(this.timer); // the linger too: the next row takes over
    if (immediately || this.open) { this.open = true; this.set(s); return; }
    this.timer = setTimeout(() => { this.open = true; this.set(s); }, LAG_MS);
  }

  // While a card is shown: scrolling (only of what contains the row), window resize, window switch and Esc close it.
  private scrolled = (e: Event) => {
    const s = this.state;
    const el = e.target instanceof Element ? e.target : document.documentElement;
    if (s && el.contains(s.el)) this.close();
  };
  private key = (e: KeyboardEvent) => { if (e.key === "Escape") this.close(); };
  private listen(enabled: boolean) {
    const f = enabled ? window.addEventListener.bind(window) : window.removeEventListener.bind(window);
    f("scroll", this.scrolled, true);
    f("resize", this.close);
    f("blur", this.close);
    f("keydown", this.key);
  }

  // The last pointer position (for closing a menu); listened to while the list is shown.
  private moved = (e: PointerEvent) => { this.pointer = { x: e.clientX, y: e.clientY }; };
  bind() {
    window.addEventListener("pointermove", this.moved, true);
    window.addEventListener("pointerdown", this.moved, true);
    return () => {
      window.removeEventListener("pointermove", this.moved, true);
      window.removeEventListener("pointerdown", this.moved, true);
      clearTimeout(this.timer);
      this.open = false;
      this.set(null);
    };
  }

  /** A menu or sheet of the list opens or closes. Closed: the row under the pointer gets its card (see header). */
  menu(open: boolean) {
    const before = this.menuOpen;
    this.menuOpen = open;
    if (open) { this.close(); return; }
    if (!before) return;
    const { x, y } = this.pointer;
    const el = x < 0 ? null : document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tooltip-row]") ?? null;
    const id = el?.dataset.tooltipRow || null;
    // If the pointer left the locked row while the menu was open, the lock is done.
    if (this.locked && this.locked !== id) this.locked = null;
    if (!el || !id || this.locked === id) return;
    preload();
    this.on({ id, el }, false);
  }

  /** Pointer and press on a row (the same objects per id). */
  handles = (id: string): TooltipHandles => {
    let g = this.handlesById.get(id);
    if (!g) {
      g = {
        onPointerEnter: (e) => {
          if (e.pointerType === "touch" || this.menuOpen || this.locked === id) return;
          preload();
          this.on({ id, el: e.currentTarget }, false);
        },
        onPointerLeave: () => {
          // The click catcher of an open menu slides under the pointer and triggers a spurious leave; the lock then
          // stays; on closing, `menu(false)` decides by the pointer's position.
          if (this.locked === id && !this.menuOpen) this.locked = null;
          this.hide();
        },
        onMouseDown: () => { this.locked = id; this.close(); },
        onContextMenu: () => { this.locked = id; this.close(); },
      };
      this.handlesById.set(id, g);
    }
    return g;
  };

  /** Keyboard: the row is no focus target, its ... is. Focus by keyboard (:focus-visible) shows the card at once. */
  buttonHandles = (id: string): TooltipButtonHandles => {
    let g = this.buttonsById.get(id);
    if (!g) {
      g = {
        onFocus: (e) => {
          const el = e.currentTarget.closest<HTMLElement>("[data-tooltip-row]");
          if (!el || this.menuOpen || !e.currentTarget.matches(":focus-visible")) return;
          this.on({ id, el }, true);
        },
        onBlur: () => this.close(),
      };
      this.buttonsById.set(id, g);
    }
    return g;
  };
}

/** The store of ONE list. `menuOpen`: any menu or sheet of the list is open. */
export function useRowsTooltip(menuOpen: boolean): TooltipStorage {
  const [storage] = useState(() => new TooltipStorage());
  useEffect(() => storage.bind(), [storage]);
  useEffect(() => { storage.menu(menuOpen); }, [storage, menuOpen]);
  return storage;
}

/** What the card shows. `time` is on the right of the head (last activity), `ticking`: a one-second tick while it is open. */
export type TooltipContent = {
  title: string;
  time?: string | null;
  model?: ModelRow | null;
  location?: string | null;
  agent?: string | null;
  schedule?: string | null;
  state?: StateSet | null;
  target?: string | null;
  ticking?: boolean;
};

/**
 * The card. `content(id, runs, now, fresh)`: `runs` are this chat's runs from `/api/active-runs` (`null` = unknown),
 * `fresh` the result of `loadFresh(id)`, once per appearance, for what the list would not learn without an event (`null`
 * until it is there). `remeasureAt`: when it changes, the position is re-measured (the row may have moved).
 */
export function ChatTooltipCard<F>({ storage, content, loadFresh, remeasureAt }: {
  storage: TooltipStorage;
  content: (id: string, runs: ActiveRun[] | null, now: number, fresh: F | null) => TooltipContent | null;
  loadFresh?: (id: string) => Promise<F>;
  remeasureAt?: unknown;
}) {
  const flat = useFlat();
  const card = useRef<HTMLDivElement>(null);
  const [situation, setSituation] = useState<{ left: number; top: number } | null>(null);
  const [, setTick] = useState(0);
  const state = useSyncExternalStore(storage.subscribe, storage.read, () => null);
  const runsStatus = useSyncExternalStore(subscribeActiveRuns, activeRunsStatus, () => null);
  const [fresh, setFresh] = useState<{ id: string; value: F } | null>(null);
  const load = useRef(loadFresh);
  load.current = loadFresh;

  // On appearing, the same check as on entering the list (fallback if the preload did not run), and once fresh, what the
  // caller needs.
  const id = state?.id ?? null;
  useEffect(() => {
    if (!id) return;
    preload();
    const f = load.current;
    if (!f) return;
    let cancelled = false;
    f(id).then((value) => { if (!cancelled) setFresh({ id, value }); }, () => {});
    return () => { cancelled = true; };
  }, [id]);

  const now = Date.now();
  const runs = runsStatus && now - runsStatus.at <= STATUS_APPLIES_MS && id ? runsOfTheChat(runsStatus.view, id) : null;
  const data = id ? content(id, runs, now, fresh?.id === id ? fresh.value : null) : null;
  const ticking = Boolean(data?.ticking);
  const visible = Boolean(state && data);

  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // Position: to the right of the row, the title level with the row title; if it overhangs the bottom it moves up.
  const stateRef = useRef(state);
  stateRef.current = state;
  const measure = useRef(() => {});
  measure.current = () => {
    const s = stateRef.current;
    const k = card.current;
    if (!s || !k || !s.el.isConnected) { setSituation(null); return; }
    const r = s.el.getBoundingClientRect();
    const limit = document.querySelector<HTMLElement>("[data-content-card]")?.getBoundingClientRect();
    const right = limit ? limit.right : window.innerWidth;
    const bottom = limit ? limit.bottom : window.innerHeight;
    const left = r.right + GAP;
    if (left + WIDTH + GAP > right) { setSituation(null); return; }
    const top = Math.max(GAP, Math.min(r.top - 2, bottom - GAP - k.offsetHeight));
    setSituation((old) => (old && old.left === left && old.top === top ? old : { left, top }));
  };
  useLayoutEffect(() => { measure.current(); }, [state, visible, remeasureAt]);
  useEffect(() => {
    const k = card.current;
    if (!visible || !k || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure.current());
    ro.observe(k);
    return () => ro.disconnect();
  }, [visible]);

  if (!state || !data || typeof document === "undefined") return null;
  const row = "flex items-start gap-2.5 text-[13px] leading-[18px] text-fg/85";
  const symbol = "mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center text-dim";
  return createPortal(
    <div
      ref={card}
      aria-hidden
      data-chat-tooltip={state.id}
      className={`cb-kit cb-pop cb-pop-in-fast pointer-events-none fixed z-[70] rounded-2xl px-3.5 py-3${flat}`}
      style={{ width: WIDTH, left: situation?.left ?? -9999, top: situation?.top ?? 0, visibility: situation ? "visible" : "hidden" }}
    >
      <div className="flex items-start gap-3">
        <div className="line-clamp-3 min-w-0 flex-1 break-words text-[14px] font-medium leading-5 text-fg">{data.title}</div>
        {data.time && <span className="shrink-0 pt-px text-[13px] leading-5 tabular-nums text-dim">{data.time}</span>}
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {data.agent && (
          <div className={row}><span className={symbol}><AgentIcon /></span><span className="min-w-0 flex-1 truncate">{data.agent}</span></div>
        )}
        {data.model && (
          <div className={row}>
            <span className={symbol}>{data.model.marker === "third" ? <ChipIcon /> : <ProviderMark provider={data.model.marker} size={13} />}</span>
            <span className="min-w-0 flex-1 truncate">{data.model.text}</span>
          </div>
        )}
        {data.location && (
          <div className={row}><span className={symbol}><FolderIcon /></span><span className="min-w-0 flex-1 truncate">{data.location}</span></div>
        )}
        {data.schedule && (
          <div className={row}><span className={symbol}><ClockIcon /></span><span className="min-w-0 flex-1 truncate">{data.schedule}</span></div>
        )}
        {data.state && (
          <div className={row}>
            <span className={symbol}><StatusPoint point={data.state.point} pulse={data.state.pulse} /></span>
            <span className={`line-clamp-2 min-w-0 flex-1 break-words ${data.state.tone === "text-accent" ? "text-fg/85" : data.state.tone}`}>{data.state.text}</span>
          </div>
        )}
        {data.target && (
          <div className={row}><span className={symbol}><TargetIcon /></span><span className="min-w-0 flex-1 truncate">{data.target}</span></div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// The status dot as in the "Active runs" pill: still, or with a soft ring (running, needs me).
function StatusPoint({ point, pulse }: { point: string; pulse: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 ${point}`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${point}`} />
    </span>
  );
}

const ico = (children: React.ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
// A third-party provider (OpenRouter, GLM ...): the chip, not the Claude mark ProviderMark would draw.
const ChipIcon = () => ico(<><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>);
const TargetIcon = () => ico(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></>);
const ClockIcon = () => ico(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
const AgentIcon = () => ico(<><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>);
