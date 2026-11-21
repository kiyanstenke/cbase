// The Coding chat's tab bar as a hook. `useChatTabs(…)` → `ChatTabsState`: the ONE tab list of the open chat (calculation
// lib/chat-tabs.ts), remembered per chat in localStorage, plus what the bar (chat/ChatTabBar.tsx), title row and code area
// (chat/ChatCodeArea.tsx → CodePane controlled) need. ChatPane stands at the line guard, so only the call is there; the stage gets the
// state as ONE prop `chatTabs`.
//
// What lives here:
//   - Loading and remembering: key `cbase-chat-tabs:<chatId>`, in the draft (New Chat before the first send) `draft@<workspaceId>`.
//     When a draft becomes a chat (the first send creates it), tabs and drafts move along, ONLY into the chat that the send of THIS
//     draft created: ChatPane reports the creation (`rememberCreationFromDraft`, in the same line that rehangs the field's text);
//     otherwise the creation time would decide, and every chat just created, from another device or agent too, would take the tabs.
//     Never into a chat that already has tabs. Written only while the bar of THIS area is visible; when it becomes visible, it
//     rereads (two ChatPanes of the same chat, Coding → Chats and Coding → Scheduled, would otherwise overwrite each other's state).
//   - Unsaved text: the code area reports per target the paths with their own changes (`reportUnsaved`) and writes drafts via
//     `draftWrite` (key `cbase-chat-tab-draft:<chat>|<tab>`); the dot on the tab stands if either says so; a tab whose target was never
//     open has only the draft. Asked ONLY on closing. Unsaved text pins a preview tab wherever it comes from (rename, code action,
//     peek, diff, another editor; not only typing in its own view), and a preview whose buffer currently carries unsaved text is
//     never replaced (lib/chat-tabs.ts `open`). A draft too big for localStorage (or storage full) lives on in this area's MEMORY: the
//     dot stays, a chat switch does not lose it, `draftWrite` returns false (the tab says "too big for a draft"), and reloading or
//     closing the window asks in the browser (beforeunload; not in the desktop client, where a beforeunload would keep the window
//     silently open).
//   - After saving in a tab, `bump(target, path)` nudges the other tabs of the SAME target (the same file as diff and as file tab
//     would otherwise see the new state only at turn end).
//   - The sign on the chat tab (`chatSign`): open question/approval before run before new answer. "New" means a run ended while the
//     code area was in front; it vanishes as soon as the chat is in front again.
//   - Follow live: a nudge `{ seq, paths }` to the code area: turn end (all) and every finished Edit/Write of the running turn (its paths).
//     The git state follows in the code area itself (useGitState, no second poller).
//   - The views (the bar's ⋯ menu): explorer, terminal and browser as tabs behind the chat (lib/chat-tabs.ts `openView`). The explorer
//     is the code area without a file; terminal and browser are drawn by the right bar itself (it owns both, with choice and copy
//     logic) via portal into the slot the stage reports (`tabView`) while the view is in front. So a chat's terminal never stands
//     twice: the bar shows a notice in its place.
//   - Shortcuts (`tabShortcut`): Cmd+P find file, Cmd+W (desktop) / Alt+W (browser) close tab, Ctrl+Tab/Ctrl+Shift+Tab cycle including
//     the chat, Cmd+1 back to the chat and into the input field. Only while this chat's bar is visible and no sheet is open; what a
//     shortcut does not take stays untouched (no preventDefault).
//   - The jump from outside (`CHAT_TAB_EVENT`): a diff or file tab in the OPEN chat.
//   - The Markdown preview as a tab: Shift+Cmd+V opens it (`openPreview`), on it back to the source (`toSource`); an unlocked one
//     follows the Markdown file in front. A link to a Markdown file switches THIS preview (`switchPreview`, the locked one too, VS Code
//     `update`); one restored from storage whose file is missing is dropped (`previewRead`, like a group's file tab).
//   - Cmd+S with focus outside the surface (the chat's bar): a diff in front saves its right side (components/code/view-locations.ts
//     `saveLocation`, location `chat:<chatKey>`; VS Code saves the active editor).
//   - Cleanup: keys of chats the server no longer knows (404), once per session. The loaded list only says whom to ask: archived and
//     empty chats appear in no list and keep their tabs; deletion happens only after the 404.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Chat } from "@/lib/api";
import { useConfirm } from "@/components/Prompts";
import { useT } from "@/lib/i18n";
import { inShell } from "@/lib/shell-bridge";
import { isMac } from "@/lib/chat-bar";
import type { PermReq } from "@/components/PermissionPrompt";
import type { Bubble } from "@/components/chat/chatBubbles";
import {
  TREE_TO_KEY, BROWSER, CHAT, CHAT_TAB_EVENT, FILES, DRAFT_PREFIX, STORAGE_PREFIX, TERMINAL, activate, cleanupCandidates, baseName, paginate,
  chatTabJumpFrom, chatSign, tabFromJump, chatTarget as computeChatTarget, fileKey, diffPath, removeFiles, draftChat, draftKey,
  keep, followUpPreview, writtenFiles, isView, emptyState, readDraft, readStatus, open, openView, close, closeShortcutText, key as keyName,
  openPreview as previewOpen, toggleLock as lockToggle, toSource as sourceBack, switchPreview as previewSwitch,
  asPreview as asPreviewOpen,
  queue, writeDraft, writeStatus, storageKey, tabShortcut, tabOf, rename, dismissesDeletedChat, migrateDrafts, waitingForHuman, targetEqual, targetKey,
  type View, type ChatSign, type CodeTab, type FileDraft, type TabState, type TabTarget,
} from "@/lib/chat-tabs";
import { writeFile } from "@/lib/diff-tab";
import { isMarkdown } from "@/lib/md-preview";
import { shortcutText, menuShortcut, closeSet, reorder as reorderList, type CloseKind } from "@/lib/tab-bar";
import type { Buffer } from "@/lib/buffer";
import { saveLocation } from "@/components/code/view-locations";
import { findInView, coordinatesOf } from "@/lib/buffer-coordinates";
import { mapInWindow, useFileFollowUp } from "@/components/code/comparison-connection";

