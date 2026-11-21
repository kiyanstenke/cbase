// The state of the "Outputs" folder per chat, module-wide, without a prop through ChatPane (near the line limit): the list per
// chat (for the tree under Artifacts AND for the clickable paths in every bubble), the open file and the last jump from the chat
// text. Three readers: OutputsFolder (tree), OutputsWindow (the open file, always mounted in the right bar; a jump also opens the
// bar), ChatBubbleRow (paths in the text).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MarkdownReferences } from "@/components/Markdown";
import { loadOutputs } from "@/lib/api";
import { type OutputTarget, type OutputsList, outputPathParts, pathContext } from "@/lib/outputs";

type State = { list: OutputsList | null; loading: boolean; error: string; loadedAt: number };
export type OutputsJump = { chatId: string; target: OutputTarget; seq: number };

const EMPTY: State = Object.freeze({ list: null, loading: false, error: "", loadedAt: 0 }) as State;
const statuses = new Map<string, State>();
let open: { chatId: string; path: string } | null = null;
let jump: OutputsJump | null = null;
let jumpSeq = 0;
const listeners = new Set<() => void>();
const report = () => { for (const h of listeners) h(); };
const subscription = (h: () => void) => { listeners.add(h); return () => { listeners.delete(h); }; };

/** Load the list (again). Without `force` only if it is still missing. */
export async function reloadOutputs(chatId: string, { force = false } = {}): Promise<OutputsList | null> {
  const s = statuses.get(chatId) ?? EMPTY;
  if (s.loading || (!force && s.loadedAt)) return s.list;
  statuses.set(chatId, { ...s, loading: true });
  report();
  try {
    const list = await loadOutputs(chatId);
    statuses.set(chatId, { list, loading: false, error: "", loadedAt: Date.now() });
    return list;
  } catch (e) {
    statuses.set(chatId, { ...(statuses.get(chatId) ?? EMPTY), loading: false, error: String((e as Error)?.message || e), loadedAt: Date.now() });
    return null;
  } finally { report(); }
}

/** The state of a chat; loads the list on the first reader. */
export function useOutputs(chatId: string | null): State {
  const s = useSyncExternalStore(subscription, () => (chatId ? statuses.get(chatId) ?? EMPTY : EMPTY), () => EMPTY);
  useEffect(() => { if (chatId) void reloadOutputs(chatId); }, [chatId]);
  return s;
}

/** Open a file (null closes). */
export function openOutputFile(chatId: string, path: string | null) {
  open = path ? { chatId, path } : null;
  report();
}
export const useOpenOutput = () => useSyncExternalStore(subscription, () => open, () => null);

/** A click on a path in the chat text: fresh list, the bar on Artifacts → Outputs, the file open. */
export function jumpToOutput(chatId: string, target: OutputTarget) {
  jump = { chatId, target, seq: ++jumpSeq };
  if (target.kind === "file") open = { chatId, path: target.path };
  report();
  void reloadOutputs(chatId, { force: true });
}
export const useOutputsJump = () => useSyncExternalStore(subscription, () => jump, () => null);

/**
 * The clickable paths of ONE message: a context for `MarkdownReferenceContext`. Images and links take the path from above (null),
 * only `path` is set. Without a chat or without roots `null` (the text stays as it was). `message` is the whole bubble text:
 * relative paths apply only if it names a root.
 */
export function useOutputsReferences(chatId: string | null, message: string, title: string): MarkdownReferences | null {
  const { list } = useOutputs(chatId);
  return useMemo(() => {
    const k = pathContext(list, message);
    if (!chatId || !k) return null;
    return {
      image: () => null,
      link: () => null,
      path: (text: string) => outputPathParts(text, k)?.map((t) => (t.target
        ? { text: t.text, title, open: () => jumpToOutput(chatId, t.target as OutputTarget) }
        : { text: t.text })) ?? null,
    };
  }, [chatId, list, message, title]);
}
