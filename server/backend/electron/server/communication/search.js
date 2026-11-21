// Full-text search over chats: backfilling the existing rows in batches, and the hits with an excerpt for the view `chats`
// with `search` (read.js). The index itself (FTS5, triggers, state) is kept by store/chat-search.js.
//
// The backfill runs in the background — triggered by the restart grace (hook "restartGrace", registered in server.js) and by
// every search that meets an incomplete index (a batch that threw would otherwise end it until the next server start; after
// a failure at most once per BACKFILL_AGAIN_MS, otherwise every search would write the same error to the log), batch by
// batch with a free round of the event loop in between (`setImmediate`, no pause): it does not block the start, and
// requests get their turn between two batches. If one is running, no second one starts. Until it is done, the view says so.
//
// The search in two steps: first WHICH chats match and how often (without a cap — membership in the list), then the
// excerpts only for the chats the view shows (per chat the best HITS_PER_CHAT). One query for the best N messages over all
// chats would let a chat with many hits silently crowd out all others.
//
// The same search also finds the summarizers' notes (store/outer-loop.js outerLoopNoteSearch — an index of its own,
// summarizers only). A chat whose note matches belongs in the list; its note hits come BEFORE the message hits, with
// `role: "note"`, and count in `matching`. The note search does not depend on the message index: if one is missing, the
// other keeps searching.

import * as store from "../store.js";

export const BACKFILL_STACK = 500;
export const EXCERPT_MAX = 240;
export const HITS_PER_CHAT = 3;
export const BACKFILL_AGAIN_MS = 60_000;

let running = null;
let lastFailure = 0;

/**
 * Backfill the existing rows, batch by batch, until the boundary is reached. → the number of batches (promise). A second
 * call while one is running gets the same promise.
 */
export function bringAlongChatSearch({ stack = BACKFILL_STACK } = {}) {
  if (running) return running;
  running = (async () => {
    let n = 0;
    try {
      // The free round BEFORE every batch, also before the first: whoever triggers (restart grace, a search) answers first.
      for (;;) {
        await new Promise((further) => setImmediate(further));
        const r = store.chatSearchStack(stack);
        n += 1;
        if (r.finished) break;
      }
    } catch (e) {
      lastFailure = Date.now();
      console.error("[chat-search] backfill:", e?.message || e);
    } finally {
      running = null;
    }
    return n;
  })();
  return running;
}

/** Is a backfill running right now? */
export const chatSearchBackfillRunning = () => running !== null;

/** Consumer of the hook "restartGrace": triggers the backfill, does not wait. */
export function chatSearchRestartGraceHook() {
  if (!store.chatSearchComplete()) bringAlongChatSearch().catch(() => {});
}

// Lower case without diacritics — like the index (`remove_diacritics 2`) — with a mapping of every position of the folded
// text to the position in the unfolded one ("fur" finds "für" in the index, so the excerpt must find it too).
function fold(text) {
  let folded = "";
  const place = [];
  let i = 0;
  for (const z of text) {
    const f = z.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    folded += f;
    for (let k = 0; k < f.length; k += 1) place.push(i);
    i += z.length;
  }
  return { folded, place };
}

/** A short excerpt around the first word found — one line, at most EXCERPT_MAX characters, with "…" at truncated ends. */
export function excerpt(text, words, max = EXCERPT_MAX) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const { folded, place } = fold(flat);
  const hits = words.map((w) => folded.indexOf(fold(String(w)).folded)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const pos = hits === undefined ? 0 : place[hits] ?? 0;
  // One character per "…", and only at an end where text is missing — a word at the end of the text is not cut this way.
  const start = Math.max(0, Math.min(pos - Math.floor(max / 3), flat.length - (max - 1)));
  let length = max - (start > 0 ? 1 : 0);
  if (start + length < flat.length) length -= 1;
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + length)}${start + length < flat.length ? "…" : ""}`;
}

/**
 * The search in the chats `chatIds` (those the reader may read — the caller filters with the predicate). → `{ available,
 * complete, ignored, matching: Map<chatId, number of matching messages>, hitsFor(ids) }` — `matching` without a cap,
 * `hitsFor` returns for the chats shown at most HITS_PER_CHAT `{ role, at, excerpt }` each (Map), `ignored` counts the
 * search words beyond CHAT_SEARCH_WORDS_MAX.
 */
export function searchInChats(request, chatIds) {
  const available = store.chatSearchAvailable();
  const { words, ignored } = store.chatSearchRequest(request);
  // The summarizers' notes — per chat the hits in bm25 order.
  const notes = new Map();
  for (const n of store.outerLoopNoteSearch(request, chatIds)) {
    const list = notes.get(n.chatId) || [];
    list.push(n);
    notes.set(n.chatId, list);
  }
  const withNotes = (matching) => {
    for (const [chatId, list] of notes) matching.set(chatId, (matching.get(chatId) || 0) + list.length);
    return matching;
  };
  const noteHits = (chatId) => (notes.get(chatId) || []).map((n) => ({ role: "note", at: n.at, excerpt: excerpt(n.text, words) }));
  if (!available) {
    const matching = withNotes(new Map());
    const hitsFor = (ids) => new Map((ids || []).filter((id) => notes.has(id)).map((id) => [id, noteHits(id).slice(0, HITS_PER_CHAT)]));
    return { available, complete: false, ignored, matching, hitsFor };
  }
  const complete = store.chatSearchComplete();
  if (!complete && !running && Date.now() - lastFailure >= BACKFILL_AGAIN_MS) bringAlongChatSearch().catch(() => {});
  const matching = withNotes(store.chatSearchChats(request, chatIds));
  const hitsFor = (ids) => {
    const perChat = new Map();
    const shown = (ids || []).filter((id) => matching.has(id));
    for (const id of shown) if (notes.has(id)) perChat.set(id, noteHits(id).slice(0, HITS_PER_CHAT));
    for (const t of store.chatSearchHits(request, shown, { perChat: HITS_PER_CHAT })) {
      const list = perChat.get(t.chatId) || [];
      if (list.length >= HITS_PER_CHAT) continue;
      list.push({ role: t.role, at: t.ts, excerpt: excerpt(t.text, words) });
      perChat.set(t.chatId, list);
    }
    return perChat;
  };
  return { available, complete, ignored, matching, hitsFor };
}
