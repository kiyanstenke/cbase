"use client";

import { useCallback, useEffect, useRef } from "react";

// ── Drafts: composer text not yet sent, per chat ─────────────────────
//
// Every composer used to hold its text as component-local state — a tab switch, a chat switch
// (the component remounts per chat) or a ⌘R threw it away. In the coding chat it even migrated
// into the NEXT chat on a chat switch.
//
// The draft is device state like tab and chat choice: localStorage, not the server.
// A server-side draft would be a route, a column and a conflict rule for typing
// across devices, which nobody asked for. ONLY the text is stored — attachments are server-side
// uploads on the chat, the artifact text sheet and the slash/mention state belong to the session.
//
// Key: `cbase-draft:<chatId>` (prefix like all other keys of the app). The hero
// without a chat gets `cbase-draft:new:<ws>:<project|ws>`; if the first action creates the chat,
// the entry moves with `moveDraft` to the new id.

export const DRAFT_PREFIX = "cbase-draft:";
/** Throttle of writing in ms — writing on every key press would be waste, and the
 *  rest sits in the synchronous flush on leaving. */
export const DRAFT_THROTTLE = 300;

export function draftKey(chatId: string): string {
  return DRAFT_PREFIX + chatId;
}

/** The hero without a chat: one draft per workspace and entered project. The chosen folder
 *  is deliberately NOT in the key — otherwise choosing a folder in the hero would clear the field. */
export function draftKeyNew(wsId: string, projectId: string | null | undefined): string {
  return `${DRAFT_PREFIX}new:${wsId}:${projectId ?? "ws"}`;
}


function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // access denied (private mode, embedding) — then there are no drafts
  }
}

export function readDraft(key: string | null): string {
  if (!key) return "";
  try {
    return storage()?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Empty text removes the entry — never empty entries, otherwise storage would grow with every
 *  chat that ever saw one character. */
export function writeDraft(key: string | null, text: string): void {
  if (!key) return;
  try {
    const s = storage();
    if (!s) return;
    if (text) s.setItem(key, text);
    else s.removeItem(key);
  } catch {
    /* full or blocked storage — the text stays in the field for this session */
  }
}

export function deleteDraft(key: string | null): void {
  if (!key) return;
  try {
    storage()?.removeItem(key);
  } catch {
    /* see above */
  }
}

/** Move the draft from one key to another (hero → freshly created
 *  chat). A draft at the target is overwritten if the source carries something; without a source
 *  the target stays untouched. */
export function moveDraft(from: string | null, to: string | null): void {
  if (!from || !to || from === to) return;
  const text = readDraft(from);
  deleteDraft(from);
  if (text) writeDraft(to, text);
}

export type DraftHandle = {
  /** Write pending text IMMEDIATELY — before a chat switch that refills the field. */
  flush: () => void;
  /** Discard the entry AND the pending write — after sending. A plain
   *  `deleteDraft` was not enough: the throttle would put the old text straight back. */
  erase: () => void;
};

/**
 * Holds `input` and the draft under `key` together. On a key change the draft of the
 * new key is loaded into the field (an empty one too — otherwise the text of the previous
 * chat would stay and be saved under the NEW key); every input is written throttled;
 * on leaving (unmount or key change) the rest runs synchronously via refs —
 * React's cleanup is synchronous on a route change, a beforeunload is not needed.
 *
 * `key` null means: no draft (read-only views).
 */
export function useDraft(key: string | null, input: string, setInput: (text: string) => void): DraftHandle {
  // What WOULD have to be written but is still in the throttle. Only text that was
  // RENDERED once counts — a `setInput("")` from sending becomes visible here only after
  // the render, so `erase` clears this state explicitly.
  const pendingRef = useRef<{ key: string; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setInputRef = useRef(setInput);
  setInputRef.current = setInput;

  const stop = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const flush = useCallback(() => {
    stop();
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) writeDraft(p.key, p.text);
  }, []);
  const erase = useCallback(() => {
    stop();
    pendingRef.current = null;
    deleteDraft(key);
  }, [key]);

  // Write, throttled. Stands BEFORE the key effect: on a key change it runs with the
  // still old `input` and remembers a wrong pair — the key effect below clears that
  // again after it has loaded the right text.
  useEffect(() => {
    if (!key) return;
    pendingRef.current = { key, text: input };
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingRef.current = null;
      writeDraft(key, input);
    }, DRAFT_THROTTLE);
    return stop;
  }, [key, input]);

  // Key change: load — and on leaving secure the pending text of the OLD key.
  useEffect(() => {
    if (!key) return;
    setInputRef.current(readDraft(key));
    stop();
    pendingRef.current = null;
    return flush;
  }, [key, flush]);

  return { flush, erase };
}
