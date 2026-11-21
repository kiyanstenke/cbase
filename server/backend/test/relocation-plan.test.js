// Guards of the relocation plan (step 1) and of the two shared leaves: projectbox/relocation/plan.js,
// projectbox/env-key.js, projectbox/compose-config.js. In the gate (macOS, no Docker): everything is pure except realpath
// and the reading of the `.env*` files, both against a real temp tree.
//
// Fixture: a rebuilt stack - Postgres with a named volume inside an anonymous image volume, a one-off container, an
// anonymous /data, a `build:` service on an external network, a service with `${VAR}`, a profile service - WITHOUT
// customer data; plus the neighbour `orbit-2` (prefix without separator).
//
// The promises and their counter-proofs:
//   path  orbit-2 does not move with ORBIT - counter-proof: `startsWith` without separator pulls it in (red).
//   env   no value appears in the output of env-key AND in the whole plan - counter-proof: the same check against an
//         output carrying values fires.
//   kinds every kind the plan reports is in ENTRIES; what a copy cannot carry is only named, the rest holds.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mountRules } from "../electron/server/projectbox/creation.js";
import {
  ComposeConfigError, composeConfig, configHashArgs, configModelArgs, servicesWithEnvFile, dryrunVerdict, upWithoutStartArgs, upDryrunArgs,
} from "../electron/server/projectbox/compose-config.js";
import { SUFFIX_CBASE, SYSTEM_PREFIXES, envKey, readEnvFiles, stageValue } from "../electron/server/projectbox/env-key.js";
import { NAMES_SUFFIX } from "../electron/server/projectbox/names.js";
import { ENTRIES, ACKNOWLEDGEABLE, RATES, planRelocation, portsInCommand, applyReceipts, writeLayerFolder, writeLayerChecksum } from "../electron/server/projectbox/relocation/plan.js";
import * as creation from "../electron/server/projectbox/creation.js";
import * as helper from "../electron/server/projectbox/helper.js";
import * as ownLabels from "../electron/server/projectbox/own-labels.js";
import { dockerfileInstructions, SOURCE_LABEL } from "../../../tools/check/lib/projectbox.mjs";
import { PROBE_LABEL } from "../../../tools/check/lib/projectbox-plan.mjs";

