// The reconcile rules when opening a chat. A leaf module without imports: web/test/chat-open.test.mjs transpiles and RUNS it, ChatPane
// (chat/chatCache.ts) calls it.
//
// The trap: open() showed the cache and reconciled behind it; the result was discarded while `busy` held — but `busy` still belonged to
// the chat that had been LEFT. The rows were already in the cache (lastId moved on), every later reconcile found nothing, and the new
// message was missing until the chat was opened again. If the target chat itself was running, the "connected(running)" discarded the
// result likewise, and the stream text was seeded onto the OLD bubbles. Two rules replace "only without busy":
//
//   1. `historyAfterReconcile`: a result is applied if nothing has changed the history since opening (the same list) or only live
//      bubbles stand behind it that the rows do not contain — the open response of the running turn (`streaming`) and rows from the
//      event `row` beyond the state. Otherwise `null`: the caller shows the rows with the open response behind them and reloads at the
//      end of the run (if a turn is running, `historyWithLiveTail`) or reloads immediately.
//   2. `reconcileNeeded`: the "connected" reports the server's state (`lastId`/`total`); if it differs from the client's, the client
//      catches up — even if an earlier reconcile could not apply its result.

/** What the rules read on a bubble. `rowId`: the row of a `row` event, otherwise the field is missing. */
export interface ReconcileBubble {
  streaming?: boolean;
  rowId?: number;
  role?: string;
  blocks?: ReadonlyArray<ReconcileBlock>;
  liveFrom?: number; // a reopened stored response: only from this block on did it come live (chatBubbles.ts `openResponse`)
}
/** What `withLiveTail` reads on a block (`Block` from AssistantBlocks satisfies this structurally). */
export interface ReconcileBlock {
  kind?: string;
  id?: string;
  text?: string;
  done?: boolean;
}

/**
 * The rows and the live bubbles behind them as ONE history. In the middle of a turn the rows end with the STORED response of this turn
 * (tools up to `lastId`), and the open response of the stream carries the same turn — often the same calls again, because they came live
 * before the reconcile. Placed side by side that would be two bubbles and thus two collective rows, with duplicates. The history after
 * loading knows only ONE response (`buildBubbles`, `ensureAssistant`), so the open one is folded into the stored one: its blocks
 * behind it, without the calls already there (same id — the more complete one wins), and without text that is already stored. The
 * bubble stays open (`streaming`), the stream keeps writing into it. A pure error bubble stands in no row and folds nothing.
 */
function withLiveTail<B extends ReconcileBubble>(fresh: B[], alongside: B[]): B[] {
  const saved = fresh[fresh.length - 1];
  const live = alongside[0];
  const onlyError = (b: B) => !!b.blocks?.length && b.blocks.every((bl) => bl.kind === "error");
  if (!saved || !live || saved.role !== "assistant" || live.role !== "assistant" || live.streaming !== true || onlyError(saved)) {
    return [...fresh, ...alongside];
  }
  const blocks: ReconcileBlock[] = [...(saved.blocks ?? [])];
  const indexById = new Map<string, number>();
  blocks.forEach((bl, i) => { if (bl.kind === "tool" && bl.id) indexById.set(bl.id, i); });
  // If the stream reopened a stored response (chat opened mid-run, `openResponse`), only its end is live — the beginning is a response
  // from an older state, often that of the PREVIOUS turn, if the rows in between were still missing on the client.
  for (const bl of (live.blocks ?? []).slice(live.liveFrom ?? 0)) {
    if (bl.kind === "tool" && bl.id && indexById.has(bl.id)) {
      const i = indexById.get(bl.id)!;
      if (bl.done && !blocks[i].done) blocks[i] = bl;
      continue;
    }
    if ((bl.kind === "text" || bl.kind === "thinking") && typeof bl.text === "string") {
      // A text block is stored only when it is finished; live, two blocks without a tool in between are joined. What is already there
      // drops — the rest (not yet stored) stays.
      let rest = bl.text;
      for (const g of blocks) {
        if (g.kind !== bl.kind || typeof g.text !== "string" || !g.text.trim()) continue;
        if (rest.trim() === g.text.trim()) { rest = ""; break; }
        if (rest.startsWith(g.text)) rest = rest.slice(g.text.length);
      }
      if (rest.trim()) blocks.push(rest === bl.text ? bl : { ...bl, text: rest });
      continue;
    }
    blocks.push(bl);
  }
  return [...fresh.slice(0, -1), { ...saved, ...live, blocks, liveFrom: undefined } as B, ...alongside.slice(1)];
}

/**
 * Apply the result of a reconcile? `prev` is the history now, `base` the one that stood at the start of the reconcile (when opening:
 * the cache), `fresh` the one built from the rows, `lastId` the highest row id in it. → the list that should hold, or `null`.
 */
export function historyAfterReconcile<B extends ReconcileBubble>(prev: B[], base: B[], fresh: B[], lastId: number): B[] | null {
  if (prev === base) return fresh;
  if (prev.length < base.length || base.some((b, i) => prev[i] !== b)) return null; // the base itself was changed
  // What was added since the start — without the `row` bubbles that the rows already carry.
  const alongside = prev.slice(base.length).filter((b) => !(b.rowId != null && b.rowId <= lastId));
  return alongside.every((b) => b.streaming === true || b.rowId != null) ? withLiveTail(fresh, alongside) : null;
}

