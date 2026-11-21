// A run's access to the backend. A leaf (only import: the leaf runs/instance.js): `runs/` must not import `projectbox/`, so the source
// comes through a setter from server.js — the same pattern as runs/instance.js setInstanceSource.
//
// backendAccessFor(inst)  `{ backendUrl, token, instance }` for writeMcpConfig (toolchain/mcp-config.js): the backend's address
//                          from the instance's project network and its token (projectbox/token.js mcpAccessFor), plus its
//                          identifier "<projectId>/<instance>" (runs/instance.js instanceIdentifierOf — the MCP's port tools send
//                          it along). WITHOUT instance — and unset — an EMPTY object: the caller then passes nothing on, and
//                          writeMcpConfig writes byte-equal to before (golden-runs.test.js).
// Callers: runs/do-run.js (main run, at the writeMcpConfig call) and runs/agents.js (subagents, per agent with ITS instance — a core
// after a project change stays in the instance of its image).

import { instanceIdentifierOf } from "./instance.js";

let source = null;

/** Sets the source `(inst) => { backendUrl, token }` (server.js). `null` withdraws it. */
export function setBackendAccess(fn) {
  source = typeof fn === "function" ? fn : null;
}

/** The access for a start in `inst` — `{}` without instance or without source (the path as before). */
export function backendAccessFor(inst) {
  if (!inst || !source) return {};
  const z = source(inst) || {};
  const out = {};
  if (z.backendUrl) out.backendUrl = String(z.backendUrl);
  if (z.token) out.token = String(z.token);
  const identifier = instanceIdentifierOf(inst);
  if (identifier) out.instance = identifier;
  return out;
}
