// Where the CLIs' sessions live and when they move. The mechanics are in the leaf runs/session-transfer.js; here the homes and the
// three callers — the start of a turn (runs/do-run.js, runs/agents.js), the transfer of a project (no route), and the deletion of
// a project (projectbox/erase.js, fetchSessionsOfTheProjectBack).
//
// THE HOMES. B: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` of the backend process, else `~/.claude` / `~/.codex`. A converted project:
// `<runtime>/home/.claude` / `<runtime>/home/.codex` — the same paths project creation hands the project container as environment
// (projectbox/creation.js); since the runtime folder lies at the same path in the container, the backend sees the sessions where
// the CLI writes them. The search covers B and EVERY project home with an instance row (also one in the middle of a transfer),
// because a chat can move between projects (project ↔ no project).
//
// G2. Without an instance of this run AND without any instance row, `sessionForStart` is a no-op without file access: the local
// server and every unconverted operation behave byte-equal to before (golden). With rows somewhere but no instance of this run, the
// target is B — this is how the session of a chat taken out of a converted project comes back.
//
// THE OLD COPY falls only once the first turn at the new location is confirmed (`sessionConfirmed`, same session id in the
// result — a fork gets a new id and therefore never removes its parent chat's session).
import os from "node:os";
import path from "node:path";
import * as store from "../store.js";
import { providerForChat } from "../providers/index.js";
import { T } from "../i18n.js";
import { locationFor } from "./runtime-location.js";
import { removeCopies, pullClaudeSession, pullCodexRollout } from "./session-transfer.js";
import { fetchSessionsBack } from "./session-transfer.js";