// Does a Dockerfile set a `cbase.` label on the image? Over the logical instructions (continuation lines joined, command
// case-insensitive) - also behind ONBUILD. A plain per-line regex saw neither a label in a continuation line nor a lowercase
// `label` (test "a cbase. label in a continuation line ..." below, with the old regex as built-in counter-proof).
function setsCbaseLabel(text) {
  const carries = (arg) => /(^|\s|")cbase\./.test(arg);
  return dockerfileInstructions(text).some((a) => (a.op === "LABEL" && carries(a.arg)) || (a.op === "ONBUILD" && /^label\s/i.test(a.arg) && carries(a.arg.replace(/^label\s+/i, ""))));
}

// ── The temp tree ────────────────────────────────────────────────────────────────────────────────────────────────

const SECRET = {
  POSTGRES_PASSWORD: "pw-secret-0815",
  DATABASE_URL: "postgresql://user-secret:pa55-secret@localhost:5432/app",
  API_KEY: "sk-secret-4711",
  EXTERNAL: "https://api.secret-company.invalid/v1",
  TOKEN: "tok-secret-quote",
  MULTILINE: "line1\nrow2-secret",
};
// Values that must never appear in an output (pieces of the values included: user, password, host, path).
const DECOY = ["pw-secret-0815", "user-secret", "pa55-secret", "sk-secret-4711", "api.secret-company.invalid", "tok-secret-quote", "row2-secret", "/srv/secret-deposit", "/app/uploads-secret", "logs-secret"];

// The tree stands for a machine's folders (workspace, home, `srv/…` outside every mount) — so it must not lie under a prefix the
// plan reads as the project container's own system (env-key.js SYSTEM_PREFIXES, among them /tmp). On macOS os.tmpdir() is
// /var/folders/…, on Linux /tmp: there every path of the tree counted as "system", and the "outside" cases held nothing (CI red).
const TREE_BASE = (() => {
  const tmp = fs.realpathSync(os.tmpdir());
  return SYSTEM_PREFIXES.some((s) => tmp === s || tmp.startsWith(`${s}/`)) ? fs.realpathSync(os.homedir()) : tmp;
})();
function tree() {
  const w = fs.realpathSync(fs.mkdtempSync(path.join(TREE_BASE, "relocation-plan-")));
  const p = (...x) => path.join(w, ...x);
  for (const d of ["home/.local/state", "ws/orbit/web", "ws/orbit/api", "ws/orbit/node_modules/x", "ws/orbit-2", "ws/different", "data/worktrees/c1", "srv/secret-deposit"]) fs.mkdirSync(p(d), { recursive: true });
  fs.writeFileSync(p("ws/orbit/.env"), [
    `POSTGRES_PASSWORD=${SECRET.POSTGRES_PASSWORD}`,
    `DATABASE_URL=${SECRET.DATABASE_URL}`,
    `export API_KEY='${SECRET.API_KEY}'`,
    `EXTERNAL="${SECRET.EXTERNAL}" # comment`,
    `TOKEN: ${SECRET.TOKEN}`,
    `MULTILINE="line1`, `row2-secret"`,
    `DEPOSIT=${p("srv/secret-deposit")}`,
    "UPLOADS=/app/uploads-secret",
    "LOGS=./logs-secret",
    "CACHE_URL=redis://localhost:6390/0",
    "this line is broken",
    "",
  ].join("\n"));
  fs.writeFileSync(p("ws/orbit/web/.env"), "PORT=3100\nNEXTAUTH_URL=http://localhost:3100\n");
  fs.writeFileSync(p("ws/orbit/web/.env.example"), "PORT=3000\nNEXTAUTH_URL=http://localhost:3000\nEXAMPLE_PATH=/path/to/example\n");
  fs.writeFileSync(p("ws/orbit/api/.env"), "PORT=3101\n");
  fs.writeFileSync(p("ws/orbit/node_modules/x/.env"), "NOT_READ=1\n");
  fs.writeFileSync(p("home/secret.env"), "KEY_OF_B=hidden\n");
  fs.symlinkSync(p("home/secret.env"), p("ws/orbit/.env.reference"));
  fs.writeFileSync(p("ws/orbit/.env.large"), `X=${"a".repeat(2048)}\n`);
  // Through links: a link ON the project counts (realpath lies inside), a link IN the project to the outside does not.
  fs.symlinkSync(p("ws/orbit"), p("link-on-project"));
  fs.symlinkSync(p("ws/different"), p("ws/orbit/out"));
  return { w, p, cleanUp: () => fs.rmSync(w, { recursive: true, force: true }) };
}

// ── The inspect fixtures ───────────────────────────────────────────────────────────────────────────────────────────

const A = (c) => c.repeat(64);
function compose(project, folder, service, extra = {}) {
  return {
    "com.docker.compose.project": project,
    "com.docker.compose.project.working_dir": folder,
    "com.docker.compose.project.config_files": path.join(folder, "docker-compose.yml"),
    "com.docker.compose.service": service,
    "com.docker.compose.config-hash": `hash-${service}`,
    "com.docker.compose.container-number": "1",
    "com.docker.compose.oneoff": "False",
    ...extra,
  };
}
function ctr(name, { labels = {}, image = "sha256:alp", ref = "alpine:latest", status = "running", exit = 0, restart = "no", mounts = [], networks = [], ports = {} } = {}) {
  return {
    Id: `id-${name}`, Name: `/${name}`, Image: image,
    Config: { Image: ref, Labels: labels }, State: { Status: status, ExitCode: exit },
    HostConfig: { RestartPolicy: { Name: restart }, PortBindings: ports },
    Mounts: mounts, NetworkSettings: { Networks: Object.fromEntries(networks.map((n) => [n, {}])) },
  };
}
const vol = (name, target) => ({ Type: "volume", Name: name, Destination: target, Driver: "local" });
// A one-off container (`compose run` without --rm): oneoff=True, name `<project>-<service>-run-<12 base-16 digits>`, default exited.
const once = (name, folder, service, { status = "exited", mounts = [], image = "sha256:pg", ref = "postgres:16-alpine" } = {}) =>
  ctr(name, { labels: compose("orbit", folder, service, { "com.docker.compose.oneoff": "True" }), image, ref, status, mounts, networks: ["orbit_default"] });
const bind = (source, target) => ({ Type: "bind", Source: source, Destination: target });

const COMPOSE_TEXT = `services:
  db:
    image: postgres:16-alpine
    volumes: [pgdata:/var/lib/postgresql/data/pgdata]
  migrate:
    image: postgres:16-alpine
    command: sh -c 'echo $$HOME'
    depends_on: { db: { condition: service_healthy } }
  files:
    image: python:3.12-slim
    volumes: [/data, ./conf:/conf:ro]
  app:
    build: ./app
    networks: [default, ext]
  spare:
    image: alpine
    environment:
      MODE: \${RELOCATION_MODE:-default}
      DB: \${POSTGRES_PASSWORD}
  extra:
    image: alpine
    profiles: [extra]
networks:
  ext:
    external: true
    name: orbit-ext
volumes:
  pgdata:
`;

function data(t, change = {}) {
  const P = t.p("ws/orbit");
  const Z = t.p("ws/orbit-2");
  const cf = path.join(P, "docker-compose.yml");
  const mounts = mountRules({ home: t.p("home"), wsPath: t.p("ws"), projectPath: P, runtime: t.p("data/projects/p1") });
  const env = readEnvFiles(P, { mounts, home: t.p("home"), localNames: ["db", "app"], maxBytes: 1024 });
  const d = {
    project: { id: "p1", name: "ORBIT", path: P },
    mounts, home: t.p("home"),
    container: [
      ctr("orbit-db-1", { labels: compose("orbit", P, "db"), image: "sha256:pg", ref: "postgres:16-alpine", restart: "unless-stopped", mounts: [vol(A("a"), "/var/lib/postgresql/data"), vol("orbit_pgdata", "/var/lib/postgresql/data/pgdata")], networks: ["orbit_default"], ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5432" }] } }),
      ctr("orbit-migrate-1", { labels: compose("orbit", P, "migrate", { "com.docker.compose.depends_on": "db:service_healthy:false" }), image: "sha256:pg", ref: "postgres:16-alpine", status: "exited", mounts: [vol(A("b"), "/var/lib/postgresql/data")], networks: ["orbit_default"] }),
      ctr("orbit-files-1", { labels: compose("orbit", P, "files"), image: "sha256:py", ref: "python:3.12-slim", mounts: [vol(A("c"), "/data"), bind(path.join(P, "conf"), "/conf")], networks: ["orbit_default"] }),
      ctr("orbit-app-1", { labels: compose("orbit", P, "app", { "com.docker.compose.depends_on": "db:service_started:false" }), image: "sha256:app1", ref: "orbit-app", restart: "always", mounts: [vol(A("d"), "/cache")], networks: ["orbit_default", "orbit-ext"] }),
      ctr("orbit-spare-1", { labels: compose("orbit", P, "spare"), status: "exited", exit: 137, restart: "unless-stopped", networks: ["orbit_default"] }),
      ctr("orbit-extra-1", { labels: compose("orbit", P, "extra"), networks: ["orbit_default"] }),
      ctr("orbit-2-db-1", { labels: compose("orbit-2", Z, "db"), image: "sha256:pg", ref: "postgres:16-alpine", networks: ["orbit-2_default"] }),
      ctr("tool-1", { mounts: [bind(path.join(P, "tool"), "/w")] }),
      ctr("foreign-1", {}),
      ctr("cbase-p-p1", { labels: { "cbase.project": "p1", "cbase.instance": "main" } }),
    ],
    images: [
      { Id: "sha256:pg", RepoTags: ["postgres:16-alpine"], Size: 100e6 },
      { Id: "sha256:py", RepoTags: ["python:3.12-slim"], Size: 50e6 },
      { Id: "sha256:alp", RepoTags: ["alpine:latest"], Size: 10e6 },
      { Id: "sha256:app1", RepoTags: ["orbit-app:latest"], Size: 20e6 },
    ],
    volumes: [
      { Name: "orbit_pgdata", Driver: "local", Labels: { "com.docker.compose.project": "orbit", "com.docker.compose.volume": "pgdata" }, size: 60e6 },
      ...["a", "b", "c", "d"].map((c) => ({ Name: A(c), Driver: "local", Labels: null, size: 5e6 })),
    ],
    networks: [
      { Name: "orbit_default", Labels: { "com.docker.compose.project": "orbit", "com.docker.compose.network": "default" } },
      { Name: "orbit-ext", Labels: {} },
      { Name: "orbit-2_default", Labels: { "com.docker.compose.project": "orbit-2" } },
    ],
    diffs: {
      "id-orbit-db-1": ["C /var", "C /var/run", "C /var/run/postgresql", "A /var/run/postgresql/.s.PGSQL.5432.lock", "C /tmp", "A /tmp/x"],
      ...Object.fromEntries(["migrate", "files", "app", "spare", "extra"].map((s) => [`id-orbit-${s}-1`, []])),
    },
    composeTexts: { [cf]: COMPOSE_TEXT },
    untrackedCompose: [],
    worktrees: [{ repo: path.join(P, "web"), path: path.join(P, "web") }, { repo: path.join(P, "web"), path: t.p("data/worktrees/c1") }],
    worktreeRoots: [t.p("data/worktrees")],
    mcpServer: [],
    env,
    tracked: ["web/.env.example"],
    services: [{ id: 9, name: "tool", container: "tool-1", port: null }],
    startScripts: {},
    repos: [],
    projectRepo: { arises: true, reason: null, files: [] },
    local: [],
    localReferences: {},
    foreign: [],
    texts: [],
    processes: [],
    runtimePrefilled: [],
  };
  return { ...d, ...(typeof change === "function" ? change(d, t) : change) };
}
const kinds = (list) => list.map((x) => x.kind).sort();
const names = (plan) => plan.container.map((c) => c.name).sort();
const reveals = (output) => DECOY.filter((k) => JSON.stringify(output).includes(k));

// ── Path rule ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("path rule: what lies under the project folder moves along (realpath WITH separator) - counter-proof: startsWith without separator pulls orbit-2 in", () => {
  const t = tree();
  try {
    const d = data(t);
    const plan = planRelocation(d);
    const ORBIT = ["orbit-app-1", "orbit-db-1", "orbit-extra-1", "orbit-files-1", "orbit-migrate-1", "orbit-spare-1"];
    assert.deepEqual(names(plan), ORBIT, "exactly the six containers of the stack; never orbit-2, a container without a label or a cbase container");
    assert.deepEqual(plan.withoutLabel.map((c) => c.name), ["tool-1"], "without label only what seems to belong to the project");

    // Links: a working_dir through a link ON the project counts, a link IN the project to the outside does not.
    const withLinks = planRelocation({ ...d, container: [
      ctr("over-link-1", { labels: compose("overlink", t.p("link-on-project"), "x") }),
      ctr("out-1", { labels: compose("out", t.p("ws/orbit/out"), "x") }),
    ], diffs: { "id-over-link-1": [] }, composeTexts: {} });
    assert.deepEqual(names(withLinks), ["over-link-1"]);

    // Counter-proof: the rule without separator pulls the neighbour in - the first assertion above would be red.
    const naive = planRelocation(d, { under: (p, w) => p.startsWith(w) });
    assert.ok(names(naive).includes("orbit-2-db-1"), "the counter-proof proves nothing: startsWith does not pull orbit-2 in");
    assert.notDeepEqual(names(naive), ORBIT);
  } finally { t.cleanUp(); }
});

// ── The clean plan ───────────────────────────────────────────────────────────────────────────────────────────────

test("clean stack: no hold reason; groups, order, volumes, networks, space and downtime computed", () => {
  const t = tree();
  try {
    // Without the bait DEPOSIT (a path outside the mounts that exists in B - the hold reason of the next test).
    const d = data(t, (x) => ({ env: x.env.map((f) => ({ ...f, entries: f.entries && f.entries.filter((e) => e.key !== "DEPOSIT") })) }));
    const plan = planRelocation(d);
    const P = d.project.path;
    assert.deepEqual(plan.holdReasons, [], JSON.stringify(plan.holdReasons));
    assert.equal(plan.canRelocate, true);
    assert.equal(plan.compose.length, 1);
    assert.deepEqual(plan.compose[0].args, ["-p", "orbit", "--project-directory", P, "-f", path.join(P, "docker-compose.yml")]);
    assert.deepEqual(plan.startFollowUp, ["orbit-db-1", "orbit-extra-1", "orbit-files-1", "orbit-spare-1", "orbit-app-1", "orbit-migrate-1"], "depends_on: db before app and migrate");
    assert.deepEqual(plan.stopFollowUp, [...plan.startFollowUp].reverse());
    assert.deepEqual(plan.compose[0].services, ["db", "extra", "files", "spare", "app", "migrate"], "all services explicitly (profile service extra included)");
    assert.deepEqual(plan.volumes.named.map((v) => [v.name, v.container]), [["orbit_pgdata", ["orbit-db-1"]]]);
    assert.deepEqual(plan.volumes.anonym.map((v) => [v.container, v.target]), [["orbit-app-1", "/cache"], ["orbit-db-1", "/var/lib/postgresql/data"], ["orbit-files-1", "/data"], ["orbit-migrate-1", "/var/lib/postgresql/data"]]);
    assert.deepEqual(plan.networks, { itself: ["orbit-ext"], owner: [{ network: "orbit_default", project: "orbit" }] });
    const db = plan.container.find((c) => c.name === "orbit-db-1");
    assert.deepEqual([db.state, db.restart, db.image, db.configHash, db.ports], ["running", "unless-stopped", "sha256:pg", "hash-db", [5432]]);
    const spare = plan.container.find((c) => c.name === "orbit-spare-1");
    assert.deepEqual([spare.state, spare.exitCode], ["exited", 137]);
    assert.deepEqual(plan.worktrees, { move: [{ repo: path.join(P, "web"), path: t.p("data/worktrees/c1") }], stay: [] });

    // Space and downtime: images 180 MB, volumes 80 MB.
    assert.deepEqual([plan.slot.images, plan.slot.volumes, plan.slot.bytes], [180e6, 80e6, 260e6]);
    const expected = 180 / RATES.imagesMBs + 80 / RATES.volumesMBs + RATES.stopS + (2 * 80) / RATES.manifestMBs;
    assert.equal(plan.downtime.seconds, Math.ceil(expected));
    assert.equal(plan.downtime.incomplete, false);

    // Hints: profile service, variable without label ($$ is none, POSTGRES_PASSWORD is in the .env).
    const var_ = plan.hints.find((h) => h.kind === "variable-without-label");
    assert.deepEqual(var_.names, ["RELOCATION_MODE"]);
    assert.ok(plan.hints.some((h) => h.kind === "profile-services"));
    assert.ok(plan.hints.some((h) => h.kind === "without-label" && h.container === "tool-1"));
    assert.ok(plan.hints.some((h) => h.kind === "path-unknown-env" && h.key === "UPLOADS"), "/app/uploads does not exist in B: hint, no hold");
    assert.ok(plan.hints.some((h) => h.kind === "env-unreadable" && h.file === ".env.large"), "over the cap: named, not read");
    // A `.env.example` is repo default, not configuration: its placeholders (EXAMPLE_PATH) are no finding.
    assert.deepEqual([...plan.holdReasons, ...plan.hints].filter((h) => /\.example$/.test(h.file || "")), []);
  } finally { t.cleanUp(); }
});

// ── Hold reasons ─────────────────────────────────────────────────────────────────────────────────────────────────

test("every hold reason of step 1 holds, and every reported kind is in ENTRIES", () => {
  const t = tree();
  try {
    const P = t.p("ws/orbit");
    const cases = [
      ["image-without-tag", (d) => ({ images: d.images.map((i) => (i.Id === "sha256:app1" ? { ...i, RepoTags: [] } : i)).concat([{ Id: "sha256:app2", RepoTags: ["orbit-app:latest"], Size: 1 }]) })],
      ["writeLayer", (d) => ({ diffs: { ...d.diffs, "id-orbit-files-1": ["C /var", "C /var/lib", "A /var/lib/data.db"] } })],
      ["bind-outside", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-files-1" ? { ...c, Mounts: [...c.Mounts, bind(t.p("srv/secret-deposit"), "/deposit")] } : c)) })],
      ["worktree-outside", (d) => ({ worktrees: [...d.worktrees, { repo: path.join(P, "web"), path: t.p("home/review-160") }] })],
      ["fixed-subnet-collision", (d) => ({ composeTexts: { [path.join(P, "docker-compose.yml")]: `${COMPOSE_TEXT}  intern:\n    ipam:\n      config:\n        - subnet: 10.230.5.0/24\n` } })],
      ["stack-port-7718", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-app-1" ? { ...c, HostConfig: { ...c.HostConfig, PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "7718" }] } } } : c)) })],
      ["volume-shared", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-2-db-1" ? { ...c, Mounts: [vol("orbit_pgdata", "/x")] } : c)) })],
      ["volume-driver", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-db-1" ? { ...c, Mounts: [{ ...vol("orbit_pgdata", "/p"), Driver: "nfs" }] } : c)) })],
      ["network-owner-stays", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-app-1" ? { ...c, NetworkSettings: { Networks: { "orbit-2_default": {} } } } : c)) })],
      ["compose-project-shared", (d) => ({ container: [...d.container, ctr("same-name-1", { labels: compose("orbit", t.p("ws/orbit-2"), "db") })] })],
      ["compose-labels", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-extra-1" ? { ...c, Config: { ...c.Config, Labels: { ...c.Config.Labels, "com.docker.compose.project.config_files": "docker-compose.yml" } } } : c)) })],
      ["compose-file-outside", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-extra-1" ? { ...c, Config: { ...c.Config, Labels: { ...c.Config.Labels, "com.docker.compose.project.config_files": t.p("home/foreign.yml") } } } : c)), composeTexts: { ...d.composeTexts, [t.p("home/foreign.yml")]: "services: {}\n" } })],
      ["path-outside-env", () => ({})],
      ["path-outside-mcp", () => ({ mcpServer: [{ name: "check", transport: "stdio", command: t.p("srv/secret-deposit"), args: [], env: {} }] })],
      ["data-missing", (d) => ({ diffs: { ...d.diffs, "id-orbit-app-1": undefined } })],
      // Digest, driver_opts, one-off container running / on a volume that moves.
      ["image-digest", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-db-1" ? { ...c, Config: { ...c.Config, Image: "postgres@sha256:" + A("e") } } : c)), images: d.images.map((i) => (i.Id === "sha256:pg" ? { ...i, RepoDigests: ["postgres@sha256:" + A("e")] } : i)) })],
      ["volume-options", (d) => ({ volumes: d.volumes.map((v) => (v.Name === "orbit_pgdata" ? { ...v, options: ["device", "o", "type"] } : v)) })],
      ["once-container-running", (d) => ({ container: [...d.container, once("orbit-migrate-run-1a2b3c4d5e6f", P, "migrate", { status: "running" })] })],
      ["once-container-volume", (d) => ({ container: [...d.container, once("orbit-migrate-run-1a2b3c4d5e6f", P, "migrate", { mounts: [vol("orbit_pgdata", "/p")] })] })],
      // A container of cbase (label ON the container) on a volume of the plan.
      ["container-excluded", (d) => ({ container: [...d.container, ctr("cbase-helper-relocation-old", { labels: { "cbase.helper": "relocation" }, mounts: [vol("orbit_pgdata", "/src")] })] })],
      // A process in B with its working dir in the project (collect.js `processes`).
      ["process-in-project", () => ({ processes: [{ pid: 7289, start: "proc:4242", program: "node" }] })],
            ["service-port-collision", () => ({ services: [
        { id: 1, name: "a", port: 3001, dir: "a", startCommand: "next dev -p 3001" }, { id: 2, name: "b", port: 3002, dir: "b", startCommand: "next dev -p 3002" },
      ] })],
      ["project-volume-existing", (d) => ({ volumes: [...d.volumes, { Name: "cbase-p-p1-docker", Driver: "local", Labels: { "cbase.project": "p1" } }] })],
      ["service-reference", (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-app-1" ? { ...c, HostConfig: { ...c.HostConfig, NetworkMode: "container:id-orbit-db-1" } } : c)) })],
    ];
    const exists = (p) => fs.existsSync(p);
    for (const [kind, change] of cases) {
      const plan = planRelocation(data(t, change), { exists });
      assert.ok(kinds(plan.holdReasons).includes(kind), `${kind}: no hold reason - ${JSON.stringify(kinds(plan.holdReasons))}`);
      assert.equal(plan.canRelocate, false);
      for (const e of [...plan.holdReasons, ...plan.hints]) assert.ok(ENTRIES[e.kind], `unknown kind ${e.kind}`);
    }
    // The DEPOSIT line of the .env (a path outside the mounts that exists in B) holds; UPLOADS (not in B) is a hint (previous
    // test). Without `exists`, "exists in B" is unknown - and unknown holds like present.
    assert.ok(planRelocation(data(t)).holdReasons.some((h) => h.kind === "path-outside-env" && h.key === "DEPOSIT"));
    const mcpWithout = planRelocation(data(t, { mcpServer: [{ name: "x", command: "/exists/es/nowhere", args: [], env: {} }] }));
    assert.ok(mcpWithout.holdReasons.some((h) => h.kind === "path-outside-mcp"), "without exists: unknown is not \"missing\"");
    const mcpWith = planRelocation(data(t, { mcpServer: [{ name: "x", command: "/exists/es/nowhere", args: [], env: {} }] }), { exists });
    assert.ok(!mcpWith.holdReasons.some((h) => h.kind === "path-outside-mcp"), "what does not exist in B is missing today as well");
    // No conclusion from the transient: /tmp, /run, /var/run make no write layer (Postgres lock file in the fixture).
    assert.ok(!kinds(planRelocation(data(t), { exists }).holdReasons).includes("writeLayer"));
    // A fixed subnet outside the occupied ranges is only a hint.
    const free = planRelocation(data(t, { composeTexts: { [path.join(P, "docker-compose.yml")]: `${COMPOSE_TEXT}  intern:\n    ipam:\n      config:\n        - subnet: 10.247.250.0/24\n` } }), { exists });
    assert.ok(free.hints.some((h) => h.kind === "fixed-subnet" && h.subnet === "10.247.250.0/24"));
    assert.ok(!kinds(free.holdReasons).includes("fixed-subnet-collision"));
    // docker.sock is a hint, no bind hold reason.
    const sock = planRelocation(data(t, (d) => ({ container: d.container.map((c) => (c.Name === "/orbit-app-1" ? { ...c, Mounts: [bind("/var/run/docker.sock", "/var/run/docker.sock")] } : c)) })), { exists });
    assert.ok(sock.hints.some((h) => h.kind === "docker-sock") && !kinds(sock.holdReasons).includes("bind-outside"));
  } finally { t.cleanUp(); }
});

test("ENTRIES: the specified kinds hold; what a copy cannot carry the plan only names", () => {
  for (const [kind, e] of Object.entries(ENTRIES)) assert.ok(["hold", "hint"].includes(e.stage) && e.text, kind);
  for (const kind of ["worktree-outside", "path-outside-mcp", "path-outside-env", "writeLayer", "image-without-tag", "bind-outside", "stack-port-7718", "fixed-subnet-collision", "image-digest", "volume-options", "once-container-running", "once-container-volume", "container-excluded", "process-in-project", "service-port-collision", "project-volume-existing", "service-reference"]) assert.equal(ENTRIES[kind].stage, "hold", kind);
  for (const kind of ["process-in-terminal", "process-descendant", "variable-from-b", "volume-without-label-foreign", "runtime-prefilled"]) assert.equal(ENTRIES[kind].stage, "hint", kind);
  for (const kind of Object.keys(ENTRIES).filter((a) => a.startsWith("copy-"))) assert.equal(ENTRIES[kind].stage, "hint", kind);
  const t = tree();
  try {
    const plan = planRelocation(data(t, {
      repos: [{ path: "web", alternates: true, flat: true, partialClone: true, submodule: true, embedded: true, beyondLimit: true, objectsReferences: true, filter: true, detached: true, stashes: true }],
      projectRepo: { arises: false, reason: "repo", files: [] },
    }));
    const copy = kinds(plan.hints).filter((a) => a.startsWith("copy-"));
    assert.deepEqual(copy, Object.keys(ENTRIES).filter((a) => a.startsWith("copy-")).sort());
    assert.ok(!kinds(plan.holdReasons).some((a) => a.startsWith("copy-")));
  } finally { t.cleanUp(); }
});

// ── env-key: no value ───────────────────────────────────────────────────────────────────────────────────────────

test("env-key: no value appears in the output (nor in the plan) - counter-proof: an output with values fires", () => {
  const t = tree();
  try {
    const d = data(t);
    const root = d.env.find((f) => f.rel === ".env");
    assert.deepEqual(reveals(d.env), [], "readEnvFiles reveals a value");
    assert.deepEqual(reveals(planRelocation(d)), [], "the plan reveals a value");
    const after = Object.fromEntries(root.entries.map((e) => [e.key, e]));
    assert.deepEqual(Object.keys(after).sort(), ["API_KEY", "CACHE_URL", "DATABASE_URL", "DEPOSIT", "EXTERNAL", "LOGS", "MULTILINE", "POSTGRES_PASSWORD", "TOKEN", "UPLOADS"]);
    assert.deepEqual(root.unreadable, [12], "the broken line as a number, not as text");
    assert.deepEqual(after.DATABASE_URL.targets, [{ host: "local", port: 5432 }]);
    assert.deepEqual(after.EXTERNAL.targets, [{ host: "foreign", port: null }]);
    assert.deepEqual([after.DEPOSIT.path, after.DEPOSIT.inB], ["outside", true]);
    assert.deepEqual([after.UPLOADS.path, after.UPLOADS.inB], ["outside", false]);
    assert.equal(after.LOGS.path, "inside", "./ resolves against the folder of the file - inside the project");
    assert.deepEqual(d.env.map((f) => f.rel), [".env", ".env.large", "api/.env", "web/.env", "web/.env.example"], "no link (.env.reference -> home of B), nothing from node_modules");
    assert.ok(!JSON.stringify(d.env).includes("KEY_OF_B"), "followed a link");

    // Counter-proof: the same check against an output that carries the value fires (otherwise "empty" would prove nothing).
    const raw = fs.readFileSync(t.p("ws/orbit/.env"), "utf8").split("\n").map((z) => z.split("=").slice(1).join("="));
    const withValues = root.entries.map((e, i) => ({ ...e, value: raw[i] }));
    assert.ok(reveals(withValues).length >= 3, `the counter-proof proves nothing: ${JSON.stringify(reveals(withValues))}`);

    // Classes: local, stack, cbase, foreign.
    const k = (w, ctx) => stageValue("URL", w, ctx).targets.map((z) => z.host);
    assert.deepEqual(k("http://127.0.0.2:1"), ["local"]);
    assert.deepEqual(k("http://[::1]:1"), ["local"]);
    assert.deepEqual(k("http://host.docker.internal:1"), ["local"]);
    assert.deepEqual(k("http://db:5432", { localNames: ["db"] }), ["stack"]);
    assert.deepEqual(k(`http://geo${SUFFIX_CBASE}:8000`), ["cbase"]);
    assert.deepEqual(k("mongodb://u:p@a.example:1,localhost:2"), ["foreign", "local"]);
    assert.equal(SUFFIX_CBASE, NAMES_SUFFIX, "two places for the suffix - bound");
    assert.equal(stageValue("DB_HOST", "localhost").targets[0].host, "local");
    assert.equal(stageValue("PIN", "1234").port, null, "a number is a port only under a port key");
    assert.deepEqual(envKey('A="x\ny"\nB=2').entries.map((e) => [e.key, e.row]), [["A", 1], ["B", 3]]);
  } finally { t.cleanUp(); }
});

// ── Port dismantling, mentions, accidental hits, ~/.local ───────────────────────────────────────────────────────────

test("port dismantling: repo default from tracked .env.example, start script or framework; not recognisable => hint; old ports in texts", () => {
  const t = tree();
  try {
    const P = t.p("ws/orbit");
    const plan = planRelocation(data(t, (d) => ({
      services: [
        { id: 1, name: "web", port: 3100, dir: "web", startCommand: "npx next dev -p 3100" },
        { id: 2, name: "api", port: 3101, dir: "api", startCommand: "PORT=3101 npm run dev" },
        { id: 3, name: "travelExpenses", port: 3110, dir: "travelExpenses", startCommand: "node server.js -p 3110" },
        { id: 4, name: "agent-runtime", port: 3125, dir: "", startCommand: "npm run dev", savedCommand: "next dev -p 3125" },
      ],
      startScripts: { [path.join(P, "api")]: { dev: "next dev" }, [P]: { dev: "next dev -p 3125" } },
      texts: [{ kind: "skill", id: "examplecorp", title: "Start", text: "Header\nopen http://localhost:3100 in the browser\nPort 3125 stays" }],
    })));
    // api/.env has no tracked .env.example - the default in the code of service `api` applies (same folder, same port 3101,
    // `next dev` => 3000), instead of the moved port staying.
    assert.deepEqual(plan.dismantling.env, [
      { file: "api/.env", key: "PORT", port: 3101, standard: 3000, source: "framework:next" },
      { file: "web/.env", key: "PORT", port: 3100, standard: 3000 },
      { file: "web/.env", key: "NEXTAUTH_URL", port: 3100, standard: 3000 },
    ]);
    const d = Object.fromEntries(plan.dismantling.services.map((x) => [x.name, [x.portOld, x.portStandard, x.source]]));
    assert.deepEqual(d.web, [3100, 3000, ".env.example"]);
    assert.deepEqual(d.api, [3101, 3000, "framework:next"]);
    assert.deepEqual(d.travelExpenses, [3110, null, null]);
    assert.deepEqual(d["agent-runtime"], [3125, 3125, "package.json"], "as it stands in the repo (ORBIT agent-runtime stays)");
    assert.ok(plan.hints.some((h) => h.kind === "service-port-unknown" && h.service === "travelExpenses"));
    assert.ok(!plan.hints.some((h) => h.kind === "env-without-example" && h.file === "api/.env"), "api/.env PORT now has a default");
    // A port without an example and without a service of this folder with that port stays, the plan names it (CACHE_URL, DATABASE_URL).
    assert.ok(plan.hints.some((h) => h.kind === "env-without-example" && h.file === ".env" && h.key === "CACHE_URL"));
    assert.ok(!plan.dismantling.env.some((x) => x.file === ".env"), "a foreign port is never guessed");
    assert.deepEqual(plan.mentions.map((n) => [n.source, n.id, n.port, n.row]), [["skill", "examplecorp", 3100, 2]], "3125 does not change and is not named");
    // ONE rule with the dismantling (port-command.js) - ascending (not in order of discovery).
    assert.deepEqual(portsInCommand("next dev --port=4000 && X_PORT=4001 node a -p 4002"), [4000, 4001, 4002]);
  } finally { t.cleanUp(); }
});

test("accidental hits in both directions, ~/.local assignment with MCP commands, project repo with cap", () => {
  const t = tree();
  try {
    const vega = envKey("DB=postgresql://u:p@localhost:5432/x\nPORT=5432\n").entries;
    const plan = planRelocation(data(t, {
      foreign: [
        { projectId: "vega", name: "VEGA", ports: [], env: [{ rel: "ppa-rag/.env", entries: vega }] },
        { projectId: "geo", name: "GEO", ports: [6390, 5432], env: [] },
      ],
      mcpServer: [{ name: "check", transport: "stdio", command: "uv", args: ["run", "--directory=./mcp", "server.py"], env: { DEPOSIT: `${t.p("home")}/.local/share/checkdata/x` } }],
      local: [{ rel: "state/check", bytes: 10 }, { rel: "share/uv", bytes: 5 }, { rel: "share/orphan", bytes: 1 }, { rel: "state/other", bytes: 2 }, { rel: "share/checkdata", bytes: 3 }],
      localReferences: { p1: ["state/check"], different: ["state/other"] },
      projectRepo: { arises: true, reason: null, files: [...Array.from({ length: 205 }, (_, i) => ({ path: `note-${String(i).padStart(3, "0")}.md`, bytes: 1 })), { path: "deck.pptx", bytes: 20 * 1024 * 1024 }, { path: "litellm/.env", bytes: 5 }] },
    }));
    assert.deepEqual(plan.hits.hitOf, [{ projectId: "vega", name: "VEGA", file: "ppa-rag/.env", key: "DB", port: 5432 }], "PORT=5432 is an own port, no target");
    assert.deepEqual(plan.hits.hits, [{ projectId: "geo", name: "GEO", source: ".env", key: "CACHE_URL", port: 6390 }], "5432 is an own port, not a foreign one");
    assert.deepEqual(plan.local.assignment, { "share/checkdata": ["p1"], "state/other": ["different"], "state/check": ["p1"] });
    assert.deepEqual(plan.local.entries.map((e) => [e.rel, e.current]), [["state/check", true], ["share/orphan", false], ["state/other", false], ["share/checkdata", true]], "share/uv stays shared");
    assert.deepEqual(plan.hints.filter((h) => h.kind === "local-without-assignment").map((h) => h.rel), ["share/orphan"]);
    assert.ok(plan.hints.some((h) => h.kind === "mcp-relative" && h.field === "args[1]"));
    assert.deepEqual([plan.projectRepo.count, plan.projectRepo.paths.length, plan.projectRepo.clipped], [207, 200, 7], "the cap says it is one");
    assert.deepEqual(plan.projectRepo.env, ["litellm/.env"]);
    assert.deepEqual(plan.projectRepo.large.map((g) => g.path), ["deck.pptx"]);
  } finally { t.cleanUp(); }
});

// ── compose-config ───────────────────────────────────────────────────────────────────────────────────────────────

test("compose-config: arguments from the labels; foreign data that is no clean call throws", () => {
  const l = compose("orbit", "/ws/orbit", "db", {
    "com.docker.compose.project.config_files": "/ws/orbit/docker-compose.yml,/ws/orbit/docker-compose.cbase.yml",
    "com.docker.compose.project.environment_file": "/ws/orbit/.env.local",
    "com.docker.compose.depends_on": "redis:service_started:true,db:service_healthy:false",
  });
  const k = composeConfig({ Config: { Labels: l } });
  assert.deepEqual(k.args, ["-p", "orbit", "--project-directory", "/ws/orbit", "-f", "/ws/orbit/docker-compose.yml", "-f", "/ws/orbit/docker-compose.cbase.yml", "--env-file", "/ws/orbit/.env.local"]);
  assert.deepEqual(composeConfig({ labels: l }).args, k.args, "ps form like inspect form");
  // `--profile *` on `config` (otherwise profile services are missing in the hash), NOT on `up`.
  assert.deepEqual(configHashArgs(k), ["compose", ...k.args, "--profile", "*", "config", "--hash", "*"]);
  assert.deepEqual(upWithoutStartArgs(k, ["db", "extra", "db"]), ["compose", ...k.args, "up", "--no-start", "--no-build", "--pull", "never", "db", "extra"]);
  const raises = (labels, code) => assert.throws(() => composeConfig({ labels }), (e) => e instanceof ComposeConfigError && e.code === code, JSON.stringify(labels));
  raises({}, "NO_COMPOSE");
  raises({ ...l, "com.docker.compose.project": "-f" }, "LABEL_INVALID");
  raises({ ...l, "com.docker.compose.project.working_dir": "ws/orbit" }, "LABEL_INVALID");
  raises({ ...l, "com.docker.compose.project.working_dir": "/ws/orbit/../different" }, "LABEL_INVALID");
  raises({ ...l, "com.docker.compose.project.config_files": "" }, "LABEL_EMPTY");
  raises({ ...l, "com.docker.compose.project.config_files": "/ws/a.yml,-f" }, "LABEL_INVALID");
  assert.throws(() => upWithoutStartArgs(k, []), (e) => e.code === "NO_SERVICES");
  assert.throws(() => upWithoutStartArgs(k, ["--build"]), (e) => e.code === "LABEL_INVALID");
  assert.equal(composeConfig({ labels: { ...l, "com.docker.compose.project.working_dir": "/ws/orbit/" } }).folder, "/ws/orbit");
});

// `config --hash` is never the hash of `up` for an env_file service - step 12b asks Compose in a dry run, the dry run
// recognises env_file from Compose's model. The line shapes below are the measured ones.
test("compose-config dry-run parser: Recreate, Created, missing line, warning, short-id prefix; unreadable throws", () => {
  const z = (o) => JSON.stringify(o);
  const plan = ["shop-db-1", "shop-web-1", "shop-migrate-1", "shop-new-1"];
  const text = [
    z({ id: "Network shop_default", status: "Working", text: "Creating" }),
    z({ level: "warning", msg: "Found orphan containers ([shop-old-1]) for this project. If you removed or renamed this service …", time: "2026-09-29T10:00:00Z" }),
    z({ id: "Container shop-web-1", status: "Working", text: "Recreate" }),
    z({ id: "Container 0ff4ffb68c10_shop-web-1", status: "Done", text: "Recreated" }),
    z({ id: "Container shop-db-1", status: "Done", text: "Running" }),
    z({ id: "Container shop-new-1", status: "Working", text: "Creating" }),
    z({ id: "Container shop-new-1", status: "Done", text: "Created" }),
    z({ tail: true, text: "Tail" }),
    "",
  ].join("\n");
  // shop-migrate-1 (current, stopped) has NO line: it is neither new nor missing.
  assert.deepEqual(dryrunVerdict(text, plan), { fresh: ["shop-web-1"], missing: ["shop-new-1"], foreign: [], unclear: [], seen: ["shop-db-1", "shop-new-1", "shop-web-1"] });
  // Only the short-id prefix is cut off, and only if the full name is no plan container.
  assert.deepEqual(dryrunVerdict(z({ id: "Container 0ff4ffb68c10_shop-web-1", status: "Done", text: "Recreated" }), plan).fresh, ["shop-web-1"]);
  assert.deepEqual(dryrunVerdict(z({ id: "Container abcdefabcdef_x-web-1", status: "Working", text: "Recreate" }), ["abcdefabcdef_x-web-1"]).fresh, ["abcdefabcdef_x-web-1"]);
  // Outside the plan: a change is "foreign" (foreign), "Running" is not; an unknown word on a plan container is "unclear".
  const u = dryrunVerdict([z({ id: "Container different-1", status: "Working", text: "Recreate" }), z({ id: "Container running-1", status: "Done", text: "Running" }),
    z({ id: "Container shop-db-1", status: "Working", text: "Starting" })].join("\n"), plan);
  assert.deepEqual([u.foreign, u.unclear], [["different-1"], [{ name: "shop-db-1", words: ["Starting"] }]]);
  // Empty is "everything current" - hence the control with --force-recreate in the procedure.
  assert.deepEqual(dryrunVerdict("\n", plan), { fresh: [], missing: [], foreign: [], unclear: [], seen: [] });
  const raises = (t, pattern) => assert.throws(() => dryrunVerdict(t, plan), (e) => e instanceof ComposeConfigError && e.code === "DRYRUN_UNREADABLE" && pattern.test(e.message) && !e.message.includes("SECRET"), t);
  raises(`${z({ id: "Container shop-db-1", status: "Done", text: "Running" })}\n{"id":"Container shop-web-1","text":"Recr HIDDEN`, /line 2 is not JSON/);
  raises("Recreate shop-web-1 HIDDEN", /line 1 is not JSON/);
  raises(z(["Container shop-web-1", "Recreate"]), /not a JSON object/);
  raises(z({ status: "Done", text: "SECRET" }), /neither `id` nor `level`/);
  raises(z({ id: "Service shop-web-1", status: "Done", text: "Recreated" }), /unknown kind/);
  raises(z({ id: "Container shop-web-1", status: "Done" }), /without text/);
  raises(z({ id: "Container shop-web-1", status: "Error", text: "SECRET" }), /status “Error”/);
  raises(z({ level: "error", msg: "SECRET", time: "t" }), /level error/);
});

test("compose-config dry-run and model calls; env_file from Compose's model, without values", () => {
  const k = composeConfig({ labels: compose("shop", "/ws/shop", "web", { "com.docker.compose.project.config_files": "/ws/shop/docker-compose.yml" }) });
  assert.deepEqual(upDryrunArgs(k, ["db", "web", "db"]), ["compose", "--progress", "json", "--dry-run", ...k.args, "up", "--no-start", "--no-build", "--pull", "never", "db", "web"]);
  assert.deepEqual(upDryrunArgs(k, ["web"], { allNew: true }), ["compose", "--progress", "json", "--dry-run", ...k.args, "up", "--no-start", "--no-build", "--pull", "never", "--force-recreate", "web"]);
  assert.throws(() => upDryrunArgs(k, []), (e) => e.code === "NO_SERVICES");
  assert.throws(() => upDryrunArgs(k, ["--build"]), (e) => e.code === "LABEL_INVALID");
  assert.deepEqual(configModelArgs(k), ["compose", ...k.args, "--profile", "*", "config", "--format", "json", "--no-interpolate", "--no-env-resolution"]);
  // The shape with --no-interpolate: list `{ path, required }`; also as text or from an anchor.
  const model = { name: "shop", services: {
    including: { image: "a", env_file: [{ path: "/ws/shop/x.env", required: true }] }, text: { image: "a", env_file: "./y.env" },
    empty: { image: "a", env_file: [] }, without: { image: "a", environment: { B: "2" } }, nothing: null,
  } };
  assert.deepEqual([...servicesWithEnvFile(JSON.stringify(model))].sort(), ["including", "text"]);
  assert.throws(() => servicesWithEnvFile("services:\n  with: {}\n"), (e) => e.code === "MODEL_UNREADABLE");
  assert.throws(() => servicesWithEnvFile(JSON.stringify({ name: "shop" })), (e) => e.code === "MODEL_UNREADABLE");
  assert.throws(() => servicesWithEnvFile(JSON.stringify({ services: [] })), (e) => e.code === "MODEL_UNREADABLE");
});

// ── One-off container, digest, driver_opts ─────────────────────────────────────────────────────────────────────────

test("a one-off container stays in B - no service, no start order, no anonymous volume, no image; named as a hint", () => {
  const t = tree();
  try {
    const P = t.p("ws/orbit");
    // Without the bait DEPOSIT (hold reason of another test); a left-over `compose run` without --rm with its own anonymous
    // volume (image VOLUME of postgres) and its own image that nobody else uses.
    const withoutDeposit = (x) => ({ env: x.env.map((f) => ({ ...f, entries: f.entries && f.entries.filter((e) => e.key !== "DEPOSIT") })) });
    const run = once("orbit-tool-run-1a2b3c4d5e6f", P, "tool", { image: "sha256:wz", ref: "utility:1", mounts: [vol(A("f"), "/var/lib/postgresql/data")] });
    const including = (d) => ({
      ...withoutDeposit(d),
      container: [...d.container, run],
      images: [...d.images, { Id: "sha256:wz", RepoTags: ["utility:1"], Size: 7e6 }],
      volumes: [...d.volumes, { Name: A("f"), Driver: "local", Labels: null, size: 9e6 }],
      diffs: { ...d.diffs, "id-orbit-tool-run-1a2b3c4d5e6f": ["A /var/lib/data.db"] }, // stays in B: no write-layer question
    });
    const without = planRelocation(data(t, withoutDeposit));
    const plan = planRelocation(data(t, including));
    assert.deepEqual(plan.holdReasons, [], JSON.stringify(plan.holdReasons));
    const c = plan.container.find((x) => x.name === "orbit-tool-run-1a2b3c4d5e6f");
    assert.equal(c?.oneoff, true, "the one-off container is in the plan (the procedure stops, reports and leaves it)");
    assert.deepEqual(plan.compose.map((g) => g.services), without.compose.map((g) => g.services), "no service `utility` for `up --no-start`");
    assert.deepEqual(plan.compose.map((g) => g.container), without.compose.map((g) => g.container));
    assert.deepEqual(plan.startFollowUp, without.startFollowUp);
    assert.deepEqual(plan.volumes, without.volumes, "its anonymous volume does not move along (step 12 would find no container inside)");
    assert.deepEqual(plan.images, without.images, "its image does not move along");
    assert.deepEqual([plan.slot, plan.downtime.seconds], [without.slot, without.downtime.seconds]);
    const h = plan.hints.filter((x) => x.kind === "once-container");
    assert.deepEqual(h.map((x) => [x.container, x.state, x.anonym]), [["orbit-tool-run-1a2b3c4d5e6f", "exited", [A("f")]]]);

    // If it runs, the plan holds (step 4 would stop it, it would be left stopped behind); if it uses a named volume that
    // moves, likewise - also one that would move only through its Compose label (withoutContainer).
    const running = planRelocation(data(t, (d) => ({ ...including(d), container: [...d.container, { ...run, State: { Status: "running", ExitCode: 0 } }] })));
    assert.deepEqual(running.holdReasons.map((x) => [x.kind, x.container]), [["once-container-running", "orbit-tool-run-1a2b3c4d5e6f"]]);
    const atVolume = planRelocation(data(t, (d) => ({ ...including(d), container: [...d.container, { ...run, Mounts: [vol("orbit_pgdata", "/p")] }] })));
    assert.deepEqual(atVolume.holdReasons.map((x) => [x.kind, x.volume, x.container]), [["once-container-volume", "orbit_pgdata", ["orbit-tool-run-1a2b3c4d5e6f"]]]);
    const onlyLabel = planRelocation(data(t, (d) => ({
      ...including(d), container: [...d.container, { ...run, Mounts: [vol("orbit_utilitydata", "/w")] }],
      volumes: [...including(d).volumes, { Name: "orbit_utilitydata", Driver: "local", Labels: { "com.docker.compose.project": "orbit", "com.docker.compose.volume": "utilitydata" }, size: 1 }],
    })));
    assert.deepEqual(onlyLabel.holdReasons.map((x) => [x.kind, x.volume]), [["once-container-volume", "orbit_utilitydata"]]);
    // A named volume that does NOT move (no label of the project, only the one-off container uses it) stays with it.
    const stays = planRelocation(data(t, (d) => ({
      ...including(d), container: [...d.container, { ...run, Mounts: [vol("tool-cache", "/w")] }],
      volumes: [...including(d).volumes, { Name: "tool-cache", Driver: "local", Labels: {}, size: 1 }],
    })));
    assert.deepEqual(stays.holdReasons, []);
    assert.ok(!stays.volumes.named.some((v) => v.name === "tool-cache"));
  } finally { t.cleanUp(); }
});

test("an image named by digest holds in the PLAN (not only step 5 after the downtime); no plan without a hold reason has an image without a tag", () => {
  const t = tree();
  try {
    const D = `postgres@sha256:${A("e")}`;
    const withoutDeposit = (x) => ({ env: x.env.map((f) => ({ ...f, entries: f.entries && f.entries.filter((e) => e.key !== "DEPOSIT") })) });
    // The real shape: `image: postgres@sha256:...`, pulled by digest, RepoTags empty.
    const digest = (tags) => (d) => ({
      ...withoutDeposit(d),
      container: d.container.map((c) => (["/orbit-db-1", "/orbit-migrate-1"].includes(c.Name) ? { ...c, Config: { ...c.Config, Image: D } } : c)),
      images: d.images.map((i) => (i.Id === "sha256:pg" ? { ...i, RepoTags: tags, RepoDigests: [D] } : i)),
    });
    for (const tags of [[], ["postgres:16-alpine"]]) {
      const plan = planRelocation(data(t, digest(tags)));
      assert.equal(plan.canRelocate, false, `RepoTags ${JSON.stringify(tags)}: no hold reason`);
      assert.deepEqual(plan.holdReasons.map((h) => [h.kind, h.container]), [["image-digest", "orbit-db-1"], ["image-digest", "orbit-migrate-1"]]);
    }
    // The promise step 5 needs: a plan that may relocate carries only images with a tag.
    for (const change of [withoutDeposit, digest([]), (d) => ({ ...withoutDeposit(d), images: d.images.map((i) => (i.Id === "sha256:app1" ? { ...i, RepoTags: [] } : i)) })]) {
      const plan = planRelocation(data(t, change));
      if (plan.canRelocate) assert.deepEqual(plan.images.filter((i) => !i.tags.length), [], "an image without a tag in a plan without a hold reason");
    }
  } finally { t.cleanUp(); }
});

test("a local volume with driver_opts holds - on the container and through the Compose label; the plan carries only the keys", () => {
  const t = tree();
  try {
    const withOpt = (name, options) => (d) => ({ volumes: d.volumes.map((v) => (v.Name === name ? { ...v, options } : v)) });
    const withOptions = planRelocation(data(t, withOpt("orbit_pgdata", ["device", "o", "type"])));
    assert.deepEqual(withOptions.holdReasons.filter((h) => h.kind === "volume-options").map((h) => [h.volume, h.options]), [["orbit_pgdata", ["device", "o", "type"]]]);
    // A volume only through the label of the project (no container) - this path must check the driver as well.
    const withoutContainer = (options, Driver = "local") => (d) => ({
      volumes: [...d.volumes, { Name: "orbit_deposit", Driver, Labels: { "com.docker.compose.project": "orbit", "com.docker.compose.volume": "deposit" }, options, size: 1 }],
    });
    assert.deepEqual(planRelocation(data(t, withoutContainer(["type"]))).holdReasons.filter((h) => h.kind === "volume-options").map((h) => h.volume), ["orbit_deposit"]);
    assert.deepEqual(planRelocation(data(t, withoutContainer(undefined, "nfs"))).holdReasons.filter((h) => h.kind === "volume-driver").map((h) => h.volume), ["orbit_deposit"]);
    // Without options no hold reason of this kind.
    assert.ok(!kinds(planRelocation(data(t, withoutContainer([]))).holdReasons).includes("volume-options"));
  } finally { t.cleanUp(); }
});

// ── Containers of cbase only by EXACTLY its own keys, set ON the container ─────────────────────────────────────────────
//
// A container inherits the labels of its image: an image with `LABEL cbase.acceptance=...` must not make half of the
// relocation set invisible (relocation possible with one container, volumes "withoutContainer" on running containers).
// Counter-proof: without the list of own keys (own-labels.js) the first test fails at the import, the second at the missing
// containers, the third at the missing hold reason.

// Like real docker: `Config.Labels` = image labels ∪ own (own win).
const inherited = (c, imageLabels) => ({ ...c, Config: { ...c.Config, Labels: { ...imageLabels, ...c.Config.Labels } } });

test("OWN_LABELS is exactly the union of the keys cbase sets - and the Dockerfile sets none on the image", () => {
  const { OWN_LABELS, LABEL_RELOCATION, ownKey, isOwnContainer, labelsFromSegments } = ownLabels;
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
  // The deploy probe label (pure module tools/check/lib/projectbox-plan.mjs).
  const probe = /^([a-z.]+)=/.exec(PROBE_LABEL);
  assert.ok(probe, "PROBE_LABEL no longer has the form key=value - adjust the guard");
  // The keys of a real helper start, as helper.js sets them (with the relocation addition).
  const args = helper.helperArgs({ kind: "relocation", projectId: "p1", labels: { [LABEL_RELOCATION]: "1" } });
  const helperKey = args.flatMap((a, i) => (a === "--label" ? [String(args[i + 1]).split("=")[0]] : []));
  // The keys of a real creation of the main one, as creation.js sets them (including cbase.mounts.v2 - a new label on the
  // project container missing here would make the relocation take it for foreign).
  const run = creation.creationArgs({ projectId: "p1", network: { hostname: "p1.cbase", ip: "10.230.0.2" }, image: "sha256:x", mounts: [],
    hash: "a".repeat(64), hashV1: "b".repeat(64), cliHome: "/c" });
  // Plus the keys of a copy creation (cbase.chat is carried only by a copy).
  const runCopy = creation.creationArgs({ projectId: "p1", instance: "copy-k1", chatId: "chat-1", network: { hostname: "k1.p1.cbase", ip: "10.230.1.2" },
    image: "sha256:x", mounts: [], hash: "a".repeat(64), hashV1: "b".repeat(64), cliHome: "/c" });
  const creationKey = [...run, ...runCopy].flatMap((a, i, all) => (a === "--label" ? [String(all[i + 1]).split("=")[0]] : []));
  assert.ok(creationKey.includes(creation.LABEL_MOUNTS_V2), JSON.stringify(creationKey));
  assert.ok(creationKey.includes(creation.LABEL_CHAT), JSON.stringify(creationKey));
  const desired = new Set([creation.LABEL_PROJECT, creation.LABEL_INSTANCE, creation.LABEL_MOUNTS, creation.LABEL_MOUNTS_V2, helper.LABEL_HELPER, helper.LABEL_HELPER_PROJECT,
    helper.LABEL_HELPER_INSTANCE, helper.LABEL_HELPER_RUN, ...helperKey, ...creationKey, probe[1]]);
  assert.deepEqual([...OWN_LABELS].sort(), [...desired].sort());
  assert.ok(helper.FOREIGN_LABELS.every((k) => OWN_LABELS.includes(k)), "the keys of the project containers are in the list");
  // "cbase never sets its labels on the image" - the precondition for an inherited key not to count.
  const dockerfile = fs.readFileSync(path.join(repo, "server/backend/Dockerfile"), "utf8");
  assert.ok(!setsCbaseLabel(dockerfile), "the Dockerfile sets a cbase. label on the image");
  // The ONE exception on the image: the source of the project box, set by `docker build --label` - every project container
  // inherits it. It must never be an own key, otherwise an inherited value would count as "own".
  const source = [SOURCE_LABEL, SOURCE_LABEL];
  assert.ok(!OWN_LABELS.includes(source[1]), `${source[1]} is in OWN_LABELS`);
  assert.deepEqual(ownKey({ [source[1]]: "a".repeat(64), "cbase.project": "p1" }, { [source[1]]: "a".repeat(64) }), ["cbase.project"]);
  // The rule: set on the container counts, inherited from the image (same value) does not; another value on the container
  // counts; an unknown image (null) lets the key count alone; foreign cbase. keys never count.
  assert.deepEqual(ownKey({ "cbase.helper": "relocation" }, {}), ["cbase.helper"]);
  assert.deepEqual(ownKey({ "cbase.helper": "relocation" }, { "cbase.helper": "relocation" }), []);
  assert.deepEqual(ownKey({ "cbase.project": "p2" }, { "cbase.project": "p1" }), ["cbase.project"]);
  assert.deepEqual(ownKey({ "cbase.probe": "1" }, null), ["cbase.probe"]);
  assert.equal(isOwnContainer({ "cbase.acceptance": "s1-26", "cbase.anything": "x", "cbase.projectRepo": "true" }, null), false);
  assert.deepEqual(labelsFromSegments("a=1,cbase.helper=relocation,empty"), { a: "1", "cbase.helper": "relocation", empty: "" });
});

test("an image label cbase.* (also an own key, inherited) and a foreign cbase. key on the container take none out of the plan", () => {
  const t = tree();
  try {
    const clean = (x) => ({ env: x.env.map((f) => ({ ...f, entries: f.entries && f.entries.filter((e) => e.key !== "DEPOSIT") })) });
    const imagePg = { "cbase.acceptance": "s1-26", "cbase.anything": "yes" };
    const imagePy = { "cbase.project": "foreign", "cbase.helper": "relocation" }; // own keys, but only from the image
    const d = data(t, (x) => ({
      ...clean(x),
      images: x.images.map((i) => (i.Id === "sha256:pg" ? { ...i, Labels: imagePg } : i.Id === "sha256:py" ? { ...i, Labels: imagePy } : { ...i, Labels: {} })),
      container: x.container.map((c) => (c.Image === "sha256:pg" ? inherited(c, imagePg) : c.Image === "sha256:py" ? inherited(c, imagePy) : c))
        .map((c) => (c.Name === "/orbit-spare-1" ? { ...c, Config: { ...c.Config, Labels: { ...c.Config.Labels, "cbase.anything": "on-container" } } } : c)),
    }));
    const plan = planRelocation(d);
    assert.deepEqual(names(plan), ["orbit-app-1", "orbit-db-1", "orbit-extra-1", "orbit-files-1", "orbit-migrate-1", "orbit-spare-1"], "all six - never without db, files, migrate, spare");
    assert.deepEqual(plan.holdReasons, [], JSON.stringify(plan.holdReasons));
    assert.deepEqual(plan.volumes.named.map((v) => [v.name, v.container, v.withoutContainer]), [["orbit_pgdata", ["orbit-db-1"], false]], "pgdata WITH its container, not \"withoutContainer\"");
    // Without `Labels` on the image (older caller) the own key counts alone: files drops out - and holds, because its
    // working_dir lies in the project (never silent).
    const withoutImage = planRelocation({ ...d, images: d.images.map(({ Labels, ...i }) => i) });
    assert.ok(!names(withoutImage).includes("orbit-files-1"));
    assert.ok(withoutImage.holdReasons.some((h) => h.kind === "container-excluded" && h.container === "orbit-files-1" && h.workingDirInProject), JSON.stringify(withoutImage.holdReasons));
    assert.ok(names(withoutImage).includes("orbit-db-1"), "a foreign cbase. key never takes out - also without image labels");
  } finally { t.cleanUp(); }
});

test("a container of cbase (label ON the container) stays out - on a volume of the plan or with working_dir in the project the plan holds", () => {
  const t = tree();
  try {
    const P = t.p("ws/orbit");
    const clean = (x) => ({ env: x.env.map((f) => ({ ...f, entries: f.entries && f.entries.filter((e) => e.key !== "DEPOSIT") })) });
    const oldHelper = ctr("cbase-helper-relocation-old", { labels: { "cbase.helper": "relocation", "cbase.helper.project": "p1", "cbase.relocation": "7" }, mounts: [vol("orbit_pgdata", "/src"), vol(A("c"), "/src2")] });
    const marked = ctr("orbit-worker-1", { labels: compose("orbit", P, "worker", { "cbase.project": "q" }) });
    const probe = ctr("probe-1", { labels: { "cbase.probe": "1" }, image: "sha256:gone" }); // image unknown, nothing mounted
    const plan = planRelocation(data(t, (x) => ({ ...clean(x), container: [...x.container, oldHelper, marked, probe] })));
    for (const n of ["cbase-helper-relocation-old", "orbit-worker-1", "probe-1", "cbase-p-p1"]) assert.ok(!names(plan).includes(n), `${n} in the plan`);
    const result = plan.holdReasons.filter((h) => h.kind === "container-excluded").map((h) => [h.container, h.labels, h.volumes, h.workingDirInProject]);
    assert.deepEqual(result, [
      ["cbase-helper-relocation-old", ["cbase.helper", "cbase.helper.project", "cbase.relocation"], [A("c"), "orbit_pgdata"].sort(), false],
      ["orbit-worker-1", ["cbase.project"], [], true],
    ], "name, keys and reason per left-out container; the project container without a plan volume and the probe without mounts do not hold");
    assert.equal(plan.canRelocate, false);
  } finally { t.cleanUp(); }
});
test("a mount point that dockerd creates in the write layer is no data - data beside it still holds", () => {
  const t = tree();
  try {
    const exists = (p) => fs.existsSync(p);
    // Verbatim as at a real dockerd (`A /data`, `A /conf`); orbit-files-1 mounts /data and /conf, plus a nested target whose
    // missing parent folder was created along.
    const withDiff = (rows, extra = []) => (d) => ({
      container: d.container.map((c) => (c.Name === "/orbit-files-1" ? { ...c, Mounts: [...c.Mounts, ...extra] } : c)),
      diffs: { ...d.diffs, "id-orbit-files-1": rows },
    });
    const onlyPoints = planRelocation(data(t, withDiff(["A /data", "A /conf", "A /srv", "A /srv/deposit"], [vol("orbit_pgdata", "/srv/deposit")])), { exists });
    assert.ok(!kinds(onlyPoints.holdReasons).includes("writeLayer"), `mount points held: ${JSON.stringify(onlyPoints.holdReasons.filter((h) => h.kind === "writeLayer"))}`);
    const withData = planRelocation(data(t, withDiff(["A /data", "A /conf", "C /usr", "C /usr/local", "A /usr/local/x.pyc", "A /datax"])), { exists });
    const h = withData.holdReasons.find((x) => x.kind === "writeLayer");
    assert.ok(h, "data beside the mount points holds");
    assert.deepEqual(h.examples, ["/datax", "/usr/local/x.pyc"], "only the data, no mount point; /datax is not under /data (separator)");
    // The bytecode cache that Python rewrites at every container start is no data; a .pyc outside __pycache__ and a file
    // in it that is no .pyc remain data.
    const pyc = ["C /usr", "C /usr/local", "C /usr/local/lib", "C /usr/local/lib/python3.12", "C /usr/local/lib/python3.12/encodings",
      "C /usr/local/lib/python3.12/encodings/__pycache__", "A /usr/local/lib/python3.12/encodings/__pycache__/__init__.cpython-312.pyc",
      "A /usr/local/lib/python3.12/encodings/__pycache__/utf_8.cpython-312.pyc", "A /app/__pycache__", "A /app/__pycache__/main.cpython-312.pyc"];
    const onlyPyc = planRelocation(data(t, withDiff(["A /data", "A /conf", ...pyc])), { exists });
    assert.ok(!kinds(onlyPyc.holdReasons).includes("writeLayer"), `bytecode cache held: ${JSON.stringify(onlyPyc.holdReasons.filter((x) => x.kind === "writeLayer"))}`);
    const pycBeside = planRelocation(data(t, withDiff([...pyc, "A /app/__pycache__/note.txt", "A /app/old.pyc"])), { exists });
    assert.deepEqual(pycBeside.holdReasons.find((x) => x.kind === "writeLayer")?.examples, ["/app/__pycache__/note.txt", "/app/old.pyc"]);
  } finally { t.cleanUp(); }
});

// MinIO creates empty folders `$HOME/.minio/certs/CAs` at every start (measured at a real dockerd) - no data; a certificate in or beside it remains one.
test("the empty certificate folder that MinIO creates at every start is no data - a certificate in it still holds", () => {
  const t = tree();
  try {
    const exists = (p) => fs.existsSync(p);
    const withDiff = (rows) => (d) => ({ diffs: { ...d.diffs, "id-orbit-files-1": rows } });
    // Verbatim as at a real dockerd (two starts alike).
    const minio = ["C /root", "A /root/.minio", "A /root/.minio/certs", "A /root/.minio/certs/CAs"];
    const only = planRelocation(data(t, withDiff(minio)), { exists });
    assert.ok(!kinds(only.holdReasons).includes("writeLayer"), JSON.stringify(only.holdReasons.filter((h) => h.kind === "writeLayer")));
    const withCa = planRelocation(data(t, withDiff([...minio, "A /root/.minio/certs/CAs/company-ca.crt", "A /root/.minio/certs/public.crt"])), { exists });
    assert.deepEqual(withCa.holdReasons.find((h) => h.kind === "writeLayer")?.examples, ["/root/.minio/certs/CAs/company-ca.crt", "/root/.minio/certs/public.crt"]);
  } finally { t.cleanUp(); }
});

// In B almost no volume carried a Compose label. Without ANY Compose label and mounted only by containers of ONE Compose project
// of the relocation => moves along (hint, `withoutLabel` on the row; the dry run checks the model); otherwise volume-extern.
test("a volume without a Compose label that only one Compose project of the relocation mounts moves along (hint) - with a foreign Compose label, half a Compose label or two projects it holds", () => {
  const t = tree();
  try {
    const withLabels = (labels, extra = []) => (d) => ({
      volumes: d.volumes.map((v) => (v.Name === "orbit_pgdata" ? { ...v, Labels: labels } : v)),
      container: [...d.container, ...extra],
    });
    const row = (plan) => plan.volumes.named.find((v) => v.name === "orbit_pgdata");
    for (const labels of [{}, null, { "de.company.backup": "daily" }]) {
      const plan = planRelocation(data(t, withLabels(labels)));
      assert.ok(!plan.holdReasons.some((h) => h.kind === "volume-extern"), `${JSON.stringify(labels)}: ${JSON.stringify(plan.holdReasons.filter((h) => h.kind === "volume-extern"))}`);
      assert.deepEqual(plan.hints.filter((h) => h.kind === "volume-without-label").map((h) => [h.volume, h.project]), [["orbit_pgdata", "orbit"]]);
      assert.equal(row(plan)?.withoutLabel, "orbit");
      assert.deepEqual(row(plan)?.labels, labels || {});
    }
    // With Compose label (own project): no mark, no hint.
    const own = planRelocation(data(t));
    assert.equal(row(own)?.withoutLabel, undefined);
    assert.ok(!own.hints.some((h) => h.kind === "volume-without-label"));
    // Foreign Compose label, a half one (only `volume`), or two Compose projects of the relocation on the same volume: volume-extern.
    const P = t.p("ws/orbit");
    const werk = ctr("other-db-1", { labels: compose("other", P, "db"), image: "sha256:pg", ref: "postgres:16-alpine", mounts: [vol("orbit_pgdata", "/w")], networks: ["other_default"] });
    for (const [labels, extra] of [[{ "com.docker.compose.project": "different" }, []], [{ "com.docker.compose.volume": "pgdata" }, []], [{}, [werk]]]) {
      const plan = planRelocation(data(t, withLabels(labels, extra)));
      assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "volume-extern").map((h) => h.volume), ["orbit_pgdata"], JSON.stringify([labels, extra.length]));
      assert.equal(row(plan)?.withoutLabel, undefined);
    }
  } finally { t.cleanUp(); }
});

test("receipts lift exactly the hold reason of the same kind, container, count and checksum - only the write layer", () => {
  assert.deepEqual(ACKNOWLEDGEABLE, ["writeLayer"]);
  const h = [
    { kind: "writeLayer", text: "x", container: "audit-serve", count: 3490, checksum: "aaaa", folder: [{ path: "/app/.venv/lib", count: 3489 }], examples: ["/app/.venv/bin/coverage"] },
    { kind: "writeLayer", text: "x", container: "audit-persist", count: 1055, checksum: "bbbb", folder: [], examples: [] },
    { kind: "volume-extern", text: "y", volume: "v", project: null },
  ];
  const q = (kind, container, count, checksum) => ({ kind, container, count, checksum });
  const r = applyReceipts(h, [q("writeLayer", "audit-serve", 3490, "aaaa")]);
  assert.deepEqual(r.dismissed, [{ kind: "writeLayer", container: "audit-serve", count: 3490, checksum: "aaaa", folder: [{ path: "/app/.venv/lib", count: 3489 }], examples: ["/app/.venv/bin/coverage"] }]);
  assert.deepEqual(r.open.map((x) => x.container || x.volume), ["audit-persist", "v"]);
  assert.deepEqual(r.mismatched, []);
  // Wrong count, wrong or missing checksum, wrong name, a kind that cannot be acknowledged: mismatched, nothing lifted.
  const f = applyReceipts(h, [q("writeLayer", "audit-serve", 3491, "aaaa"), q("writeLayer", "audit-serve", 3490, "aaab"),
    { kind: "writeLayer", container: "audit-serve", count: 3490 }, q("writeLayer", "audit-servex", 3490, "aaaa"), q("volume-extern", "v", 0, "x")]);
  assert.deepEqual(f.dismissed, []);
  assert.equal(f.open.length, 3);
  assert.equal(f.mismatched.length, 5);
  const d = applyReceipts(h, [q("writeLayer", "audit-serve", 3490, "aaaa"), q("writeLayer", "audit-serve", 3490, "aaaa")]);
  assert.equal(d.dismissed.length, 1);
  assert.equal(d.mismatched.length, 1);
  assert.deepEqual(applyReceipts(h, undefined), { open: h, dismissed: [], mismatched: [] });
  assert.equal(applyReceipts(h, [q("writeLayer", "audit-serve", "3490", "aaaa")]).mismatched.length, 1);
});

// Five examples hid a real file behind `.venv`; the hold reason counts EVERY path by folder and carries a checksum over the
// whole sorted list.
test("the write layer names every folder with a count and a checksum over the whole list - the file behind .venv stays visible", () => {
  const t = tree();
  try {
    const venv = Array.from({ length: 12 }, (_, i) => `A /app/.venv/lib/python3.12/site-packages/p${String(i).padStart(2, "0")}.py`);
    const rows = ["C /app", "A /app/.venv", ...venv, "A /app/instance", "A /app/instance/app.db", "A /root/.cache/uv/x"];
    const plan = planRelocation(data(t, (d) => ({ diffs: { ...d.diffs, "id-orbit-files-1": rows } })), { exists: (p) => fs.existsSync(p) });
    const h = plan.holdReasons.find((x) => x.kind === "writeLayer");
    assert.equal(h.count, 14);
    assert.ok(h.examples.every((b) => b.startsWith("/app/.venv/")), "the five examples are all from .venv - the reason for the counting");
    assert.deepEqual(h.folder, [{ path: "/app/.venv/lib", count: 12 }, { path: "/app/instance", count: 1 }, { path: "/root/.cache/uv", count: 1 }]);
    const paths = [...venv.map((z) => z.slice(2)), "/app/instance/app.db", "/root/.cache/uv/x"].sort();
    assert.equal(h.checksum, writeLayerChecksum(paths));
    assert.notEqual(h.checksum, writeLayerChecksum(paths.filter((p) => p !== "/app/instance/app.db")), "the checksum sees the file behind .venv");
    assert.deepEqual(writeLayerFolder(["/datax", "/a/b"]), [{ path: "/a", count: 1 }, { path: "/datax", count: 1 }]);
  } finally { t.cleanUp(); }
});

// A process in B whose working dir lies in the project and which step 4 does not end holds - with pid, program and start
// time; one in a terminal that the lock ends is a hint; a MISSING field is unknown (data-missing), never "none".
test("a process in the project folder holds (pid, program, start), one in the lock's terminal is a hint, without the field data-missing", () => {
  const t = tree();
  try {
    const exists = (p) => fs.existsSync(p);
    const plan = planRelocation(data(t, { processes: [
      { pid: 7289, start: "proc:4242", program: "node" },
      { pid: 7300, start: "proc:4300", program: "npm", terminal: "proj:p1" },
    ] }), { exists });
    assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "process-in-project").map(({ kind, pid, program, start }) => ({ kind, pid, program, start })),
      [{ kind: "process-in-project", pid: 7289, program: "node", start: "proc:4242" }]);
    assert.deepEqual(plan.hints.filter((h) => h.kind === "process-in-terminal").map(({ pid, program, terminal }) => ({ pid, program, terminal })),
      [{ pid: 7300, program: "npm", terminal: "proj:p1" }]);
    assert.ok(!plan.holdReasons.some((h) => h.pid === 7300), "the process in the lock's terminal holds");
    assert.equal(plan.canRelocate, false);
    // Only hints: the plan can relocate if nothing else holds (base without processes).
    const onlyTerminal = planRelocation(data(t, { processes: [{ pid: 7300, start: "proc:4300", program: "npm", terminal: "chat:c1" }] }), { exists });
    assert.ok(!kinds(onlyTerminal.holdReasons).includes("process-in-project"));
    assert.ok(kinds(onlyTerminal.hints).includes("process-in-terminal"));
    // Unknown is not empty: without the field the plan holds with data-missing.
    const without = planRelocation(data(t, (d) => { const { processes, ...rest } = d; return { ...rest, processes: undefined }; }), { exists });
    assert.ok(without.holdReasons.some((h) => h.kind === "data-missing" && h.what === "processes"), JSON.stringify(without.holdReasons.filter((h) => h.kind === "data-missing")));
    const empty = planRelocation(data(t), { exists });
    assert.ok(!empty.holdReasons.some((h) => h.kind === "data-missing" && h.what === "processes"), "counter-proof: [] is known");
  } finally { t.cleanUp(); }
});

// ── Follow-up fixes of the audit ─────────────────────────────────────────────────────────────────────────────────────
// Counter-tests: with an older plan.js each of the tests below is red (the test "a cbase. label in a continuation line"
// carries the old regex as a built-in counter-proof; the new cases of the table "every hold reason ..." likewise). Sabotage
// at the product: `imagesMBs: 20` turns the downtime-rate test red; dropping the check of the anonymous volumes turns the
// anonymous-volume test red; `const target = Number(d.port)` turns the port-collision test red; dropping
// `.filter((p) => p === Number(d.port))` turns the tunnel test red.

const withoutDeposit = (x) => ({ env: x.env.map((f) => ({ ...f, entries: f.entries && f.entries.filter((e) => e.key !== "DEPOSIT") })) });

test("the downtime estimate takes the ≈ 13 MB/s for images measured at the ORBIT relocation - 9.0 GB => ≥ 690 s", () => {
  const t = tree();
  try {
    const plan = planRelocation(data(t, (d) => ({ images: d.images.map((i) => (i.Id === "sha256:pg" ? { ...i, Size: 9.0e9 } : i)) })));
    assert.ok(plan.downtime.parts.images >= 690, `parts.images ${plan.downtime.parts.images}`);
    assert.equal(RATES.imagesMBs, 13);
  } finally { t.cleanUp(); }
});

test("if `tracked` or `untrackedCompose` is missing (git ls-files failed), the plan holds with data-missing - never \"none\"", () => {
  const t = tree();
  try {
    for (const field of ["tracked", "untrackedCompose"]) {
      const plan = planRelocation(data(t, (d) => { const x = { ...d, ...withoutDeposit(d) }; delete x[field]; return { ...x, [field]: undefined }; }));
      assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "data-missing").map((h) => h.what), [field], JSON.stringify(plan.holdReasons));
      assert.equal(plan.canRelocate, false);
    }
    assert.deepEqual(planRelocation(data(t, withoutDeposit)).holdReasons, [], "counter-proof: with both fields no hold reason");
  } finally { t.cleanUp(); }
});

test("an anonymous volume of a plan container that a container outside or a one-off container mounts holds", () => {
  const t = tree();
  try {
    const P = t.p("ws/orbit");
    const shared = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), container: d.container.map((c) => (c.Name === "/foreign-1" ? { ...c, Mounts: [vol(A("a"), "/inherited")] } : c)) })));
    assert.deepEqual(shared.holdReasons.map((h) => [h.kind, h.volume, h.outside]), [["volume-shared", A("a"), ["foreign-1"]]]);
    const run = once("orbit-db-run-1a2b3c4d5e6f", P, "db", { mounts: [vol(A("b"), "/var/lib/postgresql/data")] });
    const withOnce = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), container: [...d.container, run], diffs: { ...d.diffs, [run.Id]: [] } })));
    assert.deepEqual(withOnce.holdReasons.map((h) => [h.kind, h.volume, h.container]), [["once-container-volume", A("b"), ["orbit-db-run-1a2b3c4d5e6f"]]]);
    assert.match(ENTRIES["volume-shared"].text, /named or anonymous/);
  } finally { t.cleanUp(); }
});

