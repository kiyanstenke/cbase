# `components/settings/` — the settings (gear in the header)

`SettingsModal.tsx` is the frame (page list on the left, one page on the right; a new page is registered there) and the
only importer of the pages; `TopNav.tsx` opens it. `UsageKit.tsx` holds the building blocks of the five usage subpages.

## Pages

| File | Page |
|---|---|
| `ProviderSettings.tsx` | Providers — EXACTLY three: Claude and Codex with subscription (PTY login, card with quota ring) plus the FIXED OpenRouter card (`OpenRouterCard`: set/replace/remove key, the two privacy toggles, cost chip from `/api/usage/consumption`). A PUT always carries BOTH toggles (bound in `web/test/usage-binding.test.mjs`). Below, per provider, the default model (shared search, `components/ModelChoice.tsx`) and the default effort level (`PUT /api/default-effort`, no empty entry) |
| `AgentModelSettings.tsx` | Models per internal app agent and their effort level (empty entry "Default · <level>"; what is shown is what REALLY runs — `effective` from `GET /api/agent-models`). `AGENT_MODEL_KEYS` in the backend is the SECOND list — maintain both |
| `AgentHooksSettings.tsx` | Hooks of the own harness (loop engine) |
| `UsageSettings.tsx` | Usage — only the FRAME of the five subpages, modeled on Integrations (list on the left from 600 px stage width, a bar below; `start` prop from the jump `usage:<subpage>`). Keys and order are `USAGE_SUBPAGES` of the contract (`account/usage-contract.js`); the content is a `Record` over them (a new subpage is a type error). The settings of the dynamic workflows live in `WorkflowsSettings.tsx` |
| `UsageOverview.tsx` | Usage → Overview: Claude/Codex cards (ring of the binding window, reset, "measured N min ago"), API equivalent of the last 30 days per subscription provider, OpenRouter cost 30 days with credit, number of waiting items — every row leads to its subpage; each source loads on its own (a failed one shows "—") |
| `UsageSubscription.tsx` | Usage → Claude or Codex: limits (Claude: ALL windows from `/api/usage/claude-limits`, credit/extra usage; Codex: the local snapshot `/api/usage/codex`), window bar `session · week · 30d`, API equivalent with breakdown, tokens (cache read/write separate), subagent share, per model, background tasks per role, per chat, history per day |
| `UsageOpenRouter.tsx` | Usage → OpenRouter: credit (live; `known: false` ⇒ no number), cost per window `30d · total` with origin (reported · queried · estimated · unknown), per model with price range per provider (`/api/usage/openrouter-prices`), per chat, background and outer loop, history per day |
| `UsageLimit.tsx` | Usage → At the limit: the two toggles (auto-continue, credit gate "Do not start a new turn from {pct} %") and the waiting list, TAPPABLE (jump to the row's chat; the modal closes through `closeSettings`, `lib/settings-jump.ts`). `web/test/credit.test.mjs` reads this file by path |
| `UsageKit.tsx` | NOT a page (listed under `NO_PAGE` in `settings-form.test.mjs`): the building blocks of the subpages — window bar, equivalent and token surface, lists per model/chat/role (ONE surface per list, hairlines), history as bars without a library, quota card and row. The edge `import type { RingWindow }` to TopNav closes the type cycle that `import-cycles.test.mjs` holds as anchor |
| `WorkflowsSettings.tsx` | "Workflows" in "Behavior" after "Chats" (key `WORKFLOWS_PAGE` of the contract): `WorkflowCapGroup` (the per-user cap for concurrent workflow agents, default 8, `GET`/`PUT /api/dyn-workflow-cap`; the per-run cap is not settable, its number comes from the server) containing `WorkflowSizeRow` (size guideline small · medium · large · unrestricted, default medium, `GET`/`PUT /api/dyn-workflow-size`). iOS counterparts `Settings/WorkflowCapSection.swift`, `WorkflowSizeSection.swift` |
| `LanguageSettings.tsx` · `AppearanceSettings.tsx` | Language · color scheme and chat text size |
| `NotificationSettings.tsx` | Notifications per kind (web push) |
| `BrowserSettings.tsx` | Built-in Playwright browser |
| `ChatSettings.tsx` | "Chats" in "Behavior" after "Browser": auto-archive chats (global): toggle and days without a new message (1–365, `archiveDays` in `lib/archive.ts`; an invalid number is not sent), `GET`/`PUT /api/chat-auto-archive` through `lib/api/archive.ts` — the PUT ALWAYS carries `enabled` and `days`. Stored through `autoArchiveStorage`: ONE local state, set immediately, the PUTs in a chain, each reads the state of its run; an error resets to the last confirmed state. iOS counterpart `Settings/` (bound in `web/test/settings-form.test.mjs`), guard `web/test/archive.test.mjs` |
| `GitlabSettings.tsx` | Connected GitLab accounts (basis of the trigger nodes) |
| `NgrokSettings.tsx` | Second section of Integrations: ngrok access for preview links (authtoken, optional API key — password fields, "stored" instead of the value, both keys in the PUT), the mode as a sentence (free plan `dev` / Hobbyist `names`), active links with revoke, history. State from `components/preview/usePreviewLinks.ts`; `openSettings("integrations")` (`lib/settings-jump.ts`, TopNav listens) opens the page from outside |
| `EnvironmentSettings.tsx` | "Environment" (gateway mode only): the own container, plus the READ-ONLY group "Resources" (RAM limit with usage bar, CPU priority, CPU upper limit — the extra fields of `GET /gw/env`, `normOwnResources`); without `resources` the group is absent |
| `AdministrationSettings.tsx` | "Administration" — own group at the end, only for a gateway admin (the filter in `SettingsModal` is the second named exception in `web/test/settings-form.test.mjs`); replaces the old page `/gw/admin` (which redirects to `ADMINISTRATION_JUMP`). Top: the server (RAM allocated against the host with reserve mark, threads, "overbooked" as a sentence), below ONE surface with all users; a row expands (`data-open`): draft of the limits (RAM −/+, priority and cap as kit `Segments`, save), role, password, lock, start/restart/stop container, delete with or without data. The sheets carry `z="z-[70]"` (the settings themselves sit on z-60), hence no `useConfirm`. Reloads every 15 s (not in a hidden tab) and after every action; only the latest response counts, a draft survives the reload. Routes and shapes in `lib/api/administration.ts`, bound to `server/gateway/administration-contract.js` in `web/test/administration-binding.test.mjs`; iOS counterpart `Settings/AdministrationSettings.swift` |

`ThirdPartyHints.tsx` is not a page of a group but the row at the foot of the list ("Third-Party Notices", key `hints`). Its
first group is **About**: the cbase build (build id; a bare version only with the remark "build unknown"), the API level, the
gateway version (gateway mode only) and, in the desktop client, the app version (`cbaseShell.appVersion`). In gateway mode the
values come from `/gw/info` (kept by `GatewayGate`, `useGateway().info`), on the local server from `GET /api/version`. Whatever
is missing reads "unknown" — the computation is `lib/about.ts`, guard `web/test/about.test.mjs`.

NOT here: `CbKit.tsx` (the UI kit of all pages, stays in `components/`), the backend routes (`electron/server/settings/`,
`account/`).
