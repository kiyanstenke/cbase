// The timeline of a project — ONE component for two places:
//   - large as the tab "Timeline" of the project view (projects/ProjectsPane.tsx): header with the project toggle, filters
//     kind (kit `Segments`), chat (kit `Menu`) and tag (kit `Search`), "Load older" through `further`;
//   - `compact` as the section "Timeline" of the right chat rail (chat/ChatRightSidebar.tsx, only for a chat with a
//     project): without filters and toggle, the latest events, below "Show all" → the tab (lib/project-jump.ts).
// The list is a vertical timeline: newest on top, day dividers in the browser's wall time, per event a round node with a
// kind symbol on a vertical line (TimelineRow.tsx), details in the card on hover (TimelineCard.tsx); no surface around
// the list.
// The stream: `timeline` `{ projectId }` (server timeline/agent.js `reportTimeline`, after every write) reloads — as many
// as are currently shown.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hint, Header, Menu, MenuEntry, Toggle, Segments, Search, select } from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import {
  TIMELINE_KINDS, loadTimeline, setTimelineActive, subscribeGlobalEvents, timelineError,
  type TimelineKind, type TimelineEvent, type TimelinePage,
} from "@/lib/api";
import { KIND_FORM, byDays, dayWord } from "@/components/timeline/TimelineForm";
import { RevisionSheet, TimelineRow, DismissSheet } from "@/components/timeline/TimelineRow";
import { useTimelineCard } from "@/components/timeline/TimelineCard";

const PAGE = 50;
const PAGE_COMPACT = 25;
const CAP = 200; // server cap per page

