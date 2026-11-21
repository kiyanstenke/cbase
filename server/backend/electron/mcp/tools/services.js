// MCP tools: ports, services, monitor and wakeup (cbase_ports_*, service_*, monitor, monitor_stop, wakeup).
// One coherent section of the tool array, in source order — cbase-mcp.js puts the groups back together into TOOLS by spread;
// the order is part of the prompt prefix (cache), guard: server/backend/test/mcp-catalog.test.js.

import process from "node:process";
import { MONITOR_LIFETIME, MONITOR_RULE } from "../monitor-rule.js";
import { WAKEUP_LIFETIME } from "../wakeup-rule.js";
import { api, assertInScope, assertServiceInScope, enc, int, obj, qs, scopeWorkspace, serviceInScope, str } from "../lib.js";

// The instance of the chat: if this MCP server runs for a run in a project container, its environment carries that container's
// identifier "<projectId>/<instance>" (`CBASE_INSTANCE`, toolchain/mcp-config.js writeMcpConfig) — port list and port choice then ask
// the namespace OF the container, not that of B. Without an instance it is missing, and the URL is the plain one (qs omits empty
// values). Read at run time, like CBASE_CHAT_ID.
const chatInstance = () => process.env.CBASE_INSTANCE || undefined;
// The instance for start, stop and log of a service: the chat's, if the service belongs to its project — a service of another
// project has nothing to do with it (the route would reject the identifier of a foreign project with 400; from a project network
// the fence sets its own anyway). Without an instance it is missing, and the URL is the plain one.
const serviceInstance = (svc) => {
  const k = chatInstance();
  return k && k.startsWith(`${svc.projectId}/`) ? k : undefined;
};

// The reading guide of an answer of cbase_ports_running: one sentence per field THIS answer carries — it names its meaning itself,
// instead of the description explaining every conceivable field. The fields themselves stay as the route delivers them (projects/routes.js
// portRoutes); `interpretation` stands first so that the model reads it before the data.
export const PORTS_INTERPRETATION = Object.freeze({
  process: "process = pid/cmd/cwd of the process actually listening (best effort).",
  mismatch: "mismatch: true = a process listens there that does NOT belong to the registered service.",
  reserved: "reserved = registered ports that are not currently running: they, too, are TAKEN and must not be used for other services.",
  conflict: "findings kind \"conflict\" = several projects claim the same port.",
  occupiedByOther: "findings kind \"occupiedByOther\" = a process other than the registered service listens there — do NOT simply start your own service there.",
  unregistered: "findings kind \"unregistered\" = something from a PROJECT FOLDER listens on a port that no service claims: invisible in the apps view and not clickable in the port forwarding — register it with cbase_service_add or end it.",
  incomplete: "findingsComplete: false = without process resolution or not read in every namespace — the empty findings list is then no acquittal.",
  unreachable: "unreachable = namespaces (instances whose container is not running or missing) that could NOT be checked — an unchecked namespace is not an empty one.",
});
export function portsInterpretation(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return r;
  const open = Array.isArray(r.open) ? r.open : [];
  const kinds = new Set((Array.isArray(r.findings) ? r.findings : []).map((b) => b?.kind));
  const L = PORTS_INTERPRETATION;
  const interpretation = [
    ...(open.some((o) => o && o.process) ? [L.process] : []),
    ...(open.some((o) => o && o.mismatch === true) ? [L.mismatch] : []),
    ...(Array.isArray(r.reserved) && r.reserved.length ? [L.reserved] : []),
    ...["conflict", "occupiedByOther", "unregistered"].filter((a) => kinds.has(a)).map((a) => L[a]),
    ...(r.findingsComplete === false ? [L.incomplete] : []),
    ...(Array.isArray(r.unreachable) && r.unreachable.length ? [L.unreachable] : []),
  ];
  return interpretation.length ? { interpretation, ...r } : r;
}

