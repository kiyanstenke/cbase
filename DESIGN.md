# Designing for cbase

cbase is a workbench: someone lets coding agents work for hours in their own containers and checks in now and then to read,
step in or approve. The interface therefore takes the form people already keep open all day, the chat. This file is the form
system in more depth than `AGENTS.md`. Read it before you add a surface, a colour or a component, on the web or on iOS.

Four rules carry everything else:

1. **Flat.** Opaque surfaces, form from hairlines, no glass and no blur on the web.
2. **One signal colour.** The accent (cobalt by default) means "something runs here" or "you are here", and nothing else.
3. **Quiet at rest.** Nothing moves unless the machine is working or the user just did something.
4. **Dense.** 11–13 px for the interface; 15.5 px only for what is read in the chat column.

## Web

### Colour roles

All colours are roles, defined in `web/src/app/globals.css`: light values in `@theme`, dark values under
`:root[data-theme="dark"]`. Tailwind utilities resolve them at use (`bg-panel`, `text-dim`, `border-edge` …), so a container can
recolour everything below it by redefining a role. Never write a hex value into a component; a new role goes into both blocks.

| Role | Use | Dark |
|---|---|---|
| `bg` | Page ground; fill of fields, search capsules and filter chips | #121212 |
| `panel` | Reading surface of the chat; a focused field | #181818 |
| `hover` | Hover step on `bg` and `panel` | #262626 |
| `edge` | Every hairline and border; the neutral "expanded" step of a row | #2f2f2f |
| `fg` / `dim` | Text / secondary text (metadata, inactive tabs, ghost buttons) | #f3f3f3 / #9b9b9b |
| `accent` / `accent-soft` | The one signal: selection, focus, link, a running chat | #4d89ff / #1f2d45 |
| `dark` | The counter-surface: primary button, chosen chip, segment thumb | #333333 |
| `bubble`, `tool`, `code` | User message, tool rows in the history, code blocks | |
| `danger`, `warn`, `ok` | States, always as a 10–15 % tinted surface with full-colour text | |
| `frame`, `frame-edge`, `frame-hover`, `frame-active` | Header and icon rail in one colour; the page lies in it as a 12 px card | |

