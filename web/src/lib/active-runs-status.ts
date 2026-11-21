// The state of `GET /api/active-runs` as ONE source in the client. The "Active runs" pill loads
// through it (its 20 s / 3 s tick keeps the state warm anyway), and the chat list's short info reads
// the same state — a second poller would be a second truth.
//
// Whoever asks gets an answer whose fetch began AFTER the question — unless the caller explicitly
// carries over (`carryOver`). A call during a running fetch must not return that fetch's promise: a
// reload after an event (`run`, batched 400 ms) would hang on a fetch that began BEFORE the event,
// and pill and card would show the finished run as running until the next tick (20 s). So such a call
// waits for the running fetch to end and then starts its own; all who ask in the same gap share that
// ONE follow-up fetch. Only the short-info preload may carry over — it wants any state, not one
// after a particular event.
//
// `lib/active-runs.ts` stays import-free (its gate compiles it alone); this module is the one with
// the fetch.
import { api, type ActiveRun, type ActiveRunsView } from "@/lib/api";

export type ActiveRunsStatus = { view: ActiveRunsView; at: number };

let status: ActiveRunsStatus | null = null;
let running: Promise<ActiveRunsView> | null = null;
let following: Promise<ActiveRunsView> | null = null;
const listeners = new Set<() => void>();

/** The last loaded state with its time, or null (never loaded). */
export const activeRunsStatus = (): ActiveRunsStatus | null => status;

/** Notifies on every new state (for `useSyncExternalStore`). */
export function subscribeActiveRuns(h: () => void): () => void {
  listeners.add(h);
  return () => { listeners.delete(h); };
}

function start(): Promise<ActiveRunsView> {
  const p = api<ActiveRunsView>("/api/active-runs")
    .then((view) => {
      status = { view, at: Date.now() };
      for (const h of [...listeners]) h();
      return view;
    })
    .finally(() => { if (running === p) running = null; });
  running = p;
  return p;
}

/**
 * Loads the state. `maxAgeMs`: an existing state at most this old suffices. `carryOver`: a running
 * fetch suffices (only the short-info preload). An error throws; the old state then stays (the pill
 * does not clear its display on a hiccup), and whoever reads it sees its age.
 */
export function loadActiveRuns({ maxAgeMs = 0, carryOver = false }: { maxAgeMs?: number; carryOver?: boolean } = {}): Promise<ActiveRunsView> {
  if (status && maxAgeMs > 0 && Date.now() - status.at <= maxAgeMs) return Promise.resolve(status.view);
  if (!running) return start();
  if (carryOver) return running;
  // A fetch is already running and began BEFORE this question: start one of our own after it — one for all who ask in this gap.
  if (!following) {
    const beforehand = running;
    const f: Promise<ActiveRunsView> = beforehand.catch(() => undefined).then(() => {
      following = null;
      return start();
    });
    following = f;
  }
  return following;
}

/** The runs of ONE chat from a state: the chat itself (chat · ask · limit) first, then a dynamic workflow. */
export function runsOfTheChat(view: ActiveRunsView, chatId: string): ActiveRun[] {
  const own = view.items.filter((r) => r.chatId === chatId);
  return [...own.filter((r) => r.kind !== "dynworkflow"), ...own.filter((r) => r.kind === "dynworkflow")];
}
