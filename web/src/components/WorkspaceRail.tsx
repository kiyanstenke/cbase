"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/lib/i18n";
import { useAutoCollapse } from "@/lib/viewport";
import type { Workspace } from "@/lib/api";

// ── The workspace switch as a side rail ──────────────────────────────────────
//
// A workspace is not a VIEW next to chats, tasks and storage but the frame in which all of that sits — so it is a
// rail on the left, opened via a button at the top left. This file is that button plus the rail, so every page uses
// the same thing and not two imitations.
//
// The rail brings its own content frame (`children` sits in it): the hover-peek overlay lies absolutely over the
// content and needs a `relative` reference, which every calling page would otherwise have to provide.

export function WorkspaceRail({
  list,
  loaded,
  activeId,
  onPick,
  children,
  storageKey = "cbase-rail-closed",
  onNew,
  showPath = false,
}: {
  list: Workspace[];
  /**
   * Is the list settled yet? Without that, `list.length === 0` is ambiguous: pages start with `[]` and fetch the
   * workspaces afterwards; the rail would read the empty list as "no workspace", stand OPEN (228 px) and then
   * collapse over 300 ms when the list arrives, visibly. That is the purpose of this field, not a convenience
   * switch — so it is required and has no default a caller could inherit by accident.
   */
  loaded: boolean;
  activeId: string | null;
  onPick: (id: string) => void;
  children: React.ReactNode;
  /** So each page remembers its own open/closed state. */
  storageKey?: string;
  /** "+ Workspace" in the rail's header — the coding page creates workspaces. */
  onNew?: () => void;
  /** Path as tooltip on the row (without gateway); in gateway mode paths are the server's business. */
  showPath?: boolean;
}) {
  const t = useT();
  // Initial value straight from storage (lazy init) — otherwise the rail opens on first render and closes again next frame.
  const [closed, setClosed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) !== "open"; } catch { return true; }
  });
  const [peek, setPeek] = useState(false);
  // Without a single workspace the rail stays open: the only way to "+ Workspace" leads through it, and a collapsed
  // nothing explains nothing. But only if that is REALLY settled — while the list is in flight, the user's choice counts.
  const toEffective = closed && !(loaded && list.length === 0);
  // The width transition only once the rail knows its final state and one frame has passed. Otherwise the correction
  // when the list arrives animates visibly — the same precaution the chat list carries in `ChatPane` as `animReady`.
  // A user click afterwards animates as usual.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!loaded) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [loaded]);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("cbase-topnav-tabs-start")), []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, closed ? "closed" : "open"); } catch { /* no storage */ }
  }, [closed, storageKey]);

  // Below 1000 px the rail collapses by itself and reopens when enlarged — the same threshold as on the coding page.
  useAutoCollapse(1000, !closed, useCallback((open: boolean) => {
    setClosed(!open);
    if (!open) setPeek(false);
  }, []));

  // Hover peek: the button sits in the header, the overlay in the content — the timer bridges the mouse gap between them.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const peekOn = () => { clearTimeout(timer.current); if (toEffective) setPeek(true); };
  const peekTo = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setPeek(false), 250); };

  // In the chat list's measure (ChatGPT sidebar style): heading with pin on the right, below it "New workspace" as the
  // first row, then the workspaces as calm 14 px rows — the chosen one on `edge`, no accent except the symbol.
  const content = (docked: boolean) => (
    <>
      <header className="shrink-0 px-2 pb-1 pt-2">
        <div className="flex h-10 items-center gap-0.5">
          <span className="min-w-0 flex-1 truncate pl-2.5 text-[15px] font-semibold tracking-tight">{t("Workspaces")}</span>
          <button
            type="button"
            onClick={() => { setClosed(docked); setPeek(false); }}
            title={docked ? t("Undock sidebar") : t("Pin sidebar")}
            aria-label={docked ? t("Undock sidebar") : t("Pin sidebar")}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"
          >
            <PanelIcon />
          </button>
        </div>
        {onNew && (
          <button
            type="button"
            onClick={() => { onNew(); setPeek(false); }}
            className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-hover"
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-fg/80"><PlusIcon /></span>
            {t("New workspace")}
          </button>
        )}
      </header>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {list.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => { onPick(w.id); setPeek(false); }}
            title={showPath ? w.path : undefined}
            className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
              w.id === activeId ? "bg-edge text-fg" : "text-fg/90 hover:bg-hover"
            }`}
          >
            <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${w.id === activeId ? "text-accent" : "text-dim"}`}>
              <WorkspaceIcon />
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px] leading-5">{w.name}</span>
          </button>
        ))}
        {list.length === 0 && (
          <div className="px-2.5 py-2 text-[13px] leading-relaxed text-dim">{t("No workspace yet")}</div>
        )}
      </nav>
    </>
  );

  return (
    <>
      <aside
        className={`flex shrink-0 flex-col overflow-hidden bg-panel ${
          ready ? "transition-[width] duration-300 ease-in-out" : ""
        } ${toEffective ? "w-0" : "w-[228px] border-r border-edge"}`}
      >
        <div className="flex h-full w-[228px] flex-col">{content(true)}</div>
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          className={`pointer-events-none absolute bottom-3 left-3 top-1.5 z-30 flex w-[236px] flex-col items-start ${
            ready ? "transition-opacity duration-300" : ""
          } ${toEffective ? "opacity-100" : "opacity-0"}`}
          onMouseEnter={peekOn}
          onMouseLeave={peekTo}
        >
          <div
            className={`min-h-0 w-full flex-1 transition-all duration-200 ease-out ${
              peek && toEffective ? "pointer-events-auto translate-x-0 opacity-100" : "-translate-x-2 opacity-0"
            }`}
          >
            <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-edge bg-bg shadow-card">
              {content(false)}
            </div>
          </div>
        </div>
        {children}
      </main>

      {/* The button at the far left of the header. no-drag, because the header is the window drag region. */}
      {slot &&
        createPortal(
          <button
            type="button"
            onClick={() => { setClosed((v) => !v); setPeek(false); }}
            onMouseEnter={peekOn}
            onMouseLeave={peekTo}
            title={closed ? t("Open workspace sidebar (hover: preview)") : t("Collapse sidebar")}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"
          >
            <PanelIcon />
          </button>,
          slot,
        )}
    </>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

// Stacked layers — a workspace holds several projects. Deliberately not a folder (projects and chat folders carry
// that) and not a hexagon (that is a chat's run state).
function WorkspaceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 3 7.5 12 12l9-4.5L12 3z" />
      <path d="M3 12.5 12 17l9-4.5" />
    </svg>
  );
}
