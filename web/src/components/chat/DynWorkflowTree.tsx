"use client";

// The card of ONE dynamic workflow in the agents section of the chat's right bar. NOT a bar section of its own (the
// section list has three readers and a contract test).
//
// The form follows Claude Code's workflow view: short SVG icons instead of spelled-out buttons, blue/grey tiles for the
// agents' activity. EVERY WORKFLOW IS ONE CARD, not every phase: one surface per run (`rounded-xl bg-panel`, no border),
// the phases are SECTIONS of that surface separated by hairlines, with no border, rounding or background of their own
// (form system: ONE surface per list, rows separated by hairlines). There is no "Phases" heading: the card carries the
// structure. There is no accent border anywhere in the view: only the chevron (and `aria-expanded`) says open/closed. The
// focus ring stays (it answers the keyboard, it is no state) and is pulled inward on the full-width buttons, because
// the card clips with `overflow-hidden`.
//
// Only the card is here (`DynWorkflowCard`), not a list of runs with a heading. The ONE "Background Tasks" list is built by
// the agent bar (components/AgentBar.tsx): subagents and runs mixed, newest on top (lib/background-tasks.ts), every card
// in THIS form; the subagent card there takes over surface, head, rows and the stop button (`SymbolButton`, exported from
// here). From top to bottom in the card:
//   1. the head: name on the left, runtime on the right (ticks via the agent bar's one-second tick, `now`), next to it
//      the stop as an icon; below "Workflow · status · phase", "N agents · X tokens" with n/m on the right, the
//      description (meta.description) and the latest log() line, older ones on click. Collapsed (chevron at the name) ONLY
//      the head shows;
//   2. one section per phase: title, n/m and chevron, below it one tile per agent (blue running, grey filled finished,
//      grey outlined waiting, red error, muted skipped/stopped). The running phase is open, a finished one closed; a
//      click toggles and the choice sticks (`bandDefaultOpen` in lib/dyn-tree.ts). Open, the section carries `data-open`;
//   3. expanded, the table Agent · Model · Tokens · Time, one state icon per row, on the right the handles as icons
//      (message to every living agent, also a waiting one; restart; skip: `agentHandles`), subtle, clear on hover or row
//      focus, and without layout jumps: the handle column is in EVERY row of EVERY phase while the run runs, so the
//      number edge is the same across all phases and does not move when the last running agent of a phase ends. The model
//      column gives way when the phase is narrower than 18rem (container query, not a window query: the bar is 280-640 px
//      wide). A click on a row opens the agent's transcript below it (`GET .../dyn-workflows/runs/:runId/agents/:n`).
//
// The WAIT REASON is visible: a waiting row that has NOTHING yet (no start, no tokens) carries ONE muted cell
// "waiting · 2 at a time" in place of model, tokens and time (`data-dynwf-wait`); and the head of a phase where it is
// only waiting and nothing works shows "waiting for a free slot · 2 at a time" under the tiles (`data-dynwf-band-wait`).
// The explanation (where the number comes from, when it starts) is in the title. The rule for cell vs. columns
// (`waitCell`): a waiting row that already has something, started or with tokens (typically one parked at the usage
// limit), keeps model, tokens and time, and the short form of the reason stands muted NEXT to the label
// (`data-dynwf-wait-beside`), as on iOS, where the reason is in the secondary line and tokens and time always stay.
// The number comes first in the short form ("waiting · 8 per user") so truncation does not hit it. Text, number and rule
// are computed by lib/dyn-tree.ts (`waitText`, `bandWaitText`, bound to iOS; `waitCell`).
//
// Nothing that is a number or a state is computed here: n/m (head and phase), the "open" default, tile kind, times, token
// sum, short model name, handles, the wait reason and its place are in lib/dyn-tree.ts (bound to iOS,
// web/test/dyn-tree-binding.test.mjs), the state in the hook chat/chatDynTree.ts. The stop on the head is the human stop
// (`POST .../dyn-workflows/runs/:runId/stop`, `from: "human"`): it ends the WHOLE workflow. Per agent there are the two
// handles (`POST ...agents/:n/skip` and `.../restart`); there is no third "stop per agent".
//
// Hooks for DOM probes in a real browser: data-dynwf-header=<runId> (the run's card, next to it
// data-bg-task="workflow:<runId>", the key in the "Background Tasks" list), data-dynwf-status,
// data-dynwf-stop, data-dynwf-duration, data-dynwf-nm, data-dynwf-phase, data-dynwf-outcome, data-dynwf-description,
// data-dynwf-log, data-dynwf-log-truncated, data-dynwf-band=<title> (the phase's section, with data-open), data-dynwf-band-nm,
// data-dynwf-tile=<kind>, data-dynwf-agent=<n>, data-dynwf-state=<id|finished>, data-dynwf-time,
// data-dynwf-transcript, data-dynwf-wait (the wait-reason cell), data-dynwf-wait-beside (the wait reason beside the label
// of a waiting row that already has something), data-dynwf-band-wait (the wait reason on a phase head), data-dynwf-skip=<n>,
// data-dynwf-restart=<n>, data-dynwf-restarts, data-dynwf-handle-error, data-dynwf-message=<n> (the "Message" button),
// data-dynwf-message-entry=<state> (a transcript row of kind "message"). The list itself carries data-bg-tasks (AgentBar),
// the hint about older runs data-dynwf-additional.

