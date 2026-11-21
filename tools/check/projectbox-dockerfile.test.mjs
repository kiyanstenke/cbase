// The multi-stage server/backend/Dockerfile and the host probe of the project box. The Dockerfile as TEXT, read with the same
// parser the deploy uses (lib/projectbox.mjs) — no docker, no network.
//
// Promises: stages base → projectbox → backend, `backend` the last (a build without --target still builds the backend); exactly
// ONE apt row with docker.io, in base; `projectbox` without `npm install -g`, without /usr/local, without /app, without
// `COPY electron` (else every backend deploy would change its id); every plugin download with `sha256sum -c`; ENTRYPOINT tini →
// entry; `readCliPins` returns exactly the two pins. Plus what holds the behavior of the backend build: backend inherits from
// base (not from projectbox — else lsof would not stay out of the user container), the user agent and the login directory come
// from base, `ENV HOME` stands after every npm install (else root puts its npm cache into the home volume).
// Counter-tests: the state before the multi-stage Dockerfile (one stage) is red; copies with swapped stages, without the sha row,
// with `npm -g` in projectbox, with a second Claude pin of another version, with a second docker.io row, with
// `FROM projectbox AS backend`, with the login ENV in backend instead of base, with `ENV HOME` before npm: each red.
// Plus the host probe: its text (build with --target, probe without network), its inner part under sh AND dash (every line exactly
// once), and the verdict on a good output and on every single deviation. The place in the deploy via the seam
// rollOutAfterBackendBuild (`deployPlace`, counter-test against the old state and six sabotages) and the verdict on the backend
// image (`backendImageVerdict`, one counter-test per line).
// `ENV LIBMOUNT_FORCE_MOUNT2=always` exactly once and only in projectbox; `COPY cbase-clone /usr/local/bin/cbase-clone` exactly once
// and only in backend (not in the project box — else every fix would recreate every moved project), with `chmod 755` and a run
// under python3; the host probe asks mount/mountpoint/umount and LIBMOUNT_FORCE_MOUNT2 (expectation from the same Dockerfile, an
// old release expects "not set"), the backend probe the clone program. Counter-tests: the state before that (BEFORE_ST2_0) is red,
// likewise the ENV in base, the clone program in projectbox and a backend without the run under python3.
// The source of the project box is computed BEFORE the first upload (`localProjectboxStatus`, frozen), the release folder is held
// against the same bytes after the last upload and BEFORE the build (`releaseSourceProbe`/`-Verdict`, `checkReleaseSource` —
// deviating ⇒ nothing built), and the host probe reads the sha256 of entry and wrapper IN the candidate against the state
// (`PROBE_FILES`, `projectboxFileExpectation`, `expectation.files` in the verdict). The seam rollOutAfterBackendBuild demands the
// state (TypeError without) and never recomputes. `deployPlace` holds the order (state before the first rsyncUp, check between
// the last rsyncUp and the build) with seven built-in sabotages.
// COUNTER-TESTS: deployServer without `await checkReleaseSource(…)` ⇒ "the place in the deploy …" red; releaseSourceVerdict always
// returns ok ⇒ "releaseSourceProbe/-Verdict …" red (a changed wrapper in the release folder went unnoticed) and
// projectbox-distribution.test.mjs "checkReleaseSource …" red.
//
//
// SPLIT. This is the PUBLIC half (the Dockerfile as text, the parsers and verdicts of lib/projectbox.mjs, the scripts of
// lib/projectbox-scripts.mjs). What reads targets/server.mjs (upload loop, the place in the deploy, backendImageVerdict, the source of the
// release folder) stands in the maintainer's private suite.
//
// Run:  node --test --test-reporter=tap tools/check/projectbox-dockerfile.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUILD_CONTEXT_FILES } from "./lib/build-context.mjs";
import { readCliPins, PinError } from "./lib/cli-pins.mjs";
import {
  BACKEND_STAGE, ENTRYPOINT, WRAPPER_IN_IMAGE, ENTRY_IN_IMAGE, CLONE_IN_BACKEND, PROBE_COMMANDS, PROBE_INSIDE, PROJECTBOX_FILES, PROJECTBOX_STAGE,
  dockerfileInstructions, dockerfileStages, envPairs, readProjectboxExpectation, projectboxBuildCommand, projectboxCand,
  projectboxHostProbe, projectboxVerdict, stagesEnv, stagesChain, SOURCE_LABEL, copySources, projectboxSourceFiles, projectboxSource,
  PROBE_FILES, projectboxFileExpectation, projectboxImageFiles, releaseSourceProbe, releaseSourceVerdict, LFS_HELPER_IN_BACKEND,
} from "./lib/projectbox.mjs";
import { probeScript, prepareScript } from "./lib/projectbox-scripts.mjs";
// Old states (counter-tests) come through the ONE helper: the path of then, the content with today's names.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const DOCKERFILE = path.join(REPO, "server/backend/Dockerfile");
const DOCKER = fs.readFileSync(DOCKERFILE, "utf8");
// The last state BEFORE the multi-stage Dockerfile (2c8ac79, reduced: one stage, no npm pins needed for the counter-test).
const SINGLE_STAGE_BEFORE_S1_6 = [
  "FROM node:22-bookworm-slim",
  "ENV DEBIAN_FRONTEND=noninteractive",
  "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl docker.io && rm -rf /var/lib/apt/lists/*",
  "WORKDIR /app",
  "COPY package.json ./",
  "RUN npm install --omit=dev && npm cache clean --force",
  "COPY electron ./electron",
  "COPY headless.js ./",
  "RUN useradd -m -u 1001 -s /bin/bash agent && usermod -aG docker agent",
  "COPY entry.sh /entry.sh",
  "RUN chmod +x /entry.sh",
  "ENV HOME=/home/agent",
  "WORKDIR /home/agent",
  'ENTRYPOINT ["/entry.sh"]',
  "",
].join("\n");
const old = () => SINGLE_STAGE_BEFORE_S1_6;
// The later states before a change are rebuilt from today's Dockerfile by taking the change out again (`withReplacement` throws
// when its place has moved, so a rebuild never silently equals today's file). Which instructions name a word (comments do not count):
const instructionsWith = (text, word) => dockerfileStages(text).flatMap((s) => s.instructions).filter((a) => a.raw.includes(word));
// BEFORE_ST2_0 (0bcae4a): no clone program, no LIBMOUNT_FORCE_MOUNT2.
const beforeSt20 = () => withReplacement(withReplacement(DOCKER, /^ENV LIBMOUNT_FORCE_MOUNT2=always\n/m, ""),
  /^COPY cbase-clone \/usr\/local\/bin\/cbase-clone\nRUN chmod 755 \/usr\/local\/bin\/cbase-clone [^\n]*\n/m, "");
// BEFORE_AN_1 (6b431dd1): no git-lfs in the project box, no LFS helper in the backend.
const beforeAn1 = () => withReplacement(withReplacement(DOCKER, LFS_BLOCK_OF_TODAY, ""),
  /^COPY cbase-lfs-access \/usr\/local\/bin\/cbase-lfs-access\nRUN chmod 755 \/usr\/local\/bin\/cbase-lfs-access [^\n]*\n(?: {4}[^\n]*\n)*/m, "");

