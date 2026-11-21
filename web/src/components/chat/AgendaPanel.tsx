"use client";
// The "Agenda" section of the right chat bar. The chat's agent keeps the agenda (cbase_agenda_write) — here it is only
// READ, live via the `harness/agenda` event (chat/chatAgenda.ts). No editing in the UI: what should change, the human
// tells the agent.
//
// A TREE of headings: on top the title (one line) with "done/total", below it ONE line per visible item — arrow (only
// with sub-items), status mark, text (truncated), "n/m" on items with sub-items, project label on top-level items and a
// small note mark when there is a note. Description and notes are NOT in the flow: the mark opens them as a `cb-pop`
// with Markdown as in the chat. There are no groups (In progress · Open · Done) — the tree in its order is the view;
// fully done subtrees start collapsed, the user toggles per item (remembered per device and chat, `useAgendaFold`).
//
// The shape is that of the flat app: ONE surface, no card per row, top-level items separated by hairlines. Width via
// container queries (`@container/agenda`), not the window — the bar is 280–640 px wide at any window size. The
// computations (visible rows, stages, folding, progress, empty, which version applies, "… ago") live in lib/agenda.ts
// and are tested there; the server computes the status of a top-level item, the bar only shows it.
//
// Marking of the agenda keeper: an item the built-in outer-loop agent created or moved forward carries a quiet accent
// ring around its status mark — the row stays ONE line, the ring is absolute and shifts nothing. The ring stays even if
// the main agent touches the item afterwards. The explanation ("Created by the agenda keeper · 4 min ago · afterwards
// taken back by the main agent") sits as `title` on the mark and as `sr-only` for screen readers.
//
// The PROOFS: an item that timeline events of this chat refer to (`agendaItemId`) carries the small timeline mark with
// their count on the right — nothing more. The mark opens the same `cb-pop` as a note, in it per event time and title;
// a click jumps to the place in the chat. Read via GET …/timeline/proofs (only with a project), reloaded on the
// project's `timeline` stream event. A jump from the timeline's detail card (lib/agenda-jump.ts) briefly highlights
// its item and scrolls it into view.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "@/components/Markdown";
import { Chevron, Hint, useFlat } from "@/components/CbKit";
import { agendaProgress, agendaEmpty, upkeepExplanation, sinceText, visibleRows, type AgendaRow } from "@/lib/agenda";
import { proofsPerItem, loadTimelineProofs, subscribeGlobalEvents, type AgendaStep, type TimelineEvent } from "@/lib/api";
import { TIMELINE_SYMBOL, clockTime } from "@/components/timeline/TimelineForm";
import { openChatRow } from "@/lib/rows-jump";
import { openAgent } from "@/lib/agent-jump";
import { agendaWish, agendaWishDone } from "@/lib/agenda-jump";
import { useAgenda, useAgendaFold } from "@/components/chat/chatAgenda";

type T = (key: string, params?: Record<string, string | number>) => string;

/** Indent per stage (at most three stages, `AGENDA_STAGES`). */
const INSET_PX = 12;
/** Width of the note sheet; less in a narrow window. */
const SHEET_WIDTH = 320;

// The clock for "updated … ago": redrawn once a minute, only while the section is mounted.
function useMinutesClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div data-agenda-empty className="grid min-h-0 flex-1 place-items-center px-7 text-center text-[12px] leading-relaxed text-dim">{children}</div>;
}

/** The mark before an item: accent dot (in progress), empty circle (open), check (done). */
function Marker({ status }: { status: AgendaStep["status"] }) {
  if (status === "in_work") return <span aria-hidden className="grid h-3 w-3 shrink-0 place-items-center"><span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)]" /></span>;
  if (status === "done") {
    return (
      <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-dim">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    );
  }
  return <span aria-hidden className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-dim/60" />;
}

/** The status mark of an item the agenda keeper created or set: the same mark with a quiet accent ring. The ring is
 *  absolute around the mark's 12 px — the row measures and aligns like any other. */
function UpkeepMarker({ status, explanation }: { status: AgendaStep["status"]; explanation: string }) {
  return (
    <span data-agenda-upkeep title={explanation} className="relative grid h-3 w-3 shrink-0 place-items-center">
      <Marker status={status} />
      <span aria-hidden className="pointer-events-none absolute -inset-[3px] rounded-full ring-1 ring-accent/60" />
      <span className="sr-only">{explanation}: </span>
    </span>
  );
}

