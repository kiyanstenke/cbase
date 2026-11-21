// The location of a copy. A pure LEAF (only node:path and the root from projectbox/creation.js): the ONLY place of the
// literals below the root of a copy — `layer`, `objects`, `work`, `open`, `returnPath`, `snapshot.json`, `overlays.tsv`,
// `.prepared` — and of the backup folder `copies-backup`. Path guard in server/backend/test/stacks-schema.test.js (with
// built-in sabotage): a literal outside this file is red, except for the named exceptions there (words that are
// spelled the same but are not a path).
//
// The root itself (`<data>/copies/<pid>/<name>`) is computed by projectbox/creation.js `copyRoot` — the copy mounts it
// there (`/cbase-copy`, COPY_ROOT_INSIDE), and projectbox/ never imports from stacks/. The names `overlays.tsv` and
// `.prepared` are read by the copy's entrypoint (server/backend/projectbox-entry.sh); bound in the same test.
//
// copyLocation({ data, projectId, name })  → { root, inside, backup } — `root` the paths in the user container (below
//   `<data>/copies/…`), `inside` the same paths as the copy sees them (below `/cbase-copy`: the rows of overlays.tsv name
//   them that way), `backup` = `<data>/copies-backup/<pid>/<name>` (bundles of new repos — survives the clearing away,
//   gone only with the project and `purge=1`), in it `bundle(j)` = `n<j>.bundle` (the j-th new repo) and `ignoredTar` =
//   `ignored.tar` (the upper layer of the ignored files on an automatic clearing away). Per side:
//     base                   the root
//     layer(part)            `layer/<part>` — the upper layer: `p` (project folder), `r<i>` (repo i), `local` (~/.local)
//     layers                 `layer/` itself — the folder of ALL upper layers (a copy from a copy takes it over whole
//                            from its template, stacks/freeze.js)
//     layerObjects(part)     `layer/<part>.objects` — the upper layer of the object overlays (`p`, `r<i>`)
//     objects(part)          `objects/<part>` — the hard links to objects of the main instance, a LOWER layer
//     work(i)                `work/w<i>` — the workdir of the i-th overlay
//     open                   `open/` — files that were open during the pause
//     returnPath(part)       `returnPath/<part>.git` — the bare repo of a repo's return path: `part` is `p` or `r<i>`;
//                            an integer i stands for `r<i>`
//     returnPathFolder       `returnPath/` itself (created by stacks/objects.js createReturnPath; the return-path helper
//                            mounts it rw)
//     snapshot               `snapshot.json`
//     overlays               `overlays.tsv` (read by the entrypoint)
//     prepared               `.prepared` (the marker the entrypoint waits for)
// projectCopiesLocation({ data, projectId })  → { copies, backup } — the folders of ALL copies of a project (delete with
//   purge).
// neverMountedCopies({ data })  the entries projectbox/creation.js `neverMounted` gets as an addition via the context of
//   the creation (projectbox/instance.js setNeverMountedAddition, set in server.js — projectbox/ never imports stacks/):
//   `<data>/copies-backup` with everything below. The root `<data>/copies` is listed there itself (COPIES_FOLDER).
// A part outside the form (`p`, `local`, `r<i>`), an index that is not an integer ≥ 0, an invalid name or an invalid
// project id THROW — a path from a wrong input would otherwise land next to the copy.
import path from "node:path";
import { COPIES_FOLDER, COPY_ROOT_INSIDE, copyInstance, copyRoot } from "../projectbox/creation.js";

export const BACKUP_FOLDER = "copies-backup";
export const OVERLAYS_FILE = "overlays.tsv";
export const PREPARED_FILE = ".prepared";
export const SNAPSHOT_FILE = "snapshot.json";
const LAYER = "layer";
const OBJECTS = "objects";
const WORK = "work";
const OPEN = "open";
const RETURN_PATH = "returnPath";
const OBJECTS_SUFFIX = ".objects";
const GIT_SUFFIX = ".git";
const BUNDLE_SUFFIX = ".bundle";
const IGNORED_TAR = "ignored.tar";

const index = (i) => {
  if (!Number.isInteger(i) || i < 0) throw new TypeError(`location of the copy: index "${i}" is not an integer ≥ 0`);
  return i;
};
const partCheck = (part, allowed) => {
  const t = String(part ?? "");
  if (!allowed.includes(t) && !/^r(0|[1-9][0-9]*)$/.test(t)) throw new TypeError(`location of the copy: part "${t}" is none (${allowed.join(", ")}, r<i>)`);
  return t;
};

function page(base) {
  return Object.freeze({
    base,
    layer: (part) => path.join(base, LAYER, partCheck(part, ["p", "local"])),
    layers: path.join(base, LAYER),
    layerObjects: (part) => path.join(base, LAYER, `${partCheck(part, ["p"])}${OBJECTS_SUFFIX}`),
    objects: (part) => path.join(base, OBJECTS, partCheck(part, ["p"])),
    work: (i) => path.join(base, WORK, `w${index(i)}`),
    open: path.join(base, OPEN),
    returnPath: (part) => path.join(base, RETURN_PATH, `${Number.isInteger(part) ? `r${index(part)}` : partCheck(part, ["p"])}${GIT_SUFFIX}`),
    returnPathFolder: path.join(base, RETURN_PATH),
    snapshot: path.join(base, SNAPSHOT_FILE),
    overlays: path.join(base, OVERLAYS_FILE),
    prepared: path.join(base, PREPARED_FILE),
  });
}

export function copyLocation({ data, projectId, name }) {
  const instance = copyInstance(name); // throws outside the form
  const root = copyRoot({ data, projectId, instance }); // throws for a relative data path and invalid project ids
  const backup = path.join(data, BACKUP_FOLDER, String(projectId), name);
  return Object.freeze({
    root: page(root),
    inside: page(COPY_ROOT_INSIDE),
    backup,
    bundle: (j) => path.join(backup, `n${index(j)}${BUNDLE_SUFFIX}`),
    ignoredTar: path.join(backup, IGNORED_TAR),
  });
}

export function projectCopiesLocation({ data, projectId }) {
  // The same check as for a copy (via a valid placeholder name): a relative data path and invalid ids throw.
  const copies = path.dirname(copyRoot({ data, projectId, instance: copyInstance("k1") }));
  if (path.basename(path.dirname(copies)) !== COPIES_FOLDER) throw new Error(`location of the copies: ${copies} is not below ${COPIES_FOLDER}`);
  return Object.freeze({ copies, backup: path.join(data, BACKUP_FOLDER, String(projectId)) });
}

export function neverMountedCopies({ data }) {
  if (typeof data !== "string" || !path.isAbsolute(data)) throw new TypeError("neverMountedCopies: data must be an absolute path");
  return [{ path: path.join(data, BACKUP_FOLDER), reason: "backups of the copies", below: true }];
}
