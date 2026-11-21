// Old states for counter-tests. A counter-test proves a guard by running it against the code as it was BEFORE a fix.
// Those earlier files used to come from `git show <commit>:<path>`; they are checked in instead, under
// <root>/oldstates/<commit>/<path>.old (translated to today's names) and .raw (the bytes of then), so the suite runs from a tree without history.
//
// The old states belong to the private part of the tree (its deploy folder, `oldstates/`) and are never exported. The public
// counter-tests carry small fixtures of their own; only the maintainer's private suite reads old states. In a public tree this module still
// loads, `hasOldStateRaw` answers false, and `oldState`/`oldStateRaw` throw an error that says why — never a crash on a missing folder.
// A spec names the path as it was at the commit; the deploy tool stood under `tools/deploy/` then (and again today), and its
// old states were filed under the private deploy folder while it lay there, so `tools/deploy/<rest>` is looked up there.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVATE_ROOT } from "../cleanliness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OLDSTATE_ROOTS = [path.join(HERE, "..", "..", "..", PRIVATE_ROOT, "deploy", "oldstates")];

/** Whether the private old states are present (false in an exported public tree). */
export const oldStatesPresent = () => OLDSTATE_ROOTS.some((r) => fs.existsSync(r));

// The files a spec can stand for, in lookup order.
function candidates(spec, ext) {
  const cut = String(spec).indexOf(":");
  const rel = spec.slice(cut + 1).replace(/^tools\/deploy\//, `${PRIVATE_ROOT}/deploy/`);
  return OLDSTATE_ROOTS.map((r) => path.join(r, spec.slice(0, cut), `${rel}.${ext}`));
}

function read(spec, ext) {
  const file = candidates(spec, ext).find((f) => fs.existsSync(f));
  if (!file) {
    if (process.env.CBASE_OLDSTATE_MISSING) fs.appendFileSync(process.env.CBASE_OLDSTATE_MISSING, `${spec}\n`);
    const why = oldStatesPresent()
      ? `it is not checked in under the private old states (.${ext})`
      : "the old states are private and absent from this tree — a public test must use a fixture of its own";
    throw new Error(`old state ${spec}: ${why}`);
  }
  return fs.readFileSync(file, "utf8");
}

/** oldState("<commit>:<path>") — the file as it was at that commit, with today's names. Throws when it is not checked in. */
export function oldState(spec) {
  return read(spec, "old");
}

/**
 * oldStateRaw("<commit>:<path>") — the untouched bytes of that commit (old names included), for anchors that hang on
 * them (a sha256, a measured path). Lives next to the translated state as <path>.raw; <path> is today's path.
 */
export function oldStateRaw(spec) {
  return read(spec, "raw");
}

/** Whether the raw state is checked in — for tests that ask which files existed at a commit. */
export function hasOldStateRaw(spec) {
  return candidates(spec, "raw").some((f) => fs.existsSync(f));
}
