// MCP configuration per chat/workspace/project: reserved names, server entries, writing .mcp.json (writeMcpConfig,
// writeWorkspaceMcpJson), catalog of the built-in servers, variables (VAR_KINDS, varsBody, varsMcpRow), normalizeMcpBody.

import fs from "node:fs";
import path from "node:path";
import { chatProfileDir, prepareChatProfile } from "../browser-profiles.js";
import { T } from "../i18n.js";
import { BASE_URL, MCP_SCRIPT } from "../app-state.js";
import { loginStockRoot, playwrightHeadless, playwrightMcpEntry, playwrightProfileDir } from "./playwright.js";
import { sizeForMcp } from "../dynworkflows/size.js";
import { writeInRuntimeFolder } from "../runs/runtime-write.js";
import { senderOf, sendPermissionsOfTheRun } from "../communication/sender.js";
import { skillAgentsWrite } from "../store.js";
import { lockedForDepth } from "../../mcp/visibility.js";
import { LFS_STDIO_LOCK } from "../runs/lfs-environment.js";
import { hasFree } from "./mcp-tools.js";
import { issue } from "./airlock-token.js";


// Reserved server names (must not be overridden by workspace servers).
const RESERVED_MCP_NAMES = new Set(["cbase", "playwright"]);
// Valid MCP server name (a-z, 0-9, _ and -), as the Claude CLI expects.
const isValidMcpName = (n) => /^[a-z0-9_-]{1,64}$/.test(n);

// Translates a stored workspace MCP server into a config entry of the Claude CLI.
function mcpServerToConfigEntry(s) {
  if (s.transport === "http" || s.transport === "sse") {
    if (!s.url) return null;
    return { type: s.transport, url: s.url };
  }
  // stdio
  if (!s.command) return null;
  // Resolve npx absolutely in GUI apps (minimal PATH) — like the Playwright entry.
  const command = s.command === "npx" ? (process.env.NPX_BIN || "npx") : s.command;
  const entry = { command, args: Array.isArray(s.args) ? s.args : [] };
  if (s.env && Object.keys(s.env).length) entry.env = s.env;
  return entry;
}

// The wrapper of the coding MCP airlock (mcp/airlock.js) lives next to the cbase MCP server — in the project container under
// the same path (mounted) and with the same binary.
const airlockScript = () => path.join(path.dirname(MCP_SCRIPT), "airlock.js");

// The entry of a coding MCP server in a run's configuration: NOT the real server but the wrapper under its name (the tool
// names `mcp__<name>__<t>` stay). Neither headers nor command/args/env of the real server appear here — the wrapper fetches
// them via the route (toolchain/airlock-routes.js). The run token and the instance token are secret: Codex only gets their
// names (connectors/codex.js AIRLOCK_SECRET_ENVIRONMENT), the Claude CLI reads the file.
function airlockEntry(server, { baseUrl, chatId, airlock, token }) {
  const env = { CBASE_BASE_URL: baseUrl, CBASE_CHAT_ID: String(chatId), CBASE_AIRLOCK: airlock };
  if (token) env.CBASE_TOKEN = String(token);
  return { command: process.execPath, args: [airlockScript(), "--server", String(server.id)], env, timeout: MCP_CALL_TIMEOUT_MS };
}

// The project assignment of the coding servers in the system prompt of a workspace chat: from the SAME list as the
// configuration — a server without a free tool is missing in both. Keep the wording stable (prompt cache).
function projectAssignment(written) {
  const origin = written.filter((s) => s.originProject);
  if (!origin.length) return "";
  return "\n\n# Project assignment of the MCP servers\n" + origin
    .map((s) => `- Server "${s.name}" (tools mcp__${s.name}__*) belongs to the project "${s.originProject}" — use it when you work on this project.`)
    .join("\n");
}

// Writes an MCP config that makes Claude Code start the cbase server as a stdio server and additionally mounts the enabled
// workspace MCP servers. Runs on the node of THIS server (`process.execPath`) — no PATH needed.
// `toolset` restricts the run to a named toolset of the cbase server (see TOOLSETS in mcp/cbase-mcp.js). A run cut down like
// this gets EXCLUSIVELY that server: neither browser nor workspace servers, otherwise the restriction would be half the truth.
// MCP_TOOL_TIMEOUT per server. A foreground subagent (cbase_agent) works for minutes, so the call must not abort after the
// provider's default. The Claude CLI understands the field `timeout` (ms) directly; codex.js translates it to
// tool_timeout_sec, the in-process client of the loop engine reads it as well (mcp-client.js).
const MCP_CALL_TIMEOUT_MS = 660_000;

