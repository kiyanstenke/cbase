// Workflow definitions (the folder workflows/ is the RUN; the root workflows.js is the graph library):
// workflowMeta/Full, triggerViews, withLosses, saveWorkflow, workflowTriggerRoute (a function with a return value, not a route function).

import { isProviderId } from "../providers/index.js";
import * as wf from "../workflows.js";
import * as store from "../store.js";
import * as autocompact from "../autocompact.js";
import { T } from "../i18n.js";
import { WORKFLOW_MAX_STEPS, WORKFLOW_MAX_VISITS } from "./run-state.js";
import { modelKnown } from "../account/providers.js";
import { pollTriggerNode } from "./triggers.js";
import { readBody, send } from "../runtime/http.js";

// Workflow list entry (without graph — lists only show name, purpose and size) and full entry
// with graph and the editor's hints (missing edges, empty instructions …).
const workflowMeta = (w) => ({
  id: w.id, name: w.name, description: w.description, projectId: w.projectId || null,
  ...(w.originProject ? { originProject: w.originProject } : {}),
  nodeCount: w.graph?.nodes?.length || 0, steps: wf.countSteps(wf.normalizeGraph(w.graph)),
  active: !!w.active, triggers: triggerViews(w),
  // Concurrency + the key under which a lock is actually held right now (if a run of this
  // workflow is running) — so the UI can explain "waiting for …".
  lock: wf.normalizeLock(w.lock),
  run: wf.normalizeRunSettings(w.run),
  holding: store.listLocks().filter((l) => l.workflowId === w.id).map((l) => ({ key: l.key, chatId: l.chatId, at: l.at })),
  updatedAt: w.updatedAt,
});
// Limits of the machinery belong in the FULL view: the editor labels the fields with them
// ("0 = default: 5 rounds") instead of maintaining the numbers twice.
const workflowFull = (w) => w && ({
  ...workflowMeta(w),
  graph: wf.normalizeGraph(w.graph),
  // The hints are an EXTRA. A single degenerate graph (thousands of chained nodes) can throw
  // here — and because the same function sits in the LIST, the workflow list of the whole
  // workspace would then be a permanent 500, in web and iOS, with no way back from the UI.
  // A hint that cannot be computed is a missing hint.
  problems: (() => {
    // With the run settings: if the round cap is set to "continue", the run does not ask.
    try { return wf.checkGraph(w.graph, { maxSteps: WORKFLOW_MAX_STEPS, run: wf.normalizeRunSettings(w.run) }); }
    catch (e) {
      console.error("[workflow] hints:", e?.message || e);
      return [{ level: "error", text: T`The graph is too large or malformed, the check aborted: ${e?.message || e}` }];
    }
  })(),
  limits: {
    maxVisits: WORKFLOW_MAX_VISITS, maxVisitsLimit: wf.MAX_VISITS_LIMIT,
    maxSteps: WORKFLOW_MAX_STEPS, maxIterations: wf.MAX_ITERATIONS,
    // The STORED number of this workflow (old clients label "after {n} rounds" with it);
    // new ones read it from the editing state `run.doneRounds`. Per workflow.
    doneRounds: wf.normalizeRunSettings(w.run).doneRounds,
    doneRoundsMax: wf.DONE_ROUNDS_MAX,
  },
});
// Public view of a workflow's triggers: configuration in short form PLUS operating state
// (last poll, last fire, last error). The account comes without its token.
function triggerViews(w) {
  const g = wf.normalizeGraph(w.graph);
  const nodes = wf.triggerNodes(g);
  if (!nodes.length) return [];
  const states = new Map(store.listTriggerStates(w.id).map((s) => [s.nodeId, s]));
  return nodes.map((n) => {
    const t = n.trigger;
    const st = states.get(n.id);
    const acc = t.accountId ? store.getGitlabAccount(t.accountId) : null;
    return {
      nodeId: n.id, title: n.title || "", source: t.source, scope: t.scope,
      target: t.scope === "project" ? t.projectPath || t.projectId : t.scope === "group" ? t.groupPath || t.groupId : "",
      events: t.events, intervalSec: t.intervalSec, missing: wf.triggerReady(t),
      account: acc ? { id: acc.id, label: acc.label, host: acc.host, userName: acc.userName } : null,
      lastPollAt: st?.lastPollAt || 0, lastFireAt: st?.lastFireAt || 0, fires: st?.fires || 0, lastError: st?.lastError || "",
    };
  });
}
// Saving is shared by the workspace and the project route. The editor sends the WHOLE graph;
// names stay unique per scope (the project's adoption switch addresses by name).
// Returns: { workflow } or { status, error } — the route decides on the response.
// Response of a save: the full view plus the losses of THIS save. They come FIRST — what was
// just dropped is more urgent than a hint the graph has always carried.
const withLosses = (r) => {
  const full = workflowFull(r.workflow);
  return r.losses?.length ? { ...full, problems: [...r.losses, ...(full.problems || [])] } : full;
};

