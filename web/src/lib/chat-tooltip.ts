// The computation of a chat row's short info (modelled on the floating card of the ChatGPT sidebar). The card itself is
// components/chat/ChatTooltip.tsx; the words live here: the last activity (“8 h”), a chat's state in ONE sentence, and the line of its
// copy. The state sentence comes from the same computation as the “Active runs” pill (lib/run-description.ts), so pill and card say
// the same.
import type { ActiveRun } from "@/lib/api";
import { elapsed } from "@/lib/agents";
import { RUN_PHASES, runDetails, runPhase } from "@/lib/run-description";

type Translator = (key: string, params?: Record<string, string | number>) => string;

/** The last activity, short: “now”, “5 min”, “8 h”, “3 d”, from one week on the date. */
export function lastActivity(ms: number, now: number, t: Translator, locale: string): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return t("now");
  if (s < 3600) return t("{n} min", { n: Math.floor(s / 60) });
  if (s < 86_400) return t("{n} h", { n: Math.floor(s / 3600) });
  if (s < 7 * 86_400) return t("{n} d", { n: Math.floor(s / 86_400) });
  const d = new Date(ms);
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, thisYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** The card's state sentence: status dot (as in the pill) and one sentence; or null if the chat is idle. */
export type StateSet = { point: string; pulse: boolean; text: string; tone: string };

/**
 * What the chat is doing right now, in ONE sentence.
 *
 * Two sources, one rule: “running” is ALWAYS decided by the live set (`live`, the global stream); the state of `/api/active-runs`
 * (`runs`, up to a few seconds old) only supplies start time, phase and details. If the chat runs according to the live set but is
 * missing from the state, it says “running” without “for”; if the state says “running” but the set does not, the set wins.
 * `runs === null` means “no state” (not loaded, too old or an error): that is unknown, not “idle”, so no question or limit row appears
 * that might or might not be right.
 */
export function stateSet({ live, unread, runs, now, t }: {
  live: boolean;
  unread: boolean;
  // The open approval card of the old manager chat is gone with the manager teardown, and so is the phase `RUN_PHASES.approval`: the
  // server reports it in no run.
  runs: ActiveRun[] | null;
  now: number;
  t: Translator;
}): StateSet | null {
  const main = runs?.find((r) => r.kind !== "dynworkflow") ?? null;
  const dyn = runs?.find((r) => r.kind === "dynworkflow") ?? null;
  const set = (ph: { label: string; text: string; point: string; pulse: boolean }, header: string, details: string[]) => ({
    point: ph.point, pulse: ph.pulse, tone: ph.text,
    text: [header, ...details.slice(0, 3)].filter(Boolean).join(" · "),
  });
  if (live) {
    // The run itself: computing or waiting (monitor, background, wake time). A question or approval stops the run; the state's phase
    // says so if it is one of these two.
    const ph = main ? runPhase(main) : RUN_PHASES.running;
    const running = !main || main.phase === "running";
    const header = running
      ? main?.startedAt ? t("running for {duration}", { duration: elapsed(now - main.startedAt) }) : t("running")
      : t(ph.label);
    return set(running ? RUN_PHASES.running : ph, header, main ? runDetails(main, t, { context: false }) : []);
  }
  // If the run is idle according to the live set, only what waits WITHOUT a turn counts from the state: question, limit.
  if (main && (main.phase === "ask" || main.phase === "limit")) {
    const ph = runPhase(main);
    return set(ph, t(ph.label), runDetails(main, t, { context: false }));
  }
  // A dynamic workflow keeps running outside the turn: it does not hold the chat, but it works.
  if (dyn) return set(RUN_PHASES.running, t("Dynamic workflow"), [dyn.dynWorkflow?.name ?? "", ...runDetails(dyn, t, { context: false })].filter(Boolean));
  if (main && (main.background.agents || main.background.tasks)) {
    return set(RUN_PHASES.waiting, t("in the background"), runDetails(main, t, { context: false }));
  }
  if (unread) return { point: "bg-accent", pulse: false, tone: "text-accent", text: t("New reply") };
  return null;
}

/** The line of the copy the chat works in (lib/chat-location.ts `chatCopyLocation`): “Copy k1”, on its way with its state; null in main.
 *  The build phase reads like on the apps page: a copy in `build` has the instance row `create` in the same step (stacks/state.js,
 *  `coupleInstance`), so both say “being created”. */
export function copyText(copy: { name: string; state: string } | null | undefined, t: Translator): string | null {
  if (!copy) return null;
  const word: Record<string, string> = {
    waiting_queue: "waiting", waiting_storage: "waiting for memory", build: "being created", clearAway: "being removed", error: "Error",
    removed: "removed", // a binding without a live row (only in races), until `chat_meta` brings the extract
  };
  const name = t("Copy {name}", { name: copy.name });
  return word[copy.state] ? `${name} · ${t(word[copy.state])}` : name;
}
