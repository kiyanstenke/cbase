"use client";

// A view's coordinates as a hook (the computation is in lib/buffer-coordinates.ts): on the workspace level the mapping over the workspace's
// projects, on the project level the identity (except for a deeper project), in a copy the identity. As long as the list the view needs
// is missing, this hook reads it (`/api/workspaces`, ONE loader for all views of the window, lib/buffer-coordinates.ts `loadCards`) and on
// the workspace level reports `ready: false` until then (empty is not unknown — the tabs wait). The page reports every list it reads
// (app/workspaces/page.tsx, with the number of its read — an older answer does not count).
//
// Re-read: after an error with growing gap (capped, lib/buffer-coordinates.ts `repeatGap`) while a view is looking; on returning to the
// window; and when the global event stream reports a new layout of the projects (`cardsStale`: an adopted layout, an event of a project
// that has no card). Focus and stream are attached ONCE per window while a view needs coordinates. If reading fails, a waiting view shows
// the error (`waitingText`) instead of "loading…" forever.
import { useEffect, useReducer } from "react";
import { subscribeGlobalEvents } from "@/lib/api";
import {
  subscribeCards, cardWithProject, cardOf, cardsError, cardsStale, coordinatesOf, loadCards, projectOf, workspaceOf, type Coordinates,
} from "@/lib/buffer-coordinates";
import type { BufferTarget } from "@/lib/buffer";

/** What a view's edge computes (CodePane, diff tab, breadcrumbs) — ONE place, lib/buffer-coordinates.ts. */
export { inView, loadCards, renameInView } from "@/lib/buffer-coordinates";

let appended = 0;
let unhook: (() => void) | null = null;
/** Focus and event stream for the window — attached with the first view, detached with the last. */
function appendTo(): () => void {
  if (appended++ === 0) {
    const focus = () => { void loadCards(); };
    window.addEventListener("focus", focus);
    const stream = subscribeGlobalEvents((evt) => { if (cardsStale(evt)) void loadCards(); });
    unhook = () => { window.removeEventListener("focus", focus); stream(); };
  }
  let released = false;
  return () => { if (released) return; released = true; if (--appended === 0) { unhook?.(); unhook = null; } };
}

export function useCoordinates(target: BufferTarget): Coordinates {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const wid = workspaceOf(target), pid = projectOf(target);
  useEffect(() => {
    if (!wid && !pid) return; // a copy: the identity, without a card
    const off = subscribeCards(tick), stream = appendTo();
    if (wid ? !cardOf(wid) : !cardWithProject(pid)) void loadCards();
    return () => { off(); stream(); };
  }, [wid, pid]);
  return coordinatesOf(target);
}

/** The text of a view whose file is not loaded yet: "loading…" — or, while it waits for the project list and reading failed, the error
 *  (reading continues). */
export function waitingText(k: Coordinates, t: (key: string, params?: Record<string, string | number>) => string): string {
  const f = k.ready ? null : cardsError();
  return f ? t("The workspace's projects could not be read — retrying: {msg}", { msg: f }) : t("Loading…##inline");
}