const NoteCharacter = () => (
  <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 6h14M5 12h14M5 18h9" />
  </svg>
);

/**
 * The small mark behind which a note (or the description) sits, and its sheet: `cb-pop` on the body (portal), below the
 * mark at its right edge, upwards if there is no room below. Closed like the kit `Menu`: Escape, a press elsewhere
 * (document `mousedown` + `closest("[data-agenda-pop]")`, no `fixed inset-0` catcher), scrolling of an area carrying
 * the mark, and a window resize. A click INSIDE the sheet does not close — text is selected and copied there.
 */
function NoteButton({ label, identifier, header, markdown, footnote, character, count, content, kind = "note" }: {
  label: string; identifier: string; header?: string; markdown: string; footnote?: string;
  /** Instead of the note mark (the proofs: the timeline mark) with a count beside it, and own content instead of Markdown. */
  character?: React.ReactNode; count?: number; content?: React.ReactNode; kind?: "note" | "proofs";
}) {
  const [open, setOpen] = useState(false);
  const [situation, setSituation] = useState<React.CSSProperties | null>(null);
  const flat = useFlat();
  const buttonEl = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonEl.current?.focus({ preventScroll: true });
    };
    const beside = (e: MouseEvent) => {
      const pop = (e.target as Element | null)?.closest?.("[data-agenda-pop]") ?? null;
      if (pop !== buttonEl.current && pop !== sheet.current) setOpen(false);
    };
    const scrolled = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      if (sheet.current?.contains(el) || !el.contains(buttonEl.current)) return;
      setOpen(false);
    };
    const size = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", beside);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", size);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", beside);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", size);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) { setSituation(null); return; }
    const r = buttonEl.current?.getBoundingClientRect();
    const b = sheet.current?.getBoundingClientRect();
    if (!r || !b) return;
    const margin = 8;
    const width = Math.min(SHEET_WIDTH, window.innerWidth - 2 * margin);
    const left = Math.max(margin, Math.min(r.right - width, window.innerWidth - width - margin));
    const slotBottom = window.innerHeight - r.bottom - 4 - margin;
    const slotTop = r.top - 4 - margin;
    const upward = b.height > slotBottom && slotTop > slotBottom;
    setSituation(upward
      ? { left, width: width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(420, slotTop) }
      : { left, width: width, top: r.bottom + 4, maxHeight: Math.min(420, slotBottom) });
  }, [open]);

  return (
    <>
      <button
        ref={buttonEl}
        type="button"
        data-agenda-pop
        {...(kind === "proofs" ? { "data-agenda-proofs-button": identifier } : { "data-agenda-note-button": identifier })}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={`flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded-md px-0.5 transition-colors hover:bg-hover hover:text-fg ${open ? "bg-hover text-fg" : "text-dim"}`}
      >
        {character ?? <NoteCharacter />}
        {count != null && <span className="text-[10.5px] tabular-nums leading-none">{count}</span>}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={sheet}
          role="dialog"
          aria-label={label}
          data-agenda-pop
          {...(kind === "proofs" ? { "data-agenda-proofs": identifier } : { "data-agenda-note": identifier })}
          style={situation ?? { top: 0, left: 0, width: SHEET_WIDTH, visibility: "hidden" }}
          className={`cb-pop cb-pop-in-fast cb-kit fixed z-50 origin-top-right overflow-y-auto rounded-xl px-3.5 py-3 text-fg${flat}`}
        >
          {header && <div className="mb-1.5 text-[12.5px] font-semibold leading-snug">{header}</div>}
          {markdown.trim() && <div className="cb-chat-text text-[12.5px] leading-[1.65]"><Markdown src={markdown} /></div>}
          {content}
          {footnote && <div className="mt-2 text-[11px] text-dim">{footnote}</div>}
        </div>,
        document.body,
      )}
    </>
  );
}

