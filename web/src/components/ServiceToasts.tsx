"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";
import { useT, dateLocale } from "@/lib/i18n";

// Status-change event of a service (from the background monitor).
interface ServiceEvent {
  id: number;
  at: number;
  kind: "down" | "up";
  key: string;
  name: string;
  projectId: string | null;
  projectName: string | null;
  workspaceId: string | null;
  port: number | null;
  title: string;
  body: string;
  native: boolean; // true = already delivered as a native macOS push, so no in-app toast
}

const AUTO_DISMISS_MS = 9000;

// In-app push at the top right (macOS look): shows service outages/recoveries while the app
// is in the foreground. If the app is not focused, the main process has shown the native macOS
// notification (event.native=true); those are hidden here.
export function ServiceToasts() {
  const t = useT();
  const [toasts, setToasts] = useState<ServiceEvent[]>([]);
  const sinceRef = useRef<number>(-1); // -1 = baseline not set yet
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const tm = timersRef.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timersRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const since = sinceRef.current < 0 ? 0 : sinceRef.current;
        const r = await fetch(`${API_BASE}/api/services/events?since=${since}`);
        if (!r.ok) return;
        const data: { events: ServiceEvent[] } = await r.json();
        const evs = data.events ?? [];
        if (!alive) return;
        const maxId = evs.reduce((m, e) => Math.max(m, e.id), sinceRef.current);
        if (sinceRef.current < 0) {
          // First pass: only set the baseline, do not toast historical events after the fact.
          sinceRef.current = maxId < 0 ? 0 : maxId;
          return;
        }
        sinceRef.current = maxId;
        const fresh = evs.filter((e) => !e.native); // native was already shown as a macOS push
        if (fresh.length) {
          setToasts((prev) => [...prev, ...fresh].slice(-4)); // at most 4 at a time
          for (const e of fresh) {
            if (timersRef.current.has(e.id)) continue;
            timersRef.current.set(e.id, setTimeout(() => dismiss(e.id), AUTO_DISMISS_MS));
          }
        }
      } catch {
        /* monitor possibly briefly unreachable; the next tick retries */
      }
    };
    poll();
    const t = setInterval(poll, 8000);
    // Check immediately on returning to the app (background tabs throttle the timer).
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timers = timersRef.current;
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      for (const tm of timers.values()) clearTimeout(tm);
      timers.clear();
    };
  }, [dismiss]);

  function openService(e: ServiceEvent) {
    dismiss(e.id);
    if (e.workspaceId) window.location.href = `/workspaces?ws=${encodeURIComponent(e.workspaceId)}`;
  }

  if (!toasts.length) return null;

  return (
    <div data-overlay className="pointer-events-none fixed right-4 top-24 z-[80] flex w-[min(340px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((e) => {
        const down = e.kind === "down";
        return (
          <div
            key={e.id}
            onClick={() => openService(e)}
            className="cb-pop pointer-events-auto flex cursor-pointer items-start gap-3 rounded-2xl p-3.5"
            style={{ animation: "cb-toast-in 220ms ease-out" }}
          >
            <span
              className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${
                down ? "bg-danger/12 text-danger" : "bg-ok/15 text-ok"
              }`}
            >
              {down ? <AlertIcon /> : <CheckIcon />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-semibold">{e.title}</span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-dim">{fmtTime(e.at)}</span>
              </div>
              <div className="mt-0.5 truncate text-[12.5px] text-dim">{e.body}</div>
            </div>
            <button
              onClick={(ev) => {
                ev.stopPropagation();
                dismiss(e.id);
              }}
              title={t("Close")}
              className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-dim hover:bg-hover hover:text-fg"
            >
              <XIcon />
            </button>
          </div>
        );
      })}
      <style>{`@keyframes cb-toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

const svg = (children: React.ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const AlertIcon = () => svg(<><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>);
const CheckIcon = () => svg(<path d="M20 6 9 17l-5-5" />);
const XIcon = () => svg(<><path d="M18 6 6 18" /><path d="M6 6l12 12" /></>, 13);
