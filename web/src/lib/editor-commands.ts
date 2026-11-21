// The ONE command table of the code editor (editor navigation styled like VS Code): name, shortcut, condition,
// execution per command. From it come the key bindings in the editor (components/code/lsp-commands.ts `commandKeys`), the context menu
// (components/code/EditorMenu.tsx) and the command palette ("everything from the menu plus …") — one list, no case per place.
//
// WHO REGISTERS: the entries in `W2_COMMANDS` (data here; the execution is attached by components/code/lsp-commands.ts), the go-to family
// (peek ▸, references, call hierarchy, back/forward) and the palette (files, symbols, line) through `registerCommand` when their
// module loads — a key or id that is already taken THROWS (otherwise two commands on one key would exist silently, the later one would win).
//
// HIDDEN (like VS Code): a command that needs a capability the server of this file does not report (`needs`), one
// that writes, in a read-only view (`writing`), and what `condition` denies. Without a server (file without a language, server off,
// instance stopped) the `features` are empty — then only what works without a server remains (clipboard, change all occurrences via equal words).
//
// A leaf except for one type — web/test/lsp-editor.test.mjs transpiles it with tsc and runs table, shortcuts and hiding (with counter-checks).
import type { LspCapability } from "./api/lsp.js";

/** Groups of the context menu in the order of VS Code — without the chat block and without dictation. */
export const MENU_GROUPS = ["navigation", "search", "change", "clipboard", "palette"] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

/** What applies at the place where a command is offered. */
export type CommandSituation = {
  /** Capabilities of the server for this file (lib/lsp-status.ts) — empty: no server, none ready, or not read yet. */
  features: ReadonlySet<LspCapability>;
  /** The file has a language with a server (lib/api/lsp.ts `lspLanguageOf`). */
  language: boolean;
  /** The view is not read-only. */
  writable: boolean;
};

