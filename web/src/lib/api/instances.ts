// The "Instances" tab in a project: the routes to the server, nothing else. The "what the tree shows" calculation lives in the leaf
// lib/instances-tree.ts (readTree, actionsOf …), the UI in components/projects/InstancesPage.tsx and InstanceDialogs.tsx.
//
// The routes and their shapes (the header comments of the server files are the contract):
//   GET  /api/projects/:pid/instances[?open=…]                  the tree (projectbox/instances-tree.js); RAW here (`unknown`), the
//                                                               allowlist is `readTree` in the leaf
//   GET  …/instances/:instance/repos                            per code repo: branch, open files (cap + count), branches to choose from
//   POST …/instances/:instance/branch { repo, branch }          409 INSTANCE_WORKING `{ chats }` · 409 OPEN_CHANGES `{ files, count }` ·
//                                                               409 IGNORED_FILES `{ files, count }` (ignored files the target branch
//                                                               carries; the switch would overwrite them) · 409 OCCUPIED
//   POST …/instances/:instance/dismiss { repo, files }          exactly the named files (400 UNKNOWN_FILES)
//   POST …/instances/:instance/stack-restart                    `compose up -d --build` per stack, ASYNCHRONOUS: 202 `{ instance, action }`
//                                                               at once; progress and result are in the tree (`action`,
//                                                               lib/instances-tree.ts) and in the event `project/instance`
//   POST …/instances/:instance/stop | start | start-abort       projectbox/instance-stop.js
//   POST /api/projects/:pid/stack-copies { name?, base?, baseInstance? }   WITHOUT `chatId`: a human creates (stacks/routes.js);
//                                                               `baseInstance` is "main" or "copy-<name>" of a ready copy
//                                                               (400 BASE_INSTANCE_INVALID · 409 TEMPLATE_UNKNOWN/_NOT_READY/_UNREADABLE ·
//                                                               409 MAIN_STOPPED: no copy without a running main)
//   GET  …/stack-copies/:name/state                             the delete preview (stacks/status.js)
//   DELETE …/stack-copies/:name                                 202 `{ copy, … }` · 409 INSTANCE_WORKING `{ chats, open }`
//   POST …/stack-copies/:name/fetch {}                          the copy's commits into the main (`copy/<name>/…`)
//   PATCH /api/chats/:id { instance }                           `null`/"main" means main; the field is NEVER missing ("a missing field
//                                                               is no statement", the body is typed)
//   (POST /api/chats { …, instance }: "start chat" in an instance goes through the draft, ChatPane `ensureChat`)
//
// `api` throws errors carrying the body's fields (`code`, `chats`, `files`, `count`, `state` …); the dialogs read them via
// `errorFields`. Leaf module: imports only from lib/api/ (README there).
import { api } from "./core.js";
import type { Chat } from "./events.js";

const projectPath = (pid: string) => `/api/projects/${encodeURIComponent(pid)}`;
const instancePath = (pid: string, instance: string) => `${projectPath(pid)}/instances/${encodeURIComponent(instance)}`;
const copyPath = (pid: string, name: string) => `${projectPath(pid)}/stack-copies/${encodeURIComponent(name)}`;
const post = <T>(path: string, body: object) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

/** A chat of a 409 INSTANCE_WORKING (projectbox/idle.js) or of the delete preview. */
export type WorkingChat = { id: string; title: string; reason: string; running: boolean };

