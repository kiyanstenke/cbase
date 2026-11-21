// "Remove old containers": the old containers of renamed stacks (table `project_superseded`, store/project-layout.js) stay stopped
// until a HUMAN removes them, after a confirmation that names every container and data area with name and size. Everything applies
// to the main instance only (the layout, and with it `project_superseded`, exists only there). Everything runs in the INNER daemon of
// the project container via `dockerIn(…, { capMs: 0 })`, addressed by id — volumes by name (that is their identifier). Without a
// project container the routes answer 404 (./routes.js).
//
//   supersededView(pid)               GET …/superseded — the inventory (below) plus `running` and `last` (the report of the last removal
//                                     in THIS process, like the event — for a client that missed the event)
//   supersededStatus(pid)             GET …/superseded?status=1 — `{ running, last: end | null }`, WITHOUT docker
//   startSuperseded(pid, body)        POST …/superseded/remove — checks synchronously (400/409, table below), occupies the project and
//                                     starts the procedure; → { status, body }
//   computeSet(rows, raw, inv)        the ONE calculation "what belongs to the superseded set, what stays" (pure; GET and procedure)
//   supersededInWork(bootId)          for `projectWork` in /api/runs/active: the procedures running IN THIS process (own boot id) →
//                                     [{ projectId, step, since }] — they hold `busy`
//   supersededAlive(pid), supersededEnd(pid)   for tests: whether a procedure lives, and the promise of its end (instead of a duration)
//   containerById(container, ids), MISSING   the containers of the rows by id (steps 1 and 7) — exported for the guard of the "gone"
//                                     rule (below): a silent daemon and an outer "No such container" prove nothing
//
// THE INVENTORY (GET). Per row of `project_superseded` the container by id (`inspect --type container --size`: current name, state —
// "running" means started by hand —, size of the write layer `SizeRw`). Plus the objects of the OLD stack (`stackPrior` of the row)
// from `dockerInventory` (volume sizes from `system df -v --format "{{json .}}"` via `sizeFromText`, image sizes from `inspect`,
// otherwise from `system df`). Answer:
//   { stacks: [{ stackPrior, stackNow, since, container: [{ id, name, state, size }], volumes: [{ name, size }],
//                networks: [{ id, name }], images: [{ id, name, size }] }],
//     stays: [{ kind, name, reason }], total: { bytes, withoutSize }, running, last? }
// `state: "missing"` (size null): the daemon no longer knows the row's container (`No such container`, the message NAMES its id).
// `total.bytes` sums the known sizes of the deletion list, `total.withoutSize` counts its objects without a known size (a sum that
// silently drops unknowns would look complete).
// WHAT MAY GO ON THE DELETION LIST — everything else goes under `stays` with a reason:
//   OWN is a volume that a superseded container mounts (mounts `type: volume`) or that is in a row's earmark (`earmarked`); a network
//   in which a superseded container sits or that is earmarked, and that looks like the old stack (label
//   `com.docker.compose.project=<stackPrior>` or name `<stackPrior>_default` — other networks of a superseded container, such as a
//   shared `proxy`, do not belong at all); an image with the label of the old stack.
//   ASSIGNED BY NAME ONLY: a volume or network with the label or the `_default` name of the old stack that is neither mounted nor
//   earmarked ALWAYS STAYS ("assigned by name only"; if the name lives again, "the stack lives again"): the stack name can live again
//   (`tools/app` is later called "app" again, just `down`).
//   An own volume may go on the list only if
//     (1) it is ANONYMOUS — label `com.docker.volume.anonymous` (dockerd 23+) or a 64-hex name without a Compose project label
//         (dockerd 20.10 sets no label) —, or
//     (2) Compose created it for the old stack: label `com.docker.compose.project` = stackPrior AND name =
//         `<stackPrior>_<label com.docker.compose.volume>` (Compose's default name; Compose never creates `external` ones, such a one
//         carries no Compose label);
//   otherwise "fixed name" (label fits, name does not: `name:` in the Compose file — the same file names it again in the NEW stack),
//   "belongs to the Compose project" (foreign label) or "created without a Compose label" (by hand or `external`). Networks follow
//   the same rule with `com.docker.compose.network` (without case (1)). An image may go on the list if each of its names (`RepoTags`)
//   is Compose's default name of a build of the old stack (`<stackPrior>-…`/`<stackPrior>_…`) — if it carries another one (the layout
//   tags a built image for the new stack as `<stackNow>-<service>`; an `image:` of the Compose file), it stays ("also carries the name …").
//   BEFORE all that: what a container OUTSIDE the superseded set uses, running or stopped (the new stack, a container of cbase),
//   stays ("used by …").
//   LIMIT: the Compose MODEL of the new stack is NOT consulted. It could be read only through the labels of one of its containers
//   (compose-config.js composeConfig + configModelArgs + modelVolumes) — and where one exists, the mount rule above already protects
//   it. After a `compose down` of the new stack no container carries the Compose folder any more (`project_superseded` knows only the
//   name `stackNow`). Exactly one case stays unprotected: the new stack names the old default name `<stackPrior>_<key>` LITERALLY via
//   `name:`/`external` (to save the data across the rename) and has no container right now — then the volume is on the deletion
//   list, and only the confirmation protects it. Likewise for images: an `image:` of the new stack with a name of the old default
//   pattern (rebuildable, no data).
// If the daemon does not answer (or does not name a missing identifier): 409 NOT_READY — never an empty list (empty is not unknown).
// Without a row there is no docker call: the list is empty because the database says so.
//
// THE STATUS (GET …/superseded?status=1): `{ running, last }` from the memory of this process — no docker, even with a silent daemon
// and for an instance that is not `ready`; only 409 NOT_CONVERTED like the GET. `last` is the report of the last procedure IN THIS
// process (shape like the event, without `type`) or `null`; its `since` is the `since` of the POST's 202 answer it belongs to. After a
// restart of B it is gone (`running: false, last: null`) — the client then reloads the inventory; a procedure that died with the
// process has already written its earmark.
//
// THE PROCEDURE (POST, 202 `{ ok, since }`; under the project occupancy "superseded", instance.js withProjectOccupancy; in
// `projectWork` with its own boot id, `state: "superseded"`, the step as phase):
//   1. `inventory`  read the inventory again (like GET).
//   2.              only what is in `confirmed` AND still on the deletion list of the new inventory is removed — the confirmation does
//                   NOT cover anything new: what appeared after the confirmation stays and is reported ("not confirmed"). A container
//                   that runs now (running, restarting, paused) but is not in `confirmed.running` (the client showed it stopped)
//                   stays ("running since the confirmation"), and with it everything it uses.
//   2a.             BEFORE the first `rm`: per container to remove, the confirmed volumes it mounts and the confirmed networks it sits
//                   in go into `project_superseded.earmarked` — if the procedure dies between `rm` and `volume rm`, the next inventory
//                   finds them via the row (its container is then `missing`).
//   3. `container`  if it runs, first `docker stop -t 30 <id>`, then `docker rm <id>` — without `-f`.
//   4. `volumes`    `docker volume rm <name>` — without `-f`; "in use" ⇒ stays, reported.
//   5. `networks`   read afresh BEFORE EVERY `docker network rm <id>` (`ps -a -q --no-trunc` + `inspect --type container` without
//                   `--size`): if a container that was not removed sits in it, it stays ("used by …") — `network rm` refuses only for
//                   RUNNING endpoints, a stopped container would not find its network at start. "active endpoints" ⇒ stays, reported.
//   6. `images`     `docker image rm <id>` — without `-f`; used or "must be forced" ⇒ stays, reported.
//                   Before 4–6: what a superseded container uses that REMAINED (not confirmed, `rm` refused) stays as well.
//   7. `rows`       a row falls if the daemon no longer knows its container (`No such container` with its id on `inspect`; a silent
//                   daemon does not count) AND none of its earmarked objects is open. An earmarked object is open if it still exists
//                   (`volume inspect`/`network inspect`, the "gone" rule), was on the deletion list in step 1, is used by no remaining
//                   superseded container (whose row carries it) and did not fail in step 4/5 on a container from outside (then it no
//                   longer belongs to the old stack).
//   8.              event `project/superseded` `{ projectId, state: "finished" | "error", since, removed: { container, volumes,
//                   networks, images, bytes }, stays: [{ kind, name, reason }], error? }` — lists of NAMES, cut to 120 characters, no
//                   values (no label, no environment); `since` as in the 202 answer.
// "Gone" means in every step: the daemon's message names EXACTLY this object ("No such …", "not found") — a "No such container:
// cbase-p-…" of the outer `docker exec` (the project container is gone) is NO proof about an inner object.
// Repeatable: what is missing is done. An error that no rule above knows ends the procedure with `error` (the rows then still stand;
// the human presses again). A restart in the middle leaves the rows whose container is still there or whose earmark is open; there is
// no restart hook because nobody waits for the end. Ghost folders at the old path and the volumes of a copy (own dockerd) are not part
// of it.
//
// THE REJECTIONS of the POST, in this order (the most precise first — during a relocation or a setup the instance is not `ready`
// either):
//   400 CONFIRMATION_MISSING  `confirmed` is missing or lacks one of the five lists of strings — `container`, `running` (the containers
//                           the client showed as running), `volumes`, `networks`, `images` (a missing field is no statement — not even
//                           an empty list)
//   409 NOT_CONVERTED    no project container
//   409 RELOCATION       a relocation is running (read.js relocationInProgress)
//   409 SETUP_OPEN       a setup is open
//   409 COPY_OPEN        a copy lives (with `name`) — a copy made before the rename may mean the old stack when fetched back
//   409 LAYOUT_OPEN      a job in `waiting`, `running` or `error` after the turn (with `state`) — the set may change there
//   409 RUNNING          a removal is already running
//   409 OCCUPIED         another procedure holds the project (setup, recreate, delete, …; with `what`)
//   409 NOT_READY        the instance is not `ready`
// Guards: server/backend/test/superseded-remove.test.js, fence.test.js (`/superseded/**` rejected).
import * as store from "../../store.js";
import { T } from "../../i18n.js";
import { BOOT_ID } from "../../app-state.js";
import { broadcast } from "../../runtime/sse.js";
import { MAIN } from "../creation.js";
import { LABEL } from "../compose-config.js";
import { DockerError, dockerIn } from "../docker.js";
import { setupOpen } from "../setup/status.js";
import { occupancyOfProject, occupancySentence, withProjectOccupancy } from "../instance.js";
import { containerOf, runInstance } from "../run-instance.js";
import { INSPECT_BUNDLE, dockerInventory } from "./docker-read.js";
import { relocationInProgress } from "./read.js";