// agentDepth > 0 = this run IS a cbase subagent: it may neither delegate further nor ask the user (both belong to the main
// agent). profileKey separates the browser profile, because a Chromium profile tolerates only ONE browser — main agent and
// subagent would lock each other out.
// `backendUrl` and `token`: the backend's address from the instance's project network and its token (via
// runs/backend-access.js), plus `instance` (its identifier, `CBASE_INSTANCE`). Default BASE_URL, NO token and no identifier —
// then the function writes byte-identically (golden-runs.test.js). The token appears only in the cbase server's `env`: the
// Claude CLI reads the file (--mcp-config), Codex gets it via `env_vars` from its environment, never in argv
// (connectors/codex.js pushMcpConfig).
// `lfsLock`: a Claude run with LFS environment (runs/lfs-environment.js lfsLockForStdio) — then EVERY stdio entry carries
// LFS_STDIO_LOCK in its `env` (over the other entries): otherwise the CLI would hand its environment including the LFS
// helper's access to the servers. Without it byte-identical.
// Coding MCP airlock: `extraServers` (the chat's coding servers) are in the file as wrappers, per run or agent with ONE run
// token (toolchain/airlock-token.js) — `agentId` (the agent of a subagent or workflow file) and `setProject` (the project the
// caller computed `effectiveMcpServers` with) go into the token. A server without a free tool is missing; a subagent or
// workflow agent gets a coding server only with "Subagents inherit" or because its agent type brings it — `codingChoice`
// (runs/agent-set.js codingSet, serverId → null | [tool]) then names exactly its servers, `fromType` the ids of the type; both
// go into the run token. `onlyServer` (tool list of a definition, list per call) only cuts the remaining servers.
function writeMcpConfig(filePath, { projectId, workspaceId, chatId, extraServers = [], headless, toolset = "", tools = null, skills = [], agentDepth = 0, profileKey = "", vision, timeZone = "", onlyServer = null, workflowAgent = "", outerLoop = "", structure = null, runtime = null, backendUrl = BASE_URL, token = "", instance = "", lfsLock = false, agentId = "", setProject = null, userBrowser = "", approval = false, codingChoice = null, fromType = [] } = {}) {
  const env = { CBASE_BASE_URL: backendUrl || BASE_URL };
  if (token) env.CBASE_TOKEN = String(token);
  // The instance identifier: the port tools ask the namespace of the project container (mcp/tools/services.js).
  // Not a secret — like the other values it is in the file or in Codex's argv. Without an instance it is absent.
  if (instance) env.CBASE_INSTANCE = String(instance);
  // Time zone of the run: timestamps in tool responses (chat list, agenda) come as wall-clock time — the container runs UTC,
  // the user does not.
  if (timeZone) env.CBASE_TIME_ZONE = timeZone;
  // An EXPLICIT tool list instead of a named set: the tools of this run — of a subagent with a list, of an outer-loop run.
  if (Array.isArray(tools)) env.CBASE_TOOLS = JSON.stringify(tools);
  // The skills of THIS run. They are both the enumeration in the schema of `cbase_skill` and its existence: an empty set
  // drops the tool entirely, so a chat without skills pays nothing and is offered nothing that does not exist.
  if (skills.length) env.CBASE_SKILLS = JSON.stringify(skills);
  if (agentDepth > 0) env.CBASE_AGENT_DEPTH = String(agentDepth);
  // An agent of a dynamic workflow: its OWN marker (its agent id) — it cuts the set independently of depth and declines
  // approvals without a card (mcp/lib.js).
  if (workflowAgent) env.CBASE_WORKFLOW_AGENT = String(workflowAgent);
  // An outer-loop run: its OWN marker `<agentId>:<runId>` — it cuts the set (mcp/visibility.js lockedForOuterLoop), is the
  // access marker of cbase_chat_analysis and makes it the role "outer_loop" at the send route (communication/sender.js).
  // Without it every file stays byte-identical.
  if (outerLoop) env.CBASE_OUTER_LOOP = String(outerLoop);
  // The schema of an `agent(prompt, {schema})` plus reference: only with it does the MCP server show the messenger
  // StructuredOutput (its input schema IS the schema), and the messenger tells the backend the reference to check under.
  if (structure?.schema && structure?.reference) {
    env.CBASE_SCHEMA = JSON.stringify(structure.schema);
    env.CBASE_SCHEMA_REFERENCE = String(structure.reference);
  }
  // The size guideline of the dynamic workflows (dynworkflows/size.js): only for the main agent (only it sees
  // cbase_dynamic_workflow) and only if it differs from the default — without it the MCP server writes the default sentence
  // into the description.
  if (agentDepth === 0 && !workflowAgent) {
    const size = sizeForMcp();
    if (size) env.CBASE_DYNWF_SIZE = size;
  }
  if (projectId) env.CBASE_PROJECT_ID = projectId;
  // The workspace boundary of the MCP server.
  if (workspaceId) env.CBASE_WORKSPACE_ID = workspaceId;
  if (chatId) env.CBASE_CHAT_ID = chatId;
  // The write permission on other chats: from the SAME computation the send route checks with (communication/sender.js) — the
  // MCP server builds the description of cbase_agent_send from it (names `chat:<id>` only with write permission). Subagent
  // (profile or depth) and workflow agent ⇒ "no". Written only if it says something: a permission ≠ "no" AND cbase_agent_send
  // in the set — if the marker is missing, the MCP server reads "no" (and every file without both stays byte-identical,
  // golden-runs.test.js).
  // Also: a run of the role "special" (app-agent chats) reaches only its own subagents with the tool — no wf:, no channel:
  // (sender.js WRITES_CHANNEL). Depth and workflow marker do not distinguish it from the coding main agent at the MCP server;
  // the marker CBASE_ONLY_SUBAGENTS does. Only for "special" with cbase_agent_send in the set and only with a chat row — every
  // other file stays byte-identical.
  const sendVisible = Array.isArray(tools) ? tools.includes("cbase_agent_send") : !toolset;
  if (chatId && sendVisible) {
    let permission = "no";
    let onlySubagents = false;
    try { ({ writePermission: permission, onlySubagents } = sendPermissionsOfTheRun(chatId, { ofProfile: profileKey || (agentDepth > 0 ? "depth" : ""), workflowAgent, outerLoop })); }
    catch { /* without a chat row (database closed) no permission */ }
    if (permission !== "no") env.CBASE_WRITE_PERMISSION = permission;
    if (onlySubagents) env.CBASE_ONLY_SUBAGENTS = "1";
    // The address "main": only a subagent (depth or profile) of a coding chat — the same role communication/ delivers it
    // with — and only if the chat has coding MCP servers (the reason for the address; without them every file stays
    // byte-identical, golden-runs.test.js). The route delivers "main" also without the marker.
    // ONLY if the run is really offered cbase_agent_send: a workflow agent never has the cbase_agent* family
    // (mcp/visibility.js WORKFLOW_AGENT_FAMILIES), nor does a subagent at the depth limit (lockedForDepth) — the marker
    // carries the sentence "write to it with cbase_agent_send to "main"" (runs/agents.js), which would otherwise promise a
    // tool that does not exist there.
    if (!outerLoop && !workflowAgent && (agentDepth > 0 || profileKey) && !lockedForDepth("cbase_agent_send", agentDepth) && extraServers.length) {
      try { if (senderOf(chatId) === "coding") env.CBASE_MAIN_ADDRESS = "1"; } catch { /* without a chat row no marker */ }
    }
  }
  // Writing skills: the marker cbase_skill_write alone depends on (mcp/offering.js). ONLY the main run of a coding chat —
  // depth 0, no profile, no workflow or outer-loop marker, no named set and no explicit list, role "coding" from the SAME
  // computation as the route (communication/sender.js) — and only with the workspace's toggle on. The route checks both
  // again (toolchain/skill-routes.js). Subagent, workflow and outer-loop files are written by runs/agents.js with depth ≥ 1.
  if (chatId && workspaceId && agentDepth === 0 && !profileKey && !workflowAgent && !outerLoop && !toolset && !Array.isArray(tools)) {
    try {
      if (senderOf(chatId) === "coding" && skillAgentsWrite(workspaceId)) env.CBASE_SKILL_WRITE = "1";
    } catch { /* without a chat row (database closed) no marker */ }
  }
  // The run binding (mcp/visibility.js lockedForRunBinding): `approval` (approvalOverMcp below) is the only run with
  // cbase_permission_prompt.
  if (approval) env.CBASE_APPROVAL = "1";
  // Subagents browse in their own profile — the capture tools must hit their OWN browser.
  if (profileKey) env.CBASE_PROFILE_KEY = profileKey;
  // Providers without image understanding (`caps.vision` false, providers/index.js): capture tools answer purely textually
  // instead of pushing MCP image blocks of unknown effect through foreign CLIs.
  if (vision === false) env.CBASE_VISION = "0";
  if (toolset) env.CBASE_TOOLSET = toolset;
  const mcpServers = {};
  // The tool list of a subagent: only the foreign servers it names — `null` = all. The cbase server is always there
  // (CBASE_TOOLS cuts its part). This way every provider cuts, Codex too.
  const free = Array.isArray(onlyServer) ? new Set(onlyServer) : null;
  const allowed = (name) => !free || free.has(name);
  // First the workspace servers, then the built-in ones (which always win). Each as a wrapper of the airlock (see above).
  // An outer-loop run gets the coding servers its caller (outerloop/run.js) passes after its agent's choice — with the token
  // role `outer_loop`, without "Subagents inherit" (it is not the set of a parent run).
  const olAgent = outerLoop ? String(outerLoop).split(":")[0] : "";
  const role = olAgent ? "outer_loop" : workflowAgent ? "workflow" : agentDepth > 0 || profileKey ? "subagent" : "main";
  const agentTheFile = role === "workflow" ? String(workflowAgent) : String(agentId || "");
  let airlock = "";
  const written = [];
  if (!toolset && chatId && (role === "main" || agentTheFile)) {
    for (const s of extraServers) {
      if (RESERVED_MCP_NAMES.has(s.name) || !isValidMcpName(s.name)) continue;
      if (role === "subagent" || role === "workflow") {
        // With a computed set (runs/agent-set.js codingSet: agent type ∩ parent, otherwise "Subagents inherit") exactly its
        // servers; without one (a caller that computes none) only with the toggle.
        if (codingChoice ? !Object.hasOwn(codingChoice, s.id) : s.subagentsInherit === false) continue;
      }
      if (!hasFree(s) || !mcpServerToConfigEntry(s)) continue;
      if (!airlock) airlock = issue({ chatId, role, agentId: agentTheFile, workspaceId, setProject, instance, outerLoopAgent: olAgent, codingChoice, fromType });
      mcpServers[s.name] = airlockEntry(s, { baseUrl: env.CBASE_BASE_URL, chatId, airlock, token });
      written.push(s);
    }
  }
  mcpServers.cbase = { command: process.execPath, args: [MCP_SCRIPT], env, timeout: MCP_CALL_TIMEOUT_MS };
  // npx resolved absolutely (GUI apps have a minimal PATH; claude inherits this env).
  // Every chat browses in its OWN profile (Chromium allows only one browser per profile); without a chat (workspace level)
  // it stays the workspace profile. `runtime` is the run's runtime folder (runs/runtime-location.js): the chat's profile
  // lives there; the login stock stays flat. Without it the flat location (same root as the stock).
  // `userBrowser`: the CDP address of the browser of THIS chat (scope `chat:<id>`, browsers.js) — the main run (role "main")
  // always works in it, in the same browser as the human. Every other role (subagent, workflow, outer-loop agent) gets its
  // own profile, even if a caller wrongly passed the address (never two agents on the same tabs). With an address no
  // Playwright profile (no prepareChatProfile): the path only serves as the location of configuration and output.
  if (!toolset && allowed("playwright")) {
    const root = runtime?.playwrightProfiles || loginStockRoot();
    const cdpEndpoint = userBrowser && chatId && role === "main" ? String(userBrowser) : "";
    mcpServers.playwright = playwrightMcpEntry(process.env.NPX_BIN || "npx", {
      headless: headless === undefined ? playwrightHeadless() : headless,
      userDataDir: cdpEndpoint ? chatProfileDir(root, chatId)
        : chatId
          ? prepareChatProfile({ root, stock: loginStockRoot(), chatId: profileKey || chatId, workspaceId })
          : playwrightProfileDir(workspaceId),
      cdpEndpoint,
    });
  }
  // In a project's runtime folder (`<runtime>/scratch/<chat>[.agent-<id>].mcp.json`) via the descriptor
  // (runs/runtime-write.js): the project container mounts it rw, and a link in place of the file (`→ ~/.bashrc`) would make
  // B write the configuration through a file of B. If the path leads outside, it throws — the run does not start.
  // lfsLock (see above): every stdio entry (one with `command`) gets the lock — as a new object, the stored entry of a
  // workspace server stays untouched.
  if (lfsLock === true) {
    for (const [name, e] of Object.entries(mcpServers)) {
      if (e && typeof e.command === "string") mcpServers[name] = { ...e, env: { ...(e.env || {}), ...LFS_STDIO_LOCK } };
    }
  }
  const content = JSON.stringify({ mcpServers }, null, 2);
  if (!writeInRuntimeFolder(filePath, content)) fs.writeFileSync(filePath, content);
  // names = extra servers (for --allowedTools); servers = full map (for Codex `-c` injection); airlock = the names of the
  // wrappers (granted as a whole server — choice and card are decided by the airlock); assignment = the prompt section for it.
  return { names: Object.keys(mcpServers).filter((n) => !RESERVED_MCP_NAMES.has(n)), servers: mcpServers, airlock: written.map((s) => s.name), assignment: projectAssignment(written) };
}

