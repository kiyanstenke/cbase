// The words of the outer loop — ONE place for list, editor, runs and chat info (otherwise the same mark says something different in
// four places). Leaf: only types from lib/api, no components. iOS has the same sentences in
// mobile/CbaseMobile/Kit/LocDEOuterLoop.swift (keys verbatim).

import type {
  OuterLoopAgent, OuterLoopTrigger, OuterLoopRun, OuterLoopRunUpkeep, OuterLoopUpkeepTally, OuterLoopTriggerKind, OuterLoopOrigin, OuterLoopRunState, OuterLoopSource, OuterLoopIneffective,
} from "@/lib/api";

type T = (text: string, params?: Record<string, string | number>) => string;

/** Name of a trigger kind (editor, runs). "afterRun" is a run reason, not a choice. */
export function triggerKindName(kind: OuterLoopTriggerKind | string, t: T): string {
  switch (kind) {
    case "quiet": return t("After quiet");
    case "interval": return t("Interval");
    case "run_end": return t("After every run end");
    case "clockTime": return t("Fixed times");
    case "afterRun": return t("Follow-up run");
    default: return kind;
  }
}

/** A trigger as a short line: "after 5 min of quiet", "every 60 min", "after every run end", "at 08:00, 17:00". */
export function triggerShort(a: OuterLoopTrigger, t: T): string {
  switch (a.kind) {
    case "quiet": return t("after {n} min of quiet", { n: a.minutes });
    case "interval": return t("every {n} min", { n: a.minutes });
    case "run_end": return t("after every run end");
    case "clockTime": return a.times.length ? t("at {times}", { times: a.times.join(", ") }) : t("Fixed times");
  }
}

/** The triggers of an agent in one line — empty means "none" (the server does not allow it, the view says it anyway). */
export function triggerRow(list: OuterLoopTrigger[], t: T): string {
  return list.length ? list.map((a) => triggerShort(a, t)).join(" · ") : t("no trigger");
}

/** Why an agent is not running — as a "not running: …" mark. */
export function ineffectiveText(reason: OuterLoopIneffective, t: T): string {
  switch (reason) {
    case "managing": return t("not running: managing agent");
    case "off": return t("off");
    case "without-model": return t("not running: no model");
    case "without-provider": return t("not running: no provider");
    default: return "";
  }
}

export function originName(h: OuterLoopOrigin, t: T): string {
  return h === "chat" ? t("Chat") : h === "project" ? t("Project") : t("Workspace");
}

/** Why an agent is active on a chat or not (`outerloop/activation.js`). */
export function sourceText(q: OuterLoopSource | string, t: T): string {
  switch (q) {
    case "no-target-chat": return t("not a target chat");
    case "archived": return t("resting — the chat is archived");
    case "not-available": return t("not available here");
    case "ineffective": return t("not running");
    case "row-on": return t("switched on for this chat");
    case "row-off": return t("switched off for this chat");
    case "chat": return t("belongs to this chat");
    case "standard": return t("Default for new chats");
    case "timeline": return t("on for every chat of the project");
    case "no-default": return t("not default for this chat");
    default: return q;
  }
}

export function stateName(z: OuterLoopRunState | string, t: T): string {
  switch (z) {
    case "running": return t("running");
    case "finished": return t("done");
    case "parked": return t("parked");
    case "aborted": return t("cancelled");
    case "error": return t("Error");
    default: return z;
  }
}

/** Tone of the state mark. */
export function stateTone(z: OuterLoopRunState | string): "dim" | "accent" | "warn" | "ok" | "danger" {
  return z === "running" ? "accent" : z === "finished" ? "ok" : z === "parked" ? "warn" : z === "error" ? "danger" : "dim";
}

/** Tokens compact: 1,234 → "1.2k", 2,300,000 → "2.3M". */
export function tokenShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Cost: `null` means subscription or no price — then "—", never "$0". */
export function costText(k: number | null): string {
  return k == null ? "—" : `$${k.toFixed(k < 0.1 ? 4 : 2)}`;
}

