// Docker during the rebuild of a layout (steps 1, 3, 9, 18, 20 and the return path). Everything in the project container's INNER
// daemon (`dockerIn`), without a cap (an `up` of large stacks and an `rm` of large volumes take minutes). Removal is by id ONLY
// (volumes have none — their name is their identifier); an object that no longer exists is done (every step runs once more after a
// crash).
//
//   priorDocker(container, affected, confirmed)         step 1: the affected containers with restart rule, name, state, and the
//                                                       stacks (groups of equal compose labels) with their kind (`moved` · `gone` ·
//                                                       `reference`) and, for the rename case, the name change
//   stopContainer(container, list)                      step 3: `update --restart no` + `stop` per id
//   rulesBack(container, list)                          return path: the old restart rule per id
//   removeAway(container, goneAbs, confirmed)            step 9: what NOW belongs to the left-out folders, by id; what was not in
//                                                       `confirmed` goes into the report
//   supersede(pid, instance, container, stacks, { warn })  step 9: old containers of renamed stacks to `project_superseded`, with a
//                                                       fixed `container_name` `docker rename` (repeatable: only if the CURRENT name
//                                                       is a different one)
//   composeNew(container, stack, projection)            step 18: create the stack with the new paths (`up --no-start`), dry run before
//                                                       and after; a renamed stack under the name Compose picks without `-p` in the
//                                                       new folder (built images tagged for it beforehand)
//   recheckDocker(pid, container, ctx)                  step 20: no foreign containers with `working_dir` under an old path, no
//                                                       missing file from the labels of the new stacks
//
// NOT here: which containers are affected (docker-read.js `affectedContainer`), what falls with them (`deleteSet`), the name without
// `-p` (`composeNameWithoutP`) — the same computations as the check, no second version.
import path from "node:path";
import * as store from "../../store.js";
import { T } from "../../i18n.js";
import { DockerError, dockerIn } from "../docker.js";
import { ComposeConfigError, LABEL, composeConfig, configKey, dryrunVerdict, upWithoutStartArgs, upDryrunArgs } from "../compose-config.js";
import { affectedContainer, composeNameWithoutP, dockerInventory, fixedContainerName, deleteSet, underAbs } from "./docker-read.js";
import { missingLabelFiles } from "./label-files.js";

const WITHOUT_CAP = { capMs: 0 };
const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const isMissing = (e) => e instanceof DockerError && /No such (object|container|image|network|volume)|not found|no such volume/i.test(`${e.stderr}\n${e.message}`);
const firstRow = (e) => short(String(e?.stderr || e?.message || e).split("\n").map((z) => z.trim()).find(Boolean) || "", 200);

/** The restart rule as the argument of `update --restart` (`no`, `always`, `unless-stopped`, `on-failure[:n]`). */
export function restartArg(rule) {
  const name = String(rule?.Name || "");
  if (!name || name === "no") return "no";
  if (name === "on-failure" && Number(rule?.MaximumRetryCount) > 0) return `on-failure:${Number(rule.MaximumRetryCount)}`;
  return name;
}

async function inspectContainer(container, ids) {
  if (!ids.length) return [];
  let text;
  try { text = (await dockerIn(container, ["inspect", "--type", "container", ...ids], WITHOUT_CAP)).stdout; } catch (e) {
    if (!isMissing(e) || !String(e?.stdout || "").trim()) { if (isMissing(e)) return []; throw e; }
    text = e.stdout;
  }
  const l = JSON.parse(text || "[]");
  return Array.isArray(l) ? l : [];
}

/**
 * Step 1 (Docker part): `{ container: [{ id, name, state, restart, compose, service }], stacks: [...] }`.
 * `affected`: `[{ kind: "move"|"leaveOut", abs, … }]` (absolute). A stack is a group of equal compose labels (configKey) with at least
 * one affected container; its kind: `gone` (compose folder under a left-out path), `moved` (under a moved one), else `reference` (it
 * only points into it — stays stopped). `p48` carries `confirmed.stacks` (the check: does the name follow the folder, and what is it
 * called afterwards) — the confirmation applies.
 */