/**
 * If the rule did not hold WHILE a turn is running: the rows, behind them only the live bubbles at the end of `prev` (the open
 * response, `row` bubbles beyond the state). What else came in live (the user row that started the turn) is almost always already in
 * the rows — its event arrived after the server had written it; whoever kept `prev` showed it twice or, with the stale cache before it,
 * the new message not at all. The end of the run reloads anyway (`joinedMidRun`).
 */
export function historyWithLiveTail<B extends ReconcileBubble>(prev: B[], fresh: B[], lastId: number): B[] {
  let i = prev.length;
  while (i > 0 && (prev[i - 1].streaming === true || prev[i - 1].rowId != null)) i--;
  return withLiveTail(fresh, prev.slice(i).filter((b) => !(b.rowId != null && b.rowId <= lastId)));
}

/** The state of a client: highest row id and number of rows it knows (the cache entry). */
export interface HistoryStatus {
  lastId: number;
  count: number;
}

/**
 * Must a reconcile follow this "connected"? Without a state of its own (the loader of the opening is still running) no — it reconciles
 * itself after loading against the remembered "connected". Without numbers in the event (an older server) yes: looking costs an empty
 * delta.
 */
export function reconcileNeeded(status: HistoryStatus | null | undefined, evt: { lastId?: unknown; total?: unknown } | null | undefined): boolean {
  if (!status || !evt) return false;
  const lastId = Number(evt.lastId);
  const total = Number(evt.total);
  if (evt.lastId == null || evt.total == null || !Number.isFinite(lastId) || !Number.isFinite(total)) return true;
  return lastId !== status.lastId || total !== status.count;
}

/**
 * Does a delta add up to the own state (window)? `state.total` is the total the server reported at the last load — NOT the number of
 * rows the client holds: in the window (lib/api/log-window.ts) it holds only the end. A "rows in cache + delta = total" calculation
 * would never add up with a window, and every reconcile would reload. If it does not add up, rows were deleted (tidied partial output
 * of an aborted run): reload.
 */
export function deltaAddsUp(state: { total: number }, delta: { total: number; rows: readonly unknown[] }): boolean {
  return delta.total === state.total + delta.rows.length;
}

/** Should a `row` event be appended? Only if it lies beyond the own state and is not yet there. */
export function appendRow(row: { id?: unknown } | null | undefined, lastId: number, alreadyThere: (id: number) => boolean): boolean {
  const id = Number(row?.id);
  return Number.isFinite(id) && id > lastId && !alreadyThere(id);
}

// ── The history as React is about to draw it ──────────────────────────────────────────────────────────────────────────────────────
// A ref to the drawn history catches up only on RENDER. Whoever read the base from it right after a `setBubbles` (finish, addError,
// applying a reconcile) got the state before: after loading, `prev` was the meanwhile drawn one, the rule failed on identity, and the
// chat reloaded repeatedly until its catch-up counter stopped. And whoever checked the result in the updater against a stale probe
// silently discarded it (`?? prev`). Both now go through React's queue: an updater sees the history after ALL changes already queued, in
// their order.

/** A setter in the shape of React's (`setBubbles`): takes a functional updater. */
export type HistorySetter<B> = (u: (prev: B[]) => B[]) => void;

/**
 * The base of a reconcile: the history as it stands after all changes queued up to NOW — not the one drawn last. Resolves as soon as
 * React calls the updater (immediately if nothing is pending; otherwise on the next render). Changes nothing.
 */
export function baseAfterQueued<B>(set: HistorySetter<B>): Promise<B[]> {
  return new Promise((finished) => set((prev) => { finished(prev); return prev; }));
}

/**
 * Apply a reconcile result IN the updater: checked against the history that then really holds (`historyAfterReconcile`). If the rule
 * did not hold, the rows stand there with the live tail (`historyWithLiveTail` — never the old history, which lacked the rows).
 * → whether it held. The fallback (a turn is running: reload at the end of the run; otherwise immediately) is triggered by the caller
 * AFTER rendering, never in the updater — an updater has no side effect (React calls it twice in StrictMode).
 */
export function reconcileInUpdater<B extends ReconcileBubble>(set: HistorySetter<B>, base: B[], fresh: B[], lastId: number): Promise<boolean> {
  return new Promise((finished) => set((prev) => {
    const applied = historyAfterReconcile(prev, base, fresh, lastId);
    finished(applied !== null);
    return applied ?? historyWithLiveTail(prev, fresh, lastId);
  }));
}

/** What identifies an error bubble: a response consisting only of error blocks (`addError`, `run_error`). */
export interface ErrorCapable {
  role?: string;
  blocks?: ReadonlyArray<{ kind?: string }>;
}

/**
 * The error bubbles at the end of a history: `run_error` exists only in the stream, the server never writes it as a row — a reload from
 * the DB lost "Error (exit N): …", and the user saw only THAT the turn ended, not why. Whoever reloads after `run_error` appends these
 * bubbles behind the loaded rows.
 */
export function errorTail<B extends ErrorCapable>(history: readonly B[]): B[] {
  const isError = (b: B) => b.role === "assistant" && !!b.blocks?.length && b.blocks.every((bl) => bl.kind === "error");
  let i = history.length;
  while (i > 0 && isError(history[i - 1])) i--;
  return history.slice(i);
}
