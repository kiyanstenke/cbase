// The detail card of a timeline event. The row itself is terse (clock time · node · title); the card carries everything
// else: kind, full date and time, the title, the description (`text`, up to 4,000 characters, line breaks kept, scrolls
// from ~40% of the window height), the citation ("executed · <tool>" / "reported", chat title, "Subagent" — a button
// that jumps), the git anchor, the tags, the number of parts and, if dismissed, who dismissed it, when and why.
//
// WHEN (the timers of the commit card, lib/git-card.ts — the same times so both cards feel alike): only after
// CARD_DWELL_MS of rest on a row; if a card is open or just gone, the next one comes after CARD_SWITCH_MS. On leaving it
// stays CARD_GRACE_MS so the mouse can move in (the citation is a button); in the card it stays. A click on the node
// shows it immediately or closes it again (touch without hover, keyboard with Enter); visible focus on the node shows it
// after CARD_SWITCH_MS (`aria-describedby`). Escape, scrolling outside the card and a new window size close it.
// POSITION (lib/timeline-bar.ts `timelineCardsSituation`): in the right chat rail to the left of the list, in the tab
// below (else above) the row.
// On the body through a portal — the list scrolls and would cut a card off, and since Chromium 152 everything below the
// drag header inherits its `app-region` (Electron). No click catcher: the card closes through the listeners above, no
// surface lies over the whole window.
//
// Identifiers in title and text are links (`Chunks`, the chunks are computed by the server, timeline/references.js); the
// row "Links" names MR, commit and branch of the anchor in GitLab or GitHub and "Git overview" (the jump to Projects →
// Git with the branch as search); the row "Agenda" the agenda item with a jump into the agenda of its chat
// (lib/agenda-jump.ts); "revised" unfolds the earlier revisions; "Edit" opens the sheet of the new revision
// (TimelineRow.tsx `RevisionSheet`).
"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFlat } from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import type { TimelineEvent, TimelineRevision, TimelineChunk } from "@/lib/api";
import { openAgendaPoint } from "@/lib/agenda-jump";
import { showProjectGit } from "@/lib/project-jump";
import { openChatRow } from "@/lib/rows-jump";
import { openAgent } from "@/lib/agent-jump";
import { CARD_GRACE_MS, CARD_DWELL_MS, CARD_WARM_MS, CARD_SWITCH_MS } from "@/lib/git-card";
import { KIND_FORM, anchorParts, citationWord, subagentOf, timeFull } from "@/components/timeline/TimelineForm";
import { timelineCardsSituation, type CardsSituation } from "@/lib/timeline-bar";

type T = ReturnType<typeof useT>;

/** The citation as a button (or as text if there is no jump) — in the row of the tab and in the card. */
export function Citation({ e, t }: { e: TimelineEvent; t: T }) {
  const f = e.citation;
  const sub = subagentOf(f);
  const row = Number(f.ref);
  const jump = !f.chatId
    ? null
    : sub
      ? () => openAgent(f.chatId!, sub)
      : Number.isFinite(row) && row > 0 ? () => openChatRow(f.chatId!, row) : null;
  const parts = [
    f.kind === "tool" && f.tool ? `${t(citationWord(f))} · ${f.tool}` : t(citationWord(f)),
    ...(f.chatId ? [f.chatTitle || t("Untitled chat")] : []),
    ...(sub ? [t("Subagent")] : []),
  ];
  const text = parts.join(" · ");
  if (!jump) return <span className="min-w-0 truncate" data-timeline-citation={f.kind}>{text}</span>;
  return (
    <button
      type="button"
      onClick={jump}
      title={sub ? t("Show the subagent in its chat") : t("Jump to this point in the chat")}
      data-timeline-citation={f.kind}
      className="min-w-0 truncate rounded text-left underline decoration-edge underline-offset-2 transition-colors hover:text-fg hover:decoration-dim"
    >
      {text}
    </button>
  );
}

