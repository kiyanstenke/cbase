// The naming rule of the copies. A pure LEAF: the form is in projectbox/creation.js (`COPY_NAME`, `copyInstance` — every
// name, network and mount function checks it there; projectbox/ never imports from stacks/), here is when a name is
// FREE and which one comes automatically. What lives and which refs exist is handed in by the caller (the store, and
// `git for-each-ref` in the main instance) — this leaf asks nothing itself.
//
// nameError(name)          null if `name` has the form (`^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$`, not `main`), otherwise
//                          the sentence why not. Fit for DNS and branches, no prefix shared with the main instance.
// nameFree(name, { live, refs, backups })
//                          free means: the form is right, no LIVE copy of the project carries it (`live`: names), no
//                          backup folder of the project carries it (`backups`: the names under
//                          `<data>/copies-backup/<pid>/`, location.js projectCopiesLocation — the backup is kept per
//                          NAME and survives the clearing away; a second copy of the same name would write its bundles
//                          into the same folder), and no ref of a repo of the main instance is under `copy/<name>/` in
//                          one of the THREE spaces the fetch writes to (`refs/heads/`, `refs/tags/`, `refs/notes/` —
//                          fetch.js copyTarget/copyTagTarget/copyNoteTarget), nor the ref `copy/<name>` itself, nor a
//                          ref named exactly `copy` — git would not create one below it. `refs`: full names
//                          (`refs/heads/…`, `refs/tags/…`, `refs/notes/…`) or short ones (`copy/k1/main` = branch);
//                          other refs (remote ones) do not count. `backups` is MANDATORY (an array, even empty):
//                          without it the rule throws — "I did not look" is not "none there".
// automaticName({ live, refs, backups })
//                          the first free `k<n>` from n = 1 — a leftover ref `copy/k1/x` ⇒ `k2`. Cap 10,000, with a
//                          sentence. If a ref `copy` blocks the whole space, it throws the sentence from spaceError
//                          instead of counting.
// spaceError(refs)         null, or the sentence that a branch, a tag or a note named exactly `copy` blocks the space
//                          of the copies (`update-ref refs/heads/copy/k1/main` fails next to `refs/heads/copy`; the
//                          same for `refs/tags/copy` and `refs/notes/copy`).
// copyInstanceOf(name)     `copy-<name>` (creation.js copyInstance; throws outside the form).
import { T } from "../i18n.js";
import { MAIN, COPY_NAME, copyInstance } from "../projectbox/creation.js";

export const AUTO_PREFIX = "k";
export const AUTO_CAP = 10_000;
// The space of a copy's branches in the repo of the main instance (the fetch writes there).
export const REF_SPACE = "copy";
const HEADS = "refs/heads/";

export function nameError(name) {
  if (typeof name !== "string") return T("the name of a copy is a string");
  if (name === MAIN) return T`"${MAIN}" is the main instance, not a name of a copy`;
  if (!COPY_NAME.test(name)) return T`"${name}": 1–24 characters from a–z, 0–9 and "-", no "-" at the edge`;
  return null;
}

// The three spaces the fetch writes to (fetch.js copyTarget, copyTagTarget, copyNoteTarget) — the same rule per space.
export const REF_CLEAN = Object.freeze([[HEADS, "Branch"], ["refs/tags/", "Tag"], ["refs/notes/", "note"]].map((x) => Object.freeze(x)));

// The name without its space, and the kind (Branch/Tag/note) — or null for a ref outside the three spaces (remote ones).
// A short name without `refs/` is a branch.
function shortRef(ref) {
  const r = String(ref ?? "").trim();
  if (!r) return null;
  for (const [front, kind] of REF_CLEAN) if (r.startsWith(front)) return { k: r.slice(front.length), kind };
  return r.startsWith("refs/") ? null : { k: r, kind: "Branch" };
}

/** Does a branch, tag or note named exactly `copy` block the space of the copies? → the sentence or null. */
export function spaceError(refs = []) {
  const hits = (refs || []).map(shortRef).find((x) => x?.k === REF_SPACE);
  if (!hits) return null;
  const who = hits.kind === "note" ? T`A note "refs/notes/${REF_SPACE}"` : T`A ${hits.kind} "${REF_SPACE}"`;
  return T`${who} in a repo of the main instance blocks the space of the copies (${REF_SPACE}/<name>/…) — git creates ` +
    T`no ref below next to ${hits.kind === "note" ? T("it##note") : T("it##ref")}. Rename ${hits.kind === "note" ? T("the note") : T`the ${hits.kind}`} "${REF_SPACE}", then it works.`;
}

/** Has any ref occupied the space of this name (`copy/<name>` or below — or a ref `copy` itself), in one of the three
 *  spaces? */
export function refOccupied(name, refs = []) {
  const space = `${REF_SPACE}/${name}`;
  return (refs || []).some((ref) => {
    const k = shortRef(ref)?.k;
    return k !== undefined && (k === REF_SPACE || k === space || k.startsWith(`${space}/`));
  });
}

// `backups` is missing or not an array ⇒ throws (head: mandatory).
function backupNames(backups) {
  if (!Array.isArray(backups)) {
    throw new Error("naming rule of the copies: `backups` is missing — the names under copies-backup/<pid>/ belong to it");
  }
  return backups;
}

export function nameFree(name, { live = [], refs = [], backups } = {}) {
  if (nameError(name) !== null) return false;
  if (backupNames(backups).includes(name)) return false;
  if ((live || []).includes(name)) return false;
  return !refOccupied(name, refs);
}

export function automaticName({ live = [], refs = [], backups } = {}) {
  backupNames(backups);
  const space = spaceError(refs);
  if (space) throw new Error(space);
  for (let n = 1; n <= AUTO_CAP; n++) {
    const name = `${AUTO_PREFIX}${n}`;
    if (nameFree(name, { live, refs, backups })) return name;
  }
  throw new Error(T`no free name ${AUTO_PREFIX}1…${AUTO_PREFIX}${AUTO_CAP} — cap of the automatic names reached`);
}

export const copyInstanceOf = (name) => copyInstance(name);
