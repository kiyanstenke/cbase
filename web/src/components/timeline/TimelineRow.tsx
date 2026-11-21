// One row of the timeline as a time line: clock time right-aligned · round node with the kind symbol on the vertical
// line · title. In the tab, the citation below in small type; everything else (description, anchor, tags, reason of
// dismissal) is carried by the detail card on hover (TimelineCard.tsx). A collective event has a node in the accent
// color and unfolds its parts (one level — smaller nodes on an own, indented line); a dismissed one has a dashed gray
// node and a struck-through title. Plus the sheet "Dismiss" (kit `Modal`, mandatory reason, error codes in words) and
// the sheet "Edit" (`RevisionSheet`): a new revision of title and text — no new event, the old revision stays visible.
//
// The citation is a button: a tool call or message of the main chat → the chat at the row (lib/rows-jump.ts), a
// subagent → the agent in the "Background Tasks" bar of its chat (lib/agent-jump.ts).
"use client";

import { useRef, useState } from "react";
import { Chevron, Menu, MenuEntry, Modal, ModalTitle, field, ghost, primary, quietDanger } from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import { timelineError, reviseTimelineEvent, dismissTimelineEvent, type TimelineEvent } from "@/lib/api";
import { KIND_FORM, clockTime } from "@/components/timeline/TimelineForm";
import { TIMELINE, nodeRole, linesChunks, type NodeRole } from "@/lib/timeline-bar";
import { Citation, type CardsPointer } from "@/components/timeline/TimelineCard";

type T = ReturnType<typeof useT>;

// The node per role; `open` = its card is showing (accent like a selection).
const NODE: Record<NodeRole, string> = {
  normal: "border-edge bg-transparent text-fg/70 hover:border-dim/60 hover:text-fg",
  collecting: "border-accent/55 bg-accent/10 text-accent hover:bg-accent/15",
  dismissed: "border-dashed border-dim/50 bg-transparent text-dim/70 hover:text-dim",
};
const PART_TOP = 4; // padding of a part row above and below its node
const NODE_OPEN = "border-accent bg-accent/12 text-accent";

/** The round node on the line: the kind symbol; click, Enter and visible focus show the card. */
function Node({ e, t, part, open, cardsId, pointer, row }: {
  e: TimelineEvent; t: T; part: boolean; open: boolean; cardsId: string; pointer: CardsPointer;
  row: React.RefObject<HTMLDivElement | null>;
}) {
  const form = KIND_FORM[e.kind];
  const role = nodeRole(e);
  const d = part ? TIMELINE.nodePart : TIMELINE.node;
  const word = role === "dismissed" ? t("{kind}, discarded", { kind: t(form.word) }) : role === "collecting" ? t("{kind}, collecting event", { kind: t(form.word) }) : t(form.word);
  return (
    <button
      type="button"
      aria-label={t("Details: {title}", { title: e.title || t("Untitled") })}
      aria-describedby={open ? cardsId : undefined}
      aria-expanded={open}
      title={word}
      data-timeline-kind={e.kind}
      data-timeline-node={role}
      onClick={() => row.current && pointer.click(e, row.current)}
      onFocus={(ev) => row.current && pointer.focus(e, ev, row.current)}
      onBlur={(ev) => pointer.focusLost(e, ev)}
      style={{ width: d, height: d }}
      className={`relative z-[1] grid shrink-0 place-items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${open ? NODE_OPEN : NODE[role]}`}
    >
      {form.icon(part ? 10 : 12)}
    </button>
  );
}

