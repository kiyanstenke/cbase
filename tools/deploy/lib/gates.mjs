// The gates before every destructive step.
//
// They map failures that really happened:
//  · /api/runs/active covers ONLY chats — running project services not.
//  · Background oneshots (compact, title, classification) show up in `pgrep -P` with a misleading `comm`; only the full
//    command line shows them.
//  · The pattern `pgrep -af "claude [-]-|…"` in the container hit not a single start of cbase (`claude -p …`) — since then
//    lib/processes.mjs decides over the whole process list.
//  · An answer that is none (error body, deadline, 500) is "unknown", never "free" — likewise a process list in the
//    container that could not be read (`processesFrom`).
import { config } from "../config.mjs";
import { sshProbe } from "./ssh.mjs";
import * as log from "../../check/lib/log.mjs";
import { mask, providerRows, partsProcesses } from "../../check/lib/processes.mjs";
import { PROBE_LABEL } from "./projectbox-distribution.mjs";
// The ONE list of label keys that cbase sets itself (a leaf without imports in the backend).
import { ownKey, labelsFromSegments } from "../../../server/backend/electron/server/projectbox/own-labels.js";
import { projectContainerRow, projectRetrievalRow, projectOf, partsInner } from "./project-container.mjs";
import { projectErrorSet, projectErrorCount, projectStoppedAttachment, projectStoppedAddition } from "./project-container.mjs"; // error count, stopped instances
import { isRunsResponse, remoteOpsStatus, remoteRuns } from "./remote.mjs"; // ONE reading of /api/runs/active in B (restoreInner asks for it as well)
import { composeInBRow } from "./project-container.mjs";
import { copyWorkWord } from "./capabilities.mjs"; // the word for the work of a copy (also in the status row "Copies")
export { remoteRuns };

