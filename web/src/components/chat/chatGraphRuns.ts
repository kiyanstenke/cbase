// The graph-workflow starts of ONE coding chat as a hook (modelled on chatDynTree.ts): `useGraphRuns(chatId)` holds the state
// (lib/graph-runs.ts), loads it from the route (`GET /api/chats/:id/graph-workflows`) on chat switch and after every
// reconnect of the stream (`connected`: after a reload or a dropped stream the route's state is the state), and advances it
// from the event `graph_run` (`graphEvent`, called at the head of onEvent next to `treeEvent`). The transitions are computed
// by the pure function in lib/graph-runs.ts, which the gate checks.
//
// `stopGraphStart(startId)` is "Cancel" in the strip: `POST …/graph-workflows/:startId/stop { from: "human" }`; the answer
// carries the new view, the server's event the same. An error (409 `to_end`: the turn ended and the run just started)
// reloads the state and rethrows; the stage shows the message.
//
// `respondGraph(request)` is the answer in the card of a background run: `responseRequest` (lib/graph-runs.ts, bound to iOS)
// computes the request; path and body go to the CHILD chat, over the existing routes `/message`, `/ask-answer`,
// `/permission-decision`, `/dyn-workflows/approval`. The new state comes with the event `graph_run`. "No longer open" (a 409:
// the question is answered, the approval decided; and an `{ ok: false }` from `/permission-decision`: the permission is no
// longer open, the route answers 200 there) reloads the state and throws an error with `noLongerOpen: true`; any other
// error throws with the server's text. Directly over `fetch`, not `api()`: the card must tell the 409 from another error, and
// `api()` does not carry the status.
//
// `graphHidden` are the startIds whose worktree note the person clicked away: in memory ONLY, across chat switches (the
// startId is globally unique), not across a reload.
//
// Graph workflows are only started by the main agent of a coding chat (server, refusal 403 `kind`).
import { useEffect, useRef, useState } from "react";
import { api, API_BASE } from "@/lib/api";
import { GRAPH_EVENT, GRAPH_UNLOADED, graphLoaded, graphLoading, graphApply, type GraphRequest, type GraphRunsStatus, type GraphRunView } from "@/lib/graph-runs";

export type { GraphRunsStatus };

/** The error of an answer in the card: `noLongerOpen` = someone already answered (409 or `ok: false`). */
export type GraphResponseError = Error & { noLongerOpen?: boolean };

export function useGraphRuns(chatId: string | null) {
  const [graphRuns, setGraphRuns] = useState<GraphRunsStatus>(GRAPH_UNLOADED);
  const [graphHidden, setGraphHidden] = useState<ReadonlySet<string>>(() => new Set());
  const chatRef = useRef<string | null>(chatId);
  chatRef.current = chatId;

  function load(id: string) {
    setGraphRuns((s) => graphLoading(s));
    api<unknown>(`/api/chats/${encodeURIComponent(id)}/graph-workflows`)
      .then((response) => { if (chatRef.current === id) setGraphRuns((s) => graphLoaded(s, response)); })
      // Failed is not empty: the state stays as it was ("not loaded" after a chat switch); the next reconnect asks again.
      .catch(() => { if (chatRef.current === id) setGraphRuns((s) => graphLoaded(s, null)); });
  }

  // Chat switch: the old chat's starts no longer apply; until the route answers they are "not loaded". A draft without an id
  // does not load.
  useEffect(() => {
    setGraphRuns(GRAPH_UNLOADED);
    if (chatId) load(chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Called for EVERY event of the stream; only `connected` and `graph_run` do anything.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function graphEvent(evt: Record<string, any>) {
    if (evt.type !== "harness") return;
    if (evt.subtype === "connected") { if (chatRef.current) load(chatRef.current); return; }
    if (evt.subtype === GRAPH_EVENT) setGraphRuns((s) => graphApply(s, evt));
  }

  async function stopGraphStart(startId: string) {
    const id = chatRef.current;
    if (!id) return;
    try {
      const r = await api<{ run?: GraphRunView }>(
        `/api/chats/${encodeURIComponent(id)}/graph-workflows/${encodeURIComponent(startId)}/stop`,
        { method: "POST", body: JSON.stringify({ from: "human" }) },
      );
      if (chatRef.current === id) setGraphRuns((s) => graphApply(s, { type: "harness", subtype: GRAPH_EVENT, run: r?.run }));
    } catch (e) {
      if (chatRef.current === id) load(id);
      throw e;
    }
  }

  async function respondGraph(request: GraphRequest) {
    const id = chatRef.current;
    const r = await fetch(`${API_BASE}${request.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
    });
    const data = ((r.headers.get("content-type") ?? "").includes("json") ? await r.json().catch(() => null) : null) as
      { ok?: unknown; error?: unknown } | null;
    const noLongerOpen = r.status === 409 || (r.ok && data?.ok === false);
    if (r.ok && !noLongerOpen) return;
    if (noLongerOpen && id && chatRef.current === id) load(id);
    const error: GraphResponseError = new Error(typeof data?.error === "string" && data.error ? data.error : r.statusText || String(r.status));
    error.noLongerOpen = noLongerOpen;
    throw error;
  }

  function fadeGraphOut(startId: string) {
    setGraphHidden((s) => (s.has(startId) ? s : new Set([...s, startId])));
  }

  return { graphRuns, graphEvent, stopGraphStart, respondGraph, graphHidden, fadeGraphOut };
}
