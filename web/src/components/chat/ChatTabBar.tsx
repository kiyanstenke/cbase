"use client";

// The tab bar and title row of the code area in the Coding chat. Like VS Code: `[Chat · Name]` fixed on the left (speech
// bubble; while running, the run mark in its place), next to it the open views (Explorer, Browser, Terminal) and every
// open file and diff in opening order (a preview tab in italics, unsaved content as a dot); the bar scrolls horizontally.
// Directly after the last tab the ... menu "Explorer · Browser · Terminal", at the far right the instance choice
// (`right`, rendered by the stage). State and actions come from chat/chatTabs.ts (`ChatTabsState`); this file only draws.
//
// Form: views, file tabs and diff tabs are the SAME tiles as on the Files page (components/code/TabBar.tsx `TabTile`: as
// in VS Code, the active one carries the editor surface and an accent line on top, preview in italics, name in git/problem
// colour, folder suffix for equal names, context menu, dragging reorders); the chat tab has the same form without the X.
// While the chat is in front, the row has no ground of its own (the conversation's header). The title row below
// (`ChatTabTitle`) changes with the tab: in the chat it holds the usual header (the stage renders it itself), otherwise
// breadcrumbs or path + source of a diff and on the right the tab's buttons, which the code area attaches via
// `setActions` (save, blame, ...; the side-by-side/inline toggle).
//
// KEYBOARD (WAI-ARIA "Tabs", manual activation, lib/chat-tabs.ts `tabKey`): ONE tab stop in the list (roving tabIndex: the
// tab with focus, else the active one); Left/Right move around, Home/End to the edge, Enter/Space open, Delete closes every
// tab except the chat. The X is no tab stop and sits NEXT TO the role=tab (no button inside a tab); the ... menu and the
// instance choice sit beside the list, not in it (a tablist holds only tabs).
// Ctrl+Tab/Ctrl+Shift+Tab (chat/chatTabs.ts) never reaches the page in the BROWSER: Chrome, Safari and Firefox switch their
// own tabs before the page sees the key; there Left/Right in the bar is the way, in the desktop client both work.
import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@/lib/api";
import { FolderIcon, CbIcon, MessageIcon, svg } from "@/components/chat/ChatIcons";
import { DotsIcon, Menu, MenuEntry } from "@/components/CbKit";
import type { ChatTabsState } from "@/components/chat/chatTabs";
import {
  VIEWS, BROWSER, CHAT, FILES, TERMINAL, baseName, breadcrumbs, diffPath, projectIdOf, key as keyName, tabKey,
  type View, type CodeTab, type DiffSource, type TabTarget,
} from "@/lib/chat-tabs";
import { sourceLabel, targetPath } from "@/lib/diff-tab";
import { rootName } from "@/lib/buffer-coordinates";
import { Breadcrumbs } from "@/components/code/Breadcrumbs";
import { tabLocation } from "@/lib/tab-foreign";
import { TabTile, copyText, problemOfTheFile, tabMenu, useDiagnosticTick, useRootsUpfront, fullPath, rootNow } from "@/components/code/TabBar";
import { filesAddition, isGitKind, copyShortcut, nameAdditions, closeSet, tabColor, type CloseKind } from "@/lib/tab-bar";
import { diffName } from "@/lib/editor-inputs";
import { isMarkdown, previewTitle } from "@/lib/md-preview";
import { TitleSymbolSvg } from "@/components/code/EditorTitleSymbols";

type T = (key: string, params?: Record<string, string | number>) => string;

/** The name of a target: the project, else the workspace. */
export function targetName(workspace: Workspace, z: TabTarget): string {
  const pid = projectIdOf(z);
  return pid ? workspace.projects.find((p) => p.id === pid)?.name ?? pid : workspace.name;
}

/** What a tab is called: the file name, for a whole commit its subject, for a stash its name. As in VS Code a change carries
 *  its side ("(Working Tree)" / "(Index)"), a commit diff its sides ("README.md (abc1234^ <-> abc1234)"); otherwise the diffs
 *  of the same file from "Changes" and "Staged Changes", a commit diff and the file tab next to it would all be called the
 *  same. ONE computation with the editor groups of the Files page (lib/editor-inputs.ts `diffName`); the Markdown preview is
 *  called "Preview README.md" (locked: "[Preview] README.md", lib/md-preview.ts `previewTitle`). */
