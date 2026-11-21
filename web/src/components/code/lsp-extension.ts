// The ONE entry point of the editor foundation for every editor of the window: the file tab (components/CodePane.tsx — Coding → Files and code
// tabs in the chat) and the editable side of the diff tab (components/code/DiffTab.tsx). For EVERY file: command table with keys and context
// menu, hint, occurrences at the cursor (without a server the same words). With a language (lib/api/lsp.ts `lspLanguageOf`) in addition: the
// file facet, status follow-ups, completion, hover, diagnostics, signature help, rename field and light bulb. What the server does not
// report stays silent and out of the menu.
// Navigation (components/code/lsp-navigation.ts): with a buffer peek, ⌘-click, mouse side buttons and the place for back/forward; `navigation`
// is the editor's connection (components/code/navigation-connection.tsx) — it opens locations as a tab (also the file's own `open`, when none
// is passed). A target outside the instance (read-only buffer) gets no language service: the server only knows files of the instance.
// Palette (components/code/palette-host.ts): the palette's commands for every file, with a language the outline (breadcrumbs, `@`,
// components/code/lsp-layout.ts) and sticky scroll (components/code/sticky-scroll.ts).
// With a language also: the ⌘-hover — link and preview of the definition (components/code/cmd-hover.ts), semantic highlighting
// (components/code/lsp-semantics.ts) and colour squares (components/code/lsp-colors.ts — only where the server reports `document_color`).
import type { Extension } from "@codemirror/state";
import { lspLanguageOf, type LspLocation } from "@/lib/api";
import type { EditorHolder, Buffer } from "@/lib/buffer";
import { hintExtension, lspFile, statusFollowUps } from "@/components/code/lsp-core";
import { commandExtension } from "@/components/code/lsp-commands";
import { occurrencesExtension } from "@/components/code/lsp-occurrences";
import { lspCompletion } from "@/components/code/lsp-completion";
import { lspHover } from "@/components/code/lsp-hover";
import { cmdHover } from "@/components/code/cmd-hover";
import { lspDiagnostics } from "@/components/code/lsp-diagnostics";
import { lspSemantics } from "@/components/code/lsp-semantics";
import { lspColors } from "@/components/code/lsp-colors";
import { colorPicker } from "@/components/code/color-picker";
import { editorLinks } from "@/components/code/editor-links";
import { lspSignature } from "@/components/code/lsp-signature";
import { renameExtension } from "@/components/code/lsp-rename";
import { lspBulb } from "@/components/code/lsp-actions";
import { lspTheme } from "@/components/code/lsp-theme";
import { navigationExtension } from "@/components/code/lsp-navigation";
import type { NavConnection } from "@/components/code/lsp-nav-core";
import { paletteExtension } from "@/components/code/palette-host";
import { outlineExtension } from "@/components/code/lsp-layout";
import { stickyScroll } from "@/components/code/sticky-scroll";

export function editorExtensions(o: {
  /** The buffer the view shows (loaded) — null: only what works without a file. */
  buffer: Buffer | null;
  /** The editor of the view (background tabs). */
  editor?: EditorHolder | null;
  /** Open a location — without: via `navigation`. */
  open?: ((location: LspLocation) => void) | null;
  /** The editor's connection (history, "References" mode, tabs) — without it the peek remains. */
  navigation?: NavConnection | null;
}): Extension {
  const nav = navigationExtension({ connection: o.navigation ?? null, buffer: o.buffer, build: (p) => editorExtensions({ buffer: p, editor: o.editor, navigation: o.navigation }) });
  const base: Extension = [commandExtension(), paletteExtension(), nav, hintExtension, occurrencesExtension, lspTheme, editorLinks]; // links in every file
  const sp = o.buffer ? lspLanguageOf(o.buffer.path) : null;
  if (!o.buffer || !sp || o.buffer.readonly) return base;
  const n = o.navigation, p = o.buffer;
  const open = o.open ?? (n ? (location: LspLocation) => { void n.open(p.target, location); } : null); // the location is relative to the buffer's target
  return [
    base,
    lspFile.of({ buffer: o.buffer, language: sp.language, editor: o.editor ?? null, open }),
    statusFollowUps, lspCompletion, lspHover, cmdHover, lspDiagnostics, lspSemantics, lspSignature, renameExtension, lspBulb,
    outlineExtension, stickyScroll, lspColors, colorPicker,
  ];
}

/** The host of the command palette (CodePane) — passed out here: the editor has ONE entry point. */
export { usePaletteHost } from "@/components/code/palette-host";
