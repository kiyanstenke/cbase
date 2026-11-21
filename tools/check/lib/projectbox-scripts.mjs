// The pure part of the project box distribution: the planning functions, the situation reader, and the scripts that run inside a user
// container ("B"). No configuration, no ssh, no clock — the image name comes in as an argument (default: the name the deploy tool
// configures). lib/projectbox-distribution.mjs re-exports all of it and adds the flow over ssh. Guard: projectbox-distribution.test.mjs;
// the documentation of the whole distribution stands at the head of lib/projectbox-distribution.mjs.
import { LFS_HELPER_IN_BACKEND, SOURCE_LABEL, SOURCE_RE } from "./projectbox.mjs";
import { PROBE_POOL, PROBE_LABEL, OCCUPIED_RANGES, rangesIntersect } from "./projectbox-plan.mjs";
export { PROBE_POOL, PROBE_LABEL, OCCUPIED_RANGES, rangesIntersect }; // pure parts live in projectbox-plan.mjs

// The image name of the project box (config.remote.projectboxImage of the deploy tool, which passes its own value).
export const DEFAULT_PROJECTBOX_IMAGE = "cbase-projectbox";

// Product cap: attempts at one-second intervals. Measured, `docker info` answers inside after 1.3–1.9 s, a cold dockerd on an
// existing volume after 13.7 s; the entrypoint itself gives up after 120 s.
export const PROBE_CAP = 120;
// How long to wait for B's inner Docker when it reports "not there yet" (after a swap entry.sh starts dockerd in the background,
// the backend can be healthy before). Any other answer ends the wait at once.
export const DAEMON_CAP = 120;
// Cap per call into B, in seconds (GNU `timeout` on the host, `-k 5` then KILL). Measured, the calls here answer in under a second
// (`docker rmi` of an old candidate in a few, `run -d` of the probe in one to two); the `docker load` stream needs ≈ 100 s per B
// (1.86 GB). Both numbers say that they are a cap ("Cap exceeded: …").
export const EXEC_CAP_S = 60;
export const LOAD_CAP_S = 1200;
export const INSIDE_KEEP = 2;
// Exit codes of the scripts: ID (inner id ≠ host resp. unreadable), START (`run -d` of the probe failed), PROBE (the probe
// container died), CAP (cap of the start probe or of a call in it), LOAD (stream or name failed), REST (a probe container could
// not be removed — no tag), STATUS (the entrypoint reports `error` or `ended` in its status file), LFS (git-lfs and the LFS helper
// in the candidate do not fit together).
export const EXIT = { ID: 71, START: 72, PROBE: 73, CAP: 74, LOAD: 75, REST: 76, STATUS: 77, LFS: 78 };
// The status file of the entrypoint (server/backend/projectbox-entry.sh; the setup reads the same, projectbox/instance.js
// STATUS_FILE): `phase=start|prepare|wait|ready|error|ended` and `notice=…`.
export const STATUS_FILE = "/run/cbase-projectbox.status";

