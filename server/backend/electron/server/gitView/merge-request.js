// The open merge request of a branch for the git overview (detail.js) — asked DIRECTLY at GitLab (API v4) with the GitLab account
// whose host is the host of the remote (`gitlab_accounts`, Settings → GitLab; the same accounts as the workflow trigger nodes).
// There is no passthrough service: the read token of an account never leaves the server, and
// the git view routes are rejected from project networks (fence row "project-git-view"), so this is only asked from B.
//
// Account choice: the first account (oldest first, store order) whose normalized host (gitlab.js normalizeHost) has the hostname of
// the remote (git.js remoteLocation gives the hostname without port and protocol); the API base is that account's own host — with
// its protocol and port. Without such an account the repo is "no GitLab" (no row in the UI), not "no access": a GitHub remote has
// no GitLab account, and a missing account is no broken access.
// Known limit: a remote through an SSH host alias (`git@work:group/app.git`, the real host only in ~/.ssh/config) has the
// alias as its hostname and finds no account — the git view then shows no MR row for it.
//
// → `{ state: "no-gitlab" | "no-access" | "none" }`, `{ state: "error", error }` or `{ iid, title, target, pipeline, url }`
// (`pipeline` = `{ status, url }` or null). Never throws. `signal` (optional) aborts both calls — the detail passes one with a
// deadline for BOTH together (detail.js mrWithDeadline); MR_DEADLINE_MS stays the cap per call.
//
// Guard: server/backend/test/git-view-detail.test.js (a fake GitLab at the account's host).
import * as store from "../store.js";
import { normalizeHost } from "../gitlab.js";
import { T } from "../i18n.js";

const MR_DEADLINE_MS = 35_000;

/** The account (with token) for the hostname of a remote, or null. */
export function accountForHost(hostname) {
  const want = String(hostname || "").toLowerCase();
  if (!want) return null;
  for (const a of store.listGitlabAccounts()) {
    const host = normalizeHost(a.host);
    if (!host) continue;
    let name = "";
    try { name = new URL(host).hostname.toLowerCase(); } catch { continue; }
    if (name !== want) continue;
    const withToken = store.getGitlabAccountWithToken(a.id);
    return withToken?.token ? { base: host, token: withToken.token } : { base: host, token: "" };
  }
  return null;
}

export async function mergeRequestFor({ host, projectPath, sourceBranch, signal = null } = {}) {
  if (!host || !projectPath || !sourceBranch) return { state: "no-gitlab" };
  const account = accountForHost(host);
  if (!account) return { state: "no-gitlab" };
  if (!account.token) return { state: "no-access" };
  const project = `/projects/${encodeURIComponent(String(projectPath))}`;
  const fetchData = async (path, params) => {
    const target = new URL(`${account.base}/api/v4${path}`);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, String(v));
    const timeout = AbortSignal.timeout(MR_DEADLINE_MS);
    const r = await fetch(target, {
      headers: { "PRIVATE-TOKEN": account.token, accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    // An answer whose body is not read is cancelled, so the connection is free again at once.
    if (r.status === 401 || r.status === 403) { await r.body?.cancel().catch(() => {}); return { state: "no-access" }; }
    if (r.status === 404) { await r.body?.cancel().catch(() => {}); return { state: "no-gitlab" }; } // not in this GitLab (or invisible to the token)
    const txt = await r.text();
    if (!r.ok) return { state: "error", error: T`GitLab error ${r.status}.` };
    try { return { data: JSON.parse(txt) }; } catch { return { state: "error", error: T("Response was not JSON — is this a GitLab server?") }; }
  };
  try {
    const list = await fetchData(`${project}/merge_requests`, { state: "opened", source_branch: String(sourceBranch), per_page: "5" });
    if (list.state) return list;
    if (!Array.isArray(list.data)) return { state: "error", error: T("The MR list is not a list") };
    const mr = list.data.find((x) => Number.isSafeInteger(x?.iid));
    if (!mr) return { state: "none" };
    const result = { iid: mr.iid, title: String(mr.title ?? ""), target: String(mr.target_branch ?? ""), pipeline: null, url: typeof mr.web_url === "string" ? mr.web_url : null };
    // The pipeline is a bonus: if its call fails, the MR stays (pipeline null). `head_pipeline` is only on the single MR.
    const single = await fetchData(`${project}/merge_requests/${mr.iid}`, {}).catch(() => null);
    const hp = single && !single.state ? single.data?.head_pipeline : null;
    if (hp && typeof hp.status === "string") result.pipeline = { status: hp.status, url: typeof hp.web_url === "string" ? hp.web_url : null };
    return result;
  } catch (e) {
    return { state: "error", error: String(e?.message || e).slice(0, 300) };
  }
}
