// Test fixture shared by gates-workflows.test.mjs (public) and the maintainer's private suite: command lines of provider starts
// as `ps`/`pgrep` show them, built from the REAL argument builders of the connectors.
import { buildClaudeChatArgs, buildClaudeOnceArgs } from "../../../server/backend/electron/server/providers/connectors/claude.js";
import { buildCodexChatArgs, buildCodexOnceArgs } from "../../../server/backend/electron/server/providers/connectors/codex.js";

// The process list the gate reads in a container (lib/gates.mjs PROCESS_LIST; the maintainer's private suite holds the two equal).
export const PROCESS_LIST = "ps -ww -eo pid=,args=";

// Command lines in the form `ps -o command=` (local) or `pgrep -af` (container) shows.
export const SCRATCH = "/home/agent/.cbase/data/scratch";
export const claudeSub = `/usr/local/bin/claude -p --output-format stream-json --input-format stream-json --mcp-config ${SCRATCH}/c1.agent-a1b2c3d4-1.mcp.json --strict-mcp-config`;
export const claudeWf = `/usr/local/bin/claude -p --output-format stream-json --input-format stream-json --mcp-config ${SCRATCH}/c1.agent-a9f8e7d6-2.workflow.mcp.json --strict-mcp-config`;
export const codexSub = `codex exec --json --skip-git-repo-check -c mcp_servers.cbase.env.CBASE_AGENT_DEPTH="1" -c mcp_servers.cbase.env.CBASE_CHAT_ID="c1" Read the file`;
export const codexWf = `codex exec --json --skip-git-repo-check -c mcp_servers.cbase.env.CBASE_AGENT_DEPTH="1" -c mcp_servers.cbase.env.CBASE_WORKFLOW_AGENT="a9f8e7d6-2" Read the file`;

// ── Wrapper lines of the project containers ─────────────────────────────────────────────────────────────────────────
export const PROJ = "/home/agent/.cbase/data/projects/p1";
export const claudeWfBox = `claude -p --output-format stream-json --input-format stream-json --mcp-config ${PROJ}/scratch/c1.agent-7.workflow.mcp.json --strict-mcp-config`;
export const claudeSubBox = `claude -p --output-format stream-json --input-format stream-json --mcp-config ${PROJ}/scratch/c1.agent-8.mcp.json --strict-mcp-config`;
export const wrapper = (inner, id = "u1") =>
  `docker exec -i -u agent -w /home/agent/ws/checkout -e CLAUDE_CODE_DISABLE_AUTO_MEMORY cbase-p-p1 /usr/sbin/cbase-wrapper --pgid-file ${PROJ}/processes/${id}.pgid -- ${inner}`;


// How `ps -o args` shows an argv: joined with spaces, control characters as `?`.
export const psRow = (argv) => argv.map((a) => String(a ?? "").replace(/[\x00-\x1f\x7f]/g, "?")).join(" ");
export const REAL = {
  claudeOnce: ["claude", ...buildClaudeOnceArgs({ model: "claude-haiku-4-5" })],
  claudeMaterial: ["claude", ...buildClaudeOnceArgs({ material: true })],
  claudeChat: ["claude", ...buildClaudeChatArgs({ systemPrompt: "You are cbase.\nRules:\n- brief", addDirs: ["/home/agent/ws"], permissionMode: "bypassPermissions", mcpConfigPath: `${SCRATCH}/c1.mcp.json`, allowedTools: [], model: "claude-opus-5-5" })],
  codexOnce: ["codex", ...buildCodexOnceArgs({ prompt: "Classify it", outFile: "/tmp/o.txt" })],
  codexChat: ["codex", ...buildCodexChatArgs({ permissionMode: "bypassPermissions", cwd: "/home/agent/ws", addDirs: [], model: "gpt-5.6-sol" })],
};
export const LIST = [
  [1, ["/usr/bin/tini", "--", "/usr/local/bin/entry.sh"]],
  [20, ["node", "/app/headless.js"]],
  [812, REAL.claudeOnce],
  [813, REAL.claudeMaterial],
  [814, REAL.claudeChat],
  [815, REAL.codexOnce],
  [816, REAL.codexChat],
  // A oneshot in the project container whose inner line B does not see: the wrapper stands for it.
  [817, ["docker", "exec", "-i", "-u", "agent", "cbase-p-p1", "/usr/sbin/cbase-wrapper", "--pgid-file", `${PROJ}/processes/u9.pgid`, "--", "claude", ...buildClaudeOnceArgs({ model: "claude-sonnet-4-5" })]],
  [900, ["sh", "-c", PROCESS_LIST]],
  [901, ["ps", "-ww", "-eo", "pid=,args="]],
].map(([pid, argv]) => `${String(pid).padStart(5)} ${psRow(argv)}`).join("\n") + "\n";