/** The nudge to the code area: `seq` counts, `paths` null = all open tabs, otherwise the reported ones (absolute or relative); `target`
 *  set = only the tabs of this target (a save, `bump`; lib/chat-tabs.ts `nudgeFor`). */
export type TabNudge = { seq: number; paths: readonly string[] | null; target?: TabTarget | null };

// The creation of a chat from the draft: ChatPane reports it before it opens the new chat: new chat id → the draft's key. Module state:
// the area that switches is not the one that reports (ChatPane calls it before rendering with the new id).
const fromDraft = new Map<string, string>();
export function rememberCreationFromDraft(workspaceId: string, chatId: string): void { fromDraft.set(chatId, draftChat(workspaceId)); }
/** A command to the code area's tree (explorer from the ⋯ menu, Zen button): `at` lets an area only just mounted still execute "show",
 *  without an old command taking effect again on the next mount. */
export type TreeCommand = { seq: number; kind: "show" | "toggle"; at: number };
/** Terminal or browser as a tab: which view is in front and the slot the stage holds for it; the right bar draws into it. */
export type TabView = { kind: typeof TERMINAL | typeof BROWSER | null; slot: HTMLElement | null };

export type ChatTabsState = {
  /** The state's key: the chat id or `draft@<workspaceId>`. The code area remounts per key. */
  chatKey: string;
  /** The open chat id (null in the draft); the code area asks with it for the chat's git state (the same store as the bar). */
  chatId: string | null;
  status: TabState;
  chatTarget: TabTarget;
  /** The target whose tree stands on the left: the active tab's, otherwise the chat's. */
  treeTarget: TabTarget;
  activeTab: CodeTab | null;
  /** Is the code area in front (a code tab or the explorer)? Terminal and browser are not. */
  codeVisible: boolean;
  /** Is anything other than the chat in front (code area, terminal, browser)? */
  chatObscured: boolean;
  /** Terminal or browser in front, and where the right bar draws it (`setViewSlot` is reported by the stage). */
  tabView: TabView;
  setViewSlot: (el: HTMLElement | null) => void;
  /** Has the code area already been in front in this chat (or is the finder open)? Only then is it mounted. */
  codeMounted: boolean;
  character: ChatSign;
  unsaved: ReadonlySet<string>;
  /** The instance name of a target if it is NOT the chat's ("prices.ts · Copy 2"); otherwise null. */
  foreignInstance: (z: TabTarget) => string | null;
  activate: (key: string) => void;
  open: (tab: CodeTab, o?: { fixed?: boolean; background?: boolean }) => void;
  keep: (key: string) => void;
  /** Closes a tab or a view (asks about unsaved text); false: cancelled (or not open). */
  close: (key: string) => Promise<boolean>;
  /** Close a set from the tab menu, one after another; a cancel ("Close anyway?" → no) leaves the rest open (VS Code). */
  closeSet: (kind: CloseKind, key: string) => Promise<void>;
  /** The bar's ⋯ menu: open a view (or bring it to the front); the explorer then shows its tree. */
  openView: (a: View) => void;
  treeClosed: boolean;
  setTreeClosed: (closed: boolean) => void;
  treeCommand: TreeCommand;
  nudge: TabNudge;
  finderOpen: boolean;
  setFinderOpen: (isOpen: boolean) => void;
  /** The spot in the title row where the code area hangs the active tab's buttons (Save, Blame, …). */
  actions: HTMLElement | null;
  setActions: (el: HTMLElement | null) => void;
  /** The bar reports its element; the shortcuts apply only while it is visible. */
  setBar: (el: HTMLElement | null) => void;
  draftRead: (tabKey: string) => FileDraft | null;
  draftWrite: (tabKey: string, e: FileDraft | null) => boolean;
  /** After saving in a tab: the other tabs of the SAME target reread the path. */
  bump: (target: TabTarget, path: string) => void;
  reportUnsaved: (target: TabTarget, paths: readonly string[]) => void;
  /** The same for a diff tab: its building block reports whether its right side carries unsaved text. */
  reportTabUnsaved: (tabKey: string, dirty: boolean) => void;
  renamed: (target: TabTarget, old: string, fresh: string) => void;
  /** Deleted: `fromOutside` (the file was gone on "Reload") leaves every diff standing, otherwise (the explorer) a diff with the file as a
   *  side drops if it carries nothing unsaved (lib/chat-tabs.ts `removeFiles`). */
  deleted: (target: TabTarget, path: string, fromOutside: boolean) => void;
  /** The Markdown preview of `path` as a tab of target `z` (Shift+Cmd+V): pinned, right of the active one; an unlocked one of the target
   *  takes the new file in its place. */
  openPreview: (z: TabTarget, path: string) => void;
  /** Shift+Cmd+V on the preview `key` or "Open Source File": back to the source. */
  toSource: (key: string) => void;
  /** "Toggle Preview Locked to Group" for the preview `key`. */
  toggleLock: (key: string) => void;
  /** A link in the preview `key` to the Markdown file `path`: this preview shows it (VS Code `update`). */
  switchPreview: (key: string, path: string) => void;
  /** The preview `key` has read from disk; if its file is missing and the tab came from storage, it drops. */
  previewRead: (key: string, missing: boolean) => void;
  /** "Open Preview" on the file tab `key`: the locked preview in its place; with unsaved text it stays and the preview comes beside it
   *  (lib/chat-tabs.ts `asPreview`). */
  asPreview: (key: string) => void;
  /** The shortcut to close, as in the tooltip (Cmd+W in the desktop client, Alt+W in the browser). */
  closeShortcut: string;
  /** The bound shortcuts of the tab menu, as they appear there (only bound ones). */
  shortcut: { close: string } & ReturnType<typeof shortcutText>;
  /** Mac or not (for Alt+Cmd+C on the tab). */
  mac: boolean;
  /** Dragging reorders: code tabs among themselves, views among themselves (lib/tab-bar.ts `reorder`). */
  reorder: (from: string, to: string, afterwards: boolean) => void;
  /** "Reveal in Explorer View": the tab comes to the front (the tree selects it and expands its folders) and the tree is shown. */
  showInExplorer: (key: string) => void;
  /** The git state of a target (path → kind), reported by this target's code area; colours a file tab's name. */
  reportGit: (target: TabTarget, status: Readonly<Record<string, string>>) => void;
  gitKindOf: (target: TabTarget, path: string) => string | null;
};

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null): boolean => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch { return false; }
};
const allKey = (): string[] => {
  try { const out: string[] = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) out.push(k); } return out; } catch { return []; }
};
// A comparison of two files stored in the old form migrates on reading (lib/chat-tabs.ts `readStatus`); its draft first moves under the
// new key (`migrateDrafts`), otherwise the tab would stand without what was typed.
const loadStatus = (chatKey: string): TabState => {
  if (typeof window === "undefined") return emptyState();
  const raw = read(storageKey(chatKey));
  migrateDrafts(chatKey, raw, { read, write });
  return readStatus(raw);
};
/** The buffer a tab shows: a file tab its file, a diff tab with a writable side that side's file; null: none in the window. The tab
 *  names target and path of its view, the buffer is canonical (lib/buffer-coordinates.ts). */
