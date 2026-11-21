"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, API_BASE } from "@/lib/api";
import { useResolvedTheme } from "@/lib/theme";
import { useT, tr } from "@/lib/i18n";
import { listenTextSize, textCount } from "@/lib/appearance";
import { XTERM_THEMES, xtermOnBackground } from "@/components/TerminalPanel";
import { getAccent, useAccent, xtermWithAccent } from "@/lib/accent";
import { Placeholder, ghostSm, pillSm } from "@/components/CbKit";
import { BAR_ACTION_CLASS, BAR_HEADER_CLASS, BAR_TITLE_CLASS } from "@/lib/chat-bar";
import { writeTerminalChunk } from "@/lib/terminal-stream";

// Several PTY terminals per scope (workspace OR project), with tabs + split (several panes side by side in one tab).
// The layout state (tabs, splits, running PTY ids) is kept per scope in localStorage. On a tab switch this component
// stays mounted (hidden) — so the terminals and their processes keep running uninterrupted. If it is remounted anyway
// (e.g. scope change), each pane re-attaches to the still-running session by PTY id (the server replays the scrollback buffer).
//
// Two variants: `page` is the terminal tab of the page (tabs, split); `bar` is the terminal section of the right chat
// bar — it renders the 32 px panel header of the contract ITSELF (title, tabs as chips, "+"), has no split and sits
// flush without glass. The localStorage shape is the same (one group with one pane), the scopeKey `chat:<id>` — every
// chat has its own PTYs, and when the chat is deleted the server ends them via the tag every POST /terminal sends.
//
// `page` has no glass surface either: the tab row and the terminals sit borderless on the stage (the page gives no
// padding, app/workspaces/page.tsx), a hairline between tab row and terminal, likewise between panes on split; the
// terminal itself is no rounded tub in its theme's background but takes the page background colour
// (`onBackground` → `xtermOnBackground`, TerminalPanel.tsx). The bar is not affected.

type Pane = { pid: string; termId?: string; title: string };
type Group = { gid: string; panes: Pane[] };
type Layout = { groups: Group[]; active: string };

/** The localStorage key of a scope's layout — exported so ChatPane can remove it when a chat is deleted. */
export const terminalLayoutKey = (scopeKey: string) => `cbase-terms:${scopeKey}`;
/** The scopeKey (and so the server tag) of a chat's PTYs — ONCE here; the server (chats/routes.js, workspaces/routes.js)
 *  builds the same literal, and on delete it finds the shells only if both stay equal. */
export const terminalScope = (chatId: string) => `chat:${chatId}`;
const rid = () => Math.random().toString(36).slice(2, 10);

// Next terminal number = SMALLEST free number among the currently open terminals (not a monotonically growing counter).
// So a new terminal after closing "Terminal 2" is again "Terminal 2", not "Terminal 3". The number is always at the end of the title.
const nextNum = (groups: Group[]) => {
  const used = new Set(
    groups.flatMap((g) => g.panes).map((p) => {
      const m = /(\d+)\s*$/.exec(p.title);
      return m ? Number(m[1]) : 0;
    }),
  );
  let n = 1;
  while (used.has(n)) n++;
  return n;
};

// Read the current theme LIVE from the DOM (data-theme is set before first paint). useResolvedTheme() deliberately
// starts with "light" and only becomes correct after mount — for the xterm, created asynchronously (after the
// /terminal fetch), that would be too late and the terminal would stay in light mode. So use the DOM value at creation.
// Cursor and selection follow the chosen accent colour (as in TerminalPanel).
const liveXtermTheme = () => {
  const mode = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  return xtermWithAccent(XTERM_THEMES[mode], mode, getAccent());
};

function loadLayout(scopeKey: string): Layout {
  try {
    const raw = localStorage.getItem(terminalLayoutKey(scopeKey));
    if (raw) {
      const l = JSON.parse(raw) as Layout;
      if (l && Array.isArray(l.groups)) return { groups: l.groups, active: l.active || "" };
    }
  } catch { /* ignore */ }
  return { groups: [], active: "" };
}

