"use client";
// The card of ONE background graph workflow in the "Background Tasks" list (AgentBar).
//
// The shape is that of the workflow card (chat/DynWorkflowTree.tsx `DynWorkflowCard`): ONE `rounded-xl bg-panel` surface
// without a border, the head with title and chevron, runtime and stop on the right (the same `SymbolButton`); below it
// "Graph workflow <state word>" in the tone's colour, with a warning dot while the run waits for the human, the reason or
// step on the right ("3/7: Implement"); below that the worktree path and "Open". Expanded, it shows the start's input.
//
// Not computed here: title, state word, tone, warning dot, second row, worktree and stop come from `cardOf`
// (lib/graph-runs.ts, bound to iOS), the target of "Open" from `childChatOf`, the runtime from `graphDurationMs`, the
// response form from `card.response` (= `responseForm`) and the request from `responseRequest`.
//
// The response: expanded, a `data-graph-response` section above the input has the form of the wait kind: question node
// (free text), review (OK, comments), round cap (Continue, N more, Finish), completion check and halted (Continue,
// instruction), a step's question card (one button per option, multiple choice per `multiSelect`, plus an own answer),
// the permission (Allow, Deny, with tool and shortened input) and the approval of a dynamic workflow (Accept, Deny).
// Above the form sits `wait.question`, wrapped and shortened with "more". Sending goes through `onResponse`
// (`useGraphRuns.respondGraph`) to the CHILD chat; which input a request yields, and with it whether "Send" is enabled
// (an empty free text is not), is decided by `responseRequest` alone. The buttons are locked while a response is in
// flight and, after an accepted one, until the next state (`updatedAt`) that `graph_run` brings; otherwise a double
// click would send "continue" twice. After 2xx the field is cleared. "No longer open" (409, or `ok: false` of the
// permission: another device already answered) shows as the hint `data-graph-response-hint` in the card, and the hook
// reloads the state; every other error is the line `data-graph-response-error`.
//
// "Open" shows the CHILD chat via `cbase-open-chat`, the path of the bell and the channel bar (ChatPane `openTarget` with
// `openOtherwise`); the child chat is in no chat list, and `openTargetProcedure` (lib/archive.ts) sets its metadata even
// without `archivedAt` when `parentChatId` is set, so the composer stays open. Stop goes to the chat of the START
// (`POST .../graph-workflows/:startId/stop { from: "human" }`, via `useGraphRuns.stopGraphStart`, which reloads after an
// error); the end state comes from the `graph_run` event.
//
// Hooks: data-bg-task="graph:<startId>" (like every card of the list), data-graph-card (the startId), data-graph-state
// (the id), data-graph-tone, data-open; inside it data-graph-header (the head's button), data-graph-title,
// data-graph-duration, data-graph-stop, data-graph-word, data-graph-warning-dot, data-graph-row2, data-graph-worktree,
// data-graph-open, data-graph-input, data-graph-error; data-graph-response (the wait kind), inside it
// data-graph-question, data-graph-tool, data-graph-tool-input, data-graph-dyn, data-graph-ask-question (index),
// data-graph-option (label, with data-on), data-graph-button (the button's id), data-graph-remaining-count, data-graph-text,
// data-graph-send, data-graph-response-hint, data-graph-response-error, data-graph-more.
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Chevron } from "@/components/CbKit";
import { SymbolButton } from "@/components/chat/DynWorkflowTree";
import { SpinnerIcon, StopSquareIcon } from "@/components/chat/ChatIcons";
import { elapsed } from "@/lib/agents";
import { graphKey } from "@/lib/background-tasks";
import type { GraphResponseError } from "@/components/chat/chatGraphRuns";
import {
  responseRequest, graphDurationMs, cardOf, childChatOf, MORE_MAX, MORE_DEFAULT,
  type GraphRequest, type GraphResponseForm, type GraphInput, type GraphRunView, type GraphTone,
} from "@/lib/graph-runs";

// The colour of the state word per tone: the same steps as the head of the workflow card (running blue, done green, error
// red, otherwise muted) plus the warning for "waits for you".
const TONE_COLOR: Readonly<Record<GraphTone, string>> = {
  running: "text-accent",
  waiting: "text-warn",
  quiet: "text-dim",
  finished: "text-ok",
  error: "text-danger",
  muted: "text-dim",
};

/** The card. `chatId` is the chat of the START (orchestrator), `now` the bar's one-second tick; `onStop` is absent where
 *  there is no stop (then no button is shown). */