const ID = /^sha256:[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
export const short = (s) => (s ? String(s).replace(/^sha256:/, "").slice(0, 12) : "—");
const latestRef = (image) => `${image}:latest`;
function check(re, value, what) {
  if (!re.test(String(value ?? ""))) throw new TypeError(`projectbox-distribution: ${what} not allowed: ${value}`);
  return value;
}

// ── The pure computation ─────────────────────────────────────────────────────────────────────────────────────────────────

// inside: { <B>: id of :latest inside | null (no :latest inside) | "unknown" (unreadable) } → { <B>: load|nothing|source|unknown }.
// Empty is not unknown: only `null` means "missing" (⇒ load); anything that is not an id means "unknown" (⇒ no tag). `source` =
// another id, but the same source as the host candidate (`hostSource`, per B `insideSource`) ⇒ distribute nothing; a missing
// source on one side is not an equal one.
export function projectboxPlan({ hostId, inside, hostSource = null, insideSource = {} }) {
  if (!ID.test(String(hostId))) throw new TypeError(`projectboxPlan: not an image id of the host candidate: ${hostId}`);
  const hq = SOURCE_RE.test(String(hostSource)) ? hostSource : null;
  const plan = {};
  for (const [name, id] of Object.entries(inside || {})) {
    if (id === hostId) plan[name] = "nothing";
    else if (ID.test(String(id)) && hq && insideSource?.[name] === hq) plan[name] = "source";
    else if (id === null || ID.test(String(id))) plan[name] = "load";
    else plan[name] = "unknown";
  }
  return plan;
}

// The source from `{{json .Config.Labels}}` — a sha256 or null (no label, no JSON, unreadable).
export function sourceFromLabels(text) {
  try {
    const q = JSON.parse(String(text ?? "").trim() || "null")?.[SOURCE_LABEL];
    return SOURCE_RE.test(String(q)) ? q : null;
  } catch { return null; }
}

// The output of `readScript` → { latest, source, reason, images, used, projects, daemon } (`source`: that of the inner :latest or
// null). Every part that does not end with `rc 0` or carries a line that does not fit its form is `null` resp. "unknown" — never
// an empty list. `reason` is, for "unknown", the first line the part LATEST delivered (e.g. "Cap exceeded: …" or "OCI runtime
// exec failed …"), else null.
export function projectboxSituation(output) {
  const t = {};
  let now = null;
  let daemon = null;
  for (const raw of String(output ?? "").split("\n")) {
    const z = raw.replace(/\s+$/, "");
    let m = /^--- (LATEST|SOURCE|IMAGES|ALL|PROJECTS)$/.exec(z);
    if (m) { now = m[1]; t[now] = { rows: [], rc: null }; continue; }
    m = /^--- rc (\d+)$/.exec(z);
    if (m && now) { t[now].rc = Number(m[1]); now = null; continue; }
    if (z.startsWith("--- DAEMON ")) { daemon = z.slice("--- DAEMON ".length); continue; }
    if (now) t[now].rows.push(z);
  }
  const part = (k, re) => {
    if (!t[k] || t[k].rc !== 0) return null;
    const out = [];
    for (const z of t[k].rows) {
      if (!z.trim()) continue;
      const m = re.exec(z.trim());
      if (!m) return null;
      out.push(m);
    }
    return out;
  };
  let latest = "unknown";
  let reason = null;
  const L = t.LATEST;
  if (L && L.rc === 0) {
    const ids = L.rows.map((z) => z.trim()).filter(Boolean);
    if (ids.length === 1 && ID.test(ids[0])) latest = ids[0];
  } else if (L && L.rc > 0) {
    const text = L.rows.join("\n");
    if (/No such (image|object)/i.test(text) && !/No such container|Cannot connect|is not running|OCI runtime|Cap exceeded/i.test(text)) latest = null;
  }
  if (latest === "unknown" && L) reason = L.rows.map((z) => z.trim()).find(Boolean) || `rc ${L.rc ?? "missing"}, no output`;
  const images = part("IMAGES", /^(\S+) (sha256:[0-9a-f]{64})$/);
  const all = part("ALL", /^(sha256:[0-9a-f]{64}|\S*) \/(\S+)$/);
  const projects = part("PROJECTS", /^(sha256:[0-9a-f]{64}|\S*) \/(\S+)$/);
  const Q = t.SOURCE;
  const qRows = Q && Q.rc === 0 ? Q.rows.map((z) => z.trim()).filter(Boolean) : [];
  return {
    latest,
    source: ID.test(String(latest)) && qRows.length === 1 ? sourceFromLabels(qRows[0]) : null,
    reason,
    images: images && images.map((m) => ({ tag: m[1], id: m[2] })),
    used: all && [...new Set(all.map((m) => m[1]).filter((x) => ID.test(x)))],
    projects: projects && projects.map((m) => ({ image: m[1], name: m[2] })),
    daemon,
  };
}

// Which ids inside fall: candidates `cand-<release>` beyond the `keep` most recent (by release), except :latest, the ids of the
// kept ones and every id that a container uses. Unknown ⇒ remove nothing.
export function cleanupPlan({ images, used, latest, keep = INSIDE_KEEP }) {
  if (!Array.isArray(images) || !Array.isArray(used) || !ID.test(String(latest))) return { remove: [], stay: [], unknown: true };
  const candidates = images.filter((b) => /^cand-/.test(b.tag)).sort((a, b) => (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0));
  const stay = candidates.slice(0, keep);
  const protection = new Set([latest, ...stay.map((b) => b.id), ...used]);
  const remove = [...new Set(candidates.slice(keep).map((b) => b.id))].filter((id) => !protection.has(id));
  return { remove, stay: stay.map((b) => b.tag), unknown: false };
}

// The two rows of the operator's status check per B (pure): [label, text, level]. `hostUnknown`: the reason if the host candidate was not
// readable — then that stands there, not "missing".
export function projectboxRows({ situation, hostId, hostRef, hostUnknown = null, hostSource = null }) {
  const l = situation || {};
  const rows = [];
  const label = "Project box inside == host candidate";
  const reason = l.daemon || l.reason;
  if (l.latest === "unknown" || l.latest === undefined) {
    rows.push([label, `unknown (docker exec returned nothing readable${reason ? ` — ${reason}` : ""})`, "warn"]);
  } else if (hostUnknown) {
    rows.push([label, `unknown — host candidate ${hostRef} not readable (${hostUnknown}); inside ${l.latest ? short(l.latest) : "none"}`, "warn"]);
  } else if (!hostId) {
    rows.push([label, `host candidate ${hostRef} missing (release older than the project box?) — inside ${l.latest ? short(l.latest) : "none"}`, "warn"]);
  } else if (l.latest === null) {
    rows.push([label, "missing inside — the next deploy loads it", "warn"]);
  } else if (l.latest === hostId) {
    rows.push([label, `yes (${short(hostId)})`, "ok"]);
  } else if (SOURCE_RE.test(String(hostSource)) && l.source === hostSource) {
    rows.push([label, `yes by source (${short(hostSource)}): inside ${short(l.latest)}, host ${short(hostId)} — only the build cache tells them apart, not distributed`, "ok"]);
  } else {
    rows.push([label, `NO (inside ${short(l.latest)} ≠ host ${short(hostId)}) — the next deploy loads it`, "warn"]);
  }
  const label2 = "Project containers with a deviating image";
  if (!Array.isArray(l.projects) || !ID.test(String(l.latest))) {
    rows.push([label2, Array.isArray(l.projects) && l.projects.length === 0 ? "0 (no project containers)" : "unknown", Array.isArray(l.projects) && l.projects.length === 0 ? "ok" : "warn"]);
  } else {
    const stale = l.projects.filter((p) => p.image !== l.latest);
    rows.push([label2, stale.length ? `${stale.length} of ${l.projects.length} (${stale.map((p) => p.name).join(", ")}) — recreated when idle` : `0 of ${l.projects.length}`, stale.length ? "warn" : "ok"]);
  }
  return rows;
}

// ── The scripts (text for ONE ssh call per step; sh.mjs puts `set -euo pipefail` in front, the host runs `bash -s`) ──

// `dx …` = `docker exec -u agent <B> …` with a cap. If it expires (exit 124), the message stands on stderr: `read_part` collects it
// (2>&1), the wait loop shows its first line, the probe aborts. Only what bash 3.2 (gate on macOS) and bash 5 (host) both can do.
function dxPart(b) {
  return `dx() { local dx_rc=0; timeout -k 5 ${EXEC_CAP_S} docker exec -u agent ${b} "$@" || dx_rc=$?; ` +
    `if [ "$dx_rc" -eq 124 ]; then echo "Cap exceeded: docker exec -u agent ${b} $1 $2 … did not answer within ${EXEC_CAP_S} s" >&2; fi; return "$dx_rc"; }`;
}

function waitDaemonPart(b) {
  return [
    "n=0",
    "while :; do",
    `  out=$(dx docker info --format '{{.ServerVersion}}' 2>&1) && break`,
    `  case "$out" in *"Cannot connect to the Docker daemon"*) ;; *) echo "--- DAEMON $(printf '%s' "$out" | head -1)"; break;; esac`,
    "  n=$((n + 1))",
    `  if [ "$n" -ge ${DAEMON_CAP} ]; then echo "--- DAEMON Cap exceeded: the inner Docker of ${b} does not answer after ${DAEMON_CAP} attempts at one-second intervals"; break; fi`,
    "  sleep 1",
    "done",
  ];
}

// Reads per B: :latest inside, the candidates, the images of all containers and those of the project containers. Read-only; with
// `wait` first until the inner Docker answers (cap, see above). Every part ends with `--- rc <exit>`.
export function readScript(container, { wait = false, image = DEFAULT_PROJECTBOX_IMAGE } = {}) {
  const b = check(NAME, container, "container name");
  const img = image;
  return [
    dxPart(b),
    ...(wait ? waitDaemonPart(b) : []),
    'read_part() { t=$1; shift; echo "--- $t"; if "$@" 2>&1; then echo "--- rc 0"; else echo "--- rc $?"; fi; }',
    `list_all() { ids=$(dx docker ps -a -q --no-trunc "$@") || return $?; if [ -n "$ids" ]; then dx docker inspect --format '{{.Image}} {{.Name}}' $ids; fi; }`,
    `read_part LATEST dx docker image inspect --format '{{.Id}}' ${img}:latest`,
    `read_part SOURCE dx docker image inspect --format '{{json .Config.Labels}}' ${img}:latest`,
    `read_part IMAGES dx docker images --no-trunc --format '{{.Tag}} {{.ID}}' ${img}`,
    "read_part ALL list_all",
    "read_part PROJECTS list_all --filter label=cbase.project",
  ].join("\n");
}

// Remove leftover probe containers by id. Ends with EXIT.REST if they are unreadable or cannot be removed; reports "Probe
// leftovers removed: <n>" if there were any.
//
// A container INHERITS the labels of its image (`docker ps --filter label=…` sees both undistinguished) — a user container from an
// image with `LABEL cbase.probe=1` (e.g. a `docker commit` of a probe) would be removed here with `rm -f -v`, anonymous volumes
// included. So per candidate the rule from server/backend/electron/server/projectbox/own-labels.js: it is removed only if the
// image does NOT carry the container's value (label missing at the image or differs); if the image is unknown (unreadable, gone),
// the label alone counts. `grep -o` reads the value from `{{json .Config.Labels}}` (without `index`, without jq). A container that
// cannot be read is an error (EXIT.REST) — better to leave it than to guess.
const PROBE_JSON_PATTERN = `"${PROBE_LABEL.slice(0, PROBE_LABEL.indexOf("=")).replace(/\./g, "\\.")}":"[^"]*"`;
function leftoversPart(b) {
  return [
    `leftovers=$(dx docker ps -a -q --no-trunc --filter label=${PROBE_LABEL}) || { echo "Probe leftovers in ${b} not readable" >&2; exit ${EXIT.REST}; }`,
    'gone=""',
    "for id in $leftovers; do",
    `  c=$(dx docker inspect --type container --format '{{.Image}} {{json .Config.Labels}}' "$id") || { echo "Probe leftover $id in ${b} not readable" >&2; exit ${EXIT.REST}; }`,
    `  cw=$(printf '%s' "\${c#* }" | grep -o '${PROBE_JSON_PATTERN}' || true)`,
    `  if bl=$(dx docker image inspect --format '{{json .Config.Labels}}' "\${c%% *}" 2>/dev/null); then`,
    `    bw=$(printf '%s' "$bl" | grep -o '${PROBE_JSON_PATTERN}' || true)`,
    '    if [ -n "$bw" ] && [ "$bw" = "$cw" ]; then continue; fi',
    "  fi",
    '  gone="$gone $id"',
    "done",
    `if [ -n "$gone" ]; then`,
    `  dx docker rm -f -v $gone >/dev/null || { echo "Probe leftovers in ${b} could not be removed:" $gone >&2; exit ${EXIT.REST}; }`,
    `  echo "Probe leftovers removed: $(printf '%s\\n' $gone | wc -l | tr -d ' ')"`,
    "fi",
  ];
}

// For a B whose :latest is already right: only the leftovers (for EVERY readable plan — else only a new probe would clear them,
// and a leftover next to a current :latest would stay with its privileged dockerd).
export function leftoversScript(container) {
  const b = check(NAME, container, "container name");
  return [dxPart(b), ...leftoversPart(b)].join("\n");
}

// The start probe WITHOUT a tag (repointing is a step of its own, `tagScript`, in the deploy only after the tag of the backend image
// on the host). `untagAtError` removes the name `ref` again after a failure (only for one just set); a probe container that cannot
// be removed is a failure (EXIT.REST).
//
// ONLY `phase=ready` PASSES. An answering `docker info` is not enough: the entrypoint starts dockerd even after a failed cgroup
// step and stays on `phase=error` — dockerd answered, the probe passed, :latest was repointed inside, and EVERY later setup failed
// at the status file. A DNAT error always passed. So after the first answer the status file is read in the same loop until it
// says `ready` (passed), `error` or `ended` (EXIT.STATUS, with the entrypoint's notice) — the entry writes `ready` only after the
// DNAT, right after `docker info`. The same attempt cap; `cap` is only smaller for the guard.
function probePart(b, ref, untagAtError, cap = PROBE_CAP) {
  const untag = untagAtError ? ` dx docker rmi ${ref} >/dev/null 2>&1 || true;` : "";
  return [
    // Under `set -e` a failing `run -d` would end the script with docker's code — without EXIT.START, without untag.
    `pid=$(dx docker run -d --privileged -e CBASE_DOCKER_POOL=${PROBE_POOL} --label ${PROBE_LABEL} ${ref}) || { echo "Start probe: docker run from ${ref} failed in ${b}" >&2;${untag} exit ${EXIT.START}; }`,
    `case "$pid" in ""|*[!0-9a-f]*) echo "Start probe: no probe container from ${ref} ($pid)" >&2;${untag} exit ${EXIT.START};; esac`,
    `probe_remove() { dx docker rm -f -v "$pid" >/dev/null 2>&1 || { echo "Start probe: probe container $pid stayed in ${b} (${PROBE_LABEL}; the next run removes it)" >&2; return 1; }; }`,
    'n=0; phase=""; notice=""',
    "while :; do",
    `  info_rc=0; dx docker exec "$pid" docker info >/dev/null 2>&1 || info_rc=$?`,
    `  if [ "$info_rc" -eq 0 ]; then`,
    `    st_rc=0; st=$(dx docker exec "$pid" cat ${STATUS_FILE} 2>/dev/null) || st_rc=$?`,
    `    if [ "$st_rc" -eq 124 ]; then echo "Start probe: cap exceeded — the status file in the probe container from ${ref} was not readable within ${EXEC_CAP_S} s" >&2; probe_remove || true;${untag} exit ${EXIT.CAP}; fi`,
    '    phase=""; notice=""',
    '    while IFS= read -r z; do case "$z" in phase=*) phase=${z#phase=};; notice=*) notice=${z#notice=};; esac; done <<< "$st"',
    '    case "$phase" in',
    "      ready) break;;",
    `      error|ended) echo "Start probe: the entrypoint in ${ref} reports phase=$phase ($notice)" >&2; probe_remove || true;${untag} exit ${EXIT.STATUS};;`,
    "    esac",
    `  elif [ "$info_rc" -eq 124 ]; then echo "Start probe: cap exceeded — docker exec into the probe container from ${ref} did not answer within ${EXEC_CAP_S} s" >&2; probe_remove || true;${untag} exit ${EXIT.CAP}; fi`,
    `  running=$(dx docker inspect --format '{{.State.Running}}' "$pid" 2>/dev/null || echo unknown)`,
    `  if [ "$running" != "true" ]; then`,
    `    echo "Start probe: the probe container from ${ref} is no longer running (Running=$running); its last lines:" >&2`,
    `    dx docker logs --tail 20 "$pid" >&2 2>&1 || true`,
    `    probe_remove || true;${untag} exit ${EXIT.PROBE}`,
    "  fi",
    "  n=$((n + 1))",
    `  if [ "$n" -ge ${cap} ]; then echo "Start probe: ${ref} is not ready after ${cap} attempts at one-second intervals (docker info: exit $info_rc, status file: phase=\${phase:-—}) — cap of the start probe" >&2; probe_remove || true;${untag} exit ${EXIT.CAP}; fi`,
    "  sleep 1",
    "done",
    ...lfsPart(ref, untag),
    `probe_remove || { echo "Start probe passed, but not repointable: the probe container was still there" >&2; exit ${EXIT.REST}; }`,
    // The entrypoint's notice stands in the deploy log (line "Start probe passed") — it shows whether the probe environment (docker0
    // of B, no project network) reaches `ready`; behind it the version of git-lfs.
    `echo "Start probe passed: ${ref} in ${b} (phase=ready: \${notice:-}; \${lfs_row:-})"`,
  ];
}

// In the ready probe container `git lfs version` and `git config --system --get-all credential.helper`, both via `dx` (cap). BOTH
// or NEITHER passes: git-lfs answers with `git-lfs/<version>` AND /etc/gitconfig names exactly one helper, LFS_HELPER_IM_BACKEND —
// or neither git-lfs nor a helper (`--get-all` ends with 1 without output). "Neither" is a project box from before the LFS
// helper, and it only arrives here through a rollback: the start probe is the text of THIS tool, also for the candidate of an
// older release — if it demanded LFS, the rollback would leave the newer project box standing inside under the older backend.
// Such a rollback only gets this far with `--rollback-without-lfs`: the fourth axis of the rollback lock (lib/capabilities.mjs
// lfsLock) stops every target without `lfs` earlier — git-lfs has created hooks in the repos of the project containers
// (`command -v git-lfs … || exit 2`), and under this project box push, checkout and `git worktree add` would break. "Neither" still
// passes here: whoever sets the switch has assured that, and a probe that then failed would only hold the NEWER project box
// inside — the protection belongs before the swap, not here. That a build from today's Dockerfile carries both is held by
// projectbox-dockerfile.test.mjs (text) and the probes in the build itself. Any other situation — only one of the two, a foreign
// or second helper, git-lfs without a version line — is EXIT.LFS, a cap is EXIT.CAP. `--get-all` instead of `--get`: a second
// helper in /etc/gitconfig would escape `--get`.
function lfsPart(ref, untag) {
  return [
    'lfs_rc=0; lfs=$(dx docker exec "$pid" git lfs version 2>&1) || lfs_rc=$?',
    'hf_rc=0; hf=$(dx docker exec "$pid" git config --system --get-all credential.helper 2>&1) || hf_rc=$?',
    `if [ "$lfs_rc" -eq 124 ] || [ "$hf_rc" -eq 124 ]; then echo "Start probe: cap exceeded — git in the probe container from ${ref} did not answer within ${EXEC_CAP_S} s" >&2; probe_remove || true;${untag} exit ${EXIT.CAP}; fi`,
    'lfs_row=""',
    `if [ "$hf_rc" -eq 0 ] && [ "$hf" = "${LFS_HELPER_IN_BACKEND}" ] && [ "$lfs_rc" -eq 0 ]; then case "$lfs" in git-lfs/*) lfs_row="\${lfs%% *}";; esac; fi`,
    'if [ -z "$lfs_row" ] && [ "$hf_rc" -eq 1 ] && [ -z "$hf" ] && [ "$lfs_rc" -ne 0 ]; then lfs_row="without git-lfs and LFS helper (project box from before the LFS helper)"; fi',
    'if [ -z "$lfs_row" ]; then',
    `  echo "Start probe: git-lfs and LFS helper in ${ref} do not fit together (git lfs version: exit $lfs_rc, $(printf '%s' "$lfs" | head -1); credential.helper: exit $hf_rc, $(printf '%s' "$hf" | tr '\\n' ' ')) — expected: both (git-lfs/… and ${LFS_HELPER_IN_BACKEND}) or neither" >&2`,
    `  probe_remove || true;${untag} exit ${EXIT.LFS}`,
    "fi",
  ];
}

export function probeScript({ container, ref, untagAtError = false, cap = PROBE_CAP }) {
  const b = check(NAME, container, "container name");
  check(REF, ref, "image");
  return [dxPart(b), ...leftoversPart(b), ...probePart(b, ref, untagAtError, cap)].join("\n");
}

// Prepare: load (or only name), check the id, start probe — one ssh call per B, NO tag. `dry`: hostId is only a placeholder.
// `cap`: the attempt cap of the start probe (only the guard sets it smaller).
export function prepareScript({ container, cand, hostId, dry = false, cap = PROBE_CAP }) {
  const b = check(NAME, container, "container name");
  check(REF, cand, "candidate");
  if (!dry) check(ID, hostId, "image id");
  const untag = `dx docker rmi ${cand} >/dev/null 2>&1 || true`;
  return [
    dxPart(b),
    // Leftovers first: if that fails, nothing is loaded yet.
    ...leftoversPart(b),
    `if dx docker image inspect --format '{{.Id}}' ${hostId} >/dev/null 2>&1; then`,
    `  dx docker tag ${hostId} ${cand} || { echo "Project box: the name ${cand} could not be set in ${b}" >&2; exit ${EXIT.LOAD}; }`,
    `  echo "Project box: ${short(hostId)} already lies in ${b} — no stream, only the name ${cand}"`,
    "else",
    // The stream with code and cap — if it fails, the name is gone (a half-loaded candidate does not lie around).
    `  docker save ${cand} | timeout -k 5 ${LOAD_CAP_S} docker exec -i -u agent ${b} docker load || { load_rc=$?; ` +
      `if [ "$load_rc" -eq 124 ]; then echo "Cap exceeded: docker load in ${b} did not end within ${LOAD_CAP_S} s" >&2; fi; ` +
      `echo "Project box: loading ${cand} in ${b} failed (exit $load_rc)" >&2; ${untag}; exit ${EXIT.LOAD}; }`,
    "fi",
    `inner=$(dx docker image inspect --format '{{.Id}}' ${cand}) || { echo "Project box: ${cand} is not readable in ${b} after loading" >&2; ${untag}; exit ${EXIT.ID}; }`,
    `if [ "$inner" != "${hostId}" ]; then echo "Project box: ${cand} in ${b} is $inner, not ${hostId}" >&2; ${untag}; exit ${EXIT.ID}; fi`,
    ...probePart(b, cand, true, cap),
  ].join("\n");
}

// Repoint: `ref` inside to :latest — only if `ref` there still carries the checked id. No stream, no probe: they ran in the step before.
export function tagScript({ container, ref, hostId, dry = false, image = DEFAULT_PROJECTBOX_IMAGE }) {
  const b = check(NAME, container, "container name");
  check(REF, ref, "candidate");
  if (!dry) check(ID, hostId, "image id");
  return [
    dxPart(b),
    `inner=$(dx docker image inspect --format '{{.Id}}' ${ref}) || { echo "Project box: ${ref} is not readable in ${b} — not tagged" >&2; exit ${EXIT.ID}; }`,
    `if [ "$inner" != "${hostId}" ]; then echo "Project box: ${ref} in ${b} is $inner, not ${hostId} — not tagged" >&2; exit ${EXIT.ID}; fi`,
    `dx docker tag ${ref} ${latestRef(image)}`,
    `echo "Project box: ${latestRef(image)} in ${b} = ${ref}"`,
  ].join("\n");
}

export function cleanupScript({ container, ids }) {
  const b = check(NAME, container, "container name");
  return [
    dxPart(b),
    ...ids
      .map((id) => check(ID, id, "image id"))
      .map((id) => `dx docker rmi -f ${id} >/dev/null 2>&1 || echo "Project box: ${short(id)} could not be removed in ${b}" >&2`),
  ].join("\n");
}
