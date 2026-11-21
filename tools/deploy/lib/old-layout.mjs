// Old states of deploy modules are copied to a temp folder for counter-tests, and their relative imports are rewritten to the REAL
// modules of today. The old files were written for ONE folder (`tools/deploy/` then: `./sh.mjs`, `../config.mjs`); today the tool is
// split — the gate's libraries (sh, log, asar, …) live in tools/check, the tool in tools/deploy, its private remainder (pinSync,
// baseline, …) in the private part — with the same relative layout under each root. `oldModuleUrl(spec, baseHref)` resolves such a spec
// against the base as before and, when the file is not in tools/deploy any more, finds it at the same relative place in tools/check
// or in the private remainder (where the tree carries it). Returns a file URL string, like `new URL(spec, base).href`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRIVATE_DEPLOY_DIR } from "./private-part.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOY_DIR = path.resolve(HERE, "..");
export const TOOLS_CHECK = path.resolve(HERE, "..", "..", "check");
const ELSEWHERE = [TOOLS_CHECK, PRIVATE_DEPLOY_DIR];

// Today's place of a file of the old one-folder layout, or null.
function movedTo(file) {
  const rel = path.relative(DEPLOY_DIR, file);
  if (rel.startsWith("..")) return null;
  return ELSEWHERE.map((root) => path.join(root, rel)).find((p) => fs.existsSync(p)) || null;
}

export function oldModuleUrl(spec, baseHref) {
  const url = new URL(spec, baseHref);
  if (url.protocol !== "file:") return url.href;
  const file = fileURLToPath(url);
  if (fs.existsSync(file)) return url.href;
  const moved = movedTo(file);
  return moved ? pathToFileURL(moved).href : url.href;
}

/** The same for a plain path (a spec resolved by the caller): today's place of a deploy-layout file. */
export function deployLayoutPath(file) {
  if (fs.existsSync(file)) return file;
  return movedTo(file) || file;
}
