// The image of the project containers on the HOST: name of the candidate, build command, host probe and its verdict. Pure: no
// ssh, no docker — `targets/server.mjs` executes what arises here as text. The distribution into the user containers is in
// `lib/projectbox-distribution.mjs` and takes only `projectboxCand` from here.
//
// Flow in `deployServer`, right behind the backend build and its check, BEFORE any tag: `docker build --target projectbox
// -t cbase-projectbox:cand-<release>` (the stage `basis` comes from the cache of the backend build), then the host probe. If
// either fails, the deploy aborts before `cbase-backend:latest` is repointed. There is no host `:latest` for the project box —
// `:latest` exists only inside each user container.
//
// The Dockerfile parser is here too: `readProjectboxExpectation` takes the expected plugin versions and the login directory from
// the SAME Dockerfile that was built from — no second list of versions. The guard `tools/check/projectbox-dockerfile.test.mjs`
// uses the same parser.
import crypto from "node:crypto";

export const PROJECTBOX_STAGE = "projectbox";
export const BACKEND_STAGE = "backend";
export const ENTRY_IN_IMAGE = "/usr/sbin/cbase-projectbox-entry";
export const WRAPPER_IN_IMAGE = "/usr/sbin/cbase-wrapper";
export const ENTRYPOINT = ["/usr/bin/tini", "--", ENTRY_IN_IMAGE];
export const YARN = "/opt/yarn-v1.22.22";
// The files from server/backend/ that only the project box needs — they must go into the build context (targets/server.mjs,
// build.sh). `cbase-project` does NOT belong here: it lies only in the backend image (/usr/bin) and therefore stands in the
// file list of targets/server.mjs and in build.sh itself.
export const PROJECTBOX_FILES = ["projectbox-entry.sh", "cbase-wrapper"];
// The clone program is NOT in the project box but in the backend image under /usr/local/bin: that is mounted read-only into every
// project container and helper, and a fix to it does not change the id of the project box. Checked by `backendImageProbe`
// (targets/server.mjs).
export const CLONE_IN_BACKEND = "/usr/local/bin/cbase-clone";
// The LFS helper of the agent shells — for the same reason in the backend image under /usr/local/bin; the project box names it
// only in /etc/gitconfig (`credential.helper`). The start probe in every B holds the entry against this path
// (lib/projectbox-distribution.mjs), the guard the Dockerfile (projectbox-dockerfile.test.mjs).
export const LFS_HELPER_IN_BACKEND = "/usr/local/bin/cbase-lfs-access";
// What must be present in the project container: dockerd/tini from docker.io, lsof/ip from the stage, perl for the wrapper,
// python3 (project stacks, also for cbase-clone), setsid (util-linux), bash for the entrypoint; mount, mountpoint and umount for the
// overlay stage of the entrypoint (step 3a).
export const PROBE_COMMANDS = ["tini", "dockerd", "docker", "lsof", "ip", "iptables", "perl", "python3", "setsid", "bash", "mount", "mountpoint", "umount"];

// The image name comes from the caller (config.remote.projectboxImage) — this module imports no deploy configuration. The default is
// the name of the configuration and serves the frozen old states (private, absent from the public tree), which still call with the release only.
export function projectboxCand(release, image = "cbase-projectbox") {
  return `${image}:cand-${release}`;
}

// The SOURCE of the project box as a label. The id depends on the build cache of the host — after a cache loss the same sources
// produced a new id, the distribution loaded it into every B, and the restart grace recreated ALL project containers. The source
// is a sha256 over the instructions of the chain `basis` → `projectbox` (including FROM and ARG before the first FROM) and the
// sha256 of every file these stages take from the context via COPY/ADD — the file list comes from the SAME Dockerfile, never
// from a second list (a new COPY line without an entry would otherwise go unnoticed). The stage `backend` does not count: a
// change to the backend does not change the project box. If the inner :latest carries the same source as the host candidate,
// nothing is distributed (lib/projectbox-distribution.mjs, plan "source"). A deliberate refresh of the packages (apt, base image)
// goes through a source change.
export const SOURCE_LABEL = "cbase.projectbox.source";
export const SOURCE_RE = /^[0-9a-f]{64}$/;