const LFS_BLOCK_OF_TODAY = /^RUN apt-get update && apt-get install -y --no-install-recommends git-lfs \\\n(?:.*\\\n)*.*\nENV GIT_LFS_SKIP_SMUDGE=1\n/m;
const NPM_G = /\bnpm\s+(?:install|i)\b.*\s(?:-g|--global)\b/;
const APP = /(?:^|[\s"'=:])\/app(?:[/\s"']|$)/;
const lsofOrIp = (a) => a.op === "RUN" && /\bapt-get install\b/.test(a.arg) && /\s(?:lsof|iproute2)(?:\s|$)/.test(a.arg);

// All promises for ONE text — as a function so that the same check turns red on every falsified version.
function checkDockerfile(text) {
  const st = dockerfileStages(text);
  assert.deepEqual(st.map((s) => s.name), ["base", PROJECTBOX_STAGE, BACKEND_STAGE], "stages and order");
  assert.equal(st.at(-1).name, BACKEND_STAGE, "the last stage is not backend — a build without --target would build something else");
  assert.match(st[0].from, /^node:22-bookworm-slim$/);
  assert.equal(st[1].from, "base", "projectbox does not inherit from base");
  assert.equal(st[2].from, "base", "backend does not inherit from base (from projectbox: lsof and the plugins would lie in the user container)");
  const [base, pb, backend] = st;
  const all = st.flatMap((s) => s.instructions.map((a) => ({ ...a, stage: s.name })));

  // base: the ONE package list, agent after it (the docker group comes with docker.io), the login directory.
  const apt = all.filter((a) => a.op === "RUN" && /\bapt-get install\b/.test(a.arg) && /\sdocker\.io(?:\s|$)/.test(a.arg));
  assert.equal(apt.length, 1, `exactly one apt row with docker.io, found: ${apt.length}`);
  assert.equal(apt[0].stage, "base", "the apt row with docker.io is not in base");
  const iApt = base.instructions.indexOf(base.instructions.find((a) => a.row === apt[0].row));
  const iUser = base.instructions.findIndex((a) => a.op === "RUN" && /\buseradd -m -u 1001 -s \/bin\/bash agent && usermod -aG docker agent\b/.test(a.arg));
  assert.ok(iUser > iApt, "agent (uid 1001, docker group) does not stand after the apt row in base");
  assert.equal(stagesEnv(st, "base").CLAUDE_SECURESTORAGE_CONFIG_DIR, "/home/agent/.claude-login", "the login directory belongs in base");
  for (const a of backend.instructions.filter((x) => x.op === "ENV")) {
    assert.ok(!envPairs(a.arg).some(([k]) => k === "CLAUDE_SECURESTORAGE_CONFIG_DIR"), "CLAUDE_SECURESTORAGE_CONFIG_DIR twice (also in backend)");
  }
  assert.equal(stagesEnv(st, BACKEND_STAGE).CLAUDE_SECURESTORAGE_CONFIG_DIR, "/home/agent/.claude-login");
  assert.equal(stagesEnv(st, PROJECTBOX_STAGE).CLAUDE_SECURESTORAGE_CONFIG_DIR, "/home/agent/.claude-login");

  // projectbox: nothing that changes with the backend.
  for (const a of pb.instructions) {
    assert.ok(!NPM_G.test(a.arg), `projectbox installs globally via npm (line ${a.row})`);
    // /etc/gitconfig NAMES the LFS helper under /usr/local/bin (and the probe in the build compares with it) — exactly these two
    // forms write nothing there; every other mention of /usr/local stays red.
    const withoutHelperReference = LFS_REFERENCES.reduce((t, v) => t.split(v).join(""), a.arg);
    assert.ok(!withoutHelperReference.includes("/usr/local"), `projectbox writes under /usr/local (line ${a.row}) — the ro bind lies there`);
    assert.ok(!APP.test(a.arg), `projectbox touches /app (line ${a.row})`);
    assert.ok(!(a.op === "COPY" && /(^|\s)electron(\s|\/|$)/.test(a.arg)), `projectbox copies electron (line ${a.row})`);
    assert.notEqual(a.op, "USER", "projectbox switches the user — the entrypoint needs root");
  }
  assert.equal(pb.instructions.filter(lsofOrIp).length, 1, "lsof/iproute2 not (or several times) in projectbox");
  assert.ok(/\slsof\s/.test(pb.instructions.find(lsofOrIp).arg) && /\siproute2(\s|$)/.test(pb.instructions.find(lsofOrIp).arg));
  for (const s of [base, backend]) assert.equal(s.instructions.filter(lsofOrIp).length, 0, `lsof/iproute2 in ${s.name} — the user container stays without lsof`);
  // Plugins: every downloaded file against its sha256.
  const downloads = [];
  for (const a of pb.instructions.filter((x) => x.op === "RUN")) {
    for (const m of a.arg.matchAll(/\bcurl\b[^&]*?\s-o\s+(\S+)/g)) downloads.push({ target: m[1], raw: a.raw });
  }
  assert.deepEqual(downloads.map((d) => d.target).sort(), ["/usr/libexec/docker/cli-plugins/docker-buildx", "/usr/libexec/docker/cli-plugins/docker-compose"]);
  for (const d of downloads) {
    const var_ = d.target.endsWith("compose") ? "COMPOSE_SHA256" : "BUILDX_SHA256";
    // Two spaces between sum and file: the format `sha256sum -c` reads.
    assert.ok(d.raw.includes(`echo "\${${var_}}  ${d.target}" | sha256sum -c -`), `${d.target} without sha256sum -c`);
    const value = (pb.instructions.find((x) => x.op === "ARG" && x.arg.startsWith(`${var_}=`)) || {}).arg;
    assert.match(value || "", /^[A-Z0-9_]+=[0-9a-f]{64}$/, `${var_} is no sha256`);
  }
  assert.ok(pb.instructions.some((a) => a.op === "RUN" && /docker compose version && docker buildx version$/.test(a.arg)), "the plugins are not called after the download");
  const wanted = readProjectboxExpectation(text);
  assert.match(wanted.compose, /^v\d+\.\d+\.\d+$/);
  assert.match(wanted.buildx, /^v\d+\.\d+\.\d+$/);
  // Entrypoint and wrapper: from the context to their place, tini before.
  const copy = pb.instructions.filter((a) => a.op === "COPY").map((a) => a.arg);
  assert.deepEqual(copy, [`${PROJECTBOX_FILES[0]} ${ENTRY_IN_IMAGE}`, `${PROJECTBOX_FILES[1]} ${WRAPPER_IN_IMAGE}`]);
  const ep = pb.instructions.filter((a) => a.op === "ENTRYPOINT");
  assert.equal(ep.length, 1);
  assert.deepEqual(JSON.parse(ep[0].arg), ENTRYPOINT, "ENTRYPOINT is not tini → entry");

  // backend: the pins, the rest of today's build, HOME only after npm, entry of the user container, root.
  const pins = readCliPins(text);
  assert.deepEqual(Object.keys(pins).sort(), ["claude", "codex"]);
  const pinRow = all.filter((a) => a.op === "RUN" && a.arg.includes("@anthropic-ai/claude-code@"));
  assert.deepEqual(pinRow.map((a) => a.stage), [BACKEND_STAGE], "the CLI pins are not (only) in backend");
  assert.ok(backend.instructions.some((a) => a.op === "COPY" && a.arg === "electron ./electron"));
  assert.deepEqual(JSON.parse(backend.instructions.filter((a) => a.op === "ENTRYPOINT").at(-1).arg), ["/entry.sh"]);
  const chain = stagesChain(st, BACKEND_STAGE).flatMap((s) => s.instructions);
  const iHome = chain.findIndex((a) => a.op === "ENV" && envPairs(a.arg).some(([k]) => k === "HOME"));
  const iNpm = chain.map((a) => a.op === "RUN" && /\bnpm\s+install\b/.test(a.arg)).lastIndexOf(true);
  assert.ok(iHome > iNpm && iNpm >= 0, "ENV HOME stands before an npm install — root would write its cache into the home volume");
  assert.ok(!all.some((a) => a.op === "USER"), "a USER — both entries need root");

  // The overlay stage needs mount(2) — the variable only in projectbox; the clone program only in backend.
  const libmount = all.filter((a) => a.op === "ENV" && envPairs(a.arg).some(([k]) => k === "LIBMOUNT_FORCE_MOUNT2"));
  assert.deepEqual(libmount.map((a) => a.stage), [PROJECTBOX_STAGE], "LIBMOUNT_FORCE_MOUNT2 not exactly once, not in projectbox");
  assert.equal(stagesEnv(st, PROJECTBOX_STAGE).LIBMOUNT_FORCE_MOUNT2, "always");
  assert.equal(stagesEnv(st, BACKEND_STAGE).LIBMOUNT_FORCE_MOUNT2, undefined, "LIBMOUNT_FORCE_MOUNT2 in the backend image");
  const clone = all.filter((a) => /(^|[\s/])cbase-clone(\s|$)/.test(a.arg) && a.op !== "RUN");
  assert.deepEqual(clone.map((a) => [a.stage, a.op, a.arg]), [[BACKEND_STAGE, "COPY", `cbase-clone ${CLONE_IN_BACKEND}`]],
    "cbase-clone not exactly once to /usr/local/bin in the backend (never in projectbox)");
  const iClone = backend.instructions.findIndex((a) => a.op === "COPY" && a.arg === `cbase-clone ${CLONE_IN_BACKEND}`);
  assert.ok(backend.instructions.slice(iClone + 1).some((a) => a.op === "RUN" && a.arg.includes(`chmod 755 ${CLONE_IN_BACKEND}`)
    && a.arg.includes(`python3 ${CLONE_IN_BACKEND} --help`)), "cbase-clone without chmod 755 and without a run under python3");

  // git-lfs, `git lfs install --system`, GIT_LFS_SKIP_SMUDGE=1 and the two lines in /etc/gitconfig exactly once and ONLY in
  // projectbox (B stays without git-lfs and without a system-wide helper); no --skip-smudge anywhere; the helper itself exactly
  // once and ONLY in backend to /usr/local/bin, executable, `node --check` and an LFS request without environment that must
  // say nothing.
  const lfsApt = all.filter((a) => a.op === "RUN" && /\bapt-get install\b/.test(a.arg) && /\sgit-lfs(?:\s|$)/.test(a.arg));
  assert.deepEqual(lfsApt.map((a) => a.stage), [PROJECTBOX_STAGE], "git-lfs not exactly once via apt in projectbox (cloning happens only in the project container)");
  const lfsInstall = all.filter((a) => a.op === "RUN" && /\bgit lfs install\b/.test(a.arg));
  assert.deepEqual(lfsInstall.map((a) => a.stage), [PROJECTBOX_STAGE], "git lfs install not exactly once in projectbox");
  assert.match(lfsInstall[0].arg, /\bgit lfs install --system(?: |$)/, "git lfs install without --system");
  const skip = all.filter((a) => /--skip-smudge\b|\bfilter-process --skip\b/.test(a.arg));
  assert.deepEqual(skip.map((a) => a.row), [], "--skip-smudge: --skip would stand fixed in filter.lfs.process, and the agent shells could not switch smudge on");
  assert.ok(lfsInstall[0].arg.includes('test "$(git config --system --get filter.lfs.process)" = "git-lfs filter-process"'), "the build does not check the filter (without --skip)");
  const smudgeEnv = all.filter((a) => a.op === "ENV" && envPairs(a.arg).some(([k]) => k === "GIT_LFS_SKIP_SMUDGE"));
  assert.deepEqual(smudgeEnv.map((a) => a.stage), [PROJECTBOX_STAGE], "GIT_LFS_SKIP_SMUDGE not exactly once in projectbox");
  assert.equal(stagesEnv(st, PROJECTBOX_STAGE).GIT_LFS_SKIP_SMUDGE, "1", "GIT_LFS_SKIP_SMUDGE is not 1 — every process without its own setting would fetch LFS files");
  assert.equal(stagesEnv(st, BACKEND_STAGE).GIT_LFS_SKIP_SMUDGE, undefined, "GIT_LFS_SKIP_SMUDGE in the backend image");
  assert.deepEqual(systemGitConfig(all), [
    [PROJECTBOX_STAGE, "credential.helper", LFS_HELPER_IN_BACKEND],
    [PROJECTBOX_STAGE, "credential.useHttpPath", "true"],
  ], "/etc/gitconfig: not exactly the LFS helper and credential.useHttpPath, not (only) in projectbox");
  assert.ok(lfsInstall[0].arg.includes(`test "$(git config --system --get-all credential.helper)" = ${LFS_HELPER_IN_BACKEND}`)
    && lfsInstall[0].arg.includes('test "$(git config --system --get credential.useHttpPath)" = true')
    && /&& git lfs version(?: |$)/.test(lfsInstall[0].arg), "the build does not check git-lfs, the helper and useHttpPath");
  const helper = all.filter((a) => /(^|[\s/])cbase-lfs-access(\s|$)/.test(a.arg) && a.op !== "RUN");
  assert.deepEqual(helper.map((a) => [a.stage, a.op, a.arg]), [[BACKEND_STAGE, "COPY", `cbase-lfs-access ${LFS_HELPER_IN_BACKEND}`]],
    "cbase-lfs-access not exactly once to /usr/local/bin in the backend (never in projectbox)");
  const iHelper = backend.instructions.findIndex((a) => a.op === "COPY" && a.arg === `cbase-lfs-access ${LFS_HELPER_IN_BACKEND}`);
  const helperRun = backend.instructions[iHelper + 1];
  assert.ok(helperRun?.op === "RUN" && helperRun.arg.includes(`chmod 755 ${LFS_HELPER_IN_BACKEND}`) && helperRun.arg.includes(`node --check ${LFS_HELPER_IN_BACKEND}`)
    && helperRun.arg.includes(`test -z "$(printf 'protocol=https\\nhost=h\\npath=o/r.git/info/lfs\\n\\n' | ${LFS_HELPER_IN_BACKEND} get 2>&1)"`),
  "cbase-lfs-access without chmod 755, without node --check or without the silent LFS request right after the COPY");
  return { st, pins };
}

// The two forms in which the stage projectbox NAMES the LFS helper under /usr/local/bin (the line in /etc/gitconfig and the probe
// in the build) — they write nothing there.
const LFS_REFERENCES = [
  `git config --system credential.helper ${LFS_HELPER_IN_BACKEND}`,
  `test "$(git config --system --get-all credential.helper)" = ${LFS_HELPER_IN_BACKEND}`,
];
// Every writing `git config --system [--add] <key> <value>` in a RUN line: [stage, key, value] — an `--add` counts (a second
// helper), the reading forms (`--get`, `--get-all`) do not.
function systemGitConfig(all) {
  const out = [];
  for (const a of all.filter((x) => x.op === "RUN")) {
    for (const m of a.arg.matchAll(/\bgit config --system (?:--add )?(?!-)(\S+) (\S+)/g)) out.push([a.stage, m[1], m[2]]);
  }
  return out;
}

// A text in blocks per FROM line (the comments before belong to the previous block) — for the swap.
function blocks(text) {
  const parts = text.split(/(?=^FROM )/m);
  return { header: parts[0], stages: parts.slice(1) };
}
function withReplacement(text, from, to) {
  const fresh = text.replace(from, to);
  assert.notEqual(fresh, text, `the place "${String(from).slice(0, 60)}" has moved — the counter-test does not bite`);
  return fresh;
}

// ── The Dockerfile ──

test("the real Dockerfile keeps every promise; readCliPins returns exactly the two pins", () => {
  const { pins } = checkDockerfile(DOCKER);
  assert.match(pins.claude, /^\d+\.\d+\.\d+$/);
  assert.match(pins.codex, /^\d+\.\d+\.\d+$/);
});

test("counter-test: the state before the multi-stage Dockerfile (one stage) is red", () => {
  const a = old();
  assert.equal(dockerfileStages(a).length, 1, "the fixed commit is not the state before the multi-stage Dockerfile");
  assert.throws(() => checkDockerfile(a), assert.AssertionError);
});

test("counter-test: swapped stages (backend not last) are red", () => {
  const { header, stages } = blocks(DOCKER);
  assert.equal(stages.length, 3);
  assert.throws(() => checkDockerfile(header + stages[0] + stages[2] + "\n" + stages[1]), /last stage|stages and order/);
});

test("counter-test: without the sha row (buildx) is red", () => {
  const without = withReplacement(DOCKER, /\n\s*&& echo "\$\{BUILDX_SHA256\}  \/usr\/libexec\/docker\/cli-plugins\/docker-buildx" \| sha256sum -c - \\/, "");
  assert.throws(() => checkDockerfile(without), /docker-buildx without sha256sum -c/);
});

test("counter-test: npm -g in projectbox is red", () => {
  const including = withReplacement(DOCKER, "FROM base AS projectbox\n", "FROM base AS projectbox\nRUN npm install -g @go-task/cli\n");
  assert.throws(() => checkDockerfile(including), /projectbox installs globally via npm/);
});

test("counter-test: a second Claude pin with another version is red (readCliPins: several times)", () => {
  const including = withReplacement(DOCKER, "FROM base AS backend\n", "FROM base AS backend\nRUN npm install -g @anthropic-ai/claude-code@2.1.1\n");
  assert.throws(() => readCliPins(including), (e) => e instanceof PinError && /several times/.test(e.message));
  assert.throws(() => checkDockerfile(including), PinError);
});

test("counter-test: a second apt row with docker.io is red", () => {
  const including = withReplacement(DOCKER, "FROM base AS projectbox\n", "FROM base AS projectbox\nRUN apt-get update && apt-get install -y docker.io\n");
  assert.throws(() => checkDockerfile(including), /exactly one apt row/);
});

test("counter-test: backend from projectbox instead of base is red (lsof in the user container)", () => {
  const including = withReplacement(DOCKER, "FROM base AS backend\n", "FROM projectbox AS backend\n");
  assert.throws(() => checkDockerfile(including), /backend does not inherit from base/);
});

test("counter-test: the login ENV in backend instead of base is red", () => {
  let including = withReplacement(DOCKER, /^ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=\/home\/agent\/\.claude-login\n/m, "");
  // The last line of the ENV block of backend (the Playwright cache of B).
  including = withReplacement(including, "    PLAYWRIGHT_BROWSERS_PATH=/home/agent/.cache/cbase-b/ms-playwright\n", "    PLAYWRIGHT_BROWSERS_PATH=/home/agent/.cache/cbase-b/ms-playwright \\\n    CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login\n");
  assert.throws(() => checkDockerfile(including), /login directory belongs in base/);
});

test("counter-test: ENV HOME before the npm install is red", () => {
  const including = withReplacement(DOCKER, "FROM base AS backend\n", "FROM base AS backend\nENV HOME=/home/agent\n");
  assert.throws(() => checkDockerfile(including), /ENV HOME stands before an npm install/);
});

test("counter-test: /usr/local, /app or COPY electron in projectbox are red", () => {
  for (const [row, pattern] of [
    ["RUN touch /usr/local/bin/x", /\/usr\/local/],
    ["WORKDIR /app", /\/app/],
    ["COPY electron ./electron", /copies electron/],
  ]) {
    const including = withReplacement(DOCKER, "FROM base AS projectbox\n", `FROM base AS projectbox\n${row}\n`);
    assert.throws(() => checkDockerfile(including), pattern, row);
  }
});

test("counter-test: the state BEFORE_ST2_0 is red — no LIBMOUNT_FORCE_MOUNT2, no cbase-clone", () => {
  const a = beforeSt20();
  assert.deepEqual(instructionsWith(a, "cbase-clone"), [], "the rebuilt file is not the state BEFORE_ST2_0");
  assert.throws(() => checkDockerfile(a), /LIBMOUNT_FORCE_MOUNT2/);
});

test("counter-test: LIBMOUNT_FORCE_MOUNT2 in base or gone, cbase-clone in projectbox, a backend without the python3 run — each red", () => {
  const inBase = withReplacement(withReplacement(DOCKER, /^ENV LIBMOUNT_FORCE_MOUNT2=always\n/m, ""),
    "ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login\n", "ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login\nENV LIBMOUNT_FORCE_MOUNT2=always\n");
  assert.throws(() => checkDockerfile(inBase), /LIBMOUNT_FORCE_MOUNT2/);
  const without = withReplacement(DOCKER, /^ENV LIBMOUNT_FORCE_MOUNT2=always\n/m, "");
  assert.throws(() => checkDockerfile(without), /LIBMOUNT_FORCE_MOUNT2/);
  // Into the project box (via ADD under /usr/sbin, so that neither the /usr/local rule nor the COPY list of the project box
  // bites first) — red through the clone-program check alone.
  const inPb = withReplacement(DOCKER, "FROM base AS projectbox\n", "FROM base AS projectbox\nADD cbase-clone /usr/sbin/cbase-clone\n");
  assert.throws(() => checkDockerfile(inPb), /never in projectbox/);
  const withoutRun = withReplacement(DOCKER, ` && python3 ${CLONE_IN_BACKEND} --help >/dev/null\n`, "\n");
  assert.throws(() => checkDockerfile(withoutRun), /without chmod 755 and without a run under python3/);
});

// ── git-lfs in the project box, the LFS helper in the backend ──

// The LFS block of the stage projectbox (RUN with git-lfs up to ENV GIT_LFS_SKIP_SMUDGE=1) — for the counter-test "in base".
const LFS_BLOCK = /^RUN apt-get update && apt-get install -y --no-install-recommends git-lfs \\\n(?:.*\\\n)*.*\nENV GIT_LFS_SKIP_SMUDGE=1\n/m;

test("counter-test: the state BEFORE_AN_1 is red — no git-lfs, no helper", () => {
  const a = beforeAn1();
  assert.deepEqual([...instructionsWith(a, "git-lfs"), ...instructionsWith(a, "cbase-lfs-access")], [], "the rebuilt file is not the state BEFORE_AN_1");
  assert.throws(() => checkDockerfile(a), /git-lfs not exactly once via apt in projectbox/);
});

test("counter-test: the LFS block in base instead of projectbox (B would get git-lfs and the system-wide helper) is red", () => {
  const block = (DOCKER.match(LFS_BLOCK) || [])[0];
  assert.ok(block, "the LFS block no longer has the expected form — the counter-test does not bite");
  const inBase = withReplacement(withReplacement(DOCKER, block, ""),
    "ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login\n", `ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login\n${block}`);
  assert.throws(() => checkDockerfile(inBase), /git-lfs not exactly once via apt in projectbox/);
  // Every line alone in base (the others stay in projectbox): each is red on its own.
  for (const [row, pattern] of [
    ["RUN git config --system credential.useHttpPath true", /\/etc\/gitconfig/],
    ["ENV GIT_LFS_SKIP_SMUDGE=1", /GIT_LFS_SKIP_SMUDGE not exactly once in projectbox/],
    ["RUN git lfs install --system", /git lfs install not exactly once in projectbox/],
  ]) {
    const including = withReplacement(DOCKER, "ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login\n", `ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login\n${row}\n`);
    assert.throws(() => checkDockerfile(including), pattern, row);
  }
});

test("counter-test: --skip-smudge is red — the agent shells could not switch smudge on", () => {
  const including = withReplacement(DOCKER, "&& git lfs install --system \\", "&& git lfs install --system --skip-smudge \\");
  assert.throws(() => checkDockerfile(including), /--skip-smudge/);
  // The probe in the build that demands the filter without `--skip` must not be missing either.
  const withoutProbe = withReplacement(DOCKER, '    && test "$(git config --system --get filter.lfs.process)" = "git-lfs filter-process" \\\n', "");
  assert.throws(() => checkDockerfile(withoutProbe), /does not check the filter/);
});

test("counter-test: without ENV GIT_LFS_SKIP_SMUDGE, without useHttpPath, with a second helper, with another helper path — each red", () => {
  const withoutEnv = withReplacement(DOCKER, /^ENV GIT_LFS_SKIP_SMUDGE=1\n/m, "");
  assert.throws(() => checkDockerfile(withoutEnv), /GIT_LFS_SKIP_SMUDGE not exactly once/);
  const withoutHttpPath = withReplacement(DOCKER, "    && git config --system credential.useHttpPath true \\\n", "");
  assert.throws(() => checkDockerfile(withoutHttpPath), /\/etc\/gitconfig/);
  const second = withReplacement(DOCKER, "    && git config --system credential.useHttpPath true \\\n", "    && git config --system credential.useHttpPath true \\\n    && git config --system --add credential.helper store \\\n");
  assert.throws(() => checkDockerfile(second), /\/etc\/gitconfig/);
  const other = withReplacement(DOCKER, `&& git config --system credential.helper ${LFS_HELPER_IN_BACKEND} \\`, "&& git config --system credential.helper /usr/sbin/cbase-lfs-access \\");
  assert.throws(() => checkDockerfile(other), /\/etc\/gitconfig/);
});

test("counter-test: cbase-lfs-access in projectbox, written to /usr/local in projectbox, a backend without the silent request — each red", () => {
  // Via ADD under /usr/sbin, so that neither the /usr/local rule nor the COPY list of the project box bites first.
  const inPb = withReplacement(DOCKER, "FROM base AS projectbox\n", "FROM base AS projectbox\nADD cbase-lfs-access /usr/sbin/cbase-lfs-access\n");
  assert.throws(() => checkDockerfile(inPb), /cbase-lfs-access not exactly once to \/usr\/local\/bin in the backend/);
  // The exception of the /usr/local rule applies only to NAMING the helper, never to writing to its path.
  const writes = withReplacement(DOCKER, "FROM base AS projectbox\n", `FROM base AS projectbox\nRUN touch ${LFS_HELPER_IN_BACKEND}\n`);
  assert.throws(() => checkDockerfile(writes), /projectbox writes under \/usr\/local/);
  const withoutRequest = withReplacement(DOCKER, ` \\\n    && test -z "$(printf 'protocol=https\\nhost=h\\npath=o/r.git/info/lfs\\n\\n' | ${LFS_HELPER_IN_BACKEND} get 2>&1)"\n`, "\n");
  assert.throws(() => checkDockerfile(withoutRequest), /without the silent LFS request/);
});

// The start probe in every B (lib/projectbox-distribution.mjs) asks `git lfs version` and the helper — in the prepare step as in
// the single probe, both via `dx`. The BEHAVIOR (both or none, else EXIT.LFS) runs in projectbox-distribution.test.mjs against
// the fake docker.
const startProbeAsksLfs = (script) => script.includes('lfs=$(dx docker exec "$pid" git lfs version 2>&1)')
  && script.includes('hf=$(dx docker exec "$pid" git config --system --get-all credential.helper 2>&1)')
  && script.includes(`[ "$hf" = "${LFS_HELPER_IN_BACKEND}" ]`);

test("the start probe contains `git lfs version` and `git config --system --get-all credential.helper` against LFS_HELPER_IM_BACKEND — counter-test: red without the lines", () => {
  const b = "cbase-u-abc";
  const scripts = [probeScript({ container: b, ref: "cbase-projectbox:cand-1" }), prepareScript({ container: b, cand: "cbase-projectbox:cand-1", hostId: `sha256:${"a".repeat(64)}` })];
  for (const s of scripts) assert.equal(startProbeAsksLfs(s), true, s.slice(-1500));
  const without = scripts[0].split("\n").filter((z) => !z.includes("git lfs version")).join("\n");
  assert.equal(startProbeAsksLfs(without), false);
});

test("the parser: continuations, comments in continuations, FROM … AS, ENV of both forms", () => {
  const t = "# Head\nFROM a:1 AS one\nRUN x \\\n# middle\n    && y\nENV A=1 B=2\nENV C 3 4\nFROM --platform=linux/amd64 one AS two\nARG V=v1.2.3\n";
  assert.deepEqual(dockerfileInstructions(t).map((a) => [a.op, a.arg, a.row]), [
    ["FROM", "a:1 AS one", 2], ["RUN", "x && y", 3], ["ENV", "A=1 B=2", 6], ["ENV", "C 3 4", 7],
    ["FROM", "--platform=linux/amd64 one AS two", 8], ["ARG", "V=v1.2.3", 9],
  ]);
  const st = dockerfileStages(t);
  assert.deepEqual(st.map((s) => [s.name, s.from]), [["one", "a:1"], ["two", "one"]]);
  assert.deepEqual(stagesEnv(st, "two"), { A: "1", B: "2", C: "3 4" });
  assert.deepEqual(envPairs("X=1"), [["X", "1"]]);
});

// ── Build and host probe ────────────────

test("candidate, build command and probe text: --target projectbox on the context of the backend build, probe without network", () => {
  assert.equal(projectboxCand("20260928-1", "cbase-projectbox"), "cbase-projectbox:cand-20260928-1");
  assert.equal(
    projectboxBuildCommand({ root: "/r", release: "20260928-1", cand: "cbase-projectbox:cand-20260928-1" }),
    "cd /r && docker build --target projectbox -t cbase-projectbox:cand-20260928-1 -f releases/20260928-1/backend/Dockerfile releases/20260928-1/backend",
  );
  const probe = projectboxHostProbe("cbase-projectbox:cand-x");
  assert.match(probe, /^docker image inspect --format 'entrypoint=\{\{json \.Config\.Entrypoint\}\}\{\{"\\n"\}\}user=\{\{\.Config\.User\}\}\{\{"\\n"\}\}labels=\{\{json \.Config\.Labels\}\}' cbase-projectbox:cand-x \|\| echo entrypoint=MISSING$/m);
  // With a source the label after `-t`; a source that is no sha256 throws.
  assert.equal(
    projectboxBuildCommand({ root: "/r", release: "20260928-1", cand: "cbase-projectbox:cand-20260928-1", source: "f".repeat(64) }),
    `cd /r && docker build --target projectbox -t cbase-projectbox:cand-20260928-1 --label cbase.projectbox.source=${"f".repeat(64)} -f releases/20260928-1/backend/Dockerfile releases/20260928-1/backend`,
  );
  assert.throws(() => projectboxBuildCommand({ root: "/r", release: "R", cand: "c", source: "x; rm -rf /" }), /no source/);
  assert.match(probe, /^docker run --rm -i --network none --entrypoint sh cbase-projectbox:cand-x -s <<'HEXEOF' \|\| true$/m);
  assert.ok(probe.endsWith("\nHEXEOF"), "the heredoc is not closed");
  assert.ok(!/\bdocker (?:run|exec)\b[^\n]*(?:-p |--publish|--privileged|-v )/.test(probe), "the probe publishes, binds or privileges something");
});

// The inner part really runs here — under /bin/sh and /bin/dash, with a fake docker that only names versions (the PATH reaches no
// real docker). On the Mac almost everything is missing: then every line still stands exactly once.
for (const shell of ["/bin/sh", "/bin/dash"]) {
  test(`${shell}: the inner part of the probe writes every line exactly once, even if everything is missing`, () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-pbprobe-"));
    try {
      fs.writeFileSync(path.join(d, "docker"), [
        "#!/bin/sh",
        'case "$1 $2" in',
        '  "compose version") echo "Docker Compose version v5.3.1";;',
        '  "buildx version") echo "github.com/docker/buildx v0.35.0 1a2b3c";;',
        "  *) exit 1;;",
        "esac",
        "",
      ].join("\n"), { mode: 0o755 });
      const r = spawnSync(shell, ["-s"], { input: PROBE_INSIDE, encoding: "utf8", env: { PATH: `${d}:/usr/bin:/bin`, CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/agent/.claude-login", LIBMOUNT_FORCE_MOUNT2: "always" } });
      assert.equal(r.stderr, "", r.stderr);
      const key = r.stdout.split("\n").filter(Boolean).map((z) => z.slice(0, z.indexOf("=")));
      const expected = [...PROBE_COMMANDS.map((b) => `bin.${b}`), "entry", "wrapper", ...PROBE_FILES.map((f) => `sha.${f}`), "compose", "buildx", "app", "cli", "agent.uid", "agent.docker", "yarn", "login", "libmount"];
      assert.deepEqual(key, expected);
      const u = projectboxVerdict(`entrypoint=${JSON.stringify(ENTRYPOINT)}\nuser=\n${r.stdout}`, readProjectboxExpectation(DOCKER));
      const row = (what) => u.rows.find((z) => z[0] === what);
      assert.equal(row("docker compose v5.3.1")?.[2], "ok");
      assert.equal(row("docker buildx v0.35.0")?.[2], "ok");
      assert.equal(row("CLAUDE_SECURESTORAGE_CONFIG_DIR")?.[2], "ok");
      assert.equal(row("LIBMOUNT_FORCE_MOUNT2 (always)")?.[2], "ok");
      assert.equal(row("Wrapper (perl -c)")?.[2], "bad", "on the Mac there is no wrapper under /usr/sbin");
      assert.equal(u.ok, false);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
}

const GUT = [
  `entrypoint=${JSON.stringify(ENTRYPOINT)}`,
  "user=",
  "bin.tini=/usr/bin/tini", "bin.dockerd=/usr/sbin/dockerd", "bin.docker=/usr/bin/docker", "bin.lsof=/usr/bin/lsof",
  "bin.ip=/usr/bin/ip", "bin.iptables=/usr/sbin/iptables", "bin.perl=/usr/bin/perl", "bin.python3=/usr/bin/python3",
  "bin.setsid=/usr/bin/setsid", "bin.bash=/usr/bin/bash", "bin.mount=/usr/bin/mount", "bin.mountpoint=/usr/bin/mountpoint",
  "bin.umount=/usr/bin/umount",
  "entry=ok", "wrapper=ok",
  "compose=Docker Compose version v5.3.1", "buildx=github.com/docker/buildx v0.35.0 3f2b1c0",
  "app=absent", "cli=absent", "agent.uid=1001", "agent.docker=yes", "yarn=ok", "login=/home/agent/.claude-login", "libmount=always",
].join("\n");

test("the verdict: a good output is ok, every single deviation and every missing line is bad", () => {
  const wanted = readProjectboxExpectation(DOCKER);
  assert.deepEqual(wanted, { compose: "v5.3.1", buildx: "v0.35.0", login: "/home/agent/.claude-login", libmount: "always" });
  const good = projectboxVerdict(GUT, wanted);
  assert.equal(good.ok, true, JSON.stringify(good.rows.filter((z) => z[2] !== "ok")));
  for (const [from, to] of [
    [/^entrypoint=.*$/m, `entrypoint=${JSON.stringify(["/usr/bin/tini", "--", "/entry.sh"])}`],
    ["user=", "user=agent"],
    ["bin.tini=/usr/bin/tini", "bin.tini=/usr/sbin/tini"],
    ["bin.lsof=/usr/bin/lsof", "bin.lsof=MISSING"],
    ["bin.ip=/usr/bin/ip", "bin.ip=MISSING"],
    ["bin.perl=/usr/bin/perl", "bin.perl=MISSING"],
    ["entry=ok", "entry=MISSING"],
    ["wrapper=ok", "wrapper=MISSING"],
    ["v5.3.1", "v2.29.1"],
    ["buildx=github.com/docker/buildx v0.35.0 3f2b1c0", "buildx="],
    ["app=absent", "app=present"],
    ["cli=absent", "cli=present"],
    ["agent.uid=1001", "agent.uid="],
    ["agent.docker=yes", "agent.docker=no"],
    ["yarn=ok", "yarn=MISSING"],
    ["login=/home/agent/.claude-login", "login="],
    ["bin.mount=/usr/bin/mount", "bin.mount=MISSING"],
    ["bin.mountpoint=/usr/bin/mountpoint", "bin.mountpoint=MISSING"],
    ["bin.umount=/usr/bin/umount", "bin.umount=MISSING"],
    ["libmount=always", "libmount="],
    ["libmount=always", "libmount=never"],
  ]) {
    const text = withReplacement(GUT, from, to);
    assert.equal(projectboxVerdict(text, wanted).ok, false, `${to} went unnoticed`);
  }
  for (const z of GUT.split("\n")) {
    const without = GUT.split("\n").filter((x) => x !== z).join("\n");
    assert.equal(projectboxVerdict(without, wanted).ok, false, `missing line "${z}" went unnoticed`);
  }
  assert.equal(projectboxVerdict("", wanted).ok, false);
  // A release before the clone program (the rollback checks against ITS Dockerfile): it expects the variable unset — with it set it is red.
  const expectedOld = readProjectboxExpectation(beforeSt20());
  assert.equal(expectedOld.libmount, "");
  assert.equal(projectboxVerdict(GUT.replace("libmount=always", "libmount="), expectedOld).ok, true);
  assert.equal(projectboxVerdict(GUT, expectedOld).ok, false);
});

test("the expectation comes from the Dockerfile: a missing plugin version or login ENV is an error", () => {
  assert.throws(() => readProjectboxExpectation(withReplacement(DOCKER, /^ARG BUILDX_VERSION=.*\n/m, "")), /BUILDX_VERSION/);
  assert.throws(() => readProjectboxExpectation(withReplacement(DOCKER, /^ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=.*\n/m, "")), /CLAUDE_SECURESTORAGE_CONFIG_DIR/);
  assert.throws(() => readProjectboxExpectation(old()), /no stage/);
});

test("the build context: every file of the project box lies in server/backend/, is executable and build.sh builds the project box", () => {
  for (const f of PROJECTBOX_FILES) {
    const p = path.join(REPO, "server/backend", f);
    assert.ok(fs.existsSync(p), `${f} fehlt`);
    assert.equal(fs.statSync(p).mode & 0o111, 0o111, `${f} is not executable`);
  }
  // The upload loop of targets/server.mjs walks the product list (server/backend/build-context-files.json); the list itself is bound to
  // build.sh by server/backend/test/build-context.test.js. Here (deploy side): the list holds the project box files, and the loop reads it.
  const list = JSON.parse(fs.readFileSync(path.join(REPO, "server/backend/build-context-files.json"), "utf8")).files;
  assert.equal(BUILD_CONTEXT_FILES.join(), list.join(), "lib/build-context.mjs does not read the product list");
  for (const f of PROJECTBOX_FILES) assert.ok(list.includes(f), `${f} is not in build-context-files.json`);
  assert.equal(fs.statSync(path.join(REPO, "server/backend/cbase-clone")).mode & 0o111, 0o111, "cbase-clone is not executable");
  const build = fs.readFileSync(path.join(REPO, "server/backend/build.sh"), "utf8");
  assert.equal(fs.statSync(path.join(REPO, "server/backend/cbase-lfs-access")).mode & 0o111, 0o111, "cbase-lfs-access is not executable");
  assert.match(build, /docker build --target projectbox -t "\$PROJECTBOX"/);
  assert.match(build, /^docker build -t "\$IMAGE" -f Dockerfile "\$CTX"$/m, "build.sh no longer builds the backend without --target");
});


// ── The source of the project box ──

test("projectboxSource: stable; changes with a file, an instruction of base or projectbox — not with backend", () => {
  const hash = (contents) => (rel) => {
    assert.ok(rel in contents, `unexpected file ${rel}`);
    return (contents[rel] + "0".repeat(64)).slice(0, 64);
  };
  const files = Object.fromEntries(projectboxSourceFiles(DOCKER).map((d, i) => [d, String(i + 1).repeat(64)]));
  const q = projectboxSource(DOCKER, hash(files));
  assert.match(q, /^[0-9a-f]{64}$/);
  assert.equal(projectboxSource(DOCKER, hash(files)), q, "not stable");
  // The file list comes from the Dockerfile and matches the one that goes into the context (no second list that ages).
  assert.deepEqual([...projectboxSourceFiles(DOCKER)].sort(), [...PROJECTBOX_FILES].sort());
  for (const d of Object.keys(files)) assert.notEqual(projectboxSource(DOCKER, hash({ ...files, [d]: "a".repeat(64) })), q, `${d} changed, source equal`);
  // One more instruction right after the FROM of the stage (the first line of a continuation does not stand literally in the text).
  const withRow = (header) => {
    const re = new RegExp(`^(${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n)`, "m");
    const fresh = DOCKER.replace(re, "$1ENV CBASE_SOURCE_PROBE=1\n");
    assert.notEqual(fresh, DOCKER, `"${header}" does not stand as a line`);
    return fresh;
  };
  for (const header of ["FROM node:22-bookworm-slim AS base", `FROM base AS ${PROJECTBOX_STAGE}`]) {
    assert.notEqual(projectboxSource(withRow(header), hash(files)), q, `${header}: instruction added, source equal`);
  }
  assert.equal(projectboxSource(withRow(`FROM base AS ${BACKEND_STAGE}`), hash(files)), q, "a change in backend changed the source of the project box");
  assert.notEqual(projectboxSource(DOCKER.replace("FROM node:22-bookworm-slim AS base", "FROM node:24-bookworm-slim AS base"), hash(files)), q, "another base image, source equal");
  // A new COPY line in projectbox counts its file — without an entry anywhere else.
  const fresh = DOCKER.replace(/^(FROM base AS projectbox\n)/m, "$1COPY new.sh /usr/sbin/new\n");
  assert.notEqual(fresh, DOCKER, "the stage projectbox does not stand as \"FROM base AS projectbox\"");
  assert.ok(projectboxSourceFiles(fresh).includes("new.sh"));
  assert.throws(() => projectboxSource(fresh, hash(files)), /unexpected file new\.sh/);
});

test("copySources: simple paths; --from counts only as text; patterns, absolute paths, .., URL and JSON form throw", () => {
  assert.deepEqual(copySources("a.sh /usr/bin/a"), ["a.sh"]);
  assert.deepEqual(copySources("--chmod=755 a b /target/"), ["a", "b"]);
  assert.deepEqual(copySources("--from=builder /x /y"), []);
  for (const t of ["*.sh /z", "/etc/passwd /z", "../x /z", "a/../../x /z", "https://example.com/x /z", '["a", "/z"]', "only-one"]) {
    assert.throws(() => copySources(t), Error, t);
  }
});

test("projectboxVerdict: with an expected source the label must carry it — if it is missing or deviates, the probe is red", () => {
  const q = "7".repeat(64);
  const wanted = { ...readProjectboxExpectation(DOCKER), source: q };
  const rest = [
    ...PROBE_COMMANDS.map((b) => `bin.${b}=${b === "tini" ? ENTRYPOINT[0] : `/usr/bin/${b}`}`),
    "entry=ok", "wrapper=ok", `compose=Docker Compose version ${wanted.compose}`, `buildx=github.com/docker/buildx ${wanted.buildx} x`,
    "app=absent", "cli=absent", "agent.uid=1001", "agent.docker=yes", "yarn=ok", `login=${wanted.login}`, `libmount=${wanted.libmount}`,
  ];
  const including = (labels) => [`entrypoint=${JSON.stringify(ENTRYPOINT)}`, "user=", `labels=${labels}`, ...rest].join("\n");
  assert.equal(projectboxVerdict(including(JSON.stringify({ [SOURCE_LABEL]: q })), wanted).ok, true);
  for (const l of ["null", JSON.stringify({ [SOURCE_LABEL]: "8".repeat(64) }), JSON.stringify({ other: q }), "broken"]) {
    assert.equal(projectboxVerdict(including(l), wanted).ok, false, `label ${l} went unnoticed`);
  }
  assert.equal(projectboxVerdict([`entrypoint=${JSON.stringify(ENTRYPOINT)}`, "user=", ...rest].join("\n"), wanted).ok, false, "missing labels row");
  // Without an expected source (rollback rebuild of a release before the label) no row.
  assert.equal(projectboxVerdict(including("null"), readProjectboxExpectation(DOCKER)).rows.some((z) => z[0].includes(SOURCE_LABEL)), false);
});

// ── The source against the bytes it is built from ──

test("projectboxImageFiles/projectboxFileExpectation: entry and wrapper from the same Dockerfile; a missing or doubled COPY row throws", () => {
  assert.deepEqual(projectboxImageFiles(DOCKER), [
    { source: "projectbox-entry.sh", target: ENTRY_IN_IMAGE },
    { source: "cbase-wrapper", target: WRAPPER_IN_IMAGE },
  ]);
  assert.deepEqual(PROBE_FILES, [ENTRY_IN_IMAGE, WRAPPER_IN_IMAGE]);
  const h = (rel) => (rel === "cbase-wrapper" ? "1" : "2").repeat(64);
  assert.deepEqual(projectboxFileExpectation(DOCKER, h), { [ENTRY_IN_IMAGE]: "2".repeat(64), [WRAPPER_IN_IMAGE]: "1".repeat(64) });
  const without = DOCKER.replace(`COPY cbase-wrapper ${WRAPPER_IN_IMAGE}\n`, "");
  assert.notEqual(without, DOCKER);
  assert.throws(() => projectboxFileExpectation(without, h), /no COPY instruction to \/usr\/sbin\/cbase-wrapper/);
  const duplicate = DOCKER.replace(`COPY cbase-wrapper ${WRAPPER_IN_IMAGE}\n`, `COPY cbase-wrapper ${WRAPPER_IN_IMAGE}\nCOPY cbase-wrapper ${WRAPPER_IN_IMAGE}\n`);
  assert.throws(() => projectboxFileExpectation(duplicate, h), /more than one/);
  assert.throws(() => projectboxFileExpectation(DOCKER, () => "no-sha"), /no sha256/);
});

test("projectboxVerdict: with expected bytes entry and wrapper in the image must carry exactly them — deviating or without a row is red; without expectation no row", () => {
  const wanted = readProjectboxExpectation(DOCKER);
  const files = { [ENTRY_IN_IMAGE]: "3".repeat(64), [WRAPPER_IN_IMAGE]: "4".repeat(64) };
  const rows = (e, h) => `${GUT}\nsha.${ENTRY_IN_IMAGE}=${e}\nsha.${WRAPPER_IN_IMAGE}=${h}`;
  assert.equal(projectboxVerdict(rows("3".repeat(64), "4".repeat(64)), { ...wanted, files }).ok, true);
  for (const [e, h] of [["3".repeat(64), "5".repeat(64)], ["5".repeat(64), "4".repeat(64)], ["MISSING", "4".repeat(64)], ["3".repeat(64), ""]]) {
    assert.equal(projectboxVerdict(rows(e, h), { ...wanted, files }).ok, false, `${e.slice(0, 5)} / ${h.slice(0, 5)} went unnoticed`);
  }
  assert.equal(projectboxVerdict(GUT, { ...wanted, files }).ok, false, "fehlende sha-Rows");
  assert.equal(projectboxVerdict(GUT, wanted).rows.some((z) => z[0].includes("sha256")), false, "a row without expectation");
});


// ── Package caches of B, the git folder of the runs in B, go-task pinned ──
// The backend stage sets the four package caches of B under /home/agent/<B_CACHE_FOLDER> (projectbox/creation.js), AFTER the
//   last npm install (else root would put its cache there); base and projectbox set none (in the project container the
//   defaults = the shared caches). That no writable mount lies there is held by server/backend/test/projectbox-creation.test.js
//   against the same values.
// GIT_WRAPPER_FOLDER (runtime/inProject.js) is created, the `git` in it calls /usr/bin/cbase-git with CBASE_GIT_BIN=/usr/bin/git
//   (else the wrapper would call itself via PATH) — and only in backend.
// Every `npm install -g` of the backend stage names a @<version> per package.
// COUNTER-TESTS (built in): the state before that (BEFORE_WAVE_1, d1633595 — rebuilt from today's file: without the four cache
// ENV lines, without the git folder, go-task unpinned) is red in all three.
const beforeWave1 = () => withReplacement(withReplacement(withReplacement(DOCKER,
  /( {4}CBASE_VSCODE_TUNNEL=1) \\\n {4}npm_config_cache=[^\n]*\n {4}UV_CACHE_DIR=[^\n]*\n {4}PIP_CACHE_DIR=[^\n]*\n {4}PLAYWRIGHT_BROWSERS_PATH=[^\n\\]*\n/, "$1\n"),
  /^RUN mkdir -p \/usr\/lib\/cbase\/git-path \\\n(?: {4}[^\n]*\\\n)* {4}[^\n]*\n/m, ""),
  /@go-task\/cli@\d+\.\d+\.\d+/, "@go-task/cli");
const B_CACHE_ENV = ["npm_config_cache", "UV_CACHE_DIR", "PIP_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH"];
const { B_CACHE_FOLDER } = await import(new URL("../../server/backend/electron/server/projectbox/creation.js", import.meta.url).href);
const { B_OWN_ENV, GIT_WRAPPER_FOLDER } = await import(new URL("../../server/backend/electron/server/runtime/inProject.js", import.meta.url).href);

function checkBCaches(text) {
  const st = dockerfileStages(text);
  const env = stagesEnv(st, BACKEND_STAGE);
  const root = path.posix.join("/home/agent", B_CACHE_FOLDER);
  for (const k of B_CACHE_ENV) {
    assert.ok(env[k], `${k} is missing in the backend stage`);
    assert.ok(env[k].startsWith(`${root}/`), `${k}=${env[k]} does not lie under ${root}`);
  }
  for (const s of ["base", PROJECTBOX_STAGE]) for (const k of B_CACHE_ENV) assert.equal(stagesEnv(st, s)[k], undefined, `${k} in ${s}`);
  const chain = stagesChain(st, BACKEND_STAGE).flatMap((s) => s.instructions);
  const iNpm = chain.map((a) => a.op === "RUN" && /\bnpm\s+install\b/.test(a.arg)).lastIndexOf(true);
  for (const k of B_CACHE_ENV) {
    const i = chain.findIndex((a) => a.op === "ENV" && envPairs(a.arg).some(([n]) => n === k));
    assert.ok(i > iNpm, `${k} stands before an npm install`);
  }
}
function checkGitFolder(text) {
  const st = dockerfileStages(text);
  const rows = (s) => st.find((x) => x.name === s).instructions.filter((a) => a.op === "RUN" && a.arg.includes(GIT_WRAPPER_FOLDER));
  assert.equal(rows("base").length + rows(PROJECTBOX_STAGE).length, 0, "the git folder belongs only in backend");
  // It is created by exactly one line; also mentioned by the profile.d line after it (test below).
  const r = rows(BACKEND_STAGE).filter((a) => a.arg.includes(`mkdir -p ${GIT_WRAPPER_FOLDER}`));
  assert.equal(r.length, 1, `the git folder is not created by exactly one line: ${r.length}`);
  assert.ok(r[0].arg.includes(`mkdir -p ${GIT_WRAPPER_FOLDER}`));
  assert.ok(r[0].arg.includes(`CBASE_GIT_BIN=/usr/bin/git exec /usr/bin/cbase-git "$@"`), "git in the folder does not call cbase-git with a fixed git");
  assert.ok(r[0].arg.includes(`> ${GIT_WRAPPER_FOLDER}/git`) && r[0].arg.includes(`chmod 755 ${GIT_WRAPPER_FOLDER}/git`));
  const iWrapper = st.find((x) => x.name === BACKEND_STAGE).instructions.findIndex((a) => a.op === "COPY" && a.arg === "cbase-git /usr/bin/cbase-git");
  assert.ok(iWrapper >= 0 && st.find((x) => x.name === BACKEND_STAGE).instructions.indexOf(r[0]) > iWrapper, "the git folder stands before the wrapper");
}
function checkNpmPins(text) {
  const backend = dockerfileStages(text).find((s) => s.name === BACKEND_STAGE);
  const rows = backend.instructions.filter((a) => a.op === "RUN" && NPM_G.test(a.arg));
  assert.ok(rows.length >= 2, "no global npm install found");
  for (const a of rows) {
    for (const part of a.arg.split(/&&|;/).filter((t) => NPM_G.test(t))) {
      const packages = part.trim().split(/\s+/).slice(2).filter((w) => !w.startsWith("-"));
      assert.ok(packages.length, part);
      for (const p of packages) assert.match(p, /^(@[^/@\s]+\/)?[^@\s]+@\d+\.\d+\.\d+$/, `unpinned in backend: ${p} (row ${a.row})`);
    }
  }
}

test("package caches: the backend stage sets the four package caches of B under B_CACHE_FOLDER, after every npm install; the names are B_OWN_ENV", () => {
  checkBCaches(DOCKER);
  assert.deepEqual([...B_OWN_ENV].sort(), [...B_CACHE_ENV].sort(), "runtime/inProject.js filters other names than the Dockerfile sets");
  assert.throws(() => checkBCaches(beforeWave1()), assert.AssertionError, "counter-test: the state BEFORE_WAVE_1 is not red");
});

test("git folder of the runs in B (GIT_WRAPPER_FOLDER) is created, its git calls cbase-git with a fixed git", () => {
  checkGitFolder(DOCKER);
  assert.throws(() => checkGitFolder(beforeWave1()), assert.AssertionError, "counter-test: the state BEFORE_WAVE_1 is not red");
  assert.throws(() => checkGitFolder(withReplacement(DOCKER, "CBASE_GIT_BIN=/usr/bin/git exec", "exec")), assert.AssertionError);
});

// A LOGIN shell in B (the `exec_command` of Codex 0.15x) resets the PATH via /etc/profile — Debian replaces it entirely for non-root, the
// git folder dropped out. The backend stage therefore creates /etc/profile.d/cbase-git-path.sh (its own line right after that of the
// folder): only with the operation mark, only if the folder is not already in front, in front again. The script is checked as the
// Dockerfile writes it, under sh and dash BEHIND a rebuilt /etc/profile (PATH reset, then profile.d) — and that the build runs the
// two probes with a real login shell.
// COUNTER-TESTS (built in): the state before it is red; without the check of the mark it is red; without the check "already in
// front" it is red (the folder twice).
// The state before it (516ad453, rebuilt from today's file): the backend stage without the profile.d line.
function beforeFollowUpFindingA3() {
  const found = instructionsWith(DOCKER, PROFILE_D);
  assert.equal(found.length, 1, "the profile.d line has moved — the counter-test does not bite");
  const rows = DOCKER.split("\n");
  let end = found[0].row - 1;
  while (rows[end].trimEnd().endsWith("\\")) end++;
  return [...rows.slice(0, found[0].row - 1), ...rows.slice(end + 1)].join("\n");
}
const PROFILE_D = "/etc/profile.d/cbase-git-path.sh";
function profileScript(text) {
  const st = dockerfileStages(text);
  const rows = (s) => st.find((x) => x.name === s).instructions.filter((a) => a.op === "RUN" && a.raw.includes(PROFILE_D));
  assert.equal(rows("base").length + rows(PROJECTBOX_STAGE).length, 0, `${PROFILE_D} belongs only in backend`);
  const r = rows(BACKEND_STAGE);
  assert.equal(r.length, 1, `${PROFILE_D} is not created by exactly one line: ${r.length}`);
  // Its own line RIGHT after that of the git folder (which stands literally in cbase-git.test.mjs): the probes need the `git` in the
  // folder, and nothing in between may change PATH or profile.d.
  const backend = st.find((x) => x.name === BACKEND_STAGE).instructions;
  const folderRow = backend.findIndex((a) => a.op === "RUN" && a.raw.includes(`mkdir -p ${GIT_WRAPPER_FOLDER}`));
  assert.equal(backend.indexOf(r[0]), folderRow + 1, `${PROFILE_D} does not stand right after the line of the git folder`);
  const m = r[0].raw.match(new RegExp(`printf '%s\\\\n'((?:\\s+'[^']*')+)\\s*>\\s*${PROFILE_D.replace(/[./]/g, "\\$&")}`));
  assert.ok(m, `${PROFILE_D} is not written with printf '%s\\n' '<line>' …`);
  const script = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join("\n") + "\n";
  assert.ok(r[0].arg.includes(`CBASE_CONTAINER=1 CBASE_DIND=1 bash -lc 'command -v git')" = ${GIT_WRAPPER_FOLDER}/git`), "the build does not check the login shell with the mark");
  assert.ok(r[0].arg.includes(`"$(bash -lc 'command -v git')" = /usr/bin/git`), "the build does not check the login shell without the mark");
  return script;
}
function checkGitProfile(text) {
  const script = profileScript(text);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-profile-d-"));
  try {
    const file = path.join(dir, "cbase-git-path.sh");
    fs.writeFileSync(file, script);
    // Rebuilt Debian /etc/profile for non-root: PATH replaced, exported, then profile.d.
    const login = `PATH="/usr/local/bin:/usr/bin:/bin"; export PATH; . "${file}"; printf %s "$PATH"`;
    const shells = ["/bin/sh", "/bin/dash"].filter((s) => fs.existsSync(s));
    for (const shell of shells) {
      const run = (env, command = login) => {
        const r = spawnSync(shell, ["-c", command], { env, encoding: "utf8" });
        assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
        return r.stdout;
      };
      assert.equal(run({ CBASE_CONTAINER: "1", CBASE_DIND: "1" }), `${GIT_WRAPPER_FOLDER}:/usr/local/bin:/usr/bin:/bin`, `${shell}: with mark not in front`);
      assert.equal(run({}), "/usr/local/bin:/usr/bin:/bin", `${shell}: changed without mark`);
      assert.equal(run({ CBASE_CONTAINER: "1" }), "/usr/local/bin:/usr/bin:/bin", `${shell}: changed with half a mark`);
      const front = `PATH="${GIT_WRAPPER_FOLDER}:/usr/bin:/bin"; export PATH; . "${file}"; printf %s "$PATH"`;
      assert.equal(run({ CBASE_CONTAINER: "1", CBASE_DIND: "1" }, front), `${GIT_WRAPPER_FOLDER}:/usr/bin:/bin`, `${shell}: the folder stands twice`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("/etc/profile.d puts the git folder in front again in a login shell — only with the mark, never twice, only in backend; the build probes it", () => {
  checkGitProfile(DOCKER);
  const prior = beforeFollowUpFindingA3();
  assert.deepEqual(instructionsWith(prior, PROFILE_D), [], "the rebuilt file still writes the profile.d line");
  assert.throws(() => checkGitProfile(prior), assert.AssertionError, "counter-test: the state before it is not red");
  assert.throws(() => checkGitProfile(withReplacement(DOCKER, `'if [ "\${CBASE_CONTAINER:-}" = 1 ] && [ "\${CBASE_DIND:-}" = 1 ]; then'`, "'if true; then'")),
    assert.AssertionError, "counter-test: without the mark is not red");
  assert.throws(() => checkGitProfile(withReplacement(DOCKER, "/usr/lib/cbase/git-path|/usr/lib/cbase/git-path:*) ;; *)", "nie) ;; *)")),
    assert.AssertionError, "counter-test: without the check \"already in front\" is not red");
});

test("every global npm install of the backend stage pins every package (@<version>)", () => {
  checkNpmPins(DOCKER);
  assert.throws(() => checkNpmPins(beforeWave1()), /@go-task\/cli/, "counter-test: the state BEFORE_WAVE_1 (go-task unpinned) is not red");
});

// The DevTools UI of a browser in the project container is delivered by the Chromium of B (server/backend/electron/server/projectbox/devtools-ui.js)
// — it fits only if both carry the same version. By build they do: Chromium comes in EXACTLY ONE line in `base`, both images inherit
// it, B starts it via CBASE_CHROMIUM=/usr/bin/chromium (browser tab in the container and source of the UI via `resolveChromium`), and
// the Playwright MCP of the agents starts the same path in the container (toolchain/playwright.js). A second installation in a
// stage (apt, dpkg, `playwright install`) or another path would turn "fits by build" into "fits by chance" — B would then show only the
// hint "no fitting UI" for every project browser. Counter-tests per case in the test.
const PLAYWRIGHT_JS = path.join(REPO, "server/backend/electron/server/toolchain/playwright.js");
function checkChromiumFromBase(text, playwright = fs.readFileSync(PLAYWRIGHT_JS, "utf8")) {
  const st = dockerfileStages(text);
  const all = st.flatMap((s) => s.instructions.map((a) => ({ ...a, stage: s.name })));
  const installed = all.filter((a) => a.op === "RUN" && /\bchromium\b/.test(a.arg) && /\b(apt-get install|apt install|dpkg -i|playwright install)\b/.test(a.arg));
  assert.deepEqual(installed.map((a) => a.stage), ["base"], "Chromium not exactly once, not in base — the DevTools UI from B would no longer fit the browser in the project container by build");
  assert.match(installed[0].arg, /\bapt-get install\b.*\schromium(\s|$)/, "Chromium is not a package in the apt row of base");
  assert.equal(stagesEnv(st, BACKEND_STAGE).CBASE_CHROMIUM, "/usr/bin/chromium", "B does not start its Chromium from base");
  assert.match(playwright, /executablePath = process\.env\.CBASE_CHROMIUM \|\| "\/usr\/bin\/chromium";/, "the Playwright MCP starts another Chromium in the container");
}

test("Chromium comes exactly once from base, B starts it via CBASE_CHROMIUM, the Playwright MCP the same path — counter-tests each red", () => {
  checkChromiumFromBase(DOCKER);
  const inPb = withReplacement(DOCKER, "FROM base AS projectbox\n", "FROM base AS projectbox\nRUN apt-get update && apt-get install -y --no-install-recommends chromium\n");
  assert.throws(() => checkChromiumFromBase(inPb), /not exactly once/);
  const playwrightInPb = withReplacement(DOCKER, "FROM base AS projectbox\n", "FROM base AS projectbox\nRUN npx playwright install chromium\n");
  assert.throws(() => checkChromiumFromBase(playwrightInPb), /not exactly once/);
  const inBackend = withReplacement(withReplacement(DOCKER, "      chromium fonts-liberation", "      fonts-liberation"),
    "FROM base AS backend\n", "FROM base AS backend\nRUN apt-get update && apt-get install -y chromium\n");
  assert.throws(() => checkChromiumFromBase(inBackend), /not exactly once, not in base/);
  const otherPath = withReplacement(DOCKER, "CBASE_CHROMIUM=/usr/bin/chromium", "CBASE_CHROMIUM=/opt/chrome/chrome");
  assert.throws(() => checkChromiumFromBase(otherPath), /B does not start its Chromium from base/);
  assert.throws(() => checkChromiumFromBase(DOCKER, 'cfg.browser.launchOptions.executablePath = "/home/agent/.cache/ms-playwright/chrome";'), /Playwright MCP/);
});
