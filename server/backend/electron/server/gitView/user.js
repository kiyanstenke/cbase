// Who uses a branch and in which state it is. The reading (read.js/groups.js) only knows names and commits; what stands
// behind a cbase branch is known only to the database and the run state of this process:
//
//   cbase/agent-<id>  subagents (store.subagentsWithIds)            → {kind: "subagent", name, chatId, agentId}
//                       running while runs/agents.js coreWithAgent(chatId, agentId) knows it ALIVE, else ended
//                       otherwise a workflow agent (it NEVER writes to the subagents table, runs/agents.js): journal of
//                       the dynamic workflow (store.dynWorkflowAgentsWithIds — `started.agentId`, label at the `launched`
//                       of the same `n`)                              → {kind: "workflow-agent", name, chatId, agentId}
//                       running while the run is `running`, else ended
//                       without a row → user null, state unknown (chat deleted — its rows go with it — or an outer
//                       loop agent; "unknown" ≠ "ended", contract STATES)
//   cbase/graph-<8>   `graph_starts.worktree_info.branch` (youngest row) → {kind: "graph", name: workflow_name, chatId, childChatId}
//                       running only while the run view has not ended (workflows/graph-start.js graphRunView — the
//                       started status stays after the end); without a row unknown
//   copy/<name>/…     `stack_copies` of the PROJECT                  → {kind: "copy", instance: <name>}
//                       running while the copy lives, else copy-removed
//   cbase/<other>     user null, state unknown
//   everything else   user null, state null (only the group "cbase" carries a state)
//
// A user object ALWAYS carries all fields from USER_FIELDS (null where nothing stands): a synthesized Decodable in iOS
// requires every key.
//
// runningChats(projectId, instance): the chats of the project that work in this instance (the chat's instance field,
// NULL = main) AND are running right now — turn (runs/state.js running) or live subagent (runs/agents.js liveAgents).
// Fresh on EVERY call, never from a cache of the git reading (otherwise the row would lag by up to 35 s).
//
// withUsers(projectId, rows) / withChats(projectId, rows): fill the rows of groups.js in place — the table above and the
// running chats per instance; called by overview.js (large, detail) and small.js (GET …/git).
//
// Each call reads in a few queries (one per source, not per branch). Guard: server/backend/test/git-view-user.test.js.
import * as store from "../store.js";
import { coreWithAgent, liveAgents } from "../runs/agents.js";
import { running } from "../runs/state.js";
import { graphRunView } from "../workflows/graph-start.js";
import { USER_FIELDS } from "./contract.js";
import { instanceInternal } from "./instance-choice.js";

export const AGENT_PREFIX = "cbase/agent-";
export const GRAPH_PREFIX = "cbase/graph-";
export const COPY_PREFIX = "copy/";

/** Does the branch belong to the group "cbase" (all `cbase/*` and `copy/*`)? */
export const isCbaseBranch = (name) => typeof name === "string" && (name.startsWith("cbase/") || name.startsWith(COPY_PREFIX));

/** A user object with ALL fields of the contract (null where nothing stands). */
export function userObject(kind, fields = {}) {
  const b = Object.fromEntries(USER_FIELDS.map((k) => [k, null]));
  b.kind = kind;
  for (const [k, v] of Object.entries(fields)) if (USER_FIELDS.includes(k) && v !== undefined) b[k] = v;
  return b;
}

/** The name of the copy in `copy/<name>/…` (or `copy/<name>`), else null. */
export function copyFromBranch(name) {
  if (typeof name !== "string" || !name.startsWith(COPY_PREFIX)) return null;
  const rest = name.slice(COPY_PREFIX.length);
  const k = rest.split("/")[0];
  return k || null;
}

const agentIdFrom = (name) => (name.startsWith(AGENT_PREFIX) && name.length > AGENT_PREFIX.length ? name.slice(AGENT_PREFIX.length) : null);

// The rows of graph_starts per branch — the youngest wins (graphWorktreeRows is sorted by creation).
function graphRowsPerBranch(names) {
  const searched = new Set(names);
  const byKey = new Map();
  for (const z of store.graphWorktreeRows()) {
    let info = null;
    try { info = JSON.parse(z.info || ""); } catch { info = null; }
    const b = info && typeof info.branch === "string" ? info.branch : null;
    if (b && searched.has(b)) byKey.set(b, z.id);
  }
  return byKey;
}

// Is this subagent alive now? Only an open core that knows it ALIVE (a finished one is still in the core).
function subagentAlive(chatId, agentId) {
  try { return Boolean(coreWithAgent(chatId, agentId)?.alive(agentId)); } catch { return false; }
}

/**
 * User and state per branch name (table in the header) → `Map<name, { user, state }>`. `projectId` only limits the
 * copies (a copy name is valid per project); agent and graph ids are globally unique.
 */
