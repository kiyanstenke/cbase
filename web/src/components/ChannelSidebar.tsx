"use client";

// "Channels" sidebar: the channels of a workspace in the right rail of the coding chat (next to GitLab and artifacts).
// Pure READ view, no input field: agents write into a channel; the user steers (pause, resume, cap, close, reopen a
// closed channel) and jumps into the chats.
//
// Two states in ONE column: the list (channels of the open chat first, then the rest of the workspace) and the log of a
// chosen channel with participants, state and a ⋯ menu.
// Live via the global event stream (`{type:"channel"}`), no polling of its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeGlobalEvents } from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { ChannelFiles, systemMarker, type ChannelCardData } from "@/components/ChannelCard";
import { channelWaitReason } from "@/lib/channel-card";
import { BackButton, Chevron, ic, Empty, Menu, MenuEntry, MenuSeparator } from "@/components/CbKit";
import { useConfirm, usePrompt } from "@/components/Prompts";
import { dateLocale, useT } from "@/lib/i18n";

export interface ChannelParticipant {
  chatId: string;
  participantKind: string;
  cursor: number;
  name: string;
  kind: string;
  /** Messages not yet DELIVERED to this participant (the agent's cursor). */
  unread: number;
  running: boolean;
  /** The chat is archived (delivery holds) or has an open question card.
   *  If the field is missing (older server), the wait reason is unknown and `channelWaitReason` returns the generic text. */
  archived?: boolean;
  questionOpen?: boolean;
}
export interface ChannelEntry {
  id: string;
  workspaceId: string;
  name: string;
  status: string;
  cap: number;
  agentsSinceHuman: number;
  pauseReason: string;
  creatorChatId: string | null;
  lastSeq: number;
  /** How far the USER has seen the log; the count on the row is computed against it. */
  readSeq: number;
  unreadUser: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number;
  participants: ChannelParticipant[];
  messages?: ChannelCardData[];
}

