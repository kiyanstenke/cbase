"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActiveRunsPill } from "@/components/pills/ActiveRunsPill";
import { ServicesPill } from "@/components/pills/ServicesPill";
import { AgentBrowsersPill } from "@/components/pills/AgentBrowsersPill";
import { VsCodePill } from "@/components/pills/VsCodePill";
import { NotificationBell } from "@/components/NotificationBell";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { SETTINGS_OPEN, SETTINGS_CLOSE, settingsFromAddress, openSettings } from "@/lib/settings-jump";
import { ADMINISTRATION_PAGE, usageJump } from "@/lib/api";
import { syncLangToBackend, useT, dateLocale } from "@/lib/i18n";
import { useGateway } from "@/lib/gateway";
import { ProviderMark } from "@/components/ProviderMarks";
import { CbaseLens } from "@/components/CbaseLens";
import { shellBridge, drawsWindowButtons } from "@/lib/shell-bridge";

// ── Window buttons for the window WITHOUT focus — only for an OLD client ───────────────────────
// AppKit does draw the traffic lights of an unfocused window — in the tint of the WINDOW's appearance, which could be
// DarkAqua (system dark, `themeSource` unset) on a light page: contrast 1.00 (Electron 37) / 1.03 (44), i.e. invisible.
// Since the shell knows the chosen mode (`setTheme`, lib/theme.ts), they look like in any other app without focus, and
// the shell no longer unregisters them on focus loss.
//
// So they are drawn only if the bridge exists but `setTheme` is missing (`drawsWindowButtons`, lib/shell-bridge.ts): a
// client with Electron 37 that still unregisters the native ones on focus loss. For exactly that case the geometry stays
// that of 37, PIXEL-EXACT at the native position: 12×12 pt, centres 20 pt apart, left edge x=17, centre y=24 — from
// `trafficLightPosition {x:16,y:16}`; AppKit puts the buttons at x+1 and the centre at y+8 (both measured). Under 44
// (diameter 14, centres 23/46/69) they would sit beside it; but a shell with 44 carries `setTheme`, and then nothing is drawn here.
// Absolute to the nav, not centred in it: if the row wraps, the nav grows, but the first row stays 48 pt high (the h-9 placeholder ensures that).
type WindowAction = "windowClose" | "windowMinimize" | "windowZoom";
const WINDOW_BUTTONS: { action: WindowAction; label: string; hover: string }[] = [
  { action: "windowClose", label: "Close window", hover: "hover:bg-[#ff5f57]" },
  { action: "windowMinimize", label: "Minimize window", hover: "hover:bg-[#febc2e]" },
  { action: "windowZoom", label: "Zoom window", hover: "hover:bg-[#28c840]" },
];

function WindowButtons() {
  const t = useT();
  // The renderer learns the window focus itself — window blur/focus fire reliably when another app becomes active
  // (measured), and document.hasFocus() gives the initial value. No IPC needed; the bridge is only needed for the ACTIONS.
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const sync = () => setFocused(document.hasFocus());
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  if (focused) return null;

  // Drawn only WITH a bridge (drawsWindowButtons), and every shell with a bridge carries the three actions — a client
  // without any bridge no longer draws the header buttons.
  const press = (action: WindowAction) => shellBridge(window)?.[action]?.();

  return (
    <span className="absolute left-[17px] top-[18px] flex gap-2" style={noDrag}>
      {WINDOW_BUTTONS.map((b) => (
        <button
          key={b.action}
          type="button"
          title={t(b.label)}
          aria-label={t(b.label)}
          onClick={() => press(b.action)}
          className={`h-3 w-3 rounded-full bg-dim/45 transition-colors ${b.hover}`}
        />
      ))}
    </span>
  );
}

const tabClass = (active: boolean) =>
  `px-3 py-1.5 text-sm font-medium transition-colors ${
    active
      ? "text-fg underline decoration-accent decoration-2 underline-offset-8"
      : "text-dim hover:text-fg"
  }`;

