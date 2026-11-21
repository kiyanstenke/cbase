// The progress tree of the dynamic workflows of ONE coding chat as a hook: `useDynTree(chatId)` holds the state
// (lib/dyn-tree.ts), loads it from the route (`GET /api/chats/:id/dyn-workflows/tree`) on chat switch and after every
// reconnect of the stream (`connected`: after a reload or a dropped stream the route's state is the state), and advances it
// from the event `dynwf_tree` (`treeEvent`, called at the head of onEvent, right after the background hook). The
// transitions are computed by the pure function in lib/dyn-tree.ts, which the gate checks.
//
// Why its own hook and not the background hook (chatBackground.ts): the background hook's contract
// (composer-contract.test.mjs: call line, hook calls, the eight kinds) stays unchanged, and the tree only applies in the
// coding chat.
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { TREE_EVENT, TREE_UNLOADED, treeLoaded, treeLoading, treeAfterEvent, type DynTreeStatus } from "@/lib/dyn-tree";

export type { DynTreeStatus };

export function useDynTree(chatId: string | null) {
  const [dynTree, setDynTree] = useState<DynTreeStatus>(TREE_UNLOADED);
  const chatRef = useRef<string | null>(chatId);
  chatRef.current = chatId;

  function load(id: string) {
    setDynTree((s) => treeLoading(s));
    api<unknown>(`/api/chats/${encodeURIComponent(id)}/dyn-workflows/tree`)
      .then((response) => { if (chatRef.current === id) setDynTree((s) => treeLoaded(s, response)); })
      // Failed is not empty: the state stays "not loaded" (no "no subagent yet"); the next reconnect asks again.
      .catch(() => { if (chatRef.current === id) setDynTree((s) => ({ ...s, loading: false, buffer: [] })); });
  }

  // Chat switch: the old chat's tree no longer applies; until the route answers it is "not loaded".
  useEffect(() => {
    setDynTree(TREE_UNLOADED);
    if (chatId) load(chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Called for EVERY event of the stream; only `connected` and `dynwf_tree` do anything.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function treeEvent(evt: Record<string, any>) {
    if (evt.type !== "harness") return;
    if (evt.subtype === "connected") { if (chatRef.current) load(chatRef.current); return; }
    if (evt.subtype === TREE_EVENT) setDynTree((s) => treeAfterEvent(s, evt));
  }

  return { dynTree, treeEvent };
}
