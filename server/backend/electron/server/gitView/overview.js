// The large view: GET /api/projects/:pid/gitView?repo=&search=&fresh=1 (route: routes.js) and the `row` of the detail
// (detail.js).
//
//   gitView(proj, { repo, search, fresh })  → { repo, repos, mainBranch, instances, line, rows, clipped }  (RESPONSE_FIELDS)
//     repos       the code repos (repos.js reposInContainer — without git, even when main is not ready); `repo` the chosen
//                 one: `?repo=` (rel, "" = the project folder), else the first; an unknown one is 404 UNKNOWN_REPO, never
//                 silently another; without a repo `repo: null`, `rows: []`
//     instances   main, then the live copies in creation order (store.liveStackCopies, like the instances tree) —
//                 `{ name, color, read, reason, remoteState }` (INSTANCE_FIELDS). ONLY an instance whose row is `ready` is
//                 read (cache.js reading) — every other carries `read: false` with its reason (REASONS) and is
//                 NEVER asked, started or resumed, main included. `color` from color.js (main null), `remoteState` from the
//                 reading (unread null). Without a repo nothing is read: a ready instance carries `read: false` without a
//                 reason.
//     mainBranch, line  from the reading of main; if that is not read, from the first read copy (else null / empty)
//     rows, clipped  groups.js rowsFrom (main + read copies, search before the cap), then user.js withUsers and — fresh
//                 on EVERY response, never from the cache — withChats
//   rowFor(proj, { repo, instance, name })  → the row `name` of the instance `instance` (seam name) from THE SAME readings,
//     without search and cap, with user and chats — or null (does not exist, not read). Does not throw.
//
// The reasons of a not-ready instance from its state (reasonOf): stopped/stop/clearAway ⇒ "stopped"; error ⇒ "error";
// create/start/recreate/relocation and a copy without an instance row (waiting_queue, waiting_storage, build) ⇒ "starts";
// a reading that fails brings its own (read.js: time, stopped, frozen, error).
//
// Guard: server/backend/test/gitView.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { runInstance } from "../projectbox/run-instance.js";
import { allRows, lineFrom, rowsFrom } from "./groups.js";
import { withUsers, withChats } from "./user.js";
import { keyColorsOfTheProject } from "./color.js";
import { instanceDisplay } from "./instance-choice.js";
import { reading } from "./cache.js";
import { repoChoice, reposInContainer } from "./repos.js";

const MAIN = "main";

const STOPPED = new Set(["stopped", "stop", "clearAway"]);
const STARTS = new Set(["create", "start", "recreate", "relocation", "waiting_queue", "waiting_storage", "build", "earmarked"]);
/** The reason (contract.js REASONS) of an instance that is not `ready` (see header). */
export function reasonOf(state) {
  if (STOPPED.has(state)) return "stopped";
  if (STARTS.has(state)) return "starts";
  return "error";
}

// The instances of the project: main, then the live copies in creation order — with their instance row (`null` without)
// and the state that counts (the row's; without a row the copy's).
function instancesOfThe(pid) {
  const h = store.projectInstance(pid, MAIN);
  const out = [{ internalName: MAIN, row: h, state: h?.state || "" }];
  for (const k of store.liveStackCopies(pid)) {
    const internalName = `copy-${k.name}`;
    const z = store.projectInstance(pid, internalName);
    out.push({ internalName, row: z, state: z?.state || k.state || "" });
  }
  return out;
}

/**
 * Per instance `{ name, color, reading }` for a repo — read (cached) only what is `ready`; `rel === null` reads nothing.
 */
export async function readingsOfTheRepos(proj, rel, { fresh = false } = {}) {
  const pid = String(proj.id);
  const colors = keyColorsOfTheProject(pid);
  return Promise.all(instancesOfThe(pid).map(async ({ internalName, row, state }) => {
    const name = instanceDisplay(internalName);
    const color = internalName === MAIN ? null : (colors.get(name) ?? null);
    if (row?.state !== "ready") return { name, color, reading: { read: false, reason: reasonOf(state) } };
    if (rel === null) return { name, color, reading: { read: false, reason: null } };
    let inst = null;
    try { inst = runInstance(pid, internalName); } catch (e) { return { name, color, reading: { read: false, reason: "error", error: String(e?.message || e) } }; }
    if (!inst) return { name, color, reading: { read: false, reason: "error", error: T`No instance row for ${name}.` } };
    return { name, color, reading: await reading(proj, rel, inst, { fresh }) };
  }));
}

// Main and read copies for groups.js, plus the source of main branch and line.
function split(byKey) {
  const [h, ...rest] = byKey;
  const main = h?.reading?.read ? h.reading : null;
  const copies = rest.filter((k) => k.reading?.read).map((k) => ({ name: k.name, reading: k.reading }));
  return { main, copies, source: main || copies[0]?.reading || null };
}

/** The large view (see header). Throws 400 REPO_INVALID and 404 UNKNOWN_REPO (repos.js repoChoice); the route checks ops mode and conversion first. */
export async function gitView(proj, { repo = null, search = "", fresh = false } = {}) {
  const pid = String(proj.id);
  const all = reposInContainer(proj, runInstance(pid, MAIN));
  const repos = all.map(({ rel, name }) => ({ rel, name }));
  const w = repoChoice(proj, repo, { repos: all }); // 400 REPO_INVALID, 404 UNKNOWN_REPO — the same check as fetch, detail, diff
  const selected = w ? { rel: w.rel, name: w.name } : null;
  const byKey = await readingsOfTheRepos(proj, selected ? selected.rel : null, { fresh });
  const { main, copies, source } = split(byKey);
  const { rows, clipped } = selected ? rowsFrom({ main, copies, search }) : { rows: [], clipped: null };
  withUsers(pid, rows);
  withChats(pid, rows);
  return {
    repo: selected,
    repos,
    mainBranch: source?.mainBranch ? { name: source.mainBranch.name, source: source.mainBranch.source } : null,
    instances: byKey.map(({ name, color, reading: l }) => ({
      name, color, read: l.read === true, reason: l.read === true ? null : (l.reason ?? null), remoteState: l.read === true ? l.remoteState : null,
    })),
    line: lineFrom(source),
    rows,
    clipped,
  };
}

/** The row of a branch for the detail (see header). */
export async function rowFor(proj, { repo, instance, name } = {}) {
  try {
    const { main, copies } = split(await readingsOfTheRepos(proj, String(repo ?? "")));
    const z = allRows({ main, copies }).find((x) => x.name === name && x.instance === instance) || null;
    if (!z) return null;
    withUsers(String(proj.id), [z]);
    withChats(String(proj.id), [z]);
    return z;
  } catch (e) {
    console.error(`[gitView] row ${proj?.id} ${repo} ${instance} ${name}:`, e?.message || e);
    return null;
  }
}
