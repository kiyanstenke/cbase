export type McpTransport = "stdio" | "http" | "sse";
export interface McpServer {
  id: string;
  workspaceId: string;
  projectId?: string | null;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // Coding MCP airlock: header names only (values never), the tool cache, the choice (null = all), the marks (card) and "subagents
  // inherit". Optional: an older server does not know them.
  headers?: { name: string; set: boolean }[];
  tools?: { name: string; description?: string; writing: boolean | null; fresh?: boolean }[];
  toolsAt?: number;
  toolsError?: string;
  choice?: string[] | null;
  markers?: string[];
  subagentsInherit?: boolean;
  // Only in the project list (`workspaceServers`): whether the server is on at workspace level; `enabled` means "not hidden" there.
  inWorkspaceActive?: boolean;
}
export interface ProjectMcpServers {
  projectServers: McpServer[];   // the project's own servers (with their own .enabled)
  // Workspace servers apply in every project: .enabled = not hidden in this project, .inWorkspaceActive = on at workspace level (one
  // switched off there is missing in every project).
  workspaceServers: McpServer[];
}
export interface McpCatalogEntry {
  key: string;
  label: string;
  description: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  needs: string;
}

export interface WorkspaceVar {
  id: number;
  // "freeText" is the multi-line block for a whole access; no field schema, because only whoever enters it knows what it consists of.
  kind: "secret" | "variable" | "link" | "freeText";
  key: string;
  value: string;
  description: string;
  mcpAccess: boolean;
  createdAt: number;
  updatedAt: number;
  enabled?: boolean; // only in the project list (workspace-vars): available in the project (default) or hidden
}

export interface Attachment {
  name: string;
  file: string;
  mime: string;
  size: number;
  // Width and height of an image from its file header (server runtime/image-dimensions.js); the history reserves the space with them
  // before loading. If they are missing (other type, old attachment, unreadable header), the old way applies.
  w?: number;
  h?: number;
}

export interface LogEntry {
  // Row id from the database: monotonically increasing, the basis of incremental reloading.
  id: number;
  role: string;
  text: string;
  ts: number;
  attachments?: Attachment[] | null;
  // Truncated in the window (server chats/log-window.js): the length of the untruncated `text`; in full via `loadRowFull` (lib/api/log-window.ts).
  truncated?: number;
}

// Answer of GET /api/chats/:id/log/delta?since=<id>: only the new rows plus the total, by which a client recognizes whether its cache
// still fits without gaps.
export interface LogDelta {
  total: number;
  lastId: number;
  rows: LogEntry[];
}

// A port claimed by a project (project_services with a port). The only port source; there is no separate registry anymore.
export interface PortClaim {
  id: number;
  port: number;
  name: string;
  kind: string;
  tech: string;
  container: string;
  startCommand: string;
  projectId: string;
  projectName: string;
  workspaceId: string | null;
}

export interface PortProcess {
  pid: number;
  cmd: string;
  cwd: string;
}

// A finding of the live scan. The same data as in `open`/`reserved`, but as a statement: "conflict" (several projects claim a port),
// "occupiedByOther" (another process listens on a claimed port) and "unregistered" (something from a project folder listens on a port
// no service claims; therefore invisible in the apps view).
export interface PortFinding {
  kind: "conflict" | "occupiedByOther" | "unregistered";
  port: number;
  // The finding's namespace: the identifier "<projectId>/<instance>" of a project container, null = the backend. An older server
  // does not send the field; that means the backend.
  instance?: string | null;
  service?: string;
  services?: { id: number; name: string; project: string }[];
  project?: string;
  projectId?: string;
  workspaceId?: string | null;
  process?: string;
  cwd?: string;
}

export interface RunningPorts {
  scanned: number;
  // `instance` per entry: in which namespace the port is open; the same port can appear twice.
  open: { port: number; instance?: string | null; registered: PortClaim | null; process?: PortProcess | null; mismatch?: boolean }[];
  reserved?: PortClaim[];
  findings?: PortFinding[];
  // false = read without process resolution (light polling mode); "no findings" is then no statement but an unasked question.
  findingsComplete?: boolean;
}

export interface ProjectCategory {
  slug: string;
  label: string;
}

// OKF freshness of an entry: git-anchored staleness detection (commits on code_paths since verification).
export interface ContextFreshness {
  stale?: boolean;
  neverVerified?: boolean;
  verifiedAt?: number | null;
  commits?: { repo: string; sha: string; subject: string }[];
  /** Only in the metadata list (meta=1): a count instead of a list, since the list is unbounded. */
  commitCount?: number;
  missingPaths?: string[];
  rebased?: boolean;
}

export type ContextLinks = Partial<Record<"related" | "depends_on" | "supersedes" | "conflicts_with", string[]>>;

export interface ProjectContextItem {
  id: number;
  projectId: string;
  category: string;
  title: string;
  body: string;
  summary: string;
  tags: string;
  source: string;
  validAsOf: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  // "workspace" = from an adopted workspace category (read-only); otherwise the project's own entry.
  origin?: "project" | "workspace";
  // OKF: stable reference, lifecycle, anchors, relations.
  slug?: string;
  status?: "active" | "deprecated" | "superseded";
  supersededBy?: string;
  owners?: string;
  links?: ContextLinks | null;
  codePaths?: string[];
  symbols?: string;
  confidence?: string;
  freshness?: ContextFreshness | null;
}

// A workspace context category a project can adopt (opt-in, like workspace skills).
export interface AdoptableContextCategory {
  category: string;
  n: number;
  adopted: boolean;
}

export interface ContextSuggestion {
  id: number;
  projectId: string;
  chatId: string | null;
  op: "create" | "update" | "delete";
  targetId: number | null;
  category: string;
  title: string;
  body: string;
  summary: string;
  tags: string;
  validAsOf: string;
  reason: string;
  status: string;
  createdAt: number;
}

export interface PendingCount {
  projectId: string;
  n: number;
}

