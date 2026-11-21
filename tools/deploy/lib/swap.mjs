// The swap script of a user container. Pure — no ssh, no state; callers are targets/server.mjs swapContainer and
// targets/rollback.mjs, guarded by the maintainer's private suite.
//
// swapScript({ container, spec, image, remove = true })
//   The lines ONE ssh call runs on the host (sh.mjs puts `set -euo pipefail` in front):
//     docker stop -t 60 <B>   TERM to the backend; it runs its stop chain (snapshot `desired`, `docker stop -t 30` of every
//                             project container, then its own end — runs/server-end.js). Best effort (`|| true`): a B that
//                             already stands, or that no longer exists, must not hold up the swap — the `rm -f` after it decides.
//     docker rm -f <B>        afterwards only the removal of a stopped container
//     docker run …            create anew (every argument as a shell word, `runCommand`)
//   `remove: false` is only the `run` (second attempt after a name conflict, see swapVerdict). The swap used to begin with
//   `docker rm -f` of a RUNNING B — SIGKILL to all three levels (inner dockerd, every project container, its dockerd and
//   the stack). The longer gap in which the name is free is covered by swapVerdict (adopt).
//   `beforeRemove`: ONE line between `docker stop` and `rm -f` — the login retreat of the rollback (lib/login-retreat.mjs
//   retreatRow): B is stopped by then (no token refresh overtakes the copy) but not yet removed (if the copy fails, the
//   script aborts before `rm -f` and B starts again).
// removeScript(container, { beforeRemove })  only stop (and the line) and remove (the "recreate" retry path).
//
// No other place in the deploy tool removes, stops or creates a user container — the maintainer's private suite reads the sources
// under tools/deploy/ (table `DOCKER_ALLOWED`).
//
// B_STOP_DEADLINE (60 s): 30 s for project containers (measured 11.6–12.4 s with a running stack) plus snapshot, server end
// and margin. ONE number: it is defined in the gateway (server/gateway/containers.js) and used here for the `stop -t` of the deploy
// and as `--stop-timeout` of every B this tool creates (lib/remote.mjs containerSpec).
import { B_STOP_DEADLINE } from "../../../server/gateway/containers.js";
export { B_STOP_DEADLINE };

export function removeScript(container, { beforeRemove = "" } = {}) {
  if (!container || /\s/.test(container)) throw new TypeError(`removeScript: not a container name: ${container}`);
  if (typeof beforeRemove !== "string" || beforeRemove.includes("\n")) throw new TypeError("removeScript: beforeRemove must be one line");
  return `docker stop -t ${B_STOP_DEADLINE} ${container} >/dev/null || true\n` +
    (beforeRemove ? `${beforeRemove}\n` : "") +
    `docker rm -f ${container} >/dev/null\n`;
}

export function swapScript({ container, spec, image, remove = true, beforeRemove = "" }) {
  if (beforeRemove && !remove) throw new TypeError("swapScript: beforeRemove only with remove");
  return (remove ? removeScript(container, { beforeRemove }) : "") + `${runCommand(spec, image)} >/dev/null`;
}

// EVERY argument is one shell word: the values come from `docker inspect` (labels including those inherited from the image,
// env), and a value with spaces, JSON (`{"a":"b","c":…}`: brace expansion), `$`, quotes or `*` would split or be evaluated in
// bash — AFTER `docker rm -f`, with B already removed. Safe words stay readable, everything else goes in single quotes.
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
export function shellWord(a) {
  const s = String(a);
  return SAFE_WORD.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// The `docker run` line from the spec (lib/remote.mjs containerSpecFrom) and the image — for the script AND the display.
export function runCommand(spec, image) {
  if (!Array.isArray(spec)) throw new TypeError("swapScript: spec must be an array");
  if (!image) throw new TypeError("swapScript: no image");
  return `docker run ${spec.map(shellWord).join(" ")} ${shellWord(image)}`;
}
