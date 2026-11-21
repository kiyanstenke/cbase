// Jobs the server creates as an ordinary coding chat (kind `normal`):
//   · `startServiceChat`  "start service with an agent" (POST /api/projects/:id/services/:sid/start, mode "agent") — a project
//                          chat that brings the service up; the job is its first message, the turn runs at once.
//   · `createImportChat`  files into the dumpster (POST /api/workspaces/:id/context/ingest) — a chat in the workspace (or in the
//                          chosen project); the client uploads the files and sends `job` as the first message with the attachments.
//   · `serviceCwd`         the working directory of a service (also the plain start and projectbox/services.js).
// The role is VISIBLE in the job: a coding chat has no special prompt. Both run with `bypassPermissions` — the job starts
// processes or writes context, and nobody sits in front of it at start to give approvals.
// An unclear drop lands in the workspace dumpster (workspaces/routes.js), like one no project fits.
// Old chats of the removed kinds (`context`, `ingest`, `service`, `workflow`) remain in user DBs, appear in no list and start
// no turn anymore (runs/only-readable.js).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { startRun } from "../runs/do-run.js";

// Working directory of a service: project path + optional subfolder of the service.
function serviceCwd(proj, service) {
  const dir = service.dir ? path.join(proj.path, service.dir) : proj.path;
  return fs.existsSync(dir) ? dir : proj.path;
}

// A job chat: Coding (`normal`), titled (the title names the job — no auto title over it), without approvals.
function jobChat({ workspaceId, projectId = null, title }) {
  const now = Date.now();
  const chat = store.createChat({
    id: crypto.randomUUID(), workspaceId, projectId, title, profile: "default", kind: "normal",
    permissionMode: "bypassPermissions", createdAt: now, updatedAt: now,
  });
  return store.updateChat(chat.id, { titled: 1 }) || chat;
}

/** The job "start service" — the first message of the service chat. */
function serviceJob(proj, service, instructions = "") {
  const extra = String(instructions || "").trim();
  return [
    `Start the service "${service.name}" of the project "${proj.name}". Details:`,
    `- Kind: ${service.kind}${service.tech ? ` (${service.tech})` : ""}`,
    service.container ? `- Docker container: ${service.container} (usually started via docker compose; \`docker ps\` shows whether it is already running)` : null,
    service.port != null ? `- Expected port: ${service.port}` : "- No fixed host port known (Docker services may only be reachable inside the container network).",
    `- Working directory: ${serviceCwd(proj, service)}`,
    service.startCommand ? `- Known start command: ${service.startCommand}` : "- No start command stored — find the right one yourself (read the project files).",
    // The user's start instructions take precedence over the generic steps.
    extra ? `\nStart instructions from the user (follow them WITH PRIORITY):\n${extra}` : null,
    "",
    "Procedure:",
    "1. First check whether the port is already taken (cbase_ports_running) — if the service is already running, report that and do NOT start it twice.",
    "2. Prepare the necessary prerequisites (install dependencies, activate venv/environment, .env) if required.",
    "3. Start the service DETACHED in the background so that it keeps running after your answer: `(nohup <start command> > <log file> 2>&1 &)`. Do NOT use run_in_background of the Bash tool. Docker services run detached anyway (`docker compose up -d <service>`).",
    "4. Wait briefly and verify the start (port is listening or the container is running in `docker ps`).",
    "5. Answer briefly: started yes/no, port, log file path, on failure the relevant log line. Nothing destructive, only this one service.",
  ].filter((l) => l !== null).join("\n");
}

// "Start service with an agent": a coding chat in the project, the job as the first message, the turn starts at once. Via
// startRun, not doRun directly: `doRun` is a promise and this call does not wait — startRun catches a rejection (log +
// transient `run_error` to the chat's stream).
function startServiceChat(proj, service, instructions = "") {
  const chat = jobChat({ workspaceId: proj.workspaceId, projectId: proj.id, title: T`Start service · ${service.name}` });
  const text = serviceJob(proj, service, instructions);
  store.addMessage(chat.id, "user", text);
  startRun(chat, text);
  return chat.id;
}

/** The job "sort files in" — `target` is `{ kind: "workspace" | "auto" }` or `{ kind: "project", project }`. */
function importJob(target, addition = "") {
  const rule = target.kind === "project"
    ? `Target: the project "${target.project.name}" (id ${target.project.id}) — per file cbase_context_dump(projectId=${target.project.id}, text=<extracted content>).`
    : target.kind === "workspace"
      ? "Target: the workspace context (NO project) — per file cbase_workspace_context_add(text=<extracted content>)."
      : "Target: automatic — decide per file by its content which project fits (cbase_projects_list for the ids) and sort it in with cbase_context_dump; if none fits, cbase_workspace_context_add. If the assignment is unclear, ask once briefly before you sort it in.";
  const extra = String(addition || "").trim();
  return [
    "Sort the attached files into the context.",
    "Read EVERY file with the Read tool (text, code, Markdown, JSON, PDF, images, notebooks — everything) and sort in its KNOWLEDGE CONTENT. Summarize each file briefly but completely (no raw dumps of huge files; short texts may largely be taken over).",
    rule,
    extra ? `\nNote from the user:\n${extra}` : null,
    "",
    "Finally summarize in 1–2 sentences what you sorted where.",
  ].filter((l) => l !== null).join("\n");
}

// Files into the dumpster: creates the coding chat (in the chosen project, otherwise in the workspace) and returns the job —
// the client sends the first message itself, AFTER uploading the files to this chat (/api/chats/:id/attachments). `target` as
// at the dumpster: "workspace", "auto" (default) or a project id of this workspace; a foreign or unknown id is `null` (the
// caller answers 400).
function createImportChat(workspaceId, { target = "auto", text = "" } = {}) {
  const t = String(target || "auto");
  let targetItem = { kind: t === "workspace" ? "workspace" : "auto" };
  if (t !== "workspace" && t !== "auto") {
    const project = store.getProject(t);
    if (!project || project.workspaceId !== workspaceId) return null;
    targetItem = { kind: "project", project };
  }
  const chat = jobChat({
    workspaceId, projectId: targetItem.kind === "project" ? targetItem.project.id : null,
    title: T("Sort files into context"),
  });
  return { chatId: chat.id, job: importJob(targetItem, text) };
}

export { serviceJob, importJob, createImportChat, serviceCwd, startServiceChat };
