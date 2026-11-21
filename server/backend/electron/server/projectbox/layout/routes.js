// The routes of the layout in the inventory — sub-route of `projectRoutes` (projects/routes.js), entered in its sub-table. Without
// operations 404 `only in server mode` (the local server shows no "Layout" entry). From a project network the fence rejects every
// route under `/layout/**` (`projectbox/fence-table.js`, row "project-layout"): only the human lays out. Answer shapes and error codes
// are in read.js (level, check) and job.js (job); the codes are documented there.
//
//   GET    /api/projects/:id/layout?path=<rel>           one level (read.js layoutLevel) → 200; 400 PATH · NO_FOLDER, 404 PATH_MISSING,
//                                                        409 NOT_CONVERTED · NOT_READY · REFERENCE · IN_CODE_REPO (with `block`)
//   POST   /api/projects/:id/layout/check { steps }      → 202 { check }; 400 STEPS, 409 NOT_CONVERTED · NOT_READY · relocation ·
//                                                        SETUP_OPEN · COPY_OPEN (with `name`) · ROOT_IS_REPO; with an open job 409
//                                                        JOB_OPEN (a check against a tree that is about to be rebuilt would be worthless)
//   GET    /api/projects/:id/layout/check/:check         → 200 { check, state, steps, … }; 404 CHECK_UNKNOWN (unknown, expired, of
//                                                        another project)
//   Event `project/layout` (`kind: "check"`, `check`, `state`) when a check is created and when it ends.
//
// The job (./job.js):
//   POST   /api/projects/:id/layout/takeOver { steps, check } → 202 { job }; 400 STEPS · CHECK · RULES · NO_CHANGE; 409 JOB_OPEN ·
//          CHECK_OLD · DOCKER_UNREAD · LOCKED · NOT_CONVERTED · NOT_READY · relocation · SETUP_OPEN · COPY_OPEN · ROOT_IS_REPO
//   GET    /api/projects/:id/layout/job → 200 { job: { state, turned, backwards, step, error, since, steps, finalMapping, codeRepos,
//          holders, notices, report } } · 404 NO_JOB
//   DELETE /api/projects/:id/layout/job → 200 { ok } — only in `waiting` and `error` before the turning point; else 409 JOB_RUNNING,
//          without a job 404 NO_JOB
//   POST   /api/projects/:id/layout/job/again → 202 { job } — only in `error` (409 NOT_ERROR)
//   POST   /api/projects/:id/layout/holders/stop { kind, id } → 200 { ok, job } — 404 HOLDER_UNKNOWN, 409 NOT_STOPPABLE · NOT_WAITING
//   Event `project/layout` (`kind: "job"`, `state`, `step`) at every transition of the job.
//
// "Remove old containers" (./superseded.js — answer shape and procedure in the header there):
//   GET  /api/projects/:id/superseded → 200 { stacks, stays, total, running, last? } · 409 NOT_CONVERTED · NOT_READY (also if the daemon
//        does not answer — never an empty list)
//   GET  /api/projects/:id/superseded?status=1 → 200 { running, last: end | null } WITHOUT docker · 409 NOT_CONVERTED (for a client that
//        lost the end event in a gap of the stream; the same route, only the query — any value other than "1" is the full GET)
//   POST /api/projects/:id/superseded/remove { confirmed: { container: [id], running: [id], volumes: [name], networks: [id],
//        images: [id] } } → 202 { ok, since } · 400 CONFIRMATION_MISSING (also without `running`) · 409 NOT_CONVERTED · relocation ·
//        SETUP_OPEN · COPY_OPEN (with `name`) · LAYOUT_OPEN (with `state`) · RUNNING · OCCUPIED (with `what`) · NOT_READY
//   Event `project/superseded` at the end of the removal (with `since` of the 202 answer). From a project network the fence rejects
//   `/superseded/**` (row "project-superseded"): only the human removes old containers.

import { T } from "../../i18n.js";
import { NEXT, readBody, send } from "../../runtime/http.js";
import { ONLY_IN_OPS, projectboxOps } from "../ops.js";
import * as store from "../../store.js";
import { LayoutError, levelsPathError, layoutLevel, normalizeSteps, checkView, startCheck } from "./read.js";
import { jobView, again, stopHolder, takeOver, revert } from "./job.js";
import { SupersededError, supersededView, supersededStatus, startSuperseded } from "./superseded.js";

const no = (res, status, code, text, fields = {}) => send(res, status, { code, error: text, ...fields });
const CHECK_RE = /^\/layout\/check\/([0-9a-f-]{36})$/;

function errorResponse(res, e) {
  if (!(e instanceof LayoutError)) throw e;
  const { name: _n, code, status, message, ...fields } = e;
  return send(res, status || 500, { code, error: message, ...fields });
}

export async function layoutProjectRoutes(ctx) {
  const { req, res, url, m, pid, sub, proj } = ctx;
  // ── remove old containers ──
  if (sub === "/superseded" && m === "GET") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    try { return send(res, 200, url.searchParams.get("status") === "1" ? supersededStatus(pid) : await supersededView(pid)); } catch (e) {
      if (!(e instanceof SupersededError)) throw e;
      return send(res, e.status, { code: e.code, error: e.message });
    }
  }
  if (sub === "/superseded/remove" && m === "POST") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    const r = startSuperseded(pid, await readBody(req));
    return send(res, r.status, r.body);
  }
  if (sub !== "/layout" && !sub.startsWith("/layout/")) return NEXT;

  if (sub === "/layout" && m === "GET") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    const path = url.searchParams.get("path") ?? "";
    const wrong = levelsPathError(path);
    if (wrong) return no(res, 400, "PATH", T`“path” is invalid: ${wrong}.`);
    try { return send(res, 200, await layoutLevel(pid, proj, path)); } catch (e) { return errorResponse(res, e); }
  }

  if (sub === "/layout/check" && m === "POST") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    const n = normalizeSteps(await readBody(req));
    if (n.error) return no(res, 400, "STEPS", n.error);
    const open = store.layoutOpen(pid);
    if (open) return no(res, 409, "JOB_OPEN", T`An order is open (${open.state}) — check again afterwards.`, { state: open.state });
    try { return send(res, 202, { check: await startCheck(pid, proj, n.steps) }); } catch (e) { return errorResponse(res, e); }
  }

  // ── the job ──
  const including = (r) => send(res, r.status, r.body);
  if (sub === "/layout/takeOver" && m === "POST") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    return including(await takeOver(pid, proj, await readBody(req)));
  }
  if (sub === "/layout/job" && m === "GET") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    const a = jobView(pid);
    if (!a) return no(res, 404, "NO_JOB", T("There is no order."));
    return send(res, 200, { job: a });
  }
  if (sub === "/layout/job" && m === "DELETE") return including(revert(pid));
  if (sub === "/layout/job/again" && m === "POST") return including(again(pid));
  if (sub === "/layout/holders/stop" && m === "POST") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    return including(await stopHolder(pid, proj, await readBody(req)));
  }

  const pm = CHECK_RE.exec(sub);
  if (pm && m === "GET") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    const s = checkView(pid, pm[1]);
    if (!s) return no(res, 404, "CHECK_UNKNOWN", T("This check does not exist (any more) — please check again."));
    return send(res, 200, s);
  }
  return NEXT;
}
