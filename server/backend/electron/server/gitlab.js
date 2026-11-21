// GitLab integration for trigger nodes: verify the account, search projects/groups and poll events. Deliberately WITHOUT
// dependency (fetch from Node) and without DB access: the caller passes in the account (with token) and the trigger
// configuration and gets normalized events back.
//
// Why POLLING and not webhooks: cbase runs locally or in a private container, and a URL reachable from GitLab usually does not
// exist, so we ask. All queries are "since" queries (created_after/updated_after, or after=<date> for the event feed) and are
// additionally deduplicated by an event key: GitLab filters by whole days or inclusive of the boundary, so without
// deduplication the same merge request would trigger repeatedly.
import { T } from "./i18n.js";

const TIMEOUT_MS = 15_000;
const PER_PAGE = 20;         // search for projects and groups (selection in the editor)
// Events: per kind ASCENDING from its line (waterline), per query at most PAGE x PAGES_MAX entries; what lies beyond comes in the
// next tick from the last entry read, and the status says so. Reading one page of the newest 20 silently dropped what lay below
// (the backlog is produced by the own cap of 3 active runs). Reading descending down to the line silenced a kind with more than
// 1,000 entries since the line for good, because since a line entries only accumulate (a token expired during a holiday, an app
// closed for days, a backlog behind the active cap), and even a brand-new MR no longer triggered. Read ascending, every backlog
// drains over several ticks: nothing drops, nothing stalls.
const PAGE = 100;           // GitLab's maximum for per_page
const PAGES_MAX = 10;       // at most 1,000 entries per kind and query, the rest on the next tick
const PREVIEW = PER_PAGE;   // the dry run ("Check now"): one page per kind, the newest

// Normalize the host to "https://gitlab.com" (no path, no trailing slash).
export function normalizeHost(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return "";
    return `${u.protocol}//${u.host}`;
  } catch { return ""; }
}

