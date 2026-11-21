// The editor defaults of VS Code out of the box — ONE place for font, line height, cursor and the
// shadows when scrolling; read by components/code/codeTheme.ts (all code editors), components/CodePane.tsx (default of the setting
// "Font size") and components/code/sticky-scroll.ts.
//
// Sources (VS Code):
// - src/vs/editor/common/config/fontInfo.ts `EDITOR_FONT_DEFAULTS`: on the Mac "Menlo, Monaco, 'Courier New', monospace" at 12 px, on
//   Windows Consolas, on Linux "Droid Sans Mono" (there 14 px); `lineHeight: 0` ⇒ `GOLDEN_LINE_HEIGHT_RATIO` × font size = 1.5 on the
//   Mac (otherwise 1.35). cbase takes the Mac values (the desktop client runs on the Mac); the font list carries Consolas and Droid Sans
//   Mono behind it, so a browser on Windows/Linux takes what VS Code would take there.
// - src/vs/editor/browser/viewParts/viewCursors/viewCursors.ts: `cursorBlinking: "blink"` — 500 ms visible, 500 ms not, hard (no
//   cross-fade); `cursorWidth` 0 ⇒ 2 px.
// - scrollDecoration.css: a 6 px shadow on top as soon as the editor is scrolled (`scrollbar.shadow`: dark #000000, light #dddddd).
// - stickyScroll.css: the pinned strip WITHOUT an edge (`editorStickyScroll.border` is empty), with shadow `0 4px 2px -2px` in
//   `editorStickyScroll.shadow` (= scrollbar.shadow), on hover `editorStickyScrollHover.background` (#2a2d2e / #f0f0f0).
//
// Pure (no imports): EXECUTED in web/test/suggestion-list.test.mjs.

export const EDITOR_FONT = "Menlo, Monaco, Consolas, 'Droid Sans Mono', 'Courier New', monospace";
export const EDITOR_FONT_SIZE = 12;
/** Line height as a multiple of the font size (12 px ⇒ 18 px). */
export const EDITOR_LINE_FACTOR = 1.5;
/** A whole blink period (CodeMirror `cursorBlinkRate`: half of it visible). */
export const CURSOR_BLINK_MS = 1000;
export const SCROLL_SHADOW_HEIGHT = 6;
export const SCROLL_COLORS = {
  dark: { shadow: "#000000", stickyHover: "#2a2d2e" },
  light: { shadow: "#dddddd", stickyHover: "#f0f0f0" },
} as const;
/** The shadow on top as soon as scrolled (VS Code `.scroll-decoration`); none when unscrolled. */
export const scrollShadowVisible = (scrollTop: number): boolean => scrollTop > 0;
