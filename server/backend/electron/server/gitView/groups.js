// From the readings of a repo (main + copies) to the rows of the Git overview. Pure: no file, no git, no store — the
// readings come from read.js (parseReading/readInstance), the field names from contract.js (ROW_FIELDS,
// CHECKED_OUT_FIELDS). Guard: server/backend/test/git-view-groups.test.js.
//
// rowsFrom({ main, copies, search })  → { rows, clipped }
//   main     the reading of main (read.js) — an unread one (`read: false`) yields no row
//   copies   [{ name, reading }] in creation order; `reading` with `inSnapshot` per tip (read.js with `snapshot`)
//   search   substring of the name, case-insensitive — BEFORE the cap
//   clipped  null or { shown, total } (more than ROWS_MAX rows after the search)
//
// THE RULES
//   Pairing   a local branch and its upstream (`branch.<b>.merge`/`remote`, from for-each-ref `%(upstream)`) are ONE row,
//             even if the names differ (`feature/x` → `origin/x-new`) or the remote is not called origin. A remote ref
//             without a local partner is a row of the group "remote" — except the ref of the main branch itself (it is
//             the line at the top).
//   Groups    (contract.js GROUPS, in this order) `cbase` = every name under `cbase/` or `copy/` (for remote rows after
//             the remote name), ALSO when checked out; `checkedOut` = checked out in a worktree — the folder of main or
//             copy itself (`worktree: null`) or a worktree cbase did not create (cbase only creates `cbase/*`) —, plus
//             every detached HEAD as a row "detached @ <short-sha>"; `branches` = the remaining local ones; `remote` =
//             remote refs without a local partner. Per group descending by last commit (equal: by name).
//   Copies    only what is new or has moved since the freeze — measured against `inSnapshot`, NEVER against today's
//             main: a branch that main moved since then stands unchanged in the copy and yields no row. A moved copy row
//             carries `sinceCreation` (a new one `null`) and stands directly below the main row of the same name (in its
//             group); without a main row of the same name it stands in its own group. The copy's checked-out branch
//             always shows: unchanged as an entry in `checkedOut` of the main row of the same name (if there is none, as
//             a copy row). A remote ref of the copy that has moved but stands on the same commit in main is no row: both
//             fetched the same state, a second row would only be a duplicate.
//   Dots      `commits.points` up to POINTS_MAX, above that `null` (the UI draws a bar with `count`); `notFetched`
//             likewise. Without a main branch dots and `count` are null.
//   Cap       ROWS_MAX rows after the search, above that `clipped`.
//
// WHAT STAYS `null` HERE (a later building block fills it, groups.js knows nothing about it): `user`, `state` (user.js
// withUsers) and `checkedOut[].chats` (user.js withChats: the running chats of the instance, fresh from the run state on
// EVERY response — never from the cache of the reading).
//
// allRows({ main, copies, mainName })  → [row] — the same computation without search and cap (the detail looks for its
//   row in it, the small view filters the running ones). `mainName` = the name of the instance of the `main` reading
//   (default "main"; the small view IN a copy reads only that one and calls it so).
// counterFrom(rows)  → { checkedOut, branches, cbase, remote } — the count per group (`counter` of the small view, GIT_REPO_FIELDS).
//
// lineFrom(reading)  → { commits: [t…] | null, count, from, until } — the main line (first parents from the tip of the
//   main branch, ascending, the youngest LINE_MAX); `commits` null without a main branch or unread.

import { CHECKED_OUT_FIELDS, GROUPS, POINTS_MAX, ROWS_MAX, ROW_FIELDS } from "./contract.js";

/** Commits of the main line in the response at most (the youngest); `count` names all that were read. */
export const LINE_MAX = 1000;
export const MAIN = "main";

