// The routes of the Git overview — a sub-slice of the owner `projectRoutes` (projects/routes.js, sub-table, BEFORE
// codeProjectRoutes: `/gitView` is not under the code route); ctx carries `pid`, `sub`, `proj` there.
//
//   GET  /api/projects/:pid/gitView?repo=&search=&fresh=1                overview.js gitView — `repo` missing ⇒ the server's
//                                                                         choice (the first repo), `fresh=1` re-reads every ready instance
//   POST /api/projects/:pid/gitView/fetch    { repo, instance, auto }    fetch.js
//   GET  /api/projects/:pid/gitView/branch?repo=&instance=&name=         detail.js branchDetail
//   GET  /api/projects/:pid/gitView/diff?repo=&instance=&name=&file=     detail.js fileDiff
//
// COMMON (like the instances, projectbox/instances-tree.js): without the ops marker 404 "only in server operation" before
// anything is read; a project that is not converted is 409 NOT_CONVERTED. Not reachable from project networks (fence row
// "project-git-view", projectbox/fence-table.js): the view belongs to the user, agents read git in their container
// themselves. Errors go out as `{ error, code? }` (`state` with INSTANCE_NOT_READY, `reason` with READ_FAILED/READ_TIME);
// an unexpected throw is a 500 with a log line. ONE function checks the parameter `repo` for all four routes (repos.js
// repoChoice: 400 REPO_INVALID, 404 UNKNOWN_REPO — only code repos of the project, never an arbitrary folder in it).
//
// Guards: server/backend/test/gitView.test.js, git-view-fetch.test.js, git-view-detail.test.js; the sub-slice in
// dispatcher.test.js and tools/check/lib/tree-rules.mjs.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBodyOrEmpty, send } from "../runtime/http.js";
import { ONLY_IN_OPS, projectboxOps } from "../projectbox/ops.js";
import { gitViewFetch } from "./fetch.js";
import { branchDetail, fileDiff } from "./detail.js";
import { gitView } from "./overview.js";

function errorSend(res, e, where) {
  const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status === 500) console.error(`[gitView] ${where}:`, e?.message || e);
  const text = String(e?.message || e);
  return send(res, status, { error: text, ...(e?.code ? { code: String(e.code) } : {}), ...(e?.state !== undefined ? { state: e.state } : {}), ...(e?.reason ? { reason: String(e.reason) } : {}) });
}

export async function gitViewProjectRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
  const { sub, proj } = ctx;
  if (sub === "/gitView" || String(sub || "").startsWith("/gitView/")) {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    if (!store.converted(String(proj.id))) {
      const text = T`Project ${proj.id} has not been moved — the Git overview exists only for moved projects.`;
      return send(res, 409, { error: text, code: "NOT_CONVERTED" });
    }
    if (sub === "/gitView" && m === "GET") {
      const q = url.searchParams;
      const repo = q.has("repo") ? q.get("repo") : null; // missing ⇒ the server's choice; "" is the project folder (checked: repos.js repoChoice)
      try { return send(res, 200, await gitView(proj, { repo, search: q.get("search") || "", fresh: q.get("fresh") === "1" })); }
      catch (e) { return errorSend(res, e, `${m} ${p}`); }
    }
    if (sub === "/gitView/fetch" && m === "POST") {
      let b;
      try { b = await readBodyOrEmpty(req); } catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
      try { const r = await gitViewFetch(proj, b || {}); return send(res, r.status, r.body); }
      catch (e) { return errorSend(res, e, `${m} ${p}`); }
    }
    if ((sub === "/gitView/branch" || sub === "/gitView/diff") && m === "GET") {
      const q = url.searchParams;
      const query = { repo: q.get("repo"), instance: q.get("instance"), name: q.get("name"), file: q.get("file") };
      try {
        return send(res, 200, sub === "/gitView/branch" ? await branchDetail(proj, query) : await fileDiff(proj, query));
      } catch (e) { return errorSend(res, e, `${m} ${p}`); }
    }
  }
  return NEXT;
}