// Curated catalog of common MCP servers (one click in the frontend, editable afterwards). `needs` describes required input
// the user still fills in (path/env). Modeled on the Claude "Connectors" directory: local reference servers (stdio, via
// npx/uvx) and the prominent remote connectors (http/sse, mostly OAuth). url is set only for remote entries;
// command/args/env only for stdio. `label`, `description` and `needs` are English; the clients translate them (their
// tables are keyed by exactly these texts).
const MCP_CATALOG = [
  // ── Local reference servers (stdio) ──────────────────────────────────────────
  { key: "filesystem", label: "Filesystem", description: "File access to a folder (read/write/search).",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "<FOLDER-PATH>"], env: {}, url: "",
    needs: "Replace <FOLDER-PATH> with the folder to share." },
  { key: "fetch", label: "Fetch", description: "Fetches web content and converts it to Markdown for the model.",
    transport: "stdio", command: "uvx", args: ["mcp-server-fetch"], env: {}, url: "",
    needs: "Requires uv/uvx (Python)." },
  { key: "git", label: "Git", description: "Git operations on a local repository (status, diff, log, commit).",
    transport: "stdio", command: "uvx", args: ["mcp-server-git", "--repository", "<REPO-PATH>"], env: {}, url: "",
    needs: "Replace <REPO-PATH>; requires uv/uvx." },
  { key: "time", label: "Time", description: "Time and time-zone conversions.",
    transport: "stdio", command: "uvx", args: ["mcp-server-time"], env: {}, url: "", needs: "Requires uv/uvx." },
  { key: "sqlite", label: "SQLite", description: "Queries against a local SQLite database.",
    transport: "stdio", command: "uvx", args: ["mcp-server-sqlite", "--db-path", "<DB-PATH>"], env: {}, url: "",
    needs: "Replace <DB-PATH>; requires uv/uvx." },
  { key: "postgres", label: "PostgreSQL", description: "Read-only queries against a Postgres database.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "<CONNECTION-URL>"], env: {}, url: "",
    needs: "Replace <CONNECTION-URL> (postgresql://user:pass@host/db)." },
  { key: "sequential-thinking", label: "Sequential Thinking", description: "Structured, multi-step reasoning/planning steps.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"], env: {}, url: "", needs: "" },
  { key: "puppeteer", label: "Puppeteer", description: "Browser automation (screenshots, navigation).",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"], env: {}, url: "", needs: "" },
  { key: "brave-search", label: "Brave Search", description: "Web search via the Brave Search API.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "" }, url: "",
    needs: "Enter a Brave Search API key." },
  { key: "google-maps", label: "Google Maps", description: "Geocoding, places, routes via the Google Maps API.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-google-maps"], env: { GOOGLE_MAPS_API_KEY: "" }, url: "",
    needs: "Enter a Google Maps API key." },
  { key: "slack", label: "Slack", description: "Slack workspace: read channels, post messages.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" }, url: "",
    needs: "Enter a Slack bot token and team ID." },
  { key: "github", label: "GitHub (local)", description: "GitHub API via local server: repos, issues, PRs, code search.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" }, url: "",
    needs: "Enter a GitHub personal access token." },
  { key: "gitlab", label: "GitLab", description: "GitLab API: projects, issues, merge requests.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-gitlab"], env: { GITLAB_PERSONAL_ACCESS_TOKEN: "", GITLAB_API_URL: "https://gitlab.com/api/v4" }, url: "",
    needs: "Enter a GitLab token (adjust the API URL if needed)." },

  // ── Remote connectors (http/sse, usually OAuth on first run) ───────────
  { key: "github-remote", label: "GitHub", description: "Official GitHub remote server: repos, issues, PRs, Actions.",
    transport: "http", command: "", args: [], env: {}, url: "https://api.githubcopilot.com/mcp",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "notion", label: "Notion", description: "Read and edit Notion pages and databases.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.notion.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "linear", label: "Linear", description: "Manage Linear issues, projects and cycles.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.linear.app/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "asana", label: "Asana", description: "Asana tasks, projects and portfolios.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.asana.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "atlassian", label: "Atlassian (Jira/Confluence)", description: "Jira issues and Confluence pages.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.atlassian.com/v1/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "sentry", label: "Sentry", description: "Query and analyze errors and issues from Sentry.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.sentry.dev/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "stripe", label: "Stripe", description: "Stripe: payments, customers, subscriptions, invoices.",
    transport: "http", command: "", args: [], env: {}, url: "https://mcp.stripe.com/",
    needs: "Remote connection (OAuth or API key)." },
  { key: "canva", label: "Canva", description: "Create and manage Canva designs.",
    transport: "http", command: "", args: [], env: {}, url: "https://mcp.canva.com/mcp",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "intercom", label: "Intercom", description: "Intercom conversations and contacts.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.intercom.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "paypal", label: "PayPal", description: "PayPal: invoices, payments, transactions.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.paypal.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "square", label: "Square", description: "Square: payments, catalog, orders.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.squareup.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "cloudflare", label: "Cloudflare", description: "Cloudflare Workers, bindings and configuration.",
    transport: "sse", command: "", args: [], env: {}, url: "https://bindings.mcp.cloudflare.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "webflow", label: "Webflow", description: "Manage Webflow CMS and sites.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.webflow.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "zapier", label: "Zapier", description: "Zapier: drive thousands of apps via Zaps.",
    transport: "http", command: "", args: [], env: {}, url: "https://mcp.zapier.com/api/mcp/mcp",
    needs: "Personal Zapier MCP URL/key required — adjust the URL if needed." },
  { key: "hubspot", label: "HubSpot", description: "HubSpot CRM: contacts, deals, tickets.",
    transport: "http", command: "", args: [], env: {}, url: "https://app.hubspot.com/mcp/v1/http",
    needs: "Remote connection (API key/OAuth)." },
  { key: "vercel", label: "Vercel", description: "Vercel projects, deployments and logs.",
    transport: "http", command: "", args: [], env: {}, url: "https://mcp.vercel.com/",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "neon", label: "Neon", description: "Neon Serverless Postgres: projects and branches.",
    transport: "http", command: "", args: [], env: {}, url: "https://mcp.neon.tech/mcp",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "supabase", label: "Supabase", description: "Supabase projects, database and edge functions.",
    transport: "http", command: "", args: [], env: {}, url: "https://mcp.supabase.com/mcp",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "prisma", label: "Prisma Postgres", description: "Prisma Postgres: provision and query databases.",
    transport: "http", command: "", args: [], env: {}, url: "https://mcp.prisma.io/mcp",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "wix", label: "Wix", description: "Manage Wix sites, stores and data.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.wix.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "monday", label: "monday.com", description: "monday.com boards, items and updates.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.monday.com/sse",
    needs: "Remote connection (OAuth) — authorize in the browser on first run." },
  { key: "globalping", label: "Globalping", description: "Network measurements (ping, traceroute, DNS, HTTP) worldwide.",
    transport: "sse", command: "", args: [], env: {}, url: "https://mcp.globalping.dev/sse",
    needs: "Remote connection (OAuth)." },
  { key: "simplescraper", label: "Simplescraper", description: "Scrape websites and retrieve them as structured data.",
    transport: "http", command: "", args: [], env: {}, url: "https://mcp.simplescraper.io/mcp",
    needs: "Remote connection (OAuth)." },
];