test("portsInCommand is the rule of the dismantling - `-p 3100:3000` is no override, one in quotes is; only the registered port is counted", () => {
  assert.deepEqual(portsInCommand("docker run -p 3100:3000 img"), []);
  assert.deepEqual(portsInCommand('sh -c "next dev -p 3100"'), [3100]);
  assert.deepEqual(portsInCommand("bash -lc 'npm run dev -- --port=3100'"), [3100]);
  const t = tree();
  try {
    const plan = planRelocation(data(t, { services: [
      { id: 1, name: "tunnel", port: 5432, dir: "", startCommand: "ssh -N -p 2222 -L 5432:db:5432 host" },
      { id: 2, name: "shop", port: 3100, dir: "", startCommand: "docker run --rm -p 3100:3000 shop-web" },
    ] }));
    assert.deepEqual(plan.dismantling.services, [], "an ssh -p 2222 of a tunnel on 5432 and a docker mapping are no override of the service");
    assert.ok(!plan.hints.some((h) => h.kind === "service-port-unknown"), JSON.stringify(plan.hints.filter((h) => h.kind === "service-port-unknown")));
  } finally { t.cleanUp(); }
});

test("two services that the dismantling would set to the same port hold (service-port-collision) - one that stays does not", () => {
  const t = tree();
  try {
    const two = [{ id: 1, name: "a", port: 3001, dir: "a", startCommand: "next dev -p 3001" }, { id: 2, name: "b", port: 3002, dir: "b", startCommand: "next dev -p 3002" }];
    const plan = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), services: two })));
    assert.deepEqual(plan.holdReasons.map((h) => [h.kind, h.port, h.services]), [["service-port-collision", 3000, ["a", "b"]]]);
    // b stays on 3002 (start script names 3002 - the default IS today's port): no collision.
    const stays = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), services: two, startScripts: { [t.p("ws/orbit/b")]: { dev: "next dev -p 3002" } } })));
    assert.deepEqual(stays.holdReasons, [], JSON.stringify(stays.holdReasons));
  } finally { t.cleanUp(); }
});