export function GraphRunCard({ chatId, run, now, onStop, onResponse }: {
  chatId: string | null;
  run: GraphRunView;
  now: number;
  onStop?: (startId: string) => Promise<void>;
  /** The response in the card: if absent, the form is shown but locked, since nothing could go out. */
  onResponse?: (request: GraphRequest) => Promise<void>;
}) {
  const t = useT();
  const card = cardOf(run);
  // While the run waits for the human, the card is open: it shows what the human needs to know (the response).
  const [isOpen, setOpen] = useState(Boolean(card?.warningDot));
  const [stops, setStops] = useState(false);
  const [error, setError] = useState("");
  const warns = Boolean(card?.warningDot);
  useEffect(() => { if (warns) setOpen(true); }, [warns]);
  const stoppable = Boolean(card?.stop);
  useEffect(() => { if (!stoppable) setStops(false); }, [stoppable]);
  if (!card) return null;

  const childChat = childChatOf(run, chatId);
  const duration = graphDurationMs(run, now);
  const title = card.title || t("Graph workflow");

  async function stop() {
    if (!onStop) return;
    setStops(true);
    setError("");
    try {
      await onStop(run.startId);
      // The card shows the end state from the event (`graph_run`) or the response, not from an assumption of its own.
    } catch (e) {
      // 409 `to_end`: the run had already finished or was just starting; the hook reloaded, the card says so.
      setStops(false);
      setError(t("Could not stop: {msg}", { msg: String((e as Error)?.message || e) }));
    }
  }

  function open() {
    if (childChat) window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: childChat }));
  }

  return (
    <section className="overflow-hidden rounded-xl bg-panel cb-task-card"
      data-bg-task={graphKey(run.startId)} data-graph-card={run.startId} data-graph-state={run.state}
      data-graph-tone={card.tone} data-open={isOpen ? "1" : undefined}>
      <div className="px-3 pb-2.5 pt-2">
        {/* The head: title, runtime, stop, like name, runtime, stop on the workflow card's head. */}
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={isOpen} title={title} data-graph-header
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="min-w-0 truncate text-[13px] font-semibold" data-graph-title>{title}</span>
            <span className="shrink-0 text-dim"><Chevron open={isOpen} size={11} /></span>
          </button>
          {duration !== null && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-dim" data-graph-duration title={t("Duration")}>{elapsed(duration)}</span>
          )}
          {card.stop && onStop && (
            <SymbolButton onClick={stop} disabled={stops} danger size={22} data={{ "data-graph-stop": "" }}
              word={t("Stop")} explanation={t("Stop this graph workflow — its chat halts, and the main agent is told.")}>
              {stops ? <SpinnerIcon size={12} /> : <StopSquareIcon size={11} />}
            </SymbolButton>
          )}
        </div>
        {/* "Graph workflow <state>" on the left, reason or step on the right, like "Workflow <outcome>" and the phase. */}
        <div className="mt-0.5 flex items-baseline gap-1.5 text-[11px]">
          <span className="shrink-0 text-dim">{t("Graph workflow")}</span>
          {card.warningDot && (
            <span className="size-1.5 shrink-0 self-center rounded-full bg-warn" data-graph-warning-dot aria-hidden />
          )}
          <span className={`shrink-0 font-medium ${TONE_COLOR[card.tone]}`} data-graph-word>
            {t(card.stateWord)}{run.state === "stopped" && run.stoppedOf === "human" ? ` · ${t("by you")}` : ""}
          </span>
          <span className="min-w-0 flex-1 truncate text-right text-dim" title={card.row2 || undefined} data-graph-row2>
            {card.row2}
          </span>
        </div>
        {card.worktree && (
          <div className="mt-0.5 flex items-baseline gap-1.5 text-[11px] text-dim">
            <span className="shrink-0">{t("Worktree")}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]" title={card.worktree} data-graph-worktree>{card.worktree}</span>
          </div>
        )}
        {error && <div className="mt-1.5 rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger" data-graph-error>{error}</div>}
        {/* Without a child chat (deleted by hand, stopped before the start) there is no "Open": nothing to show. */}
        {childChat && (
          <div className="mt-1.5">
            <button type="button" onClick={open} data-graph-open
              title={t("Open this graph workflow's chat — that is where it runs, and where you can write to it.")}
              className="rounded-md border border-edge px-2 py-0.5 text-[11px] text-dim transition-colors hover:bg-accent/10 hover:text-fg">
              {t("Open")}
            </button>
          </div>
        )}
      </div>

      {/* Expanded: a section of the SAME surface, hairline on top, like a phase of the workflow card. */}
      {isOpen && (
        <div className="border-t border-edge px-3 pb-2.5 pt-2" data-graph-selection>
          {card.response && <GraphResponse run={run} form={card.response} onResponse={onResponse} />}
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-dim">{t("Input")}</div>
          {run.input ? (
            <p className="line-clamp-6 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-fg/80" title={run.input} data-graph-input>
              {run.input}
            </p>
          ) : (
            <p className="text-[11.5px] text-dim" data-graph-input>{t("No input")}</p>
          )}
        </div>
      )}
    </section>
  );
}