const WITHOUT_CAP = { capMs: 0 };
export const NAME_LENGTH = 120;
export const CONFIRMATION_CAP = 10_000; // entries per list — above that 400 with a message
// The lists of `confirmed` — all required.
const LISTEN = Object.freeze(["container", "running", "volumes", "networks", "images"]);
const RUNNING = new Set(["running", "restarting", "paused"]);
const ANONYM_LABEL = "com.docker.volume.anonymous";
export const MISSING = Symbol("missing");

const short = (s, n = NAME_LENGTH) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const errorText = (e) => `${e?.stderr || ""}\n${e?.message || ""}`;
const firstRow = (e) => short(String(e?.stderr || e?.message || e).split("\n").map((z) => z.trim()).find(Boolean) || "", 200);
const namesList = (names) => {
  const n = [...new Set(names)].map((x) => T`“${short(x, 60)}”`);
  return n.length > 3 ? T`${n.slice(0, 3).join(", ")} and ${n.length - 3} more` : n.join(", ");
};
const usedOf = (names) => T`used by ${namesList(names)}`;
// The reasons for staying (header) — as functions, because T() reads the language of the request.
const FESTER_NAME = () => T("fixed name — another stack may use it");
const WITHOUT_LABEL = () => T("created without a Compose label — another stack may use it (external)");
const FOREIGN_PROJECT = (p) => T`belongs to the Compose project “${short(p, 60)}”`;
const ONLY_NAME = () => T("assigned by name only — the stack name may live again");
const FOREIGN_IMAGE_NAME = (n) => T`also carries the name “${short(n, 60)}” — another stack may use it`;
const RUNNING_SINCE = () => T("running since the confirmation");

