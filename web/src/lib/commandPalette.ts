// Pure computations of the command palette (editor navigation styled like VS Code) — no DOM, no network:
// which mode an input means (prefix: `>` commands, `@` symbols of the file, `#` workspace symbols, `:` line, `?` help, no prefix
// files), which keys open the palette (ONE list for the command table AND the keys outside the editor) and which project a
// workspace-level file belongs to (the interpreter choice applies per project). How the palette filters, sorts and draws
// (quick input styled like VS Code): lib/quick-input.ts and lib/fuzzy-scorer.ts; the window is components/code/CommandPalette.tsx, the modes
// are in palette-modes.ts.
//
// Tested by execution in web/test/editor-helpers.test.mjs, each computation with a sabotage its check must catch.
export const PALETTE_MODES = ["files", "commands", "symbols", "workArea", "row", "help"] as const;
export type PaletteMode = (typeof PALETTE_MODES)[number];
/** The prefix per mode — "files" has none (like Quick Open in VS Code), `?` is help (VS Code `HelpQuickAccessProvider`). */
export const PREFIX: Readonly<Record<PaletteMode, string>> = { files: "", commands: ">", symbols: "@", workArea: "#", row: ":", help: "?" };

/** The mode of an input and the rest behind the prefix. Typing switches modes: deleting `>` searches files again. */
export function paletteMode(input: string): { mode: PaletteMode; rest: string } {
  const e = String(input ?? "");
  for (const mode of PALETTE_MODES) {
    const p = PREFIX[mode];
    if (p && e.startsWith(p)) return { mode, rest: e.slice(p.length) };
  }
  return { mode: "files", rest: e };
}

/** The commands that open the palette (Mac shortcuts of VS Code 1:1) — registered in the command table (lib/editor-commands.ts,
 *  components/code/palette-host.ts) and the same keys outside the editor (tree, bar: `paletteCommandToKey`). */
export const PALETTE_COMMANDS = [
  // F1 as in VS Code (the second key of `workbench.action.showCommands`); the shortcut names the first.
  { id: "workbench.action.showCommands", title: "Command Palette…", group: "palette", rank: 10, shortcut: "⇧⌘P", keys: ["Mod-Shift-p", "F1"], prefix: ">" },
  { id: "workbench.action.quickOpen", title: "Go to File…", shortcut: "⌘P", keys: ["Mod-p"], prefix: "" },
  { id: "workbench.action.gotoSymbol", title: "Go to Symbol in Editor…", shortcut: "⇧⌘O", keys: ["Mod-Shift-o"], prefix: "@" },
  { id: "workbench.action.showAllSymbols", title: "Go to Symbol in Workspace…", shortcut: "⌘T", keys: ["Mod-t"], prefix: "#" },
  { id: "workbench.action.gotoLine", title: "Go to Line/Column…", shortcut: "⌃G", keys: ["Ctrl-g"], prefix: ":" },
] as const;
export type PaletteCommandData = (typeof PALETTE_COMMANDS)[number];

/** What a key press needs (React and DOM events satisfy it). `keyCode` (deprecated, but in every browser): the key
 *  by layout — as CodeMirror (w3c-keyname) reads it when ⌥/⌘ change the character. */
export type KeyPress = { code: string; key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; keyCode?: number };

// The keyboard layout: `code` is the POSITION of a key (US layout), not its label — on QWERTZ `KeyY` carries the "Z". VS Code
// resolves shortcuts through the layout ("the key with the label"); the map comes from components/code/keys-layout.ts via
// `navigator.keyboard.getLayoutMap()` (Chromium, the desktop client), otherwise it stays empty and `keyCode` gives the label.
let occupancy: ReadonlyMap<string, string> | null = null;
/** Set the keyboard layout (`code` → character without modifier) — null: unknown. */
export function setKeyBindings(k: ReadonlyMap<string, string> | null): void { occupancy = k; }
const CHARACTER = /^[\p{L}\p{N}]$/u;
/** The label of the pressed letter or digit key, lower case: from the layout, else from `keyCode` (65–90, 48–57 — the layout,
 *  not the position), else from the position (`code`), last from `key`. Null: not a letter or digit key. */