/** A title or text in chunks: identifiers with an address as a link (new tab), the rest as text. Without chunks the text itself. */
export function Chunks({ chunks, text }: { chunks: readonly TimelineChunk[] | null; text: string }) {
  if (!chunks) return <>{text}</>;
  return (
    <>
      {chunks.map((s, i) => (s.url
        ? <a key={i} href={s.url} target="_blank" rel="noreferrer" data-timeline-reference={s.kind ?? ""} onClick={(ev) => ev.stopPropagation()}
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{s.t}</a>
        : <span key={i}>{s.t}</span>))}
    </>
  );
}

const linkClass = "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent";

/** The links of the anchor: MR · commit · branch (external), Git overview (cbase). Empty ⇒ null. */
function Links({ e, t, workspaceId, projectId }: { e: TimelineEvent; t: T; workspaceId: string | null; projectId: string | null }) {
  const l = e.links;
  if (!l) return null;
  const a = e.anchor;
  const parts: React.ReactNode[] = [];
  const outside = (url: string | null, word: string, kind: string) => {
    if (url) parts.push(<a key={kind} href={url} target="_blank" rel="noreferrer" data-timeline-link={kind} className={linkClass}>{word}</a>);
  };
  outside(l.mr, a?.mrIid != null ? `!${a.mrIid}` : t("MR"), "mr");
  outside(l.commit, a?.sha ? a.sha.slice(0, 8) : t("Commit"), "commit");
  outside(l.branch, a?.branch ?? t("Branch"), "branch");
  if (l.gitView && workspaceId && projectId) {
    const ga = l.gitView;
    parts.push(
      <button key="gitView" type="button" data-timeline-link="gitView" className={linkClass}
        onClick={() => showProjectGit({ workspaceId, projectId, repo: ga.repo, search: ga.branch })}
        title={t("Show in the cbase Git overview")}>{t("Git overview")}</button>,
    );
  }
  if (!parts.length) return null;
  const location = l.repo?.web ? `${l.repo.provider === "github" ? "GitHub" : "GitLab"} · ${l.repo.name}` : null;
  return (
    <>
      <dt className="text-dim">{t("Links")}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-fg/85" data-timeline-links title={location ?? undefined}>
        {parts.flatMap((x, i) => (i ? [<span key={`p${i}`} aria-hidden className="text-dim">·</span>, x] : [x]))}
      </dd>
    </>
  );
}

