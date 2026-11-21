// The sandboxing of a oneshot — the ONE version (it used to live in intake/extraction.js, and the title oneshot ran as a full agent:
// 44,000 characters of system prompt and the CLI's tool catalog for a task of 370 characters, with tools in the chat's working
// folder). A leaf: only `app-state.js`.
//
// For derived tasks with FOREIGN text — EVERY `runOnce` outside providers/ except the services scan: Adjust (settings/routes.js),
// retrieval (communication/retrieval.js), title and target verdict (runs/post-run.js), the verdicts of the graph workflows — switch,
// list, completion gate, interpretation of an answer (workflows/driver.js verdictOneshot) — and the wrappers in claude.js: compaction
// (compactConversation), classification of a dump (classifyContext, classifyProjectDump), merging (mergeProjectContext),
// project routing (routeDumpToProject) and the curator (curateContext). Their prompts carry everything they need; none passes a
// `cwd` through any more. NOT sandboxed is only claude.js scanServices: it READS the project (Read/Glob/Grep, `onlyRead`). Guard:
// server/backend/test/oneshot-sandboxing.test.js — every `runOnce(` under electron/server/ (without providers/) carries
// `...sandboxed()`, except a named exception with reason and count. The form it demands: `...sandboxed()` AFTER every spread
// (`{ timeoutMs, ...agentRunFor(k), ...sandboxed(), chatId }` — a spread after it could overwrite `cwd`), no own
// `cwd`/`withoutTools`, and a named options object is not modified after creation.
// Two independent halves, because each alone has holes:
//   · `withoutTools` takes the CLI's default set away. Without it the CLI reads in the working directory and runs Bash (writing and
//     network are off). Claude: `--tools ""` + an empty strict MCP configuration (connectors/claude.js buildClaudeOnceArgs); Codex:
//     CODEX_WITHOUT_FILE_ACCESS (connectors/codex.js buildCodexOnceArgs). The API connector (OpenRouter over the openai-chat wire —
//     the only one) has no tools and no working directory in a oneshot anyway — both halves are meaningless there.
//   · `cwd` on an empty directory. Without it the child process inherits the server's, which in the container is `/home/agent` —
//     where the database with the GitLab tokens and `~/.claude` live. This half also holds for providers that do not know the
//     switch. Created at start (server.js, next to the other DIRS) — before any oneshot.
// The way out would not be the network (that is closed) but the ANSWER: it becomes fact titles, chat titles, a summary every
// following turn gets injected, context entries or a verdict's note — and those afterwards stand in prompts and lists.
// Without set DIRS (no startServer) it THROWS: a missing directory does not mean "inherit the server's".
import { DIRS } from "../app-state.js";

export function sandboxed() {
  if (!DIRS?.empty) throw new Error("sandboxed(): DIRS.empty is not set — no oneshot with foreign text runs without an empty directory");
  return { cwd: DIRS.empty, withoutTools: true };
}