export function TerminalsPane({ apiBase, scopeKey, variant = "page" }: { apiBase: string; scopeKey: string; variant?: "page" | "bar" }) {
  const t = useT();
  const [layout, setLayout] = useState<Layout>(() => loadLayout(scopeKey));

  // On scope change (new scopeKey) load the saved layout of that scope.
  useEffect(() => { setLayout(loadLayout(scopeKey)); }, [scopeKey]);
  // Persist the layout (per scope).
  useEffect(() => { try { localStorage.setItem(terminalLayoutKey(scopeKey), JSON.stringify(layout)); } catch { /* ignore */ } }, [layout, scopeKey]);

  const groups = layout.groups;
  const activeGroup = groups.find((g) => g.gid === layout.active) || groups[0] || null;

  // Focus only on user intent (bar variant): "+" and a click on a chip request focus for ONE group, counted so that a
  // click on the already active chip also works. Without the counter every mount would pull the keyboard into the
  // shell — and the bar remounts on every chat switch and page load (the composer would lose its autoFocus, Enter
  // would run in the shell). The page variant only mounts when the user opens its tab, and therefore focuses on mount
  // (`focus` undefined).
  const [focusWish, setFocusWish] = useState<{ gid: string; n: number }>({ gid: "", n: 0 });
  const wishes = (gid: string) => setFocusWish((w) => ({ gid, n: w.n + 1 }));

  const addGroup = useCallback(() => {
    const gid = rid(); // outside the updater so the focus request carries the same id
    setLayout((l) => {
      const g: Group = { gid, panes: [{ pid: rid(), title: `${tr("Terminal")} ${nextNum(l.groups)}` }] };
      return { groups: [...l.groups, g], active: g.gid };
    });
    setFocusWish((w) => ({ gid, n: w.n + 1 }));
  }, []);

  const splitActive = useCallback(() => {
    setLayout((l) => {
      const n = nextNum(l.groups);
      const groups = l.groups.map((g) => g.gid === (l.active || l.groups[0]?.gid)
        ? { ...g, panes: [...g.panes, { pid: rid(), title: `${tr("Terminal")} ${n}` }] }
        : g);
      return { ...l, groups };
    });
  }, []);

  const killTerm = (termId?: string) => { if (termId) fetch(`${API_BASE}/api/terminal/${termId}`, { method: "DELETE" }).catch(() => {}); };

  const closeGroup = useCallback((gid: string) => {
    setLayout((l) => {
      const g = l.groups.find((x) => x.gid === gid);
      g?.panes.forEach((p) => killTerm(p.termId));
      const groups = l.groups.filter((x) => x.gid !== gid);
      const active = l.active === gid ? (groups[groups.length - 1]?.gid || "") : l.active;
      return { ...l, groups, active };
    });
  }, []);

  const closePane = useCallback((gid: string, pid: string) => {
    setLayout((l) => {
      const g = l.groups.find((x) => x.gid === gid);
      const pane = g?.panes.find((p) => p.pid === pid);
      killTerm(pane?.termId);
      let groups = l.groups.map((x) => x.gid === gid ? { ...x, panes: x.panes.filter((p) => p.pid !== pid) } : x);
      let active = l.active;
      const stillThere = groups.find((x) => x.gid === gid);
      if (stillThere && stillThere.panes.length === 0) {
        groups = groups.filter((x) => x.gid !== gid);
        if (active === gid) active = groups[groups.length - 1]?.gid || "";
      }
      return { ...l, groups, active };
    });
  }, []);

  const setTermId = useCallback((pid: string, termId: string) => {
    setLayout((l) => ({ ...l, groups: l.groups.map((g) => ({ ...g, panes: g.panes.map((p) => p.pid === pid ? { ...p, termId } : p) })) }));
  }, []);

  const setActive = (gid: string) => setLayout((l) => ({ ...l, active: gid }));

  if (variant === "bar") {
    // The chip carries the terminal's number (the title always ends with it, see nextNum) —
    // "Terminal 1 · Terminal 2" did not fit in 280 px next to the title and "+".
    const chipText = (g: Group) => {
      const title = g.panes[0]?.title || "";
      const m = /(\d+)\s*$/.exec(title);
      return m ? m[1] : title || "1";
    };
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header data-bar-header className={BAR_HEADER_CLASS}>
          <h2 className={`${BAR_TITLE_CLASS} flex-none`}>{t("Terminal")}</h2>
          <div role="tablist" className="cb-strip flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {groups.map((g) => {
              const on = g.gid === activeGroup?.gid;
              return (
                <div
                  key={g.gid}
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  title={g.panes[0]?.title || "Terminal"}
                  // `e.detail > 0`: only a real mouse click requests focus in the shell — the synthetic click of
                  // the arrow keys (chipKey) leaves it on the chip, otherwise keyboard navigation would end in the
                  // terminal after the first arrow.
                  onClick={(e) => { setActive(g.gid); if (e.detail > 0) wishes(g.gid); }}
                  onKeyDown={(e) => chipKey(e, () => { setActive(g.gid); wishes(g.gid); })}
                  className={`group flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-md pl-1.5 pr-0.5 text-[11px] font-medium tabular-nums transition-colors focus-visible:bg-hover focus-visible:text-fg ${on ? "bg-hover text-fg" : "text-dim hover:text-fg"}`}
                >
                  <span>{chipText(g)}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); closeGroup(g.gid); }}
                    title={t("Close terminal")}
                    aria-label={t("Close terminal")}
                    className="grid h-4 w-4 shrink-0 place-items-center rounded text-dim opacity-0 hover:bg-edge hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <CloseIcon />
                  </button>
                </div>
              );
            })}
          </div>
          <button type="button" data-terminal-new onClick={addGroup} aria-label={t("New terminal")} title={t("New terminal")} className={BAR_ACTION_CLASS}><PlusIcon /></button>
        </header>
        {/* No split: a group has one pane here. Should a second one be in the layout anyway (a layout is user data),
            they stack — nothing is lost. */}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-1.5 pb-1.5">
          {!activeGroup && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <Placeholder title={t("No terminal open yet.")} />
              <button onClick={addGroup} className={`${pillSm} flex items-center gap-1.5 bg-dark text-white hover:opacity-90`}>
                <PlusIcon /> {t("Open terminal")}
              </button>
            </div>
          )}
          {activeGroup?.panes.map((pane) => (
            <div key={pane.pid} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg">
              <TermInstance apiBase={apiBase} tag={scopeKey} pane={pane} onTermId={setTermId} focus={focusWish.gid === activeGroup.gid ? focusWish.n : 0} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    // Without a surface: on top the sessions as a tab row (underlined instead of filled), below them the terminals on the
    // page background — side by side on split, separated by a hairline.
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="cb-strip flex items-center gap-0.5 overflow-x-auto border-b border-edge px-2 pt-1.5">
        {groups.map((g) => {
          const on = g.gid === activeGroup?.gid;
          const extra = g.panes.length > 1 ? ` +${g.panes.length - 1}` : "";
          return (
            <div
              key={g.gid}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(g.gid)}
              onKeyDown={(e) => chipKey(e, () => setActive(g.gid))}
              className={`group relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2 py-1 pb-1.5 text-[12px] transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full ${
                on ? "font-semibold text-accent after:bg-accent/70" : "font-medium text-dim after:bg-transparent hover:bg-hover hover:text-fg"
              }`}
            >
              <TermIcon />
              <span className="max-w-[130px] truncate">{g.panes[0]?.title || "Terminal"}{extra}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeGroup(g.gid); }}
                title={t("Close terminal")}
                className="grid h-4 w-4 shrink-0 place-items-center rounded text-dim opacity-0 hover:bg-edge hover:text-danger group-hover:opacity-100"
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
        <button onClick={addGroup} title={t("New terminal")} className="mb-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"><PlusIcon /></button>
        <span className="flex-1" />
        {activeGroup && (
          <button onClick={splitActive} title={t("Split (terminal alongside)")} className={`${ghostSm} mb-1 flex shrink-0 items-center gap-1.5`}>
            <SplitIcon /> {t("Split")}
          </button>
        )}
      </div>

      {/* Panes of the active tab (side by side on split, hairline between) */}
      <div className="flex min-h-0 flex-1 divide-x divide-edge">
        {!activeGroup && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <Placeholder title={t("No terminal open yet.")} />
            <button onClick={addGroup} className={`${pillSm} flex items-center gap-1.5 bg-dark text-white hover:opacity-90`}>
              <PlusIcon /> {t("Open terminal")}
            </button>
          </div>
        )}
        {activeGroup?.panes.map((pane) => (
          <div key={pane.pid} className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* Pane header only on split: then each pane needs label + close. With a single terminal the tab above
                suffices — no "Terminal X" bar. */}
            {activeGroup.panes.length > 1 && (
              <div className="flex items-center gap-2 border-b border-edge px-3 py-1">
                <span className="truncate text-[10px] font-semibold uppercase tracking-[0.05em] text-dim">{pane.title}</span>
                <span className="flex-1" />
                <button onClick={() => closePane(activeGroup.gid, pane.pid)} title={t("Close pane")} className="grid h-5 w-5 place-items-center rounded text-dim transition-colors hover:bg-hover hover:text-danger"><CloseIcon /></button>
              </div>
            )}
            <TermInstance apiBase={apiBase} tag={scopeKey} pane={pane} onTermId={setTermId} onBackground />
          </div>
        ))}
      </div>
    </div>
  );
}