/** Tool count of an agent (cbase + built-in + external). */
export function toolCount(a: Pick<OuterLoopAgent, "tools" | "builtin" | "mcp">): number {
  return a.tools.length + a.builtin.length + Object.values(a.mcp).reduce((n, l) => n + l.length, 0);
}

/** The role of a fixed agent as a label (list, editor, chat info); empty for every other. */
export function fixedName(a: Pick<OuterLoopAgent, "summarizer" | "agendaKeeper" | "timeline">, t: T): string {
  return a.summarizer ? t("Summarizer") : a.agendaKeeper ? t("Agenda keeper") : a.timeline ? t("Timeline") : "";
}

/** "1 change" / "12 changes". */
const changes = (n: number, t: T) => (n === 1 ? t("1 change") : t("{n} changes", { n }));

/** The tally of the agenda keeper: "12 changes · 10 standing · 2 corrected" — "standing" = open + confirmed (what the main agent has not
 *  taken back). Without a change only "No change yet"; without a tally (`null`: an older server, an answer without the field) "Track
 *  record unknown" — empty is not unknown, and the rule lives here ONCE, not in every place that shows the tally. iOS:
 *  `OuterLoopWord.upkeepTally` (bound in web/test/outerloop-set-binding.test.mjs). */
export function upkeepTallyText(b: OuterLoopUpkeepTally | null, t: T): string {
  if (!b) return t("Track record unknown");
  if (b.changes <= 0) return t("No change yet");
  const state = b.open + b.confirmed;
  return [changes(b.changes, t), state === 1 ? t("1 standing") : t("{n} standing", { n: state }), t("{n} corrected", { n: b.corrected })].join(" · ");
}

/** The tally of one agenda-keeper run: "3 changes · 1 corrected"; without a correction only the changes. iOS:
 *  `OuterLoopWord.runUpkeep` (bound as above). */
export function runUpkeepText(p: OuterLoopRunUpkeep, t: T): string {
  if (p.changes <= 0) return t("no change");
  return p.corrected > 0 ? `${changes(p.changes, t)} · ${t("{n} corrected", { n: p.corrected })}` : changes(p.changes, t);
}

/** The codes with which the server ends a run ON PURPOSE (`state` "aborted", `error` = the code — server: `outerloop/intended-end.js`
 *  INTENDED_END, ONE list), each with this client's calm text: `turn` — a turn in the observed chat aborted the agenda keeper; `quiet` —
 *  the wakeup of a parked run arrived in a chat that was not quiet. The guard reads the codes from the server (web/test/outerloop-keeper.test.mjs,
 *  executed together with iOS in outerloop-set-binding): a code there without an entry here is red. iOS: `OuterLoopWord.intendedEnd`. */
const INTENDED_END: Readonly<Record<string, (t: T) => string>> = {
  turn: (t) => t("Stopped: the chat went back to work"),
  quiet: (t) => t("Postponed: the chat was not quiet"),
};
/** The codes this client shows calmly (for the guard: the same set as in the server). */
export const INTENDED_ENDS: readonly string[] = Object.freeze(Object.keys(INTENDED_END));

/** What shows under a run as an error, and whether it shows calmly (`quiet`: gray instead of red). An intended end (a code from
 *  INTENDED_END on an aborted run) is no error — the next trigger catches up —, so its own text shows calmly. Any other text shows
 *  verbatim and red. Without text: nothing. iOS: `OuterLoopWord.runError`. */
export function runError(l: Pick<OuterLoopRun, "state" | "error">, t: T): { text: string; quiet: boolean } | null {
  if (!l.error) return null;
  if (l.state === "aborted" && Object.hasOwn(INTENDED_END, l.error)) return { text: INTENDED_END[l.error](t), quiet: true };
  return { text: l.error, quiet: false };
}