export function keyLabel(e: KeyPress): string | null {
  const b = occupancy?.get(e.code);
  if (b && CHARACTER.test(b)) return b.toLowerCase();
  const kc = typeof e.keyCode === "number" ? e.keyCode : 0;
  if ((kc >= 65 && kc <= 90) || (kc >= 48 && kc <= 57)) return String.fromCharCode(kc).toLowerCase();
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  const k = String(e.key ?? "");
  return CHARACTER.test(k) && !e.altKey ? k.toLowerCase() : null;
}

/** Does the press match a CodeMirror key name ("Mod-Shift-p", "Ctrl-g", "Alt-z", "Mod-\\")? `Mod` is ⌘ on the Mac, else Ctrl (as in
 *  CodeMirror). As in VS Code the LABEL of the key counts, not its position (`keyLabel`): ⌥Z on QWERTZ is the key with the
 *  "Z" (`KeyY`), and `key` does not work, because ⌥ and ⇧ change it (⇧P is "P", ⌥S is "ß"). A punctuation mark ("\\") matches if the key
 *  carries it (layout) or produces it (`key`) — then the ⇧/⌥ this layout needs may be added (German: "\\" is ⌥⇧7); the
 *  other keys (Enter, arrows, "`") go through `key`. */
export function matchesKey(name: string, e: KeyPress, mac: boolean): boolean {
  const parts = String(name).split(/-(?!$)/);
  const key = (parts.pop() ?? "").toLowerCase();
  const desired = { meta: false, ctrl: false, shift: false, alt: false };
  for (const m of parts) {
    const x = m.toLowerCase();
    if (x === "mod") desired[mac ? "meta" : "ctrl"] = true;
    else if (x === "cmd" || x === "meta") desired.meta = true;
    else if (x === "ctrl" || x === "control") desired.ctrl = true;
    else if (x === "shift") desired.shift = true;
    else if (x === "alt") desired.alt = true;
  }
  const mods = e.metaKey === desired.meta && e.ctrlKey === desired.ctrl;
  if (CHARACTER.test(key)) return mods && e.shiftKey === desired.shift && e.altKey === desired.alt && keyLabel(e) === key;
  if (key.length === 1) {
    if (!mods) return false;
    if (occupancy?.get(e.code) === key && e.shiftKey === desired.shift && e.altKey === desired.alt) return true;
    return e.key === key && (e.shiftKey || !desired.shift) && (e.altKey || !desired.alt);
  }
  return mods && e.shiftKey === desired.shift && e.altKey === desired.alt && String(e.key).toLowerCase() === key;
}
/** The palette command for a key press — null: the key does not belong to the palette. */
export function paletteCommandToKey(e: KeyPress, mac: boolean): PaletteCommandData | null {
  return PALETTE_COMMANDS.find((b) => b.keys.some((t) => matchesKey(t, e, mac))) ?? null;
}

// ── Interpreter: the project of a workspace-level file ───────────────────────────────────────────────────────────────────────────────
/** A path in the form the server compares (`path.resolve` in devtools/code-route.js `lspTargetFor`): "//" and "/./" drop out,
 *  ".." removes the part before it (not beyond the root), no trailing slash — like `path.posix.normalize`, without Node in the web.
 *  A relative path stays relative ("" is the root itself, a leading ".." stays). Symlinks are NOT resolved by the web — two ways
 *  through a link stay two paths (`base`/409 still protects). */
export function normPath(p: string): string {
  const s = String(p ?? "");
  const abs = s.startsWith("/");
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); continue; }
    out.push(part);
  }
  return abs ? `/${out.join("/")}` : out.join("/");
}
/** The project whose folder contains the file (the longest path wins) — the same rule as the server (devtools/code-route.js
 *  `lspTargetFor`, both sides normalized). `file` is relative to the workspace folder as in `/files/*`. null: the file belongs to no project. */
export function projectOfTheFile<P extends { id: string; path: string }>(wsPath: string, projects: readonly P[], file: string): P | null {
  const abs = normPath(`${wsPath}/${String(file ?? "").replace(/^\/+/, "")}`);
  let best: P | null = null;
  for (const p of projects ?? []) {
    const w = normPath(p?.path ?? "");
    if (!w || w === "/" || !(abs === w || abs.startsWith(`${w}/`))) continue;
    if (!best || w.length > normPath(best.path).length) best = p;
  }
  return best;
}