/** The earlier revisions (unfoldable): per revision who, when, title, text and reason — newest first, without the current one. */
function Revisions({ revisions, t }: { revisions: readonly TimelineRevision[]; t: T }) {
  const [open, setOpen] = useState(false);
  if (revisions.length < 2) return null;
  const last = revisions[revisions.length - 1];
  const previous = revisions.slice(0, -1).reverse();
  return (
    <div className="border-t border-edge px-3.5 py-2 text-[12px]" data-timeline-revisions={revisions.length}>
      <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="flex w-full items-center gap-1.5 text-left text-dim transition-colors hover:text-fg">
        <span className="font-medium">{last.from === "human" ? t("Revised by you") : t("Revised by the agent")}</span>
        {last.at > 0 && <span className="tabular-nums">· {timeFull(last.at)}</span>}
        <span className="ml-auto shrink-0">{open ? t("Hide earlier versions") : t("{n} earlier versions", { n: previous.length })}</span>
      </button>
      {last.justification && <div className="mt-0.5 text-dim [overflow-wrap:anywhere]">{last.justification}</div>}
      {open && (
        <ol className="cb-scroll mt-1.5 flex max-h-[30vh] flex-col gap-2 overflow-y-auto">
          {previous.map((f, i) => (
            <li key={i} className="border-l border-edge pl-2.5" data-timeline-revision={f.from}>
              <div className="text-[11px] text-dim">
                {f.from === "human" ? t("by you") : t("by the agent")}{f.at > 0 && <span className="tabular-nums"> · {timeFull(f.at)}</span>}
                {i === previous.length - 1 && <span> · {t("first version")}</span>}
              </div>
              <div className="font-medium text-fg/85 [overflow-wrap:anywhere]">{f.title}</div>
              {f.text && <div className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-fg/70 [overflow-wrap:anywhere]">{f.text}</div>}
              {f.justification && <div className="mt-0.5 italic text-dim [overflow-wrap:anywhere]">{f.justification}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type Target = { e: TimelineEvent; anchor: HTMLElement; source: "maus" | "focus" | "click" };

/** The listeners of a row (enter/leave on the row body, click and focus on the node). */
export interface CardsPointer {
  enter: (e: TimelineEvent, ev: React.PointerEvent<HTMLElement>) => void;
  out: (e: TimelineEvent) => void;
  click: (e: TimelineEvent, anchor: HTMLElement) => void;
  focus: (e: TimelineEvent, ev: React.FocusEvent<HTMLElement>, anchor: HTMLElement) => void;
  focusLost: (e: TimelineEvent, ev: React.FocusEvent<HTMLElement>) => void;
}

/** The card with its timers. `lateral`: the narrow right chat rail (card to the left of the list). */
export function useTimelineCard({ lateral, projectId = null, workspaceId = null, onEdit }: {
  lateral: boolean;
  projectId?: string | null;
  workspaceId?: string | null;
  /** "Edit" in the card (new revision); absent ⇒ no button. */
  onEdit?: (e: TimelineEvent) => void;
}): { pointer: CardsPointer; active: string | null; id: string; card: React.ReactNode } {
  const id = `timeline-card-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [shown, setShown] = useState<Target | null>(null);
  const situation = useRef(shown);
  situation.current = shown;
  const showClock = useRef<number | null>(null);
  const hideClock = useRef<number | null>(null);
  const showFor = useRef<string | null>(null);
  const goneSince = useRef(0);
  const cardEl = useRef<HTMLDivElement>(null);

  const stopShow = useCallback(() => {
    if (showClock.current !== null) { window.clearTimeout(showClock.current); showClock.current = null; }
    showFor.current = null;
  }, []);
  const stopWay = useCallback(() => {
    if (hideClock.current !== null) { window.clearTimeout(hideClock.current); hideClock.current = null; }
  }, []);
  const hide = useCallback(() => {
    stopShow();
    stopWay();
    if (situation.current) goneSince.current = Date.now();
    setShown(null);
  }, [stopShow, stopWay]);
  const plane = useCallback((z: Target, ms: number) => {
    stopShow();
    showFor.current = z.e.id;
    showClock.current = window.setTimeout(() => { showClock.current = null; showFor.current = null; stopWay(); setShown(z); }, ms);
  }, [stopShow, stopWay]);
  const laterGone = useCallback(() => {
    if (hideClock.current === null && situation.current && situation.current.source !== "click") {
      hideClock.current = window.setTimeout(() => { hideClock.current = null; hide(); }, CARD_GRACE_MS);
    }
  }, [hide]);

  const pointer = useRef<CardsPointer | null>(null);
  const impl = useRef({ plane, hide, laterGone, stopShow, stopWay });
  impl.current = { plane, hide, laterGone, stopShow, stopWay };
  if (!pointer.current) {
    pointer.current = {
      enter: (e, ev) => {
        if (ev.buttons !== 0 || ev.pointerType === "touch") return; // a drag, or touch (there the click opens)
        const g = situation.current;
        if (g?.e.id === e.id) { impl.current.stopWay(); return; }
        if (showFor.current === e.id) return;
        const warm = g !== null || Date.now() - goneSince.current < CARD_WARM_MS;
        impl.current.plane({ e, anchor: ev.currentTarget, source: "maus" }, warm ? CARD_SWITCH_MS : CARD_DWELL_MS);
      },
      out: (e) => {
        if (showFor.current === e.id) impl.current.stopShow();
        impl.current.laterGone();
      },
      click: (e, anchor) => {
        impl.current.stopShow();
        impl.current.stopWay();
        if (situation.current?.e.id === e.id && situation.current.source === "click") { impl.current.hide(); return; }
        setShown({ e, anchor, source: "click" });
      },
      focus: (e, ev, anchor) => {
        const el = ev.target as HTMLElement;
        if (!el.matches?.(":focus-visible") || situation.current?.e.id === e.id) return;
        impl.current.plane({ e, anchor, source: "focus" }, CARD_SWITCH_MS);
      },
      focusLost: (e, ev) => {
        const next = ev.relatedTarget as Node | null;
        if (next && cardEl.current?.contains(next)) return;
        if (showFor.current === e.id) impl.current.stopShow();
        if (situation.current?.e.id === e.id && situation.current.source === "focus") impl.current.hide();
      },
    };
  }

  useEffect(() => () => { stopShow(); stopWay(); }, [stopShow, stopWay]);
  useEffect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      hide();
    };
    const scrolled = (e: Event) => {
      const el = e.target instanceof Node ? e.target : null;
      if (el && cardEl.current?.contains(el)) return;
      if (!el || el === document || (el instanceof Element && el.contains(shown.anchor))) hide();
    };
    // A press outside card and row closes a clicked card (touch has no "leave") — as a listener, not a click catcher.
    const press = (e: PointerEvent) => {
      const el = e.target instanceof Node ? e.target : null;
      if (!el || cardEl.current?.contains(el) || shown.anchor.contains(el)) return;
      hide();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("pointerdown", press, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("pointerdown", press, true);
      window.removeEventListener("resize", hide);
    };
  }, [shown, hide]);

  const card = shown && typeof document !== "undefined"
    ? createPortal(
      <Card key={shown.e.id} id={id} target={shown} lateral={lateral} cardEl={cardEl} onEnter={stopWay} onOut={laterGone}
        projectId={projectId} workspaceId={workspaceId} onEdit={onEdit ? (e) => { hide(); onEdit(e); } : undefined} />,
      document.body,
    )
    : null;
  return { pointer: pointer.current, active: shown?.e.id ?? null, id, card };
}

function Card({ id, target, lateral, cardEl, onEnter, onOut, projectId, workspaceId, onEdit }: {
  id: string; target: Target; lateral: boolean; cardEl: React.RefObject<HTMLDivElement | null>; onEnter: () => void; onOut: () => void;
  projectId: string | null; workspaceId: string | null; onEdit?: (e: TimelineEvent) => void;
}) {
  const t = useT();
  const flat = useFlat();
  const e = target.e;
  const form = KIND_FORM[e.kind];
  const anchor = anchorParts(e.anchor);
  const v = e.dismissed;
  const [situation, setSituation] = useState<CardsSituation | null>(null);
  // Measured after EVERY render (a narrow width re-breaks the description) — set only on change.
  useLayoutEffect(() => {
    const el = cardEl.current;
    if (!el) return;
    const z = target.anchor.getBoundingClientRect();
    const l = (target.anchor.closest("[data-timeline-list]") ?? target.anchor).getBoundingClientRect();
    const title = target.anchor.querySelector("[data-timeline-title]")?.getBoundingClientRect();
    const n = timelineCardsSituation(z, l, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight },
      { lateral, x: title ? title.left : z.left });
    setSituation((old) => (old && old.left === n.left && old.top === n.top && old.width === n.width && old.maxHeight === n.maxHeight && old.page === n.page ? old : n));
  });
  return (
    <div ref={cardEl} id={id} role="tooltip" data-timeline-card={e.id} data-timeline-card-page={situation?.page ?? ""}
      onPointerEnter={onEnter} onPointerLeave={onOut}
      style={situation ? { left: situation.left, top: situation.top, maxWidth: Math.min(440, situation.width), maxHeight: situation.maxHeight } : { left: 0, top: 0, visibility: "hidden" }}
      className={`cb-pop cb-fade-in-fast cb-kit fixed z-50 flex w-max min-w-[min(320px,calc(100vw-16px))] max-w-[440px] flex-col overflow-hidden rounded-xl text-[12.5px] leading-snug text-fg${flat}`}>
      <div className="flex min-h-0 flex-col gap-2 px-3.5 pb-3 pt-3">
        <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-dim">
          <span className={v ? "text-dim" : "text-accent"}>{form.icon(13)}</span>
          <span className="font-medium" data-timeline-card-kind={e.kind}>{t(form.word)}</span>
          {e.parts.length > 0 && <span>· {t("Collecting event")}</span>}
          <span className="ml-auto shrink-0 pl-3 tabular-nums" data-timeline-card-time={e.at}>{timeFull(e.at)}</span>
        </div>
        <div className={`text-[14px] font-medium leading-snug ${v ? "text-dim line-through decoration-dim" : "text-fg"}`} data-timeline-card-title>
          {e.title ? <Chunks chunks={e.references.title} text={e.title} /> : t("Untitled")}
        </div>
        {e.text
          ? (
            <div className="cb-scroll min-h-0 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg/85 [overflow-wrap:anywhere]"
              style={{ maxHeight: "min(40vh, 320px)" }} data-timeline-card-text><Chunks chunks={e.references.text} text={e.text} /></div>
          )
          : <div className="text-[12px] text-dim" data-timeline-card-text="">{t("No description.")}</div>}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 border-t border-edge px-3.5 py-2.5 text-[12px]">
        <dt className="text-dim">{t("Source")}</dt>
        <dd className="flex min-w-0 text-fg/85"><Citation e={e} t={t} /></dd>
        {anchor.length > 0 && (
          <>
            <dt className="text-dim">{t("Git anchor")}</dt>
            <dd className="min-w-0 truncate font-mono text-[11.5px] text-fg/85" data-timeline-anchor>{anchor.join(" · ")}</dd>
          </>
        )}
        <Links e={e} t={t} workspaceId={workspaceId} projectId={projectId} />
        {e.agendaItem && (
          <>
            <dt className="text-dim">{t("Agenda")}</dt>
            <dd className="flex min-w-0 text-fg/85" data-timeline-agenda={e.agendaItem.id}>
              {e.agendaItem.chatId && e.agendaItem.text !== null
                ? (
                  <button type="button" onClick={() => openAgendaPoint(e.agendaItem!.chatId!, e.agendaItem!.id)} title={t("Show in the chat's agenda")}
                    className="min-w-0 truncate rounded text-left underline decoration-edge underline-offset-2 transition-colors hover:text-fg hover:decoration-dim">
                    {e.agendaItem.text || e.agendaItem.id}
                  </button>
                )
                : <span className="min-w-0 truncate text-dim">{t("Item {id} (no longer in the agenda)", { id: e.agendaItem.id })}</span>}
            </dd>
          </>
        )}
        {e.tags.length > 0 && (
          <>
            <dt className="text-dim">{t("Tags")}</dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {e.tags.map((w) => (
                <span key={w} className="rounded-full bg-hover px-1.5 py-px text-[10.5px] text-dim" data-timeline-word={w}>{w}</span>
              ))}
            </dd>
          </>
        )}
        {e.parts.length > 0 && (
          <>
            <dt className="text-dim">{t("Parts")}</dt>
            <dd className="min-w-0 text-fg/85">{t("{n} parts", { n: e.parts.length })}</dd>
          </>
        )}
      </dl>
      <Revisions revisions={e.revisions} t={t} />
      {onEdit && !v && (
        <div className="flex justify-end border-t border-edge px-3.5 py-2">
          <button type="button" onClick={() => onEdit(e)} className="text-[12px] font-medium text-dim transition-colors hover:text-fg" data-timeline-edit={e.id}>
            {t("Edit …")}
          </button>
        </div>
      )}
      {v && (
        <div className="border-t border-edge px-3.5 py-2.5 text-[12px] leading-relaxed text-dim" data-timeline-dismissed={v.from}>
          <span className="font-medium text-fg/85">{v.from === "agent" ? t("Discarded by the agent") : t("Discarded by you")}</span>
          {v.at > 0 && <span className="tabular-nums"> · {timeFull(v.at)}</span>}
          {v.justification && <div className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{v.justification}</div>}
        </div>
      )}
    </div>
  );
}