// The number of running oneshots that the BACKEND counts itself (`open.oneshots` of /api/runs/active: title, classification,
// extraction, verdicts, curator, compaction — across all providers, also the loop engine, which has no process of its own and
// therefore appears in no process list). null = the backend does not say (older, or no answer).
export function backendOneshots(runs) {
  const n = runs?.open?.oneshots;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Waiting approvals: a run that stands at a card counts as running and holds the gate — but it ends only when someone
// decides. So the gate should SAY where it waits instead of waiting silently. The backend reports EVERY waiting card
// (airlock, rights question).
export function approvalsText(runs) {
  const f = Array.isArray(runs?.approvals) ? runs.approvals : [];
  if (!f.length) return "";
  return ` — waiting for approval: ${f.map((x) => `${x.title || x.chatId} (${x.toolName})`).join(", ")}`;
}

// The sentence in the abort text of the gate: EVERY waiting card with the chat it stands in. Without title the id.
export function approvalsSentence(approvals) {
  const f = Array.isArray(approvals) ? approvals : [];
  if (!f.length) return "";
  return ` A run is waiting for an approval — decide in chat ${f.map((x) => `"${x.title || x.chatId}"`).join(", ")}, then start again.`;
}

// Living background agents: a subagent can outlive its turn and has no journal — a swap would lose its work. The backend
// therefore counts it in `busy` and names it in the field `agents` of /api/runs/active. Here its OWN row (number, chat),
// on the pattern of the approvals: the gate waits for them, and whoever gives `--force` takes them along — that must be
// stated, otherwise someone swaps blind. A backend WITHOUT the field says nothing about its agents: then "unknown", not
// "none".
export function backgroundAgentsRow(runs) {
  if (!runs) return ["Background agents", "—", null];
  if (!Array.isArray(runs.agents)) return ["Background agents", "unknown (backend without field `agents`)", "warn"];
  const a = runs.agents;
  if (!a.length) return ["Background agents", "none", "ok"];
  const perChat = new Map();
  for (const x of a) {
    const name = x.title || x.chatId || "?";
    perChat.set(name, (perChat.get(name) || 0) + 1);
  }
  const where = [...perChat].map(([name, n]) => (n > 1 ? `${name} (${n})` : name)).join(", ");
  return [
    "Background agents",
    `${a.length} in ${where} — the gate waits for them; \`--force\` takes them along (their work is lost)`,
    "bad",
  ];
}

// Living monitors: a monitor (cbase_monitor) belongs to the chat, outlives its turn and has no journal. A monitor with a time limit
// counts in `busy` — the gate waits for it, a swap ends it (the restart leaves a note in the chat); a PERSISTENT one (a watch, e.g. on
// a WebSocket, open for days) does not: the backend starts it again after the swap (same id, same log; what it would have seen
// during the swap is lost). The field `monitors` names both; the row says on WHOM is waited and which ones the swap interrupts. A
// backend without the field (older) says nothing — then "unknown".
// Guard: gates-background.test.mjs.
export function monitorRow(runs) {
  if (!runs) return ["Monitors", "—", null];
  if (!Array.isArray(runs.monitors)) return ["Monitors", "unknown (backend without field `monitors`)", "warn"];
  const m = runs.monitors;
  if (!m.length) return ["Monitors", "none", "ok"];
  const name = (x) => `${x.name || x.taskId || "?"} in ${x.title || x.chatId || "?"}${x.report ? ` (${x.report})` : ""}`;
  const holding = m.filter((x) => !x.persistent);
  const lasting = m.filter((x) => x.persistent);
  const parts = [];
  if (holding.length) parts.push(`${holding.length}: ${holding.map(name).join(", ")} — the gate waits for them; \`--force\` ends them (the chat gets a note)`);
  if (lasting.length) parts.push(`${lasting.length} persistent: ${lasting.map(name).join(", ")} — the swap interrupts them, they start again after it`);
  return ["Monitors", parts.join(" · "), holding.length ? "bad" : "warn"];
}

// Running outer-loop runs: a run is a core of its own without a journal — the backend counts it in `busy` and names it in the
// field `outerLoop` of /api/runs/active (agent, observed chat, start). The row says on WHOM the gate waits and what `--force`
// costs: the run aborts (the next start sets it to "aborted"), the next trigger catches up. Nothing empty means "nothing
// runs": without backend or without the field "unknown".
export function outerLoopRow(runs) {
  const label = "Outer Loop";
  if (!runs) return [label, "unknown (backend unreachable)", "warn"];
  if (!Array.isArray(runs.outerLoop)) return [label, "unknown (backend without field `outerLoop`)", "warn"];
  const o = runs.outerLoop;
  if (!o.length) return [label, "none", "ok"];
  const perRun = o.map((x) => `${x?.title || x?.chatId || "?"} (${x?.agentName || x?.agentId || "?"})`);
  return [
    label,
    `${o.length} running in ${perRun.join(", ")} — the gate waits; \`--force\` aborts them (marked "aborted" at the next start, the next trigger catches up)`,
    "bad",
  ];
}

// Running dynamic workflows: they NO LONGER count in `busy` — a run has a journal, and the restart resumes it after the swap.
// The deploy therefore does not wait for them, it SHOWS them: number, per run chat, name and state (latest phase,
// finished/started agent() calls). The price is stated too: agents that were in the middle of the run start anew. Nothing
// empty means "nothing runs": an unreachable backend and a backend without the field are "unknown", never "none". An older
// backend carries the field without `progress` and still counts the runs in `busy` — the row says so then.
export function dynWorkflowRow(runs, now = Date.now()) {
  const label = "Dynamic workflows";
  if (!runs) return [label, "unknown (backend unreachable)", "warn"];
  if (!Array.isArray(runs.dynWorkflows)) return [label, "unknown (backend without field `dynWorkflows`)", "warn"];
  const w = runs.dynWorkflows;
  if (!w.length) return [label, "none", "ok"];
  const alt = w.some((x) => !x || typeof x.progress !== "object" || x.progress === null);
  const perRun = w.map((x) => {
    const st = x?.progress && typeof x.progress === "object" ? x.progress : null;
    const parts = [x?.title || x?.chatId || "?", x?.name || "?"];
    if (!st) parts.push("progress unknown");
    else {
      if (st.phase) parts.push(`phase "${st.phase}"`);
      parts.push(`${Number(st.finished) || 0}/${Number(st.agents) || 0} agents finished`);
    }
    if (Number.isFinite(x?.startedAt) && x.startedAt > 0) parts.push(`for ${Math.max(0, Math.round((now - x.startedAt) / 60000))} min`);
    return parts.join(" · ");
  });
  return [
    label,
    `${w.length} running: ${perRun.join("; ")} — ` + (alt
      ? "old backend: they still count in busy, the gate waits for them"
      : "the deploy does NOT wait; the restart resumes them after the swap (running agents start anew, their tokens are spent twice)"),
    "warn",
  ];
}

// Project instances in progress: creation, start, recreation and relocation of a project container are unsecured steps — the
// backend counts them in `busy` and names them in the field `projectWork` of /api/runs/active (only ids, state, phase, since
// when). Here their OWN row, on the pattern of the background agents: the gate waits for them, and whoever gives `--force`
// aborts the step in the middle — that must be stated. Nothing empty means "nothing runs": an unreachable backend and a
// backend without the field are "unknown", never "none".
// "All ready" only without an instance in progress AND without an instance in `error` (`projectError`, a number —
// lib/project-container.mjs projectErrorCount); otherwise the number. `error` does not hold the gate (warn, not bad).
export function projectWorkRow(runs, now = Date.now()) {
  const label = "Project instances";
  if (!runs) return [label, "unknown (backend unreachable)", "warn"];
  if (!Array.isArray(runs.projectWork)) return [label, "unknown (backend without field `projectWork`)", "warn"];
  const p = runs.projectWork;
  const f = projectErrorCount(runs);
  if (!p.length) {
    // Stopped instances are calm — they are only added (project-container.mjs projectStoppedAddition).
    if (f === 0) return [label, `none in progress, all ready${projectStoppedAddition(runs)}`, "ok"];
    if (f === null) return [label, `none in progress${projectStoppedAddition(runs)} — whether one is in \`error\`, this backend does not say (without field \`projectError\`)`, "warn"];
    return [label, `none in progress, ${projectErrorSet(f)}${projectStoppedAddition(runs)}`, "warn"];
  }
  const perInstance = p.map((x) => {
    // An instance `copy-*` is a copy of the stacks — its `create` is the whole build-up, `clearAway` the clearing,
    // `heavyLoad` the volume clone; without the word a build-up would look like a hanging creation.
    const copy = String(x?.instance || "").startsWith("copy-");
    const parts = [`${copy ? "copy " : ""}${x?.projectId || "?"}/${x?.instance || "?"}`, copy ? copyWorkWord(x?.state) : x?.state || "?"];
    if (x?.phase) parts.push(`phase "${x.phase}"`);
    if (Number.isFinite(x?.since) && x.since > 0) parts.push(`for ${Math.max(0, Math.round((now - x.since) / 60000))} min`);
    return parts.join(" · ");
  });
  return [
    label,
    `${p.length} in progress: ${perInstance.join("; ")}${f ? `; plus ${projectErrorSet(f)}` : ""}${projectStoppedAttachment(runs)} — the gate waits for them; \`--force\` aborts the step midway`,
    "bad",
  ];
}

// ---------------------------------------------------------------- Server ---
//
// There are only these gates: the local ones (localGate, waitLocalIdle, restoreLocalServices) belonged to the standalone
// app, which no longer exists.

// ALL user containers. A second container (second user or environment) once ran on the server, and because `head -1` stood
// here, gate and status saw only the FIRST. `./deploy status` reported "active runs runs=0" while in the other container a
// workflow was computing at step 5 of 18 — a `deploy server` would have torn it down without warning (the gateway recreates
// containers from `:latest` at any time).
export async function remoteContainers() {
  const r = await sshProbe(
    `docker ps --filter name=${config.remote.containerPrefix} --format '{{.Names}}'`,
  );
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

// Busy state PER container: runs from the backend plus running provider processes.
export async function remoteBusy() {
  const names = await remoteContainers();
  const rows = [];
  for (const name of names) rows.push(await remoteBusyOf(name));
  return rows;
}

/** The idle row of ONE user container (the same as in remoteBusy; idleBeforeSwap asks for it anew per swap). */
export async function remoteBusyOf(name) {
  const runs = await remoteRuns(name);
  const { holds: one, workflow, unknown: processesUnknown } = await remoteProcesses(name);
  const backendCount = backendOneshots(runs); // also the oneshots without a process of their own (loop engine)
  return {
    name, runs, oneshots: one, workflowAgents: workflow, oneshotsBackend: backendCount, processesUnknown: processesUnknown || null,
    // Unreachable (or no answer of this route) counts as busy: better wait than swap blind. Likewise a process list that
    // could not be read — whether a oneshot runs is then unknown.
    busy: !runs || Boolean(runs.busy) || Boolean(runs.runs) || one.length > 0 || backendCount > 0 || Boolean(processesUnknown),
  };
}

// An unreadable process list is named in every row that says why a B is busy.
const processesText = (r) => (r?.processesUnknown ? ` process list unknown (${r.processesUnknown})` : "");
const busyText = (r) => `runs=${r.runs?.runs ?? "?"} agents=${r.runs?.agents?.length ?? "?"} outerLoop=${r.runs?.outerLoop?.length ?? "?"} projects=${r.runs?.projectWork?.length ?? "?"}${r.oneshots?.length ? ` oneshots=${r.oneshots.length}` : ""}${r.oneshotsBackend ? ` oneshots(Backend)=${r.oneshotsBackend}` : ""}${processesText(r)}${r.runs ? "" : " — unreachable"}`;

// remoteGate measures ONCE for all, swapping then happens one after the other — between the swap of the first (with
// waitHealthy and restoreInner, minutes) and that of the second, a turn, an agent, a relocation or a setup may have begun in
// the second. So before EVERY swap the idle state of this one container anew, with the same rules as the gate: `--wait`
// waits (at most that long), `--force` swaps anyway (with a warning), otherwise the container is NOT swapped (`swap: false`,
// the run ends red and names it) — never a half swap under load. Only this one container: one just swapped may already work
// again (auto-resume) and must not hold the next. Seams for the guard (the maintainer's private suite): `busyOf`,
// `sleep`, `now`.
export async function idleBeforeSwap(name, { force = false, wait = 0, busyOf = remoteBusyOf, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  let row = await busyOf(name);
  if (row.busy && wait) {
    const until = now() + wait * 1000;
    while (row.busy && now() < until) {
      log.detail(`${name} still busy before the swap (${busyText(row)}) — waiting …`);
      await sleep(10000);
      row = await busyOf(name);
    }
  }
  if (!row.busy) return { swap: true, row };
  if (force) {
    log.warn(`--force: ${name} busy before the swap (${busyText(row)}) — swapped anyway.`);
    return { swap: true, row, forced: true };
  }
  return { swap: false, row, reason: `not idle before the swap (${busyText(row)})` };
}

// The provider processes in the container, split: `holds` hold the gate up, `workflow` are agents of dynamic workflows
// (tools/check/lib/processes.mjs) — the second place of the oneshot detection, the same exception. The WHOLE process list,
// the selection in JS (lib/processes.mjs providerRows). `ps` (procps, in the base image) writes ONE line per process —
// control characters in the system prompt appear as `?` —, `-ww` without width limit (the marker of a workflow agent stands
// far back). A list that could not be read is UNKNOWN, never "no provider processes": a missing or failing `ps` (procps
// missing in the image, the exec fails) would give an empty list and the detection in the container would be silently blind
// again. `ps` always shows at least PID 1 (and itself) in the container; empty can therefore only be a read error. Returns
// `{ holds, workflow }` or additionally `{ unknown: reason }` (then both lists are empty) — remoteBusyOf counts that as
// busy.
export const PROCESS_LIST = "ps -ww -eo pid=,args=";
export async function remoteProcesses(container) {
  return processesFrom(await sshProbe(`docker exec -u agent ${container} sh -c '${PROCESS_LIST}'`, { check: false }));
}

/** Pure: the result of sshProbe of the process list → { holds, workflow } | { holds: [], workflow: [], unknown }. */
export function processesFrom({ code, stdout = "", stderr = "" }) {
  const rows = String(stdout ?? "").split("\n").filter((z) => /^\s*\d+\s+\S/.test(z));
  if (code === 0 && rows.length) return partsProcesses(providerRows(stdout));
  const last = `${stderr ?? ""}`.split("\n").map((z) => z.trim()).filter(Boolean).at(-1);
  const reason = code !== 0 ? `Exit ${code}${last ? `: ${last}` : ""}` : `empty${last ? ` (${last})` : ""} — \`ps\` otherwise always shows at least PID 1`;
  return { holds: [], workflow: [], unknown: reason };
}

export async function remoteOneshots(container) {
  return (await remoteProcesses(container)).holds;
}

// Inner containers: names + status + compose origin, so they can be brought back exactly.
//
// WITHOUT the probe containers of the project box (label `cbase.probe=1`, lib/projectbox-distribution.mjs): a leftover one
// belongs to the tool, not to the user. If it stood in `running`, `restoreInner` would bring it back after every swap — a
// privileged container with its own dockerd —, and gate and status would list it as an inner container of the user. The
// distribution removes it on every readable plan (`leftoversScript`). `{{.Labels}}` is the list `k=v,k=v` of the CLI; a value
// with a comma falls apart there, the probe label still stands as a member of its own.
//
// A project container (label `cbase.project` or name `cbase-p-*`) stays in the list, but carries `project` (the project id) —
// the backend brings it back itself (lib/project-container.mjs); `restoreInner` leaves it out.
//
// WITHOUT the helper containers of the backend (label `cbase.helper=<kind>`, server/backend/electron/server/projectbox/
// helper.js): a helper copies as root between volumes (relocation, clone, way back). If one ran during the swap,
// `restoreInner` would bring it back after a `--force` — next to the restart, which removes it as an orphan and whose
// journal repeats the step. It belongs to the backend, not to the user, as the probe belongs to the tool.
//
// `innerFrom` recognizes probe, helper and project container by the keys from
// server/backend/electron/server/projectbox/own-labels.js — and only if the container carries them ON the container. A
// container INHERITS the labels of its image (`{{.Labels}}` shows both undistinguished): a user container from an image with
// `LABEL cbase.helper=…` (or `cbase.probe=1`, `cbase.project=…` — e.g. a `docker commit` of such a container) would
// otherwise silently drop out of the bring-back. `innerContainers` therefore reads per container the EXACT labels and those
// of its image (`EXACTLY_SCRIPT`, `exactLabelsFrom`); if that reading is missing (unreadable, older caller), the label alone
// applies. The exact labels also resolve the ambiguity of the comma list (a value with a comma fell apart into wrong members).
const PROBE_KEY = PROBE_LABEL.slice(0, PROBE_LABEL.indexOf("="));
const PROBE_VALUE = PROBE_LABEL.slice(PROBE_LABEL.indexOf("=") + 1);
const HELPER_KEY = "cbase.helper";
const PROJECT_KEY = "cbase.project";

// The reading in the user container (via `sh -c '…'` — hence no single quotes in it): per container
// `C <full id> <image id> <Config.Labels as JSON>`, per image `I <image id> <Config.Labels as JSON>` (`null` = no labels,
// `unknown` = the image could not be read).
export const EXACTLY_SCRIPT = [
  "ids=$(docker ps -aq --no-trunc) || exit 1",
  "[ -n \"$ids\" ] || exit 0",
  "docker inspect --type container --format \"C {{.Id}} {{.Image}} {{json .Config.Labels}}\" $ids",
  "for i in $(docker inspect --type container --format \"{{.Image}}\" $ids | sort -u); do printf \"I %s %s\\n\" \"$i\" \"$(docker image inspect --format \"{{json .Config.Labels}}\" \"$i\" 2>/dev/null || echo unknown)\"; done",
].join("; ");

/** The output of EXACTLY_SCRIPT → Map<full id, { labels, image }> (`image` null = image labels unknown). */
export function exactLabelsFrom(stdout) {
  // A JSON object, `null` for "none" (docker: `null` without labels), `undefined` for the unreadable.
  const json = (t) => { try { const v = JSON.parse(t); return v === null ? null : v && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; } };
  // The first n fields separated by ONE space and the rest (the JSON may contain spaces).
  const parts = (z, n) => {
    const out = [];
    let rest = z;
    for (let k = 0; k < n; k++) {
      const i = rest.indexOf(" ");
      if (i < 0) return null;
      out.push(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
    return [...out, rest];
  };
  const container = [];
  const images = new Map();
  for (const row of String(stdout ?? "").split("\n").map((z) => z.trim())) {
    if (row.startsWith("C ")) {
      const t = parts(row, 3);
      const l = t ? json(t[3]) : undefined;
      if (t && /^[0-9a-f]{64}$/.test(t[1]) && l !== undefined) container.push({ id: t[1], image: t[2], labels: l || {} });
    } else if (row.startsWith("I ")) {
      const t = parts(row, 2);
      if (!t) continue;
      const l = json(t[2]);
      images.set(t[1], l === undefined ? null : l || {}); // `null` from docker means "no labels", the unreadable "unknown"
    }
  }
  return new Map(container.map((c) => [c.id, { labels: c.labels, image: images.has(c.image) ? images.get(c.image) : null }]));
}

export function innerFrom(stdout, exactly = null) {
  return String(stdout ?? "")
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p[0])
    .map(([name, status, labels, id]) => {
      const c = { name: name.trim(), status: (status || "").trim() };
      // The FULL id (`--no-trunc`) — restoreInner compares it with `relocationContainer` (sha256).
      const fullId = String(id || "").trim();
      if (/^[0-9a-f]{64}$/.test(fullId)) c.id = fullId;
      const g = c.id && exactly instanceof Map ? exactly.get(c.id) : undefined;
      const l = g ? g.labels : labelsFromSegments(labels);
      const own = ownKey(l, g ? g.image : null);
      if (own.includes(PROBE_KEY) && l[PROBE_KEY] === PROBE_VALUE) return null;
      if (own.includes(HELPER_KEY)) return null;
      const project = projectOf(c.name, own.includes(PROJECT_KEY) ? `${PROJECT_KEY}=${l[PROJECT_KEY]}` : "");
      return project === null ? c : { ...c, project };
    })
    .filter(Boolean);
}

export async function innerContainers(container) {
  const fmt = "{{.Names}}\\t{{.Status}}\\t{{.Labels}}\\t{{.ID}}";
  const running = await sshProbe(`docker exec -u agent ${container} docker ps --no-trunc --format '${fmt}' || true`);
  const all = await sshProbe(`docker exec -u agent ${container} docker ps -a --no-trunc --format '${fmt}' || true`);
  // The exact labels together with those of the images (see above); unreadable ⇒ empty ⇒ the label alone.
  const exactly = exactLabelsFrom((await sshProbe(`docker exec -u agent ${container} sh -c '${EXACTLY_SCRIPT}' || true`)).stdout);
  return { running: innerFrom(running.stdout, exactly), all: innerFrom(all.stdout, exactly) };
}

// Gate over ALL user containers, not only the one being swapped: the tag `:latest` applies to every one, and the gateway
// recreates containers from it at any time. A running run in a FOREIGN container therefore holds the deploy up just like one
// in the own.
//
// What comes back is the inner container state PER swap candidate (`Map<name, {running, all}>`) — it must be measured before
// the swap, because a `docker rm -f` takes the inner docker daemon with it.
export async function remoteGate({ force, containers }) {
  log.step("Gate on the server");
  const rows = await remoteBusy();
  const targets = (containers || []).filter(Boolean);
  const inner = new Map();
  for (const c of targets) inner.set(c, await innerContainers(c));
  const swapped = new Set(targets);
  log.table([
    ...rows.map((r) => [
      swapped.has(r.name) ? `Chats (${r.name.slice(0, 26)}…)` : `Chats (${r.name.slice(0, 26)}… — no swap)`,
      (r.runs
        ? `busy=${r.runs.busy} runs=${r.runs.runs}${r.oneshots.length ? ` oneshots=${r.oneshots.length}` : ""}${r.oneshotsBackend ? ` oneshots(Backend)=${r.oneshotsBackend}` : ""}${r.workflowAgents?.length ? ` (+${r.workflowAgents.length} workflow agent process(es), not holding)` : ""}${approvalsText(r.runs)}`
        : "unreachable (or no answer from /api/runs/active)") + processesText(r),
      r.busy ? "bad" : "ok",
    ]),
    ...rows.filter((r) => r.runs).map((r) => {
      const [label, text, st] = backgroundAgentsRow(r.runs);
      return [`${label} (${r.name.slice(0, 26)}…)`, text, st];
    }),
    ...rows.filter((r) => r.runs).map((r) => {
      const [label, text, st] = monitorRow(r.runs);
      return [`${label} (${r.name.slice(0, 26)}…)`, text, st];
    }),
    // The outer-loop runs per container — over ALL, unreachable means "unknown".
    ...rows.map((r) => {
      const [label, text, st] = outerLoopRow(r.runs);
      return [`${label} (${r.name.slice(0, 26)}…)`, text, st];
    }),
    // ALL containers, also the unreachable ones — there "unknown", never "none".
    ...rows.map((r) => {
      const [label, text, st] = dynWorkflowRow(r.runs);
      return [`${label} (${r.name.slice(0, 26)}…)`, text, st];
    }),
    // The same for the project instances — over ALL containers, unreachable means "unknown".
    ...rows.map((r) => {
      const [label, text, st] = projectWorkRow(r.runs);
      return [`${label} (${r.name.slice(0, 26)}…)`, text, st];
    }),
    ["User containers", `${rows.length} (Swap: ${targets.length})`, rows.length > 1 ? "warn" : null],
    ...targets.flatMap((c) => {
      const i = inner.get(c) || { running: [], all: [] };
      // Only those of the user are a warning (the swap takes them along, restoreInner brings them back); the backend brings
      // project containers back itself — a row of its own, no warn.
      const user = partsInner(i.running).user;
      const pz = projectContainerRow(i.all?.length ? i.all : i.running, i.running);
      return [
        [
          `inner containers (${c.slice(0, 26)}…)`,
          user.length ? user.map((x) => x.name).join(", ") : "none",
          user.length ? "warn" : "ok",
        ],
        ...(pz ? [[`${pz[0]} (${c.slice(0, 26)}…)`, pz[1], pz[2]]] : []),
      ];
    }),
  ]);
  for (const r of rows) for (const l of r.oneshots) log.detail(`  ${r.name}: ${mask(l).slice(0, 140)}`);

  const busy = rows.filter((r) => r.busy);
  if (busy.length && !force) {
    throw new Error(
      `Not idle: ${busy.map((r) => r.name).join(", ")} — wait (\`--wait 300\`) or \`--force\`.` +
        approvalsSentence(busy.flatMap((r) => r.runs?.approvals || [])) +
        (busy.some((r) => r.runs?.agents?.length) ? " Background agents are running — the gate waits for them, `--force` takes them along." : "") +
        (busy.some((r) => r.runs?.monitors?.some((x) => !x.persistent)) ? " Monitors are running — the gate waits for them, `--force` ends them (the chat gets a note)." : "") +
        (busy.some((r) => r.runs?.outerLoop?.length) ? " Outer-loop runs are running — the gate waits for them, `--force` aborts them (marked \"aborted\" at the next start, the next trigger catches up)." : "") +
        (busy.some((r) => r.runs?.projectWork?.length) ? " Project instances are in progress (creation, start, relocation) — the gate waits for them." : "") +
        (busy.some((r) => r.processesUnknown) ? ` The process list of ${busy.filter((r) => r.processesUnknown).map((r) => r.name).join(", ")} is not readable — whether a oneshot runs there is unknown, and unknown is not free.` : "") +
        (rows.some((r) => r.runs?.dynWorkflows?.length) ? " It does not wait for dynamic workflows." : ""),
    );
  }
  const dyn = rows.reduce((n, r) => n + (r.runs?.dynWorkflows?.length || 0), 0);
  if (!busy.length && dyn) log.warn(`${dyn} dynamic workflow(s) running — the swap interrupts them, the restart resumes them.`);
  if (busy.length && force) log.warn(`--force: gate bypassed (busy: ${busy.map((r) => r.name).join(", ")}).`);
  return inner;
}

// After the settle observation — if project containers ran in a B before the swap, the deploy asks its backend via
// `projectWork` whether the restoration is done (lib/project-container.mjs projectRetrievalRow). It does not start them and
// does not wait for them: one row, `warn` as long as an instance is still in progress. Without project containers before the
// swap no call. Returns the rows (also for tests).
export async function projectRetrieval(inner, names) {
  const rows = [];
  for (const name of names || []) {
    const prior = partsInner(inner?.get(name)?.running || []).projects;
    if (!prior.length) continue;
    const [label, text, st] = projectRetrievalRow(await remoteRuns(name), prior);
    rows.push([`${label} (${name.slice(0, 26)}…)`, text, st]);
  }
  if (rows.length) log.table(rows);
  return rows;
}

// After the settle observation, per swapped B the row "Compose in B (converted)" (lib/project-container.mjs composeInBRow) —
// read from the ops state of the NEW backend (GET /api/projectbox/ops-status). A message, no abort. Returns the rows.
export async function composeInBPostObservation(names) {
  const rows = [];
  for (const name of names || []) {
    const [label, text, st] = composeInBRow(await remoteOpsStatus(name));
    rows.push([`${label} (${name.slice(0, 26)}…)`, text, st]);
  }
  if (rows.length) log.table(rows);
  return rows;
}

// Waits until EVERY user container is idle (the argument `container` is kept for callers, but is only the swap candidate
// now).
export async function waitRemoteIdle(container, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const rows = await remoteBusy();
    const busy = rows.filter((r) => r.busy);
    if (!busy.length) return true;
    log.detail(`still busy: ${busy.map((r) => `${r.name} (runs=${r.runs?.runs ?? "?"} agents=${r.runs?.agents?.length ?? "?"} outerLoop=${r.runs?.outerLoop?.length ?? "?"} projects=${r.runs?.projectWork?.length ?? "?"} dynamic workflows=${r.runs?.dynWorkflows?.length ?? "?"} (not waited for)${approvalsText(r.runs)}${processesText(r)})`).join(", ")} — waiting …`);
    await new Promise((r) => setTimeout(r, 10000));
  }
  return false;
}
