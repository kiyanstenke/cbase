// The server as its own PROCESS for the agent harness: `withAgentsServer(fn, { childProcess: true })` starts it this way so that
// `crash()` can end it HARD (SIGKILL to the process group) — a restart in the same process would always go through the
// orderly end (server.close -> agentsAtServerEnd), and the module state (open cores, registries) would survive it.
//
// Call: node agent-server-child.mjs <port> <dataRoot> <webDir>. Not a harness test (no `.test.js`), only the entry point.
// SIGTERM closes in order and ends with 0 — by the SAME path as server/backend/headless.js: endServer (hook "serverEnd"
// with a cap, closeAllConnections, close, exit 0). Guard: server/backend/test/projectbox-server-end.test.js.
import path from "node:path";

import { endServer, startServer } from "../electron/server/server.js";
import { barrierInProcess } from "./quiet.mjs";

const [port, dataRoot, webDir] = process.argv.slice(2);
const server = await startServer({ port: Number(port), dataRoot, webDir, pickDirectory: null, notify: null });
// SIGUSR2 = the test seam `wakeParkedNow` in the server process: the reset is reached — a test that runs the server as a
// process does not share its module state and wakes it this way (ctx.wakeParked()).
process.on("SIGUSR2", () => { import("../electron/server/runs/agents.js").then((m) => m.wakeParkedNow()).catch((e) => console.error("[child] wakeParkedNow:", e?.message || e)); });
// SIGWINCH = the clock seam of the docker caps `advanceCap` (projectbox/docker.js): every running cap expires at once — a
// test with a cap in the opposite direction forces it this way at the hanging call (ctx.signal("SIGWINCH")).
process.on("SIGWINCH", () => { import("../electron/server/projectbox/docker.js").then((m) => console.error(`[child] advanceCap: ${m.advanceCap()} caps`)).catch((e) => console.error("[child] advanceCap:", e?.message || e)); });
// The marker of the stream barrier (quiet.mjs): the test does not share runtime/sse.js of this process and sends it over
// the IPC channel that agent-harness.mjs opens at the start — the answer goes back AFTER the marker is in the stream. The
// channel belongs to this entry point alone: the server itself reads no IPC, and without it (started without "ipc") there
// is no `process.send` and no way.
// Also the fence token of an instance (`{ kind: "token", id, projectId, instance }` -> `{ kind: "token", id, token }`; see
// server/backend/test/language-service-fifo.test.js): it lives only in the memory of THIS process (projectbox/token.js), and a
// test that runs the fence with a token against a server as a process gets at it only this way.
if (process.send) {
  process.channel?.unref?.();
  process.on("message", (m) => {
    if (m?.kind === "token") {
      import("../electron/server/projectbox/token.js").then(
        (t) => process.send?.({ kind: "token", id: m.id, token: t.tokenFor({ projectId: String(m.projectId), instance: String(m.instance || "main") }) }),
        (e) => process.send?.({ kind: "token", id: m.id, error: String(e?.message || e) }),
      );
      return;
    }
    // A project WITHOUT an instance row in THIS process (`{ kind: "project", id, workspaceId, name, path }` ->
    // `{ kind: "project", id, project }`) — the same helper as in the test process (agent-harness.mjs projectWithoutInstance).
    if (m?.kind === "project") {
      import("./agent-harness.mjs").then(
        (h) => process.send?.({ kind: "project", id: m.id, project: h.projectWithoutInstance({ workspaceId: m.workspaceId, name: m.name, path: m.path }) }),
      ).catch((e) => process.send?.({ kind: "project", id: m.id, error: String(e?.message || e) }));
      return;
    }
    if (m?.kind !== "barrier") return;
    barrierInProcess(m.target, m.marker).then(
      () => process.send?.({ kind: "barrier", marker: m.marker }),
      (e) => process.send?.({ kind: "barrier", marker: m.marker, error: String(e?.message || e) }),
    );
  });
}
process.on("SIGTERM", () => endServer(server));
// Test seam of the relocation (server/backend/test/relocation-end.test.js "(e)"): with CBASE_TEST_RELOCATION_CREATION (JSON of
// the creation options home · system · root · addresses, projectbox/instance.js createInstance) POST /api/projects/:id/umzug
// runs the REAL procedure (projectbox/relocation/procedure.js startRelocation) with exactly these options — through the
// route test seam `setRelocationProcedure`, which server.js never sets. Without it the creation on a Mac would find no
// network marker under / and no /usr/local/lib/node_modules. The restart (decider) does not need it: the way back creates
// nothing. Without the variable this entry point changes nothing.
// Also: plan and step 4 read /proc — this process gets a fake one in which only it stands (fake-proc.mjs, under the data
// folder of the harness; macOS has no /proc, and the test does not share the module state).
if (process.env.CBASE_TEST_RELOCATION_CREATION) {
  const creation = JSON.parse(process.env.CBASE_TEST_RELOCATION_CREATION);
  const [{ setRelocationProcedure }, procedure, { setProcessSeam }, { emptyProc }] = await Promise.all([
    import("../electron/server/projectbox/relocation/routes.js"), import("../electron/server/projectbox/relocation/procedure.js"),
    import("../electron/server/projectbox/relocation/processes.js"), import("./fake-proc.mjs"),
  ]);
  setRelocationProcedure({ startRelocation: (pid, opts = {}) => procedure.startRelocation(pid, { ...opts, creation }), relocationStatus: procedure.relocationStatus });
  setProcessSeam({ root: emptyProc(path.join(dataRoot, "fake-proc")), quietMs: 0 });
}
// Test seam of the project setup (server/backend/test/project-setup.test.js "(19)"): with CBASE_TEST_CREATION_OPTIONS (JSON of
// the creation options home · system · root · addresses) the setup creates the project container of EVERY new project with
// exactly these options — through the seam `setCreationOptions` (projectbox/recreate.js), which server.js never sets; without
// it the creation on a Mac would find no network marker under / and no /usr/local/lib/node_modules. Also the service
// detection as a no-op (it would call a model). Without the variable this entry point changes nothing.
if (process.env.CBASE_TEST_CREATION_OPTIONS) {
  const creation = JSON.parse(process.env.CBASE_TEST_CREATION_OPTIONS);
  const [{ setCreationOptions }, { setServicesDetection }] = await Promise.all([
    import("../electron/server/projectbox/recreate.js"), import("../electron/server/projectbox/detection.js"),
  ]);
  setCreationOptions(() => creation);
  setServicesDetection(() => {});
}