export function tabName(tab: CodeTab, t: T): string {
  if (tab.kind === "file") return baseName(tab.path);
  if (tab.kind === "preview") { const v = previewTitle(tab.path, Boolean(tab.locked)); return t(v.key, v.values); }
  return diffName(tab.source, t, { title: tab.title, short: tab.short });
}

/** The root of a target on disk: the project path (in EVERY instance: a copy lies at its original path while running),
 *  without a project the workspace path; null if the project is not (any more) in the list. Tool paths are relativised instead. */
export function targetRoot(workspace: Workspace, z: TabTarget): string | null {
  const pid = projectIdOf(z);
  return pid ? workspace.projects.find((p) => p.id === pid)?.path ?? null : workspace.path || null;
}

/** The path of a tab relative to its target's root (for "Copy relative path" and the folder suffix): a diff via `targetPath`
 *  (repo + file; the file alone is relative to the REPO), a whole commit or a stash has none, nor does a preview (VS Code:
 *  a webview is no file: no "Copy path", no "Reveal in Explorer"). */
export function tabRelPath(tab: CodeTab): string | null {
  if (tab.kind === "preview") return null;
  if (tab.kind !== "diff") return tab.path;
  const d = diffPath(tab.source);
  return d === null ? null : targetPath(tab.source.repo, d);
}

/** Where a diff comes from: the line in the title row. The label is computed by the diff block (lib/diff-tab.ts `sourceLabel`). */
export function sourceText(q: DiffSource, t: T, short?: string): string {
  const e = sourceLabel(q, short, rootName);
  return t(e.key, e.values);
}

const DiffIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3v12" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

const TerminalIcon = () => svg(<><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></>, 14);
const BrowserIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /></>, 14);
const VIEW_ICON: Record<View, () => React.ReactNode> = { [FILES]: FolderIcon, [BROWSER]: BrowserIcon, [TERMINAL]: TerminalIcon };

/** The name of a view: the same in tab and menu. */
export function viewName(a: View, t: T): string {
  return a === FILES ? t("Explorer") : a === BROWSER ? t("Browser") : t("Terminal");
}

// The chat tab in the form of the tiles (components/code/TabBar.tsx): 35 px, hairline on the right, active with surface and accent line on top.
const tabClass = (active: boolean, width = "max-w-[280px]") =>
  `group relative flex h-[35px] ${width} shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-edge px-3 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
    active ? "bg-panel text-fg before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-accent" : "text-dim hover:text-fg"
  }`;

