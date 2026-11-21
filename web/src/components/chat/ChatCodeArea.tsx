"use client";

// The code area in the coding chat: replaces history AND composer while a code tab or "Files" is in front; chat list
// and right bar stay. The same building block as the page Coding → Files (`CodePane`) — here CONTROLLED: the tab list
// comes from chat/chatTabs.ts, the own tab row is off, the buttons of the active tab hang in the title row. The Files
// page stays uncontrolled and unchanged.
//
// Several targets: per target of open tabs (and that of the tree) ONE CodePane — the tree target's is visible, the
// others stay mounted but hidden (their content, terminal and unsaved changes live on) and do nothing while hidden
// (`active`). A diff tab sits in the pane of ITS target in place of the editor (`content`, DiffTabSwitch.tsx →
// components/code/DiffTab.tsx), the tree stays on the left; only the front diff tab is mounted, the others live in
// their draft. Likewise the Markdown preview (components/code/PreviewTab.tsx): its text from the file's buffer if it is
// open in the window, else from disk; on the right in the title row "Open Source File" and "Toggle Preview Locking"
// (the chat has no "…").
// The whole area remounts per chat (`key` = chatKey in the stage): drafts belong to the chat whose pane wrote them.
// A buffer is canonical (lib/buffer-coordinates.ts): a background tab from the diff tab opens its path IN THIS target (`inView`).
// Discard on unmount: if only ONE target's pane unmounts while the area lives, its last tab fell (after "Close anyway?",
// or the file is gone) — its unsaved changes go with it; if the whole area unmounts (chat switch), they stay in the
// buffer unless the chat was deleted (chatTabs.ts `chatIsDeleted`). `alive` falls in the layout cleanup, i.e. before the panes' cleanup.
// ⌘P (chatTabs.ts `finderOpen`) opens the command palette in "Files" mode (components/code/CommandPalette.tsx — the
// former FileFinder is this mode): with the visible editor as host (commands, `@`, `:` there), otherwise only files in the tree's target.
import { createPortal } from "react-dom";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react";
import type { Workspace } from "@/lib/api";
import { CodePane, type CodePaneControl } from "@/components/CodePane";
import { openPalette } from "@/components/code/CommandPalette";
import { visibleSource } from "@/components/code/palette-host";
import { DiffTabWrapper } from "@/components/chat/DiffTabSwitch";
import { PreviewTab } from "@/components/code/PreviewTab";
import { TitleButton } from "@/components/code/EditorTitleSymbols";
import { inputFromTab, previewKey } from "@/lib/editor-inputs";
import { NavContext } from "@/components/code/navigation-connection";
import { fileDownloadUrl } from "@/lib/api";
import { targetName } from "@/components/chat/ChatTabBar";
import { chatIsDeleted, type ChatTabsState } from "@/components/chat/chatTabs";
import { nudgeFor, fileKey, copyOf, key as keyName, targetEqual, targetKey, type TabFile, type TabPreview, type TabTarget } from "@/lib/chat-tabs";
import { findInView, inView, coordinatesOf } from "@/lib/buffer-coordinates";

type T = (key: string, params?: Record<string, string | number>) => string;

