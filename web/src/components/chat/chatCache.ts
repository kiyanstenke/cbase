// The history cache of the coding chat as a hook: `useHistoryCache(deps)` creates the cache ref and its two useCallbacks (at
// the SAME hook position they had in ChatPane, which calls the hook there) and carries the three reconcile functions on it:
// `syncChatCache` (cheap delta, full log only on deletions), `reloadOpenChatLog` (the open chat completely from the DB,
// without touching the stream) and `revalidateChat` (reconcile of a chat that is JUST being shown from the cache). What the
// three read as closure of the component comes in as GETTER `deps` and is destructured in ONE line at the head of the
// function (`syncChatCache` reads nothing from outside). Why a getter and not an object: the hook stands before
// `loadArtifacts` (which itself reads the cache ref); an object at this point would be a TDZ. The getter reads only at the
// call, after the render, and yields the state of the same render (all are `const`s of the render; refs are passed as
// objects, `.current` is read in place). The three never run during the render (open, onEvent, send).
// `open()` (the chat switch itself, which sets 26 states of ChatPane) stays in ChatPane and calls `putChatCache` /
// `revalidateChat` from here; `loadArtifacts` and the workspace switch touch the ref, `deleteChat` calls `dropChatCache`,
// `onEvent` and `send` the two catch-ups.
//
// Whether a reconcile applies is NOT decided by `busyRef` (`busy` still belonged to the abandoned chat on a switch, the result
// dropped although the rows were already in the cache). The rules of lib/history-reconcile.ts decide (`applyReconcile`):
// applied if nothing changed the history since the start or only live bubbles stand behind it; otherwise the run reloads at
// its end (`joinedMidRunRef`) or the history at once. Plus the reconcile after every "connected" (`reconcileAfterConnected`)
// and ONE reconcile per chat at a time (`syncChatCache` queues behind the running one). Every application goes through
// React's queue (`reconcileInUpdater`, `baseAfterQueued`): the base is the history after all queued changes, not the last
// drawn one; a result whose rule fails in the updater takes the same fallback as any other; every result carries the state
// it was built from (`lastId`), and `revalidateChat` applies it as soon as it is there, never after a newer one; after
// `run_error` the reload keeps the error bubble (`errorTail`).
//
// The cache holds a WINDOW (lib/api/log-window.ts, server chats/log-window.js): `rows` is the end of the history from a bubble
// boundary, `total` the server's overall count (the reconcile computes against it, `deltaAddsUp`), `older` says whether rows
// lie before it. `loadOlder` prepends the next older page (scrolling up, jump to a row, with `until` everything up to there),
// `resolveTruncation` replaces a row truncated in the window by the full one (event `ROW_FULL_EVENT` from the unfolded tool
// row). Both run in the same queue as a chat's reconciles and apply through `applyReconcile`. A reload (deletion detected,
// run end) loads the same range (`from` = first row).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Chat, type LogDelta, type LogEntry } from "@/lib/api";
import { ROW_FULL_EVENT, deltaPath, loadWindow, loadRowFull } from "@/lib/api/log-window";
import { type ChatArtifact } from "@/components/ArtifactBrowser";
import { buildBubbles } from "@/components/chat/chatBubbles";
import type { Bubble } from "@/components/chat/chatBubbles";
import { reconcileInUpdater, reconcileNeeded, baseAfterQueued, deltaAddsUp, errorTail } from "@/lib/history-reconcile";

