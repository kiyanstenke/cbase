// Third-party notices — what cbase took over or rebuilt from others, and under which license. ONE list for two places: the
// "Third-party notices" page of the settings (components/settings/ThirdPartyHints.tsx, reachable via the row at the bottom of the
// settings list) and the file web/public/THIRD_PARTY_NOTICES.txt (`hintText` — the file IS this computation, character for character).
//
// The obligation: Codicons are under Creative Commons Attribution 4.0 (author, license with link, notice of changes must be
// visible), code from VS Code under MIT — but only the one from the OSS repo (Code - OSS, github.com/microsoft/vscode); the installed
// product "Visual Studio Code" is under Microsoft's product license. Every origin therefore names the repo, the tag and the path
// THERE (checked against raw.githubusercontent.com: every path returns 200 and contains the names given).
//
// The criterion: every file that rebuilds code or an algorithm from VS Code, or takes data from it, carries in its header exactly the
// mark `markerOf(h, s)` per piece — "// Port of: <repo> <path> (<license>)" or "// Taken from: …" — and is listed here under that
// piece. What merely imitates a BEHAVIOR (keys, menus, color values, spacing) without taking code needs no mark; free text claiming a
// rebuild without a mark is therefore a named exception in the guard.
//
// Guard: web/test/thirdParty.test.mjs — the file in public/ is `hintText()`; mark ↔ list in both directions; every file that
// names one of these licenses is listed here; free text claiming a rebuild carries a mark or is a named exception; the page shows
// every entry via t() with English text; with sabotages.

export type Chunk = {
  /** "Port of": code or algorithm rewritten; "Taken from": data (glyphs, symbols) unchanged or converted. */
  kind: "Port of" | "Taken from";
  /** The path in the entry's repo at `revision` (file or folder). */
  path: string;
  /** What of it stands in cbase — an English UI key (the page translates it, the file names it verbatim). */
  what: string;
  /** Where it lives in cbase's repo (paths relative to the root); each of these files carries `markerOf(h, s)`. */
  files: readonly string[];
};

export type ThirdHint = {
  /** The proper name (not translated). */
  name: string;
  /** The repo on GitHub (`owner/name`) and its state (a tag). */
  repo: string;
  revision: string;
  /** What makes the origin more precise (e.g. which package a font came from) — not translated, like paths. */
  annotation?: string;
  originator: string;
  license: string;
  /** The license as in the files' mark. */
  licenseShort: "MIT" | "CC BY 4.0";
  licenseUrl: string;
  /** What cbase changed — English UI keys (the page translates them, the file names them verbatim). */
  changes: readonly string[];
  chunks: readonly Chunk[];
};