// Counter-proof with an older plan.js: the three tests below are red (one hold for two services already on 3000 in B; no hold
// at the container port; no `incomplete`).

test("two services that already carry the same port in B (no dismantling) do not hold - only one that the dismantling adds", () => {
  const t = tree();
  try {
    const two = [{ id: 1, name: "web-dev", port: 3000, dir: "web", startCommand: "next dev" }, { id: 2, name: "web-preview", port: 3000, dir: "web", startCommand: "next start" }];
    const plan = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), services: two })));
    assert.deepEqual(plan.dismantling.services, [], "no dismantling");
    assert.deepEqual(plan.holdReasons, [], JSON.stringify(plan.holdReasons));
    assert.equal(plan.canRelocate, true);
    // A third one that the dismantling moves from 3100 to 3000 CREATES the collision - all three are in the hold reason.
    const three = [...two, { id: 3, name: "web-new", port: 3100, dir: "fresh", startCommand: "next dev -p 3100" }];
    const including = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), services: three })));
    assert.deepEqual(including.holdReasons.map((h) => [h.kind, h.port, h.services, h.container]), [["service-port-collision", 3000, ["web-dev", "web-new", "web-preview"], undefined]]);
  } finally { t.cleanUp(); }
});

test("a service that the dismantling sets to the published port of a container that moves along holds - not without dismantling, not at a one-off container, not at its own container", () => {
  const t = tree();
  try {
    const P = t.p("ws/orbit");
    const port3000 = (c) => ({ ...c, HostConfig: { ...c.HostConfig, PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] } } });
    const on3000 = (d) => d.container.map((c) => (c.Name === "/orbit-app-1" ? port3000(c) : c));
    const native = { id: 1, name: "web", port: 3100, dir: "", startCommand: "next dev -p 3100" };
    const plan = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), container: on3000(d), services: [native] })));
    assert.deepEqual(plan.dismantling.services.map((r) => [r.name, r.portOld, r.portStandard]), [["web", 3100, 3000]]);
    assert.deepEqual(plan.holdReasons.map((h) => [h.kind, h.port, h.services, h.container]), [["service-port-collision", 3000, ["web"], ["orbit-app-1"]]]);
    // Without dismantling (the service already stands on 3000 in B next to the container): no hold.
    const already = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), container: on3000(d), services: [{ ...native, port: 3000, startCommand: "next dev" }] })));
    assert.deepEqual(already.holdReasons, [], JSON.stringify(already.holdReasons));
    // The container as a registered service: its port stands ONCE (as a service), the collision remains.
    const reg = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), container: on3000(d), services: [native, { id: 2, name: "app", port: 3000, dir: "", container: "orbit-app-1" }] })));
    assert.deepEqual(reg.holdReasons.map((h) => [h.kind, h.port, h.services, h.container]), [["service-port-collision", 3000, ["app", "web"], undefined]]);
    // A one-off container on 3000 stays in B (does not move along): no hold.
    const run = port3000(once("orbit-app-run-1a2b3c4d5e6f", P, "app"));
    const withOnce = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), container: [...d.container, run], diffs: { ...d.diffs, [run.Id]: [] }, services: [native] })));
    assert.ok(!withOnce.holdReasons.some((h) => h.kind === "service-port-collision"), JSON.stringify(withOnce.holdReasons));
  } finally { t.cleanUp(); }
});