// The header bar is a drag region (move the window, the native title bar is off); everything clickable must exempt
// itself from it with no-drag.
// RULE: no-drag belongs on the control ITSELF, never on a wide container around it. A no-drag container removes the
// drag region from the top window edge across its WHOLE width — the tab strip (flex-1) once carried no-drag and made
// most of the edge undraggable. Double-click also depends on it: macOS zooms only over a drag region, and conversely a
// drag region swallows ALL mouse events (the renderer sees neither click nor dblclick there — even webContents
// "input-event" stays empty). So gaps between controls stay a drag region.
// SECOND RULE (measured with Electron 44): a no-drag element must not come BEFORE an element in the DOM that covers it
// and carries `drag` (since 44 also inherited). The regions are computed in DOM order, the later rectangle wins —
// whatever is painted on top (see slot `cbase-topnav-center`).
const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

interface UsageLimits {
  fiveHour: { utilization: number | null; resetsAt: string | null };
  sevenDay: { utilization: number | null; resetsAt: string | null };
  ring?: RingWindow | null;
  blocking?: RingWindow | null;
}
interface CodexWindow { usedPercent: number | null; windowMinutes: number | null; resetsAt: string | null }
interface CodexUsage { connected: boolean; primary?: CodexWindow | null; secondary?: CodexWindow | null; planType?: string; reachedType?: string; ring?: RingWindow | null; blocking?: RingWindow | null }

// Window data from the server (limits.js). `ring` = the SESSION WINDOW (Claude: 5 h across all models), also with a value
// when the endpoint leaves the legacy fields empty. `blocking` = the window currently at its limit (e.g. a model-specific
// weekly limit) — shown in the tooltip, not in the ring value.
export interface RingWindow {
  percent: number;
  resetsAt: string | null;
  group: "session" | "weekly" | "credits" | "spend";
  scope: string; // model name for model-specific limits ("Fable")
  windowMinutes: number | null;
  reached: boolean;
}

// Small usage ring per provider (colour by utilization) + provider mark; details in the tooltip. The ACTIVE main
// provider is lit softly in the accent colour. A BUTTON: a click opens Settings → Usage on the provider's subpage
// (`usageJump`, bound to the contract in web/test/usage-binding.test.mjs) — the question about the ring is almost always
// "where did it go", and the answer is there.
function UsageRing({ pct, resetsAt, provider, windowLabel, active, reached, blockedBy }: { pct: number; resetsAt: string | null; provider: "claude" | "codex"; windowLabel: string; active?: boolean; reached?: boolean; blockedBy?: string }) {
  const t = useT();
  const C = 2 * Math.PI * 8;
  // ANOTHER exhausted window does not colour the ring — the ring value is the session window.
  const color = reached || pct >= 90 ? "text-danger" : pct >= 70 ? "text-warn" : "text-accent";
  const name = provider === "codex" ? "Codex" : "Claude";
  const reset = resetsAt ? new Date(resetsAt).toLocaleString(dateLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <button
      type="button"
      onClick={() => openSettings(usageJump(provider))}
      title={`${t("{name} · {window} limit: {pct}% used", { name, window: windowLabel, pct: Math.round(pct) })}${reached ? ` · ${t("Limit reached")}` : ""}${reset ? ` · ${t("resets {reset}", { reset })}` : ""}${blockedBy ? ` · ${t("{window} limit reached", { window: blockedBy })}` : ""}${active ? ` · ${t("active provider")}` : ""}`}
      aria-label={t("Open {name} usage", { name })}
      data-usage-ring={provider}
      className="flex cursor-pointer items-center gap-1 rounded-full px-1 py-0.5 transition-colors hover:bg-hover"
    >
      {/* Provider mark instead of lettering; the active provider fully opaque, the other toned down. No glow: the header should be quiet. */}
      <span className={`flex items-center ${active ? "opacity-90" : "opacity-40"}`}>
        <ProviderMark provider={provider} size={12} />
      </span>
      <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden>
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-edge" />
        <circle
          cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={`${(Math.min(100, pct) / 100) * C} ${C}`} transform="rotate(-90 10 10)"
          className={`${color} transition-[stroke-dasharray] duration-700`}
        />
      </svg>
      <span className="text-[11px] font-medium tabular-nums text-dim">{Math.round(pct)} %</span>
    </button>
  );
}