const mountsOf = (r) => (Array.isArray(r?.Mounts) ? r.Mounts : []).filter((m) => m?.Type === "volume" && m.Name).map((m) => String(m.Name));
const networkNamesOf = (r) => Object.keys(r?.NetworkSettings?.Networks || {});
const standsName = (r) => String(r?.Name || "").replace(/^\//, "") || String(r?.Id || "").slice(0, 12);

/** Header case (1): an anonymous volume — label `com.docker.volume.anonymous` or a 64-hex name without project label. */
const isAnonym = (v) => Object.hasOwn(v.labels || {}, ANONYM_LABEL) || (/^[0-9a-f]{64}$/.test(v.name) && !v.labels?.[LABEL.project]);
/** Header case (2): did Compose create the object for `stack`? → null (yes) or the reason it stays. `key` is the label with the
 *  key from the Compose file (`com.docker.compose.volume` or `…network`). */
function foreignReason(labels, name, stack, key) {
  const p = String(labels?.[LABEL.project] || "");
  if (!p) return WITHOUT_LABEL();
  if (p !== stack) return FOREIGN_PROJECT(p);
  const k = String(labels?.[key] || "");
  return k && name === `${stack}_${k}` ? null : FESTER_NAME();
}
// The repo part of an image name (`registry:5000/x:tag` → `registry:5000/x`).
const repoOf = (t) => { const s = String(t); const i = s.lastIndexOf(":"); return i > s.lastIndexOf("/") ? s.slice(0, i) : s; };
/** The same rule for images (header): the first name that is NOT a default name of a build of `stack` — or null. */
const foreignImageName = (tags, stack) => tags.find((t) => { const r = repoOf(t); return !(r.startsWith(`${stack}-`) || r.startsWith(`${stack}_`)); }) ?? null;

export class SupersededError extends Error {
  constructor(code, status, message, fields = {}) {
    super(message);
    this.name = "SupersededError";
    this.code = code;
    this.status = status;
    Object.assign(this, fields);
  }
}

// Does the daemon's message name exactly this object as missing? (Header: "gone".) `identifier` is the id (also as a 12-character
// prefix in the message) or the name of a volume.
function goneReported(e, identifier) {
  if (!(e instanceof DockerError)) return false;
  const t = errorText(e);
  if (!/No such (?:object|container|image|network|volume)|not found|no such volume/i.test(t)) return false;
  const k = String(identifier || "");
  return Boolean(k) && (t.includes(k) || (k.length > 12 && t.includes(k.replace(/^sha256:/, "").slice(0, 12))));
}

// The identifiers a message names as unknown ("Error: No such container: <id>" or "No such object: <id>").
const notFound = (stderr) => new Set([...String(stderr || "").matchAll(/No such (?:container|object):\s*(\S+)/gi)].map((m) => m[1]));

/**
 * The containers of the rows by id: `inspect --type container --size` in bundles. → Map id → inspect object | MISSING. Throws if the
 * daemon does not answer or an id neither delivers nor is NAMED as unknown (an outer "No such container: cbase-p-…" proves nothing
 * about the inner ones). `size: false` drops `--size` (the fresh read before `network rm` — `--size` computes every write layer).
 */
export async function containerById(container, ids, { size = true } = {}) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += INSPECT_BUNDLE) {
    const part = ids.slice(i, i + INSPECT_BUNDLE);
    let text;
    let named = new Set();
    try { text = (await dockerIn(container, ["inspect", "--type", "container", ...(size ? ["--size"] : []), ...part], WITHOUT_CAP)).stdout; } catch (e) {
      if (!(e instanceof DockerError)) throw e;
      named = notFound(e.stderr);
      if (!named.size) throw e;
      text = e.stdout;
    }
    let list;
    try { list = JSON.parse(String(text || "").trim() || "[]"); } catch { throw new Error("docker inspect: output is not JSON"); }
    if (!Array.isArray(list)) throw new Error("docker inspect: output is not a list");
    for (const c of list) if (c && typeof c === "object" && c.Id) out.set(String(c.Id), c);
    for (const id of part) {
      if (out.has(id)) continue;
      if ([...named].some((n) => n === id || (n.length >= 12 && id.startsWith(n)))) out.set(id, MISSING);
      else throw new Error(`docker inspect: container ${id.slice(0, 12)} neither read nor reported as unknown`);
    }
  }
  return out;
}