export async function priorDocker(container, affected, confirmed) {
  const inv = await dockerInventory(container);
  const ids = new Map();
  for (const x of affected) for (const y of affectedContainer(inv, x.abs)) ids.set(y.c.id, y.c);
  // A stack the check named a reference (it points into a moved folder with build/env_file — the labels do not show that) counts
  // with all its containers.
  const referenceStacks = new Set((confirmed?.warnings || []).filter((w) => w?.code === "REFERENCE" && w.stack).map((w) => String(w.stack)));
  for (const c of inv.container) if (!c.own && referenceStacks.has(String(c.labels[LABEL.project] || ""))) ids.set(c.id, c);
  const insp = new Map((await inspectContainer(container, [...ids.keys()])).map((i) => [String(i?.Id || ""), i]));
  const list = [];
  for (const [id, c] of ids) {
    const i = insp.get(id);
    if (!i) continue; // gone meanwhile
    list.push({
      id, name: c.name, state: String(i?.State?.Status || c.state || ""), restart: i?.HostConfig?.RestartPolicy || { Name: "" },
      compose: c.labels[LABEL.project] ? String(c.labels[LABEL.project]) : null, service: String(c.labels[LABEL.service] || ""),
    });
  }
  // The stacks: per group of equal labels (like the check).
  const groups = new Map();
  for (const c of inv.container) {
    if (c.own || !c.labels[LABEL.project] || !ids.has(c.id)) continue;
    let k;
    try { k = composeConfig({ Config: { Labels: c.labels } }); } catch (e) { if (e instanceof ComposeConfigError) continue; throw e; }
    const s = configKey(k);
    if (!groups.has(s)) groups.set(s, { k, container: [] });
    groups.get(s).container.push(c);
  }
  const p48 = new Map((confirmed?.stacks || []).filter((s) => s?.followsFolder && s.newName && s.newName !== s.name).map((s) => [String(s.stack), s]));
  const stacks = [];
  for (const { k, container: cs } of groups.values()) {
    const under = (kind) => affected.find((x) => x.kind === kind && underAbs(k.folder, x.abs));
    const kind = under("leaveOut") ? "gone" : under("move") ? "moved" : "reference";
    const e = kind === "moved" ? p48.get(k.project) : null;
    stacks.push({
      project: k.project, folder: k.folder, files: k.files, envFiles: k.envFiles, kind,
      services: [...new Set(cs.map((c) => String(c.labels[LABEL.service] || "")).filter(Boolean))].sort(),
      container: cs.map((c) => ({ id: c.id, name: c.name, service: String(c.labels[LABEL.service] || ""), fixed: fixedContainerName(c) })),
      ...(e ? { p48: { newName: e.newName } } : {}),
    });
  }
  stacks.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { container: list, stacks };
}

/** Step 3: per id `update --restart no` and `stop` (a container that no longer exists is done). */
export async function stopContainer(container, list) {
  const ids = list.map((c) => c.id).filter(Boolean);
  for (const id of ids) {
    try { await dockerIn(container, ["update", "--restart", "no", id], WITHOUT_CAP); } catch (e) { if (!isMissing(e)) throw e; }
  }
  for (const id of ids) {
    try { await dockerIn(container, ["stop", id], WITHOUT_CAP); } catch (e) { if (!isMissing(e)) throw e; }
  }
}

/** The return path: the old restart rule back per id (`no` stays `no`). */
export async function rulesBack(container, list) {
  for (const c of list) {
    const arg = restartArg(c.restart);
    if (arg === "no") continue;
    try { await dockerIn(container, ["update", "--restart", arg, c.id], WITHOUT_CAP); } catch (e) { if (!isMissing(e)) throw e; }
  }
}