/** The fields of a thrown error that the dialogs read; each list only if it is one (never guessed). */
export type ErrorFields = { text: string; code: string; chats: WorkingChat[] | null; files: string[] | null; count: number | null; state: string | null };
export function errorFields(e: unknown): ErrorFields {
  const f = (e ?? {}) as Record<string, unknown>;
  const chats = Array.isArray(f.chats)
    ? f.chats.flatMap((c) => {
      const r = (c ?? {}) as Record<string, unknown>;
      const id = typeof r.id === "string" ? r.id : typeof r.chatId === "string" ? r.chatId : "";
      return id || typeof r.title === "string" || typeof r.reason === "string"
        ? [{ id, title: typeof r.title === "string" ? r.title : "", reason: typeof r.reason === "string" ? r.reason : "", running: r.running !== false }]
        : [];
    })
    : null;
  return {
    text: e instanceof Error ? e.message : String(f.error ?? f.error ?? e ?? ""),
    code: typeof f.code === "string" ? f.code : "",
    chats,
    files: Array.isArray(f.files) ? f.files.filter((x): x is string => typeof x === "string") : null,
    count: typeof f.count === "number" && Number.isFinite(f.count) ? f.count : null,
    state: typeof f.state === "string" ? f.state : null,
  };
}

// ── The tree ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The tree RAW. `open` = the (chosen) instance to read fresh (lib/instances-tree.ts openParam), `null` = no parameter; `fresh` = every
 *  ready one fresh instead of from the summary cache (after an own action and after the events `project/instance`/`project/copy`;
 *  projectbox/instances-tree.js "SUMMARY"). */
export const loadInstancesTree = (pid: string, open: string | null, fresh = false) => {
  const q = [open ? `open=${encodeURIComponent(open)}` : "", fresh ? "fresh=1" : ""].filter(Boolean).join("&");
  return api<unknown>(`${projectPath(pid)}/instances${q ? `?${q}` : ""}`);
};

// ── Repos, branch, dismiss, restart stack ───────────────────────────────────────────────────────────────────

/** A repo row of GET …/repos (projectbox/instance-actions.js rowFrom). `rel` "" = the project folder; `null` = not readable. */
export type InstanceRepo = {
  rel: string; name: string; branch: string; detached: boolean;
  open: string[] | null; openCount: number | null; branches: string[] | null; remotes: string[] | null; error: string;
};
export type InstanceRepos = { loaded: true; repos: InstanceRepo[] } | { loaded: false; error: string; state: string | null };

const textList = (x: unknown): string[] | null => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : null);
export function normInstanceRepo(raw: unknown): InstanceRepo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.rel !== "string") return null;
  return {
    rel: r.rel, name: typeof r.name === "string" ? r.name : r.rel, branch: typeof r.branch === "string" ? r.branch : "",
    detached: r.detached === true, open: textList(r.open),
    openCount: typeof r.openCount === "number" && Number.isFinite(r.openCount) ? r.openCount : null,
    branches: textList(r.branches), remotes: textList(r.remotes), error: typeof r.error === "string" ? r.error : "",
  };
}

export async function loadInstanceRepos(pid: string, instance: string): Promise<InstanceRepos> {
  const r = await api<Record<string, unknown>>(`${instancePath(pid, instance)}/repos`);
  if (r?.loaded !== true || !Array.isArray(r.repos)) {
    return { loaded: false, error: typeof r?.error === "string" ? r.error : "", state: typeof r?.state === "string" ? r.state : null };
  }
  return { loaded: true, repos: r.repos.map(normInstanceRepo).filter((x): x is InstanceRepo => x !== null) };
}

export type BranchBody = { repo: string; branch: string };
export type DismissBody = { repo: string; files: string[] };
export const switchBranch = (pid: string, instance: string, body: BranchBody) =>
  post<{ repo: unknown }>(`${instancePath(pid, instance)}/branch`, body).then((r) => normInstanceRepo(r?.repo));
export const dismissFiles = (pid: string, instance: string, body: DismissBody) =>
  post<{ repo: unknown }>(`${instancePath(pid, instance)}/dismiss`, body).then((r) => normInstanceRepo(r?.repo));
/** Triggers the restart (202) → `since` of the action (its start in ms, `null` without one); the dialog recognises ITS action in the
 *  event `project/instance` by it; the state itself is read by lib/instances-tree.ts `actionFrom` (ONE reader of the shape). */
