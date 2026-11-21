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
// blocked storage or a broken line mean "default", never "error"; the memo is a convenience, not truth.
import { useCallback, useEffect, useRef, useState } from "react";
import { loadAgenda, type Agenda, type AgendaStep } from "@/lib/api";
import { agendaFromEvent, effectiveAgenda, toggleFold, foldKey, readDeviations, type AgendaDeviations, type AgendaRow } from "@/lib/agenda";

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

/** The deviations from this chat's fold default and the click on an arrow (`toggleFold` computes, the result is remembered). */
export function useAgendaFold(chatId: string | null): [AgendaDeviations, (row: AgendaRow, steps: readonly AgendaStep[]) => void] {
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
  return [current.deviations, flip];
}
