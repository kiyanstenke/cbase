"use client";

// The strip at the usage limit and its history row: ONE source for the Coding chat.
//
// The server parks EVERY run at the gate and at the time limit, so a parked run must be
// visible and releasable in the web UI, and the strip and the row must not be built twice.
//
// What the strip shows: the window (`limitText`), the reason, the time of continuation
// (countdown only while a clock runs; at the gate the time is a promise by the server, but
// the button is the answer), "Try now" or "Start anyway (spends credits)", and "Cancel". The
// gate's percentage comes from the SERVER (`threshold` from /api/credit-gate, see
// useGateThreshold); the constant in lib/credit.ts only holds until the server has answered.
//
// The strip is a `cb-kit-pane` (form system), not a card of its own; its warning-coloured
// variant is a class in globals.css because the surface is unlayered CSS and any utility on
// the element would lose against it.

import { useEffect, useState } from "react";
import { api, type LimitWait } from "@/lib/api";
import { CREDIT_GATE_PERCENT, isGateWaitRow, loadCreditGate } from "@/lib/credit";
import { useT } from "@/lib/i18n";
import { clockTime } from "@/lib/chat-format";
import { ic } from "@/components/CbKit";
import { StatusLine } from "@/components/chat/StatusLine";

// History row about the usage limit (persisted as role "limit").
// The server writes the kinds (`limitLine`); whoever adds one here gives it a header in
// `LimitRow` below, otherwise it gets the limit-hit header, and three of the kinds say the
// OPPOSITE (the turn was started deliberately).
export interface LimitLine {
  // gate       = the credit gate intercepted the start, the run is parked
  // gate-free  = the human pressed "Start anyway": this one turn runs on credits
  // gate-stale   = the reading was too old, so the run started instead of parking on yesterday's number
  // (The gate parks even without auto-continue, so there is no `gate-off`.)
  // model_switch = at the limit the CLI switched to another model ON ITS OWN
  // ("continuing on <model>"). It is not prevented (two layers doing the same would be worse
  // than one), but it must not stay hidden.
  // resume = the reset has come, it continues by itself · retry = the human pressed "Try now"
  // (nothing was reset, so it must not read as "limit reset").
  kind: "wait" | "resume" | "retry" | "cancel" | "off" | "credits" | "too-long" | "gave-up" | "unknown"
    | "gate" | "gate-free" | "gate-stale" | "model_switch";
  group?: string;
  label?: string;
  limitText?: string;
  reason?: string;
  resetsAt?: number | null;
  dueAt?: number;
  attempts?: number;
  evidence?: string;
  /** Only for kind "model_switch": the model the CLI continued on. */
  model?: string;
  /** Only for kind "resume": woken before the reset because a newer reading shows the credit gate clear
   *  (account switch); the header then does not say "reset". */
  early?: boolean;
  text?: string;
  at?: number;
}