/**
 * Step 9: remove the objects that NOW belong to the left-out folders (the same computation as the check) by id — containers, then
 * volumes, networks, images. → `{ removed: { container, volumes, networks, images }, add: [{ kind, name, size }] }`; `add` = what was
 * not in `confirmed.confirmable` (every one is named). `beforeEffect()` runs ONCE right before the first removal (so the procedure
 * knows whether an error has already crossed the turnaround — before it, while reading the inventory, nothing has happened).
 */
export async function removeAway(container, goneAbs, confirmed, { beforeEffect = null } = {}) {
  const removed = { container: [], volumes: [], networks: [], images: [] };
  const add = [];
  if (!goneAbs.length) return { removed, add };
  const inv = await dockerInventory(container);
  const inside = new Map();
  for (const abs of goneAbs) for (const y of affectedContainer(inv, abs)) inside.set(y.c.id, y.c);
  const set = deleteSet(inv, [...inside.keys()]);
  const b = confirmed?.confirmable || { container: [], volumes: [], networks: [], images: [] };
  const contains = (list, key, value) => (list || []).some((x) => String(x?.[key] ?? "") === String(value));
  let takenEffect = false;
  const applies = () => { if (!takenEffect) { takenEffect = true; if (typeof beforeEffect === "function") beforeEffect(); } };
  for (const c of inside.values()) {
    if (!contains(b.container, "id", c.id)) add.push({ kind: "container", name: c.name, size: null });
    applies();
    try { await dockerIn(container, ["rm", "-f", c.id], WITHOUT_CAP); } catch (e) { if (!isMissing(e)) throw e; }
    removed.container.push({ id: c.id, name: c.name });
  }
  for (const v of set.volumes) {
    if (!contains(b.volumes, "name", v.name)) add.push({ kind: "volume", name: v.name, size: v.size ?? null });
    applies();
    try { await dockerIn(container, ["volume", "rm", v.name], WITHOUT_CAP); } catch (e) { if (!isMissing(e)) throw e; }
    removed.volumes.push({ name: v.name, size: v.size ?? null });
  }
  for (const n of set.networks) {
    if (!contains(b.networks, "id", n.id)) add.push({ kind: "network", name: n.name, size: null });
    applies();
    try { await dockerIn(container, ["network", "rm", n.id], WITHOUT_CAP); } catch (e) { if (!isMissing(e)) throw e; }
    removed.networks.push({ id: n.id, name: n.name });
  }
  for (const i of set.images) {
    if (!contains(b.images, "id", i.id)) add.push({ kind: "image", name: i.tags?.[0] || i.id, size: i.size ?? null });
    applies();
    try { await dockerIn(container, ["rmi", "-f", i.id], WITHOUT_CAP); } catch (e) { if (!isMissing(e)) throw e; }
    removed.images.push({ id: i.id, size: i.size ?? null });
  }
  return { removed, add };
}

/**
 * Step 9: the old containers of a renamed stack stay stopped (step 3 set `restart no`) and go to `project_superseded` — the row
 * FIRST (a crash in between finds it and does not rename twice), then, with a fixed `container_name`, `docker rename <id>
 * <name>-old-<short-id>` (otherwise the `up` of the new stack would fail on "name already in use"). → the rows.
 *
 * REPEATABLE: `c.name` comes from the frozen state before — in a second run (crash in the middle of the loop, "retry") the container
 * already carries `afterwards`, and `rename` to its own name is an error for the daemon ("Renaming a container with the same name
 * as its current name"). After the turnaround that meant: every retry failed the same way, the project stayed locked. Hence first
 * the CURRENT name (`inspect`), renamed only if it differs; a foreign container under `afterwards` is a warning (`warn`), no throw —
 * the `up` of the new stack then reports the conflict itself, and the stack stays stopped.
 */