// A chip (role="tab") is a div — Enter and Space must trigger it like a click, otherwise it is mouse-only. Arrow keys
// move to the neighbouring chip (roving tabindex: only the active chip is in the tab order).
function chipKey(e: React.KeyboardEvent<HTMLDivElement>, toggle: () => void) {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); return; }
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const neighbor = (e.key === "ArrowLeft" ? e.currentTarget.previousElementSibling : e.currentTarget.nextElementSibling) as HTMLElement | null;
  if (neighbor?.getAttribute("role") === "tab") { neighbor.focus(); neighbor.click(); }
}

// ── One PTY session (xterm) ─────────────────────────────────────────────────
// On mount attaches to an existing PTY (pane.termId, if still alive) or starts a new one. On unmount the PTY is NOT
// ended — the process keeps running, and on the next mount the server replays the buffer.
// `tag` is the scopeKey: the server remembers it on the session and, when a chat is deleted, ends all PTYs with its tag
// (`killTerminalsByTag`) — without the tag it would not know which shells belonged to the chat.
// `focus`: undefined ⇒ focus on mount (page variant); a number ⇒ only if above 0, and again on every increase (the
// focus request of the bar variant).
// `onBackground` (page variant): the terminal sits borderless on the page background and takes its colour — without it
// it stays the rounded tub in its theme's background (bar variant, unchanged).
function TermInstance({ apiBase, tag, pane, onTermId, focus, onBackground = false }: { apiBase: string; tag: string; pane: Pane; onTermId: (pid: string, termId: string) => void; focus?: number; onBackground?: boolean }) {
  const t = useT();
  const holder = useRef<HTMLDivElement>(null);
  // The tub whose computed colour xterm takes (only with `onBackground`, else null — then the theme applies).
  const tub = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<"init" | "ready" | "unavailable" | "exited">("init");
  const [err, setErr] = useState("");
  const resolved = useResolvedTheme();
  // The mount path is asynchronous (first /exists or POST /terminal, then xterm) and reads the request from the ref
  // once the terminal stands; the effect covers one that already stands.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => { if (focus && termRef.current) termRef.current.focus(); }, [focus]);

  const accent = useAccent();
  useEffect(() => { if (termRef.current) termRef.current.options.theme = xtermOnBackground(xtermWithAccent(XTERM_THEMES[resolved], resolved, accent), tub.current); }, [resolved, accent]);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let es: EventSource | null = null;
    let ro: ResizeObserver | null = null;
    let offTextSize = () => {};
    let tid = pane.termId || "";

    (async () => {
      // Saved PTY still alive? Otherwise start a new one (e.g. after an app restart).
      if (tid) {
        try { const r = await api<{ exists: boolean }>(`/api/terminal/${tid}/exists`); if (!r.exists) tid = ""; }
        catch { tid = ""; }
      }
      if (!tid) {
        try {
          const sess = await api<{ id: string; available: boolean; error?: string }>(`${apiBase}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24, tag }) });
          if (disposed) { if (sess.id) fetch(`${API_BASE}/api/terminal/${sess.id}`, { method: "DELETE" }); return; }
          if (!sess.available) { setErr(sess.error || tr("node-pty not available")); setStatus("unavailable"); return; }
          tid = sess.id;
          onTermId(pane.pid, tid);
        } catch (e) { if (!disposed) { setErr(String((e as Error).message)); setStatus("unavailable"); } return; }
      }
      if (disposed || !holder.current) return;

      // xterm gets a NUMBER, not CSS — `textCount` factors in the app's text size (lib/appearance.ts).
      term = new Terminal({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: textCount(12), cursorBlink: true, theme: xtermOnBackground(liveXtermTheme(), tub.current), scrollback: 5000 });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(holder.current);
      setStatus("ready");

      const post = (op: string, body: Record<string, unknown>) =>
        fetch(`${API_BASE}/api/terminal/${tid}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});

      es = new EventSource(`${API_BASE}/api/terminal/${tid}/stream`);
      // A reconnect resumes at Last-Event-ID, `replaced` resets the xterm (lib/terminal-stream.ts) — otherwise every
      // reconnect would append the whole buffer: an idle terminal would show hundreds of prompts.
      es.onmessage = (e) => writeTerminalChunk(term, e.data);
      es.addEventListener("exit", () => { setStatus("exited"); es?.close(); });

      term.onData((d) => post("input", { data: d }));
      const doFit = () => {
        const el = holder.current;
        if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return; // hidden → do not fit
        try { fit.fit(); if (term) post("resize", { cols: term.cols, rows: term.rows }); } catch { /* ignore */ }
      };
      ro = new ResizeObserver(() => doFit());
      ro.observe(holder.current);
      doFit();
      offTextSize = listenTextSize(() => { if (term) { term.options.fontSize = textCount(12); doFit(); } });
      if (focusRef.current === undefined || focusRef.current > 0) term.focus();
    })();

    return () => {
      disposed = true;
      offTextSize();
      try { es?.close(); } catch { /* ignore */ }
      try { ro?.disconnect(); } catch { /* ignore */ }
      try { term?.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      // IMPORTANT: NO DELETE of the PTY — the process keeps running in the background.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.pid, apiBase]);

  // The tub carries the xterm theme's background (it does not read CSS variables): so the padding around the terminal
  // has the same colour as the terminal itself, not a second tone. With `onBackground` it is the other way round: the tub
  // carries the page background (`bg-panel`), without rounding, and the terminal takes its colour.
  return (
    <div
      ref={onBackground ? tub : undefined}
      className={`relative min-h-0 flex-1 overflow-hidden ${onBackground ? "bg-panel" : "rounded-xl"}`}
      style={onBackground ? undefined : { background: XTERM_THEMES[resolved].background }}
    >
      {status === "unavailable" ? (
        <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-dim">{t("Terminal not available")}{err ? `: ${err}` : ""}.</div>
      ) : (
        <div ref={holder} className={`h-full w-full ${onBackground ? "px-3 py-2" : "px-2 py-1"}`} />
      )}
      {status === "exited" && <span className="pointer-events-none absolute right-2 top-1 rounded-full bg-bg px-1.5 py-0.5 text-[10px] text-dim">{t("Session ended")}</span>}
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────
const TermIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></svg>;
const PlusIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>;
const CloseIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>;
const SplitIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>;
