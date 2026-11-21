// Routes of the relocation — no UI; an operator calls them inside the user container B (`docker exec -u agent <B> curl …`).
// A sub-slice of the owner `projectRoutes` (projects/routes.js, sub-table) — ctx carries `pid`, `sub`, `proj` there.
//
//   GET  /api/projects/:id/relocation/plan    collect (./collect.js) and plan (./plan.js) → { plan }. ONLY the plan: the raw
//                                             data (Compose texts, MCP environment) carries values and never leaves the backend.
//   POST /api/projects/:id/relocation         starts the relocation (./procedure.js `startRelocation`) and answers 202 with
//                                             the status (`relocationStatus`) AS SOON AS its journal stands (callback
//                                             `started`) — the relocation keeps running. Until then the procedure checks the
//                                             preconditions (plan, hold reasons, lock, idle); a no before that IS the answer
//                                             (status from `status`/`code`, plus `holdReasons` or `open` — only kinds, names,
//                                             chats, never values). Answering earlier would always return 202 with the status
//                                             of the PREVIOUS relocation and leave a hold only in the log. 409 while the heavy
//                                             load is occupied (../heavyLoad.js — at most one relocation per user container) or
//                                             one is already running for THIS project (open journal or living procedure).
//                                             409 RELOCATION_ELSEWHERE while a half relocation of ANOTHER project lives or is
//                                             not decided yet (it stems from the previous server run and the restart grace has
//                                             not taken it over — ../instances.js `relocationElsewhere`): otherwise this
//                                             relocation would grab the heavy load, and the restart grace of the half one would
//                                             find it occupied and leave it half until the next restart.
//   POST /api/projects/:id/relocation/resume  the SECOND WAY: resume an open journal without a living procedure
//                                             (./procedure.js `resumeRelocation`, the same as the restart grace: before the
//                                             turnaround the return path, from the turnaround on forward) — after a failed
//                                             decider, a hold after the turnaround or `hold-return-path`, once the reason is
//                                             fixed. 202 with the status once the heavy load is held and the decision is made;
//                                             409 without an open journal (NO_OPEN_RELOCATION), with a living procedure
//                                             (RELOCATION_RUNNING) or an occupied heavy load.
//   GET  /api/projects/:id/relocation         the status (`relocationStatus`) → { state } — an open journal without a living
//                                             procedure carries `wayOut` (and `resumeError` if resuming failed).
//
//   POST /api/projectbox/desired-snapshot     (in `projectboxOpsRoutes`) one pass of the desired-state tick
//                                             (../resumption.js `desiredTickRound`) — the gateway calls it in destroy before
//                                             the stop; → `{ result }`.
//   GET  /api/projectbox/ops-status           (in `projectboxOpsRoutes`, a top-level route in ROUTES of server.js)
//                                             `{ composeInB, withoutInstanceRow: [{ projectId, name }] }` — Compose containers
//                                             in B next to converted projects (./compose-in-b.js) and every project WITHOUT an
//                                             instance row of the main instance, with its NAME (in operation a project arises
//                                             with its row); read by the operator's status check in B. Because of the names the fence
//                                             rejects it from project networks (row "ops-status"); /api/runs/active therefore
//                                             carries only numbers.
//
// Without projectboxOps() EVERY one of these routes answers 404 "only in server mode" before anything is collected. From a
// project network the fence rejects them (../fence-table.js, row "project-relocation") — a project container would otherwise
// pull the ground from under itself.
//
// THE PROCEDURE comes at runtime by dynamic import from ./procedure.js (no static import: the routes and their tests also run
// without it, and no cycle through the procedure arises). `setRelocationProcedure(module)` is the test seam: an object
// `{ startRelocation, relocationStatus, resumeRelocation? }` instead of the module; `null` takes it back. server.js never sets it.
//
// Guards: server/backend/test/relocation-routes.test.js (procedure injected), server/backend/test/relocation-end.test.js —
// the real procedure behind the route.
import * as store from "../../store.js";
import { NEXT, readBody, send } from "../../runtime/http.js";
import { ONLY_IN_OPS, projectboxOps } from "../ops.js";
import { procedureAlive, relocationElsewhere, relocationElsewhereText } from "../instances.js";
import { heavyLoadStatus } from "../heavyLoad.js";
import { MAIN } from "../creation.js";
import { composeInB } from "./compose-in-b.js";
import { desiredTickRound } from "../resumption.js";

let procedureSeam = null;
/** Test seam (see header): `{ startRelocation, relocationStatus }` or `null`. */
export function setRelocationProcedure(module) {
  procedureSeam = module && typeof module === "object" ? module : null;
}

