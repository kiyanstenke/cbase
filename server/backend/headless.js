// cbase backend — headless container entry (without Electron).
// Starts startServer without window, dialogs and macOS notifications. Runs as PID 1 in the per-user container; the gateway talks to
// the API on port 7718 (the image sets CBASE_HOST=0.0.0.0).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { endServer, startServer } from "./electron/server/server.js";
import { processWatch } from "./electron/server/runtime/process-watch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7718);
// The image sets PORT=7718 (Dockerfile) only for the line above. Otherwise EVERY child would inherit the variable — terminals, agent
// shells, native services in B — and Next.js, Vite & co. read PORT: an `npm run dev` would want 7718, the backend's port. It is
// dropped after reading.
delete process.env.PORT;
// All user data lives under $HOME (= Docker volume): DB, memory, profiles, workspaces.
const DATA_ROOT = process.env.CBASE_DATA_ROOT || path.join(os.homedir(), "cbase");
// In client/server operation the GATEWAY serves the UI — here only a stub for direct access.
const WEB_DIR = process.env.CBASE_WEB_DIR || path.join(__dirname, "webstub");

// Binaries are on the normal PATH in the container (npm -g) — no GUI-PATH problem as on macOS.
process.env.CLAUDE_BIN ||= "claude";
process.env.CODEX_BIN ||= "codex";
process.env.NPX_BIN ||= "npx";
// Optional location for bundled model weights (can be added by volume). The image ships NONE — if nothing is here, embeddings.js
// fetches the model once and caches it in HOME. (This line alone must not switch off the semantic path: the variable being set
// does not mean a model exists.)
process.env.CBASE_MODELS_DIR ||= path.join(os.homedir(), "models");
// Managed paths: workspaces/projects are created with a name only, the server assigns the folders.
process.env.CBASE_MANAGED_PATHS ||= "1";
// Container marker: switches to remote-capable flows (e.g. codex login --device-auth instead of the localhost callback). Routes
// must read it LAZILY (ESM import hoisting!).
process.env.CBASE_CONTAINER ||= "1";

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(WEB_DIR, { recursive: true });

// As PID 1 Node has no default signal handlers — docker stop should end cleanly. Before the start a signal ends the process
// immediately; afterwards it runs the stop chain: endServer fires "serverEnd" (snapshot `desired`, `docker stop -t 30` of every project
// container — capped at 45 s), closes the server (so subagents and dynamic workflows end in an orderly way, server.js at `close`)
// and exits with 0. A plain `process.exit(0)` would end the process at once, and the inner dockerd would die with B by SIGKILL. B's
// stop deadline (60 s, server/gateway/containers.js B_STOP_DEADLINE, the deploy tool's swap.mjs) lies above the chain.
let server = null;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => (server ? endServer(server) : process.exit(0)));

server = await startServer({ port: PORT, dataRoot: DATA_ROOT, webDir: WEB_DIR, pickDirectory: null, notify: null });
// The policy for errors without a catcher: from here on B keeps running and logs loudly instead of taking all project containers
// down with a single error — reasoned in runtime/process-watch.js. ONLY HERE: a failed start stays fatal (exit 1, Docker restarts);
// with the watch before it, it would end silently with 0.
processWatch();
console.log(`[cbase-backend] ready on ${process.env.CBASE_HOST || "127.0.0.1"}:${PORT} — data under ${DATA_ROOT}`);