// The four kinds of a credential entry. "freeText" is the block for everything that does not fit into ONE value: a whole
// database or server access as it was copied from somewhere — multi-line, unstructured, and hidden like a secret.
// Deliberately WITHOUT a field schema: which fields an access has only the person entering it knows.
const VAR_KINDS = ["secret", "variable", "link", "freeText"];

// Validate a credential body — the same rule for workspace and project level, POST and PUT. Whoever only flips the toggle
// while editing sends no `value` — then it stays as it was. Returns {error} or the fields to write.
function varsBody(b, { fresh, kindOld = "" }) {
  const kind = b.kind === undefined ? (fresh ? "variable" : kindOld) : b.kind;
  if (!VAR_KINDS.includes(kind)) return { error: T("Invalid kind") };
  const out = {};
  // On create every field is in the response — createVar expects the full set.
  if (b.kind !== undefined || fresh) out.kind = kind;
  if (b.description !== undefined || fresh) out.description = String(b.description || "");
  if (b.mcpAccess !== undefined || fresh) out.mcpAccess = b.mcpAccess !== false;
  if (b.value !== undefined || fresh) {
    if (typeof b.value !== "string" || !b.value.trim()) return { error: "value required" };
    out.value = b.value;
  }
  return out;
}

// Row of the discovery list: WHAT exists, never a value.
const varsMcpRow = (v) => ({
  key: v.key, kind: v.kind, description: v.description, access: v.mcpAccess, origin: v.origin,
});