export const ChannelIcon = ({ size = 16 }: { size?: number }) => ic(<><path d="M4 6h11a4 4 0 0 1 4 4v1" /><path d="M20 18H9a4 4 0 0 1-4-4v-1" /><path d="M8 3 4 6l4 3" /><path d="m16 15 4 3-4 3" /></>, size);
const CodeIcon = () => ic(<><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m14 4-4 16" /></>, 12);
const CbIcon = ({ size = 11 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden>
    <path d="M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5z" />
  </svg>
);

// State in words and colour. Colour is a signal, not decoration: only "open" carries the accent,
// "paused" the warning colour; everything else is history and stays dimmed.
const STATE: Record<string, { word: string; kind: string }> = {
  open: { word: "Open##state", kind: "bg-accent-soft text-accent" },
  paused: { word: "Paused", kind: "bg-warn/15 text-warn" },
  waiting: { word: "Awaiting approval", kind: "bg-bg text-dim" },
  closed: { word: "Closed", kind: "bg-bg text-dim" },
  rejected: { word: "Rejected", kind: "bg-bg text-dim" },
};

function timeText(at?: number): string {
  if (!at) return "";
  const d = new Date(at);
  const today = new Date();
  const sameTag = d.toDateString() === today.toDateString();
  return sameTag
    ? d.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ChannelSidebar({ workspaceId, chatId, onlyRead = false }: {
  workspaceId: string;
  /** The open chat: its channels come first, and it is marked "this chat" in the participant rows. */
  chatId: string | null;
  /** Archived chat: reading yes, actions on the channel no. */
  onlyRead?: boolean;
}) {
  const t = useT();
  const ask = usePrompt();
  const question = useConfirm();
  const [list, setList] = useState<ChannelEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [log, setLog] = useState<ChannelEntry | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  // A channel the view opened on its own must not reopen right after "Back", or the list would never be
  // reachable. Auto-selection happens only ONCE per chat.
  const autoFor = useRef<string | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    const r = await api<{ items: ChannelEntry[] }>(`/api/workspaces/${workspaceId}/channels`);
    const items = Array.isArray(r.items) ? r.items : [];
    setList(items);
    return items;
  }, [workspaceId]);

  // The user's read mark: after the log loads it sits at the end, so the count on the row drops to zero,
  // in this and every other window (the server sends a channel event, the list reloads).
  const loadLog = useCallback(async (id: string) => {
    const k = await api<ChannelEntry>(`/api/channels/${id}`);
    setLog(k);
    if ((k.unreadUser ?? 0) > 0) {
      api(`/api/channels/${id}/read`, { method: "POST", body: JSON.stringify({ seq: k.lastSeq }) })
        .then(() => setList((cur) => (cur ?? []).map((x) => (x.id === id ? { ...x, readSeq: k.lastSeq, unreadUser: 0 } : x))))
        .catch(() => { /* the mark is a convenience, not a contract */ });
    }
    return k;
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadList().then((items) => {
      if (cancelled) return;
      // Auto-select: the open chat's channels are at the front; the first one opens if nothing is chosen yet.
      // For a chat without a channel the list stays.
      if (chatId && autoFor.current !== chatId) {
        autoFor.current = chatId;
        const ownChannel = items.find((k) => k.participants.some((p) => p.chatId === chatId));
        if (ownChannel && !selectedRef.current) setSelected(ownChannel.id);
      }
    }).catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [loadList, chatId]);

  useEffect(() => {
    if (!selected) { setLog(null); return; }
    let cancelled = false;
    setLog(null);
    loadLog(selected).catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [selected, loadLog]);

  // Live: every channel event of this workspace (new message, state, read mark) reloads the list, and the
  // log if it concerns the chosen channel. Patching per event type would be a third state machine over the same data.
  useEffect(() => {
    return subscribeGlobalEvents((evt) => {
      if (evt.type !== "channel") return;
      if (evt.workspaceId && evt.workspaceId !== workspaceId) return;
      loadList().catch(() => { /* the next event retries */ });
      const kid = typeof evt.channelId === "string" ? evt.channelId : "";
      if (kid && kid === selectedRef.current && !evt.read) loadLog(kid).catch(() => { /* s. o. */ });
    });
  }, [workspaceId, loadList, loadLog]);

  // The log sticks to the end: it reads like a conversation, newest at the bottom.
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [log?.lastSeq, log?.id]);

  // One can only jump into a coding chat (kind "normal"; an older server without a kind counts as one). A manager
  // conversation is in no chat list any more, so its participant row stays readable but without a jump.
  const jumpable = (p: ChannelParticipant) => p.chatId !== chatId && (!p.kind || p.kind === "normal");

  function jump(p: ChannelParticipant) {
    if (!jumpable(p)) return;
    // The bar only hangs in the coding chat: ChatPane handles the event.
    window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: p.chatId }));
  }

  async function action(k: ChannelEntry, what: "pause" | "resume" | "rounds" | "cap" | "close" | "open") {
    if (busy) return;
    setErr("");
    // Lock BEFORE the request, otherwise a double click sends two and the second
    // ("resume" on an already open channel) comes back as 409.
    setBusy(true);
    try {
      let fresh: ChannelEntry | null = null;
      if (what === "pause") fresh = await api<ChannelEntry>(`/api/channels/${k.id}/pause`, { method: "POST", body: JSON.stringify({ reason: "Users" }) });
      else if (what === "resume") fresh = await api<ChannelEntry>(`/api/channels/${k.id}/resume`, { method: "POST", body: JSON.stringify({}) });
      else if (what === "rounds") {
        const v = await ask(t("How many more rounds before the channel pauses again?"), String(k.cap || 8));
        if (v === null) return;
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1 || n > 1000) { setErr(t("Rounds: integer 1…1000")); return; }
        fresh = await api<ChannelEntry>(`/api/channels/${k.id}/resume`, { method: "POST", body: JSON.stringify({ rounds: n }) });
      } else if (what === "cap") {
        const v = await ask(t("Cap: agent rounds until the channel stops (0 = no cap)"), String(k.cap));
        if (v === null) return;
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 0 || n > 1000) { setErr(t("Cap: integer 0…1000")); return; }
        fresh = await api<ChannelEntry>(`/api/channels/${k.id}`, { method: "PATCH", body: JSON.stringify({ cap: n }) });
      } else if (what === "close") {
        if (!(await question(t("Close channel “{name}”? It delivers nothing afterwards until you reopen it here in the ⋯ menu.", { name: k.name }), { ok: t("Close"), danger: true }))) return;
        fresh = await api<ChannelEntry>(`/api/channels/${k.id}/close`, { method: "POST", body: JSON.stringify({ reason: "Users" }) });
      } else if (what === "open") {
        // The only way back from "closed": only the human reopens, in the channel bar. A rejected channel stays
        // closed; the server answers 409 there.
        fresh = await api<ChannelEntry>(`/api/channels/${k.id}/open`, { method: "POST", body: JSON.stringify({}) });
      }
      if (fresh) {
        setList((cur) => (cur ?? []).map((x) => (x.id === fresh!.id ? { ...x, ...fresh!, messages: undefined } : x)));
        await loadLog(k.id);
      }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const own = (list ?? []).filter((k) => chatId && k.participants.some((p) => p.chatId === chatId));
  const leftOver = (list ?? []).filter((k) => !own.includes(k));

  // One CARD per channel, in the form of the background tasks (AgentBar.tsx): surface `rounded-xl bg-panel` without
  // border, 6 px gap, name and arrow on top (arrow after the name, pointing right: the card leads into the log),
  // activity and unread on the right; below "Channel <state>" with the coloured state word instead of the pill and
  // the time of the last change, then the participants and the cap.
  const row = (k: ChannelEntry) => {
    const z = STATE[k.status] ?? { word: k.status, kind: "bg-bg text-dim" };
    const color = k.status === "open" ? "text-accent" : k.status === "paused" ? "text-warn" : "text-dim";
    const running = k.participants.some((p) => p.running);
    return (
      <button
        key={k.id}
        type="button"
        onClick={() => setSelected(k.id)}
        data-channel-row={k.id}
        className="cb-task-card block w-full overflow-hidden rounded-xl bg-panel px-3 pb-2.5 pt-2 text-left transition-colors hover:bg-hover"
      >
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-semibold text-fg">{k.name}</span>
          <span className="shrink-0 -rotate-90 text-dim"><Chevron open={false} size={11} /></span>
          <span className="flex-1" />
          {running && <span className="inline-flex shrink-0 animate-[spin_2.6s_linear_infinite] text-accent" title={t("A participant is working right now")}><CbIcon /></span>}
          {k.unreadUser > 0 && (
            <span data-channel-unread className="grid min-w-[18px] shrink-0 place-items-center rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-[18px] text-white">{k.unreadUser}</span>
          )}
        </span>
        <span className="mt-0.5 flex items-baseline gap-1.5 text-[11px]">
          <span className="shrink-0 text-dim">{t("Channel")}</span>
          <span className={`shrink-0 font-medium ${color}`} data-channel-status={k.status} title={t(z.word)}>{t(z.word)}</span>
          <span className="min-w-0 flex-1 truncate text-right tabular-nums text-dim">{timeText(k.updatedAt)}</span>
        </span>
        <span className="flex items-baseline gap-1.5 text-[11px] text-dim">
          <span className="min-w-0 flex-1 truncate">{k.participants.map((p) => p.name || t("unknown")).join(" ↔ ")}</span>
          {k.cap > 0 && (
            <span className="shrink-0 tabular-nums" title={t("{n} of {m} agent rounds since your last message", { n: k.agentsSinceHuman, m: k.cap })}>
              {k.agentsSinceHuman}/{k.cap}
            </span>
          )}
        </span>
      </button>
    );
  };

  // ── Log of a channel ──────────────────────────────────────────────────────
  if (selected) {
    const k = log ?? (list ?? []).find((x) => x.id === selected) ?? null;
    const z = k ? (STATE[k.status] ?? { word: k.status, kind: "bg-bg text-dim" }) : null;
    const controllable = k ? k.status === "open" || k.status === "paused" || k.status === "waiting" || k.status === "closed" : false;
    return (
      <section className="flex min-h-0 flex-1 flex-col" data-channel-log={selected}>
        <div className="flex items-center gap-1 px-2 pt-1.5">
          <BackButton label={t("Channels")} onClick={() => setSelected(null)} />
          <span className="min-w-0 flex-1" />
          {k && controllable && !onlyRead && (
            <Menu label={t("Channel actions")} width={224}>
              {k.status === "closed" && <MenuEntry label={t("Reopen")} hint={t("The chats can write to each other again")} onClick={() => action(k, "open")} disabled={busy} />}
              {k.status === "open" && <MenuEntry label={t("Pause")} hint={t("Nothing is delivered until you resume — messages are kept")} onClick={() => action(k, "pause")} disabled={busy} />}
              {k.status === "paused" && <MenuEntry label={t("Resume")} hint={k.cap > 0 ? t("Counter back to zero, cap stays") : undefined} onClick={() => action(k, "resume")} disabled={busy} />}
              {k.status === "paused" && <MenuEntry label={t("More rounds…")} hint={t("Resume with a new cap")} onClick={() => action(k, "rounds")} disabled={busy} />}
              {k.status !== "waiting" && k.status !== "closed" && <MenuEntry label={t("Change cap…")} hint={k.cap > 0 ? t("{n} rounds, then the channel stops", { n: k.cap }) : t("Currently without a cap")} onClick={() => action(k, "cap")} disabled={busy} />}
              {k.status !== "closed" && <MenuSeparator />}
              {k.status !== "closed" && <MenuEntry label={t("Close")} danger onClick={() => action(k, "close")} disabled={busy} />}
            </Menu>
          )}
        </div>
        {!k ? (
          <div className="p-6 text-center text-[12.5px] text-dim">{t("Loading…")}</div>
        ) : (
          <>
            <div className="px-3 pb-2 pt-1">
              <div className="flex items-center gap-1.5">
                <span className="text-accent"><ChannelIcon size={14} /></span>
                <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{k.name}</h3>
                <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold ${z!.kind}`} data-channel-status={k.status}>{t(z!.word)}</span>
              </div>
              <div className="mt-1 text-[11px] text-dim" data-channel-cap>
                {k.cap > 0
                  ? t("{n} of {m} agent rounds since your last message", { n: k.agentsSinceHuman, m: k.cap })
                  : t("No cap — the agents keep writing until you step in")}
                {k.status === "paused" && k.pauseReason ? ` · ${t("Paused")}: ${k.pauseReason}` : ""}
              </div>
              {/* Participants: one row each that jumps into the chat; the own one is marked and not
                  clickable. `unread` here is the AGENT's cursor: what has not been delivered to it yet;
                  `channelWaitReason` says why (run, archive, question, gate). */}
              <ul className="mt-2 flex flex-col gap-0.5">
                {k.participants.map((p) => {
                  const ownChannel = p.chatId === chatId;
                  const target = jumpable(p);
                  return (
                    <li key={p.chatId}>
                      <button
                        type="button"
                        disabled={!target}
                        onClick={() => jump(p)}
                        data-channel-participants={p.chatId}
                        title={ownChannel ? t("This chat") : target ? t("Back to chat") : undefined}
                        className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[12px] ${target ? "text-fg hover:bg-hover" : "text-dim"}`}
                      >
                        <span className="shrink-0 text-dim"><CodeIcon /></span>
                        <span className="min-w-0 flex-1 truncate">{p.name || t("unknown")}</span>
                        {p.running && <span className="inline-flex shrink-0 animate-[spin_2.6s_linear_infinite] text-accent"><CbIcon /></span>}
                        {p.unread > 0 && <span className="shrink-0 text-[10.5px] text-dim" title={t(channelWaitReason(p))}>{t("{n} pending", { n: p.unread })}</span>}
                        {ownChannel ? <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-dim">{t("this chat")}</span> : target && <Chevron open={false} size={11} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="cb-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {!k.messages ? (
                <div className="py-4 text-center text-[12px] text-dim">{t("Loading…")}</div>
              ) : k.messages.length === 0 ? (
                <div className="py-4 text-center text-[12px] text-dim">{t("No message in this channel yet.")}</div>
              ) : (
                <ol className="flex flex-col gap-2">
                  {k.messages.map((n) => {
                    const system = n.sender.kind === "system";
                    const own = !system && n.sender.chatId === chatId;
                    return (
                      <li key={n.seq} data-channel-message={n.seq} className={`rounded-xl px-2.5 py-2 ${system ? "bg-bg/60" : own ? "bg-accent-soft/40" : "bg-bg"}`}>
                        <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-dim">
                          {system
                            ? <span className="rounded-full bg-bg px-1.5 py-px font-semibold uppercase tracking-wide">{t(systemMarker(n.systemKind))}</span>
                            : <span className="truncate font-semibold text-fg">{n.sender.name || t("unknown")}{own ? ` · ${t("this chat")}` : ""}</span>}
                          <span className="ml-auto shrink-0 tabular-nums">#{n.seq} · {timeText(n.at)}</span>
                        </div>
                        <div className={`text-[12.5px] ${system ? "text-dim" : "text-fg"}`}><Markdown src={n.text} /></div>
                        {n.files && n.files.length > 0 && <ChannelFiles channelId={n.channelId} files={n.files} />}
                      </li>
                    );
                  })}
                </ol>
              )}
              <div ref={logEnd} />
            </div>
          </>
        )}
        {err && <div className="px-3 pb-2 text-[11.5px] text-danger">{err}</div>}
      </section>
    );
  }

  // ── List ────────────────────────────────────────────────────────────────
  return (
    <section className="cb-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3 pt-1" data-channel-list>
      {list === null ? (
        <div className="p-6 text-center text-[12.5px] text-dim">{t("Loading…")}</div>
      ) : list.length === 0 ? (
        <div className="px-2 pt-2">
          <Empty title={t("No channel yet")}>{t("A channel is created when an agent writes to another coding chat.")}</Empty>
        </div>
      ) : (
        <>
          {/* Two sections like "Running"/"Finished" of the background tasks: small uppercase head, cards below. */}
          {own.length > 0 && (
            <div className="space-y-1.5">
              <div className="px-0.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-dim">{t("Channels of this chat")}</div>
              {own.map(row)}
            </div>
          )}
          {leftOver.length > 0 && (
            <div className={`space-y-1.5 ${own.length ? "mt-3" : ""}`}>
              <div className="px-0.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-dim">{own.length ? t("Other channels of the workspace") : t("Channels of the workspace")}</div>
              {leftOver.map(row)}
            </div>
          )}
        </>
      )}
      {err && <div className="px-3 pt-2 text-[11.5px] text-danger">{err}</div>}
    </section>
  );
}

/** Number of a chat's channels and how many the user has not seen yet, for the pill and
 *  tab that also show with the rail CLOSED. Lives on the global stream, no polling. */
export function useChannelStatus(chatId: string | null, workspaceId: string): { n: number; unread: number } {
  const [status, setStatus] = useState({ n: 0, unread: 0 });
  useEffect(() => {
    if (!chatId) { setStatus({ n: 0, unread: 0 }); return; }
    let cancelled = false;
    const load = () => api<{ channels: { unreadUser?: number }[] }>(`/api/chats/${chatId}/channels`)
      .then((r) => {
        if (cancelled) return;
        const ks = Array.isArray(r.channels) ? r.channels : [];
        setStatus({ n: ks.length, unread: ks.reduce((a, k) => a + (k.unreadUser || 0), 0) });
      })
      .catch(() => { /* without a count the pill stays silent; the sidebar itself reports errors */ });
    load();
    const off = subscribeGlobalEvents((evt) => {
      if (evt.type === "channel" && (!evt.workspaceId || evt.workspaceId === workspaceId)) load();
    });
    return () => { cancelled = true; off(); };
  }, [chatId, workspaceId]);
  return status;
}