async function procedure() {
  if (procedureSeam) return procedureSeam;
  return import("./procedure.js");
}

// A start error as the answer: its `status`, otherwise 409 for the known occupied/hold codes, otherwise 500. Only the message
// and the code — an error of the procedure carries no values (journal and report are free of values).
function errorStatus(e) {
  if (Number.isInteger(e?.status) && e.status >= 400 && e.status < 600) return e.status;
  // The codes of the procedure (procedure.js RelocationError) and of the collection (collect.js CollectError) carry their
  // status themselves — the list is only the fallback for a throw without `status`.
  if (["RECEIPT_MISMATCHED", "HEAVY_LOAD_OCCUPIED", "RELOCATION_RUNNING", "RELOCATION_OPEN", "RELOCATION_ELSEWHERE", "NO_OPEN_RELOCATION", "INSTANCE_EXISTS", "HOLD", "NOT_IDLE", "OCCUPIED", "ALREADY_CONVERTED", "LOCKED"].includes(e?.code)) return 409;
  return 500;
}
// Hold reasons ({ kind, text, … }: kinds, names, paths — plan.js emits no values) and the open work ({ chatId, reason, text })
// tell the operator WHY a relocation does not begin (there is no UI to look at).
const errorBody = (e) => ({
  error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}),
  ...(Array.isArray(e?.holdReasons) ? { holdReasons: e.holdReasons } : {}), ...(Array.isArray(e?.open) ? { open: e.open } : {}),
  ...(e?.elsewhere && typeof e.elsewhere === "object" ? { elsewhere: e.elsewhere } : {}),
});

/** The receipts from the read body of a POST …/relocation (`readBody`: an empty body is `{}`) — a JSON object with at most
 *  `acknowledged` (list of { kind: text, container: text, count: integer ≥ 0, checksum: text }). Everything else throws. */
export function receiptsFromBody(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("the body is not a JSON object");
  const unknown = Object.keys(d).filter((k) => k !== "acknowledged");
  if (unknown.length) throw new Error(`unknown fields: ${unknown.join(", ")}`);
  if (d.acknowledged === undefined) return [];
  if (!Array.isArray(d.acknowledged)) throw new Error("`acknowledged` is not a list");
  return d.acknowledged.map((q, i) => {
    if (!q || typeof q !== "object" || typeof q.kind !== "string" || typeof q.container !== "string" || !Number.isInteger(q.count) || q.count < 0
      || typeof q.checksum !== "string" || !q.checksum) {
      throw new Error(`receipt ${i + 1}: { kind: text, container: text, count: integer, checksum: text } expected`);
    }
    return { kind: q.kind, container: q.container, count: q.count, checksum: q.checksum };
  });
}