// One API call. Errors are turned into meaningful, TRANSLATED messages: they land in the UI (account card, trigger status),
// not in the log.
async function call(account, path, params = {}) {
  const host = normalizeHost(account?.host);
  if (!host) throw new Error(T("Not a valid GitLab host."));
  if (!account?.token) throw new Error(T("No token stored."));
  const url = new URL(`${host}/api/v4${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": account.token, Accept: "application/json" },
      signal: ctl.signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(T("GitLab is not responding (timeout)."));
    throw new Error(T`Cannot reach GitLab: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new Error(T("Token invalid or expired (401)."));
  if (res.status === 403) throw new Error(T("Token lacks permissions for this call (403)."));
  if (res.status === 404) throw new Error(T("Not found (404) — check project/group."));
  if (res.status === 429) throw new Error(T("GitLab is rate limiting (429) — increase the interval."));
  if (!res.ok) throw new Error(T`GitLab error ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new Error(T("Response was not JSON — is this a GitLab server?"));
  }
}

// List call: for lists GitLab always returns an array; anything else would be a surprise (wrong path, proxy answer) and should
// show up as an error, not as an empty list.
async function list(account, path, params) {
  const rows = await call(account, path, params);
  if (!Array.isArray(rows)) throw new Error(T("Unexpected response from GitLab."));
  return rows;
}

// Verify the token and determine the account behind it (GET /user).
export async function verifyAccount({ host, token }) {
  const me = await call({ host, token }, "/user");
  return { userId: Number(me?.id) || 0, userName: String(me?.username || ""), name: String(me?.name || ""), webUrl: String(me?.web_url || "") };
}

// Projects the account is a member of (search optional). `id` is the numeric GitLab id.
export async function searchProjects(account, search = "") {
  const rows = await list(account, "/projects", {
    membership: true, simple: true, per_page: PER_PAGE, order_by: "last_activity_at",
    search: String(search || "").trim() || undefined,
  });
  return rows.map((p) => ({
    id: String(p.id), path: String(p.path_with_namespace || ""), name: String(p.name || ""), webUrl: String(p.web_url || ""),
  }));
}
export async function searchGroups(account, search = "") {
  const rows = await list(account, "/groups", {
    min_access_level: 20, per_page: PER_PAGE, order_by: "name", sort: "asc",
    search: String(search || "").trim() || undefined,
  });
  return rows.map((g) => ({
    id: String(g.id), path: String(g.full_path || ""), name: String(g.full_name || g.name || ""), webUrl: String(g.web_url || ""),
  }));
}

// ── Events ─────────────────────────────────────────────────────────────────────────────────────
const ms = (v) => { const t = Date.parse(String(v || "")); return Number.isFinite(t) ? t : 0; };
const iso = (t) => new Date(Math.max(0, t)).toISOString();
const day = (t) => iso(t).slice(0, 10);
const cut = (s, n = 2000) => String(s ?? "").slice(0, n);

// Base path per scope. MRs and work items exist globally and per group, everything else hangs on the project (workflows.js
// already checks this on save).
function scopeBase(trigger) {
  if (trigger.scope === "project") return `/projects/${encodeURIComponent(trigger.projectId)}`;
  if (trigger.scope === "group") return `/groups/${encodeURIComponent(trigger.groupId)}`;
  return ""; // instance-wide: /merge_requests?scope=all
}
const labelParam = (trigger) => (trigger.labels ? trigger.labels.split(",").map((s) => s.trim()).filter(Boolean).join(",") : undefined);
const projectName = (row) => String(row?.references?.full || "").replace(/[!#].*$/, "") || "";

// A merge request -> event.
function mrEvent(kind, mr, at) {
  return {
    kind, at,
    key: `${kind}:${mr.project_id}:${mr.iid}${kind === "mr_updated" ? `:${at}` : ""}`,
    ref: `!${mr.iid}`,
    title: cut(mr.title, 300),
    url: cut(mr.web_url, 500),
    project: projectName(mr) || String(mr.project_id || ""),
    author: String(mr.author?.username || ""),
    authorId: Number(mr.author?.id) || 0,
    branch: String(mr.source_branch || ""),
    targetBranch: String(mr.target_branch || ""),
    labels: Array.isArray(mr.labels) ? mr.labels.map(String) : [],
    description: cut(mr.description),
  };
}
function issueEvent(kind, issue, at) {
  return {
    kind, at,
    key: `${kind}:${issue.project_id}:${issue.iid}`,
    ref: `#${issue.iid}`,
    title: cut(issue.title, 300),
    url: cut(issue.web_url, 500),
    project: projectName(issue) || String(issue.project_id || ""),
    author: String(issue.author?.username || ""),
    authorId: Number(issue.author?.id) || 0,
    labels: Array.isArray(issue.labels) ? issue.labels.map(String) : [],
    description: cut(issue.description),
    extra: issue.issue_type && issue.issue_type !== "issue" ? `Type: ${issue.issue_type}` : "",
  };
}

// What ONE event kind queries: `path`; `params(ab)`, the filters with the time boundary from `ab`, without direction and page;
// `time(row)`, the sort time GitLab orders the list by and at which reading continues; `keyset`, the time boundary is exact, so
// every further page begins at the last timestamp read instead of at a page offset (ascending by `updated_at`, an entry changed
// during reading moves to the end; with an offset everything behind it would shift forward by one and one would fall between
// two pages); `map(rows)` -> events. Unknown kind: null.
function kindQuery(trigger, kind, me) {
  const base = scopeBase(trigger);
  const labels = labelParam(trigger);
  const all = base ? {} : { scope: "all" };
  const branch = trigger.branch || undefined;
  const created = (r) => ms(r.created_at);
  const changed = (r) => ms(r.updated_at);
  const listItems = (path, filter, to, map) => ({
    path: `${base}/${path}`, keyset: true, time: to === "created_at" ? created : changed, map,
    params: (start) => ({ labels, ...all, ...filter, order_by: to, [to === "created_at" ? "created_after" : "updated_after"]: iso(start) }),
  });
  const asMr = (moment) => (rows) => rows.map((mr) => mrEvent(kind, mr, moment(mr)));
  const asIssue = (moment) => (rows) => rows.map((it) => issueEvent(kind, it, moment(it)));

  if (kind === "mr_opened") return listItems("merge_requests", { state: "opened", target_branch: branch }, "created_at", asMr(created));
  // Creating is also a change; otherwise "updated" fires with every new MR.
  if (kind === "mr_updated") {
    return listItems("merge_requests", { state: "opened", target_branch: branch }, "updated_at",
      (rows) => asMr(changed)(rows.filter((mr) => ms(mr.created_at) !== ms(mr.updated_at))));
  }
  if (kind === "mr_merged") return listItems("merge_requests", { state: "merged", target_branch: branch }, "updated_at", asMr((mr) => ms(mr.merged_at || mr.updated_at)));
  if (kind === "mr_closed") return listItems("merge_requests", { state: "closed", target_branch: branch }, "updated_at", asMr((mr) => ms(mr.closed_at || mr.updated_at)));
  if (kind === "mr_review_requested") return listItems("merge_requests", { state: "opened", reviewer_id: me.userId }, "updated_at", asMr(changed));
  if (kind === "issue_opened") return listItems("issues", { state: "opened" }, "created_at", asIssue(created));
  if (kind === "issue_closed") return listItems("issues", { state: "closed" }, "updated_at", asIssue((it) => ms(it.closed_at || it.updated_at)));
  if (kind === "issue_assigned") return listItems("issues", { state: "opened", assignee_id: me.userId }, "updated_at", asIssue(changed));
  // The project's event feed: comments and pushes. `after` filters only by whole days (and exclusive), so ask for the previous
  // day and filter by timestamp ourselves. No exact time boundary, hence no keyset: reading uses a page offset, which holds
  // because the feed is ordered by `created_at` and only grows at the end. The lead-in before the line (up to a day) is skipped
  // by `firstPageAfterLine`.
  if (kind === "comment" || kind === "push") {
    return {
      path: `${base}/events`, keyset: false, time: created,
      params: (start) => ({ action: kind === "comment" ? "commented" : "pushed", after: day(start - 86_400_000) }),
      map: (rows) => {
        const out = [];
        for (const ev of rows) {
          const at = ms(ev.created_at);
          const author = String(ev.author?.username || "");
          const authorId = Number(ev.author?.id) || 0;
          if (kind === "comment") {
            const note = ev.note || {};
            const target = String(ev.target_type || note.noteable_type || "");
            const iid = ev.target_iid || note.noteable_iid || "";
            out.push({
              kind, at, key: `comment:${ev.id}`,
              ref: target === "MergeRequest" ? `!${iid}` : target === "Issue" ? `#${iid}` : String(ev.id),
              title: cut(ev.target_title || note.body, 300),
              url: cut(note.url || "", 500),
              project: String(trigger.projectPath || ""),
              author, authorId,
              description: cut(note.body, 1500),
              extra: target ? `Comment on: ${target}` : "",
            });
          } else {
            const pd = ev.push_data || {};
            const ref = String(pd.ref || "");
            if (trigger.branch && ref !== trigger.branch) continue;
            out.push({
              kind, at, key: `push:${ev.id}`,
              ref: String(pd.commit_to || "").slice(0, 8),
              title: cut(pd.commit_title || `${pd.commit_count || 0} commit(s)`, 300),
              url: "",
              project: String(trigger.projectPath || ""),
              author, authorId,
              branch: ref,
              extra: `${pd.commit_count || 0} commit(s) on ${ref || "?"}${pd.ref_type === "tag" ? " (tag)" : ""}`,
            });
          }
        }
        return out;
      },
    };
  }
  if (kind === "pipeline_failed" || kind === "pipeline_succeeded") {
    return {
      path: `${base}/pipelines`, keyset: true, time: (p) => ms(p.updated_at || p.created_at),
      params: (start) => ({ status: kind === "pipeline_failed" ? "failed" : "success", order_by: "updated_at", updated_after: iso(start), ref: branch }),
      map: (rows) => rows.map((p) => ({
        kind, at: ms(p.updated_at || p.created_at),
        key: `${kind}:${p.id}`,
        ref: `#${p.id}`,
        title: cut(`Pipeline ${p.status} (${p.ref || ""})`, 300),
        url: cut(p.web_url, 500),
        project: String(trigger.projectPath || ""),
        author: "", authorId: 0,
        branch: String(p.ref || ""),
        extra: `Pipeline ${p.id}: ${p.status}${p.source ? ` (${p.source})` : ""}`,
      })),
    };
  }
  return null;
}

// The first page of an ASCENDING list on which the line `ab` is crossed or the list ends. Whole pages at or before the line
// (lead-in) exist in the event feed (`after` filters by whole days, a busy project has thousands before); they are skipped by
// galloping (page 1, 2, 4, 8 ..., then halving) instead of eating the page budget: with more than PAGES_MAX lead-in pages the
// kind would otherwise stall for good. With an exact time boundary page 1 already suffices.
async function firstPageAfterLine(fetch, start, time) {
  const beforehand = (part) => part.length === PAGE && time(part[part.length - 1]) <= start;
  let part = await fetch(1);
  if (!beforehand(part)) return { page: 1, part };
  let lo = 1;
  let hi = 2;
  for (;;) {
    part = await fetch(hi);
    if (!beforehand(part)) break;
    // A list that never ends is no feed (wrong path, proxy): fail loudly instead of looping forever.
    if (hi >= 2 ** 16) throw new Error(T("More than 6 million entries before the line — check GitLab's response."));
    lo = hi;
    hi *= 2;
  }
  let hits = { page: hi, part };
  while (hi - lo > 1) {
    const middle = Math.floor((lo + hi) / 2);
    const t = await fetch(middle);
    if (beforehand(t)) lo = middle;
    else { hi = middle; hits = { page: middle, part: t }; }
  }
  return hits;
}

// Read a kind ASCENDING from `ab` (at most PAGES_MAX pages). `complete` means: read to the end of the list. Otherwise `further`
// says where the next tick resumes, one millisecond BEFORE the last entry read, since behind the page boundary there can be
// entries with the same timestamp (what of them already fired is kept by `seen` in workflows/triggers.js). If a whole read
// carries the same timestamp, that would not advance: then it continues behind it, and `jumped` names it.
async function fromLine(account, kind, start) {
  let from = start;
  const fetch = (page) => list(account, kind.path, { ...kind.params(from), sort: "asc", per_page: PAGE, page });
  const rows = [];
  let { page, part } = await firstPageAfterLine(fetch, start, kind.time);
  for (let read = 1; ; read++) {
    rows.push(...part);
    if (part.length < PAGE) return { rows, complete: true };
    const last = kind.time(part[part.length - 1]);
    if (read >= PAGES_MAX) {
      return last - 1 > start
        ? { rows, complete: false, further: last - 1 }
        : { rows, complete: false, further: Math.max(last, start + 1), jumped: last };
    }
    if (kind.keyset && last - 1 > from) { from = last - 1; page = 1; } else page += 1;
    part = await fetch(page);
  }
}

// Poll all selected event kinds of a trigger. Errors of ONE kind do not abort the poll (a missing right on pipelines should not
// prevent new MRs); they land in `errors`, cap sentences in `hints`, and the caller writes both into the trigger status.
//
// `line` is a number (all kinds from the same line, the dry run) or a function kind -> ms (the line PER KIND): events count only
// after it. `further` (kind -> ms or undefined) is the read pointer of a backlog: reading starts there, the events' line stays
// put until the kind is fully read, so an entry whose sort time lies behind the pointer but whose event lies before it (a merged
// MR, renamed later) still fires. Result per kind: `positions[kind]` = up to where it is COMPLETELY read (the line may move there),
// or `further[kind]` = where the backlog continues on the next tick; a failed kind is missing in both.
//
// `preview: true` (the dry run "Check now"): ONE page per kind, the newest. It shows what the settings hit and says nothing about
// what the live trigger fires (it reads from its own line).
export async function pollTrigger(account, trigger, line, { further: continueFor = () => undefined, preview = false } = {}) {
  const lineFor = typeof line === "function" ? line : () => line;
  const me = { userId: account.userId || 0 };
  if (!me.userId && trigger.events.some((e) => e === "mr_review_requested" || e === "issue_assigned")) {
    const who = await verifyAccount(account);
    me.userId = who.userId;
  }
  const events = [];
  const errors = [];
  const hints = [];
  const positions = {};
  const further = {};
  const previewFull = [];
  for (const kind of trigger.events) {
    const l = lineFor(kind);
    const kindName = kindQuery(trigger, kind, me);
    if (!kindName) { positions[kind] = l; continue; }
    try {
      if (preview) {
        const rows = await list(account, kindName.path, { ...kindName.params(l), sort: "desc", per_page: PREVIEW, page: 1 });
        events.push(...kindName.map(rows).filter((e) => e.at > l));
        // A full page whose oldest entry still lies after the line: there is more behind it (the feed delivers its lead-in before
        // the line, so if the page reaches there it is complete).
        if (rows.length >= PREVIEW && kindName.time(rows[rows.length - 1]) > l) previewFull.push(kind);
        continue;
      }
      const start = Math.max(l, Number(continueFor(kind)) || 0);
      const r = await fromLine(account, kindName, start);
      // What stands at or before the read pointer is already processed (the feed delivers its lead-in); what comes after and whose
      // event lies after the line is counted.
      events.push(...kindName.map(r.rows.filter((row) => kindName.time(row) > start)).filter((e) => e.at > l));
      if (r.complete) {
        positions[kind] = r.rows.length ? Math.max(start, kindName.time(r.rows[r.rows.length - 1])) : start;
        continue;
      }
      further[kind] = r.further;
      const n = PAGE * PAGES_MAX;
      // The cap says that it is one, and nothing about a stall that does not exist. No time given for "continue from": the caller
      // resets the pointer behind a deferred event (workflows/triggers.js).
      hints.push(`${kind}: ${r.jumped
        ? T`more than ${n} entries with the same timestamp ${iso(r.jumped)} — the rest of them were skipped, further entries follow on the next poll.`
        : T`more than ${n} entries since ${iso(start)} — the rest on the next poll.`}`);
    } catch (e) {
      errors.push(`${kind}: ${e?.message || e}`);
    }
  }
  if (previewFull.length) {
    const since = iso(lineFor(previewFull[0]));
    hints.push(T`Preview: the newest ${PREVIEW} per event type — ${previewFull.join(", ")} has more since ${since}.`);
  }
  // Read page by page an entry can come twice (a keyset boundary, an entry changed during reading): once per key.
  const once = [...new Map(events.map((e) => [e.key, e])).values()];
  // Skip own events (against self-triggering by the agent).
  const filtered = trigger.skipMine && me.userId
    ? once.filter((e) => !e.authorId || e.authorId !== me.userId)
    : once;
  filtered.sort((a, b) => a.at - b.at); // oldest first: they should fire in that order
  return { events: filtered, errors, hints, positions, further, userId: me.userId };
}
