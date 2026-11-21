// Loading the tools of a coding MCP server: initialize + tools/list, deadline 30 s, then the ONE computation `carryForward`
// (toolchain/mcp-tools.js) over cache and marks. Two callers: the route `POST /api/mcp-servers/:id/tools` (button "Load
// tools") and the restart-grace hook "mcp-baseline" (server.js), which loads every pre-existing server once — what is seen
// then is the baseline (without marks).
//
// Where it loads: http/sse with the server's headers (only here and in the airlock do their values leave the database, never
// into a response), for a PROJECT server from the namespace of its project's main instance (runtime/target.js via
// providers/mcp-client.js), otherwise from B; stdio via `inProject` where the server runs (project servers in the project
// container, workspace servers in B). An error goes to `toolsError` and does NOT replace the cache; only a success sets
// `toolsAt`.

import os from "node:os";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { makeClient } from "../providers/mcp-client.js";
import { instanceForProject } from "../runs/instance.js";
import { mcpServerToConfigEntry } from "./mcp-config.js";
import { carryForward } from "./mcp-tools.js";

export const LOAD_DEADLINE_MS = 30_000;

/** The entry the backend uses to reach the REAL server — including headers (backend only). */
export function realEntry(server) {
  const e = mcpServerToConfigEntry(server);
  if (!e) return null;
  if (e.type === "http" || e.type === "sse") return { ...e, headers: store.mcpHeadersValues(server.id) };
  return e;
}

/** Carry forward the result of tools/list (run or load) — returns the filtered server. */
export function carryForwardTools(serverId, list) {
  const s = store.getMcpServerInternal(serverId);
  if (!s) return null;
  const { tools, markers } = carryForward(s, list);
  store.updateMcpServer(serverId, { tools, markers, toolsAt: Date.now(), toolsError: "" });
  return store.getMcpServerInternal(serverId);
}

export async function loadMcpTools(serverId) {
  const s = store.getMcpServerInternal(serverId);
  if (!s) return null;
  const def = realEntry(s);
  let error = "";
  let list = null;
  if (!def) error = s.transport === "stdio" ? T("no command") : T("no url");
  else {
    const proj = s.projectId ? store.getProject(s.projectId) : null;
    const cwd = proj?.path || store.getWorkspace(s.workspaceId)?.path || os.homedir();
    const client = makeClient(s.name, def, { cwd, instance: s.projectId ? instanceForProject(s.projectId) : null });
    let clock = null;
    try {
      list = await Promise.race([
        (async () => { await client.start(); return client.listTools(); })(),
        new Promise((_, no) => { clock = setTimeout(() => no(new Error(T`no response within ${LOAD_DEADLINE_MS / 1000} s`)), LOAD_DEADLINE_MS); }),
      ]);
    } catch (e) {
      error = String(e?.message || e).slice(0, 500);
    } finally {
      clearTimeout(clock);
      try { client.close(); } catch { /* already closed */ }
    }
  }
  if (error) {
    store.updateMcpServer(serverId, { toolsError: error });
    return store.getMcpServer(serverId);
  }
  carryForwardTools(serverId, list);
  return store.getMcpServer(serverId);
}

// Restart-grace hook "mcp-baseline": load every server whose baseline is still open once — one after another, in the
// background (returns nothing: holds neither start nor quiet). If loading fails, the baseline stays open, and the next
// successful load (button or run) sets it — tools that appear until then count as baseline too.
export function mcpBaselineRestartGrace() {
  const ids = store.mcpServerWithoutBaseline();
  if (!ids.length) return;
  (async () => {
    for (const id of ids) {
      try {
        const r = await loadMcpTools(id);
        if (r?.toolsError) console.error(`[mcp-baseline] ${r.name}: ${r.toolsError}`);
      } catch (e) { console.error("[mcp-baseline]", e?.message || e); }
    }
  })();
}
