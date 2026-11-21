// The watermark of an empty editor group styled like VS Code — the PURE computation. Drawn in components/code/Watermark.tsx
// (the lens logo as an emboss, the shortcuts below).
//
// VS CODE 1.143 (src/vs/workbench/browser/parts/editor/editorGroupWatermark.ts):
//   - In a window WITH a folder first come "Open Chat" and "Show All Commands" (`folderEntries`); each entry only if its command is
//     registered AND bound to a key (`filterEntries`: `CommandsRegistry.getCommand` and `lookupKeybinding`).
//   - If that is fewer than `MINIMUM_ENTRIES` (3), as many from `randomEntries` (Go to File, Find in Files, Start Debugging, Toggle
//     Terminal, Open Settings) are added — filtered as above, SHUFFLED (`shuffle`, Fisher-Yates) — until there are three.
//   - Shuffled ONCE per group (the watermark lives with the group), not on every render and not on every time it becomes empty: the
//     caller holds the throw (`random`) per group as long as it lives (CodePane `throwOf`).
//   - The shortcuts: on the Mac each key its own box without a separator (⇧ ⌘ P), otherwise the "Ctrl" form with "+" (Ctrl+Shift+P) —
//     `keysParts`.
//   - The shortcuts are visible only while NO other group holds editors and the group is taller than 478 px (CSS: `:not(.empty)` on the
//     editor area and `.max-height-478px` on the group) — the drawing computes that (container query on the height), here `withShortcuts`.
// cbase registers no chat command in the editor's command table (the chat is a page of its own) and no debug start and no
// settings with a key — what remains is "Show All Commands" and two of Go to File · Find in Files · Toggle Terminal.
//
// Guard: web/test/watermark.test.mjs (EXECUTED, with sabotages).

export type WaterEntry = { id: string; title: string };
export type WaterRow = WaterEntry & { shortcut: string };

/** The fixed entries in a window with a folder (VS Code `folderEntries`). The titles are keys for lib/i18n-de.ts. */
export const WATER_FIXED: readonly WaterEntry[] = [
  { id: "workbench.action.chat.open", title: "Open chat" },
  { id: "workbench.action.showCommands", title: "Show All Commands" },
];
/** The shuffled ones (VS Code `randomEntries`). */
export const WATER_RANDOM: readonly WaterEntry[] = [
  { id: "workbench.action.quickOpen", title: "Go to File" },
  { id: "workbench.action.findInFiles", title: "Find in Files" },
  { id: "workbench.action.debug.start", title: "Start Debugging" },
  { id: "workbench.action.terminal.toggleTerminal", title: "Toggle Terminal" },
  { id: "workbench.action.openSettings", title: "Open Settings" },
];
/** VS Code `MINIMUM_ENTRIES`. */
export const WATER_AT_LEAST = 3;
/** VS Code: below this group height no shortcuts are shown (`max-height-478px`). */
export const WATER_HEIGHT = 478;

/** Shuffle as VS Code `shuffle` (Fisher-Yates, from the back) — `random` is fixed in the test. */
export function shuffle<T>(list: readonly T[], random: () => number = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The watermark's rows. `shortcut(id)` is the bound shortcut of a registered command (lib/editor-commands.ts `command(id)?.shortcut`)
 *  — empty/undefined: the command is missing or has no key, then it is not shown. */
export function watermark(shortcut: (id: string) => string | null | undefined, random: () => number = Math.random): WaterRow[] {
  const present = (e: WaterEntry) => Boolean(shortcut(e.id));
  const rows = WATER_FIXED.filter(present);
  if (rows.length < WATER_AT_LEAST) rows.push(...shuffle(WATER_RANDOM.filter(present), random).slice(0, WATER_AT_LEAST - rows.length));
  return rows.map((e) => ({ ...e, shortcut: shortcut(e.id) as string }));
}

/** Are the shortcuts shown? Only without editors in another group (VS Code `.content:not(.empty)`) — the drawing checks the height. */
export const withShortcuts = (othersWithEditors: boolean): boolean => !othersWithEditors;

// The order as VS Code `KeybindingLabel.renderChord`: Ctrl, Shift, Alt, Meta.
const MAC_MODS = ["⌃", "⇧", "⌥", "⌘"] as const;
/** A shortcut in Mac symbols ("⇧⌘P", "⌃`", "⌘K V") as keys per chord: on the Mac each symbol a key, otherwise Ctrl/Shift/Alt (⌘ and ⌃
 *  are both Ctrl there) in VS Code's order, the caller puts "+" between them. */
export function keysParts(shortcut: string, mac: boolean): string[][] {
  return shortcut.trim().split(/\s+/).filter(Boolean).map((chord) => {
    let i = 0;
    const mods = new Set<string>();
    while (i < chord.length - 1 && (MAC_MODS as readonly string[]).includes(chord[i])) { mods.add(chord[i]); i += 1; }
    const key = chord.slice(i);
    if (mac) return [...MAC_MODS.filter((m) => mods.has(m)), key];
    const out: string[] = [];
    if (mods.has("⌃") || mods.has("⌘")) out.push("Ctrl");
    if (mods.has("⇧")) out.push("Shift");
    if (mods.has("⌥")) out.push("Alt");
    return [...out, key];
  });
}
