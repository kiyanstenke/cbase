"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  OVERLAY_SELECTOR, addressText, activeTab, touchedOverlay, hasOverlay, hostRect, nativeBridge,
  reportAgainNeeded, reduceState, rectEqual, visibleLoudStyle, stateEmpty,
  type NativeBridge, type NativeHint, type NativeRect, type NativeState,
} from "@/lib/browser-native";
import { normalizeNavUrl } from "@/lib/nav-url";
import { api } from "@/lib/api";
import { projectOfTheInstance, type ProjectWithInstance } from "@/lib/services-status";
import { useT } from "@/lib/i18n";
import { Hint, ghostSm } from "@/components/CbKit";

// The NATIVE browser: in the cbase Client (Electron) the user browser is not a streamed surface but a real WebContentsView of
// the main window. This component draws only the FRAME — tab row, address row, DevTools button — and tells the client WHERE
// the page should lie; the picture comes from the window itself, not over the wire. Hence the two peculiarities the streamed
// pane does not have:
//
//  • Bounds: the host surface (`data-browser-native-host`) measures itself and sends its rectangle in CSS pixels to the client.
//    Invisible (tab switch, `hidden`, unmount) means null — the client then hides the view instead of leaving it standing over
//    another page.
//  • Still image: a native view lies ALWAYS above the web content. As soon as a modal, a menu or a palette stands above the pane,
//    the client hides the view and delivers a JPEG that stands here in its place. This is detected by the UI's markers
//    (OVERLAY_MARKER).
//
// The form is that of the streamed pane (BrowserPane.tsx): the same tab row, the same address row, the same two variants
// `page`/`bar`. Whoever changes the form here changes it there too — else the same browser looks different in client and Chrome.
export function BrowserNative({
  scope,
  active = true,
  variant = "page",
}: {
  scope: string;
  active?: boolean;
  variant?: "page" | "bar";
}) {
  // No glass surface on the page either (like BrowserPane): there a hairline separates under the address row and the host
  // surface lies edge-to-edge below; the bar keeps its inset surface.
  const page = variant !== "bar";
  // The notices between address row and host surface: on the page below the hairline, so with spacing above.
  const hintMargin = page ? "m-2 shrink-0" : "mx-2 mb-2 shrink-0";
  const t = useT();
  const hostId = useId(); // two hosts per scope possible (page + chat bar) — the client tells them apart
  const [state, setState] = useState<NativeState>(() => stateEmpty(scope));
  const [hint, setHint] = useState<NativeHint | null>(null);
  // The project names for the choice on "ambiguous" — fetched when such a card arrives, not before.
  const [projects, setProjects] = useState<ProjectWithInstance[] | null>(null);
  const [stillFrame, setStillFrame] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const lastRect = useRef<NativeRect | null>(null);
  const stillFrameOn = useRef(false);
  // `report` hangs on `active` and thereby changes identity; the listener below must not re-subscribe because of it. So via a
  // ref that always holds the current version.
  const reportRef = useRef<() => void>(() => {});

  // The bridge exists only in the client and only after mount — in the SSR build there is no `window`. The caller (BrowserPane)
  // has already checked it; here it is only fetched.
  const bridge = useMemo<NativeBridge | null>(() => (typeof window === "undefined" ? null : nativeBridge(window)), []);

  // ── Open: create views or restore them from the remembered tabs ──
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    // Empty first: `reduceState` discards everything that does not belong to the scope in the state — if the old one stayed, the
    // new scope would never receive anything. The callers remount per scope today (`key`), but the promise must not depend on
    // their continuing to do so.
    setState(stateEmpty(scope));
    void bridge.open(scope).then((z) => { if (alive && z) setState((old) => reduceState(old, z)); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge, scope]);

  // ── State, notices, ⌘L ──
  // The client sends the scope's whole state on EVERY change; `reduceState` discards what belongs to another scope (the bridge
  // sends to all listeners).
  useEffect(() => {
    if (!bridge) return;
    const offs = [
      bridge.onState((z) => {
        setState((old) => reduceState(old, z));
        // The client threw away its host entries (it does so on every navigation of the window), so our report is lost. Since the
        // pane only sends CHANGES, it has to start over by hand here — else the surface would stay empty.
        if (z?.scope === scope && reportAgainNeeded(z, lastRect.current)) {
          lastRect.current = null;
          reportRef.current();
        }
      }),
      bridge.onHint((h) => {
        if (h.scope !== scope) return;
        setHint(h);
        if (h.kind === "ambiguous") void api<ProjectWithInstance[]>("/api/projects").then((l) => { if (Array.isArray(l)) setProjects(l); }).catch(() => {});
      }),
      bridge.onAddressBar((s) => {
        if (s !== scope) return;
        urlRef.current?.focus();
        urlRef.current?.select();
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [bridge, scope]);

  // ── Bounds: where the page should lie ──
  // Only what CHANGES is reported (rectEqual) — else every scroll event would send an IPC that moves nothing. The cleanup
  // reports null: a torn-down pane must not leave a view standing over another page.
  const report = useCallback(() => {
    if (!bridge) return;
    const el = hostRef.current;
    const rect = el && active ? hostRect(el.getBoundingClientRect(), true) : null;
    if (rectEqual(rect, lastRect.current)) return;
    lastRect.current = rect;
    bridge.bounds(scope, hostId, rect);
  }, [bridge, scope, hostId, active]);

  useEffect(() => { reportRef.current = report; }, [report]);

  useEffect(() => {
    if (!bridge) return;
    report();
    const ro = new ResizeObserver(report);
    if (hostRef.current) ro.observe(hostRef.current);
    // Scrolling anywhere in the tree moves the surface without changing its size — capture, because scroll events of inner
    // elements do not bubble to the window.
    window.addEventListener("resize", report);
    document.addEventListener("scroll", report, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
      document.removeEventListener("scroll", report, true);
      lastRect.current = null;
      bridge.bounds(scope, hostId, null);
    };
  }, [bridge, report, scope, hostId]);

  // ── Overlays: view off, still image on ──
  // The observer hangs on the body with `subtree` (an overlay is not always a portal child of the body) and with
  // `class`/`style`, because the Kit menu first mounts its sheet invisibly and then sets it to its position. `touchedOverlay`
  // cheaply decides whether to recompute at all — a streaming chat mutates the document dozens of times per second, and without
  // the pre-check every time a querySelectorAll would run over the page. The computation then uses the markers plus two
  // filters: invisible does not count (the "Jump to end" button permanently carried `.cb-pop`), and only what really
  // INTERSECTS the host surface covers it. What this does NOT cover: a standing overlay under which the pane scrolls away — for
  // that the window resize is included, scrolling deliberately not (it fires per frame, and every menu of the UI closes by
  // itself on scroll).
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const check = () => {
      const el = hostRef.current;
      const host = el && active ? hostRect(el.getBoundingClientRect(), true) : null;
      const candidates = host
        ? [...document.querySelectorAll(OVERLAY_SELECTOR)].filter((k) => visibleLoudStyle(window.getComputedStyle(k)))
        : [];
      const desired = hasOverlay(candidates, host);
      if (desired === stillFrameOn.current) return;
      stillFrameOn.current = desired;
      void bridge.stillFrame(scope, desired)
        .then((image) => { if (alive) setStillFrame(desired ? image : null); })
        .catch(() => { if (alive) setStillFrame(null); });
    };
    const mo = new MutationObserver((records) => { if (touchedOverlay(records)) check(); });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    // The surface itself can change without window resize and without mutation: the right chat bar's handle drags it between
    // 280 and 640 px. Afterwards a standing menu suddenly lies above it — or no longer does.
    const ro = new ResizeObserver(check);
    if (hostRef.current) ro.observe(hostRef.current);
    window.addEventListener("resize", check);
    check();
    return () => {
      alive = false;
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", check);
      if (stillFrameOn.current) {
        stillFrameOn.current = false;
        void bridge.stillFrame(scope, false).catch(() => {});
      }
      // The image MUST go along: the effect re-runs on a change of `active`, and `check` stays silent if the target state has not
      // changed — a left-over still image would then cover the view permanently with a photo from earlier.
      setStillFrame(null);
    };
  }, [bridge, scope, active]);

  const tabs = state.tabs;
  const tab = activeTab(state);
  // The address row follows the active tab as long as it is not being edited.
  useEffect(() => {
    if (!urlFocused) setUrlInput(addressText(tab?.url));
  }, [tab?.url, urlFocused]);

  const set = useCallback((p: Promise<NativeState>) => {
    void p.then((z) => { if (z) setState((old) => reduceState(old, z)); }).catch(() => {});
  }, []);

  if (!bridge) return null; // the switch in BrowserPane does not allow this — here only for completeness

  const navigate = () => {
    // The client loads what it gets: normalization happens HERE, with the backend's rule (lib/nav-url.ts, bound in
    // web/test/nav-url-binding.test.mjs).
    const url = normalizeNavUrl(urlInput);
    if (url) void bridge.navigate(scope, url).catch(() => {});
    urlRef.current?.blur();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-browser-native>
      {/* Tab bar — the same form as in the streamed pane */}
      <div className="flex items-center gap-1 border-b border-edge px-2 pt-1.5">
        <div className="cb-strip flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tb) => (
            <div
              key={tb.id}
              role="tab"
              aria-selected={tb.active}
              onClick={() => set(bridge.selectTab(scope, tb.id))}
              title={tb.url}
              className={`group relative flex max-w-[200px] min-w-[110px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2 py-1 pb-1.5 text-[12px] transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full ${
                tb.active ? "font-semibold text-accent after:bg-accent/70" : "font-medium text-dim after:bg-transparent hover:bg-hover hover:text-fg"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{tb.title || tb.url || t("New tab")}</span>
              <button
                onClick={(e) => { e.stopPropagation(); set(bridge.tabClose(scope, tb.id)); }}
                className="hidden h-4 w-4 shrink-0 place-items-center rounded text-dim hover:bg-edge hover:text-fg group-hover:grid"
                title={t("Close tab")}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
              </button>
            </div>
          ))}
          <button
            onClick={() => set(bridge.newTab(scope))}
            className="mb-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"
            title={t("New tab")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </div>
      {/* Navigation row — on the page with the hairline to the host surface below */}
      <div className={`flex items-center gap-1 px-2 py-1.5 ${page ? "border-b border-edge" : ""}`}>
        <button onClick={() => void bridge.back(scope).catch(() => {})} disabled={!tab?.canBack} className={navButton} title={t("Back")}>
          <NavIcon d="M15 6l-6 6 6 6" />
        </button>
        <button onClick={() => void bridge.forward(scope).catch(() => {})} disabled={!tab?.canForward} className={navButton} title={t("Forward")}>
          <NavIcon d="M9 6l6 6-6 6" />
        </button>
        {tab?.loading ? (
          <button onClick={() => void bridge.stop(scope).catch(() => {})} className={navButton} title={t("Stop loading")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        ) : (
          <button onClick={() => void bridge.reload(scope).catch(() => {})} disabled={!tab} className={navButton} title={t("Reload")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        )}
        <input
          ref={urlRef}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onFocus={(e) => { setUrlFocused(true); e.target.select(); }}
          onBlur={() => setUrlFocused(false)}
          onKeyDown={(e) => { if (e.key === "Enter") navigate(); }}
          placeholder={t("URL or search — e.g. localhost:3000")}
          className="ml-1 min-w-0 flex-1 rounded-full bg-bg px-3.5 py-1.5 font-mono text-[12px] outline-none transition-colors placeholder:text-dim focus:bg-panel focus:ring-1 focus:ring-accent/50"
          spellCheck={false}
        />
        <button
          onClick={() => { if (tab?.url) bridge.extern(tab.url); }}
          disabled={!tab?.url || tab.url === "about:blank"}
          className={`${navButton} shrink-0`}
          title={t("Open in system browser")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 4h6v6" />
            <path d="M20 4l-8 8" />
            <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
          </svg>
        </button>
        <button
          onClick={() => void bridge.devtools(scope, !state.devtools).catch(() => {})}
          disabled={!tab}
          aria-pressed={state.devtools}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors disabled:opacity-40 ${state.devtools ? "bg-edge text-fg" : "text-dim enabled:hover:bg-hover enabled:hover:text-fg"}`}
          title="DevTools"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 9l-4 3 4 3" />
            <path d="M16 9l4 3-4 3" />
            <path d="M13.5 6l-3 12" />
          </svg>
        </button>
      </div>
      {/* Notices: the client's error (no silent fallback to the stream) and the choice for a locally occupied port. */}
      {state.error && (
        <div className={hintMargin}><Hint tone="warn">{state.error}</Hint></div>
      )}
      {hint?.kind === "ambiguous" && (
        <div className={hintMargin}>
          <Hint tone="warn">
            <div className="flex flex-wrap items-center gap-2" data-browser-hint-ambiguous>
              <span className="min-w-0 flex-1">
                {t("Port {port} is running in several projects — which one should this tab open?", { port: String(hint.port) })}
              </span>
              {(hint.candidates ?? []).map((k) => (
                <button
                  key={k}
                  onClick={() => { void bridge.hintResponse(hint.id, `instance:${k}`).catch(() => {}); setHint(null); }}
                  className={ghostSm}
                >
                  {projectOfTheInstance(projects, k) || k}
                </button>
              ))}
              <button
                onClick={() => { void bridge.hintResponse(hint.id, "abort").catch(() => {}); setHint(null); }}
                className={ghostSm}
              >
                {t("Cancel")}
              </button>
            </div>
          </Hint>
        </div>
      )}
      {hint && hint.kind !== "ambiguous" && (
        <div className={hintMargin}>
          <Hint tone="warn">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                {t("Port {port} is already in use on this device{process}.", {
                  port: String(hint.port),
                  process: hint.process ? ` (${hint.process})` : "",
                })}
              </span>
              <button
                onClick={() => { void bridge.hintResponse(hint.id, "other-port").catch(() => {}); setHint(null); }}
                className={ghostSm}
              >
                {t("Use a different local port")}
              </button>
              <button
                onClick={() => { void bridge.hintResponse(hint.id, "abort").catch(() => {}); setHint(null); }}
                className={ghostSm}
              >
                {t("Cancel")}
              </button>
            </div>
          </Hint>
        </div>
      )}
      {/* The host surface: NO image here — the client lays its view over exactly this rectangle. The surface becomes visible only
          when an overlay has displaced the view (then the still image) or when there is no tab. */}
      <div ref={hostRef} data-browser-native-host className={`relative min-h-0 flex-1 overflow-hidden ${page ? "" : "mx-2 mb-2 rounded-xl bg-code"}`}>
        {stillFrame && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={stillFrame} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover object-left-top" />
        )}
        {!tabs.length && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-dim">
            {t("No tab open.")}
          </div>
        )}
      </div>
    </div>
  );
}

const navButton = "grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-40";

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