export type EditorCommand<K = never> = {
  /** Identifier as in VS Code (`editor.action.rename`) — unique. */
  id: string;
  /** English title (key for lib/i18n-de.ts). */
  title: string;
  /** In the context menu in this group; without: key only (and palette). */
  group?: MenuGroup;
  /** Order within the group (ascending). */
  rank?: number;
  /** The shortcut as it stands on the right in the menu (Mac symbols). */
  shortcut?: string;
  /** CodeMirror key names the editor binds. Without: the shortcut belongs to the browser (⌘C/⌘X/⌘V) and only stands there. */
  keys?: readonly string[];
  /** Hidden without this capability of the server. */
  needs?: LspCapability;
  /** Hidden in read-only views. */
  writing?: boolean;
  /** An entry in the submenu of this command (VS Code "Peek ▸"). */
  parent?: string;
  /** The entry only opens its submenu (hidden without a visible child). */
  submenu?: boolean;
  condition?: (situation: CommandSituation, k: K) => boolean;
  execute?: (k: K) => void | Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommand = EditorCommand<any>;

/** The entries of the base table — the execution is attached by components/code/lsp-commands.ts (each id here has exactly one there). */
export const W2_COMMANDS: readonly Omit<EditorCommand, "execute" | "condition">[] = [
  { id: "editor.action.rename", title: "Rename Symbol", group: "change", rank: 10, shortcut: "F2", keys: ["F2"], needs: "rename", writing: true },
  { id: "editor.action.changeAll", title: "Change All Occurrences", group: "change", rank: 20, shortcut: "⌘F2", keys: ["Mod-F2"], writing: true },
  { id: "editor.action.formatDocument", title: "Format Document", group: "change", rank: 30, shortcut: "⌥⇧F", keys: ["Shift-Alt-f"], needs: "format", writing: true },
  { id: "editor.action.refactor", title: "Refactor…", group: "change", rank: 40, shortcut: "⌃⇧R", keys: ["Ctrl-Shift-r"], needs: "refactor", writing: true },
  { id: "editor.action.sourceAction", title: "Source Action…", group: "change", rank: 50, needs: "source_action", writing: true },
  { id: "editor.action.clipboardCutAction", title: "Cut", group: "clipboard", rank: 10, shortcut: "⌘X", writing: true },
  { id: "editor.action.clipboardCopyAction", title: "Copy", group: "clipboard", rank: 20, shortcut: "⌘C" },
  { id: "editor.action.clipboardPasteAction", title: "Paste", group: "clipboard", rank: 30, shortcut: "⌘V", writing: true },
  { id: "editor.action.quickFix", title: "Quick Fix…", shortcut: "⌘.", keys: ["Mod-."], needs: "quick_fix", writing: true },
  { id: "editor.action.marker.next", title: "Go to Next Problem (Error, Warning, Info)", shortcut: "F8", keys: ["F8"] },
  { id: "editor.action.marker.prev", title: "Go to Previous Problem (Error, Warning, Info)", shortcut: "⇧F8", keys: ["Shift-F8"] },
  { id: "editor.action.showContextMenu", title: "Show Editor Context Menu", shortcut: "⇧F10", keys: ["Shift-F10", "ContextMenu"] },
];

/** The quick-diff peek in the git margin (like VS Code `editor.action.dirtydiff.next`/`.previous`, ⌥F3/⇧⌥F3, title "Show Next/Previous
 *  Change"): jumps to the next/previous change against the index and opens the peek there — even without an open one. The execution is attached by
 *  components/code/git-gutter.ts. */
export const QUICK_DIFF_COMMANDS: readonly Omit<EditorCommand, "execute" | "condition">[] = [
  { id: "editor.action.dirtydiff.next", title: "Show Next Change", shortcut: "⌥F3", keys: ["Alt-F3"] },
  { id: "editor.action.dirtydiff.previous", title: "Show Previous Change", shortcut: "⇧⌥F3", keys: ["Shift-Alt-F3"] },
];

/** A CodeMirror key name in a fixed form ("Shift-Alt-f" = "Alt-Shift-F"; Mod = Cmd, Mac first), for comparison. */
export function keyNormalized(name: string): string {
  const parts = String(name).split(/-(?!$)/);
  let key = parts.pop() ?? "";
  const mods = new Set<string>();
  for (const m of parts) {
    const x = m.toLowerCase();
    mods.add(x === "mod" || x === "cmd" || x === "meta" || x === "m" ? "meta" : x === "control" || x === "c" ? "ctrl" : x === "a" ? "alt" : x === "s" ? "shift" : x);
  }
  if (key.length === 1) key = key.toLowerCase();
  return [...[...mods].sort(), key].join("-");
}

const TABLE = new Map<string, AnyCommand>();
const KEYS = new Map<string, string>(); // normalized → id
const SUBSCRIBERS = new Set<() => void>();

/** Register a command. A taken id or key throws. Returns: unregister. */
export function registerCommand<K>(b: EditorCommand<K>): () => void {
  if (!b?.id || !b.title) throw new Error("Command without id or title");
  if (TABLE.has(b.id)) throw new Error(`Command ${b.id} is already registered`);
  const keys = (b.keys ?? []).map(keyNormalized);
  for (const t of keys) {
    const prior = KEYS.get(t);
    if (prior) throw new Error(`Key ${t} already belongs to ${prior} (new: ${b.id})`);
  }
  if (new Set(keys).size !== keys.length) throw new Error(`Command ${b.id} names a key twice`);
  TABLE.set(b.id, b as AnyCommand);
  for (const t of keys) KEYS.set(t, b.id);
  for (const fn of [...SUBSCRIBERS]) fn();
  return () => {
    if (TABLE.get(b.id) !== b) return;
    TABLE.delete(b.id);
    for (const t of keys) if (KEYS.get(t) === b.id) KEYS.delete(t);
    for (const fn of [...SUBSCRIBERS]) fn();
  };
}
export const command = (id: string): AnyCommand | null => TABLE.get(id) ?? null;
/** All commands in menu order (group, rank, title) — the source of the palette. */
export function allCommands(): AnyCommand[] {
  const g = (b: AnyCommand) => (b.group ? MENU_GROUPS.indexOf(b.group) : MENU_GROUPS.length);
  return [...TABLE.values()].sort((a, b) => g(a) - g(b) || (a.rank ?? 0) - (b.rank ?? 0) || a.title.localeCompare(b.title));
}
/** Listens to registering and unregistering (the palette then rebuilds its list). */
export function subscribeCommands(fn: () => void): () => void { SUBSCRIBERS.add(fn); return () => { SUBSCRIBERS.delete(fn); }; }
/** For tests only. */
export function emptyCommands(): void { TABLE.clear(); KEYS.clear(); }

/** Is the command executable here? */
export function commandVisible<K>(b: EditorCommand<K>, situation: CommandSituation, k: K): boolean {
  if (b.writing && !situation.writable) return false;
  if (b.needs && !situation.features.has(b.needs)) return false;
  if (b.condition && !b.condition(situation, k)) return false;
  if (b.submenu) return childrenOf(b.id, situation, k).length > 0;
  return true;
}
/** The visible entries in the submenu of a command. */
export function childrenOf<K>(id: string, situation: CommandSituation, k: K): AnyCommand[] {
  return allCommands().filter((b) => b.parent === id && commandVisible(b, situation, k));
}
/** The context menu: per group (in order) the visible entries of the top level; empty groups drop out. */
export function menuGroups<K>(situation: CommandSituation, k: K): { group: MenuGroup; commands: AnyCommand[] }[] {
  const all = allCommands().filter((b) => b.group && !b.parent && commandVisible(b, situation, k));
  return MENU_GROUPS.map((group) => ({ group, commands: all.filter((b) => b.group === group) })).filter((x) => x.commands.length);
}