const CBASE_NAME = /^(cbase|copy)\//;
const shortRef = (ref) => String(ref).replace(/^refs\/(heads|remotes)\//, "");
const branchPart = (z) => (z.local ? z.name : z.name.slice(z.name.indexOf("/") + 1));
const detachedName = (oid) => `detached @ ${String(oid).slice(0, 7)}`;

function commitsOf(sp) {
  const count = sp.count ?? null;
  const points = Array.isArray(sp.points) && count != null && count <= POINTS_MAX ? sp.points.map((p) => ({ t: p.t, pushed: Boolean(p.pushed) })) : null;
  const notFetched = Array.isArray(sp.notFetched) && sp.notFetched.length <= POINTS_MAX ? [...sp.notFetched] : null;
  return { points, count, notFetched };
}

// The rows of ONE reading, still without a group; `_sp` = the tip, `_ref` = the full ref (null for the detached HEAD).
function rawRows(reading, instance) {
  if (!reading?.read) return [];
  const tips = reading.tips || [];
  const claimed = new Set(tips.filter((s) => s.kind === "local" && s.upstream).map((s) => s.upstream));
  const mainRef = reading.mainBranch?.ref || null;
  const perBranch = new Map(); const perDetached = new Map();
  for (const w of reading.worktrees || []) {
    const e = { instance, worktree: w.main ? null : w.path, notBackedUp: w.notBackedUp ?? null, chats: null };
    if (w.detached && w.oid) { if (!perDetached.has(w.oid)) perDetached.set(w.oid, []); perDetached.get(w.oid).push(e); }
    else if (w.branch) { if (!perBranch.has(w.branch)) perBranch.set(w.branch, []); perBranch.get(w.branch).push(e); }
  }
  const out = [];
  for (const sp of tips) {
    if (sp.kind === "remote" && (claimed.has(sp.ref) || sp.ref === mainRef)) continue;
    const detachedRef = sp.kind === "detached";
    out.push({
      name: detachedRef ? detachedName(sp.oid) : shortRef(sp.ref),
      local: sp.kind !== "remote",
      remote: sp.kind === "remote" ? shortRef(sp.ref) : sp.upstream ? shortRef(sp.upstream) : null,
      detached: detachedRef ? { sha: sp.oid } : null,
      instance,
      toRemote: sp.kind === "local" && sp.toUpstream ? { ahead: sp.toUpstream.ahead, back: sp.toUpstream.back } : null,
      toMain: sp.toMain ? { ahead: sp.toMain.ahead, back: sp.toMain.back, merged: Boolean(sp.toMain.merged) } : null,
      sinceCreation: null,
      branchPoint: sp.branchPoint ?? null,
      last: sp.last ? { t: sp.last.t ?? null, author: sp.last.author ?? "", subject: sp.last.subject ?? "" } : { t: null, author: "", subject: "" },
      commits: commitsOf(sp),
      checkedOut: (detachedRef ? perDetached.get(sp.oid) : perBranch.get(sp.ref)) || [],
      user: null,
      state: null,
      _sp: sp,
      _ref: sp.ref,
    });
  }
  return out;
}

function groupOf(z) {
  if (z.detached) return "checkedOut";
  if (CBASE_NAME.test(branchPart(z))) return "cbase";
  if (z.checkedOut.length) return "checkedOut";
  return z.local ? "branches" : "remote";
}

// Only the fields of the contract, in its order.
function form(z) {
  const out = {};
  for (const f of ROW_FIELDS) out[f] = z[f] ?? null;
  out.checkedOut = z.checkedOut.map((e) => Object.fromEntries(CHECKED_OUT_FIELDS.map((f) => [f, e[f] ?? null])));
  return out;
}

const afterLast = (a, b) => {
  const ta = a.last?.t; const tb = b.last?.t;
  if (ta == null && tb != null) return 1;
  if (tb == null && ta != null) return -1;
  if (ta !== tb) return tb - ta;
  return a.name.localeCompare(b.name);
};

// All rows of a repo in display order, raw (with `_sp`/`_ref`), still without search and cap. `mainName` is the name of
// the instance whose reading comes as `main` — "main" for the large view, the name of the copy for the small view IN a
// copy (small.js reads only this one instance there).
function ordered({ main = null, copies = [], mainName = MAIN } = {}) {
  const mainRows = rawRows(main, mainName);
  const mainAfterName = new Map(mainRows.map((z) => [z.name, z]));
  const mainOid = new Map((main?.read ? main.tips || [] : []).filter((s) => s.ref).map((s) => [s.ref, s.oid]));
  const under = new Map(); // main row → [copy rows] (in copy order)
  const own = []; // copy rows without a main row of the same name

  for (const k of copies || []) {
    for (const z of rawRows(k?.reading, String(k?.name ?? ""))) {
      const sp = z._sp;
      const moved = sp.kind === "detached" ? true : sp.inSnapshot !== sp.oid; // undefined/null = new
      const parent = mainAfterName.get(z.name) || null;
      if (sp.kind === "remote" && (!moved || mainOid.get(sp.ref) === sp.oid)) continue;
      if (!moved || (sp.kind === "detached" && parent)) {
        // Unchanged: only the copy's checked-out branch shows — on the main row, else as a row of its own.
        if (!z.checkedOut.length) continue;
        if (parent) { parent.checkedOut.push(...z.checkedOut); continue; }
      } else z.sinceCreation = sp.sinceCreation ? { ahead: sp.sinceCreation.ahead, back: sp.sinceCreation.back } : null;
      if (parent) { if (!under.has(parent)) under.set(parent, []); under.get(parent).push(z); } else own.push(z);
    }
  }

  // Groups only now: a copy can give a main row a checked-out entry.
  const top = [...mainRows, ...own];
  for (const z of top) z.group = groupOf(z);
  const list = [];
  for (const g of GROUPS) {
    for (const z of top.filter((x) => x.group === g).sort(afterLast)) {
      list.push(z);
      for (const k of under.get(z) || []) { k.group = z.group; list.push(k); }
    }
  }
  return list;
}

/** ALL rows of a repo in the shape of the contract — without search and without cap (the small view and the detail search
 *  in it; small.js counts `counterFrom` over it). `mainName` see `ordered`. */
export const allRows = ({ main = null, copies = [], mainName = MAIN } = {}) => ordered({ main, copies, mainName }).map(form);

/** The number of rows per group (GROUPS, each with its count, also 0) — `counter` of the small view. */
export function counterFrom(rows) {
  const out = Object.fromEntries(GROUPS.map((g) => [g, 0]));
  for (const z of rows || []) if (Object.hasOwn(out, z.group)) out[z.group] += 1;
  return out;
}

/** The rows of a repo (see header). */
export function rowsFrom({ main = null, copies = [], search = "" } = {}) {
  const all = ordered({ main, copies });
  const s = String(search || "").trim().toLowerCase();
  const found = s ? all.filter((z) => z.name.toLowerCase().includes(s)) : all;
  const shown = found.slice(0, ROWS_MAX);
  return {
    rows: shown.map(form),
    clipped: found.length > ROWS_MAX ? { shown: shown.length, total: found.length } : null,
  };
}

/** The main line (see header). */
export function lineFrom(reading) {
  if (!reading?.read || !reading.mainBranch) return { commits: null, count: 0, from: null, until: null };
  const all = (reading.line?.commits || []).filter((t) => t != null);
  const commits = all.slice(-LINE_MAX);
  return { commits, count: all.length, from: commits.length ? commits[0] : null, until: commits.length ? commits[commits.length - 1] : null };
}
