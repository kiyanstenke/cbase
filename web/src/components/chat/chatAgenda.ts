// The agenda of ONE coding chat as a hook: `useAgenda(chatId)` loads it from the route (`GET /api/chats/:id/agenda`) on chat
// switch and after every reconnect of the stream (`connected`: after a reload or a dropped stream the route's state is the
// state) and takes every new revision live from the event `harness/agenda`.
//
// Why an event dispatcher instead of a hook in ChatPane (like chatDynTree.ts): only the "Agenda" section of the right bar
// needs the agenda, and only while it is open (the bar mounts only ONE section at a time). ChatPane forwards every event
// with ONE line (`agendaEvent(evt)` at the head of onEvent, next to the other hooks): no state, no prop, no line in the
// bar's interface. Whoever is listening (`AgendaPanel`) filters for ITS chat itself.
//
// Stale answers are discarded: a load for chat A that arrives after the switch to B sets nothing (`chatRef`), and a load
// answer that would overtake a NEWER revision from the stream loses to it (`effectiveAgenda`, by version).
//
// Also `useAgendaFold(chatId)`: which item is folded or unfolded against the default, per device and chat in
// `localStorage` (`cbase-agenda-fold:<chatId>`), deviations only. Reading and writing sit in try/catch: a private window,
// blocked storage or a broken line mean "default", never "error"; the memo is a convenience, not truth. Likewise
// `useAgendaDone(chatId)`: whether done points are shown (`cbase-agenda-done:<chatId>`, "1" = shown; default hidden).
//
// `useAgendaArchive` reads the archive (`GET …/agenda/archive`) page by page while the "Archive (n)" row is open, and reads it
// afresh whenever the count from the stream (`agenda.archived`) changes. `useAgendaSearch` asks the same route with `q`
// (debounced 250 ms) for the hits in the archive; the active tree is searched in the client (lib/agenda.ts searchSteps).
import { useCallback, useEffect, useRef, useState } from "react";
import { loadAgenda, loadAgendaArchive, type Agenda, type AgendaArchiveEntry, type AgendaArchiveHit, type AgendaStep } from "@/lib/api";
import { agendaFromEvent, effectiveAgenda, toggleFold, foldKey, doneKey, readDeviations, readShowDone, type AgendaDeviations, type AgendaRow } from "@/lib/agenda";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Event = Record<string, any>;
const listeners = new Set<(evt: Event) => void>();

/** Called for EVERY event of the chat stream (ChatPane, onEvent); only `connected` and `agenda` do anything, in the listeners. */
export function agendaEvent(evt: Event) {
  if (evt?.type !== "harness" || (evt.subtype !== "connected" && evt.subtype !== "agenda")) return;
  for (const h of listeners) h(evt);
}

export interface AgendaState {
  agenda: Agenda | null;
  /** false until the first answer: "no agenda yet" only shows AFTER loading (empty is not unknown). */
  loaded: boolean;
  keepsAgenda: boolean;
  error: string;
}

const BEGINNING: AgendaState = { agenda: null, loaded: false, keepsAgenda: true, error: "" };

export function useAgenda(chatId: string | null): AgendaState {
  const [state, setState] = useState<AgendaState>(BEGINNING);
  const chatRef = useRef<string | null>(chatId);
  chatRef.current = chatId;

  useEffect(() => {
    setState(BEGINNING);
    if (!chatId) return;
    const load = () => {
      loadAgenda(chatId)
        .then((s) => {
          if (chatRef.current !== chatId) return;
          setState((z) => ({ agenda: effectiveAgenda(z.agenda, s.agenda, chatId), loaded: true, keepsAgenda: s.keepsAgenda, error: "" }));
        })
        // Failed is not empty: an already shown state stays, plus the error; the next reconnect asks again.
        .catch((e: unknown) => {
          if (chatRef.current === chatId) setState((z) => ({ ...z, error: e instanceof Error ? e.message : String(e) }));
        });
    };
    const listen = (evt: Event) => {
      if (chatRef.current !== chatId) return;
      if (evt.subtype === "connected") { load(); return; }
      const fresh = agendaFromEvent(evt, chatId);
      if (fresh) setState((z) => ({ ...z, agenda: effectiveAgenda(z.agenda, fresh, chatId), loaded: true, error: "" }));
    };
    listeners.add(listen);
    load();
    return () => { listeners.delete(listen); };
  }, [chatId]);

  return state;
}

function readFold(chatId: string | null): AgendaDeviations {
  if (!chatId) return {};
  try { return readDeviations(window.localStorage.getItem(foldKey(chatId))); }
  catch { return {}; }
}

function rememberFold(chatId: string, deviations: AgendaDeviations) {
  try {
    if (Object.keys(deviations).length) window.localStorage.setItem(foldKey(chatId), JSON.stringify(deviations));
    else window.localStorage.removeItem(foldKey(chatId));
  } catch { /* not remembered: the default applies on next open */ }
}

/** The deviations from this chat's fold default, the click on an arrow (`toggleFold` computes, the result is remembered) and
 *  a whole new memo (a jump from the search unfolds the ancestors, lib/agenda.ts revealPoint). */
