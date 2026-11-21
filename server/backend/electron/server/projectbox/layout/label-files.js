// A LEAF: which files from the Compose labels of a stack are missing. Origin: stacks/result.js — moved here because projectbox/ may never
// import stacks/ (server/backend/test/import-direction.test.js) and step 20 of the layout (the re-check) asks the same question;
// stacks/result.js now imports it from here (the allowed direction).
//
//   missingLabelFiles(container, k, { capMs, raise })  → [rel | abs]
//     `k` from projectbox/compose-config.js composeConfig (`folder`, `files`, `envFiles`). Checked IN the container (`[ -e ]`, a `sh -c`
//     with the paths as arguments — none of them in the script text); only the indices of the missing ones come back, the names come
//     from the own list (paths, no values). Relative to the Compose folder where they lie below it, else absolute. If the call fails,
//     the answer is `[]` (the caller then keeps its original finding) — with `{ raise: true }` it throws instead (step 20: "not
//     checkable" is not "nothing is missing").
import path from "node:path";
import { execIn } from "../docker.js";

export const MISSING_SCRIPT = 'i=0; for f in "$@"; do [ -e "$f" ] || printf "%s\\n" "$i"; i=$((i+1)); done';

export async function missingLabelFiles(container, k, { capMs = 0, raise = false } = {}) {
  const all = [...(k?.files || []), ...(k?.envFiles || [])];
  if (!all.length) return [];
  let r;
  try { r = await execIn(container, ["sh", "-c", MISSING_SCRIPT, "sh", ...all], { capMs }); } catch (e) {
    if (raise) throw e;
    return [];
  }
  const idx = new Set(String(r.stdout || "").split("\n").filter((z) => /^\d{1,4}$/.test(z)).map(Number));
  return all.filter((_, i) => idx.has(i)).map((d) => {
    const rel = path.relative(k.folder, d);
    return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : d; // by path parts
  });
}
