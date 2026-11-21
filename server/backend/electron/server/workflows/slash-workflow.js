// `/workflow:<shortname>` at the message route.
//
// Called by `runs/routes.js:messageChatRoutes`, after the attachments and before the title: that is, for what a human
// typed — channel, schedule, event and completion notice go through deliverUserPrompt and never carry an announcement.
// The SECOND named caller is the occurrence of a scheduled job (scheduled/run.js startRun): its instructions were
// written by the human; it builds the prompt with `announcementText(hits, occurrence message)` and retries only the
// 409 `open` refusal.
//
// graphSlash(chat, { text, attachments })   without a mention `null` (the route continues as before). With a mention
//                                        the first applicable refusal — `{ status, body: { error, reason } }`: 400
//                                        `kind` (not a coding chat), 404 `foreign` (only in the workspace-wide list),
//                                        404 `name` (otherwise unknown), 400 `tooMany`, 409 `open` (a workflow is open
//                                        or earmarked) — or `{ prompt, announcement, title, hits }` (hits = the named
//                                        workflows, for a custom prompt via announcementText). A refusal stores
//                                        nothing, assigns no title and starts no run: nothing reaches the CLI.
// announcementText(hits, text)           the prompt the MODEL reads for the message; the bubble shows the typed line.
//                                        The route appends the attachment lines as for any message.
//
// NOTHING is started here: the announcement travels with the input, the model earmarks via cbase_workflow_start (which
// checks once more when its turn comes), and the end of the turn starts. Two mentions yield ONE announcement with two
// entries; the same one twice counts once; comparison is lowercase (WORKFLOW_MENTION). A mention in a quote line
// ("> …") never counts (shortName.js:mentions) — neither as an announcement nor as a refusal.

import crypto from "node:crypto";
import * as wf from "../workflows.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { runKindFor } from "../runs/hooks.js";
import { withShortNames, mentions } from "./shortName.js";
import { effectiveSet } from "./graph-start.js";

// The computation lives in the leaf `shortName.js` (quote lines "> …" never count as a mention); re-exported here
// because tests and readers know it under this name.
export { mentions };

// How much of the first step's text goes into the prompt — enough to know what the workflow does first.
const STEP_TEXT_MAX = 400;
// The caps of the announcement shape (runs/human-input.js announcementForm): at most 20 workflows, at most 50
// attachments. An announcement beyond them would be dropped there ENTIRELY — the model would get the job and the tool
// would say "not announced".
const ANNOUNCEMENT_WORKFLOWS_MAX = 20;
const ANNOUNCEMENT_ATTACHMENTS_MAX = 50;

const errorText = (status, reason, error) => ({ status, body: { error, reason } });
// One line of the list: line breaks and whitespace runs become one space.
const singleLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clipped = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// The first step: the target of the first edge out of the start node. Without start node or edge `null` (the sentence is dropped).
function firstStep(flow) {
  const g = wf.normalizeGraph(flow.graph);
  const start = g.nodes.find((n) => n.type === "start");
  const edge = start && g.edges.find((e) => e.from === start.id);
  return (edge && g.nodes.find((n) => n.id === edge.to)) || null;
}

function workflowRow(flow) {
  const description = singleLine(flow.description).replace(/[.。]+$/, "") || "no description";
  const step = firstStep(flow);
  const title = step ? singleLine(step.title) : "";
  const job = step ? clipped(singleLine(step.text), STEP_TEXT_MAX) : "";
  const set = step && (title || job)
    ? ` First step: ${[title ? `"${title}"` : "", job].filter(Boolean).join(": ")}`
    : "";
  return `- "${flow.name}" (workflow: ${flow.shortName}) — ${description}.${set}`;
}

/** The prompt for the model: which workflows are named, the message, and what to do with them. */
export function announcementText(hits, text) {
  return [
    "[cbase: The human starts these graph workflows with /workflow:]",
    ...hits.map(workflowRow),
    "[Their message]",
    String(text ?? ""),
    "Start every named workflow with cbase_workflow_start (workflow = short name). You phrase input yourself: the text after the name, supplemented by what the workflow needs from this conversation — read at most what you really need for that. Foreground, unless the human says \"in the background\"; worktree only if they say so or if you start several runs on the same project. Then end your turn with ONE line. If you do not start, say why in one line.",
  ].join("\n");
}

/**
 * @param {Object} chat
 * @param {{ text: string, attachments?: string[] }} input  attachments = absolute paths of this message's attachments
 * @returns {null | { status: number, body: { error: string, reason: string } } | { prompt: string, announcement: Object, title: string, hits: Object[] }}
 */
export function graphSlash(chat, { text, attachments = [] } = {}) {
  const named = mentions(text);
  if (!named.length) return null;
  // Only in a coding chat — otherwise the CLI would swallow the line, and there is no start path there.
  if (chat.kind !== "normal" || runKindFor(chat)) {
    return errorText(400, "kind", T("/workflow: is only available in a coding chat — nothing was sent."));
  }
  const set = effectiveSet(chat);
  const afterShort = new Map(set.map((w) => [w.shortName, w]));
  const hits = [];
  for (const k of named) {
    const flow = afterShort.get(k);
    if (flow) { if (!hits.includes(flow)) hits.push(flow); continue; }
    // The workspace-wide list in its OWN computation: there the same workflow may carry a different suffix, and a
    // name that exists only there belongs to another project (or is not adopted here).
    const far = chat.workspaceId ? withShortNames(store.effectiveWorkflows(chat.workspaceId, null)) : [];
    if (far.some((w) => w.shortName === k)) {
      return errorText(404, "foreign", T`"/workflow:${k}" does not belong to this chat (another project, or not adopted here) — nothing was sent.`);
    }
    return errorText(404, "name", T`There is no workflow "/workflow:${k}" in this chat — nothing was sent.`);
  }
  if (hits.length > ANNOUNCEMENT_WORKFLOWS_MAX) {
    return errorText(400, "tooMany", T`At most ${ANNOUNCEMENT_WORKFLOWS_MAX} workflows per message — nothing was sent.`);
  }
  // In the foreground at most ONE workflow is open per chat: an open run (a waiting one too — a message with a
  // mention is not an answer then) or an earmarked/waiting start.
  const openRun = store.getWorkflowRun(chat.id);
  const openStart = store.workflowOpen(openRun) ? null : store.openForegroundStart(chat.id);
  if (store.workflowOpen(openRun) || openStart) {
    const name = store.workflowOpen(openRun) ? openRun.workflowName : openStart.workflowName;
    return errorText(409, "open", T`A workflow is already open in this chat ("${name}") — finish or cancel it first. Nothing was sent.`);
  }
  const announcement = {
    id: crypto.randomUUID(),
    workflows: hits.map((w) => ({ workflowId: w.id, shortName: w.shortName, name: w.name })),
    // More than 50 attachments: the first 50 go to the workflow (the message itself carries all of them, the model sees them).
    attachments: (Array.isArray(attachments) ? attachments : []).filter((p) => typeof p === "string" && p).slice(0, ANNOUNCEMENT_ATTACHMENTS_MAX),
  };
  return { prompt: announcementText(hits, text), announcement, title: hits[0].name, hits };
}
