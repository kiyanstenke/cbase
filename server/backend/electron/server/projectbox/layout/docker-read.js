// The Docker inventory of the layout. READ ONLY: no call here changes anything in the inner daemon (ps, inspect, images, volume
// ls/inspect, system df, network ls/inspect, compose config).
//
// Everything runs in the INNER daemon of the project container through `dockerIn(…, { capMs: 0 })` or `execIn` (content has no
// deadline — a large daemon needs minutes for `system df -v`). Read as in the relocation (`projectbox/relocation/collect.js`
// collectDocker: `ps -a -q --no-trunc`, `inspect` in bundles, images, volumes with sizes from `system df -v --format "{{json .}}"`
// with `sizeFromText` — the docker CLI 20.10 of the project container does not know `--format json` for it and delivers sizes as
// text). Containers of cbase never count (`../own-labels.js`).
//
//   dockerInventory(container)                 → { container, images, volumes, networks } (normalized, see `containerView`)
//   referencesOf(c)                             → [{ kind, path }] — working_dir, config_files, environment_file (labels), bind (mounts)
//   affectedContainer(inv, abs)             the containers with a reference under `abs`
//   deleteSet(inv, within)                  volumes, networks, images of the containers `within` that serve no container OUTSIDE —
//                                             `{ volumes, networks, images, stays }`
//   fetchedObjects(inv, within)             the same selection without the verdict "outside needs it"
//   setPerPath(inv, total, ids)              the ONE delete set of all left-out containers, cut per path for display
//   compose name (rename case):
//     normalizeProjectName(s)              Compose's rule (lower case, only [-_a-z0-9], no leading `_`/`-`)
//     composeNameArgs(k)                      `env -u COMPOSE_PROJECT_NAME docker compose --project-directory … -f … [--env-file …]
//                                             config --format json --no-interpolate` — WITHOUT `-p` (see below)
//     composeNameWithoutP(container, k)          the name Compose picks without `-p` — or throws
//     fixedContainerName(c)                  does the container carry its own `container_name`?
//   modelReferences(container, k)               what a stack's model (configModelArgs) points to as paths — build.context, bind
//                                             sources, env_file; ONLY paths leave the function (the model carries values)
//
// WHY WITHOUT `-p`: `composeConfig` always sets `-p <label name>`, and `-p` overrules `name:` — the question is the name Compose picks at
// the NEXT `up` without `-p`. Compose's order (measured): `-p` > environment > `.env` > `name:` > folder. The call's environment must
// not carry the variable (`dockerIn` passes the container's environment through) — hence `env -u COMPOSE_PROJECT_NAME` INSIDE the
// container (removed, not emptied: how Compose reads an empty value is not measured). `--env-file` from the label goes along: it is the
// file the stack was created with (instead of the `.env`).

import path from "node:path";
import { dockerIn, execIn } from "../docker.js";
import { configModelArgs, LABEL, labelsOf } from "../compose-config.js";
import { isOwnContainer } from "../own-labels.js";
import { sizeFromText } from "../relocation/collect.js";

export const INSPECT_BUNDLE = 50;
const WITHOUT_CAP = { capMs: 0 };

const rows = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const unique = (xs) => [...new Set(xs)];
const list = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
/** Does the relative path `r` (from `path.relative`) lie in its base? By WHOLE path parts: `..old` is a name below it, only `..` and
 *  `../…` lie outside (`startsWith("..")` would take a folder `..old` for outside). */
export const relInside = (r) => r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
/** Does the absolute path `p` lie under `base` (or is it)? */
export const underAbs = (p, base) => relInside(path.relative(base, path.resolve(String(p))));

// `inspect` of several ids fails on ONE vanished (exit 1) and prints the rest — we take those (like relocation/collect.js).
async function inspectBundle(container, front, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += INSPECT_BUNDLE) {
    const part = ids.slice(i, i + INSPECT_BUNDLE);
    let text;
    try { text = (await dockerIn(container, [...front, ...part], WITHOUT_CAP)).stdout; } catch (e) {
      if (!/No such/i.test(String(e?.stderr || e?.message || "")) || !String(e?.stdout || "").trim()) throw e;
      text = e.stdout;
    }
    const l = JSON.parse(text || "[]");
    if (!Array.isArray(l)) throw new Error(`docker ${front.join(" ")}: not a list`);
    out.push(...l);
  }
  return out;
}

