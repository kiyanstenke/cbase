// Read-only: chats of a kind whose agent no longer exists. The registration agent (`kind = 'conflict'`) was dropped together with its
// run kind, prompt and taboo block for converted projects. Its old chats stay in the user DBs — and still carried `claudeSessionId`
// and `bypassPermissions`: a message continued the old CLI session WITHOUT the role prompt that forbade an outdated plan in a
// converted project. Decision: such a chat is only READABLE and DELETABLE — no turn, on any path. The same holds for the kinds of
// the app agents (`context`, `ingest`, `service` and the long-unused `workflow`): the orb dock fell together with the run kinds
// "context"/"ingest", their jobs are Coding chats (projects/coding-jobs.js). Their old chats are in no list any more (no client shows
// them) — the lock keeps one from running on through an old id or a machine delivery (channel, wake call, restart) without its role
// prompt and with `bypassPermissions`.
//
// A leaf with ONE import (i18n.js, itself without imports): the kind list, the predicate and the wording. What hangs on it (the lock
// at every start path):
//   · HTTP: `chats/routes.js chatRoutes` — the same allowlist as the archive's write lock (`archiveAllowed`: read, delete for good,
//     stop, …), everything else 409 with `onlyReadableLock()` — message, question answer, fork, steering, "try now", compact,
//     workflow, also every future subroute.
//   · Machine delivery: `queue.js deliverUserPrompt` (channel, wake call, copy, schedule …) — nothing written, nothing queued;
//     `queue.js takeNextRunInput` empties an inherited queue instead of starting its head.
//   · After the restart: `resume.js resumeInterruptedWork` (active_runs), `auto-continue.js fireAutoContinue` (wait row at the
//     limit — wakeup, sweeper, button), both through `auto-continue.js clearAwayOnlyReadable`.
//   · The catcher for every path without its own check (workflow driver, target gate, server jobs): `do-run.js doRun`, before
//     `running.add`.
// Guard: server/backend/test/registration-legacy-data.test.js. (The Web and iOS twins fell with the dock and drawer: no client shows
// such a chat any more.)

import { T } from "../i18n.js";

// The kinds.
export const ONLY_READABLE_KINDS = Object.freeze(["conflict", "context", "ingest", "service", "workflow"]);

/** Is this chat read-only now? A missing chat is not (it has no kind — the caller checks "gone" itself). */
export const onlyReadable = (chat) => Boolean(chat) && ONLY_READABLE_KINDS.includes(chat.kind);

/** The wording of the 409. */
export const onlyReadableText = () => T(
  "The agent of this chat has been removed — the chat is read-only.",
);

/** The body of the 409: wording and a marker by which a client recognises the lock without reading the text. */
export const onlyReadableLock = () => ({ error: onlyReadableText(), onlyReadable: true });