const tabBuffer = (tab: CodeTab | null): Buffer | null => {
  if (!tab || tab.kind === "preview") return null;
  const d = tab.kind === "file" ? tab.path : writeFile(tab.source); // a diff: the editable right side (lib/diff-tab.ts)
  return d === null ? null : findInView(coordinatesOf(tab.target), d);
};

// Deleted chats of this session: their code area discards on unmount what only it held (ChatCodeArea `dismiss`), and what already lay
// without a holder `chatDeleted` discards at once; otherwise Alt+Cmd+S would later write the text of a chat that no longer exists, or
// another editor of the same file would show it as unsaved. The same buffer is also the one of Coding → Files: only what THIS chat's
// draft carries is discarded (lib/chat-tabs.ts `dismissesDeletedChat`); text typed elsewhere stays.
const deleted = new Set<string>();
export const chatIsDeleted = (chatKey: string): boolean => deleted.has(chatKey);
export function chatDeleted(chatId: string): void {
  deleted.add(chatId);
  for (const t of loadStatus(chatId).tabs) {
    const p = tabBuffer(t);
    if (dismissesDeletedChat(p, readDraft(read(draftKey(chatId, keyName(t)))))) p?.dismiss();
  }
}
/** The tab keys with a remembered draft in this chat. */
const draftTabs = (chatKey: string): Set<string> => {
  const p = `${DRAFT_PREFIX}${chatKey}|`;
  return new Set(allKey().filter((k) => k.startsWith(p)).map((k) => k.slice(p.length)));
};

let cleanedUp = false; // once per session (module state: several ChatPanes share it)