// The two versions of the description of cbase_ports_list: same head, different world of conflicts.
const PORTS_LIST_HEADER = "This is the only port source — there is no separate registry. THE FIRST TOOL when you want to start a service of a project: if the app is listed here, it is already registered and is started with cbase_service_start (id) via its stored start command — NOT as a second process on another port next to it.";
export const PORTS_LIST_IN_B = `All ports CLAIMED by projects (project_services with a port, each with service id, project, name, startCommand). ${PORTS_LIST_HEADER} A port CONFLICT exists as soon as more than one project in this network claims the same port; a project in its own container (entry with \`hint\`) listens in its own network namespace and is in no conflict. Entries of foreign workspaces appear only as {port, external:true} (for the conflict check), without project details.`;
export const PORTS_LIST_IN_PROJECT = `The ports CLAIMED by THIS project (project_services with a port, each with service id, name, startCommand and \`hint\`). ${PORTS_LIST_HEADER} The project runs in its own container with its own network namespace: ports of other projects do not appear here, and the same port of another project is no conflict.`;

const serviceTools = [
  {
    name: "cbase_ports_list",
    // Depends on the run: in the project container (CBASE_INSTANCE) the fence lets only the ports of THIS project through
    // (projectbox/fence.js filter "ports"), and the same port of another project is no conflict (own network namespace,
    // SET_PORTS_IN_PROJECT in the focus).
    description: () => (chatInstance() ? PORTS_LIST_IN_PROJECT : PORTS_LIST_IN_B),
    inputSchema: obj({}),
    handler: async () => {
      const ports = await api("GET", "/api/ports");
      const ws = await scopeWorkspace();
      if (!ws) return ports;
      // Foreign workspaces: the port stays visible (conflict check!), the project identity does not. The hint of a converted
      // project (the server sets it: its port belongs to it, no conflict) travels there too — it names nobody.
      return ports.map((s) => (s.workspaceId === ws ? s : { port: s.port, external: true, ...(s.hint ? { hint: s.hint } : {}) }));
    },
  },
  {
    name: "cbase_ports_running",
    // The explanation of the fields stands in the ANSWER (`interpretation`, portsInterpretation) — and only for the fields this
    // answer carries, not 1,300 characters in the description whether there was a finding or not.
    description: "Checks via a live TCP check which ports are actually occupied and by whom — for conflicts, ports occupied by others and unregistered ports. Checked are 3000–9999 and all claimed ports, or a custom range in `ports`. The answer names findings as a statement (`findings`) and explains under `interpretation` every field it carries — an empty findings list is an acquittal only if `findingsComplete` is true.",
    inputSchema: obj({ ports: str("e.g. '3000-4000,5173,8080'") }),
    handler: async (a) => portsInterpretation(await api("GET", `/api/ports/running${qs({ ports: a.ports, instance: chatInstance() })}`)),
  },
  {
    name: "cbase_ports_free",
    description: "Finds the first free port from start (neither claimed by a project nor occupied live) — for a NEW, not yet registered service. For an app that already exists in the project this is the wrong tool: read cbase_ports_list and start the registered service with cbase_service_start instead. The answer names in `skipped` the claimed ports the search passed by, with service, project and stored start command — if the service you actually wanted to start is listed there, take it instead of a second process next to it.",
    inputSchema: obj({ start: int("start port (default 3000)"), end: int("end port (default 9999)") }),
    handler: (a) => api("GET", `/api/ports/free${qs({ start: a.start, end: a.end, instance: chatInstance() })}`),
  },
  {
    name: "cbase_service_add",
    description: "Registers a service with a port on a project (project_services) — e.g. a permanent dev server the scan did not capture. projectId from cbase_projects_list.",
    inputSchema: obj({
      projectId: str("project ID (from cbase_projects_list)"),
      name: str("service name, e.g. frontend"), port: int("host port (1-65535) or omit"),
      kind: str("backend|frontend|db|cache|queue|worker|infra|other"), container: str("Docker container (optional)"),
      tech: str("technology (optional)"), startCommand: str("start command (optional)"), description: str("(optional)"),
    }, ["projectId", "name"]),
    handler: async (a) => api("POST", "/api/project-services", {
      projectId: await assertInScope(a.projectId), name: a.name, port: a.port ?? null, kind: a.kind,
      container: a.container, tech: a.tech, startCommand: a.startCommand, description: a.description,
    }),
  },
  {
    name: "cbase_service_update",
    description: "Corrects the port or start command of a registered service so that the apps view is right without a new scan — e.g. AFTER you have really resolved a conflict. id from cbase_ports_list. Set `port` to the host port now actually used and/or `startCommand` to the command that starts the service with the new port (e.g. `docker compose -f docker-compose.yml -f docker-compose.cbase.yml up -d web`). The stored start command belongs to the project, not to your session: do not bend it for an intermediate state. If you do anyway, the answer names the displaced command in `replacedStartCommand` — then restore it at the end; the history is in cbase_service_command_history. A command over 300 characters is rejected instead of shortened.",
    inputSchema: obj({
      id: int("service id from cbase_ports_list"),
      port: int("new host port (1-65535)"),
      startCommand: str("new start command of the service (optional)"),
      description: str("new description: what the service is, which port is assigned to it, which env variable breaks it. Correct it TOO if your start command contradicts it — a description that says something different from the command next to it sends the next person astray (optional)"),
    }, ["id"]),
    handler: async (a) => {
      const body = {};
      if (typeof a.port === "number") body.port = a.port;
      if (typeof a.startCommand === "string") body.startCommand = a.startCommand;
      if (typeof a.description === "string") body.description = a.description;
      return api("PATCH", `/api/project-services/${enc(await assertServiceInScope(a.id))}`, body);
    },
  },
  {
    name: "cbase_service_delete",
    description: "Removes a service (project_services) — e.g. when it no longer exists. id from cbase_ports_list.",
    inputSchema: obj({ id: int("service id from cbase_ports_list") }, ["id"]),
    handler: async (a) => api("DELETE", `/api/project-services/${enc(await assertServiceInScope(a.id))}`),
  },
  {
    name: "cbase_service_log",
    description: "Reads the last lines of the log of a registered service: the process log for a simple start, `docker logs` for container services. Also stopped containers — useful for crash diagnosis. id from cbase_ports_list.",
    inputSchema: obj({ id: int("service id from cbase_ports_list"), lines: int("number of lines (default 300, max 2000)") }, ["id"]),
    handler: async (a) => {
      const svc = await serviceInScope(a.id);
      const r = await api("GET", `/api/projects/${enc(svc.projectId)}/services/${enc(svc.id)}/log${qs({ lines: a.lines, instance: serviceInstance(svc) })}`);
      return r.log?.trim() ? r.log : "(no log available — service never started or container removed)";
    },
  },
  {
    name: "cbase_service_command_history",
    description: "The REPLACED start commands of a service, most recent first. Meant for restoring a stored command that someone — possibly you yourself in an earlier turn — bent for an intermediate state. id from cbase_ports_list.",
    inputSchema: obj({ id: int("service id from cbase_ports_list") }, ["id"]),
    handler: async (a) => api("GET", `/api/project-services/${enc(await assertServiceInScope(a.id))}/command-history`),
  },
  {
    name: "cbase_service_start",
    description: "Starts a registered service via its stored start command (like the simple start in the UI; log afterwards via cbase_service_log). Error if it is already running, the port is occupied or no start command is stored — if the start command is missing, store it with cbase_service_update (startCommand) and then start again with this tool; never in the background from the shell yourself. id from cbase_ports_list.",
    inputSchema: obj({ id: int("service id from cbase_ports_list") }, ["id"]),
    handler: async (a) => {
      const svc = await serviceInScope(a.id);
      return api("POST", `/api/projects/${enc(svc.projectId)}/services/${enc(svc.id)}/start${qs({ instance: serviceInstance(svc) })}`, { mode: "simple" });
    },
  },
  {
    name: "cbase_service_stop",
    description: "Stops a registered running service (process group/port/container — like the stop button in the UI). id from cbase_ports_list.",
    inputSchema: obj({ id: int("service id from cbase_ports_list") }, ["id"]),
    handler: async (a) => {
      const svc = await serviceInScope(a.id);
      return api("POST", `/api/projects/${enc(svc.projectId)}/services/${enc(svc.id)}/stop${qs({ instance: serviceInstance(svc) })}`);
    },
  },
  {
    name: "cbase_monitor",
    description: `Starts a monitor that wakes this chat beyond the end of your answer. THE monitor tool of this app (your provider has no built-in one in cbase). Exactly one of command (shell command) or ws (WebSocket URL). ${MONITOR_LIFETIME} ${MONITOR_RULE} With rows every line or text frame costs a model call: filter in the command (\`grep --line-buffered\`, \`awk\` with \`fflush()\`) and cover error cases; the server summarizes too many reports and ends a constant barrage. Do not poll. Time limit: rows default 2 min, end default 4 h, at most 24 h; persistent=true without a time limit.`,
    inputSchema: obj({
      command: str("shell command: with rows one that produces output on relevant events; with end the command itself (build, test suite); not together with ws"),
      ws: str("ws:// or wss:// URL; with rows every text frame is an event, with end the closing of the connection counts; not together with command"),
      protocols: { type: "array", items: { type: "string" }, description: "optional WebSocket subprotocols" },
      description: str("short description of the watched state (appears on the card under Background Tasks)"),
      report: { type: "string", enum: ["rows", "end"], description: "rows (default) = every output line wakes you; end = only the end wakes you, once" },
      timeout_ms: int("time limit in ms (default 120000 with rows, 14400000 with end; max. 86400000); ignored with persistent"),
      persistent: { type: "boolean", description: "true = a lasting watch: no time limit, no cap on events, starts again after a server restart; until cbase_monitor_stop, the command ends or the human stops it" },
    }, ["description"]),
    handler: async (a) => {
      const chatId = process.env.CBASE_CHAT_ID;
      if (!chatId) throw new Error("No chat context (CBASE_CHAT_ID missing) — the monitor cannot be assigned to a chat.");
      return api("POST", `/api/chats/${enc(chatId)}/monitor`, a);
    },
  },
  {
    name: "cbase_monitor_stop",
    description: "Ends a monitor of this chat started with cbase_monitor (also from a later turn).",
    inputSchema: obj({ task_id: str("task ID from the result of cbase_monitor") }, ["task_id"]),
    handler: async (a) => {
      const chatId = process.env.CBASE_CHAT_ID;
      if (!chatId) throw new Error("No chat context (CBASE_CHAT_ID missing).");
      return api("POST", `/api/chats/${enc(chatId)}/monitor/stop`, { taskId: a.task_id, from: "agent" });
    },
  },
  {
    name: "cbase_wakeup",
    description: `Sets a wakeup for THIS chat: at the planned time a new turn begins automatically with your prompt. Use it when you wait for something no monitor can watch (foreign service without a log, fixed waiting time, "check again in an hour") — instead of sleeping, polling or leaving the task undone. THE wakeup tool of this app (your provider has no built-in wakeups or schedules in cbase); cbase shows it to the user under Background Tasks. ${WAKEUP_LIFETIME}`,
    inputSchema: obj({
      delaySeconds: int("seconds until the continuation (max. 86400 = 24 h)"),
      prompt: str("What you want to do then — this text starts the next turn. Write it so that you understand it without the rest of the conversation."),
      reason: str("Short reason for the chosen waiting time (shown to the user next to the clock time)"),
      stop: { type: "boolean", description: "true = cancel the planned continuation (delaySeconds then does not apply)" },
    }),
    handler: async (a) => {
      const chatId = process.env.CBASE_CHAT_ID;
      if (!chatId) throw new Error("No chat context (CBASE_CHAT_ID missing) — a wakeup cannot be assigned to a chat.");
      return api("POST", `/api/chats/${enc(chatId)}/wakeup`, a);
    },
  },
];

export { serviceTools };