import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Chevron } from "@/components/CbKit";
import {
  CircleCheckIcon, CircleDashedIcon, CircleMinusIcon, CircleSkipIcon, CircleStopIcon, CircleXIcon, HistoryIcon, MessageIcon, RestartIcon, SkipForwardIcon,
  SpinnerIcon, StopSquareIcon,
} from "@/components/chat/ChatIcons";
import { durationShort, elapsed, modelText, tokenShort, tokenTitle } from "@/lib/agents";
import {
  agentDurationMs, agentHandles, BAND_EMPTY_WORD, bandDefaultOpen, bandWaitText, treeModel, interventionPath, tileKind, runDurationMs, runTokens, runTokenParts, runWord,
  modelShortName, waitText, waitCell, type BandEmpty, type TreeBand, type TreeHeader, type TreeRow, type DynTreeRun, type TileKind,
} from "@/lib/dyn-tree";
import { workflowKey } from "@/lib/background-tasks";
import type { WorkflowChoice } from "@/lib/agent-jump";
import { workflowAgentAddress } from "@/lib/api";
import { AgentMessageSheet, messageStateWord, type MessageTarget } from "@/components/chat/AgentMessageSheet";

/** How many log() lines a head shows before it is expanded: the latest. */
const LOG_VISIBLE = 1;

// The table's columns. Constants because the header row and EVERY row share them; a deviating width shifts the number
// edge. The model column shows only if the phase (= the card's width) is at least 18rem wide.
const SP_STATE = "w-[13px]";
const SP_MODEL = "w-[62px]";
const SP_TOKEN = "w-[42px]";
const SP_TIME = "w-[36px]";
// Three 20 px icons with 2 px gap: message, restart, skip.
const SP_HANDLES = "w-[64px]";
const MODEL_VISIBLE = "hidden @min-[18rem]/phase:block";
// The wait-reason cell sits in place of model, tokens and time (only for a waiting row without start and tokens,
// `waitCell`): exactly their width including the two gaps (gap-1.5 = 6 px): without model column 42 + 6 + 36, with it
// 62 + 6 + 42 + 6 + 36. So both edges of the number columns stay equal in every row, and the word gets the room the
// dashes would otherwise take. Narrow (84 px) it truncates, which is why the number comes first in the short form.
const SP_WAIT = "w-[84px] @min-[18rem]/phase:w-[152px]";

// The colour of the status word on the head: running in accent, finished green, failed red, the rest muted.
const OUTCOME_COLOR: Readonly<Record<string, string>> = { running: "text-accent", finished: "text-ok", failed: "text-danger" };

/** An icon button: the word as aria-label, the explanation as title, both stay reachable, only the icon is visible.
 *  `subtle`: in a table row half transparent, clear on hover or focus of the row (`group`).
 *  Exported: the subagent card of the agent bar carries the same stop button. */
