# `components/workflow/` — workflows in the web client

The node dialog is cut out of the editor (its computations live in `lib/workflow-node-form.ts`); the node badge with its
type table, the form classes and the "Workflow settings" modal are files of their own so that editor, library and dialog
share one shape and no import cycle arises.

| File | What |
|---|---|
| `WorkflowsTab.tsx` | The tab "Workflows" of a workspace/project: two KINDS in one kit `Segments` ("Graph" · "Dynamic", `WORKFLOW_KINDS` from `lib/coding-tabs.ts`, marker `data-wf-kind` on the button); "Graph" carries the two views (Workflows · Runs) in the SAME row, "Dynamic" shows `DynWorkflowsPane`. The page holds the kind (`kind`/`onKindChange`, remembered per workspace in `cbase-wf-kind:<ws>`); the row disappears only under "Graph" with an open editor. It stands in the shared column (`COLUMN`, CbKit.tsx) above the page header |
| `WorkflowsPane.tsx` | Management of the workflows (CRUD, workspace and project level), opens the editor. The overview in the calm form of the instances (kit parts `LIST_ROW`/`Tile`/`FACTS`/`EmptyRow`, `OriginSection`): rounded rows without hairlines, in front the tile with the graph symbol in the color of the state (green trigger listens, yellow holds a lock, muted off or not adopted), trigger · steps · trigger row as facts, above the list the summary (`data-workflows-summary`) |
| `WorkflowEditor.tsx` | The visual flow builder (nodes as DOM, edges as SVG, free camera, docks left/right — the geometry lives in `lib/graph-geometry.ts`, the two versions are held against each other by `web/test/geometry-binding.test.mjs`); under the line guard, not split. The library on the right (232 px open, 40 collapsed, header 32) is ONE flat list in `ADDABLE` order with 28 px rows: the `WorkflowBadge` of the card (22 px, collapsed 26), the kind hint in the row's `title`, the usage in the (i) of the header, a hairline without a word between entries and steps |
| `WorkflowBadge.tsx` | Leaf (imports nothing from editor or dialog): the type table `TYPE` (color, name, hint per kind), the palette lists `ENTRIES`/`STEPS`/`ADDABLE`, `ENTRY`/`HUMAN`, the `icon()` helper and the `WorkflowBadge` (hexagon for entries, fully filled for question/review, graphite for end, otherwise type color at 16%) in every size — card 28, library 22, strip 26, dialog header 22; icon and radius scale from 28. Two guards read `ENTRIES`/`STEPS` by path from here: `list-binding` and `geometry-binding` |
| `WorkflowNodeDialog.tsx` | The settings of ONE step (content of the sheet the editor renders around it): title, text with placeholder chips, the options surface with kit `Toggle`s, the command field with `SlashPalette` (supply: `/clear`, `/compact` + skills). Rules as `title` tooltip on the (i); in the header the `WorkflowBadge` (22 px). Does NOT import from the editor (cycle guard `web/test/import-cycles.test.mjs`); the type name comes as a prop |
| `PlaceholderChips.tsx` | The two building blocks that node dialog, trigger component and the editor's library share: mono chips for placeholders (button or plain display) and the (i) `Info` with tooltip — a leaf of its own because the dialog imports the trigger and an import back would be a cycle |
| `workflowForm.ts` | Leaf (imports only `field` from the kit): the form classes of the three leaves — `fieldDense` (the kit field at 28 px/12.5 px, with `!` because Tailwind orders equivalent utilities by value), `fieldFull` (full width), `marker` (11.5 px above a trough), `iconBtn` (28 px). Editor, node dialog and trigger component import them; a dimension stands in ONE place. The kit stays at 13 px/py-1.5 |
| `WorkflowSettings.tsx` | The CONTENT of the modal "Workflow settings" (the editor renders the 760 × 560 sheet around it): 40 px icon rail with the six tabs from `WFE_CATEGORIES` (`lib/workflow-settings.ts`: General · Execution · Context · Caps & checks · Concurrency · Triggers), header 32 px, rows from `settings/SettingsKit`, toggles/segments from `CbKit`, markers `data-wfe-*`. The last open tab is kept in `localStorage` (`cbase-wfe-tab`, convenience only). Computes nothing itself: the run state comes as `run` + `onRun(patch)`, saving happens in the editor. The effort selection (tab Execution) takes its entries from `effortEntries` (`lib/effort.ts`; empty label "Like the chat · new: <level>" through `effortStandardLabel(…, asChat)` — a manual start in an existing chat keeps its level, and the label says so) and appears only if `effortPicker` says yes (prop `activeProvider` — the globally active provider that "Default (global)" computes with). Beside it the toggle ultracode (`run.ultracode`, independent of the level — the level selection stays selectable and applies next to it). The tables `LOCK_TEXT`/`PERM_OPTIONS` live here, `LOCK_AREAS` is bound to `LOCK_SCOPES` of the server (`web/test/workflow-settings-binding.test.mjs`) |
| `WorkflowTriggerSettings.tsx` | Content of the node modal of a GitLab trigger node (imported only by the dialog — hence here and not under `settings/`); without explanatory paragraphs (tooltips on the (i), event placeholders as chips), with the density of the dialog (fields from `workflowForm.ts`, check rows 12 px) |
| `WorkflowRunsPane.tsx` | The history of runs with step log |
| `DynWorkflowsPane.tsx` | The kind "Dynamic" in the tab "Workflows" (rendered only by `WorkflowsTab.tsx`) — the saved workflow scripts of the workspace (server `dynworkflows/routes.js`). Workspace level: list, view (`meta` and the script BYTE-EQUAL, copyable — interchangeable with Claude Code), delete with confirmation; in the entered project the same list with a toggle per row (adoption modeled on the graph workflows, `PATCH …/workspace-dyn-workflows/:name/enabled`). Never created here — only by the agent through the tool `cbase_dynamic_workflow_save`. Shapes and the list path in `lib/dyn-library.ts`; "not loaded yet" (`null`) never shows "none saved". Tab key, kinds and the legacy "dynworkflows" are in `lib/coding-tabs.ts`. Guards `web/test/dyn-library.test.mjs`, `coding-tab.test.mjs`. List and view in the form of the instances: rounded rows, the chosen one in an accent tint (`SELECTED`, plus `data-active`), tile with the script symbol (in a project green = adopted), `/name` · phases · description as facts, summary above the list (`data-dynwf-summary`); on the right a large tile and the sections meta and script (the script in the trough of the kit fields) |

