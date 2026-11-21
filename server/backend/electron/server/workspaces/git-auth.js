// Managed paths (container operation) and git access: managedPathsOn/managedWsRoot/managedPath, slugify, GIT_ASKPASS,
// wsForPath, wsForCode, gitAuthCtx, gitErrPayload, purgeProjectDir.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitRemoteTarget, hostFromGitError, isGitAuthError, isSshAuthError } from "../git.js";
import * as store from "../store.js";


// Managed paths (container operation, set by headless.js): workspaces/projects are created by NAME ONLY —
// the server assigns the folder itself. Without the ops marker it stays path-based.
// IMPORTANT: read lazily — ESM imports run before the entry body that sets the env.
const managedPathsOn = () => process.env.CBASE_MANAGED_PATHS === "1";
const managedWsRoot = () => process.env.CBASE_WORKSPACES_DIR || path.join(os.homedir(), "workspaces");
const slugify = (s) =>
  String(s || "").trim().toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" }[c]))
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "unnamed";
// Find a free folder under baseDir (slug, slug-2, slug-3, …).
function managedPath(baseDir, name) {
  const base = path.join(baseDir, slugify(name));
  let p = base;
  for (let i = 2; fs.existsSync(p); i++) p = `${base}-${i}`;
  return p;
}

// ── Git auth: workspace credentials → askpass injection + descriptive auth errors ──
// At start a tiny askpass script is written to the data folder; network operations get
// username/token via env (if stored for workspace+host).
let GIT_ASKPASS_FILE = "";
function writeGitAskpass(dataDir) {
  GIT_ASKPASS_FILE = path.join(dataDir, "git-askpass.sh");
  fs.writeFileSync(GIT_ASKPASS_FILE, `#!/bin/sh\ncase "$1" in\n  [Uu]sername*) printf '%s' "$CBASE_GIT_USERNAME" ;;\n  *) printf '%s' "$CBASE_GIT_PASSWORD" ;;\nesac\n`, { mode: 0o755 });
}
// The workspace whose folder contains `p` — with nested workspaces the INNERMOST (longest path), not the first in
// the list.
const wsForPath = (p) => {
  const abs = path.resolve(String(p || ""));
  const matching = store.listWorkspaces().filter((w) => w?.path && (abs === path.resolve(w.path) || abs.startsWith(path.resolve(w.path) + path.sep)));
  return matching.sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length)[0] || null;
};
// The workspace of a code view: with `workspaceId` (the caller knows it — project level `proj.workspaceId`,
// workspace level `ws.id`) EXACTLY that one, otherwise via the path. A project whose folder is not under the workspace
// folder (locally: any folder works) would find none via the path (saving access: 404) or a FOREIGN workspace —
// whose access would then go to foreign remotes, and a saved one would land there. An id without a row is no fallback: null.
const wsForCode = (root, workspaceId) => (workspaceId ? store.getWorkspace(String(workspaceId)) || null : wsForPath(root));
// `opts` carries the repo's instance (git.js) — the question about the remote then runs in the project container.
// The access itself travels there as environment (git.js repoAt → runtime/git-run.js accessAsEnvironment); `askpass`
// stays the way in the user container. `workspaceId`: the caller's workspace, see wsForCode.
// `auth.host` is the host of the origin remote WITH port, lowercase — in the project container only this host gets the
// token; `host` stays the name under which the access is looked up and stored.
async function gitAuthCtx(root, rel, opts = {}, { workspaceId = null } = {}) {
  const { host, hostWithPort } = await gitRemoteTarget(root, rel, opts);
  const ws = wsForCode(root, workspaceId);
  const cred = ws && host ? store.getGitCred(ws.id, host) : null;
  return { host, ws, auth: cred ? { askpass: GIT_ASKPASS_FILE, username: cred.username, secret: cred.secret, host: hostWithPort || host } : null };
}
// Error payload: auth errors are flagged so the UI can show an access modal.
// `host` is the host git names in the message (git.js hostFromGitError — pull and fetch also carry the access of the
// submodule hosts, so the rejected one may differ from the remote's); only when it names none, the remote's
// (`host` of the caller).
const gitErrPayload = (e, host) => {
  const msg = String(e?.message || e);
  if (!isGitAuthError(msg)) return { error: msg };
  return { error: msg, authRequired: true, host: hostFromGitError(msg) || host || "", ssh: isSshAuthError(msg) };
};

// Delete a project folder for good — ONLY in container operation (there the server created the
// folders itself; without the ops marker it stays conservative). Protection: strictly inside
// $HOME and never $HOME itself.
function purgeProjectDir(projPath) {
  if (process.env.CBASE_CONTAINER !== "1") return false;
  const home = path.resolve(os.homedir());
  const abs = path.resolve(String(projPath || ""));
  if (abs === home || !abs.startsWith(home + path.sep)) return false;
  try { fs.rmSync(abs, { recursive: true, force: true }); return true; } catch { return false; }
}

export { gitAuthCtx, gitErrPayload, managedPath, managedPathsOn, managedWsRoot, purgeProjectDir, slugify, writeGitAskpass, wsForPath, wsForCode };