export function useChatTabs(e: {
  activeId: string | null;
  activeChat: Chat | undefined;
  workspaceId: string;
  projectId: string | null | undefined;
  activeInstance: string;
  busy: boolean;
  bubbles: Bubble[];
  permReqs: PermReq[];
  chats: Chat[];
  taRef: React.RefObject<HTMLTextAreaElement | null>;
}): ChatTabsState {
  const t = useT();
  const question = useConfirm();
  const { activeId, activeChat, workspaceId, busy, bubbles, permReqs } = e;
  const chatKey = activeId ?? draftChat(workspaceId);

  // ── State per chat ──
  // Drafts localStorage did not take (too big, full), key `draftKey(chat, tab)`; they live as long as this area lives.
  const onlyInStorage = useRef(new Map<string, FileDraft>());
  const draftTabsWithStorage = (k: string): Set<string> => {
    const s = draftTabs(k);
    const p = `${DRAFT_PREFIX}${k}|`;
    for (const key of onlyInStorage.current.keys()) if (key.startsWith(p)) s.add(key.slice(p.length));
    return s;
  };
  const [raw, setRaw] = useState<{ k: string; s: TabState; drafts: Set<string> }>(() => ({ k: chatKey, s: loadStatus(chatKey), drafts: draftTabs(chatKey) }));
  // From the draft into the chat just created (see header): remembered on the switch, decided once the chat is known.
  const takeover = useRef<{ from: string; s: TabState } | null>(null);
  if (raw.k !== chatKey) {
    // The chat switch as derived state (React: "state from the previous render"): no render with the previous chat's state under the
    // new key.
    takeover.current = raw.k.includes("@") && activeId ? { from: raw.k, s: raw.s } : null;
    setRaw({ k: chatKey, s: loadStatus(chatKey), drafts: draftTabsWithStorage(chatKey) });
  }
  const state = raw.k === chatKey ? raw.s : emptyState();
  // The previews that came from storage (not opened by the human); if their file is missing on the first read, the tab drops.
  const restored = useRef<{ k: string; keys: Set<string> } | null>(null);
  if (raw.k === chatKey && restored.current?.k !== chatKey) {
    restored.current = { k: chatKey, keys: new Set(state.tabs.filter((x) => x.kind === "preview").map(keyName)) };
  }
  const setStatus = useCallback((f: (s: TabState) => TabState) => setRaw((r) => {
    const s = f(r.s);
    return s === r.s ? r : { ...r, s };
  }), []);
  const barEl = useRef<HTMLElement | null>(null);
  // Visible = the bar of THIS area is in the document and has a surface (a hidden tab has none).
  const visible = () => { const el = barEl.current; return Boolean(el && el.isConnected && el.getClientRects().length > 0); };
  useEffect(() => {
    if (raw.k !== chatKey || !visible()) return; // a hidden area of the same chat does not write
    write(storageKey(raw.k), writeStatus(raw.s));
  }, [raw, chatKey]);
  useEffect(() => {
    const u = takeover.current;
    if (!u || !activeId || !activeChat || activeChat.id !== activeId) return;
    takeover.current = null;
    // Only into the chat the send of THIS draft created; never into another one just created.
    if (fromDraft.get(activeId) !== u.from) return;
    fromDraft.delete(activeId);
    if (!u.s.tabs.length) return;
    setRaw((r) => {
      if (r.k !== activeId || r.s.tabs.length) return r;
      const drafts = new Set(r.drafts);
      for (const k of allKey()) {
        if (!k.startsWith(`${DRAFT_PREFIX}${u.from}|`)) continue;
        const tabKey = k.slice(`${DRAFT_PREFIX}${u.from}|`.length);
        if (write(draftKey(activeId, tabKey), read(k))) { write(k, null); drafts.add(tabKey); }
      }
      for (const [k, d] of [...onlyInStorage.current]) {
        if (!k.startsWith(`${DRAFT_PREFIX}${u.from}|`)) continue;
        const tabKey = k.slice(`${DRAFT_PREFIX}${u.from}|`.length);
        onlyInStorage.current.delete(k);
        onlyInStorage.current.set(draftKey(activeId, tabKey), d);
        drafts.add(tabKey);
      }
      write(storageKey(u.from), null);
      return { k: r.k, s: u.s, drafts };
    });
  }, [activeId, activeChat]);

  // ── Targets ──
  // The chat's target follows the git bar (ChatRightSidebar `gitProjectId`): the entered project before the chat's, the chat's
  // instance only in ITS project; no choice of its own. ChatPane already passes `projectId` that way (entered project first).
  const ownProject = !activeChat || (activeChat.projectId ?? null) === (e.projectId ?? null);
  const chatTarget = useMemo(() => computeChatTarget({ workspaceId, projectId: e.projectId, instance: ownProject ? e.activeInstance : null }), [workspaceId, e.projectId, e.activeInstance, ownProject]);
  const activeTab = tabOf(state, state.active);
  const treeTarget = activeTab?.target ?? chatTarget;
  // An unlocked preview follows the Markdown file in front (VS Code: the dynamic preview shows the active Markdown editor;
  // lib/chat-tabs.ts `followUpPreview`).
  const mdFront = activeTab?.kind === "file" && isMarkdown(activeTab.path) ? activeTab : null;
  const mdFrontKey = mdFront ? keyName(mdFront) : null;
  const viewFront = state.active === TERMINAL || state.active === BROWSER ? state.active : null;
  const chatObscured = state.active !== CHAT;
  const codeVisible = chatObscured && viewFront === null;
  const [viewSlot, setViewSlot] = useState<HTMLElement | null>(null);
  const tabView = useMemo<TabView>(() => ({ kind: viewFront, slot: viewFront ? viewSlot : null }), [viewFront, viewSlot]);
  const [mounted, setMounted] = useState<string | null>(null);
  useEffect(() => { if (codeVisible) setMounted(chatKey); }, [codeVisible, chatKey]);
  const foreignInstance = useCallback((z: TabTarget): string | null => {
    // Only the instance of the same project is named; a tab of another target carries its path, not "Main".
    if (targetEqual(z, chatTarget) || z.apiBase !== chatTarget.apiBase) return null;
    const m = /\/copy-([^/]+)$/.exec(z.instance ?? "");
    return m ? t("Copy {name}", { name: m[1] }) : t("Main");
  }, [chatTarget, t]);

  // ── Unsaved text ──
  const [paneDirty, setPaneDirty] = useState<{ k: string; byPane: Record<string, string[]> }>({ k: chatKey, byPane: {} });
  const unsaved = useMemo(() => {
    const s = new Set(raw.k === chatKey ? raw.drafts : []);
    if (paneDirty.k === chatKey) for (const keys of Object.values(paneDirty.byPane)) for (const k of keys) s.add(k);
    return s as ReadonlySet<string>;
  }, [raw, paneDirty, chatKey]);
  const reportGroup = useCallback((targetK: string, keys: string[]) => {
    setPaneDirty((d) => {
      const byPane = d.k === chatKey ? d.byPane : {};
      const old = byPane[targetK] ?? [];
      if (d.k === chatKey && old.length === keys.length && old.every((k, i) => k === keys[i])) return d;
      return { k: chatKey, byPane: { ...byPane, [targetK]: keys } };
    });
  }, [chatKey]);
  const reportUnsaved = useCallback((target: TabTarget, paths: readonly string[]) => {
    reportGroup(targetKey(target), paths.map((p) => fileKey(target, p)));
  }, [reportGroup]);
  const reportTabUnsaved = useCallback((tabKey: string, dirty: boolean) => reportGroup(`tab:${tabKey}`, dirty ? [tabKey] : []), [reportGroup]);
  const draftRead = useCallback((tabKey: string) => {
    const k = draftKey(chatKey, tabKey);
    return onlyInStorage.current.get(k) ?? readDraft(read(k));
  }, [chatKey]);
  // What localStorage does not take stays in memory (the dot stays, a chat switch does not lose it), and the result says false so the
  // tab says it. An older, smaller state in localStorage is then dropped (it would be stale after a reload).
  const draftWrite = useCallback((tabKey: string, d: FileDraft | null): boolean => {
    const k = draftKey(chatKey, tabKey);
    const text = d ? writeDraft(d) : null;
    const ok = d && text === null ? false : write(k, text);
    if (d && !ok) { onlyInStorage.current.set(k, d); write(k, null); }
    else onlyInStorage.current.delete(k);
    setRaw((r) => {
      if (r.k !== chatKey) return r;
      const present = r.drafts.has(tabKey);
      if (d && !present) return { ...r, drafts: new Set(r.drafts).add(tabKey) };
      if (!d && present) { const n = new Set(r.drafts); n.delete(tabKey); return { ...r, drafts: n }; }
      return r;
    });
    return ok;
  }, [chatKey]);
  // Reloading or closing the window with a draft that lives only in memory: the browser asks. Not in the desktop client, where a
  // beforeunload would keep the window silently open (Electron shows no question); the tab says it there itself.
  useEffect(() => {
    if (inShell(window)) return;
    const beforeUnload = (ev: BeforeUnloadEvent) => { if (onlyInStorage.current.size > 0) { ev.preventDefault(); ev.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  const forget = useCallback((keys: string[]) => {
    for (const k of keys) { write(draftKey(chatKey, k), null); onlyInStorage.current.delete(draftKey(chatKey, k)); }
    setRaw((r) => {
      if (r.k !== chatKey || !keys.some((k) => r.drafts.has(k))) return r;
      const n = new Set(r.drafts);
      for (const k of keys) n.delete(k);
      return { ...r, drafts: n };
    });
  }, [chatKey]);

  useEffect(() => { if (mdFront) setStatus((s) => followUpPreview(s, mdFront.target, mdFront.path)); }, [mdFrontKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  const stateRef = useRef(state);
  stateRef.current = state;
  // If the preview carries unsaved text (reported or now in the buffer), it is pinned, and `open` never replaces it.
  const carriesUnsaved = useCallback((s: TabState) => (k: string) => unsavedRef.current.has(k) || Boolean(tabBuffer(tabOf(s, k))?.dirty), []);
  useEffect(() => { const v = state.preview; if (v && unsaved.has(v)) setStatus((s) => keep(s, v)); }, [state.preview, unsaved, setStatus]);
  const closeTab = useCallback(async (key: string): Promise<boolean> => {
    if (isView(key)) { setStatus((s) => close(s, key)); return true; } // a view carries nothing unsaved
    const tab = tabOf(stateRef.current, key);
    if (!tab) return false;
    // A file tab whose buffer lies without a holder (the area was unmounted) still carries its unsaved text; asked then too.
    const stale = tab.kind === "file" ? tabBuffer(tab) : null;
    if (unsavedRef.current.has(key) || (stale?.dirty && stale.holders === 0)) {
      const name = baseName(tab.kind === "diff" ? diffPath(tab.source) ?? tab.title ?? "" : tab.path);
      if (!(await question(t("\"{name}\" has unsaved changes. Close anyway?", { name }), { ok: t("Close"), danger: true }))) return false;
    }
    forget([key]);
    if (stale?.dirty && stale.holders === 0) stale.dismiss(); // otherwise Alt+Cmd+S would write it after all, and a tab opened later would show it
    // A closed diff tab takes its unsaved text with it (asked above), unless a file tab still shows the same buffer (lib/buffer.ts).
    // Only the front diff tab is mounted; its own holdership therefore does not count. Without this the buffer would lie unsaved in the
    // window: Alt+Cmd+S would write it, a file tab opened later would show it.
    if (tab.kind === "diff" && writeFile(tab.source) !== null) {
      const p = tabBuffer(tab);
      if (p?.dirty && p.holders <= (stateRef.current.active === key ? 1 : 0)) p.dismiss();
    }
    setStatus((s) => close(s, key));
    return true;
  }, [question, t, forget, setStatus]);
  const closeSetTab = useCallback(async (kind: CloseKind, key: string) => {
    const s = stateRef.current;
    for (const x of closeSet(kind, queue(s).filter((k) => k !== CHAT), key, (y) => !unsavedRef.current.has(y))) {
      if (!(await closeTab(x))) return; // cancelled: the rest stays open (as in VS Code)
    }
  }, [closeTab]);
  const [treeClosed, setTreeToRaw] = useState(() => read(TREE_TO_KEY) === "1");
  const setTreeClosed = useCallback((closed: boolean) => { setTreeToRaw(closed); write(TREE_TO_KEY, closed ? "1" : null); }, []);
  const [treeCommand, setTreeCommand] = useState<TreeCommand>({ seq: 0, kind: "show", at: 0 });
  const viewOpen = useCallback((a: View) => {
    setStatus((s) => openView(s, a));
    // The explorer shows its tree (the code area may only be mounting then; "show" still takes effect, see CodePane).
    if (a === FILES) setTreeCommand((b) => ({ seq: b.seq + 1, kind: "show", at: Date.now() }));
  }, [setStatus]);
  // Reordering, "Reveal in Explorer View", the git state per target for the colour of the tab names.
  const reorder = useCallback((from: string, to: string, afterwards: boolean) => setStatus((s) => {
    const tabs = reorderList(s.tabs, keyName, from, to, afterwards);
    const views = reorderList(s.views, (a) => a, from, to, afterwards);
    return tabs === s.tabs && views === s.views ? s : { ...s, tabs: [...tabs], views: [...views] };
  }), [setStatus]);
  const showInExplorer = useCallback((key: string) => {
    setStatus((s) => activate(s, key));
    setTreeCommand((b) => ({ seq: b.seq + 1, kind: "show", at: Date.now() }));
  }, [setStatus]);
  const [gitByTarget, setGitByTarget] = useState<Record<string, { fingerprint: string; status: Readonly<Record<string, string>> }>>({});
  const reportGit = useCallback((target: TabTarget, status: Readonly<Record<string, string>>) => {
    const k = targetKey(target), fingerprint = JSON.stringify(status);
    setGitByTarget((old) => (old[k]?.fingerprint === fingerprint ? old : { ...old, [k]: { fingerprint, status } }));
  }, []);
  const gitKindOf = useCallback((target: TabTarget, path: string) => gitByTarget[targetKey(target)]?.status[path] ?? null, [gitByTarget]);
  // Renamed/deleted: the drafts of the tabs whose key changes or drops are forgotten; the code area or the diff writes a draft anew under
  // the new key (diffs move along too, lib/chat-tabs.ts `renameSource`).
  const forgetGone = useCallback((after: TabState) => {
    const stays = new Set(after.tabs.map(keyName));
    forget(stateRef.current.tabs.map(keyName).filter((k) => !stays.has(k)));
  }, [forget]);
  // A comparison of two files follows per side, one from another target too (`mapInWindow`).
  // A diff that would drop in the process (a side leaves its target) stays standing with unsaved text and keeps its draft, as on deletion.
  const renamed = useCallback((target: TabTarget, old: string, fresh: string, onlyCompare = false) => {
    const o = (s: TabState) => ({ map: mapInWindow, onlyCompare, unsaved: carriesUnsaved(s) });
    forgetGone(rename(stateRef.current, target, old, fresh, o(stateRef.current)));
    setStatus((s) => rename(s, target, old, fresh, o(s)));
  }, [setStatus, forgetGone, carriesUnsaved]);
  const deleted = useCallback((target: TabTarget, path: string, fromOutside: boolean, onlyCompare = false) => {
    const diffFalls = (s: TabState) => (k: string) => !fromOutside && !carriesUnsaved(s)(k);
    const o = { map: mapInWindow, onlyCompare };
    forgetGone(removeFiles(stateRef.current, target, path, diffFalls(stateRef.current), o));
    setStatus((s) => removeFiles(s, target, path, diffFalls(s), o));
  }, [setStatus, forgetGone, carriesUnsaved]);
  // A rename/delete in ANY area of the window pulls this chat's comparisons along (only them; the own area has done everything else via
  // `renamed`/`deleted`, a second application changes nothing).
  useFileFollowUp((e) => (e.kind === "renamed" ? renamed(e.target, e.old, e.fresh, true) : deleted(e.target, e.path, false, true)));

  // ── Sign on the chat tab ──
  const [fresh, setNew] = useState(false);
  const busyPrior = useRef(busy);
  const [nudge, setNudge] = useState<TabNudge>({ seq: 0, paths: null });
  useEffect(() => {
    const before = busyPrior.current;
    busyPrior.current = busy;
    if (before && !busy) {
      if (chatObscured) setNew(true);
      setNudge((a) => ({ seq: a.seq + 1, paths: null })); // Turn end: all open tabs look again
    }
  }, [busy, chatObscured]);
  useEffect(() => { if (!chatObscured) setNew(false); }, [chatObscured]);
  // A chat switch: the run state applies from NOW, the new chat's `busy`, not false (sent from the draft, the first turn was already
  // running and its end was lost: no nudge, no "new").
  useEffect(() => { setNew(false); busyPrior.current = busy; }, [chatKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = permReqs.length > 0 || waitingForHuman(bubbles);
  const character = chatSign({ waiting, running: busy, fresh });

  const bump = useCallback((target: TabTarget, path: string) => setNudge((a) => ({ seq: a.seq + 1, paths: [path], target })), []);

  // ── Edit/Write in the running turn ──
  const seen = useRef<{ k: string; ids: Set<string> } | null>(null);
  const hasFileTabs = state.tabs.some((x) => x.kind === "file");
  useEffect(() => {
    if (!hasFileTabs) return;
    let start = bubbles.length;
    while (start > 0 && bubbles[start - 1].role !== "user") start--;
    const newWritten = writtenFiles(bubbles.slice(Math.max(0, start - 1)));
    const g = seen.current;
    if (!g || g.k !== chatKey) { seen.current = { k: chatKey, ids: new Set(newWritten.map((x) => x.id)) }; return; }
    const paths = newWritten.filter((x) => !g.ids.has(x.id)).map((x) => x.path);
    for (const x of newWritten) g.ids.add(x.id);
    if (paths.length && busy) setNudge((a) => ({ seq: a.seq + 1, paths }));
  }, [bubbles, busy, chatKey, hasFileTabs]);

  // ── Finder (Cmd+P) and shortcuts ──
  const [finderOpen, setFinderOpen] = useState(false);
  useEffect(() => { setFinderOpen(false); }, [chatKey]);
  // When the bar becomes visible (a tab with a second area of the same chat comes to the front), the area rereads its state, since the
  // other may have written meanwhile. Measured via the surface (ResizeObserver: 0 → >0).
  const observer = useRef<ResizeObserver | null>(null);
  const wasVisible = useRef<boolean | null>(null);
  const chatKeyRef = useRef(chatKey);
  chatKeyRef.current = chatKey;
  const setBar = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    barEl.current = el;
    wasVisible.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const now = el.getClientRects().length > 0;
      const prior = wasVisible.current;
      wasVisible.current = now;
      if (prior === false && now) {
        const k = chatKeyRef.current;
        setRaw((r) => (r.k === k ? { k, s: loadStatus(k), drafts: draftTabsWithStorage(k) } : r));
      }
    });
    ro.observe(el);
    observer.current = ro;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => observer.current?.disconnect(), []);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [environment, setEnvironment] = useState<{ mac: boolean; shell: boolean }>({ mac: false, shell: false });
  useEffect(() => { setEnvironment({ mac: isMac(), shell: inShell(window) }); }, []);
  const shortcutRef = useRef({ closeTab, closeSetTab, setStatus, environment, taRef: e.taRef });
  shortcutRef.current = { closeTab, closeSetTab, setStatus, environment, taRef: e.taRef };
  const chord = useRef(false); // Cmd+K was pressed: the next press belongs to it
  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      const el = barEl.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return; // this chat is not in front
      if (document.querySelector('[aria-modal="true"]')) return; // a sheet (the "Close anyway?" question, alertdialog, too) has the keyboard
      const r = shortcutRef.current;
      const s = stateRef.current;
      // The tab menu's shortcuts (Alt+Cmd+T, Cmd+K U, Cmd+K W, Cmd+K Enter): like Cmd+W only if a tab is in front (in the chat they belong to the window).
      if (!["Meta", "Control", "Alt", "Shift"].includes(ev.key)) {
        const m = s.active === CHAT ? null : menuShortcut(ev, r.environment, chord.current);
        chord.current = m?.kind === "chord";
        if (m) {
          ev.preventDefault();
          if (m.kind === "set") void r.closeSetTab(m.set, s.active);
          else if (m.kind === "fixed") r.setStatus((x) => keep(x, x.active));
          return;
        }
      }
      // Cmd+S outside the surface (CodeMirror binds it itself): a diff in front saves its right side; VS Code saves the active editor.
      if ((r.environment.mac ? ev.metaKey : ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "s" && tabOf(s, s.active)?.kind === "diff"
        && !(ev.target instanceof Element && ev.target.closest(".cm-editor"))) {
        ev.preventDefault();
        ev.stopPropagation();
        saveLocation(`chat:${chatKeyRef.current}`);
        return;
      }
      const k = tabShortcut(ev, r.environment);
      if (!k) return;
      if (k === "find") { ev.preventDefault(); setFinderOpen(true); return; }
      if (k === "chat") {
        ev.preventDefault();
        r.setStatus((x) => activate(x, CHAT));
        requestAnimationFrame(() => r.taRef.current?.focus());
        return;
      }
      if (k === "close") {
        if (s.active === CHAT) return; // in the chat Cmd+W belongs to the window
        ev.preventDefault();
        void r.closeTab(s.active);
        return;
      }
      if (s.tabs.length === 0 && s.views.length === 0 && s.active === CHAT) return; // nothing to page through; Ctrl+Tab stays with the window
      ev.preventDefault();
      r.setStatus((x) => paginate(x, k === "next" ? 1 : -1));
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);

  // ── Jump from outside (git bar, edit lines) ──
  // Listening is on the chat's key, not its id: the draft of a new chat (`draft@<ws>`) has tabs too, and the bar sends there. A jump
  // without a target takes the chat's at THIS moment (`tabFromJump`).
  const chatTargetRef = useRef(chatTarget);
  chatTargetRef.current = chatTarget;
  useEffect(() => {
    const enabled = (ev: Event) => {
      const s = chatTabJumpFrom((ev as CustomEvent<unknown>).detail);
      if (!s || s.chatId !== chatKey) return;
      if (!visible()) return; // only the visible area of the same chat opens (and writes) the tab
      const tab = tabFromJump(s, chatTargetRef.current);
      setStatus((x) => open(x, tab, { fixed: s.fixed, unsaved: carriesUnsaved(x) }));
    };
    window.addEventListener(CHAT_TAB_EVENT, enabled);
    return () => window.removeEventListener(CHAT_TAB_EVENT, enabled);
  }, [chatKey, setStatus, carriesUnsaved]);

  // ── Cleanup (once per session, only with the list loaded) ──
  const chats = e.chats;
  useEffect(() => {
    if (cleanedUp || chats.length === 0) return;
    cleanedUp = true;
    const candidates = cleanupCandidates(allKey(), new Set(chats.map((c) => c.id)), true);
    void (async () => {
      for (const [chatId, keys] of [...candidates].slice(0, 40)) {
        try { await api(`/api/chats/${encodeURIComponent(chatId)}`); }
        catch (err) { if ((err as { httpStatus?: number }).httpStatus === 404) for (const k of keys) write(k, null); }
      }
    })();
  }, [chats]);

  return {
    chatKey, chatId: activeId, status: state, chatTarget, treeTarget, activeTab, codeVisible, chatObscured, tabView, setViewSlot,
    codeMounted: codeVisible || finderOpen || mounted === chatKey,
    character, unsaved, foreignInstance,
    activate: useCallback((key: string) => setStatus((s) => activate(s, key)), [setStatus]),
    open: useCallback((tab: CodeTab, o?: { fixed?: boolean; background?: boolean }) => setStatus((s) => open(s, tab, { fixed: Boolean(o?.fixed), background: Boolean(o?.background), unsaved: carriesUnsaved(s) })), [setStatus, carriesUnsaved]),
    keep: useCallback((key: string) => setStatus((s) => keep(s, key)), [setStatus]),
    close: closeTab, closeSet: closeSetTab, openView: viewOpen, treeClosed, setTreeClosed, treeCommand, nudge, finderOpen, setFinderOpen, actions, setActions, setBar,
    draftRead, draftWrite, bump, reportUnsaved, reportTabUnsaved, renamed, deleted,
    closeShortcut: closeShortcutText(environment),
    shortcut: { close: closeShortcutText(environment), ...shortcutText(environment) }, mac: environment.mac,
    reorder, showInExplorer, reportGit, gitKindOf,
    openPreview: useCallback((z: TabTarget, path: string) => setStatus((s) => previewOpen(s, z, path)), [setStatus]),
    toSource: useCallback((key: string) => setStatus((s) => sourceBack(s, key)), [setStatus]),
    toggleLock: useCallback((key: string) => setStatus((s) => lockToggle(s, key)), [setStatus]),
    switchPreview: useCallback((key: string, path: string) => setStatus((s) => previewSwitch(s, key, path)), [setStatus]),
    previewRead: useCallback((key: string, missing: boolean) => {
      const w = restored.current;
      if (w && w.keys.delete(key) && missing) setStatus((s) => close(s, key));
    }, [setStatus]),
    asPreview: useCallback((key: string) => setStatus((s) => asPreviewOpen(s, key, carriesUnsaved(s)(key))), [setStatus, carriesUnsaved]),
  };
}