async function saveWorkflow(req, flow, workspaceId, projectId) {
  const b = await readBody(req);
  const fields = { updatedAt: Date.now() };
  if (typeof b.name === "string" && b.name.trim() && b.name.trim() !== flow.name) {
    const name = b.name.trim().slice(0, 64);
    const other = store.getWorkflowByName(workspaceId, projectId, name);
    if (other && other.id !== flow.id) {
      return { status: 409, error: T`A workflow "${name}" already exists here.` };
    }
    fields.name = name;
    // Adoption in the project hangs on the NAME — carry it along on rename, otherwise every
    // project would silently lose its assignment.
    if (!projectId) store.renameWorkflowAdoptions(workspaceId, flow.name, name);
  }
  if (typeof b.description === "string") fields.description = b.description.slice(0, 400);
  // What is SILENTLY dropped on save (discarded steps, capped fields, edges into nowhere) can ONLY
  // be measured here: the normalized version is stored, and afterwards the loss is invisible in
  // the stored data. So compute it now and pass it along with the response.
  const losses = b.graph ? wf.storageLosses(b.graph) : [];
  if (b.graph) fields.graph = wf.normalizeGraph(b.graph);
  // Arming (n8n: "Active"): only with a fully configured trigger, and the clock starts NOW —
  // otherwise half the project history would start runs after the fact.
  // The waterline is only written at the very bottom, after the last check.
  let waterline = [];
  if (typeof b.active === "boolean") {
    const graph = fields.graph || wf.normalizeGraph(flow.graph);
    const triggers = wf.triggerNodes(graph);
    if (b.active) {
      if (!triggers.length) return { status: 400, error: T("Activating needs a trigger step.") };
      const broken = triggers.filter((n) => wf.triggerReady(n.trigger));
      if (broken.length === triggers.length) {
        return { status: 400, error: T("The trigger is not fully configured yet.") };
      }
      // Do NOT write here: below this block are further checks (lock, run settings) that can
      // bail out with 400. The waterline would then stand at NOW although NOTHING was saved —
      // the events of that window would be dropped silently. A side effect belongs after the
      // last check.
      waterline = triggers.map((n) => n.id);
    }
    fields.active = b.active;
  }
  // Concurrency: which key makes runs mutually exclusive (see workflows.js).
  if (b.lock && typeof b.lock === "object") {
    if (b.lock.scope !== undefined && !wf.LOCK_SCOPES.includes(String(b.lock.scope))) {
      return { status: 400, error: T("Unknown lock scope.") };
    }
    const lock = wf.normalizeLock({ scope: b.lock.scope ?? flow.lock?.scope, template: b.lock.template ?? flow.lock?.template });
    if (lock.scope === "custom" && !lock.template.trim()) {
      return { status: 400, error: T("A custom key needs a template.") };
    }
    // The key is formed ONCE, at the start of the run. It cannot contain what does not exist yet
    // at that time: the loop element and the answer to a question only come into being in the
    // middle of the run.
    // Only a CHANGED template is checked. The editor sends `lock` with EVERY save — a workflow
    // whose template already carried such a placeholder could otherwise never be saved again,
    // not even to change something else entirely (a lockout instead of a warning).
    const oldTemplate = wf.normalizeLock(flow.lock);
    const templateNew = lock.scope !== oldTemplate.scope || lock.template !== oldTemplate.template;
    if (lock.scope === "custom" && templateNew) {
      const impossible = (lock.template.match(/\{\{\s*(element|item|answer)\s*\}\}/gi) || []);
      if (impossible.length) {
        return { status: 400, error: T`${impossible.join(", ")} does not exist yet when a run starts and cannot appear in a lock key.` };
      }
    }
    fields.lock = lock;
  }
  // Run settings: provider/model/permissions/effort of this workflow.
  // Empty fields stay empty = "as usual". Unknown values are REJECTED, not silently dropped: a
  // typo in the mode would otherwise erase the stored choice, and an invented provider/model
  // name would land unchanged on the chat and go to the CLI as `--model` — the chat would be
  // permanently unusable afterwards, outside the workflow too.
  if (b.run && typeof b.run === "object") {
    const raw = b.run;
    const old = wf.normalizeRunSettings(flow.run);
    // Only what REALLY changes is checked. The editor sends `run` back unchanged with every
    // save, and a model disappears from the catalog as soon as a CLI version rises. Without
    // this comparison an existing workflow could NEVER be saved again after a catalog change —
    // a guard against typos would have become a lockout.
    const fresh = (field) => raw[field] !== undefined && String(raw[field] ?? "").trim() !== String(old[field] ?? "").trim();
    // Three statements per field, not two: if it is MISSING, the stored value stays (`run` is a
    // partial patch — `fresh` does not see it at all); if it is EMPTY, that means "back to
    // default" and is saved; only an unknown, NON-empty value is a 400.
    // Empty means, for provider and permissions: whitespace only (as for model and check model
    // below); for the effort the save verdict itself decides (`effortSavable`: empty is exactly "").
    const empty = (field) => String(raw[field]).trim() === "";
    if (fresh("provider") && !empty("provider") && !isProviderId(String(raw.provider).trim())) {
      return { status: 400, error: T`Unknown provider “${String(raw.provider).slice(0, 40)}”.` };
    }
    if (fresh("model") && String(raw.model).trim()) {
      const provider = String(raw.provider ?? flow.run?.provider ?? "").trim();
      const model = String(raw.model).trim();
      if (!modelKnown(provider, model)) {
        return { status: 400, error: T`Unknown model “${model.slice(0, 60)}”${provider ? T` for “${provider}”` : ""}.` };
      }
    }
    if (fresh("permissionMode") && !empty("permissionMode") && !wf.PERMISSION_MODES.includes(String(raw.permissionMode))) {
      return { status: 400, error: T`Unknown permission mode “${String(raw.permissionMode).slice(0, 40)}”.` };
    }
    // Effort via the save verdict (workflows.js): a changed field is an effort level or empty
    // (default); only `unknown` is rejected. `String(…)`: a non-text is judged as text (`null`
    // becomes "null" this way — unknown, as in the verdict itself).
    if (fresh("effort") && wf.effortSavable(String(raw.effort)).kind === "unknown") {
      return { status: 400, error: wf.effortWording(raw.effort) };
    }
    // The same for the verdict of the completion gate: an invented model would otherwise go to
    // the oneshot as `--model`, and EVERY gate of this workflow would fail with "verdict unusable".
    if (fresh("doneProvider") && String(raw.doneProvider).trim() && !isProviderId(String(raw.doneProvider).trim())) {
      return { status: 400, error: T`Unknown provider “${String(raw.doneProvider).slice(0, 40)}” for the completion check.` };
    }
    if (fresh("doneModel") && String(raw.doneModel).trim()) {
      const provider = String(raw.doneProvider ?? flow.run?.doneProvider ?? "").trim();
      const model = String(raw.doneModel).trim();
      if (!modelKnown(provider, model)) {
        return { status: 400, error: T`Unknown model “${model.slice(0, 60)}”${provider ? T` for “${provider}”` : ""} for the completion check.` };
      }
    }
    // The six newer fields: again only what changes is checked — compared STRICTLY here, because
    // `null` (default) and `0` (off) are different statements and the string comparison above
    // turned both into "". An explicit `null` means "back to default", a missing key "unchanged".
    const changed = (field) => raw[field] !== undefined && raw[field] !== old[field];
    if (changed("autocompact") && raw.autocompact !== null && (typeof raw.autocompact !== "number" || autocompact.stage(raw.autocompact) === null)) {
      return { status: 400, error: T`Unknown compaction level “${String(raw.autocompact).slice(0, 20)}” — allowed are default, off or ${autocompact.STAGES.join(", ")} %.` };
    }
    if (changed("autocompactMax") && raw.autocompactMax !== null && (typeof raw.autocompactMax !== "number" || autocompact.maxStage(raw.autocompactMax) === null)) {
      return { status: 400, error: T`Unknown compaction cap “${String(raw.autocompactMax).slice(0, 20)}”.` };
    }
    if (changed("doneRounds") && !(Number.isInteger(raw.doneRounds) && raw.doneRounds >= 1 && raw.doneRounds <= wf.DONE_ROUNDS_MAX)) {
      return { status: 400, error: T`Check rounds must be a whole number from 1 to ${wf.DONE_ROUNDS_MAX}.` };
    }
    // Ultracode: the same check as on the chat (`ultracodeSavable`) — a boolean or 400; switching
    // off (`false`) is a value like any other, not an error case.
    if (changed("ultracode") && wf.ultracodeSavable(raw.ultracode).kind === "unknown") {
      return { status: 400, error: wf.ultracodeSavable(raw.ultracode).error };
    }
    for (const field of ["doneAll", "doneCapAuto", "loopCapAuto"]) {
      if (changed(field) && typeof raw[field] !== "boolean") {
        return { status: 400, error: T`“${field}” must be true or false.` };
      }
    }
    fields.run = wf.normalizeRunSettings({ ...old, ...raw });
  }
  // Last trigger node removed? Then nothing can fire any more — switch the toggle off as well,
  // otherwise an "armed" workflow would remain whose toggle no longer shows up in the UI at all.
  if (fields.graph && flow.active && !wf.triggerNodes(fields.graph).length) fields.active = false;
  // From here on we write — every check is done. The clock starts NOW, otherwise half the
  // project history would start runs after the fact (see above).
  if (waterline.length && fields.active !== false) {
    const now = Date.now();
    for (const nodeId of waterline) {
      store.ensureTriggerState(flow.id, nodeId, now);
      store.updateTriggerState(flow.id, nodeId, { since: now, lastPollAt: 0, lastError: "" });
    }
  }
  return { workflow: store.updateWorkflow(flow.id, fields), losses };
}
// Shared trigger sub-route of workspace and project workflows:
//   GET  …/trigger-status  operating state of all triggers
//   POST …/trigger-test    look once at what would fire ({ fire: true } really fires)
async function workflowTriggerRoute(req, res, m, sub, flow) {
  if (sub.endsWith("/trigger-status") && m === "GET") {
    send(res, 200, { active: !!flow.active, triggers: triggerViews(flow) });
    return true;
  }
  if (sub.endsWith("/trigger-test") && m === "POST") {
    const b = await readBody(req);
    const graph = wf.normalizeGraph(flow.graph);
    const nodes = wf.triggerNodes(graph);
    const node = b.nodeId ? nodes.find((n) => n.id === String(b.nodeId)) : nodes[0];
    if (!node) { send(res, 404, { error: T("Trigger not found") }); return true; }
    try {
      // Without `fire` this is a dry run: it does NOT move the waterline, otherwise the test
      // would swallow exactly the events the user is waiting for.
      const r = await pollTriggerNode(flow, node, b.fire === true ? { force: true } : { dryRun: true });
      send(res, 200, {
        nodeId: node.id, fired: r.fired || 0, error: r.error || "",
        events: (r.events || []).slice(-10).map((e) => ({
          kind: e.kind, summary: wf.eventSummary(e), url: e.url || "", at: e.at, author: e.author || "",
        })),
      });
    } catch (e) { send(res, 502, { error: String(e?.message || e) }); }
    return true;
  }
  return false;
}

export { withLosses, saveWorkflow, workflowFull, workflowMeta, workflowTriggerRoute };