External caller: `app/workspaces/page.tsx` (tab "Workflows" with kind; the library reaches the page only through
`WorkflowsTab`).

Typical questions:

- Where is an edge drawn? → `WorkflowEditor.tsx`, `wire`/`docks` from `lib/graph-geometry.ts`.
- Where does the run status live? → `WorkflowRunsPane.tsx`.
- Where is the trigger poller configured? → `WorkflowTriggerSettings.tsx`.
- When does "Rounds per run" appear in the node dialog? → `showsCap` in `lib/workflow-node-form.ts` (only on a cycle; the
  computations `nodesOnCycle`/`effectiveCaps`/`exitTitle` live there, measured in `web/test/workflow-node-form.test.mjs` —
  including the binding of `NODE_COMMANDS` to `isHarnessCommand` in the server and to `nodeCommands` in the iOS sheet; the
  composition of the sheet per type is `rowsFor(cycle, node, wf)` — the dialog only calls it; three-valued per node
  (`doneMode` inherit/on/off, `doneCapMode`/`loopCapMode` inherit/ask/continue, legacy data reads only `nodeModes`); the
  three rules `checksEffective`/`checkCapContinue`/`effectiveCaps(…, wf)` compute the same answer as the server — matrix
  binding in `web/test/workflow-settings-binding.test.mjs`; every UI string of both files including table values has its
  English entry, `web/test/workflow-node-i18n.test.mjs`).

NOT here: the graph library of the server (`electron/server/workflows.js`) and the run logic
(`electron/server/workflows/`); the mobile editor (`mobile/CbaseMobile/Workflows/WorkflowCanvasEditor.swift`, there
`WorkflowNodeSheet`).