export function ChatTabBar({ t, tabs, chatName, right }: { t: T; tabs: ChatTabsState; chatName: string; right: React.ReactNode }) {
  const { status: state, character } = tabs;
  useDiagnosticTick();
  useRootsUpfront(state.tabs.map((x) => x.target.apiBase)); // "Copy path" writes without await
  const scroll = useRef<HTMLDivElement>(null);
  // Make the active tab visible IN its bar: by hand instead of `scrollIntoView` (which also scrolled the ancestors, see CodePane).
  useEffect(() => {
    const bar = scroll.current;
    const el = bar?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!bar || !el) return;
    const e = el.getBoundingClientRect();
    const l = bar.getBoundingClientRect();
    if (e.left < l.left) bar.scrollLeft -= l.left - e.left;
    else if (e.right > l.right) bar.scrollLeft += e.right - l.right;
  }, [state.active, state.tabs.length]);
  // Roving tabIndex: exactly ONE tab is reachable with Tab: the one with focus, else the active one; Left/Right/Home/End move,
  // Enter opens, Delete closes (lib/chat-tabs.ts `tabKey`). When focus leaves the bar, the tab stop returns to the active one.
  const [focus, setFocus] = useState<string | null>(null);
  const node = useRef(new Map<string, HTMLElement>());
  const rememberNode = (k: string) => (el: HTMLElement | null) => { if (el) node.current.set(k, el); else node.current.delete(k); };
  const queue = [CHAT, ...state.views, ...state.tabs.map(keyName)];
  const carrier = focus !== null && queue.includes(focus) ? focus : queue.includes(state.active) ? state.active : CHAT;
  const onKey = (e: React.KeyboardEvent, k: string) => {
    const copy = copyShortcut(e, { mac: tabs.mac }); // Opt+Cmd+C / Opt+Shift+Cmd+C on the focused tab
    if (copy) {
      const tab = state.tabs.find((x) => keyName(x) === k);
      const rel = tab ? tabRelPath(tab) : null, w = tab ? rootNow(tab.target.apiBase) : null;
      if (!rel) return;
      e.preventDefault();
      if (copy === "relative") copyText(rel); else if (w) copyText(fullPath(w, rel));
      return;
    }
    const r = tabKey(e.key, queue, k);
    if (!r) return;
    e.preventDefault();
    if (r.kind === "focus") { setFocus(r.target); node.current.get(r.target)?.focus(); }
    else if (r.kind === "activate") tabs.activate(r.target);
    else {
      const i = queue.indexOf(r.target);
      const afterwards = queue[i + 1] ?? queue[i - 1] ?? CHAT;
      // After closing, the neighbour; if cancelled ("Close anyway?" -> no), focus stays where it was.
      void tabs.close(r.target).then(() => requestAnimationFrame(() => {
        const whereTo = node.current.has(r.target) ? r.target : afterwards;
        setFocus(whereTo);
        node.current.get(whereTo)?.focus();
      }));
    }
  };
  const role = (k: string) => ({
    role: "tab" as const,
    tabIndex: carrier === k ? 0 : -1,
    ref: rememberNode(k),
    onFocus: () => setFocus(k),
    onKeyDown: (e: React.KeyboardEvent) => onKey(e, k),
  });
  const chatActive = state.active === CHAT;
  // Equal names get a folder suffix; the context menu closes sets (the chat tab belongs to none) one after the other; a
  // question ("Close anyway?") holds only its tab. A comparison of same-named files carries its folders itself (`filesAddition`).
  const additions = nameAdditions(state.tabs.map((tab) => ({ name: tabName(tab, t), path: tabRelPath(tab) })));
  const closable = queue.filter((k) => k !== CHAT);
  // One after the other, a cancel leaves the rest open (in the hook `closeSet`); greyed out what would hit nothing.
  const setCount = (k: string) => (kind: CloseKind) => closeSet(kind, closable, k, (y) => !tabs.unsaved.has(y)).length;
  const data = (k: string, path: string | null) => ({
    wrapper: { "data-chat-tab-wrapper": path ?? k }, close: { "data-chat-tab-close": "" }, point: { "data-chat-tab-unsaved": "" },
  });
  return (
    // px-1 + px-2 on the tab = 12 px: the chat tab's icon aligns with the title below (px-3). The ... menu and the instance
    // choice sit NEXT TO the tab list, not in it (a tablist holds only tabs); the list takes only its own width (scrolls
    // in itself if it does not fit) so the ... sits directly behind the last tab; the rest of the row is a spacer.
    <div className={`relative flex h-[35px] items-stretch ${chatActive ? "" : "bg-bg shadow-[inset_0_-1px_0_var(--color-edge)]"}`} data-chat-tabs>
      <div
        ref={tabs.setBar}
        role="tablist"
        aria-label={t("Tabs")}
        className="flex min-w-0 items-stretch"
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(null); }}
        data-chat-tab-list
      >
        <div
          {...role(CHAT)}
          aria-selected={chatActive}
          onClick={() => tabs.activate(CHAT)}
          title={character === "question" ? t("Waiting for your answer") : character === "running" ? t("Generating reply…") : character === "fresh" ? t("New reply") : t("Chat (⌘1)")}
          className={tabClass(chatActive, "max-w-[280px]")}
          data-chat-tab="chat"
          data-chat-character={character ?? ""}
        >
          {/* The speech bubble in front; the same marks as the chat list stand in ITS place: running -> turning hexagon, new
              reply -> glowing one; an open question/approval pulses. */}
          <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${character ? "text-accent" : chatActive ? "text-fg/80" : "text-dim"}`}>
            {character === "running" ? (
              <span className="inline-flex animate-[spin_2.6s_linear_infinite]"><CbIcon size={13} /></span>
            ) : character ? (
              <span className={`inline-flex drop-shadow-[0_0_4px_currentColor] ${character === "question" ? "animate-pulse" : ""}`}><CbIcon size={13} filled /></span>
            ) : (
              <MessageIcon size={14} />
            )}
          </span>
          <span className="shrink-0 font-medium">{t("Chat")}</span>
          <span className="min-w-0 truncate" data-chat-tab-name>· {chatName}</span>
        </div>
        <div ref={scroll} role="presentation" className="cb-strip flex min-w-0 items-stretch overflow-x-auto">
          {state.views.map((a) => {
            const active = state.active === a;
            const name = viewName(a, t);
            const Icon = VIEW_ICON[a];
            return (
              // A view as a tab: the same tile as a code tab, without preview and without unsaved content.
              <TabTile
                key={a}
                t={t}
                name={name}
                icon={<span className={active ? "text-fg/80" : "text-dim"}><Icon /></span>}
                active={active}
                hint={name}
                tabProps={{ ...role(a), "aria-selected": active, "aria-keyshortcuts": "Delete", "data-chat-tab": "view", "data-chat-tab-view": a }}
                data={data(a, null)}
                closeTitle={`${t("Close")} (${tabs.closeShortcut})`}
                onActivate={() => tabs.activate(a)}
                onClose={() => { void tabs.close(a); }}
                menu={() => tabMenu(t, { close: () => { void tabs.close(a); }, closeSet: (kind) => { void tabs.closeSet(kind, a); }, setCount: setCount(a), shortcut: tabs.shortcut })}
                drag={{ key: a, onDropped: (from, afterwards) => tabs.reorder(from, a, afterwards) }}
              />
            );
          })}
          {state.tabs.map((tab, i) => {
            const k = keyName(tab);
            const active = state.active === k;
            const preview = state.preview === k;
            const dirty = tabs.unsaved.has(k);
            const instance = tabs.foreignInstance(tab.target);
            const path = tab.kind === "diff" ? diffPath(tab.source) : tab.path;
            const name = tabName(tab, t);
            const git = tab.kind === "file" ? tabs.gitKindOf(tab.target, tab.path) : null;
            const color = tab.kind === "file" ? tabColor(isGitKind(git) ? git : null, problemOfTheFile(tab.target, tab.path)) : null;
            return (
              // The TAB is the label, the X sits next to it (no button inside a role=tab, no tab stop; Delete closes).
              <TabTile
                key={k}
                t={t}
                name={name}
                addition={(tab.kind === "diff" ? filesAddition(tab.source, rootName) : undefined) ?? additions[i]}
                symbolPath={tab.kind === "preview" ? null : path}
                icon={tab.kind === "preview" ? <TitleSymbolSvg name="markdown-preview" /> : <DiffIcon />}
                active={active}
                preview={preview}
                dirty={dirty}
                color={color}
                byName={instance ? <span className="shrink-0 text-[11px] text-dim">· {instance}</span> : null}
                hint={[path ?? name, tab.kind === "diff" ? sourceText(tab.source, t, tab.short) : "", instance ?? ""].filter(Boolean).join(" · ")}
                tabProps={{
                  ...role(k), "aria-selected": active, "aria-keyshortcuts": "Delete",
                  "data-chat-tab": tab.kind, "data-chat-tab-path": path ?? "", "data-chat-tab-preview": preview ? "" : undefined,
                }}
                data={data(k, path)}
                closeTitle={`${t("Close")} (${tabs.closeShortcut})`}
                onActivate={() => tabs.activate(k)}
                onKeep={() => tabs.keep(k)}
                onClose={() => { void tabs.close(k); }}
                menu={() => tabMenu(t, {
                  close: () => { void tabs.close(k); },
                  closeSet: (kind) => { void tabs.closeSet(kind, k); },
                  setCount: setCount(k),
                  relPath: tabRelPath(tab),
                  root: rootNow(tab.target.apiBase),
                  showInExplorer: tab.kind === "file" ? () => tabs.showInExplorer(k) : undefined,
                  openPreview: tab.kind === "file" && isMarkdown(tab.path) ? () => tabs.openPreview(tab.target, tab.path) : undefined,
                  keep: () => tabs.keep(k), preview,
                  shortcut: tabs.shortcut,
                })}
                // A file carries its location: another window at the same location opens it (lib/tab-foreign.ts).
                drag={{ key: k, foreign: tab.kind === "file" ? { location: tabLocation(tab.target.apiBase, tab.target.instance), path: tab.path } : null, onDropped: (from, afterwards) => tabs.reorder(from, k, afterwards) }}
              />
            );
          })}
        </div>
      </div>
      {/* The ... directly behind the last tab: what one wants to open (with the same icon as its tab); an open view
          comes only to the front. */}
      <Menu
        label={t("Open view")}
        width={180}
        alignment="left"
        button={{
          content: <DotsIcon />,
          className: "mb-0.5 grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg",
          data: { "data-chat-tab-more": "" },
        }}
      >
        {VIEWS.map((a) => (
          <MenuEntry key={a} icon={VIEW_ICON[a]()} label={viewName(a, t)} onClick={() => tabs.openView(a)} data={{ "data-chat-view-open": a }} />
        ))}
      </Menu>
      <div className="min-w-0 flex-1" aria-hidden />
      {right && <div className="mb-0.5 flex min-w-0 shrink items-center pl-1">{right}</div>}
    </div>
  );
}

/** The title row while a code tab or the Explorer is in front: breadcrumbs or path and source, on the right the tab's buttons. */
export function ChatTabTitle({ t, tabs, workspace }: { t: T; tabs: ChatTabsState; workspace: Workspace }) {
  const tab = tabs.activeTab;
  const target = tab?.target ?? tabs.chatTarget;
  const instance = tabs.foreignInstance(target);
  const path = tab ? (tab.kind === "diff" ? diffPath(tab.source) : tab.path) : null;
  const parts = path ? breadcrumbs(path) : [];
  return (
    // `@container/chattitle`: a diff tab's side-by-side/inline toggle shows its label by the width of THIS row.
    <div className="@container/chattitle relative flex h-9 items-center gap-2 border-b border-edge px-3 text-[12.5px]" data-chat-tab-title={tab?.kind ?? "files"}>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-dim">
        <span className="shrink-0">{targetName(workspace, target)}</span>
        {instance && <span className="shrink-0">· {instance}</span>}
        {tab ? (
          <>
            {parts.map((g, i) => (
              <span key={i} className={`flex min-w-0 items-center gap-1 ${i === parts.length - 1 ? "text-fg" : "shrink-0"}`}>
                <span aria-hidden className="text-dim/70">›</span>
                <span className="truncate">{g}</span>
              </span>
            ))}
            {/* Behind a file tab's path, the symbols at the insertion point (path > class > function). */}
            {tab.kind === "file" && <Breadcrumbs target={tab.target} path={tab.path} />}
            {!path && <span className="truncate text-fg"><span aria-hidden className="text-dim/70">› </span>{tabName(tab, t)}</span>}
            {/* The source takes only the space the name leaves over (basis 0, grows up to its width, else ellipsis); below 360 px
                it drops out entirely, since the tab already names the side. With a fixed shrink-0 the file name vanished
                next to it when narrow, and a mere shrink weight left it a fraction of a pixel of overflow: enough for an ellipsis. */}
            {tab.kind === "diff" && <span className="ml-2 hidden min-w-0 max-w-max grow base-0 truncate rounded-full bg-hover px-2 py-[1px] text-[11px] text-dim @[360px]/chattitle:block" data-chat-tab-source>{sourceText(tab.source, t, tab.short)}</span>}
          </>
        ) : (
          <span className="truncate"><span aria-hidden className="text-dim/70">› </span>{t("Explorer")}</span>
        )}
      </div>
      <div ref={tabs.setActions} className="flex shrink-0 items-center gap-0.5" data-chat-tab-actions />
    </div>
  );
}