// Window label for tooltip/accessibility. A model-specific limit carries its model name ("Fable"), credits and spend caps have no time window at all.
function ringLabel(ring: RingWindow, t: (s: string) => string): string {
  if (ring.group === "credits") return t("Credits");
  if (ring.group === "spend") return t("Spend");
  if (ring.scope) return ring.scope;
  if (ring.windowMinutes === 300) return "5h";
  if (ring.windowMinutes === 10080) return t("7-day");
  if (ring.windowMinutes) return `${Math.round(ring.windowMinutes / 60)}h`;
  return ring.group === "weekly" ? t("7-day") : "5h";
}

// Names the exhausted window in the tooltip — but only if it is a DIFFERENT one than the ring window (otherwise "Limit reached" would appear twice).
const blockedLabel = (ring: RingWindow | null | undefined, blocking: RingWindow | null | undefined, t: (s: string) => string) =>
  blocking && !(ring?.reached && ring.group === blocking.group && ring.scope === blocking.scope)
    ? ringLabel(blocking, t)
    : undefined;

// Does the content of the centred slot protrude beyond its edges? Then the band is narrower than the content's minimum
// widths (icon `shrink-0`, name `min-w-[3rem]`, caret), and the content would lie over its neighbours. Measured at the
// edges of every element IN FLOW: an absolutely positioned one (the project menu under the breadcrumb) does not count —
// it lies above the page anyway and is wider than its anchor —, and behind an edge with `overflow` ≠ visible (the
// truncated name) nothing is looked at, what runs out there is clipped. Not `scrollWidth`: that counts the open menu.
function protrudesOut(slot: HTMLElement): boolean {
  const s = slot.getBoundingClientRect();
  const check = (el: Element): boolean => {
    for (const kind of Array.from(el.children)) {
      const st = getComputedStyle(kind);
      if (st.position === "absolute" || st.position === "fixed" || st.display === "none") continue;
      const r = kind.getBoundingClientRect();
      if (r.width > 0 && (r.left < s.left - 0.5 || r.right > s.right + 0.5)) return true;
      if (st.overflowX === "visible" && check(kind)) return true;
    }
    return false;
  };
  return check(slot);
}

