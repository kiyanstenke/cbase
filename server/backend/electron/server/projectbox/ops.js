// The ops marker of the project containers. A leaf without imports.
//
// projectboxOps()  says whether project containers are possible here AT ALL. Both must hold:
//   CBASE_CONTAINER === "1"  the backend runs in the user container (set in server/backend/headless.js),
//   CBASE_DIND === "1"       the user container has an inner Docker of its own (set only by the gateway, together with `--runtime`,
//                              server/gateway/containers.js — without Sysbox there is no daemon that could carry a project container).
//   Only the string "1" counts: "true", "0", empty and unset are OFF (a missing field is no statement). Without both there is no docker
//   call (projectbox/docker.js asks here before it starts a child), every new route answers 404 `ONLY_IN_OPS`, and the local server
//   stays unchanged.
//
// WHY AT RUN TIME. The markers are read at every call, never frozen at load: headless.js sets CBASE_CONTAINER only AFTER the hoisted
// ESM imports (comment there), and the tests switch the markers in the same process. A constant at module level would see the wrong
// state in both cases.
export function projectboxOps() {
  return process.env.CBASE_CONTAINER === "1" && process.env.CBASE_DIND === "1";
}

// The wording of the 404 answer without operations — the same as in the Codex OAuth relay (account/routes.js), so a client knows ONE
// message. Plain English on the wire (not through T()): clients and tests recognize it by its text.
export const ONLY_IN_OPS = "only in server mode";