const containerView = (c, imageLabels) => {
  const labels = labelsOf(c);
  return {
    id: String(c?.Id || ""),
    name: String(c?.Name || "").replace(/^\//, ""),
    state: String(c?.State?.Status || ""),
    imageId: String(c?.Image || ""),
    labels,
    own: isOwnContainer(labels, imageLabels),
    mounts: (Array.isArray(c?.Mounts) ? c.Mounts : []).map((m) => ({ type: String(m?.Type || ""), source: String(m?.Source || ""), name: m?.Name ? String(m.Name) : null, target: String(m?.Destination || "") })),
    networks: Object.keys(c?.NetworkSettings?.Networks || {}),
  };
};

/** The inventory of the inner daemon (see header). Throws if a read fails (the caller turns that into "unknown"). */
export async function dockerInventory(container) {
  const ids = rows((await dockerIn(container, ["ps", "-a", "-q", "--no-trunc"], WITHOUT_CAP)).stdout);
  const raw = ids.length ? await inspectBundle(container, ["inspect", "--type", "container"], unique(ids)) : [];
  const imageIds = unique([...rows((await dockerIn(container, ["images", "-q", "--no-trunc"], WITHOUT_CAP)).stdout), ...raw.map((c) => c?.Image).filter(Boolean)]);
  const images = (imageIds.length ? await inspectBundle(container, ["image", "inspect"], imageIds) : []).map((i) => ({
    id: String(i?.Id || ""), tags: Array.isArray(i?.RepoTags) ? i.RepoTags.map(String) : [],
    size: Number.isFinite(i?.Size) ? i.Size : null,
    // Without `Config` the label is unknown — `labels` null (never "no labels").
    labels: i?.Config && typeof i.Config === "object" ? (i.Config.Labels && typeof i.Config.Labels === "object" ? i.Config.Labels : {}) : null,
  }));
  const image = new Map(images.map((i) => [i.id, i.labels]));
  const container_ = raw.map((c) => containerView(c, image.get(String(c?.Image || "")) ?? null));
  const volNames = rows((await dockerIn(container, ["volume", "ls", "-q"], WITHOUT_CAP)).stdout);
  const volRaw = volNames.length ? await inspectBundle(container, ["volume", "inspect"], unique(volNames)) : [];
  let sizes = null;
  try {
    const df = JSON.parse((await dockerIn(container, ["system", "df", "-v", "--format", "{{json .}}"], WITHOUT_CAP)).stdout || "{}");
    sizes = new Map((Array.isArray(df?.Volumes) ? df.Volumes : []).map((v) => [v?.Name, sizeFromText(v?.Size)]));
    // Images: `inspect` carries the size as a number; if it is missing there, the text size from `system df` (real CLI 20.10).
    for (const d of Array.isArray(df?.Images) ? df.Images : []) {
      const i = images.find((x) => x.size === null && (x.id === d?.ID || x.id === `sha256:${d?.ID}` || x.id.startsWith(`sha256:${d?.ID}`)));
      if (i) i.size = sizeFromText(d?.Size);
    }
  } catch (e) {
    console.error(`[layout] docker system df not readable — volume sizes unknown: ${String(e?.message || e).slice(0, 200)}`);
  }
  const volumes = volRaw.map((v) => {
    const g = sizes?.get(v?.Name);
    return { name: String(v?.Name || ""), labels: v?.Labels && typeof v.Labels === "object" ? v.Labels : {}, size: Number.isFinite(g) ? g : null };
  });
  const networkIds = rows((await dockerIn(container, ["network", "ls", "-q", "--no-trunc"], WITHOUT_CAP)).stdout);
  const networks = (networkIds.length ? await inspectBundle(container, ["network", "inspect"], unique(networkIds)) : [])
    .map((n) => ({ id: String(n?.Id || ""), name: String(n?.Name || ""), labels: n?.Labels && typeof n.Labels === "object" ? n.Labels : {} }));
  return { container: container_, images, volumes, networks };
}

/** What a container points to: Compose folder, files, environment files (labels) and bind sources (mounts), each absolute. */
export function referencesOf(c) {
  const out = [];
  const wd = c.labels[LABEL.folder];
  if (wd) out.push({ kind: "working_dir", path: path.resolve(String(wd)) });
  for (const d of list(c.labels[LABEL.files])) out.push({ kind: "config_files", path: path.resolve(d) });
  for (const d of list(c.labels[LABEL.envFiles])) out.push({ kind: "environment_file", path: path.resolve(d) });
  for (const m of c.mounts) if (m.type === "bind" && m.source) out.push({ kind: "bind", path: path.resolve(m.source) });
  return out.filter((b) => path.isAbsolute(b.path));
}

/** The containers (without those of cbase) with a reference under `abs` — each `{ c, kinds }`. */
export function affectedContainer(inv, abs) {
  const out = [];
  for (const c of inv.container) {
    if (c.own) continue;
    const kinds = unique(referencesOf(c).filter((b) => underAbs(b.path, abs)).map((b) => b.kind));
    if (kinds.length) out.push({ c, kinds });
  }
  return out;
}

/** A container's view in the check result (no values, only names, state and Compose membership). */
export const containerRow = ({ c, kinds }) => ({
  id: c.id, name: c.name, state: c.state, reference: kinds,
  compose: c.labels[LABEL.project] ? { project: String(c.labels[LABEL.project]), service: String(c.labels[LABEL.service] || "") } : null,
});

/**
 * What falls with the containers `within` (ids) — and what stays because a container OUTSIDE needs it. A volume belongs to it if a
 * container inside mounts it OR it carries the Compose label of a project from inside; a network if it is called `<project>_default`
 * or carries the label; an image if it carries the label. Outside = every other container (one of cbase too). Selecting by label
 * alone would take along a shared volume (counter-proof in the test).
 */
export function deleteSet(inv, within) {
  const inside = new Set(within);
  const outside = inv.container.filter((c) => !inside.has(c.id));
  const user = (check) => outside.filter(check).map((c) => c.name);
  const volumes = [], networks = [], images = [], stays = [];
  const b = fetchedObjects(inv, within);
  for (const v of b.volumes) {
    const who = user((c) => c.mounts.some((m) => m.type === "volume" && m.name === v.name));
    if (who.length) stays.push({ kind: "volume", name: v.name, size: v.size, usedBy: who });
    else volumes.push({ name: v.name, size: v.size });
  }
  for (const n of b.networks) {
    const who = user((c) => c.networks.includes(n.name));
    if (who.length) stays.push({ kind: "network", name: n.name, usedBy: who });
    else networks.push({ id: n.id, name: n.name });
  }
  for (const i of b.images) {
    const who = user((c) => c.imageId === i.id);
    if (who.length) stays.push({ kind: "image", name: i.tags[0] || i.id, size: i.size, usedBy: who });
    else images.push({ id: i.id, tags: i.tags, size: i.size });
  }
  return { volumes, networks, images, stays };
}

/** Which volumes, networks and images concern the containers `within` (ids) — the selection of deleteSet, WITHOUT the verdict whether
 *  a container outside needs them: mounted or with the Compose label of a project from inside (volumes), label or `<project>_default`
 *  (networks), label (images). */
export function fetchedObjects(inv, within) {
  const inside2 = new Set(within);
  const inside = inv.container.filter((c) => inside2.has(c.id));
  const projects = new Set(inside.map((c) => c.labels[LABEL.project]).filter(Boolean).map(String));
  const mounted = new Set(inside.flatMap((c) => c.mounts.filter((m) => m.type === "volume" && m.name).map((m) => m.name)));
  return {
    volumes: inv.volumes.filter((v) => mounted.has(v.name) || projects.has(String(v.labels[LABEL.project] || ""))),
    networks: inv.networks.filter((n) => projects.has(String(n.labels[LABEL.project] || "")) || [...projects].some((p) => n.name === `${p}_default`)),
    images: inv.images.filter((i) => projects.has(String(i.labels?.[LABEL.project] || ""))),
  };
}

/**
 * The delete set is ONE over all left-out containers (`total` = deleteSet over all — exactly the computation step 9 runs,
 * docker-rebuild.js removeAway), cut for DISPLAY per path to what the containers `ids` of this path concern. Computed per path, the
 * container of the OTHER left-out path held a shared volume "outside": the question showed it under "stays", step 9 deleted it. An
 * object that concerns two paths appears at both.
 */
export function setPerPath(inv, total, ids) {
  const b = fetchedObjects(inv, ids);
  const vol = new Set(b.volumes.map((v) => v.name));
  const network = new Set(b.networks.map((n) => n.id));
  const networkName = new Set(b.networks.map((n) => n.name));
  const image = new Set(b.images.map((i) => i.id));
  const imageName = new Set(b.images.map((i) => i.tags[0] || i.id));
  return {
    volumes: total.volumes.filter((v) => vol.has(v.name)),
    networks: total.networks.filter((n) => network.has(n.id)),
    images: total.images.filter((i) => image.has(i.id)),
    stays: total.stays.filter((x) => (x.kind === "volume" ? vol.has(x.name) : x.kind === "network" ? networkName.has(x.name) : imageName.has(x.name))),
  };
}

// ── The Compose name without `-p` ───────────────────────────────────────────────────────────────────────────────────────

/** Compose's rule for a project name from a folder name (normalizeProjectName in compose-go). */
export const normalizeProjectName = (s) => String(s ?? "").toLowerCase().replace(/[^-_a-z0-9]+/g, "").replace(/^[_-]+/, "");

/** The call INSIDE the container (see header) — `k` from composeConfig (folder, files, envFiles). */
export const composeNameArgs = (k) => [
  "env", "-u", "COMPOSE_PROJECT_NAME", "docker", "compose", "--project-directory", k.folder,
  ...k.files.flatMap((d) => ["-f", d]), ...k.envFiles.flatMap((d) => ["--env-file", d]),
  "config", "--format", "json", "--no-interpolate",
];

/** The name Compose picks without `-p`. Throws (call failed, no JSON, no name) — without passing on stdout/stderr (the model
 *  carries values). */
export async function composeNameWithoutP(container, k) {
  let r;
  try { r = await execIn(container, composeNameArgs(k), WITHOUT_CAP); } catch (e) {
    throw new Error(`compose config without -p for ${k.project}: exit ${e?.code ?? "?"}`);
  }
  let d;
  try { d = JSON.parse(String(r.stdout || "")); } catch { throw new Error(`compose config without -p for ${k.project}: no JSON output`); }
  const name = d && typeof d === "object" && typeof d.name === "string" ? d.name : "";
  if (!name) throw new Error(`compose config without -p for ${k.project}: no name in the model`);
  return name;
}

/** Does the container carry a fixed `container_name`? Compose's own names are `<project>-<service>-<n>` (v2) or
 *  `<project>_<service>_<n>` (v1). */
export function fixedContainerName(c) {
  const p = c.labels[LABEL.project], d = c.labels[LABEL.service], n = c.labels[LABEL.number];
  if (!p || !d) return false;
  return c.name !== `${p}-${d}-${n || 1}` && c.name !== `${p}_${d}_${n || 1}`;
}

// ── References between stacks ───────────────────────────────────────────────────────────────────────────────────────────

/** What a stack's model points to as paths (see header): `[{ kind, path }]`, absolute. Throws like composeNameWithoutP. */
export async function modelReferences(container, k) {
  let r;
  try { r = await dockerIn(container, configModelArgs(k), WITHOUT_CAP); } catch (e) {
    throw new Error(`compose config for ${k.project}: exit ${e?.code ?? "?"}`);
  }
  let d;
  try { d = JSON.parse(String(r.stdout || "")); } catch { throw new Error(`compose config for ${k.project}: no JSON output`); }
  const out = [];
  const absolute = (p) => (typeof p === "string" && p ? path.resolve(k.folder, p) : null);
  for (const s of Object.values(d?.services && typeof d.services === "object" ? d.services : {})) {
    if (!s || typeof s !== "object") continue;
    const ctx = typeof s.build === "string" ? s.build : s.build && typeof s.build === "object" ? s.build.context : null;
    if (absolute(ctx)) out.push({ kind: "build", path: absolute(ctx) });
    for (const ef of Array.isArray(s.env_file) ? s.env_file : s.env_file ? [s.env_file] : []) {
      const p = absolute(typeof ef === "string" ? ef : ef?.path);
      if (p) out.push({ kind: "env_file", path: p });
    }
    for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
      if (v && typeof v === "object" && v.type === "bind" && absolute(v.source)) out.push({ kind: "bind", path: absolute(v.source) });
    }
  }
  return out;
}
