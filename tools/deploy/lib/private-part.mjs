// The private remainder of the deploy tool: present in the maintainer's tree, absent from the public one.
//
// The deploy tool itself is public (tools/deploy). A few parts stay private because they read measurements of the Claude Code binary
// or the private tree layout: the `baseline` target, the pin-sync guard (lib/pinSync.mjs) and the merged gate plan (lib/ops-gate.mjs,
// which adds the private suites and the second register). The public tool reaches them ONLY through `importPrivate` — a dynamic
// import behind an existence check, never a static import — so every file of tools/deploy loads in a tree without the private part.
// Guard: tools/deploy/public-closure-deploy.test.mjs (no static import of the private part in the closure of tools/deploy).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRIVATE_ROOT } from "../../check/cleanliness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The private remainder's folder, repo-relative and absolute. */
export const PRIVATE_DEPLOY_REL = `${PRIVATE_ROOT}/deploy`;
export const PRIVATE_DEPLOY_DIR = path.resolve(HERE, "..", "..", "..", PRIVATE_ROOT, "deploy");

/** Whether the private module `rel` (relative to PRIVATE_DEPLOY_REL) is present in this tree. */
export const privatePresent = (rel) => fs.existsSync(path.join(PRIVATE_DEPLOY_DIR, rel));

/** The private module `rel` (relative to PRIVATE_DEPLOY_REL), or null when this tree does not carry it. */
export async function importPrivate(rel) {
  const file = path.join(PRIVATE_DEPLOY_DIR, rel);
  if (!fs.existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

/** The sentence for a command that needs the private part in a tree without it. */
export const needsPrivatePart = (what, rel) =>
  `${what} needs the private part of the deploy tool (${PRIVATE_DEPLOY_REL}/${rel}), which this tree does not carry.`;