/** The proofs of an item in the sheet: per event time · title; a click jumps to the place in the chat (subagent: its bar). */
function ProofsList({ proofs, t }: { proofs: TimelineEvent[]; t: T }) {
  return (
    <ul className="-mx-1 mt-0.5">
      {proofs.map((e) => {
        const f = e.citation;
        const sub = f.from.startsWith("subagent:") ? f.from.slice(9) : "";
        const row = Number(f.ref);
        const jump = !f.chatId ? null : sub ? () => openAgent(f.chatId!, sub) : Number.isFinite(row) && row > 0 ? () => openChatRow(f.chatId!, row) : null;
        return (
          <li key={e.id} data-agenda-proof={e.id}>
            <button type="button" disabled={!jump} onClick={jump ?? undefined} title={jump ? t("Jump to this point in the chat") : undefined}
              className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-hover disabled:hover:bg-transparent">
              <span className="shrink-0 text-[11px] tabular-nums text-dim">{clockTime(e.at)}</span>
              <span className={`min-w-0 flex-1 text-[12.5px] leading-snug ${e.dismissed ? "text-dim line-through decoration-dim" : "text-fg"}`}>{e.title || t("Untitled")}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Row({ z, t, now, onFold, proofs, highlight }: { z: AgendaRow; t: T; now: number; onFold: () => void; proofs?: TimelineEvent[]; highlight: boolean }) {
  const p = z.point;
  const upkeep = p.upkeep ? upkeepExplanation(p.upkeep, now) : null;
  const upkeepText = upkeep
    ? [t(upkeep.key, upkeep.prior ? { prior: t(upkeep.prior) } : undefined), upkeep.since ? t(upkeep.since.key, { n: upkeep.since.n }) : "",
      upkeep.afterwards ? t(upkeep.afterwards) : ""]
      .filter(Boolean).join(" · ")
    : "";
  const foldable = p.subitems > 0;
  const done = p.status === "done";
  const statusWord = p.status === "in_work" ? t("In progress") : done ? t("Done") : t("Open##state");
  const content = (
    <>
      <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center text-dim transition-transform duration-150 ${foldable ? "" : "invisible"} ${z.open ? "" : "-rotate-90"}`}>
        <Chevron open={false} size={10} />
      </span>
      {upkeep ? <UpkeepMarker status={p.status} explanation={upkeepText} /> : <Marker status={p.status} />}
      <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-snug @md/agenda:text-[13px] ${done ? "text-dim" : "text-fg"} ${foldable && p.depth === 0 ? "font-medium" : ""}`}>
        <span className="sr-only">{statusWord}: </span>
        {p.text}
      </span>
    </>
  );
  return (
    <li
      data-agenda-step={p.id}
      data-agenda-status={p.status}
      data-agenda-stage={z.stage}
      data-agenda-upkeep-kind={p.upkeep?.kind}
      data-agenda-upkeep-afterwards={p.upkeep?.afterwards ?? undefined}
      data-agenda-open={foldable ? String(z.open) : undefined}
      title={p.text}
      data-agenda-highlight={highlight ? "" : undefined}
      className={`flex items-center gap-1.5 py-[5px] transition-colors duration-700 ${highlight ? "rounded-md bg-accent/12" : ""} ${p.depth === 0 ? "border-t border-edge first:border-t-0" : ""}`}
      style={{ paddingLeft: z.stage * INSET_PX }}
    >
      {foldable ? (
        <button
          type="button"
          data-agenda-fold={p.id}
          aria-expanded={z.open}
          aria-label={`${z.open ? t("Collapse") : t("Expand")}: ${p.text}`}
          onClick={onFold}
          className="-my-0.5 flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-left transition-colors hover:bg-hover"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{content}</div>
      )}
      {foldable && (
        <span data-agenda-counter className="shrink-0 text-[11px] tabular-nums text-dim" aria-label={t("{done} of {total} done", { done: p.done, total: p.total })}>
          {p.done}/{p.total}
        </span>
      )}
      {p.depth === 0 && p.project?.name && (
        <span data-agenda-project={p.project.id} title={t("Project: {name}", { name: p.project.name })} className="max-w-[38%] shrink truncate rounded-full bg-hover px-1.5 py-px text-[10.5px] text-dim">
          {p.project.name}
        </span>
      )}
      {p.note.trim() && <NoteButton label={t("Show note")} identifier={p.id} header={p.text} markdown={p.note} />}
      {proofs && proofs.length > 0 && (
        <NoteButton kind="proofs" label={t("Evidence in the timeline: {n}", { n: proofs.length })} identifier={p.id} header={p.text} markdown=""
          character={TIMELINE_SYMBOL(12)} count={proofs.length} content={<ProofsList proofs={proofs} t={t} />} />
      )}
    </li>
  );
}

/** The proofs of this chat's agenda (header) — none without a project. An error leaves the agenda standing, just without marks. */
function useProofs(projectId: string | null, chatId: string): Map<string, TimelineEvent[]> {
  const [byKey, setByKey] = useState<Map<string, TimelineEvent[]>>(() => new Map());
  useEffect(() => {
    if (!projectId) { setByKey(new Map()); return; }
    let stale = false;
    const load = () => {
      loadTimelineProofs(projectId, chatId).then((r) => { if (!stale) setByKey(proofsPerItem(r.proofs)); }).catch(() => { /* without proofs: just no mark */ });
    };
    load();
    const off = subscribeGlobalEvents((evt) => { if (evt.type === "timeline" && String(evt.projectId ?? "") === projectId) load(); });
    return () => { stale = true; off(); };
  }, [projectId, chatId]);
  return byKey;
}

/** The highlighted item of a jump from the timeline (lib/agenda-jump.ts): picked up once it is in the agenda, for 2.4 s. */
function useHighlight(chatId: string, ids: readonly string[]): string | null {
  const [highlight, setHighlight] = useState<string | null>(null);
  const key = ids.join("\u0000");
  useEffect(() => {
    const w = agendaWish(chatId);
    if (!w || !ids.includes(w.pointId)) return;
    agendaWishDone(w);
    setHighlight(w.pointId);
    requestAnimationFrame(() => document.querySelector(`[data-agenda-step="${CSS.escape(w.pointId)}"]`)?.scrollIntoView({ block: "nearest" }));
    const h = setTimeout(() => setHighlight(null), 2400);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, key]);
  return highlight;
}

export function AgendaPanel({ t, chatId, projectId = null }: { t: T; chatId: string; projectId?: string | null }) {
  const { agenda, loaded, keepsAgenda, error } = useAgenda(chatId);
  const [deviations, flip] = useAgendaFold(chatId);
  const now = useMinutesClock();
  const proofs = useProofs(projectId, chatId);
  const highlight = useHighlight(chatId, agenda?.steps.map((p) => p.id) ?? []);

  if (!loaded) {
    return error
      ? <div className="px-3 pt-1"><Hint tone="warn">{t("The agenda could not be loaded: {error}", { error: error })}</Hint></div>
      : <Empty>{t("Loading …")}</Empty>;
  }
  if (!keepsAgenda) return <Empty>{t("This chat keeps no agenda — only coding chats have one.")}</Empty>;
  if (!agenda || agendaEmpty(agenda)) return <Empty>{t("No agenda yet. The model creates one as soon as it has a plan.")}</Empty>;

  const rows = visibleRows(agenda.steps, deviations);
  const f = agendaProgress(agenda);
  const since = sinceText(agenda.changedAt, now);
  const state = since ? t("updated {when}", { when: t(since.key, { n: since.n }) }) : undefined;
  const share = f.total ? Math.round((f.done / f.total) * 100) : 0;

  return (
    <div data-agenda data-agenda-version={agenda.version} className="@container/agenda cb-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="px-3 pb-5 pt-1 @md/agenda:px-4">
        {error && <div className="mb-2"><Hint tone="warn">{t("The agenda could not be loaded: {error}", { error: error })}</Hint></div>}
        <div className="flex items-center gap-1.5">
          <h3 data-agenda-title title={agenda.title} className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-snug text-fg @md/agenda:text-[15px]">{agenda.title}</h3>
          {agenda.description.trim() && <NoteButton label={t("Show description")} identifier="description" header={agenda.title.trim() || undefined} markdown={agenda.description} footnote={state} />}
          {f.total > 0 && (
            <span data-agenda-progress title={state} aria-label={t("{done} of {total} done", { done: f.done, total: f.total })} className="shrink-0 text-[11px] tabular-nums text-dim">
              {f.done}/{f.total}
            </span>
          )}
        </div>
        {f.total > 0 && (
          <div aria-hidden className="mt-2 h-[3px] overflow-hidden rounded-full bg-hover">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${share}%` }} />
          </div>
        )}
        {rows.length > 0 && (
          <ul data-agenda-tree className="mt-2">
            {rows.map((z) => <Row key={z.point.id} z={z} t={t} now={now} onFold={() => flip(z, agenda.steps)} proofs={proofs.get(z.point.id)} highlight={highlight === z.point.id} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