export function Timeline({ projectId, workspaceId = null, compact = false, onEverything }: {
  projectId: string;
  /** For the jump "Git overview" from the detail card; absent ⇒ no such link. */
  workspaceId?: string | null;
  compact?: boolean;
  /** `compact` only: "Show all" leads into the tab of the project view. */
  onEverything?: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<TimelineKind | "">("");
  const [chat, setChat] = useState("");
  const [wordInput, setWordInput] = useState("");
  const [word, setWord] = useState("");
  const [page, setPage] = useState<TimelinePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [toggles, setToggles] = useState(false);
  const [dismiss, setDismiss] = useState<TimelineEvent | null>(null);
  const [edit, setEdit] = useState<TimelineEvent | null>(null);
  // The chats that ever appeared in a loaded page — the chat filter choice does not lose them when a filter hides them.
  const chats = useRef(new Map<string, string>());
  const [chatList, setChatList] = useState<[string, string][]>([]);
  // Only the latest request writes (a filter change overtakes a slow one).
  const request = useRef(0);
  const shown = useRef(0);
  // The detail card on hover (TimelineCard.tsx) — ONE per list, in the rail to the left beside it.
  const card = useTimelineCard({ lateral: compact, projectId, workspaceId, onEdit: setEdit });

  const rememberChats = useCallback((list: readonly TimelineEvent[]) => {
    let fresh = false;
    for (const e of list) for (const x of [e, ...e.parts]) {
      const id = x.citation.chatId;
      if (!id) continue;
      const title = x.citation.chatTitle || "";
      if (chats.current.get(id) !== title) { chats.current.set(id, title); fresh = true; }
    }
    if (fresh) setChatList([...chats.current.entries()]);
  }, []);

  const filter = compact ? {} : { kind: kind || null, chat: chat || null, word: word || null };
  const filterKey = `${projectId}|${filter.kind ?? ""}|${filter.chat ?? ""}|${filter.word ?? ""}`;

  // First page — `count` keeps the shown length when reloading for an event.
  const load = useCallback(async (count?: number) => {
    const seq = ++request.current;
    const limit = Math.min(CAP, Math.max(compact ? PAGE_COMPACT : PAGE, count ?? 0));
    try {
      const s = await loadTimeline(projectId, { ...filter, limit });
      if (seq !== request.current) return;
      setPage(s);
      shown.current = s.events.length;
      rememberChats(s.events);
      setError(null);
    } catch (e) {
      if (seq !== request.current) return;
      setError(timelineError(e).text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, compact, rememberChats]);

  useEffect(() => {
    setPage(null);
    void load();
  }, [load]);

  useEffect(() => subscribeGlobalEvents((evt) => {
    if (evt.type === "timeline" && String(evt.projectId ?? "") === projectId) void load(shown.current);
  }), [projectId, load]);

  const more = async () => {
    if (!page?.further || moreLoading) return;
    const seq = request.current;
    setMoreLoading(true);
    try {
      const s = await loadTimeline(projectId, { ...filter, until: page.further, untilId: page.continueId, limit: compact ? PAGE_COMPACT : PAGE });
      if (seq !== request.current) return;
      setPage((old) => {
        if (!old) return s;
        const present = new Set(old.events.map((e) => e.id));
        const events = [...old.events, ...s.events.filter((e) => !present.has(e.id))];
        shown.current = events.length;
        return { active: s.active, events, further: s.further, continueId: s.continueId };
      });
      rememberChats(s.events);
    } catch (e) {
      setError(timelineError(e).text);
    } finally {
      setMoreLoading(false);
    }
  };

  const toggle = async () => {
    if (!page || toggles) return;
    const target = !page.active;
    setToggles(true);
    setPage({ ...page, active: target });
    try {
      const active = await setTimelineActive(projectId, target);
      setPage((old) => (old ? { ...old, active } : old));
      setError(null);
    } catch (e) {
      setPage((old) => (old ? { ...old, active: !target } : old));
      setError(timelineError(e).text);
    } finally {
      setToggles(false);
    }
  };

  const filtered = !compact && Boolean(kind || chat || word);
  const days = page ? byDays(page.events) : [];

  const list = (
    <div className={`cb-scroll min-h-0 flex-1 overflow-y-auto ${compact ? "px-3 pb-3" : "pr-2"}`} data-timeline-list>
      {error && <div className="mb-3"><Hint tone="danger">{error}</Hint></div>}
      {!page ? (
        !error && <div className="py-6 text-[12.5px] text-dim">{t("Loading…")}</div>
      ) : page.events.length === 0 ? (
        <div className={`${compact ? "py-6" : "border-t border-edge py-10"} text-[13px] leading-relaxed text-dim`} data-timeline-empty>
          {filtered
            ? t("No event matches the filter.")
            : !page.active
              ? t("The timeline is off for this project.")
              : t("No events yet. The timeline agent records what actually happened in this project's chats.")}
        </div>
      ) : (
        <>
          {days.map((g, i) => (
            <section key={g.day} data-timeline-day={g.day}>
              <h4 className={`pb-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-dim ${i === 0 ? "" : "pt-4"}`}>{dayWord(g.at, t)}</h4>
              <ul>
                {g.events.map((e, j) => (
                  <TimelineRow key={e.id} e={e} compact={compact} first={j === 0} last={j === g.events.length - 1}
                    active={card.active} cardsId={card.id} pointer={card.pointer} onDismiss={setDismiss} onEdit={setEdit} />
                ))}
              </ul>
            </section>
          ))}
          {page.further != null && !compact && (
            <div className="border-t border-edge py-3">
              <button type="button" onClick={() => void more()} disabled={moreLoading} className="text-[12.5px] font-medium text-dim transition-colors hover:text-fg disabled:opacity-50" data-timeline-more>
                {moreLoading ? t("Loading…") : t("Load older")}
              </button>
            </div>
          )}
          {compact && onEverything && (
            <div className="border-t border-edge pt-2.5">
              <button type="button" onClick={onEverything} className="text-[12px] font-medium text-accent transition-opacity hover:opacity-80" data-timeline-everything>
                {t("Show all")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );

  const sheet = (
    <>
      {dismiss && <DismissSheet projectId={projectId} event={dismiss} onClose={() => setDismiss(null)} onFinished={() => void load(shown.current)} />}
      {edit && <RevisionSheet projectId={projectId} event={edit} onClose={() => setEdit(null)} onFinished={() => void load(shown.current)} />}
    </>
  );

  if (compact) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-timeline={projectId} data-timeline-compact>
        {page && !page.active && page.events.length > 0 && (
          <div className="px-3 pb-2 text-[11.5px] text-dim">{t("The timeline is off for this project.")}</div>
        )}
        {list}
        {sheet}
        {card.card}
      </div>
    );
  }

  const chatWord = chat ? (chats.current.get(chat) || t("Untitled chat")) : t("All chats");
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-timeline={projectId}>
      <Header
        title={t("Timeline")}
        hint={t("What actually happened in this project — backed by a source in a chat.")}
        className="pb-4"
      >
        <span className="text-[12px] text-dim">{page?.active === false ? t("Off") : t("On")}</span>
        <span data-timeline-toggle={page?.active === false ? "off" : "on"}>
          <Toggle
            on={page?.active !== false}
            onClick={() => void toggle()}
            disabled={!page || toggles}
            title={page?.active === false ? t("Turn the timeline on for this project") : t("Turn the timeline off for this project — the agent will then record nothing")}
          />
        </span>
      </Header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3" data-timeline-filter>
        <Segments
          label={t("Type")}
          value={kind || "all"}
          onChange={(k) => setKind(k === "all" ? "" : (k as TimelineKind))}
          items={[
            { key: "all", label: t("All") },
            ...TIMELINE_KINDS.map((a) => ({ key: a, label: t(KIND_FORM[a].word), data: { "data-timeline-filter-kind": a } as Record<`data-${string}`, string> })),
          ]}
          className="min-w-0 max-w-full"
        />
        <Menu
          label={t("Chat: {chat}", { chat: chatWord })}
          width={260}
          alignment="left"
          shrinks
          button={{ content: <span className="block max-w-[200px] truncate">{chatWord}</span>, className: select, data: { "data-timeline-filter-chat": chat } }}
        >
          <MenuEntry label={t("All chats")} selected={!chat} onClick={() => setChat("")} />
          {chatList.map(([id, title]) => (
            <MenuEntry key={id} label={title || t("Untitled chat")} selected={chat === id} onClick={() => setChat(id)} />
          ))}
        </Menu>
        <Search
          value={wordInput}
          onChange={(v) => { setWordInput(v); if (!v) setWord(""); }}
          onSubmit={() => setWord(wordInput.trim().toLowerCase())}
          placeholder={t("Keyword (Enter)")}
          className="w-[200px] max-w-full"
        />
      </div>
      {list}
      {sheet}
      {card.card}
    </div>
  );
}
