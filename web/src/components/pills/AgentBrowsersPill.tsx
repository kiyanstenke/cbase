"use client";

import { useEffect, useState } from "react";
import { api, subscribeGlobalEvents, type BrowserInfo } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useEdgeClamp } from "@/lib/viewport";
import { useActiveScope } from "@/lib/active-scope";
import { windowForSession, openBrowserWindow } from "@/lib/browser-choice";
import { menuHeader, menuRow } from "@/components/CbKit";

// Display of the agents' browsers: appears in the header as soon as an agent (the Playwright MCP of a chat run) has started a browser.
// Click → choice of the active browsers → viewer pop-up window (window.open, like the admin window). Live via the global event stream
// (/api/events, type "browsers"); initial state via GET /api/browsers. The type `BrowserInfo` lives in lib/api/devtools.ts — the right
// chat bar reads the same list.
//
// Icon + count instead of a sentence — the bar is tight; the sentence is in the tooltip and the accessibility label. The workspace is
// the active scope of the header (`lib/active-scope.ts`), not a prop of the Coding page: the pill shows on every page.
//
// It opens the window through `openBrowserWindow` (lib/browser-choice.ts) — the same call as the button in the browser section of the
// right chat bar — and for an agent browser with the PROFILE instead of the session id (`windowForSession`): the agent's next run starts
// a new Chromium, and a window on the old id would stay at "gone".

export function AgentBrowsersPill() {
  const t = useT();
  const { workspaceId } = useActiveScope();
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [open, setOpen] = useState(false);
  const popRef = useEdgeClamp<HTMLDivElement>(open);

  useEffect(() => {
    let alive = true;
    void api<{ browsers: BrowserInfo[] }>("/api/browsers")
      .then((r) => { if (alive) setBrowsers(r.browsers || []); })
      .catch(() => {});
    const off = subscribeGlobalEvents((d) => {
      if (d.type === "browsers") setBrowsers((d.list as BrowserInfo[]) || []);
      else if (d.type === "init" && Array.isArray(d.browsers)) setBrowsers(d.browsers as BrowserInfo[]);
    });
    return () => { alive = false; off(); };
  }, []);

  // Click catcher as a document mousedown, not as fixed inset-0 (house rule, globals.css).
  useEffect(() => {
    if (!open) return;
    const beside = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest?.("[data-agentbrowser-pop]")) setOpen(false); };
    document.addEventListener("mousedown", beside);
    return () => document.removeEventListener("mousedown", beside);
  }, [open]);

  const agents = workspaceId ? browsers.filter((b) => b.kind === "agent" && b.workspaceId === workspaceId) : [];
  if (!agents.length) return null;

  const openViewer = (b: BrowserInfo) => {
    setOpen(false);
    openBrowserWindow(window, windowForSession(b));
  };
  const set = agents.length === 1 ? t("Browser active") : t("{n} browsers active", { n: agents.length });

  return (
    <span className="relative shrink-0" data-agentbrowser-pop>
      <button
        type="button"
        onClick={() => (agents.length === 1 ? openViewer(agents[0]) : setOpen((v) => !v))}
        title={`${set} — ${t("An agent is currently driving a browser — click to watch (extra window)")}`}
        aria-label={set}
        data-agent-browser-count={agents.length}
        className="flex h-8 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg"
      >
        {/* Static: an open agent browser is a lasting state (can last hours), not a process. A permanent animation = 60 frames/s
            for no reason. */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-accent">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
          <circle cx="6.5" cy="6.5" r="0.6" fill="currentColor" />
          <circle cx="9" cy="6.5" r="0.6" fill="currentColor" />
        </svg>
        <span className="tabular-nums">{agents.length}</span>
      </button>
      {open && (
        <div ref={popRef} data-overlay className="cb-pop absolute right-0 top-full z-40 mt-2 w-[min(260px,calc(100vw-2rem))] rounded-2xl p-1.5 text-fg">
          <div className={menuHeader}>
            {t("Watch browser")}
          </div>
          {/* The rows in the form of the menu row (CbKit `menuRow`): rounded, indented, 2 px gap. */}
          {agents.map((b) => (
            <button
              key={b.id}
              onClick={() => openViewer(b)}
              className={`${menuRow} text-[13px]`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 flex-1 truncate">{b.label || t("Agent browser")}</span>
              <span className="shrink-0 text-[11px] text-dim">{b.tabs} {b.tabs === 1 ? "Tab" : "Tabs"}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
