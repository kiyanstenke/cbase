"use client";
// The connection of the editor groups to CodePane: the state of the groups (computations in lib/editor-groups.ts, remembered per target in
// localStorage — it survives reload; including the grid), the commands in the ONE command table (lib/editor-commands.ts: ⌘\ ⌘1 ⌃⌘← … are
// bound by the editor, all are in the palette — except ⌘2–⌘8, which VS Code knows only as a key: the root catches them, the editor lets them
// through) and the key catcher for CodePane's root (the same keys outside the editor and the chords ⌘K W / ⌘K U / ⌘K Enter / ⌘K ⌘\ …
// that CodeMirror cannot bind). The drawing is in EditorGroups.tsx, the execution of the commands in CodePane (`groupsCommand` — what only
// changes the state is computed by lib/editor-groups.ts `statusStep`).
//
// WHO EXECUTES: a command from the editor (key, palette) looks for the host in whose root the view stands (as palette-host.ts does) and the
// group from `data-editor-group` above it — a view outside every group (the chat, a diff tab in the chat) does not see the commands
// (`condition`), there the editor releases the key.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { registerCommand } from "@/lib/editor-commands";
import { isMac } from "@/lib/chat-bar";
import { CHORD_DEADLINE_MS, BEGINNING, GROUPS_COMMANDS, TERMINAL_PASSTHROUGH, fromStorage, pressText, groupKey, storageText, keysOf, type GroupsCommandId, type GroupsStatus } from "@/lib/editor-groups";
import type { EditorContext } from "@/components/code/lsp-core";
import { tidy, oneDynamicPreview, migrateCompare, toRestore } from "@/lib/editor-inputs";
import type { TabTarget } from "@/lib/chat-tabs";
import { followUpKeyBinding } from "@/components/code/keys-layout";

const STORAGE = "cbase-code-groups:";
/** The target of the groups from their key (`[apiBase, instance ?? ""].join("|")`, CodePane) — null if it names none; it is checked only
 *  when moving (lib/chat-tabs.ts `checkSource`: a foreign route does not move). */
export const targetTheGroups = (k: string): TabTarget | null => {
  const i = k.indexOf("|");
  return i > 0 ? { apiBase: k.slice(0, i), instance: k.slice(i + 1) || null } : null;
};

/** The state of the groups — `key` null: remember nothing (the controlled form in the chat has no groups). `wende` changes it AT ONCE
 *  in the ref (two steps in the same event see each other) and renders only if something changed. It is remembered only after it was read
 *  (otherwise the empty start would overwrite the remembered state). It is read BEFORE the first paint (otherwise the empty start would
 *  flash). `load` counts every restore — the surface (EditorGroups.tsx) takes a restored state as the basis, not as a rebuild of the grid
 *  (otherwise a small window's clamps would turn into shares after reload). The key names the groups' target (`apiBase|instance`,
 *  CodePane) — a remembered comparison in the old form migrates with it (`targetTheGroups`). */
export function useEditorGroups(key: string | null) {
  const [status, setStatus] = useState<GroupsStatus>(BEGINNING);
  const [load, setLoad] = useState(0);
  const ref = useRef<GroupsStatus>(BEGINNING);
  const read = useRef<string | null>(null);
  /** The tabs that came from storage (not opened by the user) — if their file is missing on load, the tab falls. File tabs (their path)
   *  and previews (their key: components/code/PreviewTab.tsx reports `onMissing`). */
  const restored = useRef(new Set<string>());
  useLayoutEffect(() => {
    read.current = null;
    if (!key) return;
    let s: GroupsStatus | null = null;
    try { s = fromStorage(localStorage.getItem(STORAGE + key)); } catch { /* without storage: the start */ }
    // A tab that is not a valid input (foreign text in storage) falls on reading (lib/editor-inputs.ts `tidy`); "missing on load"
    // applies to file tabs and previews (the preview reads its file itself and reports it) — a diff shows a source in git. A comparison of
    // two files in the old form migrates FIRST (both sides in this target) instead of falling as "no input".
    const z = targetTheGroups(key);
    if (s && z) s = migrateCompare(s, z);
    if (s) s = tidy(s);
    if (s) { ref.current = s; setStatus(s); setLoad((n) => n + 1); restored.current = new Set(toRestore(s)); }
    read.current = key;
  }, [key]);
  useEffect(() => {
    if (!key || read.current !== key) return;
    try { localStorage.setItem(STORAGE + key, storageText(ref.current)); } catch { /* for this session only */ }
  }, [status, key]);
  // After EVERY step at most one unlocked preview per group (VS Code `onDidChangeViewState`) — splitting, moving and dragging would
  // otherwise bring a second (lib/editor-inputs.ts `oneDynamicPreview`).
  const apply = useCallback((f: (s: GroupsStatus) => GroupsStatus): GroupsStatus => {
    const old = ref.current, fresh = oneDynamicPreview(f(old));
    if (fresh !== old) { ref.current = fresh; setStatus(fresh); }
    return fresh;
  }, []);
  return { state: status, ref, apply, restored, load };
}