export function ChatCodeArea({ t, tabs, workspace }: { t: T; tabs: ChatTabsState; workspace: Workspace }) {
  const { status: state, activeTab, treeTarget, codeVisible } = tabs;
  // The targets in the order they were first needed — a pane never changes its place (otherwise React would remount it).
  const queue = useRef<string[]>([]);
  const targets = new Map<string, TabTarget>();
  for (const x of state.tabs) targets.set(targetKey(x.target), x.target);
  targets.set(targetKey(treeTarget), treeTarget);
  for (const k of targets.keys()) if (!queue.current.includes(k)) queue.current.push(k);
  const treeKey = targetKey(treeTarget);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dismiss = useCallback(() => alive.current || chatIsDeleted(tabsRef.current.chatKey), []);

  const control = (z: TabTarget): CodePaneControl => {
    const targetK = targetKey(z);
    const diff = activeTab?.kind === "diff" && targetEqual(activeTab.target, z) ? activeTab : null;
    const diffKey = diff ? keyName(diff) : "";
    const preview = activeTab?.kind === "preview" && targetEqual(activeTab.target, z) ? activeTab : null;
    // The location in the chat (components/code/view-locations.ts): ⌘S in the chat's bar saves the front diff, the scroll position per tab.
    const location = `chat:${tabs.chatKey}`;
    return {
      paths: state.tabs.filter((x): x is TabFile => x.kind === "file" && targetEqual(x.target, z)).map((x) => x.path),
      active: activeTab?.kind === "file" && targetEqual(activeTab.target, z) ? activeTab.path : null,
      // The front tab as key of the groups (lib/editor-inputs.ts) — the timeline also shows the diff's file.
      input: activeTab && targetEqual(activeTab.target, z) ? inputFromTab(activeTab) : null,
      content: diff ? (
        <DiffTabWrapper
          key={diffKey}
          tab={diff}
          active={codeVisible}
          actions={tabs.actions}
          draft={{ read: () => tabs.draftRead(diffKey), write: (e) => tabs.draftWrite(diffKey, e) }}
          saved={(path) => tabsRef.current.bump(diff.target, path)}
          reportUnsaved={(dirty) => tabsRef.current.reportTabUnsaved(diffKey, dirty)}
          keep={() => tabs.keep(diffKey)}
          nudge={tabs.nudge}
          openFile={(path) => tabs.open({ kind: "file", target: z, path }, { fixed: true })}
          editor={{ openInBackground: (p) => { const pf = inView(coordinatesOf(z), p.target, p.path); if (pf !== null) tabsRef.current.open({ kind: "file", target: z, path: pf }, { fixed: true, background: true }); } }}
          chatId={tabs.chatId}
          chatTarget={tabs.chatTarget}
          location={location}
        />
      ) : preview ? <ChatPreview key={keyName(preview)} t={t} tab={preview} actions={targetK === treeKey ? tabs.actions : null} nudge={tabs.nudge.seq} location={location}
          // A reference to another Markdown file (without a line): THIS preview shows it, locked or not (VS Code
          // `openMarkdownLinks: inPreview` → `this.update`); otherwise the file — as in the groups without `fixed` and at the line (the jump via NavContext).
          onReference={(path) => tabsRef.current.switchPreview(keyName(preview), path)}
          onFile={(path) => tabsRef.current.open({ kind: "file", target: z, path }, { fixed: false })}
          onDisk={(missing) => tabsRef.current.previewRead(keyName(preview), missing)}
          onSource={() => tabsRef.current.toSource(keyName(preview))}
          onLock={() => tabsRef.current.toggleLock(keyName(preview))} />
        : null,
      open: (path, o) => tabsRef.current.open({ kind: "file", target: z, path }, o),
      keep: (path) => tabsRef.current.keep(fileKey(z, path)),
      renamed: (old, fresh) => tabsRef.current.renamed(z, old, fresh),
      deleted: (path, fromOutside) => tabsRef.current.deleted(z, path, fromOutside),
      reportUnsaved: (paths) => tabsRef.current.reportUnsaved(z, paths),
      reportGit: (status) => tabsRef.current.reportGit(z, status), // the colour of the tab names
      draft: {
        read: (path) => tabsRef.current.draftRead(fileKey(z, path)),
        write: (path, e) => tabsRef.current.draftWrite(fileKey(z, path), e),
      },
      // A save in a tab nudges only the tabs of ITS target (`nudgeFor`).
      nudge: nudgeFor(tabs.nudge, z),
      saved: (path) => tabsRef.current.bump(z, path),
      treeClosed: tabs.treeClosed,
      setTreeClosed: tabs.setTreeClosed,
      treeCommand: tabs.treeCommand,
      actions: targetK === treeKey && !diff && !preview ? tabs.actions : null,
      // The chat's target asks for its git state WITH the chat — the same stock as the right bar (lib/git-state.ts), no
      // second poller; a foreign target asks its instance.
      gitChat: tabs.chatId && targetEqual(z, tabs.chatTarget) ? tabs.chatId : null,
      // An entry of the timeline opens its commit's diff as a diff tab of this target (as a preview, like a click in the tree).
      openDiff: (source, o) => tabsRef.current.open({ kind: "diff", target: z, source, title: o.title, short: o.short }, { fixed: Boolean(o.fixed) }),
      // ⇧⌘V opens the preview as a tab of this target; on it, back to the source.
      preview: {
        front: preview ? preview.path : null,
        open: (path) => tabsRef.current.openPreview(z, path),
        toSource: () => { const a = tabsRef.current.activeTab; if (a?.kind === "preview") tabsRef.current.toSource(keyName(a)); },
        lock: () => { const a = tabsRef.current.activeTab; if (a?.kind === "preview") tabsRef.current.toggleLock(keyName(a)); },
        // "Open as preview" (VS Code `markdown.reopenAsPreview`): the front file becomes the locked preview in place.
        asPreview: () => { const a = tabsRef.current.activeTab; if (a?.kind === "file") tabsRef.current.asPreview(keyName(a)); },
      },
    };
  };

  const openFromFinder = useCallback((path: string) => tabsRef.current.open({ kind: "file", target: tabsRef.current.treeTarget, path }, { fixed: true }), []);
  const closeFinder = useCallback(() => tabsRef.current.setFinderOpen(false), []);
  const areaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tabs.finderOpen) return;
    const z = tabsRef.current.treeTarget;
    const open = tabsRef.current.status.tabs.filter((x): x is TabFile => x.kind === "file" && targetEqual(x.target, z)).map((x) => x.path);
    openPalette({
      input: "",
      source: visibleSource(areaRef.current) ?? { target: z, targetName: targetName(workspace, z), open, view: null, openFile: openFromFinder, anchor: areaRef.current },
      atClose: closeFinder,
    });
  }, [tabs.finderOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={areaRef}
      className="flex min-h-0 min-w-0 flex-1"
      // A file dropped over the code area is no chat attachment: the tree uploads it (CodePane), everything else
      // discards it — the stage below never sees the drop.
      onDragOver={(e) => { e.stopPropagation(); if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); } }}
      onDrop={(e) => { e.stopPropagation(); e.preventDefault(); }}
      data-chat-code-area
    >
      {queue.current.filter((k) => targets.has(k)).map((targetK) => {
        const z = targets.get(targetK)!;
        const front = targetK === treeKey;
        return (
          <div key={targetK} className={front ? "flex min-h-0 min-w-0 flex-1" : "hidden"} data-chat-code-target={targetK}>
            <CodePane
              apiBase={z.apiBase}
              projectName={targetName(workspace, z)}
              instance={z.instance}
              copy={copyOf(z)}
              active={codeVisible && front}
              controlled={control(z)}
              dismiss={dismiss}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The Markdown preview as a chat tab: the SAME building block as in the editor groups (components/code/PreviewTab.tsx);
 *  its buffer if the file is open in the window, else the disk (re-read on every nudge of the chat — turn end, a save). */
function ChatPreview({ t, tab, actions, nudge, location, onReference, onFile: onFileOpen, onDisk, onSource, onLock }: {
  t: T; tab: TabPreview; actions: HTMLElement | null; nudge: number; location: string;
  onReference: (path: string) => void; onFile: (path: string) => void; onDisk: (missing: boolean) => void; onSource: () => void; onLock: () => void;
}) {
  const buffer = findInView(coordinatesOf(tab.target), tab.path);
  const nav = useContext(NavContext); // CodePane wraps `content` in it — the jump to the line like `openFile(path, line)` in the groups
  const onFile = (path: string, row: number | null, markdown: boolean) => {
    if (markdown && row === null) { onReference(path); return; }
    if (row !== null) nav?.rememberJump(path, { line: Math.max(0, row - 1), character: 0 });
    onFileOpen(path);
  };
  return (
    <>
      <PreviewTab t={t} target={tab.target} path={tab.path} previewKey={previewKey(tab.path)} buffer={buffer} state={nudge}
        imageUrl={(x) => fileDownloadUrl(tab.target.apiBase, x, true, tab.target.instance)} onFile={onFile} focus location={location} onDisk={onDisk} />
      {actions && createPortal(
        <div className="flex items-center gap-0.5" data-code-actions>
          <TitleButton name="file-code" title={t("Open Source File")} onClick={onSource} data={{ "data-preview-source": "" }} />
          <TitleButton name="lock" title={t("Toggle Preview Locking")} onClick={onLock} data={{ "data-preview-lock": tab.locked ? "on" : "off" }} />
        </div>,
        actions,
      )}
    </>
  );
}