// What the reconcile functions read from ChatPane, one line per value, in the order of first access.
export type HistoryCacheDeps = {
  activeIdRef: { readonly current: string | null }; // read only: does the result still belong to the open chat?
  setBubbles: React.Dispatch<React.SetStateAction<Bubble[]>>;
  setCtxTokens: React.Dispatch<React.SetStateAction<number>>;
  setGoal: (target: string, paused?: boolean) => void; // goal with pause: the chat row brings both
  openSeqRef: { readonly current: number }; // read only: the running open() sequence; only the youngest switch may apply
  busyRef: { readonly current: boolean }; // read only: if a turn runs, the live stream leads the history
  loadArtifacts: (chatId: string) => Promise<unknown>; // refreshes list AND cache (stands in ChatPane behind the hook)
  // read only, at the end instead of after first access: counts every `setGoal`; if anyone set the goal since the request left
  // (pause, trash, /goal, `harness/goal`), its goal is stale
  targetStatusRef: { readonly current: number };
  // written: if a reconcile could not be applied during a run, its end reloads the history (the "joined" path)
  joinedMidRunRef: { current: boolean };
};

// A freshly fetched chat row with the goal (and pause) of the cache entry: if the goal was set since the request left, the
// entry (ChatPane `takeOverTarget` carries it along) is newer than the answer's. Without an entry the answer counts.
const withTargetOf = (chat: Chat, old: Chat | null | undefined): Chat => (old ? { ...chat, goal: old.goal, goalPaused: old.goalPaused } : chat);

/** An entry of the cache: window rows, their state (`lastId`), the server's total, whether rows lie before, bubbles, chat, artifacts. */
type CacheEntry = { rows: LogEntry[]; lastId: number; total: number; older: boolean; bubbles: Bubble[]; chat: Chat | null; artifacts: ChatArtifact[] };
/** What a caller files: without `total` the number of rows counts (a new chat, a full history), without `older` nothing lies before. */
type CacheInput = Omit<CacheEntry, "lastId" | "total" | "older"> & { total?: number; older?: boolean };

/** A reconcile result: the history built from the rows and the highest row id in it (its state). */
export type Reconcile = { bs: Bubble[]; lastId: number };

