"use client";

// The switch to the diff block: a diff tab of the chat shows `components/code/DiffTab.tsx`. This file is only the ADAPTER
// from the props the code area (chat/ChatCodeArea.tsx) passes to those of the block; the block itself knows no tabs, no
// in-memory drafts and no nudge.
//
//   tab          -> `source`, `target`. If the target is the CHAT'S (lib/chat-tabs.ts `targetEqual` with `chatTarget`), the
//                   block asks with `?chat=<id>` instead of `?instance=`: the same path as the right bar, hence the same git
//                   state (lib/git-state.ts) for "stage block"; a foreign target asks its own instance. Never both
//                   (lib/bar-instance.ts, header).
//   actions      -> `buttonsIn`: up/down and the side-by-side/inline toggle sit on the right of the title row, "Open file" before them.
//   draft        -> `draft` (read ONCE on mount: the WHOLE draft with its base and the base's sha; passing only the content
//                   would let a draft on a stale base count against the new disk content) and `onDraft` (written as a
//                   FileDraft with the on-disk base; its result, false = too large to keep, goes back to the block, which says so).
//   saved        <- `onSaved`: after every save the holder nudges the other tabs of the SAME target.
//                   An inactive diff tab is UNMOUNTED (ChatCodeArea renders only the front one): its unsaved content lives
//                   only in the draft; the block stores it on unmount, the wrapper below then reports "nothing unsaved in
//                   the block", and the draft carries the dot on the tab (chat/chatTabs.ts `unsaved`).
//   reportUnsaved <- `onUnsaved`; the first input makes a preview tab permanent (typing = permanent).
//   nudge        -> `revision` (follow live): a nudge counts for this tab if it means everyone (`paths` null, turn end) or a
//                   reported path that matches ITS file (`pathMatches`); a nudge with a target (a save) only if it
//                   canonically means the same file (`sameFileInWindow`). The left side of a comparison additionally
//                   re-reads EVERY save in the window (`useLeftSaved`: Coding -> Files, another chat). Plus the target's git
//                   state: when it changes (an agent stages, the bar commits), a change re-reads, via `useGitState` with the
//                   same arguments as the code area, so the same state and no second tick. Only `change` follows (and the
//                   comparison of two files, without git: both sides, each in ITS target, lib/diff-tab.ts
//                   `followUpLocations`); commit, history, stash and the timeline comparison are history.
//   openFile  -> the "Open file" button (components/code/DiffButtons.tsx, change and commit): the file as a file tab of
//                   the same target, permanent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useGitState } from "@/lib/git-state";
import { pathMatches, targetEqual, type FileDraft, type TabDiff, type TabTarget } from "@/lib/chat-tabs";
import { followUpLocations } from "@/lib/diff-tab";
import { sameFileInWindow, useLeftSaved } from "@/components/code/comparison-connection";
import type { TabNudge } from "@/components/chat/chatTabs";
import { DiffTab } from "@/components/code/DiffTab";
import { FileOpenButton } from "@/components/code/DiffButtons";
import { diffFile } from "@/lib/editor-inputs";
import type { EditorHolder } from "@/lib/buffer";

export type DiffTabProps = {
  tab: TabDiff;
  /** The code area is in front (always while mounted; a diff tab in the background is unmounted). */
  active: boolean;
  actions: HTMLElement | null;
  draft: { read: () => FileDraft | null; write: (e: FileDraft | null) => boolean };
  /** After every save: the path relative to the target. */
  saved: (path: string) => void;
  reportUnsaved: (dirty: boolean) => void;
  keep: () => void;
  nudge: TabNudge;
  openFile: (path: string) => void;
  /** The area's editor: a rename/code action on the editable side opens changed files as background tabs. */
  editor?: EditorHolder | null;
  /** The open chat (null in a draft) and its target; a tab with the chat's target asks WITH the chat. */
  chatId: string | null;
  chatTarget: TabTarget;
  /** Where the tab lives (components/code/view-locations.ts, `chat:<chatKey>`): Cmd+S in the chat's bar and the scroll position per tab. */
  location?: string;
};