export function TopNav() {
  const t = useT();
  const pathname = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The page the modal opens with — set by a jump from outside (`openSettings`), otherwise the first.
  const [settingsPage, setSettingsPage] = useState<string | undefined>(undefined);
  useEffect(() => {
    const jump = (e: Event) => {
      const page = (e as CustomEvent<{ page?: string }>).detail?.page;
      setSettingsPage(typeof page === "string" && page ? page : undefined);
      setSettingsOpen(true);
    };
    // And out: a jump from the modal into a chat of THIS page closes it (lib/settings-jump.ts).
    const close = () => setSettingsOpen(false);
    window.addEventListener(SETTINGS_OPEN, jump);
    window.addEventListener(SETTINGS_CLOSE, close);
    return () => {
      window.removeEventListener(SETTINGS_OPEN, jump);
      window.removeEventListener(SETTINGS_CLOSE, close);
    };
  }, []);
  // The jump via the ADDRESS: `GET /gw/admin` redirects to `/?settings=administration`. Read once on load — the header
  // sits in the layout and survives the start page's redirect to /workspaces, which would lose the parameter anyway.
  // Cleared through Next (`replaceState(null, …)`, see app/apps/page.tsx): with a state of its own the router would write
  // the old address back, and every reload would open the modal again.
  useEffect(() => {
    const jump = settingsFromAddress(window.location.href);
    if (!jump) return;
    window.history.replaceState(null, "", jump.without);
    setSettingsPage(jump.page || undefined);
    setSettingsOpen(true);
  }, []);
  const [usage, setUsage] = useState<UsageLimits | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  // Connected providers — a usage ring is shown on top for each connected provider.
  const [conn, setConn] = useState<{ claude: boolean; codex: boolean }>({ claude: true, codex: false });
  // Active main provider (global switch) — its mark is lit in the accent colour.
  const [activeProvider, setActiveProvider] = useState("");
  // Only in Electron: leave room on the left for the macOS traffic-light buttons (hiddenInset).
  const [inElectron, setInElectron] = useState(false);
  // The grey window buttons are drawn by the header only for a shell WITHOUT `setTheme` (old client, see WindowButtons).
  // Read after mount, like inElectron: the prerendered HTML knows no window, and a difference on hydration would be React #418.
  const [ownWindowButtons, setOwnWindowButtons] = useState(false);
  useEffect(() => {
    setInElectron(navigator.userAgent.includes("Electron"));
    setOwnWindowButtons(drawsWindowButtons(window));
  }, []);
  // Gateway mode (client/server): user chip + sign out; without gateway → null, no chrome.
  const gw = useGateway();
  // Report the UI language to the backend once (server-side messages then speak the same language).
  useEffect(() => syncLangToBackend(), []);

  // Connection status of the providers (rarely changing) — controls which rings appear.
  // AbortSignal timeout: a hanging request must not block the poll chain for minutes.
  // Focus listener: after sleep/window switch update immediately instead of waiting for the interval.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      fetch("/api/providers", { signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { active?: string; providers?: { id: string; connected: boolean }[] } | null) => {
          if (alive && d?.providers) {
            const on = (id: string) => !!d.providers!.find((x) => x.id === id)?.connected;
            setConn({ claude: on("claude"), codex: on("codex") });
            setActiveProvider(d.active || "");
          }
        })
        .catch(() => {})
        .finally(() => { if (alive) timer = setTimeout(tick, 60_000); });
    };
    const onFocus = () => { clearTimeout(timer); tick(); };
    // Provider switch (from the settings): apply the highlight at once without waiting for the 60 s poll — set the new
    // id from the event directly and additionally refetch to reconcile connection flags.
    const onSwitch = (e: Event) => {
      const id = (e as CustomEvent<{ active?: string }>).detail?.active;
      if (id) setActiveProvider(id);
      clearTimeout(timer); tick();
    };
    tick();
    window.addEventListener("focus", onFocus);
    window.addEventListener("cbase-provider-changed", onSwitch);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener("focus", onFocus); window.removeEventListener("cbase-provider-changed", onSwitch); };
  }, []);

  // Poll Codex usage (local rate-limit snapshot) regularly.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      fetch("/api/usage/codex", { signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: CodexUsage | null) => { if (alive && d) setCodexUsage(d); })
        .catch(() => {})
        .finally(() => { if (alive) timer = setTimeout(tick, 45_000); });
    };
    const onFocus = () => { clearTimeout(timer); tick(); };
    tick();
    window.addEventListener("focus", onFocus);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener("focus", onFocus); };
  }, []);

  // Poll the 5h limit regularly (server caches 60 s). IMPORTANT: a briefly failed request (503/network blip/rate limit
  // 429) must NOT clear the display — otherwise the ring vanishes until the next successful poll. So update only on a
  // valid response, otherwise keep the last value. While no data has ever arrived, poll faster (15 s), afterwards at the resting rate (60 s).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let gotData = false;
    const tick = () => {
      fetch("/api/usage", { signal: AbortSignal.timeout(15_000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: UsageLimits | null) => {
          // Every response that carries ANY utilization value is accepted — `ring` also covers the cases where
          // fiveHour stays empty (model-specific limit, credits).
          if (alive && d && (d.ring || d.fiveHour?.utilization != null)) {
            gotData = true;
            setUsage(d);
          }
        })
        .catch(() => {
          /* keep the display */
        })
        .finally(() => {
          if (alive) timer = setTimeout(tick, gotData ? 60_000 : 15_000);
        });
    };
    const onFocus = () => { clearTimeout(timer); tick(); };
    tick();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // The centred indicator (Workspace › Project) is ABSOLUTE and used to know nothing about its neighbours: with long
  // project names it slid over the usage rings. Instead of shortening it or sacrificing the rings, the FREE BAND between
  // tabs and controls is measured — it sits centred in it and truncates itself. Measured, not guessed, because on the
  // right there are, depending on the situation, rings, account, runs pill and bell (or not).
  //
  // And if the band is narrower than the indicator at its MINIMUM widths (icon, name ≥ 3rem, caret), it stands in a row
  // of its own in the header like under `lg` — never absolutely over other controls (in client mode with usage rings the
  // band fell to width 0 at 1024–1150 px, the content ran out and lay over the rings).
  //
  // This measurement sets the position ITSELF on the slot (`data-situation`, `left`/`right`), not via React state: it is
  // checked by trying the content in the band and measuring whether it protrudes — in the same call, with no painted
  // frame in between. The slot therefore carries no `style` in the JSX (React would overwrite it on the next render).
  const navRef = useRef<HTMLElement | null>(null);
  const tabsRef = useRef<HTMLSpanElement | null>(null);
  const ctrlRef = useRef<HTMLSpanElement | null>(null);
  const middleRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current, tabs = tabsRef.current, ctrl = ctrlRef.current, slot = middleRef.current;
    if (!nav || !tabs || !ctrl || !slot) return;
    const GAP = 12; // air to both neighbours
    const wide = window.matchMedia("(min-width: 1024px)"); // `lg` — below it always the own row
    const ownRow = () => {
      delete slot.dataset.situation;
      slot.style.left = "";
      slot.style.right = "";
    };
    const measure = () => {
      if (!slot.firstElementChild || !wide.matches) { ownRow(); return; }
      const n = nav.getBoundingClientRect();
      const strip = tabs.getBoundingClientRect();
      const b = ctrl.getBoundingClientRect();
      // Wrapped header (controls in row two): no band in row one.
      if (b.top > strip.bottom - 2) { ownRow(); return; }
      // The VISIBLE right edge of the tabs. Not the strip's box alone: it carries `flex-1` and stretches to the controls —
      // the band would always come out with width 0. But also not the last tab element alone: as soon as the strip
      // shrinks and scrolls, its edge lies BEHIND the visible strip (partly behind the controls), and `left`/`right`
      // would overlap. So the end of the content, clamped to the strip's edges.
      const last = (tabs.lastElementChild ?? tabs).getBoundingClientRect();
      const tabEnd = Math.max(strip.left, Math.min(last.right, strip.right));
      const left = Math.round(tabEnd - n.left + GAP);
      const right = Math.round(n.right - b.left + GAP);
      if (n.width - left - right <= 0) { ownRow(); return; }
      slot.dataset.situation = "band";
      slot.style.left = `${left}px`;
      slot.style.right = `${right}px`;
      if (protrudesOut(slot)) ownRow();
    };
    measure();
    // Observed are strip and controls, NOT the nav: the measurement itself changes the nav's height (own row or not), and
    // a size change of an observed ancestor in its own callback ends in "ResizeObserver loop completed with undelivered
    // notifications". The nav's width follows the window (`resize`); strip and controls keep their size wherever the slot
    // stands (it is absolute or in a row AFTER them).
    const ro = new ResizeObserver(measure);
    for (const el of [tabs, ctrl]) ro.observe(el);
    window.addEventListener("resize", measure);
    // The content comes via portal and changes with the page (entering a workspace, project), and before the tabs each
    // page puts the workspace rail's button (slot `cbase-topnav-tabs-start`): both shift edges without changing an
    // observed box. Only children and text, no attributes — the measurement writes some on the slot itself.
    const mo = new MutationObserver(measure);
    for (const el of [slot, tabs]) mo.observe(el, { childList: true, subtree: true, characterData: true });
    wide.addEventListener("change", measure);
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) measure(); }).catch(() => {});
    return () => {
      alive = false;
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", measure);
      wide.removeEventListener("change", measure);
    };
  }, []);

  return (
    // Part of the FRAME (ChatGPT model, see `.cb-frame` in globals.css): the same colour as the symbol rail on the left
    // and the ground behind the content card, no bottom edge — the hairline on top of the card separates. `cb-frame` sets
    // `hover`/`edge` (and, in light, `dim`) to the frame's steps.
    <header className="cb-frame bg-frame">
      {/* No separate drag strip above the header. The window buttons sit IN this row, level with the tabs — and the row
          itself is the drag region. Double-click zoom stays possible: macOS performs it in the topmost ~28 px band over a
          drag region, which lies inside this row. So only controls get no-drag, exactly where one sits. */}
      {/* flex-wrap: the header is the only row on EVERY page — when it overflowed, the gear button on the right became
          unreachable (measured: 154 px overflow from ~1000 px window width, 634 px at 420 px). Instead of clipping it now
          wraps: brand and tabs top left, controls in the second row. */}
      <nav ref={navRef} className={`relative flex select-none flex-wrap items-center gap-x-2 gap-y-1.5 px-3 sm:px-5 ${inElectron ? "py-1.5" : "py-2"}`} style={drag}>
        {/* The centred slot (`cbase-topnav-center`) stands in the DOM BEHIND the tab strip, not here in front — the reason is at the slot. */}
        {/* The brand: lens and wordmark, in the window too (to the right of the traffic lights, level with the tabs, like
            the desktop apps of other tools). It is no control — it stays part of the drag region. */}
        {inElectron && (
          /* The placeholder is deliberately h-9 high — it keeps the first row at the 48 pt from which main.js derives the
             traffic-light height (centre 24: under Electron 44 y = 24 − 7 = 17, under 37 it was 24 − 8 = 16), even if the
             controls on the right wrap into a second row.
             The width must reach behind the third NATIVE button, in both shells: right edge under 44 at x 76 (frame 14 × 14
             at x 16/39/62), under 37 at x 69 (circle Ø 12 around x 63; frame up to 70). Left of it lies the nav's padding,
             px-5 = 20 — px-3 (12) applies only below sm (640), and the window does not get there at zoom 1 (minWidth 980 in
             both main.js). 20 + 62 = 82 > 76 > 70: 62 covers both, with 6 pt of air under 44. Limit: the page zoom
             (View → Zoom Out) shrinks CSS pixels, not the buttons — at 90 % the placeholder ends at 73.8 pt, but the first
             control starts only at (82 + 16 + 8) · 0.9 = 95.4 pt; content slides under the buttons only below 72 %. */
          <span aria-hidden className="h-9 w-[62px] shrink-0" />
        )}
        <span className={`mr-1 flex shrink-0 items-center gap-2.5 sm:mr-6 ${inElectron ? "ml-1" : ""}`}>
          {/* The brand IN the app is always the lens, never the app-icon tile (its dark background belongs on the desktop, not in a light header). */}
          <CbaseLens alt="cbase" className="h-7 w-7" />
          {/* The lettering is dropped on narrow windows — the logo already carries the brand. */}
          <span className="hidden text-[15px] font-bold tracking-tight sm:inline" data-brand-wordmark>cbase</span>
        </span>
        {ownWindowButtons && <WindowButtons />}
        {/* flex-1: takes the free space so the controls sit on the right. cb-strip scrolls the tabs horizontally if needed
            instead of pushing them out of the window. min-w-[13rem] is the lower bound they must NOT shrink below: with
            min-w-0 only 26 px stayed visible at 480 px window width (formally scrollable, practically unusable). With the
            minimum width the button group wraps instead. */}
        {/* no-drag sits on the TABS, not on the strip: the strip is flex-1 and would otherwise remove the drag region from
            the top window edge across its whole width — exactly where one usually grabs and double-clicks a window. */}
        <span ref={tabsRef} className="cb-strip flex min-w-[13rem] flex-1 items-center gap-1 overflow-x-auto sm:gap-2">
          {/* Slot BEFORE the first tab (filled via portal, e.g. the sidebar button of the workspace page). display:contents —
              the portal content becomes a direct flex child of the strip; empty, the slot takes no space. Like the other
              slots, no-drag is set by the portal CONTENT, not the slot. */}
          <span id="cbase-topnav-tabs-start" className="contents" />
          {/* "Coding" instead of "Workspace": the tab is named after what happens below it — the implementation and coding
              agents run here. The WORKSPACE is no longer a level of the top navigation but the selection to the left (sidebar
              button in the slot before). The route stays /workspaces — a rename is no reason to break bookmarks and deep links. */}
          <Link style={noDrag} href="/workspaces" className={tabClass(pathname === "/" || pathname.startsWith("/workspaces"))}>
            Coding
          </Link>
          {/* Old addresses of removed tabs redirect to Coding (the `todos` page under app/; `/skills` → Coding → Skills). */}
          <Link style={noDrag} href="/apps" className={tabClass(pathname.startsWith("/apps"))}>
            Apps
          </Link>

        </span>
        {/* Centred slot in the main row (filled via portal through `HeadersMiddle`: Workspace › Project of the coding page,
            "All workspaces" on Apps) — centred, level with the nav links. IMPORTANT: the slot itself must carry NO
            no-drag (it spans the whole nav and would cancel the window drag region) — only the portal CONTENT sets
            no-drag (`HeadersMiddle`, always). Absolutely centred only if it fits the measured band
            (`data-situation="band"`, see the measurement above): from lg, controls in row one, and the content does not
            protrude at its minimum widths. Otherwise it gets a row of its own (order-last), and while the slot is empty it
            takes none thanks to empty:hidden.
            Its PLACE IN THE DOM is load-bearing: BEHIND the tab strip, not as the first child of the nav (otherwise
            "Workspace › Project" could not be clicked in the client). Blink collects the app-regions in DOM order, Electron
            unions `drag` and subtracts `no-drag`, rectangle by rectangle — the LATER one wins, not the one painted on top.
            The strip is `flex-1`, so it reaches across the whole band to the controls, and since Electron 44 inherits
            `drag` from the nav: in front of it in the DOM its rectangle overwrote the content's `no-drag`. Measured with
            Electron's drag-region debugger (`ELECTRON_DEBUG_DRAGGABLE_REGIONS=1`, Electron 44): slot before a flex-1
            sibling ⇒ 1 rectangle, the content's hole is closed; the same slot behind it ⇒ 4 rectangles, the hole stays. In
            the browser there is no drag region, the click always worked there. Behind the slot only the controls stand, and
            their group ends 12 px before the band (or lies in another row). Guard: web/test/drag-region.test.mjs (a portal
            slot with `id` before a wide sibling that inherits `drag` is red).
            Tab order thus matches the picture ONLY in the band layout (tabs, Workspace › Project, controls); in the row
            layout the slot is its own row UNDER the controls, and focus jumps from the tabs down there and back up. A fixed
            DOM order cannot make both layouts identical to the picture, and the slot must not go before the strip.
            Menus in this slot (and everywhere in the header) fade in via opacity only (`cb-fade-in-fast`), never with
            `translate`/`scale` (`cb-pop-in-fast`): Electron computes a menu's `no-drag` area from the layout, a transform
            animation runs past the compositor — the region would stay at the start position (for the project menu 12 px
            lower, its top 4 px stayed a window grab handle) until some later layout comes. */}
        <div
          id="cbase-topnav-center"
          ref={middleRef}
          /* NO `style` and no `data-situation` here: `left`/`right` (the measured free band) and the situation are set by
             the measurement itself on the element — what stands in the JSX belongs to React and would be written back on
             the next render. */
          className="pointer-events-none order-last flex w-full min-w-0 items-center justify-start empty:hidden data-[situation=band]:absolute data-[situation=band]:inset-y-0 data-[situation=band]:order-none data-[situation=band]:w-auto data-[situation=band]:justify-center"
        />
        {/* All controls in ONE group: so they stay together on wrap and land together in the second row instead of
            falling apart one by one. No no-drag on the group itself — the gaps should stay window drag region. */}
        {/* Compact and quiet: borderless 32 px buttons, dimmed rings, a hairline between information (rings, pills) and
            operation (runs, bell, theme, settings). */}
        <span ref={ctrlRef} className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
        {(() => {
          // One ring per CONNECTED provider. WHICH window is shown is decided uniformly by the server: `ring` is the
          // SESSION WINDOW (Claude 5 h across all models) — also with a value when the endpoint leaves the legacy fields
          // empty (the display used to vanish exactly at the limit). An exhausted OTHER window (e.g. a model-specific weekly
          // limit) is shown in the tooltip, not in the ring value. The branches without `ring` stay for older backends.
          const rings = [];
          if (conn.claude && (usage?.ring || usage?.fiveHour?.utilization != null)) {
            const r = usage.ring;
            rings.push(
              <UsageRing
                key="claude" provider="claude" active={activeProvider === "claude"}
                windowLabel={r ? ringLabel(r, t) : "5h"}
                pct={r ? r.percent : usage.fiveHour!.utilization!}
                resetsAt={r ? r.resetsAt : usage.fiveHour.resetsAt}
                reached={!!r?.reached}
                blockedBy={blockedLabel(r, usage.blocking, t)}
              />,
            );
          }
          if (conn.codex && codexUsage?.connected) {
            const r = codexUsage.ring;
            const w = codexUsage.secondary?.usedPercent != null ? codexUsage.secondary : codexUsage.primary;
            if (r) {
              rings.push(<UsageRing key="codex" provider="codex" windowLabel={ringLabel(r, t)} pct={r.percent} resetsAt={r.resetsAt} active={activeProvider === "codex"} reached={r.reached} blockedBy={blockedLabel(r, codexUsage.blocking, t)} />);
            } else if (w && w.usedPercent != null) {
              const wl = w.windowMinutes === 300 ? "5h" : w.windowMinutes === 10080 ? t("7-day") : w.windowMinutes ? `${Math.round(w.windowMinutes / 60)}h` : "";
              rings.push(<UsageRing key="codex" provider="codex" windowLabel={wl} pct={w.usedPercent} resetsAt={w.resetsAt ?? null} active={activeProvider === "codex"} />);
            }
          }
          {/* Hidden below md: the rings are mainly information — and the controls should not slip into a third row on
              narrow windows. The same values are in Settings under "Usage"; a click on a ring leads there. */}
          return rings.length ? <span style={noDrag} className="hidden items-center gap-0.5 md:flex">{rings}</span> : null;
        })()}
        {/* The state pills, on EVERY page: services · agent browser · VS Code, right after the rings — both are the state
            of the whole. Their scope is the active workspace (`lib/active-scope.ts`), in Coding plus the entered project.
            Unlike the rings NOT hidden below md: the services pill only drops its CPU/RAM numbers there. no-drag on the
            group as on the rings — it carries only controls; empty, it takes no space. */}
        <span style={noDrag} className="flex shrink-0 items-center gap-0.5 empty:hidden">
          <ServicesPill />
          <AgentBrowsersPill />
          <VsCodePill />
        </span>
        <span aria-hidden className="mx-1.5 hidden h-4 w-px bg-edge md:inline-block" />
        {gw && (
          <span style={noDrag} className="flex items-center gap-1.5">
            <span className="flex items-center gap-1 rounded-full py-0.5 pl-2 pr-0.5 text-[11.5px] text-dim"
                  title={t("Signed in as {name}", { name: gw.user.username })}>
              <span className="max-w-[120px] truncate">{gw.user.username}</span>
              {/* "Administration" opens the settings page. The link is dropped below sm — there it cost the controls' space, and the gear leads there too. */}
              {gw.user.role === "admin" && (
                <button type="button" onClick={() => openSettings(ADMINISTRATION_PAGE)}
                   className="hidden rounded-full px-1.5 py-0.5 text-[11px] text-dim transition-colors hover:bg-hover hover:text-fg sm:inline"
                   title={t("Admin")}>{t("Admin")}</button>
              )}
              <button onClick={gw.logout} title={t("Sign out")} aria-label={t("Sign out")}
                      className="grid h-6 w-6 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </span>
          </span>
        )}
        {/* Active runs — visible on every page: what is computing right now, for how long, what waits for me. Deliberately left of the bell: it is state, not a notification. */}
        <span style={noDrag}>
          <ActiveRunsPill />
        </span>
        <span style={noDrag}>
          <NotificationBell />
        </span>
        <span style={noDrag}>
          <ThemeToggle />
        </span>
        <button
          onClick={() => { setSettingsPage(undefined); setSettingsOpen(true); }}
          style={noDrag}
          title={t("Settings")}
          aria-label={t("Settings")}
          className="grid h-8 w-8 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        </span>
        {settingsOpen && <SettingsModal start={settingsPage} onClose={() => setSettingsOpen(false)} />}
      </nav>

    </header>
  );
}