// ── The command table ────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Host = { root: () => HTMLElement | null; execute: (id: GroupsCommandId, group: string | null) => void; can: (id: GroupsCommandId, group: string | null) => boolean };
const HOSTS = new Set<Host>();
/** The host of a view and the group it stands in — null: it stands in no group. */
function hostOf(view: EditorView): { w: Host; group: string | null } | null {
  for (const w of HOSTS) {
    if (!w.root()?.contains(view.dom)) continue;
    const g = view.dom.closest<HTMLElement>("[data-editor-group]");
    return g ? { w, group: g.dataset.editorGroup ?? null } : null;
  }
  return null;
}
/** Does the command apply in the view's group (the host asks its situation, e.g. "Markdown: …" only on a Markdown file)? */
function canIn(id: GroupsCommandId, view: EditorView): boolean {
  const x = hostOf(view);
  return x !== null && x.w.can(id, x.group);
}
let entered = false;
/** The group commands into the table — once per window. */
function enter() {
  if (entered) return;
  entered = true;
  for (const b of GROUPS_COMMANDS) {
    if ("onlyKey" in b) continue; // ⌘2–⌘8 are not in VS Code's palette — the root catches them (`key`)
    const keys = keysOf(b, isMac());
    registerCommand<EditorContext>({
      id: b.id, title: b.title, ...("shortcut" in b ? { shortcut: b.shortcut } : {}), ...(keys.length ? { keys } : {}),
      condition: (_situation, k) => hostOf(k.view) !== null && canIn(b.id, k.view),
      execute: (k) => { const x = hostOf(k.view); x?.w.execute(b.id, x.group); },
    });
  }
}

const ONLY_SWITCHER = ["Meta", "Control", "Shift", "Alt"];
const groupAt = (e: React.KeyboardEvent) => (e.target as Element | null)?.closest?.<HTMLElement>("[data-editor-group]")?.dataset.editorGroup ?? null;
/** A key in the terminal belongs to the terminal (VS Code: ⌘K clears there, ⌘\ splits the terminal, ⌥Z goes to the shell) — except the
 *  commands VS Code sends past the shell (`TERMINAL_PASSTHROUGH`, `terminal.integrated.commandsToSkipShell`). */
export const inTerminal = (e: { target: EventTarget | null }) => Boolean((e.target as Element | null)?.closest?.(".xterm"));
/** What the status bar's chord says (VS Code): it waits for the second key — or the second key was no command (`combo`). */
export type ChordNotice = { kind: "waiting" } | { kind: "no"; combo: string };
/** How long "… is not a command" stays (VS Code: 10 s). */
const NO_COMMAND_MS = 10_000;

/** Register the host (CodePane uncontrolled, `on`). Returns `key` for `onKeyDown` on the root (true: taken) — it does not take what the
 *  editor already took (`defaultPrevented`); `capture` for `onKeyDownCapture`: if a chord waits it takes the NEXT key before all others (also
 *  before the editor and the tree's type-ahead) — even an unknown one, VS Code does not type it; bare modifiers leave it open. As in
 *  VS Code: the chord ends after 5 s, when the window loses focus or is hidden; while it waits, `notice` tells the status bar, a second
 *  key without a command says "… is not a command". Keys in the terminal (`.xterm`) do not see the groups. */
export function useGroupsKeys(root: React.RefObject<HTMLElement | null>, on: boolean, execute: (id: GroupsCommandId, group: string | null) => void, can: (id: GroupsCommandId, group: string | null) => boolean = () => true) {
  const run = useRef(execute);
  run.current = execute;
  const may = useRef(can);
  may.current = can;
  const chord = useRef(false);
  const [notice, setNotice] = useState<ChordNotice | null>(null);
  const clock = useRef<ReturnType<typeof setTimeout> | null>(null);
  const report = useCallback((m: ChordNotice | null, duration = 0) => {
    if (clock.current) clearTimeout(clock.current);
    clock.current = m && duration > 0 ? setTimeout(() => { chord.current = false; clock.current = null; setNotice(null); }, duration) : null;
    setNotice(m);
  }, []);
  const end = useCallback(() => { if (!chord.current) return; chord.current = false; report(null); }, [report]);
  useEffect(() => {
    if (!on) return;
    followUpKeyBinding();
    const onBlur = () => end();
    const view = () => { if (document.visibilityState !== "visible") end(); };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", view);
    return () => { window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", view); if (clock.current) clearTimeout(clock.current); };
  }, [on, end]);
  useEffect(() => {
    if (!on) return;
    enter();
    const w: Host = { root: () => root.current, execute: (id, g) => run.current(id, g), can: (id, g) => may.current(id, g) };
    HOSTS.add(w);
    return () => { HOSTS.delete(w); };
  }, [on, root]);
  const capture = useCallback((e: React.KeyboardEvent) => {
    if (!on || !chord.current || ONLY_SWITCHER.includes(e.key)) return;
    chord.current = false;
    if (inTerminal(e)) { report(null); return; } // clicked into the terminal: the chord is over, the key belongs to the terminal
    const r = groupKey(e, true, isMac());
    e.preventDefault();
    e.stopPropagation();
    if (r !== null && r !== "chord") { report(null); run.current(r, groupAt(e)); }
    else report({ kind: "no", combo: pressText(e, isMac()) }, NO_COMMAND_MS);
  }, [on, report]);
  const key = useCallback((e: React.KeyboardEvent): boolean => {
    if (!on || e.defaultPrevented || ONLY_SWITCHER.includes(e.key)) return false;
    const r = groupKey(e, false, isMac());
    if (r === null || (inTerminal(e) && (r === "chord" || !TERMINAL_PASSTHROUGH.includes(r)))) return false;
    e.preventDefault();
    if (r === "chord") { chord.current = true; report({ kind: "waiting" }, CHORD_DEADLINE_MS); }
    else run.current(r, groupAt(e));
    return true;
  }, [on, report]);
  return { key, capture, notice };
}