function DiffTabAdapter({ tab, active, actions, draft, saved, reportUnsaved, keep, nudge, openFile, editor = null, chatId, chatTarget, location }: DiffTabProps) {
  const t = useT();
  const { source } = tab;
  const withChat = chatId && targetEqual(tab.target, chatTarget) ? chatId : null;
  const target = useMemo<TabTarget>(() => (withChat ? { apiBase: tab.target.apiBase, instance: null } : tab.target), [withChat, tab.target]);
  const follows = useMemo(() => followUpLocations(source, tab.target), [source, tab.target]);
  // "Open file" (VS Code `git.openFile`) on a commit diff too: the file in the working tree (the same button as in the groups).
  const open = diffFile(source);
  // The draft ONCE on mount (the block reads it only on first load).
  const [first] = useState(() => draft.read());
  const back = useRef({ draft, saved, reportUnsaved, keep });
  back.current = { draft, saved, reportUnsaved, keep };
  const onDraft = useCallback((text: string | null, base: string, sha: string | null, buffer?: string) => (
    back.current.draft.write(text === null ? null : { base, content: text, at: Date.now(), ...(sha ? { sha } : {}), ...(buffer ? { buffer } : {}) })
  ), []);
  const onSaved = useCallback((path: string) => back.current.saved(path), []);
  const onUnsaved = useCallback((dirty: boolean) => {
    if (dirty) back.current.keep();
    back.current.reportUnsaved(dirty);
  }, []);

  // Follow live: the chat's nudges and the target's git state -> one counter.
  const [revision, setStatus] = useState(0);
  const seen = useRef(nudge.seq);
  useEffect(() => {
    if (nudge.seq === seen.current) return;
    seen.current = nudge.seq;
    if (!follows.length) return;
    // A save (nudge with a target) counts for the side that is the SAME file, canonically (the same file at workspace level
    // and in the project is ONE, `sameFileInWindow`); a nudge without a target (turn end, reported paths) goes through
    // `pathMatches`. The left side of a comparison re-reads a save window-wide (`useLeftSaved` below); only the others
    // are handled here, or it would read twice.
    const z = nudge.target;
    const saved = z && source.kind === "files" ? follows.filter((o) => !(targetEqual(o.target, source.leftTarget) && o.path === source.left)) : follows;
    if (z ? nudge.paths !== null && nudge.paths.some((p) => saved.some((o) => sameFileInWindow(o, { target: z, path: p })))
      : nudge.paths === null || nudge.paths.some((p) => follows.some((o) => pathMatches(o.path, p)))) setStatus((n) => n + 1);
  }, [nudge, follows, source]);
  // The left side of a comparison, saved in ANOTHER area of the window (Coding -> Files, another chat): window-wide via the
  // buffer (lib/buffer.ts `atSave`); the right side holds the buffer and is live anyway.
  useLeftSaved(source, () => setStatus((n) => n + 1));
  const git = useGitState(active && source.kind === "change" ? target.apiBase : null, withChat, withChat ? null : target.instance);
  const firstTree = useRef(true);
  useEffect(() => {
    if (!git.tree) return;
    if (firstTree.current) { firstTree.current = false; return; }
    setStatus((n) => n + 1);
  }, [git.tree]);

  return (
    <DiffTab
      source={source}
      target={target}
      bufferTarget={tab.target}
      editor={editor}
      chatId={withChat}
      draft={first}
      onDraft={onDraft}
      onSaved={onSaved}
      onUnsaved={onUnsaved}
      header={false}
      buttonsIn={actions}
      buttonsExtra={open ? <FileOpenButton t={t} onClick={() => openFile(open)} /> : null}
      state={revision}
      location={location}
    />
  );
}

/** The wrapper ChatCodeArea renders: on unmount it reports "nothing unsaved left in the block" (the dot is then carried by
 *  the draft the block stored on unmount). */
export function DiffTabWrapper(p: DiffTabProps) {
  const report = useRef(p.reportUnsaved);
  report.current = p.reportUnsaved;
  useEffect(() => () => report.current(false), []);
  return <DiffTabAdapter {...p} />;
}