// Time left until continuation, kept short: "2 h 14 min", "14 min", "38 s".
function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min`;
  return `${s} s`;
}

// ── The gate threshold: one number, one source ───────────────────────────────
//
// `GET /api/credit-gate` returns `threshold`; the usage page reads it the same way. The chat
// strip must not show its own number from a client constant: two numbers that merely happen
// to be equal. It is fetched once per page and only when a gate wait row needs it; until then
// (and on a network error) the preset holds.
let thresholdKnown: number | null = null;
async function fetchThreshold(): Promise<number | null> {
  try {
    const g = await loadCreditGate(api);
    if (g) thresholdKnown = g.threshold;
  } catch { /* the preset stays; a strip without a number would be worse */ }
  return thresholdKnown;
}
/** The gate threshold for the label; `needed` = a gate wait row is pending. */
export function useGateThreshold(needed: boolean): number {
  const [threshold, setThreshold] = useState(() => thresholdKnown ?? CREDIT_GATE_PERCENT);
  useEffect(() => {
    if (!needed) return;
    if (thresholdKnown !== null) { setThreshold(thresholdKnown); return; }
    let cancelled = false;
    fetchThreshold().then((s) => { if (!cancelled && s !== null) setThreshold(s); });
    return () => { cancelled = true; };
  }, [needed]);
  return threshold;
}

const ClockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

/**
 * The strip above the history (Coding chat): a run of this chat parked at the usage limit or
 * at the credit gate. `null` renders nothing.
 *
 * The actions come from outside (each view calls its own route); the strip disables its
 * buttons while one of them runs. `queued`: messages sit behind the waiting continuation, and
 * the strip then says they run AFTER it (parked counts as running; a second message does not
 * displace the first, it waits behind it).
 */
export function LimitStrip({
  wait, threshold, onNow, onAnyway, onAbort, queued = false,
}: {
  wait: LimitWait | null;
  threshold: number;
  onNow: () => void | Promise<void>;
  onAnyway: () => void | Promise<void>;
  onAbort: () => void | Promise<void>;
  queued?: boolean;
}) {
  const t = useT();
  const [running, setRunning] = useState(false);
  // One-second tick ONLY while a run hangs at the limit, for the countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!wait) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [wait]);
  if (!wait) return null;
  const gate = isGateWaitRow(wait);
  const perform = async (fn: () => void | Promise<void>) => {
    if (running) return;
    setRunning(true);
    try { await fn(); } finally { setRunning(false); }
  };
  // The gate has no countdown, but the promise is still shown: the gate row is self-sustaining
  // and continues by itself at the reset. Without the time the strip read like "nothing happens
  // until you press", which made people start on credits although the window would have been
  // free within the hour.
  const gateTime = wait.resetsAt
    ? t("continues at {time} or when released", { time: clockTime(wait.dueAt) })
    : t("Reset time unknown — checking back regularly.");
  return (
    <div className="cb-kit-pane flex items-center gap-2 overflow-hidden rounded-xl px-2.5 py-1.5 text-[12px]" data-limit-strip>
      <span className="shrink-0 text-dim"><ClockIcon /></span>
      <span className="shrink-0 text-fg/75">{wait.limitText}</span>
      <span className="min-w-0 flex-1 truncate text-dim">
        {gate
          ? `${t("Credit gate: no new turn is started above {pct}%.", { pct: threshold })} · ${gateTime}`
          : wait.reason === "probe"
          ? t("Reset time unknown — checking back regularly.")
          : wait.kind === "compact"
            ? t("Compacting at {time}", { time: clockTime(wait.dueAt) })
            : t("Continuing at {time}", { time: clockTime(wait.dueAt) })}
        {!gate && wait.dueAt > now ? ` · ${countdown(wait.dueAt - now)}` : ""}
        {wait.attempts > 0 ? ` · ${t("Attempt {n}", { n: wait.attempts + 1 })}` : ""}
        {queued ? ` · ${t("Queued — runs after the waiting continuation")}` : ""}
      </span>
      {/* At the credit gate "Try now" would run into the same check and park again at once, so
          the release for this one turn stands in its place. Conversely the release must NEVER
          appear for the time window: it would only send the request into a wall. */}
      {gate ? (
        <button
          type="button"
          onClick={() => perform(onAnyway)}
          disabled={running}
          data-limit-anyway
          title={t("Releases this one turn. The setting stays as it is.")}
          className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] text-fg hover:bg-hover disabled:opacity-40"
        >
          {t("Start anyway (spends credits)")}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => perform(onNow)}
          disabled={running}
          data-limit-now
          title={t("Try again right away instead of waiting for the reset")}
          className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          {t("Try now")}
        </button>
      )}
      <button
        type="button"
        onClick={() => perform(onAbort)}
        disabled={running}
        data-limit-abort
        title={wait.workflow
          ? `${t("Stop waiting for the reset (the task is discarded)")} — ${t("The running workflow then ends as failed.")}`
          : t("Stop waiting for the reset (the task is discarded)")}
        className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-fg disabled:opacity-40"
      >
        {t("Cancel")}
      </button>
    </div>
  );
}

/**
 * The history row for the usage limit: parked / continued / discarded / gate, a quiet row like
 * the target gate. The sentence arrives already translated from the server (it knows window and
 * time); the header here is the short form per kind.
 */
export function LimitRow({ line: l }: { line: LimitLine }) {
  const t = useT();
  const resumed = l.kind === "resume";
  const retried = l.kind === "retry";
  const switched = l.kind === "model_switch";
  const hard = l.kind === "credits" || l.kind === "too-long" || l.kind === "gave-up";
  // Two gate kinds report a START, not a brake: `gate-free` is the human's decision, `gate-stale` a
  // note (nothing happened that needs attention). Only `gate` itself is a warning. It differs
  // by word and symbol only, not by colour (StatusLine.tsx).
  const started = l.kind === "gate-free";
  const annotation = l.kind === "gate-stale";
  const head = resumed ? (l.early ? t("Credit gate clear") : t("Limit has reset"))
    : retried ? t("Tried again")
    : switched ? t("Model switched")
    : hard ? t("No automatic continuation")
    : l.kind === "cancel" ? t("Stopped waiting")
    : l.kind === "gate" ? t("Credit gate — no new turn")
    : started ? t("Started anyway")
    : annotation ? t("Credit gate — reading stale, started")
    : t("Usage limit reached");
  // The server writes the sentence; if there is none, at least the model carries the message:
  // a "Model switched" row without a target would tell nothing.
  const detail = l.text || (switched && l.model ? t("continued on {model}", { model: l.model }) : "");
  // No padding of its own: the row starts at the edge of the reply text like any other.
  const icon = ic(<><circle cx="12" cy="12" r="8" />
    {resumed || retried || started ? <path d="M16 9.5 10.8 15 8 12.2" />
      : switched ? <><path d="M8.5 10.2h7l-2.2-2.2" /><path d="M15.5 13.8h-7l2.2 2.2" /></>
      : l.kind === "gate" ? <path d="M8 12h8" />
      : annotation ? <><path d="M12 11v5" /><path d="M12 8h.01" /></>
      : <path d="M12 8v4.5l3 2" />}</>, 13);
  return <StatusLine data-limit-row={l.kind} icon={icon} header={head} rest={detail || undefined} wrap />;
}