export const HINTS: readonly ThirdHint[] = [
  {
    name: "Codicons",
    repo: "microsoft/vscode-codicons",
    revision: "v0.0.46-46",
    annotation: "outlines from dist/codicon.ttf of the npm package @vscode/codicons 0.0.46-46 (built from src/icons; sha256 fe9082f0a5b97134…, "
      + "the same file as out/media/codicon.ttf in Visual Studio Code 1.143.1), SVG paths from src/icons/<name>.svg",
    originator: "© Microsoft Corporation",
    license: "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    licenseShort: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    changes: ["Outlines converted to a 16×16 grid and rounded", "Further glyphs taken over unchanged as SVG paths"],
    chunks: [
      {
        kind: "Taken from", path: "src/icons", what: "Editor glyphs (symbols, buttons, title bar)",
        files: ["web/src/lib/codicon-symbols.ts", "web/src/components/code/EditorTitleSymbols.tsx", "web/src/lib/codicons.ts"],
      },
    ],
  },
  {
    name: "Visual Studio Code (Code - OSS)",
    repo: "microsoft/vscode",
    revision: "1.143.1",
    originator: "© Microsoft Corporation",
    license: "MIT License",
    licenseShort: "MIT",
    licenseUrl: "https://github.com/microsoft/vscode/blob/1.143.1/LICENSE.txt",
    changes: ["Rewritten in TypeScript or JavaScript, names and form adapted to cbase"],
    chunks: [
      { kind: "Taken from", path: "extensions/markdown-language-features/media/preview-dark.svg", what: "Markdown preview icon taken over", files: ["web/src/components/code/EditorTitleSymbols.tsx"] },
      { kind: "Port of", path: "src/vs/base/common/fuzzyScorer.ts", what: "Quick Open scoring reimplemented", files: ["web/src/lib/fuzzy-scorer.ts", "server/backend/electron/server/runtime/fast-open.js"] },
      { kind: "Port of", path: "src/vs/base/common/filters.ts", what: "Command palette word filter reimplemented", files: ["web/src/lib/fuzzy-scorer.ts"] },
      { kind: "Port of", path: "src/vs/base/common/strings.ts", what: "Quick Open prefilter reimplemented", files: ["server/backend/electron/server/runtime/fast-open.js"] },
      { kind: "Port of", path: "src/vs/base/common/labels.ts", what: "Shortening of same-named paths reimplemented", files: ["web/src/lib/tab-bar.ts"] },
      { kind: "Port of", path: "src/vs/base/common/search.ts", what: "Case preservation on replace reimplemented", files: ["web/src/lib/preserve-case.ts"] },
      { kind: "Port of", path: "src/vs/base/browser/ui/tree/abstractTree.ts", what: "Sticky folders in the tree reimplemented", files: ["web/src/lib/tree-sticky.ts"] },
      { kind: "Port of", path: "src/vs/base/browser/ui/tree/abstractTree.ts", what: "ARIA attributes of tree rows reimplemented", files: ["web/src/lib/tree-window.ts"] },
      { kind: "Port of", path: "src/vs/base/browser/ui/list/listView.ts", what: "Virtualized Explorer rows reimplemented", files: ["web/src/lib/tree-window.ts", "web/src/components/code/explorer/TreeWindow.tsx"] },
      { kind: "Port of", path: "src/vs/editor/common/model/guidesTextModelPart.ts", what: "Indentation guides reimplemented", files: ["web/src/lib/indentation.ts"] },
      { kind: "Port of", path: "src/vs/workbench/contrib/files/browser/fileActions.ts", what: "Copy names and file name validation reimplemented", files: ["web/src/lib/explorer-names.ts"] },
      { kind: "Port of", path: "src/vs/workbench/contrib/files/browser/fileImportExport.ts", what: "Import of entries from another window reimplemented", files: ["web/src/lib/explorer-names.ts"] },
      { kind: "Port of", path: "src/vs/base/common/htmlContent.ts", what: "Image dimensions in Markdown reimplemented", files: ["web/src/lib/hover-sections.ts"] },
      { kind: "Port of", path: "src/vs/workbench/contrib/scm/browser/quickDiffModel.ts", what: "Quick Diff peek navigation reimplemented", files: ["web/src/lib/quick-diff.ts"] },
      { kind: "Port of", path: "src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts", what: "Quick Diff peek measurements reimplemented", files: ["web/src/lib/quick-diff.ts"] },
      { kind: "Port of", path: "src/vs/base/browser/ui/grid/grid.ts", what: "Editor group grid reimplemented", files: ["web/src/lib/editor-raster.ts"] },
      { kind: "Port of", path: "src/vs/base/browser/ui/grid/gridview.ts", what: "Grid nesting and sizes reimplemented", files: ["web/src/lib/editor-raster.ts"] },
      { kind: "Port of", path: "src/vs/base/browser/ui/splitview/splitview.ts", what: "Sash dragging reimplemented", files: ["web/src/lib/editor-raster.ts"] },
      { kind: "Port of", path: "src/vs/workbench/browser/parts/editor/editorPart.ts", what: "Splitting, closing and merging of editor groups reimplemented", files: ["web/src/lib/editor-groups.ts"] },
      { kind: "Port of", path: "src/vs/workbench/browser/parts/editor/editorActions.ts", what: "Editor group commands and layouts reimplemented", files: ["web/src/lib/editor-groups.ts"] },
      { kind: "Port of", path: "src/vs/workbench/browser/parts/editor/editorCommands.ts", what: "Moving editors between groups reimplemented", files: ["web/src/lib/editor-groups.ts"] },
      { kind: "Port of", path: "src/vs/workbench/browser/parts/editor/editorDropTarget.ts", what: "Drop zones on an editor group reimplemented", files: ["web/src/lib/editor-groups.ts"] },
      { kind: "Port of", path: "extensions/markdown-language-features/src/client/client.ts", what: "Client side of the Markdown language server reimplemented", files: ["server/backend/electron/server/lsp/markdown.js"] },
      { kind: "Port of", path: "extensions/markdown-language-features/src/extensions/yamlPreamble/yamlPreamble.ts", what: "Front matter rule for markdown-it reimplemented", files: ["server/backend/electron/server/lsp/markdown.js"] },
      { kind: "Port of", path: "src/vs/workbench/contrib/debug/browser/debug.contribution.ts", what: "Run or Debug button of the editor title bar reimplemented", files: ["web/src/lib/editor-title.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorDetector.ts", what: "Color squares before color values reimplemented", files: ["web/src/lib/color-square.ts", "web/src/components/code/lsp-colors.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorPicker.css", what: "Dimensions of the color squares and the color picker reimplemented", files: ["web/src/components/code/lsp-colors.ts", "web/src/components/code/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/base/common/color.ts", what: "Color math (RGBA, HSVA, CSS, light/dark) reimplemented", files: ["web/src/lib/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorPickerModel.ts", what: "Color picker presentations reimplemented", files: ["web/src/lib/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorPickerParts/colorPickerSaturationBox.ts", what: "Color picker saturation box reimplemented", files: ["web/src/lib/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorPickerParts/colorPickerStrip.ts", what: "Hue and opacity strips reimplemented", files: ["web/src/lib/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorPickerWidget.ts", what: "Color picker reimplemented", files: ["web/src/components/code/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorPickerParts/colorPickerHeader.ts", what: "Color picker header reimplemented", files: ["web/src/components/code/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorPickerParts/colorPickerBody.ts", what: "Color picker body reimplemented", files: ["web/src/components/code/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/hoverColorPicker/hoverColorPickerParticipant.ts", what: "Color picker in the hover reimplemented", files: ["web/src/components/code/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/colorPicker/browser/colorPickerParticipantUtils.ts", what: "Writing the picked color reimplemented", files: ["web/src/components/code/color-picker.ts"] },
      { kind: "Port of", path: "src/vs/editor/common/languages/linkComputer.ts", what: "Detection of addresses in text reimplemented", files: ["web/src/lib/link-detection.ts"] },
      { kind: "Port of", path: "src/vs/editor/contrib/links/browser/links.ts", what: "Links in the editor (hint, ⌘-click) reimplemented", files: ["web/src/components/code/editor-links.ts"] },
      { kind: "Taken from", path: "extensions/theme-seti/icons/vs-seti-icon-theme.json", what: "File icon colours of the Seti theme taken over", files: ["web/src/lib/file-symbols.ts"] },
    ],
  },
  // The German wordings of Explorer and editor stem from the German language pack. The repo carries no tags since 1.98 — the state
  // is the `main` commit read against. The adopted texts themselves are scattered over the components (as keys of t()); their ONE list
  // is the table below (a row per wording with key and the pack's value), which carries the marks in its field `markers` (JSON has no
  // comments).
  {
    name: "VS Code Language Pack (German)",
    repo: "microsoft/vscode-loc",
    revision: "62d5443b567022539ba6e8565b0f43f5f6b3682b",
    annotation: "branch main, read on 29.10.2026 and 31.10.2026 (commit of 19.10.2026); package i18n/vscode-language-pack-de",
    originator: "© Microsoft Corporation",
    license: "MIT License",
    licenseShort: "MIT",
    licenseUrl: "https://github.com/microsoft/vscode-loc/blob/62d5443b567022539ba6e8565b0f43f5f6b3682b/LICENSE.md",
    changes: ["Wording adopted entry by entry, “...” as “…”, typographic quotes, placeholders named after their content, informal “du” instead of “Sie”"],
    chunks: [
      { kind: "Taken from", path: "i18n/vscode-language-pack-de/translations/main.i18n.json", what: "German wording of Explorer and editor adopted", files: ["web/src/lib/i18n-de.ts", "web/test/fixtures/vscode-de-wordings.json"] },
      { kind: "Taken from", path: "i18n/vscode-language-pack-de/translations/extensions/vscode.git.i18n.json", what: "German wording of the Git commands adopted", files: ["web/src/lib/i18n-de.ts", "web/test/fixtures/vscode-de-wordings.json"] },
      { kind: "Taken from", path: "i18n/vscode-language-pack-de/translations/extensions/vscode.references-view.i18n.json", what: "German wording of the References view adopted", files: ["web/src/lib/i18n-de.ts", "web/test/fixtures/vscode-de-wordings.json"] },
      { kind: "Taken from", path: "i18n/vscode-language-pack-de/translations/extensions/vscode.typescript-language-features.i18n.json", what: "German wording of “Go to Source Definition” adopted", files: ["web/src/lib/i18n-de.ts", "web/test/fixtures/vscode-de-wordings.json"] },
      { kind: "Taken from", path: "i18n/vscode-language-pack-de/translations/extensions/vscode.markdown-language-features.i18n.json", what: "German wording of the Markdown preview adopted", files: ["web/src/lib/i18n-de.ts", "web/test/fixtures/vscode-de-wordings.json"] },
      { kind: "Taken from", path: "i18n/vscode-language-pack-de/translations/extensions/vscode.markdown-language-features.i18n.json", what: "German messages of the Markdown language server taken over unchanged", files: ["server/backend/electron/server/lsp/l10n/de/vscode.markdown-language-features.i18n.json"] },
      { kind: "Taken from", path: "i18n/vscode-language-pack-de/translations/extensions/vscode.css-language-features.i18n.json", what: "German messages of the CSS language server taken over unchanged", files: ["server/backend/electron/server/lsp/l10n/de/vscode.css-language-features.i18n.json"] },
      { kind: "Taken from", path: "i18n/vscode-language-pack-de/translations/extensions/vscode.json-language-features.i18n.json", what: "German messages of the JSON language server taken over unchanged", files: ["server/backend/electron/server/lsp/l10n/de/vscode.json-language-features.i18n.json"] },
    ],
  },
];

/**
 * Material under a license without conditions (public domain dedication) or data so small that no license condition applies, named
 * as a courtesy: no marker, no pinned state. The page and the file show each row; what it is used for is an English UI key.
 */
export type Attribution = {
  name: string;
  originator: string;
  license: string;
  licenseUrl: string;
  /** The project's home (a repo or site). */
  source: string;
  what: string;
  files: readonly string[];
};

export const ATTRIBUTIONS: readonly Attribution[] = [
  {
    name: "Simple Icons",
    originator: "Simple Icons contributors",
    license: "Creative Commons Zero v1.0 Universal (CC0 1.0)",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    source: "https://github.com/simple-icons/simple-icons",
    what: "Brand logos and colours of the MCP servers taken over (the logos remain trademarks of their owners)",
    files: ["web/src/components/brandLogos.ts"],
  },
  {
    name: "Seti UI",
    originator: "© Jesse Weed",
    license: "MIT License",
    licenseUrl: "https://opensource.org/license/mit",
    source: "https://github.com/jesseweed/seti-ui",
    what: "Origin of the Seti file icon colours (taken over through VS Code's theme-seti, see above)",
    files: ["web/src/lib/file-symbols.ts"],
  },
  {
    name: "Simple Icons (provider and integration logos)",
    originator: "Simple Icons contributors",
    license: "Creative Commons Zero v1.0 Universal (CC0 1.0)",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    source: "https://github.com/simple-icons/simple-icons",
    what: "GitLab logo and ngrok wordmark in the web UI and the iOS app (the logos remain trademarks of their owners; list: TRADEMARKS.md)",
    files: [
      "web/src/components/settings/IntegrationsSettings.tsx",
      "mobile/CbaseMobile/Assets.xcassets/IntegrationGitLab.imageset/gitlab.svg",
      "mobile/CbaseMobile/Assets.xcassets/IntegrationNgrok.imageset/ngrok.svg",
    ],
  },
];
/** An attribution's row — the same on the page and in the file. */
export const attributionRow = (a: Attribution): string => `${a.name} — ${a.originator} — ${a.license} — ${a.licenseUrl} — ${a.source}`;

/** A package cbase ships UNCHANGED (npm, in the image under /app/node_modules — there with its license file). */
export type Pack = {
  name: string;
  /** Version and license (SPDX) as in the lockfile (server/backend/package-lock.json) — the guard pins both to it. */
  version: string;
  license: string;
  /** The repo on GitHub (`owner/name`). */
  repo: string;
};

/**
 * The backend packages whose license was checked on adoption (markdown-it for the client side of the Markdown language server,
 * server/backend/electron/server/lsp/markdown.js, with everything it pulls in). All allow redistribution with a license notice; the
 * notice sits in the image per package. Older backend packages are not (yet) listed here.
 */
export const PACKAGES: readonly Pack[] = [
  { name: "markdown-it", version: "14.3.3", license: "MIT", repo: "markdown-it/markdown-it" },
  { name: "linkify-it", version: "5.0.2", license: "MIT", repo: "markdown-it/linkify-it" },
  { name: "mdurl", version: "2.1.0", license: "MIT", repo: "markdown-it/mdurl" },
  { name: "uc.micro", version: "2.1.0", license: "MIT", repo: "markdown-it/uc.micro" },
  { name: "punycode.js", version: "2.3.1", license: "MIT", repo: "mathiasbynens/punycode.js" },
  { name: "entities", version: "4.5.0", license: "BSD-2-Clause", repo: "fb55/entities" },
  { name: "argparse", version: "2.0.1", license: "Python-2.0", repo: "nodeca/argparse" },
];
/** A package's row — the same on the page and in the file. */
export const packageRow = (p: Pack): string => `${p.name} ${p.version} — ${p.license} — https://github.com/${p.repo}`;

/** A piece's mark in the header of each of its files (one line, verbatim). */
export const markerOf = (h: ThirdHint, s: Chunk): string => `// ${s.kind}: ${h.repo} ${s.path} (${h.licenseShort})`;
/** How the guard recognizes a mark — every line of this form, even one that matches no piece (that is then an error). */
const MARKER = /^\/\/ (?:Port of|Taken from): \S+ \S+ \((?:MIT|CC BY 4\.0)\)$/;
/** A file's marks, in their order. */
export const markersIn = (text: string): string[] => text.split("\n").map((z) => z.replace(/\r$/, "")).filter((z) => MARKER.test(z));
/** The repo at its state — the "Source" link. */
export const sourceOf = (h: ThirdHint): string => `https://github.com/${h.repo}/tree/${h.revision}`;
/** Where exactly from: repo, state and the annotation. */
export const originOf = (h: ThirdHint): string => `${h.repo}, Tag ${h.revision}${h.annotation ? ` — ${h.annotation}` : ""}`;
/** All files of an entry, each once, in the order of the pieces. */
export const filesOf = (h: ThirdHint): string[] => [...new Set(h.chunks.flatMap((s) => s.files))];

/** The license text of VS Code (Code - OSS) — MIT requires it in every copy (LICENSE.txt at tag 1.143.1, character for character). */
export const MIT_VSCODE = `MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The language pack's license text (LICENSE.md at the commit above; header lines without the Markdown separators, the license text as there — also
 *  without the final period). */
export const MIT_VSCODE_LOC = `Visual Studio Code Localization Packs
Copyright (c) Microsoft Corporation
All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE`;

/** Runtime dependencies of the web bundle, the contents of the backend image and the Seti UI license text (resolved versions and license fields from
 *  web/package-lock.json and server/backend/package-lock.json). Appended to the file after the backend packages. */
export const EXTRA_NOTICES = `------------------------------------------------------------------------------
Web bundle — runtime dependencies
------------------------------------------------------------------------------
Direct dependencies of web/package.json, version as resolved in web/package-lock.json, license as given there. Shipped unmodified; each
package's license text is in its npm package. Transitive packages are listed with their license in web/package-lock.json (mostly MIT,
ISC, BSD-3-Clause, 0BSD or Apache-2.0; the @img/sharp-libvips-* packages pulled in by sharp are LGPL-3.0-or-later and the
@img/sharp-{win32,wasm32}-* packages are Apache-2.0 AND LGPL-3.0-or-later — see the libvips note under Image contents; the
lightningcss* packages are MPL-2.0 and used at build time only; caniuse-lite data is CC BY 4.0, build time only).
  @codemirror/autocomplete 6.20.3 — MIT — https://github.com/codemirror/autocomplete
  @codemirror/commands 6.10.4 — MIT — https://github.com/codemirror/commands
  @codemirror/lang-markdown 6.5.1 — MIT — https://github.com/codemirror/lang-markdown
  @codemirror/language 6.12.4 — MIT — https://github.com/codemirror/language
  @codemirror/language-data 6.5.2 — MIT — https://github.com/codemirror/language-data
  @codemirror/lint 6.9.7 — MIT — https://github.com/codemirror/lint
  @codemirror/merge 6.12.2 — MIT — https://github.com/codemirror/merge
  @codemirror/search 6.7.1 — MIT — https://github.com/codemirror/search
  @codemirror/state 6.7.1 — MIT — https://github.com/codemirror/state
  @codemirror/view 6.43.6 — MIT — https://github.com/codemirror/view
  @lezer/highlight 1.2.3 — MIT — https://github.com/lezer-parser/highlight
  @replit/codemirror-minimap 0.5.2 — MIT — https://github.com/replit/codemirror-minimap
  @uiw/react-codemirror 4.25.11 — MIT — https://github.com/uiwjs/react-codemirror
  @xterm/addon-fit 0.11.0 — MIT — https://github.com/xtermjs/xterm.js
  @xterm/xterm 6.0.0 — MIT — https://github.com/xtermjs/xterm.js
  next 15.5.4 — MIT — https://github.com/vercel/next.js
  react 19.1.1 — MIT — https://github.com/facebook/react
  react-dom 19.1.1 — MIT — https://github.com/facebook/react
Transitive runtime packages that reach the bundle include @swc/helpers 0.5.15 (Apache-2.0) and tslib 2.8.1 (0BSD).

------------------------------------------------------------------------------
Image contents
------------------------------------------------------------------------------
The repository contains no provider CLIs. Images built from server/backend/Dockerfile install the packages and tools below at build time
from their upstream sources. Each keeps its own license; the full license texts are in the image, in the node_modules folder of the
package or in the tool's package. Images that contain Claude Code, Codex or the VS Code CLI are for the builder's own use and must not be
pushed to a public registry.

Backend npm runtime dependencies (server/backend/package.json, version as resolved in server/backend/package-lock.json):
  @huggingface/transformers 3.8.1 — Apache-2.0 — https://github.com/huggingface/transformers.js
  @ngrok/ngrok 1.7.0 — MIT OR Apache-2.0 — https://github.com/ngrok/ngrok-javascript
  ajv 8.20.0 — MIT — https://github.com/ajv-validator/ajv
  markdown-it 14.3.3 — MIT — https://github.com/markdown-it/markdown-it
  node-pty 1.1.0 — MIT — https://github.com/microsoft/node-pty
  typescript 5.9.3 — Apache-2.0 — https://github.com/microsoft/TypeScript
  ws 8.21.1 — MIT — https://github.com/websockets/ws
Notable transitive packages (license field of the lockfile):
  sharp 0.34.5 — Apache-2.0 — https://github.com/lovell/sharp
  @img/sharp-libvips-* 1.2.4 — LGPL-3.0-or-later — https://github.com/lovell/sharp-libvips
  onnxruntime-node 1.21.0, onnxruntime-common 1.21.0, onnxruntime-web 1.22.0-dev — MIT — https://github.com/microsoft/onnxruntime
  The @img/sharp-libvips-* packages hold the libvips library (LGPL-3.0-or-later). sharp loads it dynamically as a separate shared library;
  it is not linked into cbase and can be replaced by another build of libvips. Source: https://github.com/lovell/sharp-libvips and
  https://github.com/libvips/libvips.

Tools installed by the Dockerfile (version pinned there):
  Claude Code (@anthropic-ai/claude-code) — proprietary, Anthropic's terms apply — https://github.com/anthropics/claude-code
  Codex CLI (@openai/codex) — Apache-2.0 — https://github.com/openai/codex
  VS Code CLI (downloaded from update.code.visualstudio.com) — Microsoft Software License Terms, not MIT — https://aka.ms/vscode-server-license
  go-task (@go-task/cli) — MIT — https://github.com/go-task/task
  typescript-language-server — Apache-2.0 — https://github.com/typescript-language-server/typescript-language-server
  typescript — Apache-2.0 — https://github.com/microsoft/TypeScript
  basedpyright — MIT — https://github.com/DetachHead/basedpyright
  yaml-language-server — MIT — https://github.com/redhat-developer/yaml-language-server
  vscode-langservers-extracted — MIT — https://github.com/hrsh7th/vscode-langservers-extracted
  Docker Compose (plugin) — Apache-2.0 — https://github.com/docker/compose
  Docker Buildx (plugin) — Apache-2.0 — https://github.com/docker/buildx

------------------------------------------------------------------------------
Seti UI — MIT License
------------------------------------------------------------------------------
Copyright (c) 2014 Jesse Weed

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Codicons license text (CC BY 4.0): https://creativecommons.org/licenses/by/4.0/legalcode`;

/** Where the file lives on the web (web/public → the site root). */
export const HINT_FILE = "/THIRD_PARTY_NOTICES.txt";
// `process` for the one build-time variable below. Declared here, module-scoped, because the guard (web/test/thirdParty.test.mjs)
// compiles THIS FILE alone, without the node types; in the app the Next build replaces the whole `process.env.NEXT_PUBLIC_…` term
// with its value, so nothing of it reaches the browser.
declare const process: { env: Record<string, string | undefined> };

/**
 * cbase's own licence and where its source is — the AGPL (section 13) asks that network users can get the source. A fork that offers
 * a modified version over a network sets NEXT_PUBLIC_SOURCE_URL at build time to ITS OWN repository; this repository is the default.
 */
export const PROJECT: { license: string; licenseUrl: string; source: string } = {
  license: "GNU AGPL-3.0-only",
  licenseUrl: "https://www.gnu.org/licenses/agpl-3.0.html",
  source: process.env.NEXT_PUBLIC_SOURCE_URL || "https://github.com/kiyanstenke/cbase",
};

/** A piece's row — the same on the page and in the file. */
export const chunkRow = (s: Chunk): string => `${s.kind}: ${s.path} — ${s.what}`;

/** The content of web/public/THIRD_PARTY_NOTICES.txt — the same entries as the page, plus the MIT text. */
export function hintText(): string {
  const stroke = "-".repeat(78);
  const parts = [
    "cbase — Third-Party Notices",
    "",
    `cbase itself is licensed under the ${PROJECT.license} (${PROJECT.licenseUrl}); its source code is at ${PROJECT.source}.`,
    "",
    "cbase contains third-party material. Per entry: author, license with link, source (repo and tag), changes and per part the path",
    "in the repo with the files of cbase that carry it (each with the same marker in its header).",
  ];
  for (const h of HINTS) {
    parts.push(
      "", stroke, h.name, stroke,
      h.originator,
      `License: ${h.license} — ${h.licenseUrl}`,
      `Source: ${sourceOf(h)}`,
      `Origin: ${originOf(h)}`,
      `Changes: ${h.changes.join("; ")}.`,
      "Parts:",
      ...h.chunks.flatMap((s) => [`  ${chunkRow(s)}`, ...s.files.map((d) => `    ${d}`)]),
    );
  }
  parts.push(
    "", stroke, "Further attributions", stroke,
    ...ATTRIBUTIONS.flatMap((a) => [`  ${attributionRow(a)}`, `    ${a.what}`, ...a.files.map((d) => `    ${d}`)]),
  );
  parts.push(
    "", stroke, "Backend packages", stroke,
    "Shipped unmodified; each package's license text is in the image under /app/node_modules/<name>/",
    ...PACKAGES.map((p) => `  ${packageRow(p)}`),
  );
  parts.push("", stroke, "Visual Studio Code (Code - OSS) — MIT License", stroke, MIT_VSCODE);
  parts.push("", stroke, "VS Code Language Pack (German) — MIT License", stroke, MIT_VSCODE_LOC);
  parts.push("", EXTRA_NOTICES);
  return `${parts.join("\n")}\n`;
}
