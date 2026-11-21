// State of the server with depth 1: HOST, BASE_URL, DIRS (data directories), pickDirectoryFn (native folder dialog) and
// MCP_SCRIPT (path to the cbase MCP server, relative to THIS module — hence the file sits next to server.js). Imports only
// node:*; every reader loads it first. The setters at the end are called by startServer alone.

import path from "node:path";
import { fileURLToPath } from "node:url";


// Default: never bind outward. In the per-user container (client/server operation) the image sets CBASE_HOST=0.0.0.0 —
// there Docker/gateway shield from the outside.
const HOST = process.env.CBASE_HOST || "127.0.0.1";

let BASE_URL = "http://127.0.0.1:7718";
let DIRS = null; // { data, scratch, profilesDir, … }
let pickDirectoryFn = null; // native folder dialog (from the Electron main process)
// The boot id: one value per startServer, newly generated there and set here — NEVER a module constant: the harness starts the
// server with `restart()` in the SAME Node process on the same data folder, a constant would take a row of the previous run
// for its own. Empty as long as no server has run.
let BOOT_ID = "";

// Path to the cbase MCP server (electron/mcp/cbase-mcp.js, relative to this module).
const MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "cbase-mcp.js");

export function setBaseUrl(v) { BASE_URL = v; }
export function setDirs(v) { DIRS = v; }
export function setPickDirectoryFn(v) { pickDirectoryFn = v; }
export function setBootId(v) { BOOT_ID = String(v || ""); }

export { BASE_URL, BOOT_ID, DIRS, HOST, MCP_SCRIPT, pickDirectoryFn };