export async function relocationProjectRoutes(ctx) {
  const { req, res, url, p, m, pid, sub, proj } = ctx;
  if (sub === "/relocation" || sub === "/relocation/plan" || sub === "/relocation/resume") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });

    if (sub === "/relocation/plan" && m === "GET") {
      try {
        const { planFor } = await import("./collect.js");
        const { plan } = await planFor(proj.id);
        return send(res, 200, { plan });
      } catch (e) {
        console.error(`[relocation] plan ${pid}:`, e?.message || e);
        return send(res, errorStatus(e), errorBody(e));
      }
    }

    if (sub === "/relocation" && m === "GET") {
      let module;
      try { module = await procedure(); } catch (e) {
        return send(res, 501, { error: `the relocation procedure is missing (projectbox/relocation/procedure.js): ${e?.message || e}` });
      }
      try { return send(res, 200, { state: await module.relocationStatus(proj.id) }); } catch (e) {
        return send(res, errorStatus(e), errorBody(e));
      }
    }

    if (sub === "/relocation" && m === "POST") {
      let module;
      try { module = await procedure(); } catch (e) {
        return send(res, 501, { error: `the relocation procedure is missing (projectbox/relocation/procedure.js): ${e?.message || e}` });
      }
      const occupied = heavyLoadStatus();
      if (occupied) {
        return send(res, 409, { error: `heavy load occupied: "${occupied.kind}" for ${occupied.projectId}/${occupied.instance} is running — at most one relocation per user container`, code: "HEAVY_LOAD_OCCUPIED", occupied });
      }
      if (store.openRelocation(proj.id) || procedureAlive(proj.id, "main")) {
        let state = null;
        try { state = await module.relocationStatus(proj.id); } catch { /* the status is only an extra */ }
        return send(res, 409, { error: `a relocation is already running for project ${proj.id}`, code: "RELOCATION_RUNNING", state });
      }
      const elsewhere = relocationElsewhere(proj.id);
      if (elsewhere) return send(res, 409, { error: relocationElsewhereText(elsewhere), code: "RELOCATION_ELSEWHERE", elsewhere });
      // The answer goes out as soon as the journal stands (`started`) or the start ends — whichever comes first. A throw
      // before that is the answer; a later one (after `started`) is in the journal and the log, no longer in the answer.
      let reported;
      const journalStands = new Promise((r) => { reported = r; });
      let run;
      // The body may carry receipts (`{ acknowledged: [{ kind, container, count, checksum }] }`, plan.js `applyReceipts`); an
      // empty body means "none". A body that is not a JSON object, or a receipt in another form, is a 400 — never silently
      // "no receipt".
      let acknowledged = [];
      try { acknowledged = receiptsFromBody(await readBody(req)); } catch (e) { return send(res, 400, { error: String(e?.message || e), code: "BODY_INVALID" }); }
      try { run = Promise.resolve(module.startRelocation(proj.id, { acknowledged, started: () => reported({ error: null }) })); } catch (e) { run = Promise.reject(e); }
      run.then(() => reported({ error: null }), (e) => {
        console.error(`[relocation] ${pid}: ${e?.message || e}`);
        reported({ error: e });
      });
      const end = await journalStands;
      if (end.error) return send(res, errorStatus(end.error), errorBody(end.error));
      let state = null;
      try { state = await module.relocationStatus(proj.id); } catch (e) { state = { error: String(e?.message || e) }; }
      return send(res, 202, { started: true, state });
    }

    if (sub === "/relocation/resume" && m === "POST") {
      let module;
      try { module = await procedure(); } catch (e) {
        return send(res, 501, { error: `the relocation procedure is missing (projectbox/relocation/procedure.js): ${e?.message || e}` });
      }
      if (typeof module.resumeRelocation !== "function") return send(res, 501, { error: "the relocation procedure cannot resume" });
      // As with POST …/relocation: the answer goes out as soon as the decision is made (`started`) or resuming ends. A no
      // before that (no open journal, procedure alive, heavy load) is thrown synchronously by `resumeRelocation`.
      let reported;
      const decided = new Promise((r) => { reported = r; });
      let run;
      try { run = module.resumeRelocation(proj.id, { started: () => reported({ error: null }) })?.run; } catch (e) {
        return send(res, errorStatus(e), errorBody(e));
      }
      Promise.resolve(run).then(() => reported({ error: null }), (e) => {
        console.error(`[relocation] ${pid} resume: ${e?.message || e}`);
        reported({ error: e });
      });
      const end = await decided;
      if (end.error) return send(res, errorStatus(end.error), errorBody(end.error));
      let state = null;
      try { state = await module.relocationStatus(proj.id); } catch (e) { state = { error: String(e?.message || e) }; }
      return send(res, 202, { resumed: true, state });
    }
  }
  return NEXT;
}

/** Every project without an instance row of the main instance — `[{ projectId, name }]` (see header). Synchronous, no docker. */
export function withoutInstanceRow() {
  return store.listAllProjects().filter((p) => !store.projectInstance(p.id, MAIN)).map((p) => ({ projectId: p.id, name: p.name }));
}

/** The ops status for GET /api/projectbox/ops-status (see header): `composeInB` is `null` if docker in B does not answer. */
export async function opsStatus() {
  return { composeInB: await composeInB(), withoutInstanceRow: withoutInstanceRow() };
}

// The ops status and the desired snapshot (see header). Without the ops marker 404 like every route of the project containers.
export async function projectboxOpsRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
  if (p === "/api/projectbox/ops-status" && m === "GET") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    return send(res, 200, await opsStatus());
  }
  // The snapshot of the desired state of every ready, converted instance — ONE pass of the desired-state tick
  // (../resumption.js `desiredTickRound`: single-flight, writes only when quiet and only what changed). The gateway calls it
  // in destroy BEFORE marker and stop script (server/gateway/containers.js); afterwards the project containers are stopped
  // and their inside is no longer readable. → `{ result: { <identifier>: <verdict of the pass> } }`. The fence rejects it from
  // project networks (fence-table.js, row "desired-snapshot").
  if (p === "/api/projectbox/desired-snapshot" && m === "POST") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    return send(res, 200, { result: await desiredTickRound() });
  }
  return NEXT;
}
