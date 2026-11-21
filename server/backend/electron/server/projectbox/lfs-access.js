// The route of the LFS access — git access of the agent shells (LFS and https; the name stays).
//
// POST /api/projects/:id/lfs-access   body `{ host, path?, protocol? }` → 200 `{ access: { username, password } | null }`;
//                                     body `{ host, rejected }` (see "THE REJECTION") → 200 `{ ok: true }`.
//   Asked by the git credential helper server/backend/cbase-lfs-access from an agent shell of a project container (only when git-lfs
//   asks or — since the https extension — git itself over https: fetch/pull/push/ls-remote/clone; the helper checks the descent, not
//   the route). The order of the checks is the statement:
//     1. without an ops marker 404 `ONLY_IN_OPS` (the local server and B without an inner Docker do not have the route);
//     2. without a fence context (`ctx.fence`, set only with the valid token of an instance — projectbox/fence.js fenceRequest) 403,
//        and likewise if the project of the path is not that of the token (the fence checks `:project` already; here once more, because
//        the route would otherwise silently answer a foreign project as soon as someone changed the row). NO path gate: `path` only
//        comes along, it is not evaluated (the helper asks with the path of the remote, see there "THE PATH GATE IS REFUTED");
//        plus the SOURCE: the request comes from the project network of the token's instance (`inNetwork(requestSource(req),
//        fence.instance.subnet)`, projectbox/fence.js), else 403 — a token that gets out of the project (log, copy into another
//        container) fetches no access from outside. The helper reaches the route via the address in the project network
//        (CBASE_LFS_URL from runs/lfs-environment.js ← backendAccessFor);
//     3. the body: no JSON 400, a host that is not `hostname[:port]` 400; `protocol` other than "https" ⇒ `{ access: null }`;
//     4. what is searched is the stored git access of the WORKSPACE (store.getGitCred, the same stock as the management git and
//        cbase-project in B) under the hostname LOWER CASE and without port — that is how the UI stores it (devtools/code-route.js
//        PUT /git/creds) and how workspaces/git-auth.js gitAuthCtx searches it. The workspace comes from the instance's project
//        (`fence.projectId`), NEVER from the body. No access ⇒ `{ access: null }` (the helper reports a line, git asks on).
//   `Cache-Control: no-store` on every response (Cloudflare caches otherwise what carries no `private` marker). Neither value nor user
//   stands in a log or event — the route writes none; messages name at most the host.
//
// WHY NOT THE ACCESS ROUTE OF THE WRAPPER. `POST /api/workspaces/:id/git-access` (git-assignment.js gitAccessResponse) stays only for
// cbase-project in B (loopback + key in `<data>/git-access.key`, fence row "git-access" rejected): it hands out ALL wanted hosts and
// belongs to VS Code. This route is the one exception from the project network (fence row "lfs-access", allowed, POST only, copies
// included) — ONE host per request, only with the token of the instance.
//
// THE REJECTION: on `erase` from git-lfs the helper reports the sha256 (hex) of `username + "\n" + password` of the rejected access
// (never the value). The route remembers it in the MEMORY of B (a map; no clock, no schema — a restart forgets, then git-lfs loops at
// most until the next erase) per (workspace of the project, hostname lower case) — but ONLY if it is the fingerprint of the STORED
// access (a foreign fingerprint has no effect: it would otherwise block an access that nobody rejected). A `get` answers `{ access:
// null }` as long as the stored access has the same fingerprint; a newly stored access (another fingerprint) counts again at once. So
// git-lfs ends after ONE 401 instead of looping without end. Answer `{ ok: true }` in every valid case (the helper does not read it);
// a `rejected` that is no sha256 hex, 400.
//
// RISK: the value is then readable for the agent (its shell carries URL and credential, it can call the route itself or point the real
// git-lfs at any remote) — the descent check in the helper only keeps other ways than git-lfs and git over https from getting the
// access BY THEMSELVES.
//
// Guards: server/backend/test/lfs-access.test.js (route through the fence, the four names at the agent starts),
// server/backend/test/fence.test.js (the row), server/backend/test/dispatcher.test.js (404 without operations),
// tools/check/routes.test.mjs (NEW_WITHOUT_GET).
import crypto from "node:crypto";

import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBody } from "../runtime/http.js";
import { ONLY_IN_OPS, projectboxOps } from "./ops.js";
import { requestSource, inNetwork } from "./fence.js";

