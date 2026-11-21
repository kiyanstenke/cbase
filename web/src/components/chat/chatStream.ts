// The event stream of ONE chat as a hook: the five refs (connection, "already seen", waiting list until "connected", retry
// delay, watchdog), attaching/opening with the three healers, and waiting for the proof that events arrive. `activeIdRef` and
// `onEvent` come in as arguments (the switch stays in ChatPane, it carries the chat's side effects); the refs go back as an
// object, ChatPane still touches them in open(), on workspace switch, on delete and in the "connected" branch. `onEvent` is a
// hoisted function declaration in ChatPane, so the hook may be called before its line; `es.onmessage` captures the version of
// the render in which openChatStream ran.
import { useEffect, useRef } from "react";
import { API_BASE, watch, heartbeatDeadline, type Watchdog } from "@/lib/api";

export function useChatStream({ activeIdRef, onEvent }: {
  activeIdRef: React.MutableRefObject<string | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent: (evt: Record<string, any>) => void;
}) {
  const esRef = useRef<EventSource | null>(null);
  // Has this chat stream been seen before? Then every further "connected" is a RE-ENTRY with a gap before it. Reset on every
  // chat switch.
  const streamSeenRef = useRef(false);
  // Has the event stream of this chat ARRIVED at the server? `new EventSource` returns at once, but the connection stands only
  // one round trip later, and the server keeps no backlog (it adds the response to its distribution list only AFTER the
  // "connected"). If sent right after, the POST won the race: "user_message" and "run_started" fell into the gap, the history
  // stayed empty and the view stood on the hero image although the run was running. Only the "connected" proves that events
  // arrive. `ready` may FALL BACK: if the connection drops, the stream is no longer provably there. Hence a waiting list
  // instead of a one-time promise: a promise stays resolved for ever after the first time and would say "yes" at once after
  // every reconnect.
  const streamReadyRef = useRef<{ id: string; ready: boolean; waiters: Array<() => void> } | null>(null);
  // Self-healing of the chat stream: retry delay of the next attempt (doubles).
  const esRetryRef = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; delay: number }>({ timer: undefined, delay: 1000 });
  // Watchdog of the open stream against silent hanging (see `watch` in lib/api.ts).
  const esWatchdogRef = useRef<Watchdog | null>(null);

  // Wait for the "connected" of the open stream, at most `ms`. Returns whether the stream provably stands. On timeout it is
  // sent ANYWAY (a message must not fail on a hanging stream); the caller then fetches the history instead.
  function awaitChatStream(id: string, ms = 4000): Promise<boolean> {
    const pending = streamReadyRef.current;
    const es = esRef.current;
    if (!pending || pending.id !== id || !es) return Promise.resolve(false);
    // "Seen once" is NOT enough. An EventSource whose response was no 200/event-stream (gateway restart, a proxy's error page)
    // is finally CLOSED and stays so; `ready` still stood on true from before, sending took the stream for healthy and skipped
    // the history catch-up. Visible as: own message does not appear, only the working display runs, and only a reload helped.
    if (es.readyState === EventSource.CLOSED) return Promise.resolve(false);
    if (pending.ready && es.readyState === EventSource.OPEN) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        pending.waiters = pending.waiters.filter((w) => w !== wake);
        resolve(false);
      }, ms);
      pending.waiters.push(wake);
    });
  }

  // Attach this chat's event stream (from open(), after cache and full load alike).
  function attachChatStream(id: string) {
    streamSeenRef.current = false; // the first "connected" of this chat is no re-entry
    esRetryRef.current.delay = 1000;
    openChatStream(id);
  }

  // The actual connection, also the path of the self-healer. It deliberately does NOT call `attachChatStream`: `streamSeenRef`
  // must stay, otherwise the re-entry would take itself for the first and the history comparison in "connected" would be skipped.
  function openChatStream(id: string) {
    esWatchdogRef.current?.stop();
    esWatchdogRef.current = null;
    esRef.current?.close();
    clearTimeout(esRetryRef.current.timer);
    // Fresh waiting list per connection: sending waits on it so the first message does not fall into the gap before the
    // connection is up.
    streamReadyRef.current = { id, ready: false, waiters: [] };
    const es = new EventSource(`${API_BASE}/api/chats/${id}/stream`);
    es.onmessage = (e) => {
      if (activeIdRef.current !== id) return;
      let d; try { d = JSON.parse(e.data); } catch { return; } // do not let a broken SSE frame throw
      esRetryRef.current.delay = 1000; // something arrived again → reset the delay
      onEvent(d);
    };
    // An EventSource reconnects BY ITSELF on an ordinary network drop (readyState CONNECTING). It becomes finally CLOSED only
    // if the response was no 200/text-event-stream: on a gateway restart, a container recreate or a proxy's error page. After
    // that the view ran blind: no user_message, no run_done, no end of the working display. Hence its own rebuild with a
    // growing delay.
    es.onerror = () => {
      const pending = streamReadyRef.current;
      // The silent reconnect also tears a gap: until the next "connected" it is not provable that events arrive.
      if (pending && pending.id === id) pending.ready = false;
      if (es.readyState !== EventSource.CLOSED) return; // CONNECTING: EventSource continues on its own
      if (esRef.current !== es || activeIdRef.current !== id) return;
      const st = esRetryRef.current;
      clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        if (esRef.current === es && activeIdRef.current === id) openChatStream(id);
      }, st.delay);
      st.delay = Math.min(st.delay * 2, 15_000);
    };
    esRef.current = es;
    // Third healer: the stream STANDS but nothing arrives any more, neither event nor the server's 25 s heartbeat. Neither
    // `onerror` nor the focus healer saw this case (readyState stays OPEN); the view showed "Pondering…" while the answer was
    // long in the DB, and only reload helped. The re-entry brings a second "connected": if nothing runs any more, that pulls
    // the history; if something still runs, joinedMidRun loads it at run end; both without reloading the page.
    esWatchdogRef.current = watch(es, () => {
      if (esRef.current !== es || activeIdRef.current !== id) return;
      const pending = streamReadyRef.current;
      if (pending && pending.id === id) pending.ready = false; // no longer provably there
      esRetryRef.current.delay = 1000;
      openChatStream(id);
    });
  }

  // Second healer, without delay: when the window returns or the network is back, look at once. A retry timer can be throttled
  // in a background tab, and after waking from sleep that is exactly when the user looks again; a stream silent for minutes is
  // then as dead as a closed one.
  useEffect(() => {
    const check = () => {
      const id = activeIdRef.current;
      if (!id) return;
      const silent = (esWatchdogRef.current?.silence() ?? 0) > heartbeatDeadline();
      if (!esRef.current || esRef.current.readyState === EventSource.CLOSED || silent) {
        esRetryRef.current.delay = 1000;
        openChatStream(id);
      }
    };
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { esRef, streamSeenRef, streamReadyRef, esRetryRef, esWatchdogRef, awaitChatStream, attachChatStream, openChatStream };
}