export function SymbolButton({ onClick, disabled, word, explanation, danger = false, subtle = false, size = 20, data, children }: {
  onClick: () => void;
  disabled?: boolean;
  word: string;
  explanation: string;
  danger?: boolean;
  subtle?: boolean;
  size?: number;
  data: Record<string, string | number>;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={word}
      title={explanation}
      {...data}
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-md text-dim transition focus-visible:opacity-100 disabled:cursor-default disabled:opacity-40 ${
        subtle ? "opacity-45 group-hover:opacity-100 group-focus-within:opacity-100" : ""
      } ${danger ? "hover:bg-danger/10 hover:text-danger" : "hover:bg-hover hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

/** The card of ONE run in the "Background Tasks" list (AgentBar). `now` is the bar's one-second tick. `choice`: the jump
 *  "agent in chat" to an agent of THIS run (lib/agent-jump.ts). */
export function DynWorkflowCard({ chatId, run, now, choice }: { chatId: string | null; run: DynTreeRun; now: number; choice?: WorkflowChoice | null }) {
  const t = useT();
  const { header, bands } = treeModel(run);
  // A running workflow is open, a finished one collapsed: its rows are then history.
  const [open, setOpen] = useState(header.running);
  const [allLogs, setAllLogs] = useState(false);
  const [stops, setStops] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  // The jump: card open, row selected; once per jump (each carries a new object), afterwards the click rules again.
  useEffect(() => { if (choice) { setOpen(true); setSelected(choice.n); } }, [choice]);
  // The "Message" sheet to a workflow agent lives HERE, not in the row: the row exists only while its phase is expanded, and
  // the phase collapses by itself once nothing in it runs or waits. If the addressed agent ended while the human was
  // typing, the sheet and its text would go with the row, in exactly the commonest rejection case (agent finished, 409),
  // whose promise is "the text is not lost". The target is frozen on opening (name, state) and does not point into the
  // void after the row is gone.
  const [messageTo, setMessageTo] = useState<MessageTarget | null>(null);
  useEffect(() => { if (!header.running) setStops(false); }, [header.running]);

  async function stop() {
    if (!chatId) return;
    setStops(true);
    setError("");
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/dyn-workflows/runs/${encodeURIComponent(run.runId)}/stop`, {
        method: "POST",
        body: JSON.stringify({ from: "human" }),
      });
      // The head shows the end state from the event (`dynwf_tree`), not from the response: one source.
    } catch (e) {
      setStops(false);
      setError(t("Could not stop: {msg}", { msg: String((e as Error)?.message || e) }));
    }
  }

  const duration = runDurationMs(run, now);
  const sum = runTokens(run);
  const logs = allLogs ? header.logs : header.logs.slice(-LOG_VISIBLE);
  const older = header.logs.length - Math.min(header.logs.length, LOG_VISIBLE) + header.logsTruncated;
  return (
    // The card OF THE RUN: the only surface in this view, WITHOUT a border; it stands out from the bar's ground by `bg-panel`
    // alone, in dark one step lighter via `cb-task-card` (globals.css). `overflow-hidden` clips hover and selected row at
    // the rounding; the full-width buttons therefore pull their focus ring inward.
    <section className="overflow-hidden rounded-xl bg-panel cb-task-card"
      data-dynwf-header={run.runId} data-bg-task={workflowKey(run.runId)} data-dynwf-status={header.status} data-open={open ? "1" : undefined}>
      {/* 1. The head: name, runtime, stop: the row one skims. */}
      <div className="px-3 pb-2.5 pt-2">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            aria-expanded={open} title={header.name}>
            {/* The arrow AFTER the name, the rows below flush (like the subagent card). */}
            <span className="min-w-0 truncate text-[13px] font-semibold">{header.name || t("Workflow")}</span>
            <span className="shrink-0 text-dim"><Chevron open={open} size={11} /></span>
          </button>
          {duration !== null && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-dim" data-dynwf-duration title={t("Duration")}>{elapsed(duration)}</span>
          )}
          {header.running && chatId && (
            <SymbolButton onClick={stop} disabled={stops} danger size={22} data={{ "data-dynwf-stop": "" }}
              word={t("Stop")} explanation={t("Stop the whole workflow — running agents end, the main agent learns about it in its next turn.")}>
              {stops ? <SpinnerIcon size={12} /> : <StopSquareIcon size={11} />}
            </SymbolButton>
          )}
        </div>
        <div>
          <div className="mt-0.5 flex items-baseline gap-1.5 text-[11px]">
            <span className="shrink-0 text-dim">{t("Workflow")}</span>
            <span className={`shrink-0 font-medium ${OUTCOME_COLOR[header.status] ?? "text-dim"}`} data-dynwf-outcome>
              {t(runWord(header.status))}{header.status === "stopped" && header.stoppedOf === "human" ? ` · ${t("by you")}` : ""}
            </span>
            <span className="min-w-0 flex-1 truncate text-right text-dim" data-dynwf-phase title={header.phase ?? undefined}>
              {header.phase ? t("Phase: {phase}", { phase: header.phase }) : t("no phase yet")}
            </span>
          </div>
          <div className="flex items-baseline gap-1.5 text-[11px] text-dim">
            <span className="min-w-0 flex-1 truncate">
              {header.started === 1 ? t("1 agent") : t("{n} agents", { n: header.started })}
              {sum && (
                <span title={tokenTitle(sum.tokens, sum.tokenKind, runTokenParts(run) ?? undefined, t)}>{` · ${tokenShort(sum.tokens, sum.tokenKind)} ${t("tokens")}`}</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums" data-dynwf-nm title={t("done / agent() calls")}>{header.finished}/{header.started}</span>
          </div>
          {header.description && (
            <p className="mt-1.5 line-clamp-3 text-[11.5px] leading-snug text-fg/80" title={header.description} data-dynwf-description>
              {header.description}
            </p>
          )}
          {error && <div className="mt-1.5 rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">{error}</div>}
          {header.warning && <div className="mt-1.5 rounded-md bg-warn/10 px-2 py-1 text-[11px] text-warn" data-dynwf-warning>{header.warning}</div>}
          <LogRows header={header} logs={logs} older={older} all={allLogs} onToggle={() => setAllLogs((a) => !a)} />
        </div>
      </div>

      {/* 2. The phases as sections of the SAME surface, each with its hairline on top, without a card of its own. No
             "Phases" heading: the card carries the structure, and the head sits above the first section. */}
      {open && bands.map((b) => b.empty ? (
        <EmptyPhase key={b.title ?? "\u0000"} title={b.title ?? t("No phase")} empty={b.empty} />
      ) : (
        <PhasesSection key={b.title ?? "\u0000"} chatId={chatId} run={run} header={header} band={b} now={now}
          jump={choice && b.rows.some((z) => z.n === choice.n) ? choice.nonce : undefined}
          selected={selected} onSelect={(n) => setSelected((g) => (g === n ? null : n))} onMessage={setMessageTo} />
      ))}
      {messageTo && chatId && <AgentMessageSheet chatId={chatId} target={messageTo} onClose={() => setMessageTo(null)} />}
    </section>
  );
}

function LogRows({ header, logs, older, all, onToggle }: {
  header: TreeHeader; logs: TreeHeader["logs"]; older: number; all: boolean; onToggle: () => void;
}) {
  const t = useT();
  if (!header.logs.length && !header.logsTruncated) return null;
  const word = all ? t("fewer log() lines") : t("{n} older log() lines", { n: older });
  return (
    <div className="mt-1.5 flex items-start gap-2">
      <div className={`min-w-0 flex-1 ${all ? "max-h-40 overflow-y-auto" : ""}`}>
        {all && header.logsTruncated > 0 && (
          <div className="text-[10.5px] text-dim">{t("Truncated: the tree does not show the {n} oldest lines.", { n: header.logsTruncated })}</div>
        )}
        {logs.map((z, i) => (
          // The marker before it is in CSS (::before), not in the text: the row carries exactly the log() text (the test rig
          // reads it, and a screen reader reads no decoration).
          <div key={`${z.at}-${i}`} className="truncate font-mono text-[10.5px] leading-snug text-dim before:mr-1 before:opacity-60 before:content-['›']"
            title={z.text} data-dynwf-log>
            {z.text}
          </div>
        ))}
      </div>
      {older > 0 && (
        <button type="button" onClick={onToggle} aria-expanded={all} aria-label={word} title={word}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 text-[10.5px] tabular-nums text-dim hover:bg-hover hover:text-fg"
          data-dynwf-log-truncated={header.logsTruncated}>
          {!all && <span>+{older}</span>}
          <Chevron open={all} size={9} />
        </button>
      )}
    </div>
  );
}

// The tile per agent, in the kit's colour system by state: blue (accent) running, green (ok) finished, grey outlined waiting,
// red (danger) error, amber (warn) aborted, muted the rest. lib/dyn-tree.ts `tileKind` computes the kind.
const TILE: Readonly<Record<TileKind, string>> = {
  running: "bg-accent",
  finished: "bg-ok/85",
  waiting: "border border-dim/60",
  error: "bg-danger/85",
  aborted: "bg-warn/80",
  muted: "bg-dim/20",
};

// A phase without agents (known from meta.phases or passed without an agent() call): the same row as a phase title, muted,
// the word on the right instead of n/m; nothing to expand, so no button and no chevron. Own marker
// `data-dynwf-band-empty`, so test rigs that count phase cards count only those with agents.
function EmptyPhase({ title, empty }: { title: string; empty: BandEmpty }) {
  const t = useT();
  return (
    <div className="border-t border-edge px-3 pb-2 pt-1.5" data-dynwf-band-empty={empty}>
      <span className="flex items-center gap-2 text-dim">
        <span className="min-w-0 truncate text-[12px] font-medium" title={title}>{title}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-[11px]">{t(BAND_EMPTY_WORD[empty])}</span>
      </span>
    </div>
  );
}

// A phase: a section of the run's card: hairline on top, nothing of its own (no border, no rounding, no background).
// Only the chevron says open/closed.
function PhasesSection({ chatId, run, header, band, now, jump, selected, onSelect, onMessage }: {
  chatId: string | null; run: DynTreeRun; header: TreeHeader; band: TreeBand; now: number; selected: number | null; onSelect: (n: number) => void;
  /** A jump "agent in chat" to a row of THIS phase: its `nonce`; the phase expands as after a click. */
  jump?: number;
  onMessage: (target: MessageTarget) => void;
}) {
  const t = useT();
  // Open is what the computation presets (the running phase) until the human clicks; then the choice sticks. The preset
  // follows the run only while it runs: a stop collapses nothing under the reader's eyes.
  const preset = bandDefaultOpen(band, header.running);
  const [follows, setFollows] = useState(preset);
  useEffect(() => { if (header.running) setFollows(preset); }, [preset, header.running]);
  const [choice, setChoice] = useState<boolean | null>(null);
  useEffect(() => { if (jump !== undefined) setChoice(true); }, [jump]);
  const open = choice ?? follows;
  const title = band.title ?? t("No phase");
  // If the phase is only waiting, the head says for what; otherwise it would look like a skipped one.
  const wait = bandWaitText(band, header.running, run.cap);
  // The handle column is in every row of every phase while the run runs (and there is a chat the handles act on);
  // otherwise the number columns would jump between phases and when buttons come and go.
  const withHandles = header.running && Boolean(chatId);
  return (
    <div
      className="@container/phase border-t border-edge"
      data-dynwf-band={band.title ?? ""}
      data-open={open ? "1" : undefined}
    >
      <button type="button" onClick={() => setChoice(!open)} aria-expanded={open}
        className="block w-full px-3 pb-2 pt-1.5 text-left transition-colors hover:bg-hover/50 focus-visible:outline-offset-[-2px]">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[12px] font-medium" title={title}>{title}</span>
          <span className="-ml-1 shrink-0 text-dim"><Chevron open={open} size={10} /></span>
          <span className="flex-1" />
          <span className="shrink-0 text-[11px] tabular-nums text-dim" data-dynwf-band-nm title={t("done / agent() calls")}>
            {band.finished}/{band.rows.length}
          </span>
        </span>
        <span className="mt-1.5 flex flex-wrap gap-[3px]" aria-hidden>
          {band.rows.map((z) => (
            <span key={z.n} className={`box-border h-[9px] w-[9px] rounded-[2px] ${TILE[tileKind(z.status)]}`}
              title={`${z.label || t("Agent {n}", { n: z.n })} — ${z.state ? t(z.state.word) : t("done")}`} data-dynwf-tile={tileKind(z.status)} />
          ))}
        </span>
        {wait && (
          <span className="mt-1 block truncate text-[10.5px] text-dim" title={t(wait.explanation, wait.values)} data-dynwf-band-wait>
            {t(wait.lang, wait.values)}
          </span>
        )}
      </button>
      {/* Expanded: the table directly under the title, no line between (the tiles close off the title); the first row
          carries the line under the column header. */}
      {open && (
        <div>
          <div className="flex items-center gap-1.5 pl-3 pr-2 pb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-dim" aria-hidden>
            <span className={`${SP_STATE} shrink-0`} />
            <span className="min-w-0 flex-1 truncate">{t("Agent")}</span>
            <span className={`${SP_MODEL} ${MODEL_VISIBLE} shrink-0 truncate`}>{t("Model")}</span>
            <span className={`${SP_TOKEN} shrink-0 text-right`}>{t("tokens")}</span>
            <span className={`${SP_TIME} shrink-0 text-right`}>{t("Time")}</span>
            {withHandles && <span className={`${SP_HANDLES} shrink-0`} />}
          </div>
          {band.rows.map((z) => (
            <AgentRow key={z.n} chatId={chatId} run={run} row={z} runRunning={header.running} now={now} withHandles={withHandles}
              selected={selected === z.n} onSelect={() => onSelect(z.n)} onMessage={onMessage} />
          ))}
        </div>
      )}
    </div>
  );
}

// The state icon before the row: tick finished, turning arc running, cross error, dashed circle waiting; the muted ends
// each with a mark of their own. The id comes from the bound table (lib/history-state.ts).
function StateSymbol({ identifier }: { identifier: string }) {
  switch (identifier) {
    case "finished": return <span className="text-ok"><CircleCheckIcon /></span>;
    case "running": return <span className="text-accent"><SpinnerIcon /></span>;
    case "error": return <span className="text-danger"><CircleXIcon /></span>;
    case "waiting": return <span className="text-dim"><CircleDashedIcon /></span>;
    case "skipped": return <span className="text-dim"><CircleSkipIcon /></span>;
    case "stopped": return <span className="text-dim"><CircleStopIcon /></span>;
    default: return <span className="text-dim"><CircleMinusIcon /></span>;
  }
}

function AgentRow({ chatId, run, row, runRunning, now, withHandles, selected, onSelect, onMessage }: {
  chatId: string | null; run: DynTreeRun; row: TreeRow; runRunning: boolean; now: number; withHandles: boolean; selected: boolean; onSelect: () => void;
  /** Opens the "Message" sheet on the CARD (DynWorkflowCard `messageTo`), never here: the row goes with its phase. */
  onMessage: (target: MessageTarget) => void;
}) {
  const t = useT();
  const identifier = row.state?.identifier ?? "finished";
  const word = row.state ? t(row.state.word) : t("done");
  // The wait reason: short in the row, long read aloud and in the title, the explanation in the short text's title.
  // `waitCell` says where the short text stands: as a cell over model, tokens and time only while the waiting row has none
  // of them; otherwise (parked at the limit, with start and tokens) the columns stay and it stands next to the label.
  const wait = identifier === "waiting" ? waitText(row, run.cap) : null;
  const cell = wait && waitCell(row) ? wait : null;
  const beside = wait && !cell ? wait : null;
  const waitReason = wait ? t(wait.lang, wait.values) : "";
  const full = modelText(row.provider, row.model);
  const short = modelShortName(row.provider, row.model);
  const duration = agentDurationMs(row, run, now);
  const tok = tokenShort(row.tokens, row.tokenKind);
  const label = row.label || t("Agent {n}", { n: row.n });
  const restarted = row.restarts ? t("restarted {n}×", { n: row.restarts }) : "";
  // What the row does not carry as a word is in the title (and as text for screen readers): state, reason, model,
  // restarts, "from the journal".
  const explanation = [label, waitReason || word, full, restarted, row.fromCache ? t("from the journal") : ""].filter(Boolean).join(" · ");
  const handles = agentHandles(row, runRunning);
  // "Message" to every LIVING agent, also a waiting one (the run address applies before its start; the message is queued
  // and hangs on its job). The server rejects finished, skipped and failed ones.
  const live = runRunning && (row.status === "running" || row.status === "waiting");
  // A handle is in flight: both buttons rest until the row's state changes (the tree's message).
  const [inFlight, setInFlight] = useState<"" | "skip" | "restart">("");
  const [error, setError] = useState("");
  useEffect(() => { setInFlight(""); }, [row.status, row.restarts]);
  async function handle(kind: "skip" | "restart") {
    if (!chatId || inFlight) return;
    setInFlight(kind);
    setError("");
    try {
      await api(interventionPath(chatId, run.runId, row.n, kind), { method: "POST" });
    } catch (e) {
      setInFlight("");
      setError(t(kind === "skip" ? "Could not skip: {msg}" : "Could not restart: {msg}", { msg: String((e as Error)?.message || e) }));
    }
  }
  return (
    <div className="border-t border-edge/70">
      {/* `cb-row` + `data-open`: the selected row carries `edge` (globals.css); `hover` is too quiet in light. */}
      <div className="cb-row group flex items-center gap-1.5 pl-3 pr-2 transition-colors hover:bg-hover/60 focus-within:bg-hover/60" data-open={selected ? "1" : undefined}>
        <button type="button" onClick={onSelect} aria-expanded={selected} title={explanation}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-[5px] text-left focus-visible:outline-offset-[-2px]"
          data-dynwf-agent={row.n} data-dynwf-state={identifier}>
          <span className={`${SP_STATE} flex shrink-0 justify-center`} aria-hidden><StateSymbol identifier={identifier} /></span>
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="min-w-0 truncate text-[12px]">{label}</span>
            {/* A waiting row that already has something (parked at the limit): the reason short next to the label, muted, like the
                secondary line on iOS; the long form is read aloud (sr-only below). */}
            {beside ? (
              <span className="min-w-0 truncate text-[11px] text-dim" title={t(beside.explanation, beside.values)} data-dynwf-wait-beside aria-hidden>
                {t(beside.short, beside.values)}
              </span>
            ) : null}
            {/* A restart is visible so a second attempt does not look like the first: as a mark, the word in the title. */}
            {row.restarts ? (
              <span className="inline-flex shrink-0 items-center gap-[1px] text-[10px] tabular-nums text-dim" title={restarted} data-dynwf-restarts>
                <RestartIcon size={9} />{row.restarts}
              </span>
            ) : null}
            {/* A row from the journal (resume) shows tokens and time as a dash; the mark says why (iOS: secondary line). */}
            {row.fromCache ? (
              <span className="inline-flex shrink-0 items-center text-dim" title={t("from the journal")} data-dynwf-cache aria-hidden>
                <HistoryIcon size={10} />
              </span>
            ) : null}
            <span className="sr-only">{`, ${[waitReason || word, row.fromCache ? t("from the journal") : ""].filter(Boolean).join(", ")}`}</span>
          </span>
          {cell ? (
            // A waiting row without start and tokens: ONE cell over model, tokens and time, the word instead of three dashes.
            // What the cell does not carry (explanation, model) is in the title; it has no tokens and time (`waitCell`).
            <span className={`${SP_WAIT} shrink-0 truncate text-[11px] text-dim`} data-dynwf-wait
              title={[t(cell.explanation, cell.values), full].filter(Boolean).join(" · ")}>
              {t(cell.short, cell.values)}
            </span>
          ) : (
            <>
              <span className={`${SP_MODEL} ${MODEL_VISIBLE} shrink-0 truncate text-[11px] text-dim`} title={full || undefined}>{short || "–"}</span>
              <span className={`${SP_TOKEN} shrink-0 text-right text-[11px] tabular-nums`}
                title={typeof row.tokens === "number" ? tokenTitle(row.tokens, row.tokenKind, row.tokenParts, t) : undefined}>
                {tok || "–"}
              </span>
              <span className={`${SP_TIME} shrink-0 text-right text-[11px] tabular-nums text-dim`} data-dynwf-time>{duration !== null ? durationShort(duration) : "–"}</span>
            </>
          )}
        </button>
        {withHandles && (
          <span className={`${SP_HANDLES} flex shrink-0 items-center justify-end gap-0.5`}>
            {live && (
              <SymbolButton onClick={() => onMessage({ address: workflowAgentAddress(run.runId, row.n), name: label, kind: t("Workflow agent"), state: waitReason || word })} subtle data={{ "data-dynwf-message": row.n }}
                word={t("Message")}
                explanation={t("Write this agent a message — also a waiting one: it then reads it when it starts.")}>
                <MessageIcon size={11} />
              </SymbolButton>
            )}
            {handles.restart && (
              <SymbolButton onClick={() => handle("restart")} disabled={Boolean(inFlight)} subtle data={{ "data-dynwf-restart": row.n }}
                word={t("Restart")}
                explanation={t("Restart this agent — the current attempt ends, the same task starts over; the script receives the new result.")}>
                {inFlight === "restart" ? <SpinnerIcon size={11} /> : <RestartIcon size={11} />}
              </SymbolButton>
            )}
            {handles.skip && (
              <SymbolButton onClick={() => handle("skip")} disabled={Boolean(inFlight)} subtle data={{ "data-dynwf-skip": row.n }}
                word={t("Skip")}
                explanation={t("Skip this agent — it ends, the script receives null for it, the workflow keeps running.")}>
                {inFlight === "skip" ? <SpinnerIcon size={11} /> : <SkipForwardIcon size={11} />}
              </SymbolButton>
            )}
          </span>
        )}
      </div>
      {error && <div className="px-3 pb-1 text-[10.5px] text-danger" data-dynwf-handle-error>{error}</div>}
      {selected && chatId && <Transcript chatId={chatId} runId={run.runId} n={row.n} status={`${row.status}:${row.tokens ?? ""}`} />}
    </div>
  );
}

// Kind "message" (agent communication): a message to this agent, with sender and delivery state; "not_delivered" carries
// the reason.
type TranscriptRow = {
  kind: string; text?: string; name?: string; input?: unknown; error?: boolean;
  from?: "agent" | "human" | string; state?: string; reason?: string;
};

// The structured transcript of ONE workflow agent: the framed job, text, thinking, tool calls and their results. Refetched
// whenever the agent's state or tokens change, so it follows the running agent without a tick of its own.
function Transcript({ chatId, runId, n, status }: { chatId: string; runId: string; n: number; status: string }) {
  const t = useT();
  const [rows, setRows] = useState<TranscriptRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ rows?: TranscriptRow[] }>(`/api/chats/${encodeURIComponent(chatId)}/dyn-workflows/runs/${encodeURIComponent(runId)}/agents/${n}`)
      .then((r) => { if (active) { setRows(Array.isArray(r?.rows) ? r.rows : []); setError(""); } })
      .catch((e) => { if (active) setError(String((e as Error)?.message || e)); });
    return () => { active = false; };
  }, [chatId, runId, n, status]);
  return (
    <div className="max-h-[320px] space-y-1.5 overflow-y-auto border-t border-edge/70 bg-bg/50 px-3 py-2 text-[11px]" data-dynwf-transcript={n}>
      {error ? <div className="text-danger">{t("Transcript not loaded: {msg}", { msg: error })}</div>
        : rows === null ? <div className="text-dim">…</div>
        : rows.length === 0 ? <div className="text-dim">{t("Nothing in the transcript yet.")}</div>
        : rows.map((z, i) => <TranscriptEntry key={i} z={z} />)}
    </div>
  );
}

function TranscriptEntry({ z }: { z: TranscriptRow }) {
  const t = useT();
  if (z.kind === "tool") {
    return (
      <div className="truncate font-mono text-[10.5px] text-dim" title={JSON.stringify(z.input ?? {})}>
        → {z.name} {JSON.stringify(z.input ?? {}).slice(0, 120)}
      </div>
    );
  }
  if (z.kind === "message") {
    // A message to the agent: its own mark with sender and state; what did not arrive is muted, with the reason.
    const not = z.state === "not_delivered";
    const word = messageStateWord(z.state);
    return (
      <div className={`rounded-md bg-hover/50 px-2 py-1.5 ${not ? "opacity-60" : ""}`} data-dynwf-message-entry={z.state ?? ""}>
        <div className="mb-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[10px] text-dim">
          <span className="font-semibold uppercase tracking-wider">{z.from === "human" ? t("Message from the human") : t("Message from the main agent")}</span>
          {word && <span>· {t(word)}</span>}
        </div>
        <div className={`whitespace-pre-wrap break-words ${not ? "text-dim" : ""}`}>{z.text}</div>
        {not && z.reason && <div className="mt-0.5 text-[10.5px] text-dim">{t("Reason: {reason}", { reason: z.reason })}</div>}
      </div>
    );
  }
  if (z.kind === "tool-result") {
    return <div className={`line-clamp-3 whitespace-pre-wrap font-mono text-[10.5px] ${z.error ? "text-danger" : "text-dim"}`}>{z.text}</div>;
  }
  const marker = z.kind === "job" ? t("Brief") : z.kind === "thinking" ? t("Thinking") : "";
  return (
    <div className={`whitespace-pre-wrap break-words ${z.kind === "thinking" ? "italic text-dim" : ""} ${z.kind === "job" ? "line-clamp-4 text-dim" : ""}`}>
      {marker && <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-dim">{marker}</span>}
      {z.text}
    </div>
  );
}