test("if `runtimePrefilled` is missing (the check failed), the plan names `incomplete` - [] is known, only a hint", () => {
  const t = tree();
  try {
    const without = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), runtimePrefilled: undefined })));
    assert.deepEqual(without.hints.filter((h) => h.kind === "incomplete").map((h) => h.what), ["runtimePrefilled"]);
    assert.equal(without.canRelocate, true, "a missing hint does not hold");
    const empty = planRelocation(data(t, withoutDeposit));
    assert.deepEqual(empty.hints.filter((h) => h.kind === "incomplete"), [], "counter-proof: [] is known");
  } finally { t.cleanUp(); }
});

test("if the volume of the project container already exists in B, the plan holds (project-volume-existing)", () => {
  const t = tree();
  try {
    const plan = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), volumes: [...d.volumes, { Name: "cbase-p-p1-docker", Driver: "local", Labels: { "cbase.project": "p1" } }] })));
    assert.deepEqual(plan.holdReasons.map((h) => [h.kind, h.volume]), [["project-volume-existing", "cbase-p-p1-docker"]]);
    const other = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), volumes: [...d.volumes, { Name: "cbase-p-p2-docker", Driver: "local", Labels: {} }] })));
    assert.deepEqual(other.holdReasons, [], "the volume of another project does not count");
  } finally { t.cleanUp(); }
});

