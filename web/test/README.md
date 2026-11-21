# `web/test/` — the web suite in the gate

About 200 `*.mjs` files. The gate's glob is **`web/test/*.mjs`** (`tools/check/targets/check.mjs`); a file also runs alone:

```sh
node --test web/test/list-binding.test.mjs
node --test web/test/*.mjs            # the whole suite, ~20 s
```

There is **no browser** here. What the rendered DOM must prove is checked by hand in a real browser, which does NOT run in the
gate. Whatever stands in the gate must manage without Chrome.

## The kinds of test

| Kind | What it does |
|---|---|
| **Pure logic** | A `.ts` module from `web/src/lib/` is compiled with `tsc` and executed, without tsconfig. Examples: `effort`, `slash`, `markdown`, `agents`, `agenda`, `active-runs`, `background-tasks`, `running-tasks`, `dyn-tree`, `graph-runs`, `archive`, `credit`, `chat-scrollbar`, `history-without-points`, `window-buttons-theme`, `jumps`, `git-view-time`, `accent`, `appearance`, and the editor, explorer, buffer, LSP and tree families. They check the computation (what a list contains, which version applies, which state a row shows), not a drawn view. |
| **Contracts** | A component is read BY PATH and held against a promise without rendering it: `apps-conflicts` (the apps page does not compute port conflicts itself), `drag-region` (no floating element as DOM child of a drag root without `no-drag` or a portal), `composer-form`, `composer-contract`, `slash-switch`, `hint-row`, `settings-form`, `menu-row`. Comments are stripped before every measurement so that history may stand there without coloring the test. |
| **Bindings** | A list or computation that the server keeps and a client copies, held to ONE truth: `app-agents-catalog`, `list-binding`, `administration-binding`, `agenda-binding`, `agents-message-binding`, `archive-binding`, `history-binding`, `dyn-tree-binding`, `geometry-binding`, `nav-url-binding`, `token-kind-binding`, `waiting-until-binding`, `background-tasks-binding`, `running-tasks-binding`, `graph-runs-binding`, `preview-binding`, `usage-binding` and more. The web side is compiled with `tsc`; the iOS side is either read as text or cut from the real Swift source and RUN with `xcrun swift` against the same cases (those files are registered under `onlyMacOS` in `tools/check/latch.json`; a missing toolchain fails LOUDLY). The built-in sabotage in most of them shows each binding red once. |
| **Streams** | `streams` and `reducer` run recorded SSE histories (`fixtures/streams`, `fixtures/bubbles`) through the reducer and compare the bubbles. Recording is done with `streams/record.mjs` or `CBASE_BUBBLES_RECORD=1`; see `streams/README.md`. Without a recording, hand-written rows and events go through BOTH paths of the coding chat (`buildBubbles` and `reduceChatEvent`, `chatBubbles.ts` compiled without tsconfig): `parent-unknown` (a row with an UNKNOWN parent call falls away on both paths instead of slipping into the main bubble) and `grandchild-nested` (each grandchild under the block of ITS parent agent). `chat-open` and `end-anchor` run the leaf modules behind opening a chat (image frame, bubble key, history reconcile, end anchor) and read the wiring in ChatPane/chatCache/ChatStage per path. |

One **build guard**: `textScale` runs Tailwind and the PostCSS plugin `web/postcss-text-scale.cjs` over `globals.css`
(unoptimized like `next dev`, optimized like `next build`) and holds the promise of the app-wide text size: no absolute
font size or line height without `--cb-text-scale`, nothing relative touched, idempotent, an unknown form
(`max(12px,1vw)`) breaks the build, `textPx` from `lib/appearance.ts` computes the same formula, a `fontSize` in TSX only
through `textPx`/`textCount` (or relative; every number, variable and shorthand `{ fontSize }` as a named exception), a
`lineHeight` in TSX never absolute, Tailwind before the plugin in `postcss.config.mjs`. Each promise has been shown red
once.

## The rules

- **Reading goes BY PATH.** Whoever moves a component adjusts the read line (`credit.test.mjs` reads the ChatPane family
  through `readChatPaneFamily`).
- **Every anchor is a DECLARATION and throws.** A regex that yields an empty set instead of failing turns every
  comparison below it silently green. The error message says where the declaration stands, and that the anchor is to be
  adjusted, not the test deleted.
- **Numbers go in the printed measurement line, not in the test title.** A number in the title ages silently.
- **Every guard is shown RED once** before the code behind it lands; the sabotage is then reverted. The header of a
  test carries the counter-test map: which sabotage turns which test red.
- **A `t.skip(…)` is red in the gate.** The places here carry the condition "node_modules missing (tsc)"; on a machine
  with dependencies none of them skips. A new skip turns the gate red until someone names it.
- **`i18n-de.ts` tolerates no duplicate keys** (TS1117); otherwise the web build aborts, and a test bench after that
  measures the OLD bundle.
- **Anchors on German product text** (the translation tables `i18n-de.ts`, fixtures that answer in German) stay German on
  purpose; an anchor on English product text must equal what the product says today.

## Not here

Checks with a real server and a real browser (by hand), the backend suite
(`server/backend/test/`), the tests of the deploy tool (`tools/check/*.test.mjs`), the XCUITests
(`mobile/CbaseMobileUITests/`).