// ── The response ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The heading per wait kind: just a word above the form, not a rule (the form itself comes from `responseForm`).
const KIND_WORD: Readonly<Record<string, string>> = {
  question: "Question",
  cap: "Round cap",
  review: "Review",
  done: "Completion check",
  stopped: "Halted",
  agent_ask: "Question##ask",
  permission: "Permission",
  dyn_approval: "Workflow approval",
};

// From when a text is shown shortened (with "more"): more characters or more rows than these.
const SHORT_CHARACTER = 220;
const SHORT_ROWS = 4;

const BUTTON_CLASS = "rounded-full border border-edge px-2.5 py-0.5 text-[11.5px] font-medium text-fg transition-colors hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent";
const SEND_CLASS = "rounded-full bg-accent px-2.5 py-0.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40";

/** A text, wrapped and, if long, shortened to a few lines, with "more"/"less". */
function Truncated({ text, mono = false, data }: { text: string; mono?: boolean; data: Record<string, string> }) {
  const t = useT();
  const [full, setFull] = useState(false);
  const lang = text.length > SHORT_CHARACTER || text.split("\n").length > SHORT_ROWS;
  return (
    <div className="min-w-0">
      <p {...data}
        className={`whitespace-pre-wrap break-words leading-snug ${mono ? "font-mono text-[10.5px] text-fg/80" : "text-[12px] text-fg"} ${lang && !full ? "line-clamp-4" : ""}`}>
        {text}
      </p>
      {lang && (
        <button type="button" onClick={() => setFull((v) => !v)} data-graph-more
          className="mt-0.5 text-[11px] font-medium text-dim hover:text-fg">
          {full ? t("less") : t("more")}
        </button>
      )}
    </div>
  );
}

/** The form of a waiting run. The input (button, number, selection, text) is held here; what goes to the server is
 *  computed by `responseRequest`; `null` means "nothing to send", and then "Send" is locked. */