export function useHistoryCache(deps: () => HistoryCacheDeps) {
  // On a chat switch the view used to wait for the COMPLETE log; for large chats that was two to three seconds with the old
  // chat still showing. The RAW log rows are remembered (not only the finished bubbles): after a delta the history can be
  // rebuilt in one go without dragging along the reconstruction's continuation state (open tool calls, question cards,
  // assistant grouping). `lastId` is the highest seen row id, `rows.length` the cross-check against deletions.
  const chatCacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const CHAT_CACHE_MAX = 12; // enough for "jumping back and forth" without filling up memory
  // Counts every filing: ChatPane reads `windowOf` while rendering, and a new entry (older page there) redraws.
  const [, setCacheTick] = useState(0);
  const putChatCache = useCallback((id: string, e: CacheInput) => {
    const map = chatCacheRef.current;
    map.delete(id); // file anew → map order is usage order
    map.set(id, { ...e, total: e.total ?? e.rows.length, older: e.older ?? false, lastId: e.rows.length ? e.rows[e.rows.length - 1].id : 0 });
    while (map.size > CHAT_CACHE_MAX) map.delete(map.keys().next().value as string);
    setCacheTick((x) => x + 1);
  }, []);
  /** What the stage must know of the chat's window: whether rows lie before it, and which is the first loaded. */
  const windowOf = (id: string | null): { older: boolean; firstRow: number } => {
    const e = id ? chatCacheRef.current.get(id) : undefined;
    return { older: !!e?.older, firstRow: e?.rows[0]?.id ?? 0 };
  };
  // A chat whose history changed live is caught up via the delta at the next open anyway; but the cache must not count as
  // "complete" if the live stream produced bubbles not yet in `rows`. Hence: discard at run end.
  const dropChatCache = useCallback((id: string | null | undefined) => {
    if (id) chatCacheRef.current.delete(id);
  }, []);

  // Reconcile a chat's cache against the server. First the cheap delta (mostly zero new rows), and only if the total does not
  // add up, i.e. rows were DELETED (tidied partial output of an aborted run), the full log. Returns the rebuilt history, or
  // null if nothing changed (then nothing re-renders either). ONE reconcile per chat at a time: open, "connected" and run end
  // often ask at the same moment; two simultaneous deltas from the same state built two histories, and the second no longer
  // fitted the first. The second waits and asks from the state the first left behind (mostly: nothing new). The result
  // carries the state it was built from (`lastId`): the cache entry may already be newer when applying.
  const runningRef = useRef<Map<string, Promise<unknown>>>(new Map());
  function syncChatCache(id: string): Promise<Reconcile | null> {
    const prior = runningRef.current.get(id) ?? Promise.resolve();
    const p = prior.then(() => syncOnce(id), () => syncOnce(id));
    runningRef.current.set(id, p.catch(() => null));
    return p;
  }
  async function syncOnce(id: string): Promise<Reconcile | null> {
    const entry = chatCacheRef.current.get(id);
    if (!entry) return null;
    const delta = await api<LogDelta>(deltaPath(id, entry.lastId)).catch(() => null);
    if (!delta) return null;
    const complete = deltaAddsUp(entry, delta);
    if (complete && !delta.rows.length) return null;
    let rows: LogEntry[];
    let total = delta.total;
    let older = entry.older;
    if (complete) {
      rows = [...entry.rows, ...delta.rows];
    } else {
      // Something was deleted: the same range anew (from the first held row), not the full history.
      const f = await loadWindow(id, { from: entry.rows[0]?.id }).catch(() => null);
      if (!f) return null;
      ({ rows, total, older } = f);
    }
    const bs = buildBubbles(rows);
    putChatCache(id, { rows, total, older, bubbles: bs, chat: entry.chat, artifacts: entry.artifacts });
    return { bs, lastId: rows.length ? rows[rows.length - 1].id : 0 };
  }

  // Pull the OPEN chat's history completely from the DB without touching the event stream. Needed when the live stream was
  // incomplete (joined mid-run). `keepError` (after `run_error`): the error bubble exists only in the stream; read from the
  // history AFTER the queued `run_error`, appended behind the rows.
  async function reloadOpenChatLog(id: string, opts?: { keepError?: boolean }) {
    const { activeIdRef, setBubbles, setCtxTokens, setGoal, targetStatusRef } = deps();
    const error = opts?.keepError ? baseAfterQueued(setBubbles).then(errorTail) : null;
    const targetBefore = targetStatusRef.current;
    const [chat, log] = await Promise.all([
      api<Chat>(`/api/chats/${id}`).catch(() => null),
      loadWindow(id, { from: chatCacheRef.current.get(id)?.rows[0]?.id }).catch(() => null),
    ]);
    if (!log || activeIdRef.current !== id) return;
    const bs = buildBubbles(log.rows);
    const targetChanged = targetStatusRef.current !== targetBefore;
    putChatCache(id, { rows: log.rows, total: log.total, older: log.older, bubbles: bs, chat: chat && targetChanged ? withTargetOf(chat, chatCacheRef.current.get(id)?.chat) : chat, artifacts: chatCacheRef.current.get(id)?.artifacts ?? [] });
    const behind = error ? await error : [];
    if (activeIdRef.current !== id) return;
    setBubbles(behind.length ? [...bs, ...behind] : bs);
    if (chat) { setCtxTokens(chat.contextTokens ?? 0); if (!targetChanged) setGoal(chat.goal ?? "", chat.goalPaused); }
  }

  // Apply a reconcile result: `base` stood at the start, `bs` is built from the rows up to `lastId` (without it: the cache
  // entry it was just built from). If the rule (lib/history-reconcile.ts) holds, checked IN the updater against the history
  // that then really applies (a stale probe before it silently discarded a result), it replaces the history; the open answer and
  // `row` bubbles behind it stay. If it does not hold, the rows stand with the open answer behind them (`historyWithLiveTail`,
  // not the old history, which lacked the new message), and AFTER rendering: if a turn runs its end reloads, otherwise the full
  // history at once.
  function applyReconcile(id: string, base: Bubble[], bs: Bubble[], lastId = chatCacheRef.current.get(id)?.lastId ?? 0) {
    const { setBubbles, activeIdRef, busyRef, joinedMidRunRef } = deps();
    reconcileInUpdater(setBubbles, base, bs, lastId)
      .then((absorbed) => {
        if (absorbed || activeIdRef.current !== id) return;
        if (busyRef.current) joinedMidRunRef.current = true;
        else reloadOpenChatLog(id).catch(console.error);
      })
      .catch(console.error);
  }

  // After every "connected": if the server reports a different state than the cache, catch up, even if an earlier reconcile
  // could not apply its result. A re-entry MID-run does not reconcile (the stream leads, `joinedMidRun` loads at the end); the
  // FIRST one after opening does: its base is the cache, without live content. Without a cache entry (the open loader is
  // still running) the event stays remembered, and the loader then reconciles against it (`afterTheLoad`).
  const connectedRef = useRef<{ id: string; lastId?: unknown; total?: unknown } | null>(null);
  function reconcileAfterConnected(id: string, evt: { running?: unknown; lastId?: unknown; total?: unknown }, first: boolean) {
    connectedRef.current = { id, lastId: evt.lastId, total: evt.total };
    if (evt.running && !first) return;
    afterTheLoad(id);
  }
  function afterTheLoad(id: string) {
    const { setBubbles, activeIdRef } = deps();
    const entry = chatCacheRef.current.get(id);
    const c = connectedRef.current;
    if (!entry || !c || c.id !== id || !reconcileNeeded({ lastId: entry.lastId, count: entry.total }, c)) return;
    const base = baseAfterQueued(setBubbles); // after what open() and the "connected" just queued
    syncChatCache(id)
      .then(async (r) => { if (r && activeIdRef.current === id) applyReconcile(id, await base, r.bs, r.lastId); })
      .catch(console.error);
  }

  // ── The window: older pages and truncated rows ──
  // In the queue of this chat's reconciles (`runningRef`): an older page and a delta never build from the same state at once.
  function inQueue(id: string, f: () => Promise<void>): Promise<void> {
    const prior = runningRef.current.get(id) ?? Promise.resolve();
    const p = prior.then(f, f);
    runningRef.current.set(id, p.catch(() => null));
    return p;
  }
  // Replace rows and apply: from the entry as it stands AFTER loading (a reconcile in between may have renewed it). FIRST bring
  // the entry to the server's state: it holds the rows of the last load, and what has since come LIVE (the own message, the
  // tools of the running turn) is not in it. Built from it, the older page replaced the history with one WITHOUT the message
  // just sent, until the run end reloaded. The delta here runs in the same queue (`inQueue`), so `syncOnce` directly, not
  // `syncChatCache` (it would wait for itself).
  async function applyRows(id: string, base: Promise<Bubble[]>, build: (e: CacheEntry) => Partial<CacheEntry> | null) {
    const { activeIdRef } = deps();
    await syncOnce(id).catch(() => null);
    const now = chatCacheRef.current.get(id);
    const fresh = now ? build(now) : null;
    if (!now || !fresh) return;
    const rows = fresh.rows ?? now.rows;
    const bs = buildBubbles(rows);
    putChatCache(id, { ...now, ...fresh, rows, bubbles: bs });
    if (activeIdRef.current === id) applyReconcile(id, await base, bs, now.lastId);
  }
  /** Prepend the next older page of the OPEN chat; with `until` everything up to that row (jump). Nothing if nothing lies before. */
  function loadOlder(until?: number): Promise<void> {
    const { activeIdRef, setBubbles } = deps();
    const id = activeIdRef.current;
    if (!id) return Promise.resolve();
    return inQueue(id, async () => {
      const entry = chatCacheRef.current.get(id);
      const first = entry?.rows[0]?.id;
      if (!entry?.older || !first || (until !== undefined && first <= until)) return;
      const base = baseAfterQueued(setBubbles);
      const f = await loadWindow(id, { before: first, from: until }).catch(() => null);
      if (!f) return;
      await applyRows(id, base, (e) => (e.rows[0]?.id === first ? { rows: [...f.rows, ...e.rows], older: f.older } : null));
    });
  }
  /** Replace a row truncated in the window by the full one. */
  const loadingFull = useRef<Set<number>>(new Set());
  function resolveTruncation(id: string, row: number): Promise<void> {
    const { setBubbles } = deps();
    if (loadingFull.current.has(row)) return Promise.resolve();
    loadingFull.current.add(row);
    return inQueue(id, async () => {
      if (!chatCacheRef.current.get(id)?.rows.some((r) => r.id === row && r.truncated)) return;
      const base = baseAfterQueued(setBubbles);
      const full = await loadRowFull(id, row).catch(() => null);
      if (!full) return;
      await applyRows(id, base, (e) => (e.rows.some((r) => r.id === row) ? { rows: e.rows.map((r) => (r.id === row ? full : r)) } : null));
    }).finally(() => loadingFull.current.delete(row));
  }
  // The event of the unfolded tool row (AssistantBlocks.tsx `ResultText`) concerns the open chat.
  const resolveRef = useRef(resolveTruncation);
  resolveRef.current = resolveTruncation;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  useEffect(() => {
    const on = (e: Event) => {
      const row = Number((e as CustomEvent).detail);
      const id = depsRef.current().activeIdRef.current;
      if (id && Number.isInteger(row)) resolveRef.current(id, row).catch(console.error);
    };
    window.addEventListener(ROW_FULL_EVENT, on);
    return () => window.removeEventListener(ROW_FULL_EVENT, on);
  }, []);

  // Reconcile for a chat that is JUST being shown from the cache: also display the result. `base` is the history that stood at
  // the start (open(): the cache entry; otherwise the one after everything queued). Whether it applies is told not by `busyRef`
  // (it still belonged to the abandoned chat on a switch) but by the rule in `applyReconcile`. It is applied AS SOON AS the
  // reconcile is back, not only with the chat row: a newer reconcile queued behind it (the "connected") would otherwise apply
  // first and the older would overwrite it. A chat's reconciles run one after another, so their application keeps that order.
  async function revalidateChat(id: string, seq: number, base?: Bubble[]) {
    const { openSeqRef, activeIdRef, busyRef, setCtxTokens, setGoal, loadArtifacts, targetStatusRef, setBubbles } = deps();
    const prior = base ? Promise.resolve(base) : baseAfterQueued(setBubbles);
    const entry = chatCacheRef.current.get(id);
    if (!entry) return;
    const targetBefore = targetStatusRef.current;
    const applies = () => openSeqRef.current === seq && activeIdRef.current === id;
    const [chat] = await Promise.all([
      api<Chat>(`/api/chats/${id}`).catch(() => null),
      syncChatCache(id).then(async (r) => { if (r && applies()) applyReconcile(id, await prior, r.bs, r.lastId); }),
    ]);
    if (!applies()) return;
    const current = chatCacheRef.current.get(id);
    if (chat) {
      // If the goal was set since the request left, the answer's is stale: the rest of the row applies, the goal does not.
      const targetChanged = targetStatusRef.current !== targetBefore;
      if (current) current.chat = targetChanged ? withTargetOf(chat, current.chat) : chat;
      if (!busyRef.current) setCtxTokens(chat.contextTokens ?? 0);
      if (!targetChanged) setGoal(chat.goal ?? "", chat.goalPaused);
    }
    if (openSeqRef.current === seq) await loadArtifacts(id).catch(console.error);
  }

  return { chatCacheRef, putChatCache, dropChatCache, syncChatCache, reloadOpenChatLog, revalidateChat, applyReconcile, reconcileAfterConnected, afterTheLoad, loadOlder, windowOf };
}
