# `toolchain/` — toolchain (MCP, skills, Playwright, hooks)

**What lives here:** what gives a run its tools.
- `mcp-config.js`: MCP configuration per chat/workspace/project (`writeMcpConfig`, `writeWorkspaceMcpJson`),
  `RESERVED_MCP_NAMES`, the catalog `MCP_CATALOG`, `normalizeMcpBody`, the credential kinds (`varsBody`), the airlock fields
  of a server (`headersChange`, `airlockFields`). It writes `CBASE_SKILL_WRITE=1` only for the main run of a coding chat with
  the toggle on.
- `playwright.js`: the pinned Playwright MCP (`playwrightMcpEntry`), profile paths, `BROWSER_MODES`, `resolveChatHeadless`.
  `playwright-tools.js` (leaf): `PLAYWRIGHT_TOOLS`, the tool names of the pinned version.
- `profiles.js`: agent hooks (`HOOK_EVENTS`, `loadAgentHooks`); re-exports `PERMISSION_MODES` from `../workflows.js`.
- `instructions.js`: the ONE computation of which instruction sections an agent carries (`sectionsFor` by role
  `main`/`sub`, opt-out per project) and how they appear in the system prompt (`instructionsBlock`) — called by
  `../runs/do-run.js` (main run) and `../runs/agents.js` (subagent, workflow agent; never the outer loop).
- `skill-catalog.js`: the skill set of a chat (`chatSkills`), the catalog in the system prompt (`skillCatalog`) and its
  cost (`catalogCost`), slash resolution (`resolveSkillSlash`), the department in a body (`areaToCreate`,
  `areaContradicts`), the migration `migrateFileSkillsToDb`.
- `skill-change.js`: the ONE mutation path of the skills (`skillCreate`, `changeSkill` including renaming, `skillDelete`
  with the trash `<data>/skill-trash/<historyId>/`, `revert`, `submitRequest`, `decideRequest`, `skillReferences`, the event
  `reportSkills` → `{type:"skills"}`): UI (`who: human`) and tool (`who: agent`) go through it, every mutation writes its
  history entry in the same step.
- `skill-routes.js`: `skillWriteChatRoutes` behind `cbase_skill_write` (only the coding main agent, only with the toggle);
  `skillHistoryWorkspaceRoutes` for history, recently deleted, requests, toggle; `skillHistoryRoutes` for undo and decide.
- `agent-tools.js`: the tool list of a subagent definition in the store — `toolListFromBody` (read the request body:
  missing = not set, `[]` = nothing), `unknownInWorkspace` (check names against the registered tools; tool names of foreign
  servers cannot be checked) and the one-time migrations `migrateToolLists`, `dropRemovedTools`, `dropCodingServer` (each
  with its marker under `migration.*`; a store without definitions gets none). What a list MEANS on which path is computed
  in `../runs/agent-set.js`.
- `agent-mcp.js`: the coding MCP servers of an agent type (field `mcp` of the definition, `{ serverId: null | [tool] }`):
  `agentMcpFromBody` (validate the body: unknown server/tool ⇒ 400, missing = unchanged), `selectableCodingServer`,
  `mcpOfTheTypeForDisplay`.
- The coding MCP airlock: `mcp-tools.js` (leaf: the ONE computation over cache, choice and marks — `carryForward`,
  `verdict`, `hasFree`, `filtered`), `mcp-load.js` (`loadMcpTools`, the restart-grace hook
  `mcpBaselineRestartGrace`), `airlock-token.js` (run tokens, in memory), `airlock-routes.js` (the wrapper's way into the
  backend: start, list, call, rpc), `airlock-texts.js` (what a rejected call tells the model).
- `tool-catalog.js`: the coding groups `context` · `communication` as `CODING_GROUPS`/`CODING_TOOLS`, their
  areas and the tool primer `toolPrimer`/`toolPrimerRows`/`externalToolPrimer` — read by the outer loop and the approval
  marks.
- `approval-marks.js`: which built-in cbase tool runs only after the human's approval, per workspace under
  `approval.cbase.<wid>`; `MARKABLE` = the `cbase_*` from `CODING_TOOLS`.

**Routes (`routes.js`):** `toolchainWorkspaceRoutes` (sub-slice of `workspaces/routes.js:workspaceRoutes`, `sub` under
`/api/workspaces/:wid`) — `/mcp-servers`, `/vars[/…]`, `/skills[/…]` (only the department Coding exists: `?area=` is missing
or `coding`, any other value is a 400; an old managing skill is read-only — PUT and DELETE answer 409 with
`runs/manager-lock.js:managerLock`), `/approval-marks` (GET/PUT), `/effective-skills`, `/skill-catalog` (count and token cost of a level's catalog, `catalogCost` — the same
`skillCatalog` function that writes the system prompt); in `ROUTES` (`server.js`) `mcpCatalogRoutes` (`/api/mcp-catalog`,
`/api/mcp-servers/:id[/tools]`). The project side of the skills (own ones, hiding workspace coding skills by id) is in
`../projects/routes.js`.