// `hostname[:port]` — like HOST_PATTERN in projectbox/git-assignment.js, here with port (git sends `host=h:8443`). The same pattern
// stands in the helper (so the value arrives already checked; here once more, because anyone with the token can call the route).
export const LFS_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;

const NO_FENCE = () => T(
  "LFS access: only from an agent shell of a project container, with the token of its instance",
);

// THE REJECTION (header): `<workspaceId>\n<hostname>` → sha256 hex of the rejected access. Memory only.
const rejected = new Map();
const FINGERPRINT = /^[0-9a-f]{64}$/;
const fingerprintOf = (c) => crypto.createHash("sha256").update(`${String(c.username)}\n${String(c.secret || "")}`, "utf8").digest("hex");
/** Test seam: forget the remembered rejections (a restart of B does the same). */
export const forgetLfsRejections = () => rejected.clear();

/**
 * The answer without HTTP: `{ status, body }`. `fence` = ctx.fence (or undefined), `projectId` = the identifier in the path, `body` =
 * the read body (`null`: not readable), `source` = the address of the request (fence.js requestSource).
 */
export function lfsAccessResponse({ fence, projectId, body, source }) {
  if (!projectboxOps()) return { status: 404, body: { error: ONLY_IN_OPS } };
  if (!fence || typeof fence.projectId !== "string" || !fence.projectId) return { status: 403, body: { error: NO_FENCE() } };
  if (fence.projectId !== projectId) {
    return { status: 403, body: { error: T("LFS access: only for the token's own project") } };
  }
  // Only from the project network of the token's instance (header, check 2).
  if (!inNetwork(String(source || ""), String(fence.instance?.subnet || ""))) {
    return { status: 403, body: { error: T("LFS access: only from the project network of the token's instance") } };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: T("LFS access: the body is not a JSON object") } };
  }
  const host = body.host;
  if (typeof host !== "string" || !LFS_HOST_PATTERN.test(host)) {
    return { status: 400, body: { error: T("LFS access: host is hostname[:port]") } };
  }
  const hostname = host.split(":")[0].toLowerCase();
  const workspaceId = store.getProject(fence.projectId)?.workspaceId || null;
  // THE REJECTION (header): remember if it is the fingerprint of the stored access — otherwise nothing.
  if (body.rejected !== undefined) {
    if (typeof body.rejected !== "string" || !FINGERPRINT.test(body.rejected)) {
      return { status: 400, body: { error: T("LFS access: rejected is a sha256 (hex)") } };
    }
    const c = workspaceId ? store.getGitCred(workspaceId, hostname) : null;
    if (c?.username && fingerprintOf(c) === body.rejected) rejected.set(`${workspaceId}\n${hostname}`, body.rejected);
    return { status: 200, body: { ok: true } };
  }
  if (body.protocol !== undefined && body.protocol !== "https") return { status: 200, body: { access: null } };
  if (!workspaceId) return { status: 200, body: { access: null } };
  const c = store.getGitCred(workspaceId, hostname);
  if (!c?.username) return { status: 200, body: { access: null } };
  const key = `${workspaceId}\n${hostname}`;
  const remembered = rejected.get(key);
  if (remembered) {
    if (remembered === fingerprintOf(c)) return { status: 200, body: { access: null } }; // rejected, and it is still the same access
    rejected.delete(key); // a newly stored access counts again at once
  }
  return { status: 200, body: { access: { username: String(c.username), password: String(c.secret || "") } } };
}

// Sub-route of projects/routes.js projectRoutes (ctx with pid/sub/proj).
export async function lfsAccessProjectRoutes(ctx) {
  const { req, res, m, pid, sub } = ctx;
  if (sub === "/lfs-access" && m === "POST") {
    // First operations and fence, THEN the body: without both the route reads nothing (and a 404/403 names no body error).
    const source = requestSource(req);
    const upfront = lfsAccessResponse({ fence: ctx.fence, projectId: pid, body: {}, source });
    if (upfront.status === 404 || upfront.status === 403) { respond(res, upfront); return; }
    let body = null;
    try { body = await readBody(req); } catch (e) {
      const status = Number(e?.status) === 413 || Number(e?.status) === 415 ? Number(e.status) : 400;
      respond(res, { status, body: { error: T("LFS access: the body is unreadable") } });
      return;
    }
    respond(res, lfsAccessResponse({ fence: ctx.fence, projectId: pid, body, source }));
    return;
  }
  return NEXT;
}

function respond(res, a) {
  res.writeHead(a.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(a.body));
}