export const restartStack = (pid: string, instance: string) =>
  post<{ action?: { since?: unknown } }>(`${instancePath(pid, instance)}/stack-restart`, {})
    .then((r) => ({ since: typeof r?.action?.since === "number" && Number.isFinite(r.action.since) ? r.action.since : null }));

// ── Stop, start, abort start ─────────────────────────────────────────────────────────────────────────────

export const stopInstance = (pid: string, instance: string) => post<unknown>(`${instancePath(pid, instance)}/stop`, {});
/** `kind`: "start" (boots) or "waiting" (memory gate closed; starts by itself, abortable). */
export const startInstance = (pid: string, instance: string) =>
  post<{ kind?: unknown }>(`${instancePath(pid, instance)}/start`, {}).then((r) => ({ kind: r?.kind === "waiting" ? "waiting" as const : "start" as const }));
export const abortInstanceStart = (pid: string, instance: string) => post<unknown>(`${instancePath(pid, instance)}/start-abort`, {});

// ── Create a copy, delete preview, delete, fetch ───────────────────────────────────────────────────────────

/** The body of creation by a human: NEVER with `chatId` (the copy belongs to no chat). `base`: one ref per repo
 *  (`{ "<rel>": ref }`, "." = the project folder) or absent. */
export type CopyCreateBody = { name: string; baseInstance: string; base?: Record<string, string> };
export const createCopy = (pid: string, body: CopyCreateBody) =>
  post<{ copy?: { name?: unknown; state?: unknown } }>(`${projectPath(pid)}/stack-copies`, body)
    .then((r) => ({ name: typeof r?.copy?.name === "string" ? r.copy.name : body.name, state: typeof r?.copy?.state === "string" ? r.copy.state : "" }));

/** A repo row of the delete preview (stacks/status.js): what ends up in the main as `copy/<name>/…`. */
export type StateRepo = { rel: string; name: string; branch: string; detached: boolean; commits: number | null; open: string[]; openCount: number | null; fresh: boolean };
export type CopyStatus = { loaded: true; repos: StateRepo[]; chats: WorkingChat[] } | { loaded: false; error: string };
export async function loadCopyStatus(pid: string, name: string): Promise<CopyStatus> {
  const r = await api<Record<string, unknown>>(`${copyPath(pid, name)}/state`);
  if (r?.loaded !== true || !Array.isArray(r.repos) || !Array.isArray(r.chats)) return { loaded: false, error: typeof r?.error === "string" ? r.error : "" };
  const count = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    loaded: true,
    repos: r.repos.flatMap((x) => {
      const z = (x ?? {}) as Record<string, unknown>;
      if (typeof z.rel !== "string") return [];
      return [{ rel: z.rel, name: typeof z.name === "string" ? z.name : z.rel, branch: typeof z.branch === "string" ? z.branch : "", detached: z.detached === true, commits: count(z.commits), open: textList(z.open) ?? [], openCount: count(z.openCount), fresh: z.fresh === true }];
    }),
    chats: errorFields({ chats: r.chats }).chats ?? [],
  };
}
/** DELETE without a body: a human over REST gets 409 on ANY work in the copy; `scheduled` exists only for the agent. */
export const deleteCopy = (pid: string, name: string) => api<Record<string, unknown>>(copyPath(pid, name), { method: "DELETE" });
export const fetchCopy = (pid: string, name: string) => post<{ result?: unknown }>(`${copyPath(pid, name)}/fetch`, {});

// ── Chats in an instance ────────────────────────────────────────────────────────────────────────────────────────

/** The body of the instance switch: the field is ALWAYS present; `null` means main. A PATCH without `instance` would leave everything as is. */
export type ChatInstanceBody = { instance: string | null };
export const setChatInstance = (chatId: string, instance: string | null) => {
  const body: ChatInstanceBody = { instance };
  return api<Chat>(`/api/chats/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify(body) });
};
// "Start chat" in an instance no longer creates by itself (new chat = draft, lib/chat-draft.ts): the coding chat opens a draft with
// project and instance, `ensureChat` creates on the first send: one POST for all entry points.