test("a plan container with `container:` coupling (network, IPC, PID) or volumes_from holds - only name and kind, no value", () => {
  const t = tree();
  try {
    const including = (hc) => planRelocation(data(t, (d) => ({ ...withoutDeposit(d), container: d.container.map((c) => (c.Name === "/orbit-app-1" ? { ...c, HostConfig: { ...c.HostConfig, ...hc } } : c)) })));
    const network = including({ NetworkMode: "container:id-orbit-db-1" });
    assert.deepEqual(network.holdReasons.map((h) => [h.kind, h.container, h.references]), [["service-reference", "orbit-app-1", ["NetworkMode"]]]);
    assert.equal(network.canRelocate, false);
    assert.ok(!JSON.stringify(network.holdReasons).includes("container:id-"), "the value of the coupling is in the plan");
    assert.deepEqual(including({ IpcMode: "container:x", PidMode: "container:y", VolumesFrom: ["id-orbit-db-1"] }).holdReasons.map((h) => h.references), [["IpcMode", "PidMode", "VolumesFrom"]]);
    assert.deepEqual(including({ NetworkMode: "orbit_default", IpcMode: "private", PidMode: "", VolumesFrom: [] }).holdReasons, [], "without coupling no hold reason");
  } finally { t.cleanUp(); }
});

