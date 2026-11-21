// The retreat of the shared login on a server rollback. Pure functions, no ssh, no docker.
//
// The image carries `CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login`, and entry.sh moved `.credentials.json`
// there at the start of B. A rollback to an image WITHOUT the variable would not find the login anymore: its CLI and its
// usage.js read ~/.claude/.credentials.json — the user would be logged out of Claude. Therefore, if the TARGET image
// lacks the variable:
//   1. COPY the file to ~/.claude/ (not move: the old state needs it there, the next forward deploy finds both and keeps
//      the newer one, the one in the login directory on a tie; `cp -p` keeps the mtime), via tmp + rename in the same
//      folder;
//   2. STRIKE the variable from the `docker run` arguments. containerSpec (lib/remote.mjs) now filters against B's OWN
//      image, so the variable (from B's image) drops out there already; striking remains the net below (e.g. if a gateway
//      set it explicitly). If it stayed, the CLI of the rolled-back B would keep writing into the login directory, and
//      usage.js would read the copy, which goes stale with the first token refresh.
// If the target carries the variable, nothing is to be done. If the target's environment is unknown (empty or no array —
// imageEnv returns [] on an error), the safe way applies: copying and striking do not harm a target WITH the variable (it
// then comes from the image), a missing retreat harms a target without it. "Empty is not unknown" — here empty IS unknown,
// because every image carries at least PATH.
//
// WHERE THE COPY RUNS. Not per `docker exec` in the running B: a rollback is usually needed when the new state does NOT
// run — the backend crashes at start, B hangs in the restart loop or stands, after a sysbox restart it accepts no `exec`.
// Instead a throwaway container from the TARGET image (`docker run --rm`) with B's home volume and B's runtime (sysbox then
// maps the uids of the volume exactly as in B), as agent, without network — in the swap script AFTER `docker stop` and
// BEFORE `rm -f` (lib/swap.mjs `beforeRemove`), so no token refresh of the old B overtakes the copy. A B that already
// stands gets the same copy without a swap.
export const LOGIN_VAR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

// In the throwaway container as agent; `copyFor` passes the variable in with the value from B. No single
// quotes: the text sits in `sh -c '…'` behind ssh.
const COPY = [
  `q="\${${LOGIN_VAR}:-}"`,
  `if [ -z "$q" ]; then echo "Login retreat: no variable ${LOGIN_VAR} in the container, nothing to do"; exit 0; fi`,
  `if [ ! -f "$q/.credentials.json" ] || [ -L "$q/.credentials.json" ]; then echo "Login retreat: no .credentials.json in $q, nothing to do"; exit 0; fi`,
  [
    `mkdir -p "$HOME/.claude"`,
    `cp -p "$q/.credentials.json" "$HOME/.claude/.credentials.json.retreat.$$"`,
    `chmod 600 "$HOME/.claude/.credentials.json.retreat.$$"`,
    `mv "$HOME/.claude/.credentials.json.retreat.$$" "$HOME/.claude/.credentials.json"`,
    `echo "Login retreat: $q/.credentials.json copied to ~/.claude/"`,
  ].join(" && ") + ` || { echo "Login retreat FAILED"; rm -f "$HOME/.claude/.credentials.json.retreat.$$"; exit 1; }`,
].join("; ");

// Strikes every `-e <LOGIN_VAR>=…` (and a bare `-e <LOGIN_VAR>`) from the run args; everything else keeps
// its order.
export function withoutLoginVar(spec) {
  const out = [];
  for (let i = 0; i < spec.length; i++) {
    const a = spec[i];
    const value = spec[i + 1];
    if ((a === "-e" || a === "--env") && typeof value === "string" && (value === LOGIN_VAR || value.startsWith(`${LOGIN_VAR}=`))) { i++; continue; }
    if (typeof a === "string" && (a.startsWith(`--env=${LOGIN_VAR}=`) || a === `--env=${LOGIN_VAR}`)) continue;
    out.push(a);
  }
  return out;
}

export const HOME_B = "/home/agent";
// The exit code of the swap script when the copy failed and B was started again (without --force).
export const RETREAT_EXIT = 97;
const SAFE = /^[A-Za-z0-9._\/-]+$/;