**What does NOT live here:** the file format of the skills (`SKILL.md`, resources) is the root `../skills.js` — hence the
name `skill-catalog.js` here. The MCP server lives in `../../mcp/` (entry `cbase-mcp.js`, the sets in `toolsets.js`, the
catalog in `catalog.js`, visibility by depth in `visibility.js`, the tools under `tools/`; README there) — `writeMcpConfig`
only gives it its environment (`CBASE_TOOLSET`, `CBASE_TOOLS`, `CBASE_SKILLS`, `CBASE_AGENT_DEPTH` — depth 0–3 below the
chat —, `CBASE_PROFILE_KEY`, by which an approval card recognizes its requesting subagent). Persistence is
`store/toolchain.js`.

**Terms → file:** MCP configuration, reserved names, catalog, credentials → `mcp-config.js` · the agent's browser
(headless, profile, version) → `playwright.js` · hooks, permission mode → `profiles.js` · instructions → `instructions.js` ·
skill catalog, slash resolution → `skill-catalog.js` · tool list of a subagent definition → `agent-tools.js` · tool catalog
and tool primer of the coding groups → `tool-catalog.js` · approval marks → `approval-marks.js` · airlock, choice, marks, run token → `mcp-tools.js`, `airlock-*.js`.

**The most frequent questions:**
- Which MCP servers and env variables does a run get (toolset, skills, subagent depth, time zone)? →
  `mcp-config.js:writeMcpConfig`. With an instance, `CBASE_BASE_URL` = the gateway of the project network, `CBASE_TOKEN` and
  `CBASE_INSTANCE` (the instance identifier for the port tools — not a secret) are in the cbase server's environment;
  without an instance the file is byte-identical (guard `server/backend/test/fence.test.js`). `writeWorkspaceMcpJson`
  (terminals in B) is separate.
- Which skills does a chat see, and how is `/skillname` resolved on send? → `skill-catalog.js:chatSkills` (Coding only; an
  old manager chat gets `[]`) / `skill-catalog.js:resolveSkillSlash`. Before that the message route asks whether `/name` is
  a saved dynamic workflow of the chat (`../dynworkflows/slash.js:dynSlashRefusal`, coding chats only): if so it answers
  404 `dyn_slash`, and a skill of the same name does not get its turn. A mention `/workflow:<shortname>`
  (`../workflows/slash-workflow.js:graphSlash`) also precedes skill resolution. The name rule only applies when saving a
  workflow (`skillCarriesNames` ⇒ 400); a skill of the same name created later is not rejected here and is then not
  reachable via `/name`.
- Does a chat's browser run visibly or headless, and where is its profile? → ALWAYS headless
  (`playwright.js:playwrightHeadless` returns `true`) / `playwright.js:playwrightProfileDir` (the login stock per workspace,
  `loginStockRoot` — stays flat). The profile of a CHAT lives in its chat's runtime folder
  (`runs/runtime-location.js:playwrightProfileRoot`, passed to `writeMcpConfig` as `runtime`), the Playwright configuration
  next to it (`playwrightConfigPath` → `runtime-location.js:playwrightConfigFile`).
- Which tools does the Playwright MCP have? → `playwright-tools.js:PLAYWRIGHT_TOOLS`: the names of the pinned version with
  `PLAYWRIGHT_CAPABILITIES`, bound to `tools/list` of the real MCP (`server/backend/test/playwright-capabilities.test.js`);
  the Codex prefix names them (`../providers/connectors/codex-prefix.js`). A version or capability bump is red there until
  the list follows.
- Where does the Playwright MCP write screenshots and recordings? → by default into the working folder
  (`.playwright-mcp/`); for a profile in the runtime folder of a converted project `playwright.js:playwrightMcpEntry` sets
  `outputDir` to the chat's output location (`../runs/runtime-location.js:playwrightOutputLocation`) — otherwise it would
  write into the project repo; without an instance the key is absent and the configuration stays byte-identical.

**Agent communication:** `writeMcpConfig` writes `CBASE_WRITE_PERMISSION` from `communication/sender.js` — the same
computation the send route checks with —, but only if it says something: a permission ≠ "no" AND `cbase_agent_send` in the
set (if the marker is missing, the MCP server reads "no"; this keeps every other file byte-identical,
`golden-runs.test.js`). Subagent (profile or depth) and workflow agent ⇒ never. The MCP server builds the description of
`cbase_agent_send` from it (guard `server/backend/test/communication-description.test.js`).