test("a Compose variable that no .env sets but that is in the environment of B is a hint - only the name; without the field none", () => {
  const t = tree();
  try {
    const P = t.p("ws/orbit");
    const text = COMPOSE_TEXT.replace("      MODE: ${RELOCATION_MODE:-default}\n", '      MODE: ${RELOCATION_MODE:-default}\n      APP_PORT: "${PORT}"\n');
    const including = (extra) => planRelocation(data(t, (d) => ({ ...withoutDeposit(d), composeTexts: { [path.join(P, "docker-compose.yml")]: text }, ...extra })));
    const ages = process.env.PORT;
    process.env.PORT = "7718";
    try {
      const plan = including({ bEnvironmentNames: ["HOME", "PORT"] });
      assert.deepEqual(plan.hints.filter((h) => h.kind === "variable-from-b").map(({ file, names }) => ({ file, names })), [{ file: "docker-compose.yml", names: ["PORT"] }]);
      assert.equal(JSON.stringify(plan).includes("7718"), false, "a value from the environment of B in the plan");
      assert.ok(!including({}).hints.some((h) => h.kind === "variable-from-b"), "without bEnvironmentNames there is no entry");
    } finally { if (ages === undefined) delete process.env.PORT; else process.env.PORT = ages; }
  } finally { t.cleanUp(); }
});