// The copy command for ONE user container from its `docker inspect` and the target image. Result:
//   null          B does not carry the variable (its login is still in ~/.claude) — nothing to do;
//   { command }   `docker run --rm …` (one line, for ssh);
//   { missing }   the retreat is not feasible (no home volume, login directory outside it, unsafe characters).
export function copyFor(insp, image) {
  const name = String(insp?.Name || "").replace(/^\//, "") || "?";
  const row = (insp?.Config?.Env || []).find((e) => typeof e === "string" && e.startsWith(`${LOGIN_VAR}=`));
  const q = row ? row.slice(LOGIN_VAR.length + 1) : "";
  if (!q) return null;
  if (!SAFE.test(q) || !q.startsWith(`${HOME_B}/`) || q.split("/").includes("..")) {
    return { missing: `${name}: ${LOGIN_VAR}=${q} does not lie safely under ${HOME_B} — the copy would not see it` };
  }
  const home = (insp?.Mounts || []).find((m) => m?.Destination === HOME_B);
  const source = home?.Type === "volume" ? home.Name : home?.Type === "bind" ? home.Source : "";
  if (!source || !SAFE.test(source)) return { missing: `${name}: no home volume under ${HOME_B}` };
  const rt = insp?.HostConfig?.Runtime;
  if (rt && !SAFE.test(rt)) return { missing: `${name}: runtime ${rt}` };
  if (!image || !/^[A-Za-z0-9._\/:@-]+$/.test(image)) throw new TypeError(`copyFor: no image: ${image}`);
  const parts = ["docker run --rm --network none"];
  if (rt && rt !== "runc") parts.push(`--runtime ${rt}`);
  parts.push(`-v ${source}:${HOME_B}`, "--entrypoint /bin/sh", "-u agent", `-e HOME=${HOME_B}`, `-e ${LOGIN_VAR}=${q}`, image, `-c '${COPY}'`);
  return { command: parts.join(" ") };
}

// The line in the swap script between `docker stop` and `rm -f` (lib/swap.mjs `beforeRemove`). Without --force: if the
// copy fails, the script ends with RETREAT_EXIT BEFORE the `rm -f`, and B runs again (the stop halted it, unless-stopped
// does not start it by itself). With --force: continue without the copy, with a message — also with the marker
// RETREAT_MARKER on stdout, which the rollback reads (`retreatFailedFrom`) and writes into the verdict. The message
// alone on stderr would appear only in the log.
export const RETREAT_MARKER = "CBASE-LOGIN-RETREAT-FAILED";
export function retreatRow({ command, container, force = false }) {
  if (!command || command.includes("\n")) throw new TypeError("retreatRow: command must be one line");
  if (!container || !SAFE.test(container)) throw new TypeError(`retreatRow: no container name: ${container}`);
  return force
    ? `${command} || { echo "Login retreat for ${container} FAILED — --force: continuing without copy, Claude is logged out in the old state" >&2; echo "${RETREAT_MARKER} ${container}"; }`
    : `${command} || { echo "Login retreat for ${container} FAILED — ${container} is started again" >&2; docker start ${container} >/dev/null || true; exit ${RETREAT_EXIT}; }`;
}

/** Pure: the containers whose login retreat failed with --force, from the output of the swap script. */
export function retreatFailedFrom(stdout) {
  const out = [];
  for (const z of String(stdout ?? "").split("\n")) {
    const m = new RegExp(`^${RETREAT_MARKER} (\\S+)$`).exec(z.trim());
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// env: `Config.Env` of the target image (["NAME=value", …]). Result:
//   { needed, unknown, reason, copy(insp, image) → copyFor(…) or null, spec(runArgs) → runArgs }
export function loginRetreat(env) {
  const unknown = !Array.isArray(env) || env.length === 0;
  const carries = !unknown && env.some((e) => typeof e === "string" && e.startsWith(`${LOGIN_VAR}=`) && e.length > LOGIN_VAR.length + 1);
  if (carries) {
    return { needed: false, unknown: false, reason: `the target image carries ${LOGIN_VAR} — the login stays in the login directory`, copy: () => null, spec: (s) => s };
  }
  return {
    needed: true,
    unknown,
    reason: unknown
      ? `environment of the target image unknown — safe way: copy the login to ~/.claude, do not pass ${LOGIN_VAR}`
      : `the target image lacks ${LOGIN_VAR} — copy the login to ~/.claude, do not pass the variable`,
    copy: copyFor,
    spec: withoutLoginVar,
  };
}