export function useAgendaFold(chatId: string | null): [AgendaDeviations, (row: AgendaRow, steps: readonly AgendaStep[]) => void, (deviations: AgendaDeviations) => void] {
  const [status, setStatus] = useState(() => ({ chatId, deviations: readFold(chatId) }));
  // Chat switch without remounting: the new chat's memo, in THIS render (no frame with the old one).
  const current = status.chatId === chatId ? status : { chatId, deviations: readFold(chatId) };
  if (current !== status) setStatus(current);
  const flip = useCallback((row: AgendaRow, steps: readonly AgendaStep[]) => {
    const fresh = toggleFold(current.deviations, row, steps);
    if (fresh === current.deviations || !chatId) return;
    setStatus({ chatId, deviations: fresh });
    rememberFold(chatId, fresh);
  }, [current.deviations, chatId]);
  const replace = useCallback((deviations: AgendaDeviations) => {
    if (!chatId) return;
    setStatus({ chatId, deviations });
    rememberFold(chatId, deviations);
  }, [chatId]);
  return [current.deviations, flip, replace];
}

function readDone(chatId: string | null): boolean {
  if (!chatId) return false;
  try { return readShowDone(window.localStorage.getItem(doneKey(chatId))); }
  catch { return false; }
}

function rememberDone(chatId: string, shown: boolean) {
  try {
    if (shown) window.localStorage.setItem(doneKey(chatId), "1");
    else window.localStorage.removeItem(doneKey(chatId));
  } catch { /* not remembered: hidden again on next open */ }
}

/** Whether this chat's bar shows done points (default: no) and the switch; remembered per device and chat. */
export function useAgendaDone(chatId: string | null): [boolean, (shown: boolean) => void] {
  const [status, setStatus] = useState(() => ({ chatId, shown: readDone(chatId) }));
  const current = status.chatId === chatId ? status : { chatId, shown: readDone(chatId) };
  if (current !== status) setStatus(current);
  const set = useCallback((shown: boolean) => {
    if (!chatId) return;
    setStatus({ chatId, shown });
    rememberDone(chatId, shown);
  }, [chatId]);
  return [current.shown, set];
}

/** A page of the archive is this long; "Load more" asks for the next one. */
export const ARCHIVE_PAGE = 30;

export interface ArchiveState {
  entries: AgendaArchiveEntry[];
  more: boolean;
  loading: boolean;
  error: string;
}

/**
 * The archive of a chat while `open`: the first page on opening and whenever the agenda's `version` changes (a restore and
 * an archive in one write keep the count, so the count alone is not enough); `more()` appends the next page (`before` = the last entry's id). Closed, nothing is read. A late answer for
 * another chat or an older request sets nothing.
 */
export function useAgendaArchive(chatId: string, version: number, open: boolean): ArchiveState & { loadMore: () => void } {
  const [state, setState] = useState<ArchiveState>({ entries: [], more: false, loading: false, error: "" });
  const ticket = useRef(0);
  useEffect(() => {
    if (!open) return;
    const mine = ++ticket.current;
    setState((z) => ({ ...z, loading: true, error: "" }));
    loadAgendaArchive(chatId, { limit: ARCHIVE_PAGE })
      .then((r) => { if (ticket.current === mine) setState({ entries: r.entries, more: r.more, loading: false, error: "" }); })
      .catch((e: unknown) => { if (ticket.current === mine) setState((z) => ({ ...z, loading: false, error: e instanceof Error ? e.message : String(e) })); });
  }, [chatId, version, open]);
  const loadMore = useCallback(() => {
    const last = state.entries[state.entries.length - 1];
    if (!last || state.loading) return;
    const mine = ++ticket.current;
    setState((z) => ({ ...z, loading: true, error: "" }));
    loadAgendaArchive(chatId, { limit: ARCHIVE_PAGE, before: last.id })
      .then((r) => {
        if (ticket.current !== mine) return;
        setState((z) => {
          const known = new Set(z.entries.map((e) => e.id));
          return { entries: [...z.entries, ...r.entries.filter((e) => !known.has(e.id))], more: r.more, loading: false, error: "" };
        });
      })
      .catch((e: unknown) => { if (ticket.current === mine) setState((z) => ({ ...z, loading: false, error: e instanceof Error ? e.message : String(e) })); });
  }, [chatId, state.entries, state.loading]);
  return { ...state, loadMore };
}

/** Debounce of the archive search — typing does not ask the server per key. */
export const SEARCH_DEBOUNCE_MS = 250;

/** The ARCHIVED hits of a query (the server searches both; the active ones the client computes itself). Empty query: none. */
export function useAgendaArchiveSearch(chatId: string, query: string, count: number, version: number): { hits: AgendaArchiveHit[]; more: boolean; searching: boolean } {
  const [state, setState] = useState<{ q: string; hits: AgendaArchiveHit[]; more: boolean }>({ q: "", hits: [], more: false });
  const q = query.trim();
  useEffect(() => {
    if (!q || count === 0) { setState({ q, hits: [], more: false }); return; }
    let stale = false;
    const h = setTimeout(() => {
      loadAgendaArchive(chatId, { q, limit: 1 })
        .then((r) => { if (!stale) setState({ q, hits: r.hits.filter((x) => x.archived), more: r.hitsMore }); })
        .catch(() => { if (!stale) setState({ q, hits: [], more: false }); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { stale = true; clearTimeout(h); };
  }, [chatId, q, count, version]);
  return { hits: state.q === q ? state.hits : [], more: state.q === q && state.more, searching: Boolean(q) && count > 0 && state.q !== q };
}
