// The kind "manager" is read-only — permanently. Only a store from before the removal of Managing can carry such a chat. The run
// kind is gone: a manager chat would otherwise run through `runKindDefault` with `bypassPermissions` and the full catalog
// (runs/hooks.js).
//
// A leaf after the pattern of `only-readable.js`: reads only `chat.kind`, imports only i18n.js. The list is NOT
// `ONLY_READABLE_KINDS`: that one is bound to Web and iOS (registration-legacy-data), and a manager chat is locked more strictly
// than a read-only one (also archive, restore, delete, PATCH, fork).
//
// What hangs on it (guard server/backend/test/manager-lock.test.js, every path with a counter-test on a Coding chat):
//   · Turns, the five start paths and the catcher: `chats/routes.js chatRoutes` (only GET and the emergency valves `managerAllowed`),
//     `queue.js deliverUserPrompt` and `takeNextRunInput`, `resume.js resumeInterruptedWork` (also the wait row and the workflow
//     run: nothing touched), `auto-continue.js fireAutoContinueInner`, `do-run.js doRun`. Plus the restart of the runs outside doRun:
//     `dynworkflows/run.js dynWorkflowsRestartGrace` gives up a dynamic workflow, `workflows/graph-start.js` redeem discards a graph
//     start — instead of continuing. `runs/agents.js reportOrphaned` lets a manager chat's subagent STAND (not resumed, not orphaned,
//     no hint).
//   · Archive and auto-archive (`store/chats.js` takes only `kind = 'normal'`), the start migrations that write chats
//     (`account/model-migration.js`, `chats/auto-gone.js`), the kind's folders (`chats/routes.js chatFolderRoutes`).
//   · The frozen channels: `channels/freeze.js` and its readers.
//   · The managing skills (`toolchain/routes.js`, `toolchain/skill-routes.js`).

import { T } from "../i18n.js";

/** Is this chat locked (kind manager)? A missing chat is not — the caller checks "gone" itself. */
export const managerLocked = (chat) => Boolean(chat) && chat.kind === "manager";

/** The wording — managing has been removed, the chat stays readable. */
export const managerLockText = () => T(
  "Managing has been removed — this chat is read-only.",
);

/** The body of the 409: wording and a marker by which a client recognises the lock without reading the text. */
export const managerLock = () => ({ error: managerLockText(), managerLocked: true });

/**
 * What a manager chat still accepts over HTTP: every GET (history, stream, artifacts) and the emergency valves that write nothing
 * and start nothing — stop of the run, of a dynamic workflow, of a graph workflow. NOT archive, restore, delete, PATCH, fork, a
 * message, a question answer — and no future subroute.
 */
export function managerAllowed(sub, m) {
  if (m === "GET") return true;
  if (m !== "POST") return false;
  return sub === "/stop" || /^\/dyn-workflows\/runs\/[^/]+\/stop$/.test(sub) || /^\/graph-workflows\/[^/]+\/stop$/.test(sub);
}