// ── Fields of the coding MCP airlock ─────────────────────────
// Headers: name per RFC 7230 (token), value ≤ 4 KB without a line break, only for http/sse. The names the backend sets
// itself when forwarding are locked — a user value there would break the protocol.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const HEADER_VALUE_MAX = 4096;
const HEADER_LOCKED = new Set(["host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "connection", "transfer-encoding", "x-cbase-token"]);

// `raw` from the body: `{ Name: "value" | null }` sets or removes individually. `alt` = the stored values. Returns
// `{ error }` or `{ headers }` (the FULL new object); `raw === undefined` means unchanged (`{ headers: alt }`).
function headersChange(raw, transport, old = {}) {
  if (raw === undefined) return { headers: { ...old } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: T("headers: an object { name: value | null } is expected.") };
  const fresh = { ...old };
  for (const [nameRaw, value] of Object.entries(raw)) {
    const name = String(nameRaw).trim();
    if (!HEADER_NAME.test(name)) return { error: T`Header "${name}": invalid name.` };
    if (HEADER_LOCKED.has(name.toLowerCase())) return { error: T`Header "${name}" is set by cbase.` };
    // A name applies regardless of case (HTTP) — the stored one of the same name drops.
    for (const k of Object.keys(fresh)) if (k.toLowerCase() === name.toLowerCase()) delete fresh[k];
    if (value === null) continue;
    if (typeof value !== "string" || !value.length) return { error: T`Header "${name}": value missing (null removes it).` };
    if (/[\r\n\0]/.test(value)) return { error: T`Header "${name}": value contains a line break.` };
    if (Buffer.byteLength(value) > HEADER_VALUE_MAX) return { error: T`Header "${name}": value over 4 KB.` };
    fresh[name] = value;
  }
  if (Object.keys(fresh).length && transport !== "http" && transport !== "sse") return { error: T("Headers exist only for http/sse.") };
  return { headers: fresh };
}

// The other airlock fields from the body of a PATCH: `choice` (null = all, otherwise names), `markers`, `subagentsInherit`.
// Allowed are names from the cache AND names choice or marks already carry (a vanished tool keeps its decision).
// Returns `{ error, unknown? }` or the fields to write (only those named).
function airlockFields(server, b) {
  const out = {};
  // Only names the server knows (its cache, choice or marks) are selectable or markable.
  const known = new Set([...(Array.isArray(server.tools) ? server.tools : []).map((w) => w.name), ...(server.choice || []), ...(server.markers || [])]);
  const namesList = (field, v) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) return { error: T`${field}: a list of tool names is expected.` };
    const unknown = [...new Set(v)].filter((n) => !known.has(n));
    if (unknown.length) return { error: T`${field}: unknown tools (load the tools first): ${unknown.join(", ")}`, unknown };
    return { list: [...new Set(v)] };
  };
  if ("choice" in b) {
    if (b.choice === null) out.choice = null;
    else { const r = namesList("choice", b.choice); if (r.error) return r; out.choice = r.list; }
  }
  if ("markers" in b) { const r = namesList("markers", b.markers); if (r.error) return r; out.markers = r.list; }
  if ("subagentsInherit" in b) {
    if (typeof b.subagentsInherit !== "boolean") return { error: T("subagentsInherit must be true or false.") };
    out.subagentsInherit = b.subagentsInherit;
  }
  return out;
}
const AIRLOCK_FIELDS = ["headers", "choice", "markers", "subagentsInherit"];