export function userAndState(projectId, names) {
  const list = [...new Set((names || []).filter((n) => typeof n === "string" && n))];
  const out = new Map();
  const agentIds = list.map(agentIdFrom).filter(Boolean);
  const sub = new Map();
  for (const z of store.subagentsWithIds(agentIds)) {
    // Several rows of the same id (a fork carries it along): a live one before the youngest (the rows come oldest first).
    if (sub.get(z.agentId)?.alive) continue;
    sub.set(z.agentId, { z, alive: subagentAlive(z.chatId, z.agentId) });
  }
  const withoutSub = agentIds.filter((id) => !sub.has(id));
  const wf = new Map(store.dynWorkflowAgentsWithIds(withoutSub).map((w) => [w.agentId, w]));
  const graphNames = list.filter((n) => n.startsWith(GRAPH_PREFIX));
  const graph = graphNames.length ? graphRowsPerBranch(graphNames) : new Map();
  for (const name of list) {
    if (!isCbaseBranch(name)) { out.set(name, { user: null, state: null }); continue; }
    const aid = agentIdFrom(name);
    if (aid && sub.has(aid)) {
      const { z, alive } = sub.get(aid);
      out.set(name, { user: userObject("subagent", { name: z.name || null, chatId: z.chatId, agentId: aid }), state: alive ? "running" : "ended" });
      continue;
    }
    if (aid && wf.has(aid)) {
      const w = wf.get(aid);
      out.set(name, { user: userObject("workflow-agent", { name: w.label || w.runName || null, chatId: w.chatId, agentId: aid }), state: w.status === "running" ? "running" : "ended" });
      continue;
    }
    if (graph.has(name)) {
      const z = store.graphStart(graph.get(name));
      const view = z ? graphRunView(z) : null;
      if (z && view) {
        out.set(name, { user: userObject("graph", { name: z.workflowName || null, chatId: z.chatId, childChatId: z.childChatId }), state: view.endedAt === null ? "running" : "ended" });
        continue;
      }
    }
    const copy = copyFromBranch(name);
    if (copy) {
      const alive = Boolean(store.liveStackCopy(String(projectId), copy));
      out.set(name, { user: userObject("copy", { instance: copy }), state: alive ? "running" : "copy-removed" });
      continue;
    }
    out.set(name, { user: null, state: "unknown" });
  }
  return out;
}

/** User and state of ONE branch (the detail, detail.js). */
export const userOf = (projectId, name) => userAndState(projectId, [name]).get(name) || { user: null, state: null };

// The name under which a row stands in the table above: a local branch (and a detached HEAD) by its name, a remote row
// without the remote (`origin/cbase/agent-x` → `cbase/agent-x`) — the way groups.js forms the group.
const tablesName = (z) => (z.local ? z.name : String(z.name).slice(String(z.name).indexOf("/") + 1));

/**
 * `user` and `state` of the rows (groups.js, shape of the contract) following the table above, IN PLACE: group "cbase"
 * via userAndState (ONE query per source for all rows); every other row has no state and a user only if it is checked
 * out in the folder of a copy and not in main (→ `{kind: "copy", instance}`; checked out in main, the row names its
 * chats). → the same rows.
 */
export function withUsers(projectId, rows) {
  const cbaseRows = (rows || []).filter((z) => z.group === "cbase");
  const table = cbaseRows.length ? userAndState(projectId, cbaseRows.map(tablesName)) : new Map();
  for (const z of rows || []) {
    if (z.group === "cbase") {
      const t = table.get(tablesName(z)) || { user: null, state: "unknown" };
      z.user = t.user;
      z.state = t.state;
      continue;
    }
    const out = Array.isArray(z.checkedOut) ? z.checkedOut : [];
    const copy = out.find((e) => e.instance !== "main" && e.worktree === null);
    z.user = copy && !out.some((e) => e.instance === "main") ? userObject("copy", { instance: copy.instance }) : null;
    z.state = null;
  }
  return rows;
}

/**
 * `checkedOut[].chats` of the rows, IN PLACE: the folder of an instance (`worktree: null`) names the chats currently
 * running in this instance (runningChats, asked ONCE per instance), a worktree `null`. Fresh on EVERY response — never
 * from a cache. → the same rows.
 */
export function withChats(projectId, rows) {
  const byKey = new Map();
  for (const z of rows || []) {
    for (const e of Array.isArray(z.checkedOut) ? z.checkedOut : []) {
      if (e.worktree !== null) { e.chats = null; continue; }
      if (!byKey.has(e.instance)) byKey.set(e.instance, runningChats(projectId, e.instance));
      e.chats = byKey.get(e.instance).map((c) => ({ ...c }));
    }
  }
  return rows;
}

/**
 * The chats of the project currently running in this instance → `[{ chatId, title }]` in creation order. `instance` is
 * the seam name (`main` | `<copy>`). Fresh from the run state.
 */
export function runningChats(projectId, instance = "main") {
  const internalName = instanceInternal(instance);
  const live = new Set(liveAgents().map((a) => String(a.chatId)));
  return store.chatsInInstance(String(projectId), internalName)
    .filter((id) => running.has(id) || live.has(String(id)))
    .map((id) => {
      let title = "";
      try { title = String(store.getChat(id)?.title || ""); } catch { title = ""; }
      return { chatId: id, title };
    });
}