/**
 * The ONE calculation (header "The inventory"): `rows` from `project_superseded` (main, with `earmarked`), `raw` from containerById,
 * `inv` from dockerInventory. Pure. → `{ stacks, stays, total }` — the GET answer without `running`/`last`.
 */
export function computeSet(rows, raw, inv) {
  const existing = new Map(); // id → inspect object of the superseded containers that exist
  for (const z of rows) { const r = raw.get(z.containerId); if (r && r !== MISSING) existing.set(z.containerId, r); }
  const outside = inv.container.filter((c) => !existing.has(c.id));
  const stays = [];
  const seen = new Set();
  const remember = (kind, name, reason) => { const k = `${kind}\0${name}`; if (!seen.has(k)) { seen.add(k); stays.push({ kind, name, reason }); } };
  // The old name lives again: a container outside the set carries the same Compose project (header).
  const alive = new Map();
  for (const c of outside) {
    const p = c.labels?.[LABEL.project];
    if (p) alive.set(String(p), [...(alive.get(String(p)) || []), c.name]);
  }
  const aliveReason = (stack) => T`the stack “${short(stack, 60)}” lives again (${namesList(alive.get(stack))}) — it belongs to it`;
  const onlyNameReason = (stack) => (alive.has(stack) ? aliveReason(stack) : ONLY_NAME());
  const stacks = new Map();
  for (const z of rows) {
    const k = `${z.stackPrior}\0${z.stackNow}`;
    if (!stacks.has(k)) stacks.set(k, { stackPrior: z.stackPrior, stackNow: z.stackNow, since: z.since, container: [], volumes: [], networks: [], images: [], ids: [], vol: new Set(), networkName: new Set(), networkId: new Set() });
    const s = stacks.get(k);
    s.since = Math.min(s.since, z.since);
    // The earmark counts like a mount — especially for a row whose container is missing.
    for (const v of z.earmarked?.volumes || []) s.vol.add(v);
    for (const n of z.earmarked?.networks || []) s.networkId.add(n);
    const r = existing.get(z.containerId);
    if (!r) { s.container.push({ id: z.containerId, name: z.nameNow || z.namePrior, state: "missing", size: null }); continue; }
    s.container.push({ id: z.containerId, name: String(r.Name || "").replace(/^\//, "") || z.nameNow, state: String(r.State?.Status || ""), size: Number.isFinite(r.SizeRw) && r.SizeRw >= 0 ? r.SizeRw : null });
    s.ids.push(z.containerId);
    for (const v of mountsOf(r)) s.vol.add(v);
    for (const n of networkNamesOf(r)) s.networkName.add(n);
  }
  const allocated = { volume: new Set(), network: new Set(), image: new Set() };
  const afterOldStack = (n, stack) => String(n.labels?.[LABEL.project] || "") === stack || n.name === `${stack}_default`;
  // Two passes: first what is OWN (mounted, attached, earmarked) — across all stacks —, then what belongs only by name. Otherwise a
  // stack that knows a volume only by its label would take it from the stack whose container mounts it.
  for (const s of stacks.values()) {
    const sv = s.stackPrior;
    for (const v of inv.volumes) {
      if (allocated.volume.has(v.name) || !s.vol.has(v.name)) continue;
      allocated.volume.add(v.name);
      const who = outside.filter((c) => c.mounts.some((m) => m.type === "volume" && m.name === v.name)).map((c) => c.name);
      const reason = who.length ? usedOf(who) : isAnonym(v) ? null : foreignReason(v.labels, v.name, sv, LABEL.volume);
      if (reason) remember("volume", v.name, reason);
      else s.volumes.push({ name: v.name, size: Number.isFinite(v.size) ? v.size : null });
    }
    for (const n of inv.networks) {
      if (allocated.network.has(n.id) || !afterOldStack(n, sv) || !(s.networkName.has(n.name) || s.networkId.has(n.id))) continue;
      allocated.network.add(n.id);
      const who = outside.filter((c) => c.networks.includes(n.name)).map((c) => c.name);
      const reason = who.length ? usedOf(who) : foreignReason(n.labels, n.name, sv, LABEL.network);
      if (reason) remember("network", n.name, reason);
      else s.networks.push({ id: n.id, name: n.name });
    }
    for (const i of inv.images) {
      // Without `Config` the label is unknown (docker-read.js: `labels` null) — such an image does not belong.
      if (allocated.image.has(i.id) || !i.labels || String(i.labels[LABEL.project] || "") !== sv) continue;
      allocated.image.add(i.id);
      const name = i.tags[0] || i.id;
      const who = outside.filter((c) => c.imageId === i.id).map((c) => c.name);
      const foreign = foreignImageName(i.tags, sv);
      if (who.length) remember("image", name, usedOf(who));
      else if (alive.has(sv)) remember("image", name, aliveReason(sv));
      else if (foreign) remember("image", name, FOREIGN_IMAGE_NAME(foreign));
      else s.images.push({ id: i.id, name, size: Number.isFinite(i.size) ? i.size : null });
    }
  }
  for (const s of stacks.values()) {
    const sv = s.stackPrior;
    for (const v of inv.volumes) {
      if (allocated.volume.has(v.name) || String(v.labels?.[LABEL.project] || "") !== sv) continue;
      allocated.volume.add(v.name);
      const who = outside.filter((c) => c.mounts.some((m) => m.type === "volume" && m.name === v.name)).map((c) => c.name);
      remember("volume", v.name, who.length ? usedOf(who) : onlyNameReason(sv));
    }
    for (const n of inv.networks) {
      if (allocated.network.has(n.id) || !afterOldStack(n, sv)) continue;
      allocated.network.add(n.id);
      const who = outside.filter((c) => c.networks.includes(n.name)).map((c) => c.name);
      remember("network", n.name, who.length ? usedOf(who) : onlyNameReason(sv));
    }
  }
  let bytes = 0;
  let withoutSize = 0;
  const count = (g) => { if (Number.isFinite(g)) bytes += g; else withoutSize += 1; };
  const list = [...stacks.values()].map(({ ids: _ids, vol: _v, networkName: _nn, networkId: _ni, ...s }) => {
    for (const c of s.container) if (c.state !== "missing") count(c.size);
    for (const v of s.volumes) count(v.size);
    for (const i of s.images) count(i.size);
    return s;
  });
  return { stacks: list, stays, total: { bytes, withoutSize } };
}

const notConverted = () => new SupersededError("NOT_CONVERTED", 409, T("This project has no project container — old containers exist only there."));

function instanceOrError(pid) {
  const inst = runInstance(pid);
  if (!inst) throw notConverted();
  if (inst.state !== "ready") throw new SupersededError("NOT_READY", 409, T("The project container is not ready."));
  return inst;
}

// The inventory of NOW: rows, containers by id, inventory of the inner daemon. Throws NOT_READY if the daemon does not answer.
async function inventory(pid, inst) {
  const rows = store.supersededOf(pid, MAIN);
  if (!rows.length) return { rows, raw: new Map(), set: { stacks: [], stays: [], total: { bytes: 0, withoutSize: 0 } } };
  const container = containerOf(inst);
  let raw;
  let inv;
  try {
    raw = await containerById(container, rows.map((z) => z.containerId));
    inv = await dockerInventory(container);
  } catch (e) {
    throw new SupersededError("NOT_READY", 409, T`The project container's Docker does not answer (${firstRow(e)}) — which old containers exist is unknown.`);
  }
  return { rows, raw, set: computeSet(rows, raw, inv) };
}

// Step 5 (header): the containers that sit in this network NOW — read afresh, running or stopped. → [{ id, name }]
async function containerInNetwork(container, n) {
  const ids = [...new Set(String((await dockerIn(container, ["ps", "-a", "-q", "--no-trunc"], WITHOUT_CAP)).stdout || "").split(/\s+/).filter(Boolean))];
  if (!ids.length) return [];
  const raw = await containerById(container, ids, { size: false }); // containers that vanished in the meantime are MISSING
  const out = [];
  for (const [id, r] of raw) {
    if (r === MISSING) continue;
    const networks = r?.NetworkSettings?.Networks || {};
    if (Object.entries(networks).some(([name, e]) => name === n.name || (e?.NetworkID && String(e.NetworkID) === n.id))) out.push({ id, name: standsName(r) });
  }
  return out;
}

// Does the object still exist? (Step 7.) `inspect` succeeds ⇒ yes; the message names EXACTLY this object as missing ⇒ no; anything
// else (a silent daemon) throws — then the row stays.
async function stillPresent(container, args, identifier) {
  try { await dockerIn(container, args, WITHOUT_CAP); return true; } catch (e) {
    if (goneReported(e, identifier)) return false;
    throw e;
  }
}

// ── The procedure ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const running = new Map(); // projectId → { since, boot, step, end }
const last = new Map(); // projectId → the report of the last procedure (like the event, without `type`)

export const supersededAlive = (pid) => running.has(String(pid));
export const supersededEnd = (pid) => running.get(String(pid))?.end ?? Promise.resolve();
/** For /api/runs/active: the procedures with boot id `bootId` (header). */
export const supersededInWork = (bootId = BOOT_ID) => [...running]
  .filter(([, l]) => l.boot === String(bootId ?? ""))
  .map(([projectId, l]) => ({ projectId, step: l.step, since: l.since }));
/** Tests only: empty the memory of the reports (as after the end of the process). */
export function forgetSuperseded() { last.clear(); }

/** GET …/superseded (header). Throws SupersededError (NOT_CONVERTED, NOT_READY). */
export async function supersededView(pid) {
  const p = String(pid);
  const inst = instanceOrError(p);
  const { set } = await inventory(p, inst);
  return { ...set, running: running.has(p), ...(last.has(p) ? { last: last.get(p) } : {}) };
}

/** GET …/superseded?status=1 (header "The status") — without docker. Throws SupersededError (NOT_CONVERTED only). */
export function supersededStatus(pid) {
  const p = String(pid);
  if (!runInstance(p)) throw notConverted();
  return { running: running.has(p), last: last.get(p) ?? null };
}

/** The body of the POST → `{ container, running, volumes, networks, images }` (each a set of strings) or null (400). */
function confirmation(body) {
  const b = body && typeof body === "object" ? body.confirmed : null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const out = {};
  for (const k of LISTEN) {
    const l = b[k];
    if (!Array.isArray(l) || l.length > CONFIRMATION_CAP || l.some((x) => typeof x !== "string" || !x || x.length > 512)) return null;
    out[k] = new Set(l);
  }
  return out;
}

const no = (status, code, text, fields = {}) => ({ status, body: { code, error: text, ...fields } });

/** POST …/superseded/remove (header "The rejections"). Checks and occupies SYNCHRONOUSLY (no await between check and occupancy). */
export function startSuperseded(pid, body) {
  const p = String(pid);
  const confirmed = confirmation(body);
  if (!confirmed) {
    return no(400, "CONFIRMATION_MISSING", T`“confirmed” is missing or incomplete — the five lists container, running, volumes, networks, images are required (strings, at most ${CONFIRMATION_CAP} each).`);
  }
  const inst = runInstance(p);
  if (!inst) return no(409, "NOT_CONVERTED", T("This project has no project container — old containers exist only there."));
  if (relocationInProgress(p)) return no(409, "RELOCATION", T("The project is moving — remove old containers afterwards."));
  if (setupOpen(p)) return no(409, "SETUP_OPEN", T("The project is still being set up — remove old containers afterwards."));
  const copies = store.liveStackCopies(p);
  if (copies.length) {
    const name = String(copies[0].name || "");
    return no(409, "COPY_OPEN", T`The copy “${short(name, 60)}” is open — when fetched back it may mean the old stack. Remove it first, then the old containers.`, { name });
  }
  const g = store.layoutOpen(p);
  if (g) return no(409, "LAYOUT_OPEN", T`A restructuring is open (${g.state}) — the old containers may still change.`, { state: g.state });
  if (running.has(p)) return no(409, "RUNNING", T("The old containers are already being removed."));
  const occupied = occupancyOfProject(p);
  if (occupied) return no(409, "OCCUPIED", T`Something is running for the project (${occupancySentence(occupied.what)}) — remove old containers afterwards.`, { what: occupied.what });
  if (inst.state !== "ready") return no(409, "NOT_READY", T("The project container is not ready."));

  const run = { since: Date.now(), boot: BOOT_ID, step: "inventory", end: null };
  running.set(p, run);
  // withProjectOccupancy occupies synchronously (up to the first await) — the occupancyOfProject check above still holds.
  run.end = withProjectOccupancy(p, "superseded", () => procedure(p, inst, confirmed, run))
    .catch((e) => report(p, run.since, { state: "error", removed: emptyRemoved(), stays: [], error: T`Removal not started: ${short(e?.message || e, 200)}` }))
    .finally(() => { if (running.get(p) === run) running.delete(p); });
  return { status: 202, body: { ok: true, since: run.since } };
}

const emptyRemoved = () => ({ container: [], volumes: [], networks: [], images: [], bytes: 0 });

// The end (header, step 8): `{ projectId, state, since, removed, stays, error? }` — remembered for GET/`?status=1` and broadcast.
function report(pid, since, { state, removed, stays, error }) {
  const b = { projectId: String(pid), state, since, removed, stays, ...(error !== undefined ? { error } : {}) };
  last.set(String(pid), b);
  broadcast({ type: "project/superseded", ...b });
}

async function procedure(pid, inst, confirmed, run) {
  const container = containerOf(inst);
  const removed = emptyRemoved();
  const stays = [];
  const seen = new Set();
  const remember = (kind, name, reason) => { const k = `${kind}\0${name}`; if (!seen.has(k)) { seen.add(k); stays.push({ kind, name: short(name), reason }); } };
  const count = (g) => { if (Number.isFinite(g)) removed.bytes += g; };
  // Step 7: what dropped in 4/5 (no confirmation needed) and what failed on a container from outside (no longer belongs).
  const dropped = new Set();
  const fromOutside = new Set();
  try {
    // 1. the inventory of now
    run.step = "inventory";
    const { rows: rowsPrior, raw, set } = await inventory(pid, inst);
    for (const x of set.stays) remember(x.kind, x.name, x.reason);
    const rowsIds = new Set(rowsPrior.map((z) => z.containerId));
    // 2. only what is confirmed and still on the deletion list; a container that runs since the confirmation stays
    const notConfirmed = T("not confirmed — added after the confirmation");
    const choice = { container: [], volumes: [], networks: [], images: [] };
    for (const s of set.stacks) {
      for (const c of s.container) {
        if (c.state === "missing") continue;
        if (!confirmed.container.has(c.id)) remember("container", c.name, notConfirmed);
        else if (RUNNING.has(c.state) && !confirmed.running.has(c.id)) remember("container", c.name, RUNNING_SINCE());
        else choice.container.push(c);
      }
      for (const v of s.volumes) if (confirmed.volumes.has(v.name)) choice.volumes.push(v); else remember("volume", v.name, notConfirmed);
      for (const n of s.networks) if (confirmed.networks.has(n.id)) choice.networks.push(n); else remember("network", n.name, notConfirmed);
      for (const i of s.images) if (confirmed.images.has(i.id)) choice.images.push(i); else remember("image", i.name, notConfirmed);
    }
    // 2a. the earmark BEFORE the first rm
    const choiceVol = new Set(choice.volumes.map((v) => v.name));
    const choiceNetwork = new Map(choice.networks.map((n) => [n.name, n.id]));
    for (const c of choice.container) {
      const r = raw.get(c.id);
      store.earmarkSuperseded(pid, MAIN, c.id, {
        volumes: mountsOf(r).filter((n) => choiceVol.has(n)),
        networks: networkNamesOf(r).filter((n) => choiceNetwork.has(n)).map((n) => choiceNetwork.get(n)),
      });
    }
    // 3. containers: running ⇒ first stop -t 30, then rm without -f
    run.step = "container";
    const gone = new Set();
    for (const c of choice.container) {
      if (RUNNING.has(c.state)) {
        try { await dockerIn(container, ["stop", "-t", "30", c.id], WITHOUT_CAP); } catch (e) { if (!goneReported(e, c.id)) throw e; }
      }
      try { await dockerIn(container, ["rm", c.id], WITHOUT_CAP); } catch (e) {
        if (goneReported(e, c.id)) { gone.add(c.id); continue; } // meanwhile gone — done, but not removed by us
        if (e instanceof DockerError && /is running|cannot remove|conflict/i.test(errorText(e))) { remember("container", c.name, `docker rm: ${firstRow(e)}`); continue; }
        throw e;
      }
      gone.add(c.id);
      removed.container.push(short(c.name));
      count(c.size);
    }
    // What a superseded container that remained uses, stays (header, before 4–6).
    const state = [...raw.entries()].filter(([id, r]) => r !== MISSING && !gone.has(id)).map(([, r]) => r);
    // 4. Volumes
    run.step = "volumes";
    for (const v of choice.volumes) {
      const who = state.filter((r) => mountsOf(r).includes(v.name)).map(standsName);
      if (who.length) { remember("volume", v.name, usedOf(who)); continue; }
      try { await dockerIn(container, ["volume", "rm", v.name], WITHOUT_CAP); } catch (e) {
        if (goneReported(e, v.name)) { dropped.add(`volume\0${v.name}`); continue; }
        if (e instanceof DockerError && /in use/i.test(errorText(e))) { remember("volume", v.name, `docker volume rm: ${firstRow(e)}`); fromOutside.add(`volume\0${v.name}`); continue; }
        throw e;
      }
      dropped.add(`volume\0${v.name}`);
      removed.volumes.push(short(v.name));
      count(v.size);
    }
    // 5. networks — read afresh before every rm
    run.step = "networks";
    for (const n of choice.networks) {
      const who = state.filter((r) => networkNamesOf(r).includes(n.name)).map(standsName);
      if (who.length) { remember("network", n.name, usedOf(who)); continue; }
      const fresh = await containerInNetwork(container, n);
      if (fresh.length) {
        remember("network", n.name, usedOf(fresh.map((c) => c.name)));
        if (fresh.some((c) => !rowsIds.has(c.id))) fromOutside.add(`network\0${n.id}`);
        continue;
      }
      try { await dockerIn(container, ["network", "rm", n.id], WITHOUT_CAP); } catch (e) {
        if (goneReported(e, n.id)) { dropped.add(`network\0${n.id}`); continue; }
        if (e instanceof DockerError && /active endpoints|in use/i.test(errorText(e))) { remember("network", n.name, `docker network rm: ${firstRow(e)}`); fromOutside.add(`network\0${n.id}`); continue; }
        throw e;
      }
      dropped.add(`network\0${n.id}`);
      removed.networks.push(short(n.name));
    }
    // 6. Images
    run.step = "images";
    for (const i of choice.images) {
      const who = state.filter((r) => String(r.Image || "") === i.id).map(standsName);
      if (who.length) { remember("image", i.name, usedOf(who)); continue; }
      try { await dockerIn(container, ["image", "rm", i.id], WITHOUT_CAP); } catch (e) {
        if (goneReported(e, i.id)) continue;
        if (e instanceof DockerError && /conflict|being used|must be forced|in use/i.test(errorText(e))) { remember("image", i.name, `docker image rm: ${firstRow(e)}`); continue; }
        throw e;
      }
      removed.images.push(short(i.name));
      count(i.size);
    }
    // 7. rows: only what the daemon no longer knows AND whose earmark is done (header)
    run.step = "rows";
    const rows = store.supersededOf(pid, MAIN);
    const after = await containerById(container, rows.map((z) => z.containerId));
    const standing = [...after.values()].filter((r) => r !== MISSING);
    const listVol = new Set(set.stacks.flatMap((s) => s.volumes.map((v) => v.name)));
    const listNetwork = new Map(set.stacks.flatMap((s) => s.networks.map((n) => [n.id, n.name])));
    const open = async (z) => {
      for (const name of z.earmarked.volumes) {
        const k = `volume\0${name}`;
        if (!listVol.has(name) || dropped.has(k) || fromOutside.has(k) || standing.some((r) => mountsOf(r).includes(name))) continue;
        if (await stillPresent(container, ["volume", "inspect", name], name)) return true;
      }
      for (const id of z.earmarked.networks) {
        const k = `network\0${id}`;
        if (!listNetwork.has(id) || dropped.has(k) || fromOutside.has(k) || standing.some((r) => networkNamesOf(r).includes(listNetwork.get(id)))) continue;
        if (await stillPresent(container, ["network", "inspect", id], id)) return true;
      }
      return false;
    };
    for (const z of rows) if (after.get(z.containerId) === MISSING && !(await open(z))) store.removeSuperseded(pid, MAIN, z.containerId);
    report(pid, run.since, { state: "finished", removed, stays });
  } catch (e) {
    console.error(`[superseded] ${pid}: step ${run.step}: ${short(e?.message || e, 300)}`);
    report(pid, run.since, { state: "error", removed, stays, error: T`“${run.step}” failed: ${e instanceof SupersededError ? short(e.message, 300) : firstRow(e)} — the rows of containers that still exist stay; removing again continues.` });
  }
}
