"use client";

// The state of the preview links for the UI: ONE fetch on mount, then it follows the SSE event `preview/link` — no polling
// loop. Refetched only on a cause: the access changed (window event `NGROK_ACCESS_CHANGED` from settings — mode and limit do not
// come over SSE) or the caller asks (`loadAgain`, e.g. when opening a menu).
//
// `state === null` means "no answer yet" (or the server does not know the route, e.g. an older backend): nobody then shows
// "Share link" as possible, and an event is not written into an empty list (`withLink`).
import { useCallback, useEffect, useState } from "react";
import { loadPreviewLinks, normPreviewLink, subscribeGlobalEvents, type PreviewLink, type PreviewStatus } from "@/lib/api";
import { NGROK_ACCESS_CHANGED, PREVIEW_EVENT, withLink } from "@/lib/preview-links";

export function usePreviewLinks(active = true): {
  status: PreviewStatus | null;
  loadAgain: () => void;
  /** Merge our own response (create, revoke) at once — the SSE event comes afterwards and changes nothing. */
  takeOver: (l: PreviewLink) => void;
} {
  const [state, setStatus] = useState<PreviewStatus | null>(null);
  const [cause, setCause] = useState(0);
  const loadAgain = useCallback(() => setCause((n) => n + 1), []);
  const takeOver = useCallback((l: PreviewLink) => setStatus((s) => withLink(s, l)), []);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    loadPreviewLinks()
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, [active, cause]);

  useEffect(() => {
    if (!active) return;
    const off = subscribeGlobalEvents((evt) => {
      if (evt.type !== PREVIEW_EVENT) return;
      const l = normPreviewLink(evt.link);
      if (l) setStatus((s) => withLink(s, l));
    });
    window.addEventListener(NGROK_ACCESS_CHANGED, loadAgain);
    return () => { off(); window.removeEventListener(NGROK_ACCESS_CHANGED, loadAgain); };
  }, [active, loadAgain]);

  return { status: state, loadAgain, takeOver };
}