// Validates/normalizes incoming MCP server data (create & edit). Returns {error} if invalid, otherwise the cleaned fields.
function normalizeMcpBody(b) {
  const name = String(b.name || "").trim().toLowerCase();
  if (!isValidMcpName(name)) return { error: T("Name: only a–z, 0–9, _ and - (max. 64 characters).") };
  if (RESERVED_MCP_NAMES.has(name)) return { error: T`"${name}" is a reserved name.` };
  const transport = ["stdio", "http", "sse"].includes(b.transport) ? b.transport : "stdio";
  if (transport === "stdio") {
    const command = String(b.command || "").trim();
    if (!command) return { error: T("Command required (e.g. npx).") };
    const args = Array.isArray(b.args)
      ? b.args.map((a) => String(a)).filter((a) => a.length)
      : String(b.args || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const env = {};
    if (b.env && typeof b.env === "object" && !Array.isArray(b.env)) {
      for (const [k, v] of Object.entries(b.env)) { const kk = String(k).trim(); if (kk) env[kk] = String(v ?? ""); }
    }
    return { name, transport, command, args, env, url: "", enabled: b.enabled !== false };
  }
  const urlStr = String(b.url || "").trim();
  if (!/^https?:\/\//.test(urlStr)) return { error: T("URL required (http/https).") };
  return { name, transport, command: "", args: [], env: {}, url: urlStr, enabled: b.enabled !== false };
}

// Workspace-local .mcp.json (for manual claude calls in the folder): uses the system node, the project is resolved via cwd.
// `"node"` here and `process.execPath` in writeMcpConfig (above) look alike and answer two questions: THIS file is read by a
// `claude` the human starts in a terminal — a system node is right there; the configuration above starts the node THIS
// server runs on, whatever is in the run's PATH. Do not unify.
function writeWorkspaceMcpJson(wsPath, workspaceId = "") {
  const cfg = { mcpServers: {
    cbase: { command: "node", args: [MCP_SCRIPT], env: { CBASE_BASE_URL: BASE_URL } },
    playwright: playwrightMcpEntry("npx", { headless: playwrightHeadless(), userDataDir: playwrightProfileDir(workspaceId) }),
  } };
  fs.writeFileSync(path.join(wsPath, ".mcp.json"), JSON.stringify(cfg, null, 2));
}

// Does this run's CLI obtain approvals via cbase_permission_prompt? Only a provider that drives its own tool loop AND lets
// individual tools be approved (`caps.ownsAgentLoop && caps.permissionPrompt` — the Claude CLI via --permission-prompt-tool;
// Codex never asks, the loop engine asks in its own process), and only outside bypassPermissions. The same condition is
// spec.permissionPromptTool at the run (runs/do-run.js, runs/agents.js) — the marker CBASE_APPROVAL is its description side.
function approvalOverMcp(caps, permissionMode) {
  return Boolean(caps?.ownsAgentLoop && caps?.permissionPrompt) && permissionMode !== "bypassPermissions";
}

export { MCP_CALL_TIMEOUT_MS, MCP_CATALOG, RESERVED_MCP_NAMES, AIRLOCK_FIELDS, approvalOverMcp, isValidMcpName, headersChange, mcpServerToConfigEntry, normalizeMcpBody, airlockFields, varsBody, varsMcpRow, writeMcpConfig, writeWorkspaceMcpJson };