// The sources of a COPY/ADD instruction (relative to the context) — or [] with `--from` (then the text of the instruction counts).
// What cannot be read as a list of simple paths (JSON form, pattern, `..`, absolute, URL) throws: a source that cannot be
// computed is an error, never "no file".
export function copySources(arg) {
  const t = String(arg).trim();
  if (t.startsWith("[")) throw new Error(`COPY/ADD in JSON form is not read for the source of the project box: ${t}`);
  const parts = t.split(" ").filter(Boolean);
  if (parts.some((x) => /^--from(=|$)/.test(x))) return [];
  const paths = parts.filter((x) => !x.startsWith("--"));
  if (paths.length < 2) throw new Error(`COPY/ADD without source and target: ${t}`);
  const sources = paths.slice(0, -1);
  for (const q of sources) {
    if (/[*?[\]]/.test(q) || q.startsWith("/") || q.split("/").includes("..") || /^[a-z]+:\/\//i.test(q)) throw new Error(`COPY/ADD source "${q}" is not a simple path in the context`);
  }
  return sources;
}

function projectboxChain(dockerfileText) {
  const stages = dockerfileStages(dockerfileText);
  const chain = stagesChain(stages, PROJECTBOX_STAGE);
  if (!chain.length || chain.at(-1).name !== PROJECTBOX_STAGE) throw new Error(`Dockerfile without stage "${PROJECTBOX_STAGE}"`);
  return { stages, chain };
}

// The files of the chain `basis` → `projectbox` that come from the context, in order and without duplicates.
export function projectboxSourceFiles(dockerfileText) {
  const out = [];
  for (const st of projectboxChain(dockerfileText).chain) {
    for (const a of st.instructions) if (a.op === "COPY" || a.op === "ADD") for (const q of copySources(a.arg)) if (!out.includes(q)) out.push(q);
  }
  return out;
}

// `fileHash(rel)` → sha256 (base-16) of the file in the context. Pure.
export function projectboxSource(dockerfileText, fileHash) {
  const { stages, chain } = projectboxChain(dockerfileText);
  const h = crypto.createHash("sha256");
  const part = (x) => { const b = Buffer.from(String(x)); h.update(`${b.length}:`); h.update(b); };
  part("cbase-projectbox-source-v1");
  for (const a of stages.beforeFrom) part(`VOR ${a.raw.replace(/\s+/g, " ")}`);
  for (const st of chain) {
    part(`FROM ${st.from} AS ${st.name}`);
    for (const a of st.instructions) {
      part(a.raw);
      if (a.op !== "COPY" && a.op !== "ADD") continue;
      for (const q of copySources(a.arg)) {
        const d = String(fileHash(q) || "");
        if (!SOURCE_RE.test(d)) throw new Error(`Source of the project box: no sha256 for "${q}"`);
        part(`DATEI ${q} ${d}`);
      }
    }
  }
  return h.digest("hex");
}

// ── The source against the BYTES that are built from ─────────────────────────────────────────────────────────────
//
// The deploy used to compute the source from the working tree only AFTER the upload and the backend build — and the label said only
// what the tree was at that moment, not what lay in the release folder and was built: a file that changed between rsync and the
// computation (a second session in the tree, an editor) gave the image a source that is not its own — and the distribution then
// compared sources instead of ids and left the wrong image standing. Now:
//   1. `targets/server.mjs` computes the state BEFORE the upload (Dockerfile text, sha256 per file of the chain, source);
//   2. after the upload and BEFORE every build `releaseSourceProbe` reads the sha256 in the release folder, and
//      `releaseSourceVerdict` holds them against the state and recomputes the source from the bytes of the release folder — if
//      anything deviates, the deploy aborts before anything is built;
//   3. the host probe reads the sha256 of entry and wrapper IN the built candidate (PROBE_FILES) and holds them against the state
//      (`projectboxFileExpectation`, `expectation.files` in projectboxVerdict) — without an expectation (rollback rebuild) no row.

// The paths in the image whose bytes the host probe holds against the tree.
export const PROBE_FILES = Object.freeze([ENTRY_IN_IMAGE, WRAPPER_IN_IMAGE]);

// The files the chain `basis` → `projectbox` copies from the context to a FIXED place in the image: [{ source, target }] —
// COPY/ADD with exactly one source and an absolute target that is no folder (no "/" at the end). From the same Dockerfile.
export function projectboxImageFiles(dockerfileText) {
  const out = [];
  for (const st of projectboxChain(dockerfileText).chain) {
    for (const a of st.instructions) {
      if (a.op !== "COPY" && a.op !== "ADD") continue;
      const sources = copySources(a.arg);
      const paths = a.arg.split(" ").filter((x) => x && !x.startsWith("--"));
      const target = paths.at(-1);
      if (sources.length === 1 && target.startsWith("/") && !target.endsWith("/")) out.push({ source: sources[0], target });
    }
  }
  return out;
}

// `fileHash(rel)` → sha256; → { [path in the image]: sha256 } for PROBE_FILES. A path without a COPY in the chain throws — an
// expectation that cannot be computed is an error, never "none".
export function projectboxFileExpectation(dockerfileText, fileHash) {
  const list = projectboxImageFiles(dockerfileText);
  const out = {};
  for (const target of PROBE_FILES) {
    const e = list.filter((x) => x.target === target);
    if (e.length !== 1) throw new Error(`Dockerfile, chain projectbox: ${e.length ? "more than one" : "no"} COPY instruction to ${target}`);
    const d = String(fileHash(e[0].source) || "");
    if (!SOURCE_RE.test(d)) throw new Error(`Expectation of the project box: no sha256 for "${e[0].source}"`);
    out[target] = d;
  }
  return out;
}

const SIMPLE = /^[A-Za-z0-9._/-]+$/;

// The shell text (for `sshProbe`, under `bash -s` with `set -euo pipefail`): per file in the release folder `backendDir` one line
// `sha.<rel>=<sha256|MISSING>` — the Dockerfile and every file of the chain (projectboxSourceFiles). If the folder is missing:
// `release=MISSING`.
export function releaseSourceProbe(backendDir, dockerfileText) {
  const dir = String(backendDir || "");
  if (!dir.startsWith("/") || !SIMPLE.test(dir)) throw new TypeError(`releaseSourceProbe: not a simple absolute path: ${dir}`);
  const files = ["Dockerfile", ...projectboxSourceFiles(dockerfileText)];
  for (const f of files) if (!SIMPLE.test(f)) throw new TypeError(`releaseSourceProbe: not a simple name: ${f}`);
  return [
    `cd ${dir} || { echo release=MISSING; exit 0; }`,
    `for f in ${files.join(" ")}; do`,
    `  if s=$(sha256sum -- "$f" 2>/dev/null); then echo "sha.$f=\${s%% *}"; else echo "sha.$f=MISSING"; fi`,
    `done`,
  ].join("\n");
}

// The verdict on the output of releaseSourceProbe against the state BEFORE the upload (`state` = { dockerfile, dockerfileSha,
// files: { rel: sha }, source }): { ok, rows, sourceRelease } — `sourceRelease` is the source recomputed from the sha256 of the
// release folder (null if one is missing). Every missing row is "bad".
export function releaseSourceVerdict(stdout, state) {
  const kv = new Map();
  for (const z of String(stdout ?? "").split("\n")) {
    const i = z.indexOf("=");
    if (i > 0 && !kv.has(z.slice(0, i))) kv.set(z.slice(0, i).trim(), z.slice(i + 1).trim());
  }
  const rows = [];
  const short = (s) => (s === undefined ? "(no row)" : SOURCE_RE.test(s) ? s.slice(0, 12) : s || "(empty)");
  const check = (what, value, good) => rows.push([what, short(value), good ? "ok" : "bad"]);
  if (kv.get("release") === "MISSING") check("Release folder", "MISSING", false);
  check("Dockerfile in the release = state before the upload", kv.get("sha.Dockerfile"), kv.get("sha.Dockerfile") === state.dockerfileSha);
  for (const [rel, sha] of Object.entries(state.files)) check(`${rel} in the release = state before the upload`, kv.get(`sha.${rel}`), kv.get(`sha.${rel}`) === sha);
  let sourceRelease = null;
  try { sourceRelease = projectboxSource(state.dockerfile, (rel) => kv.get(`sha.${rel}`)); } catch { sourceRelease = null; }
  check("Source from the bytes of the release folder", sourceRelease ?? "not computable", sourceRelease === state.source);
  return { ok: rows.every((z) => z[2] === "ok"), rows, sourceRelease };
}

// Context and Dockerfile are those of the backend build (releases/<release>/backend). With `source` the image carries it as a
// label — behind `-t`, where the guards recognise the command.
export function projectboxBuildCommand({ root, release, cand, source = null }) {
  if (source !== null && !SOURCE_RE.test(String(source))) throw new TypeError(`projectboxBuildCommand: no source: ${source}`);
  const label = source ? ` --label ${SOURCE_LABEL}=${source}` : "";
  return `cd ${root} && docker build --target ${PROJECTBOX_STAGE} -t ${cand}${label} -f releases/${release}/backend/Dockerfile releases/${release}/backend`;
}

// In the candidate, as root, under sh (dash), WITHOUT `set -e`: every check writes exactly one line `key=value`, even if it
// fails — an abort in the middle would look like "the rest are missing". No single quotes needed: the text stands in a heredoc
// with a quoted terminator.
export const PROBE_INSIDE = [
  `for b in ${PROBE_COMMANDS.join(" ")}; do`,
  `  if p=$(command -v "$b" 2>/dev/null); then echo "bin.$b=$p"; else echo "bin.$b=MISSING"; fi`,
  `done`,
  `if [ -x ${ENTRY_IN_IMAGE} ] && bash -n ${ENTRY_IN_IMAGE} 2>/dev/null; then echo entry=ok; else echo entry=MISSING; fi`,
  `if [ -x ${WRAPPER_IN_IMAGE} ] && perl -c ${WRAPPER_IN_IMAGE} >/dev/null 2>&1; then echo wrapper=ok; else echo wrapper=MISSING; fi`,
  // The bytes of entry and wrapper in the image — projectboxVerdict holds them against the state before the upload.
  `for f in ${PROBE_FILES.join(" ")}; do`,
  `  if s=$(sha256sum "$f" 2>/dev/null); then echo "sha.$f=\${s%% *}"; else echo "sha.$f=MISSING"; fi`,
  `done`,
  `echo "compose=$(docker compose version 2>/dev/null | head -1)"`,
  `echo "buildx=$(docker buildx version 2>/dev/null | head -1)"`,
  `if [ -e /app ]; then echo app=present; else echo app=absent; fi`,
  `if [ -e /usr/local/lib/node_modules/@anthropic-ai ] || [ -e /usr/local/lib/node_modules/@openai ] || [ -e /usr/local/lib/node_modules/@go-task ]; then echo cli=present; else echo cli=absent; fi`,
  `echo "agent.uid=$(id -u agent 2>/dev/null)"`,
  `case " $(id -nG agent 2>/dev/null) " in *" docker "*) echo agent.docker=yes;; *) echo agent.docker=no;; esac`,
  `if [ -d ${YARN} ]; then echo yarn=ok; else echo yarn=MISSING; fi`,
  `echo "login=\${CLAUDE_SECURESTORAGE_CONFIG_DIR:-}"`,
  `echo "libmount=\${LIBMOUNT_FORCE_MOUNT2:-}"`,
].join("\n");

// The shell text of the host check (for `sshProbe`, runs there under `bash -s` with `set -euo pipefail`). Without network, as a
// throwaway container; entrypoint and user are read by `image inspect` because `--entrypoint sh` masks them.
export function projectboxHostProbe(cand) {
  return [
    `docker image inspect --format 'entrypoint={{json .Config.Entrypoint}}{{"\\n"}}user={{.Config.User}}{{"\\n"}}labels={{json .Config.Labels}}' ${cand} || echo entrypoint=MISSING`,
    `docker run --rm -i --network none --entrypoint sh ${cand} -s <<'HEXEOF' || true`,
    PROBE_INSIDE,
    `HEXEOF`,
  ].join("\n");
}

// ── Reading the Dockerfile ─────────────────────────────────────────────────────────────────────────────────────────────

// Logical instructions: continuation lines joined, comments (also within a continuation) and blank lines dropped, whitespace in
// the argument collapsed to one character. `row` is the first physical line (1-based).
export function dockerfileInstructions(text) {
  const out = [];
  let accumulator = null;
  let start = 0;
  const rows = String(text ?? "").split("\n");
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (/^\s*#/.test(raw)) continue;
    if (accumulator === null && !raw.trim()) continue;
    const z = raw.replace(/\s+$/, "");
    if (accumulator === null) { accumulator = ""; start = i + 1; }
    if (z.endsWith("\\")) { accumulator += `${z.slice(0, -1)} `; continue; }
    accumulator += z;
    out.push(instruction(accumulator, start));
    accumulator = null;
  }
  if (accumulator !== null && accumulator.trim()) out.push(instruction(accumulator, start));
  return out;
}

// `arg` with collapsed whitespace (for comparing), `raw` as written — where whitespace carries meaning (the two spaces of a
// `sha256sum -c` line).
function instruction(logical, row) {
  const raw = logical.trim();
  const t = raw.replace(/\s+/g, " ");
  const i = t.indexOf(" ");
  return { op: (i < 0 ? t : t.slice(0, i)).toUpperCase(), arg: i < 0 ? "" : t.slice(i + 1), raw, row };
}

// Stages in order: { name, from, instructions } — `from` is the image behind FROM, `name` the name behind AS (else null).
// Instructions before the first FROM (ARG) stand under `beforeFrom`.
export function dockerfileStages(text) {
  const stages = [];
  const beforeFrom = [];
  for (const a of dockerfileInstructions(text)) {
    if (a.op === "FROM") {
      const m = a.arg.match(/^(?:--\S+ )*(\S+)(?: AS (\S+))?$/i);
      stages.push({ name: m ? m[2] || null : null, from: m ? m[1] : a.arg, instructions: [], row: a.row });
      continue;
    }
    (stages.length ? stages[stages.length - 1].instructions : beforeFrom).push(a);
  }
  return Object.assign(stages, { beforeFrom });
}

// `ENV A=1 B=2` resp. the old form `ENV A 1` → [[A, "1"], [B, "2"]]. Values without whitespace and without quotes — this
// Dockerfile knows no more.
export function envPairs(arg) {
  const parts = String(arg).split(" ");
  if (!parts[0].includes("=")) return [[parts[0], parts.slice(1).join(" ")]];
  return parts.map((t) => { const i = t.indexOf("="); return [t.slice(0, i), t.slice(i + 1)]; });
}

// A stage with its ancestors, oldest first (the ENV of `basis` continues to apply in `backend`).
export function stagesChain(stages, name) {
  const chain = [];
  let s = stages.find((x) => x.name === name);
  while (s && !chain.includes(s)) { chain.unshift(s); const from = s.from; s = stages.find((x) => x.name && x.name === from); }
  return chain;
}

export function stagesEnv(stages, name) {
  const chain = stagesChain(stages, name);
  const env = {};
  for (const st of chain) for (const a of st.instructions) if (a.op === "ENV") for (const [k, v] of envPairs(a.arg)) env[k] = v;
  return env;
}

// What the host probe expects, from the Dockerfile: plugin versions (ARG of the stage projectbox) and the login directory (ENV,
// inherited from basis). If something is missing, that is an error — never "empty = fits". Plus LIBMOUNT_FORCE_MOUNT2 from the
// same stage: here "not set" expressly means "empty expected" (an older release does not set it, and the rollback checks its
// project box against ITS Dockerfile); that the current one sets it is held by projectbox-dockerfile.test.mjs.
export function readProjectboxExpectation(text) {
  const stages = dockerfileStages(text);
  const pb = stages.find((s) => s.name === PROJECTBOX_STAGE);
  if (!pb) throw new Error(`server/backend/Dockerfile has no stage "${PROJECTBOX_STAGE}"`);
  const arg = {};
  for (const a of pb.instructions) if (a.op === "ARG") { const i = a.arg.indexOf("="); if (i > 0) arg[a.arg.slice(0, i)] = a.arg.slice(i + 1); }
  const missing = ["COMPOSE_VERSION", "BUILDX_VERSION"].filter((k) => !/^v\d+\.\d+\.\d+$/.test(arg[k] || ""));
  if (missing.length) throw new Error(`server/backend/Dockerfile, stage projectbox: ${missing.join(", ")} is missing or not an exact version`);
  const login = stagesEnv(stages, PROJECTBOX_STAGE).CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (!login) throw new Error("server/backend/Dockerfile: CLAUDE_SECURESTORAGE_CONFIG_DIR is missing in the stage projectbox (belongs in basis)");
  const libmount = stagesEnv(stages, PROJECTBOX_STAGE).LIBMOUNT_FORCE_MOUNT2 ?? "";
  return { compose: arg.COMPOSE_VERSION, buildx: arg.BUILDX_VERSION, login, libmount };
}

// ── Verdict ───────────────────────────────────────────────────────────────────────────────────────────────────────

// From the output of the host probe: { ok, rows } — `rows` in the format of log.table ([what, value, "ok"|"bad"]). Every
// missing row is "bad": a probe that says nothing is not a passed one.
export function projectboxVerdict(stdout, expectation) {
  const kv = new Map();
  for (const z of String(stdout ?? "").split("\n")) {
    const i = z.indexOf("=");
    if (i > 0 && !kv.has(z.slice(0, i))) kv.set(z.slice(0, i).trim(), z.slice(i + 1).trim());
  }
  const rows = [];
  const check = (what, value, good) => rows.push([what, value === undefined ? "(no row)" : value || "(empty)", good ? "ok" : "bad"]);
  const ep = kv.get("entrypoint");
  check("Entrypoint (tini → entry)", ep, ep === JSON.stringify(ENTRYPOINT));
  check("User of the image", kv.has("user") ? kv.get("user") || "root" : undefined, kv.get("user") === "");
  for (const b of PROBE_COMMANDS) {
    const v = kv.get(`bin.${b}`);
    check(`${b} in the image`, v, b === "tini" ? v === ENTRYPOINT[0] : Boolean(v) && v !== "MISSING");
  }
  check("Entrypoint script (bash -n)", kv.get("entry"), kv.get("entry") === "ok");
  check("Wrapper (perl -c)", kv.get("wrapper"), kv.get("wrapper") === "ok");
  // With expected bytes (the deploy computes them BEFORE the upload) the image must carry exactly those. Without an expectation
  // (rollback rebuild) no row.
  if (expectation.files) {
    for (const [target, sha] of Object.entries(expectation.files)) {
      const v = kv.get(`sha.${target}`);
      check(`${target} = state before the upload (sha256)`, SOURCE_RE.test(v || "") ? v.slice(0, 12) : v, v === sha);
    }
  }
  const ver = (s) => (String(s || "").match(/v\d+\.\d+\.\d+/) || [])[0] || "";
  check(`docker compose ${expectation.compose}`, kv.get("compose"), ver(kv.get("compose")) === expectation.compose);
  check(`docker buildx ${expectation.buildx}`, kv.get("buildx"), ver(kv.get("buildx")) === expectation.buildx);
  check("/app (backend) in the image", kv.get("app"), kv.get("app") === "absent");
  check("CLIs under /usr/local (arrive by bind)", kv.get("cli"), kv.get("cli") === "absent");
  check("agent", kv.get("agent.uid"), kv.get("agent.uid") === "1001");
  check("agent in the docker group", kv.get("agent.docker"), kv.get("agent.docker") === "yes");
  check(YARN, kv.get("yarn"), kv.get("yarn") === "ok");
  check("CLAUDE_SECURESTORAGE_CONFIG_DIR", kv.get("login"), kv.get("login") === expectation.login);
  // With an expected source (the deploy computes it from the tree) the image must carry it — a label that does not arrive would
  // mean: every distribution compares only ids again. Without an expectation (rollback rebuild) no row.
  if (expectation.source) {
    let q = null;
    try { q = JSON.parse(kv.get("labels") ?? "null")?.[SOURCE_LABEL] ?? null; } catch { q = null; }
    check(`Label ${SOURCE_LABEL}`, typeof q === "string" ? q.slice(0, 12) : kv.get("labels"), q === expectation.source);
  }
  check(`LIBMOUNT_FORCE_MOUNT2 (${expectation.libmount || "not set"})`, kv.has("libmount") ? kv.get("libmount") || "not set" : undefined,
    kv.has("libmount") && kv.get("libmount") === expectation.libmount);
  return { ok: rows.every((z) => z[2] === "ok"), rows };
}