/** The body of a row — for top-level events as for parts: clock time · node · title (+ in the tab the citation). */
function Body({ e, t, compact, part, active, cardsId, pointer, right }: {
  e: TimelineEvent; t: T; compact: boolean; part: boolean; active: string | null; cardsId: string; pointer: CardsPointer; right?: React.ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const v = e.dismissed;
  const d = part ? TIMELINE.nodePart : TIMELINE.node;
  return (
    <div
      ref={row}
      className="group/row flex min-w-0 items-start"
      style={{ gap: TIMELINE.gap }}
      onPointerEnter={(ev) => pointer.enter(e, ev)}
      onPointerMove={(ev) => pointer.enter(e, ev)}
      onPointerLeave={() => pointer.out(e)}
      data-timeline-row={e.id}
    >
      {!part && (
        <span className="shrink-0 text-right text-[11.5px] tabular-nums leading-none text-dim" style={{ width: TIMELINE.clockTime, paddingTop: (d - 11) / 2 }}>
          {clockTime(e.at)}
        </span>
      )}
      <Node e={e} t={t} part={part} open={active === e.id} cardsId={cardsId} pointer={pointer} row={row} />
      <div className="min-w-0 flex-1" style={{ paddingTop: (d - 18) / 2 }}>
        <div className="flex min-w-0 items-start gap-2">
          <div
            data-timeline-title
            className={`min-w-0 flex-1 ${compact || part ? "truncate" : "line-clamp-2"} ${part ? "text-[12.5px]" : "text-[13px]"} font-medium leading-[18px] ${v ? "text-dim line-through decoration-dim" : "text-fg"}`}
          >
            {part && <span className="mr-1.5 font-normal tabular-nums text-dim">{clockTime(e.at)}</span>}
            {e.title || t("Untitled")}
          </div>
          {right}
        </div>
        {!compact && !part && (
          <div className={`mt-0.5 flex min-w-0 items-center gap-x-2 text-[11.5px] text-dim ${v ? "opacity-60" : ""}`}>
            <Citation e={e} t={t} />
            {v && <span className="shrink-0" data-timeline-dismissed={v.from}>· {v.from === "agent" ? t("Discarded by the agent") : t("Discarded by you")}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function DismissMenu({ e, t, onDismiss, onEdit }: { e: TimelineEvent; t: T; onDismiss?: (e: TimelineEvent) => void; onEdit?: (e: TimelineEvent) => void }) {
  if ((!onDismiss && !onEdit) || e.dismissed) return null;
  return (
    <span className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 has-[[aria-expanded=true]]:opacity-100">
      <Menu label={t("Actions for this event")} width={200} silent>
        {onEdit && <MenuEntry label={t("Edit …")} onClick={() => onEdit(e)} data={{ "data-timeline-action": "edit" }} />}
        {onDismiss && <MenuEntry label={t("Discard …")} danger onClick={() => onDismiss(e)} data={{ "data-timeline-action": "dismiss" }} />}
      </Menu>
    </span>
  );
}

/** A top-level row on the line: `first`/`last` of the day determine where the line ends; collective event expandable. */
export function TimelineRow({ e, compact, first, last, active, cardsId, pointer, onDismiss, onEdit }: {
  e: TimelineEvent;
  compact: boolean;
  first: boolean;
  last: boolean;
  /** The id of the event whose card is currently showing. */
  active: string | null;
  cardsId: string;
  pointer: CardsPointer;
  /** Absent in read-only (e.g. without project rights) — then no ⋯. */
  onDismiss?: (e: TimelineEvent) => void;
  /** New revision of title/text; absent ⇒ no entry. */
  onEdit?: (e: TimelineEvent) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const n = e.parts.length;
  const line = linesChunks(first, last);
  const nodeTop = TIMELINE.top;
  const nodeBottom = TIMELINE.top + TIMELINE.node;
  // The line of the parts: indented to below the title of the collective event, per part in two pieces as above.
  const partInset = TIMELINE.clockTime + TIMELINE.gap + TIMELINE.node + TIMELINE.gap;
  const partMiddle = TIMELINE.nodePart / 2 - 0.5;
  const right = (
    <>
      {n > 0 && (
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
          data-timeline-parts={n}
          className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-dim transition-colors hover:bg-hover hover:text-fg"
        >
          {t("{n} parts", { n })}
          <Chevron open={open} size={11} />
        </button>
      )}
      <DismissMenu e={e} t={t} onDismiss={onDismiss} onEdit={onEdit} />
    </>
  );
  return (
    <li className="relative" style={{ paddingTop: nodeTop, paddingBottom: nodeTop }} data-timeline-event={e.id}>
      {line.top && <span aria-hidden className="absolute w-px bg-edge" style={{ left: line.x - 0.5, top: 0, height: nodeTop }} />}
      {line.bottom && <span aria-hidden className="absolute bottom-0 w-px bg-edge" style={{ left: line.x - 0.5, top: nodeBottom }} data-timeline-line />}
      <Body e={e} t={t} compact={compact} part={false} active={active} cardsId={cardsId} pointer={pointer} right={right} />
      {open && n > 0 && (
        <ul className="relative mt-1.5" style={{ paddingLeft: partInset }} data-timeline-parts-list>
          {e.parts.map((part, i) => (
            <li key={part.id} className="relative" style={{ paddingTop: PART_TOP, paddingBottom: PART_TOP }} data-timeline-event={part.id} data-timeline-part>
              {i > 0 && <span aria-hidden className="absolute w-px bg-edge" style={{ left: partMiddle, top: 0, height: PART_TOP }} />}
              {i < n - 1 && <span aria-hidden className="absolute bottom-0 w-px bg-edge" style={{ left: partMiddle, top: PART_TOP + TIMELINE.nodePart }} />}
              <Body e={part} t={t} compact={compact} part active={active} cardsId={cardsId} pointer={pointer}
                right={<DismissMenu e={part} t={t} onDismiss={onDismiss} onEdit={onEdit} />} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The server's code in words of the sheet; an unknown one stays as the server's text. */
function errorSet(code: string | null, text: string, t: T): string {
  switch (code) {
    case "JUSTIFICATION": return t("Nothing can be discarded without a reason.");
    case "ALREADY_DISMISSED": return t("This event has already been discarded.");
    case "UNKNOWN": return t("This event does not exist in this project (anymore).");
    case "DISMISSED": return t("A discarded event gets no new version.");
    case "UNCHANGED": return t("Title and text are unchanged.");
    case "TOO_MANY": return t("This event already has too many versions.");
    case "BODY": return t("The server did not understand the request: {text}", { text });
    default: return text;
  }
}

/** The sheet "Dismiss": mandatory reason; the server answers with the dismissed event. */
export function DismissSheet({ projectId, event, onClose, onFinished }: {
  projectId: string;
  event: TimelineEvent;
  onClose: () => void;
  onFinished: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [sends, setSends] = useState(false);
  const [error, setError] = useState<{ code: string | null; set: string } | null>(null);
  const empty = !reason.trim();
  const send = async () => {
    if (empty || sends) return;
    setSends(true);
    setError(null);
    try {
      await dismissTimelineEvent(projectId, event.id, reason.trim());
      onFinished();
      onClose();
    } catch (e) {
      const f = timelineError(e);
      setError({ code: f.code, set: errorSet(f.code, f.text, t) });
    } finally {
      setSends(false);
    }
  };
  return (
    <Modal onClose={onClose} label={t("Discard event")} width={480}>
      <div data-timeline-dismiss={event.id}>
        <ModalTitle hint={t("The event stays visible, greyed out and with your reason — the timeline deletes nothing.")}>
          {t("Discard event")}
        </ModalTitle>
        <div className="mb-3 truncate text-[13px] font-medium text-fg">{event.title}</div>
        <label className="mb-1.5 block text-[12px] font-medium text-dim" htmlFor="timeline-dismiss-reason">{t("Reason")}</label>
        <textarea
          id="timeline-dismiss-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          rows={3}
          autoFocus
          placeholder={t("Why did this not happen, or why is it recorded wrongly?")}
          className={`${field} w-full resize-y`}
          data-timeline-dismiss-reason
        />
        <div className="mt-1 text-right text-[11px] tabular-nums text-dim">{reason.length}/500</div>
        {error && (
          <div className="mt-2 text-[12.5px] leading-relaxed text-danger" role="alert" data-timeline-dismiss-error={error.code ?? ""}>
            {error.set}{error.code ? <span className="ml-1.5 font-mono text-[11px] opacity-80">{error.code}</span> : null}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghost}>{t("Cancel")}</button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={empty || sends}
            title={empty ? t("A reason is required.") : undefined}
            className={`${quietDanger} disabled:cursor-not-allowed disabled:opacity-50`}
            data-timeline-dismiss-send
          >
            {sends ? t("Discarding …") : t("Dismiss")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The sheet "Edit": title and text prefilled with the current revision, reason free. Only the changed fields are sent;
 *  the server appends a new revision (no new event) and answers with the event. */
export function RevisionSheet({ projectId, event, onClose, onFinished }: {
  projectId: string;
  event: TimelineEvent;
  onClose: () => void;
  onFinished: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(event.title);
  const [text, setText] = useState(event.text);
  const [reason, setReason] = useState("");
  const [sends, setSends] = useState(false);
  const [error, setError] = useState<{ code: string | null; set: string } | null>(null);
  const newTitle = title.trim();
  const newText = text.trim();
  const changed = newTitle !== event.title || newText !== event.text;
  const possible = Boolean(newTitle) && changed && !sends;
  const send = async () => {
    if (!possible) return;
    setSends(true);
    setError(null);
    try {
      await reviseTimelineEvent(projectId, event.id, {
        ...(newTitle !== event.title ? { title: newTitle } : {}),
        ...(newText !== event.text ? { text: newText } : {}),
        ...(reason.trim() ? { justification: reason.trim() } : {}),
      });
      onFinished();
      onClose();
    } catch (e) {
      const f = timelineError(e);
      setError({ code: f.code, set: errorSet(f.code, f.text, t) });
    } finally {
      setSends(false);
    }
  };
  return (
    <Modal onClose={onClose} label={t("Edit event")} width={560}>
      <div data-timeline-revision-sheet={event.id}>
        <ModalTitle hint={t("A new version of title and text — the previous one stays visible in the detail card. Evidence, time and kind stay.")}>
          {t("Edit event")}
        </ModalTitle>
        <label className="mb-1.5 block text-[12px] font-medium text-dim" htmlFor="timeline-revision-title">{t("Title")}</label>
        <input id="timeline-revision-title" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 200))} autoFocus
          className={`${field} w-full`} data-timeline-revision-title />
        <div className="mt-1 text-right text-[11px] tabular-nums text-dim">{title.length}/200</div>
        <label className="mb-1.5 block text-[12px] font-medium text-dim" htmlFor="timeline-revision-text">{t("Description")}</label>
        <textarea id="timeline-revision-text" value={text} onChange={(e) => setText(e.target.value.slice(0, 4000))} rows={6}
          className={`${field} w-full resize-y`} data-timeline-revision-text />
        <div className="mt-1 text-right text-[11px] tabular-nums text-dim">{text.length}/4000</div>
        <label className="mb-1.5 block text-[12px] font-medium text-dim" htmlFor="timeline-revision-reason">{t("Reason (optional)")}</label>
        <input id="timeline-revision-reason" value={reason} onChange={(e) => setReason(e.target.value.slice(0, 500))}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          placeholder={t("What was wrong or unclear about the previous version?")} className={`${field} w-full`} data-timeline-revision-reason />
        {error && (
          <div className="mt-2 text-[12.5px] leading-relaxed text-danger" role="alert" data-timeline-revision-error={error.code ?? ""}>
            {error.set}{error.code ? <span className="ml-1.5 font-mono text-[11px] opacity-80">{error.code}</span> : null}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghost}>{t("Cancel")}</button>
          <button type="button" onClick={() => void send()} disabled={!possible} className={`${primary} disabled:cursor-not-allowed disabled:opacity-50`} data-timeline-revision-send>
            {sends ? t("Saving …") : t("Save new version")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
