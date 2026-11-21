// A chat's output location: ONE folder per chat holding what the chat's agents still have to READ after their end — the output
// file named by a subagent's completion notice (`outputFile`) and the script files of dynamic workflows (`scriptPath`, resume).
//
//   <data>/outputs/<chatId>/             the location (local: the server's data folder; container: /home/agent/cbase/data,
//                                        in the home volume — survives restarts and container swaps)
//   <data>/outputs/<chatId>/agents/      <agentId>.output per subagent (providers/agent-runtime.js: writeOutputFile)
//   <data>/outputs/<chatId>/workflows/   script files of dynamic workflows (created by the builder)
//   <data>/outputs/<chatId>/monitors/    <taskId>.log per monitor (runs/monitors.js) — the whole output, capped
//
// Why not a scratch area: it was in NO run among the readable directories — the file the notice names was unreadable for the
// agent it went to. This location goes as `addDirs` into EVERY run of the chat (do-run.js: Claude `--add-dir`, Codex `--add-dir`,
// loop-engine sandbox root; subagents inherit the same list).
//
// Lifetime: until the chat is deleted. Cleanup at agent end does NOT touch it; only the close path removes it (chats/erase.js:
// tidyUp). Continuation and resume read it.
//
// If the chat's project is converted, the location lies in the project's runtime folder (`<data>/projects/<projectId>/outputs/<chatId>/`),
// otherwise flat — the switch is runs/runtime-location.js. Whoever needs a fixed location (a core that remembers its location at
// open) passes it as the second argument.
//
// A leaf: imports only node:*, runs/runtime-location.js and runs/runtime-write.js.
//
// In a project's runtime folder `createOutputLocation` creates the location through the descriptor (runs/runtime-write.js): the
// project container mounts it rw, and a link `outputs → /somewhere` would let `mkdirSync` create the chat's folder in B — and
// every writer afterwards (a subagent's output file, script and result of a dynamic workflow) write there. If the location leads
// out, it is NOT created (reported, not thrown: the run goes on, the writers refuse there individually).
import fs from "node:fs";
import path from "node:path";
import { outputFile, outputLocationIn, locationForChat } from "./runtime-location.js";
import { createFolderInRuntimeFolder } from "./runtime-write.js";

const WORKFLOWS = "workflows";

/** The location per chat (at the chat's current location, or at the one passed in). */
export const outputLocation = (chatId, location = locationForChat(chatId)) => outputLocationIn(location, chatId);
/** The output files of the chat's subagents. */
export const agentOutputs = (chatId, location) => path.join(outputLocation(chatId, location), "agents");
/** The script files of the chat's dynamic workflows. */
export const workflowScripts = (chatId, location) => path.join(outputLocation(chatId, location), WORKFLOWS);
/**
 * A file among the script files (`rel` relative to `workflows/`) for READING — falling back to the old location after a
 * project change, as long as the chat's files have not moved yet (runs/runtime-location.js outputFile).
 * Without another location `path.join(workflowScripts(chatId), rel)`.
 */
export const workflowFileToRead = (chatId, rel) => outputFile(chatId, path.join(WORKFLOWS, rel));

/**
 * The fixed paragraph in the system prompt of a Coding chat's main run: where reports and screenshots for the human belong and where
 * he sees them. Fixed per chat — the path changes only with the project (like the project focus), so it costs the cache nothing.
 * The path is THE SAME the run gets as `--add-dir` (do-run.js runAddDirs: `createOutputLocation(chat.id, location)` at the turn's
 * location) — description = execution. Browser captures are shown by the turn end by itself (chats/captures-show.js).
 */
export const outputsSentence = (filePath) => "# Outputs\n"
  + `Reports, screenshots and other files the human should see go into this chat's output location: \`${filePath}\` (subfolders such as \`screens/\` are fine). `
  + "The human sees this folder in cbase under Artifacts → Outputs — images and Markdown directly, everything else for download —, "
  + "and he can click an absolute path to it in your reply. When you give a subagent a task that produces reports or "
  + `screenshots, you name this location in the assignment. cbase manages the subfolders \`agents/\`, \`${WORKFLOWS}/\` and \`monitors/\` itself — you put nothing there. `
  + "You show the human a screenshot or a video from your browser with cbase_screenshot or cbase_recording_start/_stop: "
  + "cbase attaches them as a card to the chat at the end of your turn. browser_take_screenshot serves only your own checking.";

/**
 * Create the location and return it. BEFORE the first run: a directory that only comes into being when the first agent
 * writes would be missing from the readable ones in exactly the first run (same pattern as the attachments, which are
 * only added when they exist).
 */
export function createOutputLocation(chatId, location) {
  const dir = outputLocation(chatId, location);
  try {
    if (!createFolderInRuntimeFolder(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e?.code !== "EOUTSIDE") throw e;
    console.warn(`[outputs] ${dir} not created — the path leads out of the runtime folder: ${e.message}`);
  }
  return dir;
}