function GraphResponse({ run, form, onResponse }: {
  run: GraphRunView;
  form: GraphResponseForm;
  onResponse?: (request: GraphRequest) => Promise<void>;
}) {
  const t = useT();
  const w = run.wait;
  const [text, setText] = useState("");
  const [n, setN] = useState(MORE_DEFAULT);
  const [selection, setSelection] = useState<string[][]>([]);
  const [sends, setSends] = useState(false);
  // The instance an answer was accepted for; until the next state arrives, the form stays locked.
  const [accepted, setAccepted] = useState("");
  const [hint, setHint] = useState(false);
  const [error, setError] = useState("");
  const instance = `${form.kind}|${form.requestId}|${run.updatedAt}`;
  // A new state (also one another device triggered): the selection belongs to the old question, and so do hint and error.
  // The typed text stays; it is the human's work.
  useEffect(() => { setSelection([]); setHint(false); setError(""); setAccepted(""); }, [instance]);

  const locked = sends || accepted === instance || !onResponse;

  async function send(input: GraphInput) {
    const request = responseRequest(run, input);
    if (!request || !onResponse || locked) return;
    setSends(true);
    setHint(false);
    setError("");
    try {
      await onResponse(request);
      // The new state comes via `graph_run`; here only clear the field and keep the form locked until then.
      setText("");
      setSelection([]);
      setAccepted(instance);
    } catch (e) {
      if ((e as GraphResponseError)?.noLongerOpen) setHint(true);
      else setError(t("Answer failed: {msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setSends(false);
    }
  }

  function select(qi: number, label: string, multiple: boolean) {
    setSelection((a) => {
      const fresh = form.questions.map((_, i) => a[i] ?? []);
      const soFar = fresh[qi] ?? [];
      fresh[qi] = soFar.includes(label) ? soFar.filter((l) => l !== label) : multiple ? [...soFar, label] : [label];
      return fresh;
    });
  }

  // What "Send" would send: the free text (with the selection for a question). `null` = locked.
  const freeInput: GraphInput = form.route === "ask-answer" ? { selection, text } : { text };
  const sendable = responseRequest(run, freeInput) !== null;
  const question = typeof w?.question === "string" ? w.question.trim() : "";

  return (
    <div className="mb-2.5 flex flex-col gap-1.5" data-graph-response={form.kind}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-warn">{t(KIND_WORD[form.kind] ?? form.kind)}</div>
      {question && <Truncated text={question} data={{ "data-graph-question": "" }} />}
      {form.kind === "permission" && (
        <div className="flex flex-col gap-0.5">
          {w?.tool && <span className="font-mono text-[11px] font-medium text-fg" data-graph-tool>{w.tool}</span>}
          {w?.input && <Truncated text={w.input} mono data={{ "data-graph-tool-input": "" }} />}
        </div>
      )}
      {form.kind === "dyn_approval" && (w?.dynName || w?.dynDescription) && (
        <div className="flex flex-col gap-0.5" data-graph-dyn>
          {w?.dynName && <span className="text-[12px] font-medium text-fg">{w.dynName}</span>}
          {w?.dynDescription && <Truncated text={w.dynDescription} data={{}} />}
        </div>
      )}
      {form.questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1" data-graph-ask-question={qi}>
          {(q.header || q.question) && (
            <div className="text-[12px] leading-snug text-fg">
              {q.header && <span className="mr-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-dim">{q.header}</span>}
              {q.question}
            </div>
          )}
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {q.options.map((o) => {
                const on = (selection[qi] ?? []).includes(o.label);
                return (
                  <button key={o.label} type="button" disabled={locked} title={o.description || undefined}
                    onClick={() => select(qi, o.label, q.multiple)} aria-pressed={on}
                    data-graph-option={o.label} data-on={on ? "1" : undefined}
                    className={`${BUTTON_CLASS} ${on ? "border-accent bg-accent/10 text-accent" : ""}`}>
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {form.buttons.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {form.buttons.map((k) => k.id === "more" ? (
            <span key={k.id} className="flex items-center gap-1">
              <button type="button" disabled={locked} onClick={() => send({ button: k.id, n })} data-graph-button={k.id} className={BUTTON_CLASS}>
                {t(k.word, { n })}
              </button>
              <input type="number" min={1} max={MORE_MAX} value={n} disabled={locked} data-graph-remaining-count aria-label={t("More rounds")}
                onChange={(e) => { const v = Math.trunc(Number(e.target.value)); setN(Number.isFinite(v) ? Math.min(MORE_MAX, Math.max(1, v)) : MORE_DEFAULT); }}
                className="w-11 rounded-md bg-bg px-1.5 py-0.5 text-[11.5px] tabular-nums text-fg outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-40" />
            </span>
          ) : (
            <button key={k.id} type="button" disabled={locked} onClick={() => send({ button: k.id })} data-graph-button={k.id} className={BUTTON_CLASS}>
              {t(k.word, k.params)}
            </button>
          ))}
        </div>
      )}
      {form.freeText && (
        <div className="flex items-end gap-1.5">
          <textarea value={text} rows={2} disabled={locked} placeholder={t(form.placeholder)} data-graph-text
            onChange={(e) => setText(e.target.value)}
            // Enter sends (like in the composer), Shift+Enter breaks the line.
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (sendable) send(freeInput); } }}
            className="min-w-0 flex-1 resize-none rounded-lg bg-bg px-2 py-1 text-[12px] leading-snug text-fg outline-none placeholder:text-dim focus:ring-1 focus:ring-accent/50 disabled:opacity-60" />
          <button type="button" disabled={locked || !sendable} onClick={() => send(freeInput)} data-graph-send className={SEND_CLASS}>
            {sends ? <SpinnerIcon size={11} /> : t("Send")}
          </button>
        </div>
      )}
      {hint && (
        <div className="rounded-md bg-warn/10 px-2 py-1 text-[11px] text-warn" data-graph-response-hint>
          {t("This is no longer open — someone has already answered (on another device, perhaps). Reloading the state.")}
        </div>
      )}
      {error && <div className="rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger" data-graph-response-error>{error}</div>}
    </div>
  );
}