The dark palette is the one of the ChatGPT app: ground #121212, reading surface #181818, hairline #2f2f2f, cards #2a2a2a, menus
#2d2d2d. Light is warm paper with a white reading surface; under `.cb-kit` (the coding views) a cool set of greys applies instead.
The accent is cobalt (#1f57f7, dark #4d89ff) and the user can change it (`web/src/lib/accent.ts`); selected rows take it at 14 %
(`SELECTED` in CbKit).

### The flat form

`cb-flat` sits on the body (`web/src/app/layout.tsx`), so the flat form applies everywhere, portals included:

- **Cards** (`cb-kit-pane`): opaque, a hairline, no shadow, no blur. Variations are classes in `globals.css`
  (`cb-kit-pane-accent`, `-warn`, `-hover`, `-dashed`), not utilities on the element: the pane rule is unlayered and beats them.
- **Menus and modals** (`cb-pop`, `cb-sheet`): opaque, a 10 % edge, 16 px radius, exactly one soft shadow. The scrim
  (`cb-overlay`) darkens without blur.
- **One surface per list.** A list is one card; its rows are separated by hairlines. Thirty boxes with their own edge are thirty
  claims.
- **Capsule or card.** What you operate is a capsule (`rounded-full`); what contains things is a card (12–16 px). Menu rows are
  rounded 10 px, concentric to the 16 px sheet.
- **Strips, not wraps.** A row that does not fit scrolls sideways (`cb-strip`); a title that does not fit fades out (`cb-fade-r`)
  instead of ending in "…".
- **One base rule per class** in `globals.css` (guard `web/test/css-one-rule-per-class.test.mjs`); no blur and no glass
  variables (guard `web/test/flat-css.test.mjs`).

### Building blocks (`web/src/components/CbKit.tsx`)

Take the kit before you write a class of your own.

| Need | Use |
|---|---|
| A button | `ghost` (the normal case), `primary` (completes something: save, create), `accent` (only when the action itself is the signal: start a run, approve), `quietDanger` (destructive, quiet until hovered). `…Sm` for toolbars that repeat. |
| An input | `field` (a tray without a frame; focus lifts it to `panel`), `select`, `Search` (a capsule) |
| Filters and tabs | `FilterChip` (warning tone only when its count is above 0), `Segments` (tabs inside a page; the thumb jumps, only the colour fades) |
| A menu | `Menu` with `MenuEntry` and `MenuSeparator`; `popClass` for a custom popover |
| A dialog | `Modal`, `ModalTitle` |
| A state or a gap | `Hint` (tinted danger / warn / ok), `Empty`, `EmptySentence`, `Loading`, `Placeholder` |
| Page structure | `PagesHeader`, `Header`, `Overline`, `Section`, `SectionHeader`, `SplitPane` (list and detail side by side when the container is wide enough) |
| Rows | `ROW`, `LIST_ROW`, `FACTS` with `Fact`, `Tile`, `Toggle` |

### Layout

- **Container queries, not window queries.** The same page stands in a browser window, in the desktop client and next to a
  sidebar, so widths ask the container (`@container/kit`, `@container/history`).
- **Portals.** Modals and menus hang on `document.body` through a portal. Since Chromium 152 `app-region` inherits: anything in
  the DOM under the desktop client's drag header would become a drag region. A click-catcher is never `fixed inset-0`.
- **The chat column** is 736 px wide (about 82 characters at 15.5 px). In an empty chat the composer sits in the middle.

### Type and motion

- Sizes by role: page title 24 px; modal and card heads 15 px semibold; reading 15.5 px; interface 13 px; buttons, chips and
  hints 12 px; metadata 11–12 px; overline 10 px semibold uppercase. Do not invent intermediate sizes.
- Monospace means "type it exactly like this" (paths, IDs, commands), never emphasis.
- A switch of tab, category or page fades in over 150 ms through `--cb-switch` / `--cb-switch-fade`, never a second number in
  TypeScript. Animate `transform` and `opacity` only. Anything that loops runs only while the machine works and stops under
  `prefers-reduced-motion`.

### Text and translation

UI strings are English and are themselves the dictionary keys: `t("Save")` with `useT()` from `web/src/lib/i18n.ts`. Add the
German translation to `web/src/lib/i18n-de.ts`; a missing entry falls back to English, never to an empty string.

## iOS (`mobile/CbaseMobile/`)

The same product, with the grammar of Apple's Human Interface Guidelines. Building blocks live in `mobile/CbaseMobile/Kit/`.

- **Colours.** Surfaces, edges and text come from the app's own warm roles in `Kit/CbColor.swift` (ground, surface, elevated,
  selection, edge, text …), never from the system backgrounds, which carry a cold blue cast in dark mode. System colours stay
  where they are neutral: `.primary`/`.secondary` text, `Divider()`, status colours. Every form and list is `CbForm`/`CbList`.
- **Liquid Glass** (iOS 26; opaque below) in the chat (composer island, header zone, the "to the end" arrow) and in both
  drawers, never glass on glass (`Kit/CbGlass.swift`). This is the deliberate platform difference: the web is flat, iOS carries
  glass.
- **Sheets.** Every `.sheet` carries `.cbSheet(…)` (guard `web/test/ios-sheets.test.mjs`); closing is one ✕ top left
  (`SheetCloseButton`, 44 pt).
- **Rows and tiles** from `Kit/CbRows.swift` and `Kit/CbTile.swift`, lists without cards around them.
- **Text sizes** only through `cbFont` / `chatFont` (Dynamic Type); minimum tap target 44 × 44 pt.
- **Accent.** The default is terracotta (#a94c2d, dark #d47353) where the web uses cobalt. That difference is deliberate; both
  sides derive light and dark the same way from one chosen colour (`Kit/AccentColor.swift` and `web/src/lib/accent.ts`, guard
  `web/test/accent.test.mjs`).
- **Text.** iOS has its own German dictionary on top of the English keys (`Kit/LocDE*.swift`).

## What not to do

- No glass, blur, gradients as ground or large colourful metric cards on the web.
- No decorative "AI" look: no glowing orbs, sparkle ornaments, gradient text or ever-pulsing "thinking" marks.
- No accent as decoration, no shadow on a card, no new font size.
- No company logos drawn or redrawn by hand. Providers carry neutral glyphs (`web/src/components/ProviderMarks.tsx`); third-party
  marks and their sources are listed in `TRADEMARKS.md`.
