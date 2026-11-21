// The LFS environment of agent starts. A leaf (only import: the leaf runs/backend-access.js) — `providers/` may import it without
// closing an import cycle (providers/ → runs/ already exists: runs/instance.js, runs/runtime-limit.js).
//
// lfsAgentEnvironment(inst)  the four names with which a git in an agent's shell fetches LFS files (and talks to the remote over
//                         https):
//     CBASE_LFS_URL               `<backendUrl>/api/projects/<projectId>/lfs-access` (projectbox/lfs-access.js) — the backend's
//                                   address from the instance's project network (backendAccessFor, like the MCP configuration);
//     CBASE_LFS_PASS              the instance's token (the same the run's MCP configuration already carries);
//     GIT_LFS_SKIP_SMUDGE=0       the project box sets `ENV GIT_LFS_SKIP_SMUDGE=1` by default — only in the agent shell does
//                                   checkout/pull/clone really fetch (`git lfs pull` fetches even with 1);
//     GIT_LFS_SKIP_DOWNLOAD_ERRORS=1  without access (the helper stays silent) the pointer stays and git ends with 0 — otherwise
//                                   every checkout of a repo with LFS files would fail for a host with no stored access.
//                                   This also holds for a stored but REJECTED access (401): after the first erase the helper
//                                   stays silent for that host (see below "A WRONG ACCESS DOES NOT LOOP"; checkout after 1 s
//                                   exits 0, pointer).
//   The helper itself (server/backend/cbase-lfs-access) is carried by the project box's /etc/gitconfig; it answers only with both
//   CBASE_LFS_* names AND only when git-lfs asks or (git itself over https, by lineage) — the two CBASE_LFS_* are thus the git
//   access of the agent shells (LFS and https); the names stay. WITHOUT instance, address or token an EMPTY object: the caller then
//   changes nothing (golden-runs.test.js byte-equal without re-recording).
//
// withLfsEnvironment(inst, opts)  the options of an `inProject` start with the LFS environment: without LFS THE SAME object (the
//     start is byte-equal to before), otherwise `env` = (opts.env or process.env) plus the four names and `envAlways` extended by the
//     four names (runtime/inProject.js: a name B carries with the same value would otherwise not go along). The VALUES go only through
//     the environment of the docker child, argv gets one `-e NAME` per name — runtime/inProject.js envAllowlist.
//
// WHO GETS IT (the table with a reason per row is held by server/backend/test/in-project-start-places.test.js, column `lfs`): the
// five starts from which an agent calls git — the Claude CLI of a turn (providers/connectors/claude.js, its Bash and hooks inherit
// the environment), Codex (providers/connectors/codex.js: Codex 0.153.1 and 0.162.1 strip no names containing KEY/TOKEN/SECRET), the
// hooks of the loop engine (providers/engine.js), its Bash (providers/tool-runtime.js, foreground and background) and its monitor
// (providers/monitor-runtime.js). NOT: service detection at start (`runOnceClaude`/`runOnceCodex` — no agent shell), the
// administrative git (runtime/git-run.js — own access per host, accessAsEnvironment), stdio MCP servers, services, terminals,
// debuggers, VS Code and browser: there a `git lfs pull` asks the helper without the environment, and it stays silent.
// THE STDIO MCP SERVERS OF THE CLAUDE CLI: the CLI starts every stdio MCP server with ITS environment, extended by the `env` of
// its entry — without a countermeasure the cbase MCP, Playwright and every workspace server would inherit the four names. So
// `lfsLockForStdio(inst, provider)` (only for provider "claude" and only if the run carries the LFS environment) makes
// toolchain/mcp-config.js writeMcpConfig (`lfsLock`) put LFS_STDIO_LOCK over it in the `env` of EVERY stdio entry: both CBASE_LFS_*
// empty (the helper stays silent), GIT_LFS_SKIP_SMUDGE=1 (the project box default) and GIT_LFS_SKIP_DOWNLOAD_ERRORS empty. The other
// `env` entries stay; without the LFS environment the file is byte-equal (golden-runs.test.js without re-recording). cbase starts the
// loop engine's stdio servers itself without the environment (providers/mcp-client.js, column `lfs: false`); Codex does not pass its
// whole environment to its stdio servers — neither needs the lock. Guard: server/backend/test/lfs-access.test.js (f).
//
// RISK: with these names the stored access is readable by the agent (it can call the route itself).
// A WRONG ACCESS DOES NOT LOOP: if the LFS endpoint rejects the stored access (401), the helper reports git-lfs's `erase` as a
// fingerprint to the route, and the route answers every further `get` of that host with `{ access: null }` until another access is
// stored — git-lfs then ends after ONE 401 (with GIT_LFS_SKIP_DOWNLOAD_ERRORS=1 as a pointer) instead of asking without end
// (server/backend/cbase-lfs-access, projectbox/lfs-access.js "THE REJECTION").
import { backendAccessFor } from "./backend-access.js";

export const LFS_NAMES = Object.freeze(["CBASE_LFS_URL", "CBASE_LFS_PASS", "GIT_LFS_SKIP_SMUDGE", "GIT_LFS_SKIP_DOWNLOAD_ERRORS"]);

/** The four names for an agent start in `inst` — `{}` without instance, without address or without token. */
export function lfsAgentEnvironment(inst) {
  if (!inst || !inst.projectId) return {};
  const z = backendAccessFor(inst);
  if (!z.backendUrl || !z.token) return {};
  return {
    CBASE_LFS_URL: `${z.backendUrl.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(String(inst.projectId))}/lfs-access`,
    CBASE_LFS_PASS: z.token,
    GIT_LFS_SKIP_SMUDGE: "0",
    GIT_LFS_SKIP_DOWNLOAD_ERRORS: "1",
  };
}

/** The override in the `env` of every stdio MCP entry of a Claude run with LFS environment (see header "THE STDIO MCP SERVERS"). */
export const LFS_STDIO_LOCK = Object.freeze({ CBASE_LFS_URL: "", CBASE_LFS_PASS: "", GIT_LFS_SKIP_SMUDGE: "1", GIT_LFS_SKIP_DOWNLOAD_ERRORS: "" });

/** Does the MCP configuration of a run of `provider` in `inst` need the lock? Only "claude" with LFS environment. */
export const lfsLockForStdio = (inst, provider) => provider === "claude" && Object.keys(lfsAgentEnvironment(inst)).length > 0;

/** The options of an `inProject` start with the LFS environment — without LFS the same object `opts`. */
export function withLfsEnvironment(inst, opts) {
  const lfs = lfsAgentEnvironment(inst);
  if (!Object.keys(lfs).length) return opts;
  const o = opts || {};
  return { ...o, env: { ...(o.env || process.env), ...lfs }, envAlways: [...new Set([...(o.envAlways || []), ...LFS_NAMES])] };
}