test("a volume without a Compose label that a not-yet-converted project names in its Compose file is a hint; a `$` there => not checkable", () => {
  const t = tree();
  try {
    const including = (foreign) => planRelocation(data(t, (d) => ({ ...withoutDeposit(d), volumes: d.volumes.map((v) => (v.Name === "orbit_pgdata" ? { ...v, Labels: {} } : v)), foreign })));
    const plan = including([{ projectId: "old", name: "ORBIT-old", ports: [], env: [], volumeNames: ["orbit_pgdata"] }]);
    assert.deepEqual(plan.hints.filter((h) => h.kind === "volume-without-label-foreign").map(({ volume, projectId, notCheckable }) => ({ volume, projectId, notCheckable })), [{ volume: "orbit_pgdata", projectId: "old", notCheckable: undefined }]);
    const dollar = including([{ projectId: "var", name: "Var", ports: [], env: [], volumeNames: ["${PG_VOLUME}"] }]);
    assert.deepEqual(dollar.hints.filter((h) => h.kind === "volume-without-label-foreign").map((h) => [h.projectId, h.notCheckable]), [["var", true]]);
    for (const foreign of [[{ projectId: "x", name: "X", ports: [], env: [], volumeNames: ["other"] }], [{ projectId: "y", name: "Y", ports: [], env: [] }]]) {
      assert.ok(!including(foreign).hints.some((h) => h.kind === "volume-without-label-foreign"), JSON.stringify(foreign));
    }
  } finally { t.cleanUp(); }
});

test("prefilled targets in the runtime folder and a descendant of an ended group are only hints", () => {
  const t = tree();
  try {
    const plan = planRelocation(data(t, (d) => ({ ...withoutDeposit(d), runtimePrefilled: [{ field: "attachments", count: 2 }], processes: [{ pid: 700, start: "proc:9", program: "node", descendant: true }] })));
    assert.deepEqual(plan.holdReasons, [], JSON.stringify(plan.holdReasons));
    assert.deepEqual(plan.hints.filter((h) => h.kind === "runtime-prefilled").map(({ field, count }) => ({ field, count })), [{ field: "attachments", count: 2 }]);
    assert.deepEqual(plan.hints.filter((h) => h.kind === "process-descendant").map((h) => h.pid), [700]);
  } finally { t.cleanUp(); }
});

test("a cbase. label in a continuation line or behind a lowercase `label` is recognised - the old per-line regex saw neither", () => {
  const old = (text) => /^\s*LABEL\b[^\n]*\bcbase\./m.test(text);
  for (const text of ["FROM x\nLABEL a=b \\\n  cbase.x=y\n", "FROM x\nlabel cbase.x=y\n", "FROM x\nONBUILD LABEL cbase.x=y\n"]) {
    assert.equal(setsCbaseLabel(text), true, text);
  }
  assert.equal(old("FROM x\nLABEL a=b \\\n  cbase.x=y\n") || old("FROM x\nlabel cbase.x=y\n"), false, "the counter-proof proves nothing: the old regex saw one of the cases");
  for (const text of ["FROM x\nLABEL a=b\n", "FROM x\n# LABEL cbase.x=y\n", "FROM x\nENV X=cbase.y\n", "FROM x\nLABEL org.cbase.x=y\n"]) assert.equal(setsCbaseLabel(text), false, text);
});
