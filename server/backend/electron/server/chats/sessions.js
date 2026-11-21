// The CLI sessions of a permanently deleted chat: its transcript must not stay in the CLI home of its project, which the
// project container mounts, readable by every process there. Called ONLY from the closing path (chats/erase.js) — every
// delete path goes through there.
//
// The rule: when a chat is deleted permanently, its Claude session (`projects/<slug>/<sid>.jsonl` with `<sid>/`), its Codex
// rollouts and the sessions of its subagents fall in ALL CLI homes (the backend's and the project homes, in the runtime
// folder symlink-safe via the descriptor); a session id that another chat or subagent still carries (fork) stays.
//
// THE SEQUENCE (three points in time on the closing path):
//   1. BEFORE the rows are deleted: the sessions of every falling chat — the carried one (`chats.claude_session_id` —
//      Claude session or Codex thread) AND every previous one (`previous_sessions`: `/clear`, `/compact`, provider switch,
//      … overwrite the column, the transcript before stays on disk; store/subagents.js chatSessions). With a store
//      deletion of the caller (workspace) those of EVERY chat — the store only reports afterwards which fell, and the
//      selection follows its report. Plus the sessions of the outer loop runs on the chat and of its chat-owned outer
//      loop agents (store/outer-loop.js outerLoopSessionsOf) — their rows fall in the row step (deleteOuterLoopChat).
//   2. Per chat in the row step (chats/erase.js), AFTER its cores are closed (a silenced core no longer writes) and
//      BEFORE their records are deleted: the sessions of its subagents (the carried ones and their previous ones, e.g.
//      before a restart without resume), for a worktree agent including the working folder. After that the rows of the
//      previous ones fall with the records.
//   3. After ALL rows: an id that a chat or subagent still carries stays (store.sessionCarried — a fork inherits the
//      session of its original until its first run splits off its own with --fork-session; rolling back a half-created
//      fork would otherwise take the original's history). The rest fall in ALL CLI homes: the backend's
//      (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`, else ~/.claude and ~/.codex) and `home/.claude`, `home/.codex` of EVERY project
//      runtime folder — including a project without an instance row (after a delete without purge the folder stays),
//      since nobody knows where the chat last ran. Per id in both providers (a chat may have switched provider; an id is
//      a UUID and hits nothing foreign). Then the empty slug folder of a worktree agent.
//   The mechanics (id → paths, symlink-safe via the descriptor, root fallback) live in the leaf runs/session-transfer.js;
//   here only WHICH ids fall and WHERE to look.
//
// What does NOT fall here (open): the sessions of the agents of a dynamic workflow (their ids are stored nowhere
// permanently, only in the journal of a parked one), further CLI folders under the id (`file-history/<sid>/`, `todos/`, …)
// and the Codex entry `[projects."…"]` in `~/.codex/config.toml`. And the LEGACY of previous sessions: an id overwritten
// BEFORE the server started with `previous_sessions` and its triggers is recorded nowhere — its transcript stays even
// after the chat is deleted; that cannot be recovered.
// A child process still ending at the moment of deletion (SIGTERM) can append a last line to an already removed session
// file — a race the closing path does not wait out.
//
// Guard: server/backend/test/closePath.test.js.
import path from "node:path";
import * as store from "../store.js";
import { allLocations } from "../runs/runtime-location.js";
import { bClaudeDir, bCodexDir } from "../runs/session-location.js";
import { removeEmptyWorktreeSlug, removeSessionTraces, validSession, sessionTraces } from "../runs/session-transfer.js";

const warnSafe = (warn, w) => { try { warn(w); } catch { /* the warning must not topple the path */ } };

/**
 * Step 1: the sessions of the chats BEFORE their rows fall — `Map<chatId, sid[]>` (carried and previous). `ids` null ⇒
 * every chat (the path with a store deletion of the caller). Never throws (without a readable store no session falls).
 */
export function sessionsBeforeDeletion(ids = null, { warn = console.warn } = {}) {
  let out;
  try { out = store.chatSessions(ids); } catch (e) {
    warnSafe(warn, `[session] sessions of the falling chats not readable (${e?.message || e}) — their transcripts stay`);
    out = new Map();
  }
  // Plus the sessions of the outer loop runs: runs on the chat and runs of its chat-owned agents — their rows fall in the
  // row step (store.deleteOuterLoopChat), their transcripts with the chat.
  try {
    for (const [id, sids] of store.outerLoopSessionsOf(ids)) {
      const list = out.get(id) || [];
      for (const sid of sids) if (!list.includes(sid)) list.push(sid);
      out.set(id, list);
    }
  } catch (e) {
    warnSafe(warn, `[session] sessions of the outer loop runs not readable (${e?.message || e}) — their transcripts stay`);
  }
  return out;
}