export async function supersede(pid, instance, container, stacks, { warn = () => {} } = {}) {
  const out = [];
  for (const s of stacks) {
    if (!s.p48) continue;
    for (const c of s.container) {
      const afterwards = c.fixed ? `${c.name}-old-${c.id.slice(0, 12)}` : c.name;
      const already = store.supersededOf(pid, instance).find((z) => z.containerId === c.id);
      if (!already) store.rememberSuperseded({ projectId: pid, instance, containerId: c.id, namePrior: c.name, nameNow: afterwards, stackPrior: s.project, stackNow: s.p48.newName });
      if (c.fixed) {
        let now = null;
        try {
          now = String((await dockerIn(container, ["inspect", "--type", "container", "-f", "{{.Name}}", c.id], WITHOUT_CAP)).stdout || "").trim().replace(/^\//, "");
        } catch (e) { if (!isMissing(e)) throw e; } // gone — done
        if (now !== null && now !== afterwards) {
          try { await dockerIn(container, ["rename", c.id, afterwards], WITHOUT_CAP); } catch (e) {
            const t = `${e?.stderr || ""}\n${e?.message || ""}`;
            if (isMissing(e) || /same name as its current name/i.test(t)) { /* gone meanwhile or already named so — done */ }
            else if (e instanceof DockerError && /already in use|Conflict/i.test(t)) {
              warn(T`The old container “${c.name}” could not be renamed to “${afterwards}” — the name is taken; the new stack “${s.p48.newName}” then cannot take its fixed name.`);
            } else throw e;
          }
        }
      }
      out.push({ id: c.id, name: c.name, afterwards, stack: s.project, fresh: s.p48.newName });
    }
  }
  return out;
}

/**
 * A service WITHOUT `image:` (only `build:`) is called `<project>-<service>` by Compose — under the new name of a renamed stack that
 * image does not exist, and `up --no-build --pull never` (compose-config.js upWithoutStartArgs) would always fail: the stack stayed
 * stopped. Recognised by the old container (Compose creates it with the image NAME in `Config.Image`: `<old>-<service>`, before
 * Compose v2 `<old>_<service>`); ITS image (by id) is tagged `<new>-<service>` — only if that name does not exist yet (a second run, an
 * already built image). A foreign `image:` stays untouched. → [targets]
 */
async function imageNamesBringAlong(container, s, name) {
  const withoutLatest = (r) => String(r || "").replace(/:latest$/, "");
  const tagged = [];
  const insp = await inspectContainer(container, s.container.map((c) => c.id));
  for (const i of insp) {
    const service = String(i?.Config?.Labels?.[LABEL.service] || "");
    const ref = withoutLatest(i?.Config?.Image);
    const id = String(i?.Image || "");
    if (!service || !id || (ref !== `${s.project}-${service}` && ref !== `${s.project}_${service}`)) continue;
    const target = `${name}-${service}`;
    if (tagged.includes(target)) continue;
    try { await dockerIn(container, ["image", "inspect", "--format", "{{.Id}}", target], WITHOUT_CAP); continue; } catch (e) { if (!isMissing(e)) throw e; }
    await dockerIn(container, ["tag", id, target], WITHOUT_CAP);
    tagged.push(target);
  }
  return tagged;
}

// The configuration of a stack with new paths (`projection`: absolute → absolute) and, optionally, a new name.
export function configWith(s, projection, name = s.project) {
  const folder = projection(s.folder);
  const files = s.files.map(projection);
  const envFiles = (s.envFiles || []).map(projection);
  const args = ["-p", name, "--project-directory", folder];
  for (const d of files) args.push("-f", d);
  for (const d of envFiles) args.push("--env-file", d);
  return { project: name, folder, files, envFiles, args };
}

async function dryrun(container, k, services, names) {
  const r = await dockerIn(container, upDryrunArgs(k, services), WITHOUT_CAP);
  return dryrunVerdict(`${r.stdout || ""}\n${r.stderr || ""}`, names);
}

/**
 * Step 18: create a moved stack with the new paths (`up --no-start` with all its services — the same volumes; for a renamed stack
 * under the name Compose picks without `-p` in the new folder: new, empty volumes). Dry run before (is the new configuration
 * readable?) and after (does Compose still report something for one of the new containers?). An error from Compose (file, image,
 * configuration) is a WARNING — the stack stays stopped, the job goes on; a standing project container throws.
 * → `{ project, name, outcome: "created" | "stopped", text?, container: [id] }`.
 */
export async function composeNew(container, s, projection) {
  let k = configWith(s, projection);
  let name = s.project;
  if (s.p48) {
    try { name = await composeNameWithoutP(container, k); } catch (e) {
      return { project: s.project, name: s.p48.newName, outcome: "stopped", container: [], text: T`“${s.project}”: the new name could not be read (${short(e?.message, 150)}) — the stack stays stopped.` };
    }
    k = configWith(s, projection, name);
  }
  const failed = (e, where) => {
    // If the project container itself is down (the answer of the outer `docker exec`, it names it), that is no finding about the stack.
    const st = String(e?.stderr || "");
    if (!(e instanceof DockerError || e instanceof ComposeConfigError) || (/is not running|No such container|is paused/i.test(st) && st.includes(String(container)))) throw e;
    return { project: s.project, name, outcome: "stopped", container: [], text: T`“${name}”: Compose reports “${firstRow(e)}” during ${where} — the stack stays stopped.` };
  };
  if (s.p48 && name !== s.project) {
    try { await imageNamesBringAlong(container, s, name); } catch (e) { return failed(e, T("taking over the built images")); }
  }
  try { await dryrun(container, k, s.services, []); } catch (e) { return failed(e, T("the dry run")); }
  // `--force-recreate`: a service without a path in its hash also gets a new container with the new `working_dir` (compose-config.js).
  try { await dockerIn(container, upWithoutStartArgs(k, s.services, { fresh: true }), WITHOUT_CAP); } catch (e) { return failed(e, T("creation")); }
  // The new containers: labels of this name and this folder.
  const inv = await dockerInventory(container);
  const fresh = inv.container.filter((c) => String(c.labels[LABEL.project] || "") === name && path.resolve(String(c.labels[LABEL.folder] || "/")) === path.resolve(k.folder));
  let text = "";
  try {
    const u = await dryrun(container, k, s.services, fresh.map((c) => c.name));
    const open = [...u.fresh, ...u.missing];
    if (open.length) text = T`“${name}”: after creation Compose still reports ${open.join(", ")}.`;
  } catch (e) { text = T`“${name}”: dry run after creation not readable (${firstRow(e)}).`; }
  return { project: s.project, name, outcome: "created", container: fresh.map((c) => c.id), ...(text ? { text } : {}) };
}

/**
 * Step 20 (Docker part): `{ warnings: [text] }` — a container (except the superseded ones and the stopped reference/non-compose
 * containers from before) with `working_dir` under an old path; a file from the labels of a newly created stack that is missing
 * (`missingLabelFiles`).
 */
export async function recheckDocker(pid, container, { oldAbs, stayStopped, newStacks }) {
  const warnings = [];
  const inv = await dockerInventory(container);
  const superseded = store.supersededIds(pid);
  const stopped = new Set(stayStopped);
  for (const c of inv.container) {
    if (c.own || superseded.has(c.id) || stopped.has(c.id)) continue;
    const wd = c.labels[LABEL.folder];
    if (!wd) continue;
    const old = oldAbs.find((a) => underAbs(wd, a));
    if (old) warnings.push(T`The container “${c.name}” still works in the old folder “${path.basename(old)}”.`);
  }
  const seen = new Set();
  for (const c of inv.container) {
    if (!newStacks.has(c.id)) continue;
    let k;
    try { k = composeConfig({ Config: { Labels: c.labels } }); } catch { continue; }
    const s = configKey(k);
    if (seen.has(s)) continue;
    seen.add(s);
    let missing;
    try { missing = await missingLabelFiles(container, k, { raise: true }); } catch (e) { warnings.push(T`“${k.project}”: the files from the labels could not be checked (${firstRow(e)}).`); continue; }
    if (missing.length) warnings.push(T`“${k.project}”: file from the label is missing: ${missing.join(", ")}.`);
  }
  return { warnings };
}
