"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";
import { useT, tr, dateLocale } from "@/lib/i18n";
import { useEdgeClamp } from "@/lib/viewport";

interface ServiceEvent {
  id: number;
  at: number;
  kind: "down" | "up" | "question" | "trigger" | "review" | "workflow" | string;
  name?: string;
  projectName?: string | null;
  workspaceId?: string | null;
  port?: number | null;
  title: string;
  body: string;
  chatId?: string | null;      // if set: a click opens this regular chat (workflow trigger)
  resolved?: boolean; // question/review: the card is closed (answered, answered via channel, dismissed)
}

const SEEN_KEY = "cbase-notif-seen"; // highest event id already seen (localStorage)

// Bell at the top right with a notification centre: shows the status-change history of the
// services (from the background monitor), unread ones as a badge. A click opens the list and
// marks everything as read.
export function NotificationBell() {
  const t = useT();
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  const [open, setOpen] = useState(false);
  // In narrow windows the trigger sits far left after the header wraps; without this
  // correction the right-anchored popover would extend past the left edge.
  const popRef = useEdgeClamp<HTMLDivElement>(open);
  const [seenId, setSeenId] = useState(0);
  const seenRef = useRef(0);

  useEffect(() => {
    const v = Number(localStorage.getItem(SEEN_KEY) || 0) || 0;
    seenRef.current = v;
    setSeenId(v);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/services/events?since=0`);
      if (!r.ok) return;
      const d: { events: ServiceEvent[] } = await r.json();
      setEvents((d.events ?? []).slice().reverse()); // newest first
    } catch {
      /* monitor possibly briefly unreachable */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const maxId = events.reduce((m, e) => Math.max(m, e.id), 0);
  const unread = events.filter((e) => e.id > seenId).length;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && maxId > seenRef.current) {
      // Opening marks everything as read.
      seenRef.current = maxId;
      setSeenId(maxId);
      localStorage.setItem(SEEN_KEY, String(maxId));
    }
  }

  async function clearAll() {
    try {
      await fetch(`${API_BASE}/api/services/events`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
    setEvents([]);
  }

  return (
    <span className="relative">
      <button
        onClick={toggle}
        title={t("Notifications")}
        className="relative grid h-8 w-8 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div data-overlay ref={popRef} className="absolute right-0 top-full z-50 mt-2 w-[min(360px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl cb-pop">
            <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
              <span className="text-[13px] font-bold tracking-tight">{t("Notifications")}</span>
              {events.length > 0 && (
                <button onClick={clearAll} className="text-[11px] font-medium text-dim hover:text-fg">
                  {t("Clear all")}
                </button>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {events.length === 0 ? (
                <div className="px-4 py-10 text-center text-[13px] text-dim">
                  {t("No notifications.")}
                  <div className="mt-1 text-[11px]">{t("Service outages and recoveries appear here.")}</div>
                </div>
              ) : (
                events.map((e) => {
                  const down = e.kind === "down";
                  // A requested review is a question to the human: same look, but its own icon; the
                  // run STANDS until answered.
                  // A RESOLVED question no longer prompts: the card is closed (answered, answered via
                  // a channel, or dismissed). It stays as an entry (the bell is a history), but
                  // without a prompt and without an accent.
                  const answered = (e.kind === "question" || e.kind === "review") && !!e.resolved;
                  const review = e.kind === "review" && !answered;
                  const ask = (e.kind === "question" || review) && !answered;
                  const fired = e.kind === "trigger" || e.kind === "workflow";
                  // Managing is gone: an old notification that pointed only at the manager page (manager chat,
                  // extraction, suggestion batch) carries no `chatId` and is no longer clickable; a jump to
                  // that page would land nowhere. The same holds for an old notification of the context
                  // agent (`agentChatId`, its chat in the orb dock): its jump target is in no list any more.
                  const clickable = !!e.chatId;
                  const openChat = () => {
                    setOpen(false);
                    if (e.chatId) window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: e.chatId }));
                  };
                  return (
                    <div
                      key={e.id}
                      onClick={clickable ? openChat : undefined}
                      data-notice-resolved={answered ? "1" : undefined}
                      className={`flex items-start gap-3 border-b border-edge px-4 py-2.5 last:border-b-0 ${clickable ? "cursor-pointer hover:bg-hover" : ""} ${answered ? "opacity-70" : ""}`}
                    >
                      <span
                        className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${
                          down ? "bg-danger/12 text-danger" : answered ? "bg-edge text-dim" : ask || fired ? "bg-accent/15 text-accent" : "bg-ok/15 text-ok"
                        }`}
                      >
                        {down ? <AlertIcon /> : answered ? <CheckIcon /> : review ? <ReviewIcon /> : fired ? <BoltIcon /> : ask ? <AskIcon /> : <CheckIcon />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-[12.5px] font-semibold">{e.title}</span>
                          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-dim">{fmtWhen(e.at)}</span>
                        </div>
                        <div className="line-clamp-2 text-[12px] text-dim">{e.body}</div>
                        {answered ? (
                          <div className="mt-0.5 text-[11px] font-medium text-dim">{t("Answered")}</div>
                        ) : clickable && <div className="mt-0.5 text-[11px] font-medium text-accent">{review ? t("Answer review →") : t("Open chat →")}</div>}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

// Person with a check mark: the same icon as the review node in the editor and the row in the chat.
function ReviewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 4 18.5V20" /><circle cx="9.5" cy="7.5" r="3.5" /><path d="m15.5 11 2.2 2.2L22 8.9" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8" />
    </svg>
  );
}

// Relative time ("3 min ago", "2 h ago") or the date for older entries.
function fmtWhen(ms: number) {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return tr("just now");
  if (min < 60) return tr("{min} min ago", { min });
  const h = Math.floor(min / 60);
  if (h < 24) return tr("{h} h ago", { h });
  return new Date(ms).toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" });
}

const svg = (children: React.ReactNode, size = 17) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const BellIcon = () => svg(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>);
const AlertIcon = () => svg(<><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>, 15);
const CheckIcon = () => svg(<path d="M20 6 9 17l-5-5" />, 15);
const AskIcon = () => svg(<><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /><circle cx="12" cy="12" r="10" /></>, 15);