/** The collection of the closing path: `Map<sid, { worktrees: Set<cwd> }>`. */
export const newCollection = () => new Map();

function take(collection, sid, worktreeCwd = null) {
  const id = typeof sid === "string" ? sid.trim() : "";
  if (!validSession(id)) return;
  const e = collection.get(id) || { worktrees: new Set() };
  if (worktreeCwd) e.worktrees.add(worktreeCwd);
  collection.set(id, e);
}

/** The sessions of a falling chat (from step 1: a list; a single id works too). */
export const collectChat = (collection, sids) => { for (const sid of [].concat(sids ?? [])) take(collection, sid); };

// The working folder of a subagent that ran in a worktree (providers/agent-runtime.js: `cwd` = `<root>/agent-<aid>`;
// while it exists the record names it under `worktree.dir`, after removal `worktreeRepo` remains) — else null: the slug
// of a shared working folder (the project's) is never touched.
function worktreeCwd(image) {
  const cwd = typeof image?.cwd === "string" && image.cwd ? image.cwd : null;
  if (!cwd) return null;
  const wt = image.worktree && typeof image.worktree === "object" ? image.worktree.dir : null;
  if (typeof wt === "string" && wt && path.resolve(wt) === path.resolve(cwd)) return cwd;
  if (image.worktreeRepo && path.basename(cwd) === `agent-${image.agentId}`) return cwd;
  return null;
}

/**
 * Step 2: the sessions of a chat's subagents — the carried and the previous ones (a previous one of a worktree agent
 * lives in the slug of the same working folder) — BEFORE store.deleteSubagents and store.deletePreviousSessions. Never
 * throws.
 */
export function collectSubagents(collection, chatId, { warn = console.warn } = {}) {
  try {
    const locations = new Map();
    for (const image of store.subagentsOf(chatId)) {
      const wt = worktreeCwd(image);
      locations.set(String(image.agentId), wt);
      take(collection, image.sessionId, wt);
    }
    for (const f of store.previousSubagentSessions(chatId)) take(collection, f.sid, locations.get(f.agentId) || null);
  } catch (e) {
    warnSafe(warn, `[session] subagents of ${chatId} not readable (${e?.message || e}) — their transcripts stay`);
  }
}

/** Every CLI home: the backend's and `home/.claude` / `home/.codex` of every project runtime folder (with or without a row). */
export function cliHomes() {
  const projects = allLocations().map((o) => o.home).filter(Boolean);
  return {
    claude: [bClaudeDir(), ...projects.map((h) => path.join(h, ".claude"))],
    codex: [bCodexDir(), ...projects.map((h) => path.join(h, ".codex"))],
  };
}

/**
 * Step 3: after ALL rows. Carried ids stay, the rest fall in all homes. Never throws.
 * @param {Map<string, { worktrees: Set<string> }>} collection
 * @param {{ rootFallback?: Function, warn?: Function, homes?: { claude: string[], codex: string[] } }} [opts]
 * @returns {{ removed: string[], remained: string[], warnings: string[] }}  `remained`: the ids someone else carries
 */
export function cleanUpSessions(collection, { rootFallback = null, warn = console.warn, homes = null } = {}) {
  const result = { removed: [], remained: [], warnings: [] };
  if (!collection?.size) return result; // no file access without a session
  const report = (w) => { result.warnings.push(w); warnSafe(warn, w); };
  const fallen = [];
  for (const [sid, e] of collection) {
    let supported;
    try { supported = store.sessionCarried(sid); } catch (err) {
      report(`[session] ${sid} stays — cannot read whether someone still carries it (${err?.message || err})`);
      continue;
    }
    if (supported) result.remained.push(sid);
    else fallen.push([sid, e]);
  }
  if (!fallen.length) return result;
  let h;
  try { h = homes || cliHomes(); } catch (err) { report(`[session] CLI homes cannot be determined (${err?.message || err}) — the transcripts stay`); return result; }
  const r = removeSessionTraces(sessionTraces(fallen.map(([sid]) => sid), h), { rootFallback, warn: () => {} });
  result.removed.push(...r.removed);
  for (const w of r.warnings) report(w);
  // Then the empty slug of a worktree agent — only once its sessions are gone.
  for (const [, e] of fallen) {
    for (const cwd of e.worktrees) result.removed.push(...removeEmptyWorktreeSlug(cwd, h.claude, { warn: report }));
  }
  return result;
}