const out = (value, fallback) => path.resolve(value ? String(value) : fallback);
/** B's Claude home (CLAUDE_CONFIG_DIR of the backend, else ~/.claude). */
export const bClaudeDir = () => out(process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude"));
/** B's Codex home (CODEX_HOME of the backend, else ~/.codex). */
export const bCodexDir = () => out(process.env.CODEX_HOME, path.join(os.homedir(), ".codex"));

/** A project's CLI home (`<runtime>/home`) — whether or not it is converted yet (the transfer creates it beforehand). */
export const projectCliHome = (projectId) => locationFor({ projectId, converted: true }).home;
export const projectClaudeDir = (projectId) => path.join(projectCliHome(projectId), ".claude");
export const projectCodexDir = (projectId) => path.join(projectCliHome(projectId), ".codex");

// The projects with an instance row — none before initStore (unit tests without a database).
function projectsWithRow() {
  try { return [...new Set(store.projectInstances().map((z) => String(z.projectId)))]; } catch { return []; }
}
/** The Codex homes of all projects with an instance row — the source codexSessionRoots adds (server.js). */
export const projectCodexHomes = () => projectsWithRow().map(projectCodexDir);
const allClaudeDirs = () => [bClaudeDir(), ...projectsWithRow().map(projectClaudeDir)];
const allCodexDirs = () => [bCodexDir(), ...projectCodexHomes()];
/** All homes where session files can lie (B and every project with an instance row) — for the late booking (lateBooking.js). */
export const sessionHomes = () => ({ claude: allClaudeDirs(), codex: allCodexDirs() });

const PROVIDER = new Set(["claude", "codex"]);

/**
 * Before the spawn: the session `sid` afterwards lies in this run's home (`instance` ⇒ the project's, else B's) —
 * Claude in the slug of `cwd`. Returns the move (runs/session-transfer.js) or `null` (nothing to do). Never throws: a
 * failed transfer ends in the retry path without resume, not in an aborted turn.
 * @param {{ sid?: string|null, provider: string, instance?: object|null, cwd: string }} o
 */
export function sessionForStart({ sid, provider, instance = null, cwd }) {
  if (!sid || !PROVIDER.has(provider)) return null;
  const projects = instance ? null : projectsWithRow();
  if (!instance && !projects.length) return null; // G2: no project converted — no file access
  try {
    const turn = provider === "claude"
      ? pullClaudeSession({ sid, destination: instance ? projectClaudeDir(instance.projectId) : bClaudeDir(), cwd, sources: allClaudeDirs() })
      : pullCodexRollout({ threadId: sid, destination: instance ? projectCodexDir(instance.projectId) : bCodexDir(), sources: allCodexDirs() });
    if (turn.status === "copied") console.log(`[session] ${provider} ${sid}: ${turn.source} → ${turn.target}`);
    return turn;
  } catch (e) {
    console.warn(`[session] transfer of ${sid} failed: ${e?.message || e}`);
    return null;
  }
}

/**
 * After a successful turn: remove the old copies — only if the turn continued the same session.
 * Returns how many were removed.
 */
export function sessionConfirmed(turn, sidAfter) {
  if (!turn || !Array.isArray(turn.old) || !turn.old.length) return 0;
  if (turn.status !== "copied" && turn.status !== "present") return 0;
  if (String(sidAfter || "") !== turn.sid) return 0;
  return removeCopies(turn.old);
}

/** The wording of the hint line when a resume in the project container found nothing. */
export const sessionLostText = (sid) =>
  T`Session ${sid || "?"} not found, the chat starts without memory.`;

/**
 * The silent hint after a transfer WITH `<sid>/`: the CLI stores large tool results under
 * `<home>/projects/<slug>/<sid>/tool-results/` and tells the model the absolute path ("Full output saved to: …"). The
 * history afterwards names the OLD folder — B's home is not mounted in the project container, and after the confirmed
 * turn the old copy falls in both directions. "" ⇒ nothing to say (no transfer, no folder).
 */
export function sessionTransferHint(turn) {
  if (turn?.status !== "copied" || !turn.folder?.from || !turn.folder?.destination) return "";
  const row = `- ${turn.folder.from}${path.sep} → ${turn.folder.destination}${path.sep}`;
  return [T("This chat's session moved to another CLI home (project container or back). Absolute paths in the earlier history that start with the old session folder (e.g. \"Full output saved to: …/tool-results/…\") now live under the new one — the old one is not readable here or is removed after this turn:"), row].join("\n");
}

/**
 * The transfer of ONE project (no route): every session of its chats (also the child chats of a graph workflow) and of
 * their subagents into the project's home, Claude in the slug of the NEW working folder. The old copies stay (first
 * confirmed turn, `sessionConfirmed`). The caller names the new working folder per chat (`cwdFor(chat)`), because the
 * project is not converted yet at that point.
 * @param {string} projectId
 * @param {{ cwdFor: (chat: object) => string }} o
 * @returns {Array<{ chatId: string, agentId: string|null, provider: string, status: string, target: string|null, error?: string }>}
 */
export function pullSessionsOfTheProject(projectId, { cwdFor }) {
  const report = [];
  const to = { claude: projectClaudeDir(projectId), codex: projectCodexDir(projectId) };
  const sources = { claude: allClaudeDirs(), codex: allCodexDirs() };
  const pull = (chatId, agentId, provider, sid, cwd) => {
    if (!sid || !PROVIDER.has(provider)) return;
    try {
      const turn = provider === "claude"
        ? pullClaudeSession({ sid, destination: to.claude, cwd, sources: [...sources.claude, to.claude] })
        : pullCodexRollout({ threadId: sid, destination: to.codex, sources: [...sources.codex, to.codex] });
      report.push({ chatId, agentId, provider, status: turn.status, target: turn.target });
    } catch (e) {
      report.push({ chatId, agentId, provider, status: "error", target: null, error: String(e?.message || e) });
    }
  };
  for (const id of store.chatIdsInProject(projectId)) {
    const chat = store.getChat(id);
    if (!chat) continue;
    const cwd = cwdFor(chat);
    pull(chat.id, null, providerForChat(chat), chat.claudeSessionId, cwd);
    for (const a of store.subagentsOf(chat.id)) pull(chat.id, a.agentId, a.provider, a.sessionId, a.cwd || cwd);
  }
  return report;
}

/**
 * The reverse when a project is DELETED (caller projectbox/erase.js, before the removal — with purge before the runtime
 * folder, otherwise before the instance row): every session in the project's CLI home to B. Without the row
 * sessionForStart no longer searches there (projectsWithRow), and the chats survive the deletion (store.deleteProject) —
 * their next turn would begin without memory and without a hint line. Per session id, not per chat
 * (runs/session-transfer.js fetchSessionsBack): this also brings along the chats that left the project without a new turn,
 * and their subagents. The copies in the project stay (they fall with the runtime folder or stay with it).
 * Never throws. Nothing without the project's CLI home.
 * @returns {Array<{ kind: string, sid: string, status: string, target: string|null, error?: string }>}
 */
export function fetchSessionsOfTheProjectBack(projectId) {
  return [
    ...fetchSessionsBack({ kind: "claude", from: projectClaudeDir(projectId), destination: bClaudeDir() }),
    ...fetchSessionsBack({ kind: "codex", from: projectCodexDir(projectId), destination: bCodexDir() }),
  ];
}
