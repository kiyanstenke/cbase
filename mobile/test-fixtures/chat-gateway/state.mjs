// State, ids, containers, tables, seed functions and helpers of the fixture gateway. German data below stays German where a UI test matches it.
import { createHash } from "node:crypto";
import zlib from "node:zlib";
// The protocol of the terminal stream — the same leaf, without imports, that the server computes with (section "Terminal").
import { dataRow, truncateBuffer } from "../../../server/backend/electron/server/terminal-stream.js";
export const S = {};
export const NEXT = Symbol("route: not responsible");
const workspaceId = "10000000-0000-4000-8000-000000000001";
const chatId = "20000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";

const workspace = {
  id: workspaceId,
  name: "Mobile Fixture",
  path: "/tmp/mobile-fixture",
  createdAt: Date.now(),
  projects: [
    {
      id: projectId,
      name: "Fixture-Projekt",
      path: "/tmp/mobile-fixture/project",
      createdAt: Date.now(),
    },
  ],
};

// A SECOND workspace, only on request (`POST /fixture/second-workspace { on: true }`): a filter on the active workspace can
// only be proven if there is something to hide. By default it stays OFF — every test that counts workspaces or opens the
// first one would otherwise run against a list it does not know.
const workspaceId2 = "10000000-0000-4000-8000-000000000002";
const workspace2 = {
  id: workspaceId2,
  name: "Second workspace",
  path: "/tmp/mobile-fixture-2",
  createdAt: Date.now(),
  projects: [],
};
S.secondWorkspace = false;

S.chat = {
  id: chatId,
  workspaceId,
  projectId,
  title: "Queue-Test",
  profile: "default",
  model: "gpt-5.6-sol",
  permissionMode: "bypassPermissions",
  effort: "medium",
  // Ultracode: the mode beside the level — the chat route delivers it and accepts it via PATCH.
  ultracode: false,
  provider: "codex",
  browserMode: "",
  contextTokens: 0,
  goal: "",
  // Goal paused: the chat route delivers it and accepts it via PATCH; every setting of `goal` clears it.
  goalPaused: false,
  contextSummary: "",
  pinned: false,
  notify: {},
  // Auto-compact: null = default (global stage), 0 = off, otherwise a stage.
  autocompact: null,
  autocompactMax: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// Two more chats — only for search, sorting and project filter. Deliberately OLDER than the main chat, so "Newest first"
// (default) still lists it first and existing tests keep opening the right chat. Both hang on the workspace, not on a
// project — so the project filter can be checked.
const extraChats = [
  {
    ...S.chat,
    id: "20000000-0000-4000-8000-000000000002",
    projectId: null,
    title: "Architektur-Notizen",
    // Deliberately WITHOUT the field (JSON omits `undefined`): a chat of an older server stays readable.
    ultracode: undefined,
    updatedAt: Date.now() - 3_600_000,
    createdAt: Date.now() - 7_200_000,
  },
  {
    ...S.chat,
    id: "20000000-0000-4000-8000-000000000003",
    projectId: null,
    title: "Zahlungs-Bug im Checkout",
    updatedAt: Date.now() - 7_200_000,
    createdAt: Date.now() - 10_800_000,
  },
];

S.running = false;
S.waiting = false;
S.queue = [];
S.chatCreateCount = 0;
/// The body of the last PATCH on the main chat — so a test checks the field that was SENT, not only the state afterwards.
/// `reset-run` clears it.
S.lastChatPatch = null;
/// The body of the last creation (`POST /api/chats`) — so a test checks the field that was SENT (ultracode in the "New chat"
/// sheet: `ultracode: true` beside the level, never "ultracode" as a level). `reset-run` clears it.
S.lastChatCreate = null;
// Chat folders (purely logical grouping of the chat list). Ids deliberately deterministic so tests can address them.
S.chatFolders = [];
S.chatFolderCounter = 0;
// Archive: the state stands BESIDE the chats (id → archivedAt), not on them — `extraChats` is a shared constant, and `reset-run`
// clears one registry in ONE move (`archiveEmpty()`). Applies to Coding chats and their folders.
S.archive = archiveEmpty();
S.seededHistoryCount = 0;
S.seededHistoryStress = false;
S.seededMarkdown = false;
// Raw history rows ({id, role, text, ts, attachments}) — 1:1 imitation of real chats.
S.seededRawEntries = null;
// A history with start and end marker of a dynamic workflow (role `workflow_marker`) — switch
// `POST /fixture/workflow-markers {history}`, live `{live: "start"|"end"}`; `reset-run` clears it.
S.workflowMarkers = false;
// Approval cards of a dynamic workflow in the history (role `workflow_approval`) — switch `POST /fixture/workflow-approval {history}`;
// `null` = off, otherwise `{ decide: { <requestId>: "accepted"|"rejected" }, requests: [<body per POST /dyn-workflows/approval>] }`.
// `reset-run` clears it.
S.workflowApproval = null;
// Saved dynamic workflows (`GET /api/chats/<id>/dyn-workflows`, draft `GET /api/workspaces/<id>/dyn-workflows`). They are no
// longer the third group of the slash picker, and a line `/name` on `POST /message` no longer starts one (404 `dyn_slash`).
// The same list is the library of the Coding category "Dynamic workflows" (list/view/delete
// `/api/workspaces/<id>/dyn-workflows[/<id>]`, takeover `/api/projects/<id>/workspace-dyn-workflows[/<name>/enabled]`). The
// default stays the one entry; `POST /fixture/dyn-library {seed:true}` adds three: two names that differ ONLY in special
// characters (pre-encoding or a hit on the neighbor shows in the state), and one WITHOUT `whenToUse` and WITHOUT `phases` (the
// fields are missing entirely). `{error:true}` makes both lists answer 500. Every call is in `S.dynLibraryCalls` with the RAW
// path; `GET /fixture/dyn-library` delivers list, takeovers, calls. `reset-run` restores everything.
S.dynWorkflows = dynWorkflowsDefault();
S.dynTakenOver = new Set();
S.dynLibraryError = false;
S.dynLibraryCalls = [];
// The progress tree of the dynamic workflows in the agents sheet (`GET /api/chats/<id>/dyn-workflows/tree`, transcript
// `GET …/dyn-workflows/runs/<runId>/agents/<n>`, human stop `POST …/dyn-workflows/runs/<runId>/stop`, routes-chat.mjs) — switch
// `POST /fixture/dyn-tree {seed: "running"|"karg"|null}` (seeds.mjs `dynTreeSeed`); `null` = no workflow, the route then
// answers with an empty list for EVERY chat. `stops`: the bodies of the stop requests with run id; `interventions`:
// `{ runId, n, kind: "skip" | "restart" }` per `POST …/dyn-workflows/runs/<runId>/agents/<n>/<kind>`; `GET /fixture/dyn-tree` delivers both.
// `reset-run` clears it.
S.dynTree = null;
// The graph-workflow starts of the fixture chat as run views (contract from workflows/graph-start.js graphRunView) —
// `GET /api/chats/<id>/graph-workflows` and the human abort `POST …/graph-workflows/<startId>/stop` (routes-chat.mjs). Seed
// `POST /fixture/graph-runs {runs, live}` (routes-fixture.mjs); every stop request is in `S.graphRuns.stops` with `startId` and
// body. `reset-run` clears both.
S.graphRuns = { runs: [], stops: [] };
// A history whose assistant turns contain NOTHING visible (only Task* calls — they live in the task bar above the composer).
// This is where the finding "abnormal padding below the user message" hangs: a row without content must not get a cell.
S.seededInvisible = false;
S.seededHistoryDelayMs = 0;
// Reconcile on open (`Chat/ChatViewModel+Reconcile.swift`; switches in detail in the README of this folder).
// History of the main chat = seed + channel + `S.addenda` (stored after the start, seeds.mjs `mainHistory`).
S.addenda = [];
S.gapRow = null; // `/fixture/gap`: stored RIGHT AFTER the next `GET …/log`
S.runStream = null; // `/fixture/run-stream`: the next run streams in pieces; `null` = the usual run
S.runStreamText = ""; // its not yet stored text — `streamText` in `connected` (like `runStreamText`)
S.runStreamFull = ""; // the whole text of the stream run (the buffer above stops at `cap` — `streamTextTruncated`)
S.runStreamCap = 0; // `run-stream { cap }`: characters at which the buffer stops (0 = never, like RUN_STREAM_MAX)
S.silentStreams = new Set(); // `/fixture/stream-silent`: streams that receive nothing any more — dead without the app noticing
S.streamConnections = 0; // number of connections to the stream of the main chat (`GET /fixture/reconcile`)
S.streamFlapping = null; // `/fixture/stream-flapping`: `{ times }` — every connection ends again at once (after `connected` or as 503)
S.streamFailedAttempts = 0; // `/fixture/stream-abort { failedAttempts }`: this many connections still answer 503
S.streamFailedResponses = 0; // number of 503s on the stream (`GET /fixture/reconcile`)
S.usageDelayMs = 0; // `/fixture/usage`: `GET /api/usage/consumption` answers only after this many ms
S.usageHistoryUnknown = false; // `/fixture/usage`: in the history all days WITH consumption carry `equivalentUsd: null`
S.deltaRetrievals = 0; // number of `GET …/log/delta` (`GET /fixture/reconcile`)
S.imageAttachment = null; // `/fixture/image`: image attachment with `w`/`h`, delivery delayed
S.timers = [];
// Credentials: an ordinary secret and a FREE-TEXT access. Without this route the credentials page hung in the loading state
// forever on mobile.
S.vars = [
  { id: 901, key: "GITLAB_TOKEN", kind: "secret", value: "glpat-fixture",
    description: "PAT for git.example.com", mcpAccess: true, createdAt: Date.now(), updatedAt: Date.now() },
  { id: 902, key: "ORBIT_SQL", kind: "freeText", description: "Azure SQL of the tenant portal",
    value: "Host: 203.0.113.45\nPort: 1433\nUser: lurch\nPassword: s3hr-secret",
    mcpAccess: true, createdAt: Date.now(), updatedAt: Date.now() },
];

const chatStreams = new Set();
const globalStreams = new Set();

// ── Streamed browser (fixture) ──────────────────────────────────────────────
// Enough of the real contract to check the browser pane: ensure → id, SSE with "hello" and "frame" images, inputs and actions are
// recorded. The images are self-built PNGs (UIImage reads any format) with a GREEN corner at the top left — from that the 90° turn
// of the desktop view can be read in the screenshot.
const browserId = "40000000-0000-4000-8000-000000000001";
const browserState = {
  viewport: { width: 0, height: 0, dpr: 0 },
  inputs: [],
  acts: [],
  viewers: new Set(),
  seq: 0,
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/// Small PNG: white, with a green square in the TOP LEFT corner and a blue stripe at the bottom edge. Kept small (the display
/// does the scaling).
function framePng(width, height) {
  const w = Math.max(16, Math.min(160, Math.round(width / 16)));
  const h = Math.max(16, Math.min(160, Math.round(height / 16)));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * (w * 3 + 1);
    raw[rowStart] = 0; // filter "none"
    for (let x = 0; x < w; x += 1) {
      const at = rowStart + 1 + x * 3;
      const inCorner = x < w * 0.32 && y < h * 0.32;
      const inFooter = y > h * 0.88;
      raw[at] = inCorner ? 0x11 : inFooter ? 0x22 : 0xf4;
      raw[at + 1] = inCorner ? 0xcc : inFooter ? 0x33 : 0xf4;
      raw[at + 2] = inCorner ? 0x22 : inFooter ? 0xdd : 0xf4;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Files of the fixture scope (Code tab) ───────────────────────────────────
// Flat list with paths; `fileTree` filters to one level, as the real server does.
const fixturePng = framePng(16 * 48, 16 * 32); // 48×32 px
const fixtureFiles = [
  { path: "readme.md", name: "readme.md", type: "file", content: "# Fixture\n\nOne text file.\n" },
  { path: "logo.png", name: "logo.png", type: "file", image: true },
  { path: "src", name: "src", type: "dir" },
  { path: "src/till.ts", name: "till.ts", type: "file", content: "export const price = 42;\n" },
];
S.lastDownload = null;
S.lastUpload = null;
// ── Workflows (node/edge graph) ──
// Enough of the real contract to check list, editor, takeover and the start from the chat. The run is NOT really worked off (that
// would need an agent) — it stays in the state that start/skip/abort set.
const defaultWorkflows = () => [
  {
    id: "50000000-0000-4000-8000-000000000001",
    name: "Release vorbereiten",
    description: "Tests, changelog, tag",
    projectId: null,
    // Set on the desktop — a mobile save must leave it untouched (see UI test).
    run: { provider: "codex", model: "gpt-5.6-sol", permissionMode: "plan", effort: "high", doneProvider: "", doneModel: "" },
    graph: {
      nodes: [
        { id: "s", type: "start", title: "Start", text: "", x: 40, y: 120 },
        { id: "a", type: "instruction", title: "Tests laufen lassen", text: "Run the test suite.", x: 240, y: 120 },
      ],
      edges: [{ from: "s", to: "a", branch: null }],
    },
  },
  // A second one, so a test can choose a DIFFERENT one than the one at the post.
  {
    id: "50000000-0000-4000-8000-000000000002",
    name: "Hotfix ausliefern",
    description: "Fix, test, tag",
    projectId: null,
    graph: {
      nodes: [
        { id: "s", type: "start", title: "Start", text: "", x: 40, y: 120 },
        { id: "a", type: "instruction", title: "Build fix", text: "Fix the error.", x: 240, y: 120 },
      ],
      edges: [{ from: "s", to: "a", branch: null }],
    },
  },
  // A third one with a CYCLE (a→b→a) — the only place where the step sheet shows the round cap: "Nachbessern" carries no value
  // of its own and inherits the 20 of "Review sauber?" ("20 · von Review sauber?"); the two chains above do NOT show it. Without
  // this seed a test about the cap would be green without ever entering the path — chain and cycle would look the same in the
  // sheet. The cards stand below each other so they are visible in portrait.
  {
    id: "50000000-0000-4000-8000-000000000003",
    name: "Review-Schleife",
    description: "Build, check, rework",
    projectId: null,
    graph: {
      nodes: [
        { id: "s", type: "start", title: "Start", text: "", x: 40, y: 40 },
        { id: "a", type: "instruction", title: "Nachbessern", text: "Fix the findings.", x: 40, y: 160 },
        { id: "b", type: "instruction", title: "Review sauber?", text: "Check the diff.", maxVisits: 20, x: 40, y: 280 },
      ],
      edges: [
        { from: "s", to: "a", branch: null },
        { from: "a", to: "b", branch: null },
        { from: "b", to: "a", branch: null },
      ],
    },
  },
  // A fourth one with a TRIGGER node — the only place where the "Trigger" tab of the settings sheet has something to arm. The
  // trigger is fully configured (account, project, events), otherwise the PUT with `active: true` would be rejected like on the
  // real server. It stands LAST in the list: the tests before it open their editors by the index of their row (ids …0001 to …0004).
  {
    id: "50000000-0000-4000-8000-000000000004",
    name: "Auf Issue reagieren",
    description: "A new issue starts the run",
    projectId: null,
    active: false,
    graph: {
      nodes: [
        { id: "t", type: "trigger", title: "New issue", text: "", x: 40, y: 40,
          trigger: { source: "gitlab", accountId: "a0000000-0000-4000-8000-000000000001", scope: "project", projectId: 42, projectPath: "till/app", events: ["issue_opened"], intervalSec: 120 } },
        { id: "a", type: "instruction", title: "Handle issue", text: "Bearbeite {{input}}.", x: 40, y: 160 },
      ],
      edges: [{ from: "t", to: "a", branch: null }],
    },
  },
];
// ── Skills (slash picker in the composer) ──
// Two are enough, and they carry exactly the distinction the picker must show: one from the workspace (without origin) and one
// from a project (with). Without this seed a test about the picker would be green without ever entering the path — the list
// would come back empty.
const defaultSkills = () => [
  { id: "60000000-0000-4000-8000-000000000001", name: "release-notes", description: "Schreibt die Release-Notes aus den Commits.", hasResources: false, originProject: "" },
  { id: "60000000-0000-4000-8000-000000000002", name: "till-receipt", description: "Formats a till receipt.", hasResources: false, originProject: "Kasse" },
];
S.skills = defaultSkills();

// ── Skills in Coding ──
// Exactly ONE area per skill. The seed carries what the three views must show: a Coding skill of the workspace (applies in the
// project until it is hidden there), a project skill (always Coding) and a Managing skill (only per workspace — a leftover that
// must appear in no list). Hiding hangs on the skill id: `S.skillsHidden` holds "<projectId>:<skillId>"; `S.skillsCalls` records
// every skills request of the app (method, path, query, body). Routes and computation in `routes-workspace.mjs`.
const defaultPagesSkills = () => [
  { id: "60000000-0000-4000-8000-000000000001", name: "release-notes", description: "Schreibt die Release-Notes aus den Commits.", hasResources: false, area: "coding", projectId: null, body: "# release-notes\n\nCollect the commits since the last tag and write the release notes.\n" },
  { id: "60000000-0000-4000-8000-000000000002", name: "till-receipt", description: "Formats a till receipt.", hasResources: false, area: "coding", projectId, body: "# till receipt\n\nFormat the receipt as a till receipt.\n" },
  { id: "60000000-0000-4000-8000-000000000004", name: "weekly-report", description: "Summarizes the week for the manager agents.", hasResources: false, area: "managing", projectId: null, body: "# weekly report\n\nSummarize the week.\n" },
];
S.pagesSkills = defaultPagesSkills();
S.skillsHidden = new Set();
S.skillsCalls = [];
S.skillsPatchError = 0; // `/fixture/pages-skills { patchError: 404 }`: every switch PATCH fails with this status
S.skillCounter = 100; // ids of newly created skills (…000000000101 ff.), deliberately survives `reset-run`
// A LONG skill body (`POST /fixture/pages-skills { lang: true }`): about 120 paragraphs, the last line is END-OF-THE-FILE. Only
// that way can one measure whether the editor on the phone scrolls to the end — with three lines a scroll test would be green
// without scrolling.
const longSkillBody = () => [
  "# release-notes",
  "",
  ...Array.from({ length: 120 }, (_, i) => `Absatz ${i + 1}: Diese Zeile füllt den Editor und bricht mehrfach um, damit der Inhalt weit über ein Fenster hinausreicht.\n`),
  "END-OF-THE-FILE",
].join("\n");

S.workflows = defaultWorkflows();
S.projectWorkflows = [];
S.adoptedWorkflows = new Set();
S.workflowRun = null;
// Bell notices (review request, trigger) — settable via /fixture/notice.
S.notices = [];
// The services of the header: running services, their resources, the machine and an agent browser — only on request
// (`POST /fixture/services { on: true, calculator? }`), `reset-run` clears it. By default it stays at `[]` / `{ resources: [] }` /
// `{ browsers: [] }` and without `/gw/host`: the Apps page, the browser pane and every other test run against the lists they know.
// `calculator` chooses the source of the machine: "gateway" (`/gw/host` answers — the operating mode; the resources answer
// carries its own `host` anyway, like the real server), "backend" (only the field `host` — the app must NOT show it: it is
// always in gateway mode, and there only `/gw/host` counts, as on the web) or "none".
S.services = false;
S.servicesMachine = "gateway";
// `measurement`: "ja" (default — the seed below, "measured: 2 of 3") or "no": the same services run, but NO project reports
// containers (`containers: 0`, like a workspace whose services run without Docker). Then there is no sum, and the menu must say
// "measured: 0 of 3 services" without numbers (say it openly).
S.servicesMeasurement = "yes";
// `resources`: "ok" (default) or "error" — then `/api/project-resources` answers 500, like a backend whose `docker stats` hangs or
// whose container is just being woken. The services keep answering: exactly the state in which the app must say NOTHING about a
// measurement (no "measured: 0 of 3" — empty is not unknown).
S.serviceResources = "ok";
// The requests to `/api/project-resources` since the last `reset-run`, oldest first, at most 50: each `{ disk, projectId, at }` —
// `disk` is the parameter as it came (`"0"` or `null`). Read via `GET /fixture/services` (`query`): the test holds that the button
// asks without folder size when closed and immediately with it on opening. Counted ALWAYS, also without the services switch — a
// request without `disk=0` with the menu closed is a `du` either way.
S.serviceResourceQueries = [];
// Port conflicts of the project list: with `POST /fixture/port-conflicts { on: true }` `GET /api/ports/conflicts` names a group with
// two entries for the fixture project (the "Port conflicts" mark on its card); `{ error: true }` makes the same route answer 500 —
// the list must then keep the LAST state (a read error is not an empty answer). Default: no conflict (the route answers `{}`);
// `reset-run` clears both.
S.portConflicts = false;
S.portConflictsError = false;
// The retrievals of `/api/ports/conflicts` since the last `reset-run` (`retrievals` in the answer of `/fixture/port-conflicts`): the
// test sees from it that pull-to-refresh really asked again.
S.portConflictsRetrievals = 0;
// Two projects in the fixture workspace: the known one and one that only has services here — so "tapping opens Apps with THAT
// project" has something to hide. Three run, one stands; the service in the second project carries no container and its project
// no measurement ⇒ "measured: 2 of 3".
const servicesProject2 = "30000000-0000-4000-8000-000000000002";
const servicesSeed = () => [
  { id: 501, projectId, projectName: "Fixture-Projekt", workspaceId, name: "web", kind: "web", port: 3000, container: "fixture-web-1", tech: "node", startCommand: "npm run dev", agentInstructions: "", running: true },
  { id: 502, projectId, projectName: "Fixture-Projekt", workspaceId, name: "api", kind: "api", port: 8080, container: "fixture-api-1", tech: "node", startCommand: "npm start", agentInstructions: "", running: true },
  { id: 503, projectId: servicesProject2, projectName: "Second project", workspaceId, name: "worker", kind: "worker", port: null, container: "", tech: "python", startCommand: "python worker.py", agentInstructions: "", running: true },
  { id: 504, projectId, projectName: "Fixture-Projekt", workspaceId, name: "db", kind: "db", port: 5432, container: "fixture-db-1", tech: "postgres", startCommand: "", agentInstructions: "", running: false },
];
const GiB = 1024 * 1024 * 1024;
const serviceResources = () => S.servicesMeasurement === "no"
  ? [
    { projectId, name: "Fixture-Projekt", dockerUp: true, containers: 0, cpu: 0, memBytes: 0, memLimitBytes: 0, memLimitShared: true, diskBytes: 250 * 1024 * 1024 },
    { projectId: servicesProject2, name: "Second project", dockerUp: true, containers: 0, cpu: 0, memBytes: 0, memLimitBytes: 0, memLimitShared: true, diskBytes: 10 * 1024 * 1024 },
  ]
  : [
    { projectId, name: "Fixture-Projekt", dockerUp: true, containers: 2, cpu: 12.34, memBytes: 1.4 * GiB, memLimitBytes: 8 * GiB, memLimitShared: true, diskBytes: 250 * 1024 * 1024 },
    { projectId: servicesProject2, name: "Second project", dockerUp: true, containers: 0, cpu: 0, memBytes: 0, memLimitBytes: 0, memLimitShared: true, diskBytes: 10 * 1024 * 1024 },
  ];
// The host behind the gateway: RAM 92 % used ⇒ `danger` — the reason the button and its accessibility text must name. Swap stands
// deliberately HIGHER (95 %): it does not count, and if the stage hung on it the reason would be "swap". Load 30 % per core, disk 60 %.
const SERVICES_HOST_GATEWAY = {
  at: 0, cpu: { count: 8, load1: 2.4, load5: 2.1, load15: 1.9 },
  mem: { totalBytes: 16 * GiB, availableBytes: 1.28 * GiB },
  swap: { totalBytes: 4 * GiB, freeBytes: 0.2 * GiB },
  disk: { path: "/var/lib/docker", totalBytes: 500 * GiB, freeBytes: 200 * GiB },
};
// What the backend in the user container measures itself (its quota): all calm, the highest value the disk at 40 %.
const SERVICES_HOST_BACKEND = {
  at: 0, cpu: { count: 4, load1: 0.8, load5: 0.7, load15: 0.6 },
  mem: { totalBytes: 4 * GiB, availableBytes: 3 * GiB },
  swap: null,
  disk: { path: "/", totalBytes: 100 * GiB, freeBytes: 60 * GiB },
};
const SERVICES_AGENT_BROWSER = { id: "50000000-0000-4000-8000-000000000001", kind: "agent", label: "Research agent", tabs: 2 };
// Run parked at the usage limit (auto-continue). Settable via /fixture/limit-wait, so a UI test can drive the strip including
// "Try now"/"Cancel".
S.limitWait = null;
// What the body of the last `POST …/auto-continue/now` carried: `true` only if the button "Start anyway (costs credit)" was pressed.
// The real server bypasses the gate EXCLUSIVELY with `{"anyway": true}` — a button that does not send the field parks again at
// once. That can only be checked at the server, not at the view; hence it stands here and goes beyond `/fixture/settings`.
// `null` = no attempt since the seed.
S.limitAttemptAnyway = null;
// Usage limit REACHED (both providers, /fixture/usage-limit): the header must then show 100 % — before, the rings disappeared because
// a full pot brings no percentage.
S.usageAtLimit = false;
const limitWaitState = (over = {}) => ({
  chatId: S.chat.id, kind: "run", provider: "claude", group: "session", label: "session",
  limitText: "5-Stunden-Limit", reason: "reset", resetsAt: Date.now() + 3_600_000,
  dueAt: Date.now() + 3_600_000, attempts: 0, probes: 0, maxAttempts: 12,
  evidence: "usage limit reached", workflow: false,
  // Explicitly with default `false`: `gate: true` means the CREDIT GATE intercepted the start — the strip then says "Start anyway
  // (costs credit)" instead of "Try now". Settable via `/fixture/limit-wait {"gate":true}`.
  gate: false,
  createdAt: Date.now(), updatedAt: Date.now(), text: "Fortsetzung geplant",
  ...over,
});
// The waiting row BELONGS to a chat: the real server keeps one `pending_resume` row per chat. Via `/fixture/limit-wait {"chatId":
// "<id>"}` the seed is attributed to another chat; without the field it stays the working chat, and every existing check reads the
// same state.
const limitWaitFor = (id) => (S.limitWait && S.limitWait.chatId === id ? S.limitWait : null);
// Events go only to the stream of the WORKING chat (the special chats have no registered stream in the fixture) — and therefore always
// carry ITS state, never that of a foreign chat. The real server sends per chat; a foreign state on this stream would be a strip in
// the wrong conversation.
const limitEvent = () => chatEvent({ type: "harness", subtype: "limit_wait", wait: limitWaitFor(S.chat.id) });
// The waiting list of the usage page is the SAME table on the real server as the waiting row of a chat (`listPendingResumes` ↔
// `getPendingResume`). Here there is the seed of the page (`autoContinueWaiting`) and the chat seed (`limitWait`) — the list merges
// both, otherwise a chat parked via `/fixture/limit-wait` would not stand on the page, and the contract "gate rows survive
// switching off A" would not be checkable there.
const autoContinueList = () => [
  ...S.autoContinueWaiting.map((w) => ({ ...w })),
  ...(S.limitWait && !S.autoContinueWaiting.some((w) => w.chatId === S.limitWait.chatId) ? [{ ...S.limitWait }] : []),
];
S.lastWorkflowStart = null;
// The RAW body of the last PUT on a workflow: the UI test of the context tab checks that "Default" arrives as an explicit `null` —
// the normalized state alone would see an omitted field and a `null` as the same.
S.lastWorkflowPut = null;

const stepsOf = (graph) => ({
  total: (graph.nodes || []).filter((n) => ["instruction", "parallel", "ask"].includes(n.type)).length,
  approx: (graph.nodes || []).some((n) => n.type === "loop"),
});
// Run settings as `normalizeRunSettings` on the real server: fourteen fields (`ultracode` included), always all present
// (compaction, "check all", check rounds, two caps). Numbers stay numbers, `null` stays `null`. The stages are THE SAME as the
// global ones below (`AUTOCOMPACT_STAGES`) — read only at the call, i.e. after the module is evaluated (no TDZ).
const emptyRun = () => ({
  provider: "", model: "", permissionMode: "", effort: "", ultracode: false, doneProvider: "", doneModel: "",
  autocompact: null, autocompactMax: null, doneAll: true, doneRounds: 3, doneCapAuto: false, loopCapAuto: false,
});
const TEXT_FIELDS = ["provider", "model", "permissionMode", "effort", "doneProvider", "doneModel"];
const stageOf = (v, stages) => (v === 0 ? 0 : stages.includes(Number(v)) ? Number(v) : null);
const runOf = (raw) => {
  const r = raw && typeof raw === "object" ? raw : {};
  const rounds = Number(r.doneRounds);
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, String(r[k] ?? "").trim()])),
    ultracode: r.ultracode === true,
    autocompact: stageOf(r.autocompact, AUTOCOMPACT_STAGES),
    autocompactMax: stageOf(r.autocompactMax, AUTOCOMPACT_MAX_STAGES),
    doneAll: r.doneAll !== false,
    doneRounds: Number.isInteger(rounds) && rounds >= 1 && rounds <= 10 ? rounds : 3,
    doneCapAuto: r.doneCapAuto === true,
    loopCapAuto: r.loopCapAuto === true,
  };
};
// As `triggerViews` on the real server, only what the app reads.
const triggerViewsOf = (w) => (w.graph.nodes || []).filter((n) => n.type === "trigger").map((n) => {
  const t = n.trigger || {};
  return {
    nodeId: n.id, title: n.title || "", source: t.source || "gitlab", scope: t.scope || "all",
    target: t.projectPath || "", events: t.events || [], intervalSec: t.intervalSec || 120,
    missing: !t.accountId ? "account" : !(t.events || []).length ? "events" : "",
    account: null, lastPollAt: 0, lastFireAt: w.active ? Date.now() - 3_600_000 : 0, fires: w.active ? 1 : 0, lastError: "",
  };
});
const LOCK_SCOPES_FIXTURE = ["project", "workflow", "event", "custom", "off"];
const lockOf = (raw) => ({
  scope: LOCK_SCOPES_FIXTURE.includes(raw?.scope) ? raw.scope : "project",
  template: String(raw?.template ?? ""),
});
const workflowMeta = (w) => ({
  id: w.id, name: w.name, description: w.description, projectId: w.projectId ?? null,
  nodeCount: (w.graph.nodes || []).length, steps: stepsOf(w.graph),
  active: !!w.active, triggers: triggerViewsOf(w),
  lock: lockOf(w.lock),
  run: runOf(w.run),
  holding: [],
  updatedAt: Date.now(),
});
const workflowFull = (w) => ({
  ...workflowMeta(w), graph: w.graph, problems: [],
  limits: { maxVisits: 5, maxVisitsLimit: 99, maxSteps: 200, maxIterations: 50, doneRounds: runOf(w.run).doneRounds, doneRoundsMax: 10 },
});
// One-shot switch: the next run starts a subagent (Task) that does NOT finish — to check the "N agent(s) working" display.
// Consumes itself, otherwise the next test would see the subagent too.
S.subagentOnce = false;
// The stop calls of the agent buttons, each with route and body — `/fixture/reset-run` clears them.
S.agentStops = [];
// The calls of `POST /agent/background` — read via `/fixture/agents-background`.
S.agentsBackground = [];
// One-shot switch: the next run goes into the waiting phase of a BACKGROUND agent — the main agent is idle (result through), the CLI
// delivers the message of the agent later.
S.waitingAgentOnce = false;
S.waitingAgentKind = "agent"; // "agent" | "task" | "wakeup" — which wake reason is reported
// Four counter-probe switches (route `/fixture/waiting-agent-counter-probe`) — the first two here, `descriptionEmpty` and `mixed` below.
// The tests of the waiting phase do NOT set them, `reset-run` does NOT clear them (sticky, see route); the manual run in
// `assertWaitingState` reads ALL FOUR beforehand: `empty` reports the waiting phase WITHOUT content (no task, no agent, no wake-up
// — chip or dot must then be missing), `event` chooses the envelope: `run_waiting` (the turn is over) or `background` (side work
// IN THE MIDDLE of the turn — the run row stays).
S.waitingAgentEmpty = false;
S.waitingAgentEvent = "run_waiting"; // "run_waiting" | "background"
// Third counter-probe switch: the background task comes with an EMPTY description — chip "1 background task" stands, the sheet says
// "No description". Sticky like the two others, `GET /fixture/waiting-agent-counter-probe` shows all of them.
S.waitingAgentDescriptionEmpty = false;
// Fourth counter-probe switch: the waiting phase reports a subagent IN ADDITION — the header dot would then also stand at "running"
// with `kind: task`/`wakeup`. It backs the mirror-image exclusion rows in `assertWaitingState` ("not wrongly as an agent").
S.waitingAgentMixed = false;
// One-shot switch: the next run seeds the whole situation of the agents sheet — ONE finished subagent (report as a tool result in the
// history) and ONE running. The running one stayed invisible in the UI for a long time: its tool block gets its result at once
// ("Async agent launched"), so it does not count as running — the server reports it via `background`, with model, status,
// startedAt, tokens, token kind and tool count.
S.backgroundAgentOnce = false;
// A background agent that survives its turn (`/fixture/agent-after-run`, routes-run.mjs). As long as it lives, the `connected` of the
// chat stream carries it — like the real server from the owner (chats/routes.js).
S.agentAfterRun = null;
// With `/fixture/background-agent { foreground: true }`: the running agent of the seed is a FOREGROUND agent — its row carries
// `foreground: true`, the sheet shows "To background". The button (POST /agent/background) clears the mark, like the real server on the
// switch.
S.backgroundAgentForeground = false;
// One-shot switch: the next run drives the CLI's OWN task list (TaskCreate/TaskUpdate) instead of the superseded TodoWrite.
S.nativeTasksOnce = false;
// One-shot switch: the next run executes TWO groupable tool calls (Bash). Only from two on does the client build a group row
// (ToolGroupView), which stands OPEN during the run and collapses at the end of the turn — the cell gets clearly smaller. Exactly
// this jump in height INSIDE a cell was "extreme padding, flickers back and forth".
S.groupToolsOnce = false;
// With the switch set the run ends quickly, so the collapsing can be observed in the test.
S.groupToolsFast = false;
// One-shot switch: the next run asks a question with a choice card (cbase_ask) and ENDS afterwards — exactly like the real server,
// where the choice arrives as the next message.
S.askOnce = false;
// How many questions the next card carries (`POST /fixture/ask { open: true, questions: 3 }`): three give the question pager of the card,
// one the immediate tap. Falls back with the run.
S.askQuestions = 1;
// One-shot switch (`POST /fixture/open-call`): the next run executes two Bash calls, the second gets NO result, and the run stays open
// 60 s. That is the counter-check that the spinner of the group row is findable in the RUNNING turn at all — before a test claims
// its absence in the finished turn.
S.openCallOnce = false;
// Addition (`POST /fixture/open-call { open: true, error: true }`): the FIRST of the two calls fails. The running group row then
// carries the red counter "(1 failed)" below its light band — the picture on which the red counter's legibility is checked. Falls
// back with the run.
S.openCallError = false;
// Artifacts of the fixture chat. Only as much storage as the view needs: path → text. With it the editor can be checked (read,
// change, save) — including the checksum with which the server secures real overwriting.
S.artifacts = new Map([["issues/01-login.md", "# Login-Fehler\n\nDie **Anmeldung** bricht ab.\n\n## Abschnitt 1\n\nRow 1 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 2\n\nRow 2 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 3\n\nRow 3 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 4\n\nRow 4 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 5\n\nRow 5 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 6\n\nRow 6 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 7\n\nRow 7 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 8\n\nRow 8 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 9\n\nRow 9 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 10\n\nRow 10 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 11\n\nRow 11 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 12\n\nRow 12 des Befundes mit genug Text, um umzubrechen.\n\n> Kundenmeldung vom 12.8.\n"]]);
const artifactSha = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
function artifactMeta(path) {
  const text = S.artifacts.get(path) ?? "";
  return {
    path,
    name: path.split("/").pop(),
    mime: path.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    size: Buffer.byteLength(text, "utf8"),
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    sha256: artifactSha(text),
    chatId,
    chatTitle: S.chat.title,
    own: true,
  };
}

// Last choice received via /api/chats/:id/ask-answer (the test reads it via /fixture/ask).
S.lastAskAnswer = null;
const ASK_REQUEST_ID = "fixture-ask-1";
const ASK_QUESTIONS = [{
  header: "Layout",
  question: "Monorepo oder getrennte Repos?",
  multiSelect: false,
  options: [
    { label: "Monorepo (Empfehlung)", description: "Ein Repo, geteilte Tooling-Basis." },
    { label: "Getrennte Repos", description: "Unabhängige Release-Zyklen." },
  ],
}];
// Three questions on one card (`questions: 3`): one with header, one multiple choice, one without header — exactly the variants the
// pager draws differently per page.
const ASK_QUESTIONS_THREE = [
  ASK_QUESTIONS[0],
  {
    header: "Werkzeuge",
    question: "Welche Prüfungen sollen im CI laufen?",
    multiSelect: true,
    options: [
      { label: "Lint", description: "Stil und offensichtliche Fehler." },
      { label: "Unit-Tests", description: "Die schnelle Suite." },
      { label: "E2E", description: "Langsam, aber vollständig." },
    ],
  },
  {
    header: "",
    question: "Wann soll das erste Release stehen?",
    multiSelect: false,
    options: [
      { label: "Diese Woche", description: "Nur das Nötigste." },
      { label: "Nächster Sprint", description: "Mit Dokumentation." },
    ],
  },
];

function fileByPath(at) {
  if (at === "") return { path: "", name: "Mobile Fixture", type: "dir" };
  return fixtureFiles.find((f) => f.path === at) || null;
}

function fileTree(at) {
  const prefix = at ? `${at}/` : "";
  return fixtureFiles
    .filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"))
    .map((f) => ({
      name: f.name,
      path: f.path,
      type: f.type,
      size: f.image ? fixturePng.length : Buffer.byteLength(f.content || ""),
      symlink: false,
      heavy: false,
    }));
}

function browserFrame() {
  const width = browserState.viewport.width || 1280;
  const height = browserState.viewport.height || 800;
  browserState.seq += 1;
  const payload = {
    seq: browserState.seq,
    tab: "tab-1",
    data: framePng(width, height).toString("base64"),
    w: width,
    h: height,
  };
  const line = `event: frame\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const viewer of browserState.viewers) {
    try {
      viewer.write(line);
    } catch {
      browserState.viewers.delete(viewer);
    }
  }
}

// ── Git of the fixture project ──────────────────────────────────────────────
// x = index (staged), y = working tree — exactly like "git status --porcelain". The client derives `staged` from x, so the split
// must be right here.
S.gitHasRepo = true;
S.gitFail = false;   // failure switch for the git retrieval
// Delay of the git retrieval in ms ("The operation could not be completed" on pull-to-refresh): only an answer that does NOT come at once
// keeps the request open while `.refreshable` cancels its task — the fixture otherwise answers in ~10 ms.
S.gitSlow = 0;
S.gitFiles = [];
S.gitCommitted = [];
// The git sheet with repositories · changes · graph: a second repo "frontend" on request (`/fixture/git {second: true}`), so the
// "Repositories" section appears, and the requests to `/git/log` and `/git/show`, so a test reads what the app asked.
// `reset-run` clears everything (routes-git.mjs `resetGitSheet`).
S.gitSecond = false;
S.gitLogRequests = [];
S.gitShowRequests = [];

function resetGit() {
  S.gitFiles = [
    { x: " ", y: "M", path: "src/checkout.ts", code: "M", label: "modified", kind: "modified" },
    { x: "M", y: " ", path: "src/prices.ts", code: "M", label: "modified", kind: "modified" },
    { x: "?", y: "?", path: "notes.md", code: "?", label: "new (untracked)", kind: "untracked" },
  ];
  S.gitCommitted = [];
}
resetGit();

function gitTree() {
  if (!S.gitHasRepo) return { repos: [] };
  const staged = S.gitFiles.filter((f) => f.x.trim() && f.x !== "?").length;
  const untracked = S.gitFiles.filter((f) => f.x === "?").length;
  return {
    repos: [{
      name: "Fixture-Projekt",
      relPath: "",
      branch: "fn/till",
      detached: false,
      upstream: "origin/fn/till",
      ahead: 2,
      behind: 1,
      changes: S.gitFiles,
      counts: { staged, unstaged: S.gitFiles.length - staged - untracked, untracked, total: S.gitFiles.length },
      clean: S.gitFiles.length === 0,
      lastCommit: { subject: "Price rounding fixed", author: "Fixture", relative: "2 hours ago" },
      remote: { host: "github", url: "git@github.com:example/fixture.git" },
      // The small git overview only with the switch `/fixture/git-view` — without the fields the "Branches" section is missing, and the
      // older git tests measure the sheet as it was before.
      ...(S.gitView ? gitViewSmall() : {}),
    }, ...(S.gitSecond ? [{
      // Clean, without remote: the graph stays with the fixture project (graphRepo prefers one WITH remote) until one chooses it.
      name: "frontend",
      relPath: "frontend",
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      changes: [],
      counts: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
      clean: true,
      lastCommit: { hash: GIT_GRAPH_FRONTEND[0].hash, subject: GIT_GRAPH_FRONTEND[0].subject, author: "Fixture", relative: "3 days ago" },
    }] : [])],
  };
}

// ── The graph: `POST …/git/log` with `graph` and `POST …/git/show` with `files`/`file` ───────────────────────────
// The fixture project: the branch `fn/till` (HEAD, 2 ahead, 1 behind `origin/fn/till`) with a merge from `main`, beside it
// `experiment/layout` (only under "All") and two tags — enough for lanes, arcs, the merge point and all kinds of badges.
// Topologically ordered, newest first, like `git log --topo-order`.
const gitC = (hash, subject, author, hours, parents, refs = [], file = []) => ({ hash, subject, author, hours, parents, refs, file });
const GIT_GRAPH_MAIN = [
  gitC("7c1e5a90d4b2f3a6c8e1d0b9a7f6e5d4c3b2a190", "Kasse: Tippfehler im Beleg", "Mira", 1, ["e6b2d8f4a0c5e1b7d3f9a2c4e6b8d0f2a4c6e8b0"],
    [{ name: "origin/fn/till", kind: "remote" }], [{ status: "M", path: "src/till/proof.ts" }]),
  gitC("3f9a2b7c1d8e4f60a5b3c2d1e0f9a8b7c6d5e4f3", "Kasse: Rabatt runden", "Fixture", 2, ["9b4c6d2e8f1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c"],
    [{ name: "fn/till", kind: "head" }],
    [{ status: "M", path: "src/till/discount.ts" }, { status: "A", path: "src/till/discount.test.ts" }, { status: "D", path: "docs/alt-discount.md" }]),
  gitC("9b4c6d2e8f1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c", "Merge branch 'main' into funktion/kasse", "Fixture", 3,
    ["e6b2d8f4a0c5e1b7d3f9a2c4e6b8d0f2a4c6e8b0", "c2a8e4f0b6d1a3c5e7f9b2d4a6c8e0f1b3d5a7c9"], [], [{ status: "M", path: "src/prices.ts" }]),
  gitC("51d7e3f9a2b4c6d8e0f1a3b5c7d9e2f4a6b8c0d1", "Layout: Raster ausprobieren", "Jonas", 5, ["0d5f1b7e3a9c4d6f8b0e2a4c6d8f0b1e3a5c7d9f"],
    [{ name: "experiment/layout", kind: "local" }], [{ status: "M", path: "src/layout/raster.css" }]),
  gitC("c2a8e4f0b6d1a3c5e7f9b2d4a6c8e0f1b3d5a7c9", "Preise aus der API laden", "Mira", 8, ["0d5f1b7e3a9c4d6f8b0e2a4c6d8f0b1e3a5c7d9f"],
    [{ name: "main", kind: "local" }, { name: "origin/main", kind: "remote" }, { name: "v1.2", kind: "tag" }],
    [{ status: "M", path: "src/prices.ts" }, { status: "R", path: "src/api/prices.ts", old: "src/prices-api.ts" }]),
  gitC("e6b2d8f4a0c5e1b7d3f9a2c4e6b8d0f2a4c6e8b0", "Kasse: Summenzeile", "Fixture", 26, ["0d5f1b7e3a9c4d6f8b0e2a4c6d8f0b1e3a5c7d9f"],
    [], [{ status: "A", path: "src/till/sum.ts" }]),
  gitC("0d5f1b7e3a9c4d6f8b0e2a4c6d8f0b1e3a5c7d9f", "Abhängigkeiten aktualisiert", "Jonas", 50, ["84f0c6a2e8b4d0f6a1c3e5b7d9f1a3c5e7b9d2f4"],
    [], [{ status: "M", path: "package.json" }, { status: "M", path: "package-lock.json" }]),
  gitC("84f0c6a2e8b4d0f6a1c3e5b7d9f1a3c5e7b9d2f4", "Erster Stand", "Fixture", 120, [],
    [{ name: "v1.0", kind: "tag" }], [{ status: "A", path: "README.md" }, { status: "A", path: "src/index.ts" }]),
];
// "Current branch": HEAD and its upstream — without `experiment/layout`.
const GIT_GRAPH_CURRENT = GIT_GRAPH_MAIN.filter((c) => c.subject !== "Layout: Raster ausprobieren");
const GIT_GRAPH_FRONTEND = [
  gitC("a9c3e5b7d1f2a4c6e8b0d2f4a6c8e1b3d5f7a9c2", "Startseite: Kacheln", "Jonas", 72, ["b8d4f6a2c0e7b3d9f5a1c7e3b9d5f1a7c3e9b5d0"],
    [{ name: "main", kind: "head" }], [{ status: "M", path: "src/start.tsx" }]),
  gitC("b8d4f6a2c0e7b3d9f5a1c7e3b9d5f1a7c3e9b5d0", "Frontend angelegt", "Jonas", 96, [], [], [{ status: "A", path: "index.html" }]),
];
function gitGraphList(repo, extent) {
  if (repo === "frontend") return GIT_GRAPH_FRONTEND;
  return extent === "current" ? GIT_GRAPH_CURRENT : GIT_GRAPH_MAIN;
}
const gitRelative = (hours) => {
  const days = Math.round(hours / 24);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  return days === 1 ? "1 day ago" : `${days} days ago`;
};
// The answer of `POST …/git/log` with `graph` (server electron/server/git.js `gitGraphLog`): parents, refs, HEAD, time, `clipped`, `extent`.
function gitGraph(repo, extent, limit) {
  const all = gitGraphList(repo, extent);
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const now = Math.floor(Date.now() / 1000);
  return {
    commits: all.slice(0, n).map((c) => ({
      hash: c.hash, short: c.hash.slice(0, 7), subject: c.subject, author: c.author, relative: gitRelative(c.hours),
      parents: c.parents, refs: c.refs, head: c.refs.some((r) => r.kind === "head"), time: now - c.hours * 3600,
    })),
    clipped: all.length > n,
    extent: extent === "current" ? "current" : "all",
  };
}
// The answer of `POST …/git/show` (server `gitCommitPart`): with `files` the files against the first parent, with `file` their diff,
// otherwise the whole commit. An unknown hash is a 404.
function gitCommitPart(repo, request) {
  const c = [...GIT_GRAPH_MAIN, ...GIT_GRAPH_FRONTEND].find((x) => x.hash === request.hash);
  if (!c) return null;
  const short = c.hash.slice(0, 7);
  if (request.files === true) return { hash: c.hash, parent: c.parents, files: c.file, total: c.file.length, clipped: false };
  if (typeof request.file === "string") {
    const old = typeof request.old === "string" ? request.old : null;
    return {
      hash: c.hash, path: request.file, old: old,
      diff: `diff --git a/${old ?? request.file} b/${request.file}\n--- a/${old ?? request.file}\n+++ b/${request.file}\n@@ -1,2 +1,2 @@\n-alt vor ${short}\n+neu in ${short}`,
      clipped: false,
    };
  }
  return { hash: c.hash, diff: c.file.map((d) => `diff --git a/${d.path} b/${d.path}\n@@ -1 +1 @@\n-alt\n+neu in ${short}`).join("\n") };
}

// ── Git overview ──────────────────────────────────────────────────────────────
// Only on request (`POST /fixture/gitView { on: true }`, routes-git.mjs): the fixture project is then switched (instance row,
// `repos: 1`), `/api/projectCreation/rules` reports server mode, and `…/git` carries `branchesRunning`/`counter`. `reset-run` clears
// everything (`resetGitView`). Times in ms, computed at EVERY answer from now — the timeline then always stands in the window.
// The seed: two groups (Checked out, From cbase), a copy row (k1) under the same-named main row, a running and a finished subagent
// (the latter with bar and branch-off before the 30-day window), an unread copy (k2, stopped).
S.gitView = false;
S.gitViewFetches = [];
S.gitViewRetrievals = 0;

function gitViewRows() {
  const now = Date.now();
  const min = 60_000, std = 3_600_000, tag = 86_400_000;
  const row = (z) => ({
    group: "checkedOut", local: true, remote: null, detached: null, instance: "main", toRemote: null, toMain: null,
    sinceCreation: null, branchPoint: null, last: null, commits: { points: [], count: 0, notFetched: null }, checkedOut: [],
    user: null, state: null, ...z,
  });
  return [
    row({
      name: "fn/till", remote: "origin/fn/till", toRemote: { ahead: 1, back: 0 },
      toMain: { ahead: 3, back: 2, merged: false }, branchPoint: now - 6 * tag,
      last: { t: now - 2 * std, author: "Fixture", subject: "Price rounding fixed" },
      commits: { points: [{ t: now - 5 * tag, pushed: true }, { t: now - 2 * tag, pushed: true }, { t: now - 2 * std, pushed: false }], count: 3, notFetched: [] },
      checkedOut: [{ instance: "main", worktree: null, notBackedUp: 3, chats: [{ chatId, title: "Queue-Test" }] }],
    }),
    row({
      name: "fn/till", instance: "k1", remote: "origin/fn/till", toRemote: { ahead: 2, back: 0 },
      toMain: { ahead: 5, back: 2, merged: false }, sinceCreation: { ahead: 2, back: 0 }, branchPoint: now - 6 * tag,
      last: { t: now - 40 * min, author: "Agent", subject: "Till in the copy" },
      commits: { points: [{ t: now - 5 * tag, pushed: true }, { t: now - 2 * tag, pushed: true }, { t: now - 3 * std, pushed: false }, { t: now - 40 * min, pushed: false }], count: 4, notFetched: [] },
      checkedOut: [{ instance: "k1", worktree: null, notBackedUp: 1, chats: [] }],
      user: { kind: "copy", name: "k1", instance: "k1" },
    }),
    row({
      group: "cbase", name: "cbase/agent-3f2a", toMain: { ahead: 1, back: 0, merged: false }, branchPoint: now - 1 * std,
      last: { t: now - 10 * min, author: "Agent", subject: "Tests added" },
      commits: { points: [{ t: now - 10 * min, pushed: false }], count: 1, notFetched: null },
      checkedOut: [{ instance: "main", worktree: "/tmp/mobile-fixture/.cbase/worktrees/agent-3f2a", notBackedUp: 0, chats: null }],
      user: { kind: "subagent", name: "Tests", chatId, agentId: "agent-3f2a" }, state: "running",
    }),
    row({
      group: "cbase", name: "cbase/agent-91c0", toMain: { ahead: 22, back: 40, merged: false }, branchPoint: now - 45 * tag,
      last: { t: now - 9 * tag, author: "Agent", subject: "Review finished" },
      commits: { points: null, count: 22, notFetched: null },
      user: { kind: "subagent", name: "Review", chatId, agentId: "agent-91c0" }, state: "ended",
    }),
  ];
}

function gitViewResponse(search = "") {
  const now = Date.now();
  const tag = 86_400_000;
  const s = String(search || "").toLowerCase();
  const rows = gitViewRows().filter((z) => !s || z.name.toLowerCase().includes(s));
  const line = Array.from({ length: 12 }, (_, i) => now - (33 - i * 3) * tag);
  return {
    repo: { rel: "", name: "Fixture-Projekt" },
    repos: [{ rel: "", name: "Fixture-Projekt" }],
    mainBranch: { name: "main", source: "origin/HEAD" },
    instances: [
      { name: "main", color: null, read: true, remoteState: { at: now - 3 * 60_000, source: "fetch-head" } },
      { name: "k1", color: 2, read: true, remoteState: { at: now - 12 * 60_000, source: "fetch-head" } },
      { name: "k2", color: 4, read: false, reason: "stopped", remoteState: { at: null, source: "unknown" } },
    ],
    line: { commits: line, count: line.length, from: line[0], until: line[line.length - 1] },
    rows,
    clipped: null,
  };
}

// The fields of the small view in the repo of `…/git`: the running rows of the main (the checked-out one with chat, the running subagent).
function gitViewSmall() {
  const rows = gitViewRows();
  return {
    branchesRunning: rows.filter((z) => z.instance === "main" && (z.group === "checkedOut" || z.state === "running")),
    counter: { checkedOut: 1, branches: 0, cbase: 2, remote: 0 },
  };
}

// Notifications (German wording of the server, bound by server/backend/test/notify.test.js): global default per kind, plus a registered device with the last APNs answer — without it the test measures the empty
// state instead of the device list.
const NOTIFY_KINDS = [
  { key: "question", chat: true, preset: true, label: "Rückfrage", hint: "Ein Lauf braucht deine Antwort und steht so lange still." },
  { key: "approval", chat: true, preset: true, label: "Freigabe", hint: "Ein Agent will ein Werkzeug ausführen, das deine Freigabe braucht — der Lauf wartet." },
  { key: "review", chat: true, preset: true, label: "Review", hint: "Eine Review-Node wartet auf dein Urteil." },
  { key: "finished", chat: true, preset: false, label: "Antwort fertig", hint: "Ein Lauf ist zu Ende und hat geantwortet." },
  { key: "workflow", chat: true, preset: false, label: "Workflow-Schritt", hint: "Ein Workflow hat einen Schritt erreicht, der ein Häkchen trägt." },
  { key: "trigger", chat: true, preset: false, label: "Workflow ausgelöst", hint: "Ein Workflow wurde von außen ausgelöst (z. B. GitLab)." },
  // Usage limit: parked AND continued report the same kind — order and default as in notify.js, otherwise the notification page checks
  // against another list than the one the real server sends.
  { key: "limit", chat: true, preset: true, label: "Nutzungslimit", hint: "Ein Lauf wartet auf den Reset eines Nutzungslimits — und meldet sich, wenn er weiterläuft." },
  // (The kind "manager" — a proposal of the manager — is gone, as in notify.js.)
  { key: "schedule", chat: false, preset: true, label: "Zeitplan", hint: "Ein zeitgesteuerter Lauf ist fertig oder gescheitert." },
  { key: "service", chat: false, preset: true, label: "Dienst", hint: "Ein Dienst ist ausgefallen oder wieder erreichbar." },
  { key: "info", chat: false, preset: false, label: "Hinweis", hint: "Aufnahmen und sonstige Hinweise." },
];
const NOTIFY_CHAT_KINDS = NOTIFY_KINDS.filter((a) => a.chat).map((a) => a.key);
const NOTIFY_SCHEDULE_KINDS = ["schedule", "question", "approval"];
// The global default per kind at module start (`reset-run` resets it the same way).
S.notifyGlobal = Object.fromEntries(NOTIFY_KINDS.map((a) => [a.key, a.preset]));
// Auto-compact: the global stage as on the real server (autocompact.js).
const AUTOCOMPACT_STAGES = [30, 40, 50, 60, 70, 80, 90];
// The absolute cap: 50k steps up to one million, same build as on the server.
const AUTOCOMPACT_MAX_STAGES = Array.from({ length: 20 }, (_, i) => (i + 1) * 50_000);
S.autocompactPercent = 0;
S.autocompactMax = 0;
const autocompactDoc = () => ({
  percent: S.autocompactPercent, stages: AUTOCOMPACT_STAGES,
  maxTokens: S.autocompactMax, maxStages: AUTOCOMPACT_MAX_STAGES,
});
// Adjust: remembered instructions and the last call (for the test).
S.adjustPrompts = [];
S.adjustSeq = 0;
S.adjustLast = null;
S.adjustCounter = 0;
// A registered device (Notifications → Devices, `GET /api/push/status`): seeded at module start — `SettingsUITests/
// testNotificationSettingsAndPerChatOverride` looks for "iPhone · sandbox".
S.pushDevices = [
  { installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", environment: "sandbox", locale: "de",
    createdAt: 1_800_000_000_000, lastSeen: 1_800_000_260_000,
    lastStatus: 200, lastReason: "", lastPushAt: 1_800_000_260_000 },
];
S.pushTests = 0;

// ── Settings that exist new on mobile ─────────────────────────────────────────
// Every secret value follows the real server here: it is stored and used but NEVER returned — the answer says only THAT one is set
// (`hasKey` or `hasToken`). Seed and reset read from the SAME factories. Two separate literals would drift apart at the next field,
// and a test would check a state that existed only once; `channelSeed()` below has the same build for the same reason.

/// Read aloud (ElevenLabs). Without a key there is no voice list — that is the one condition on which the view hangs its "Load
/// voices" button.
const ttsSeed = () => ({
  apiKey: "",
  voiceId: "21m00Tcm4TlvDq8ikWAM",
  modelId: "eleven_multilingual_v2",
  baseUrl: "https://api.elevenlabs.io",
});
S.ttsConfig = ttsSeed();
/// Three voices, so the picker shows a choice and not a single row.
const TTS_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", labels: { accent: "american" } },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", labels: { accent: "american" } },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", labels: { accent: "american" } },
];

/// Web search of the own harness. The list is fixed — the real server silently normalizes anything unknown to `duckduckgo` instead of
/// answering 400.
const WEB_SEARCH_PROVIDERS = ["duckduckgo", "brave", "tavily", "searxng"];
const webSearchSeed = () => ({ provider: "duckduckgo", apiKey: "", baseUrl: "" });
S.webSearch = webSearchSeed();

/// Permanent tool approvals ("do not ask again"), notation as in Claude Code's settings.json. One rule is preset: otherwise the test
/// measures only the empty state and could not show that the list also DISPLAYED something.
const permissionRulesSeed = () => ["Bash(git status:*)"];
S.permissionRules = permissionRulesSeed();

/// Auto-continue at the usage limit. Default ON — on the real server the setting is missing at first, and a missing setting means "on"
/// there.
S.autoContinueEnabled = true;
/// The credit gate is the OTHER setting: own route, reversed default. On the real server a missing setting means OFF here
/// (`getSetting("credit_gate", "0")`). Two switches, two defaults — whoever merges them flips the other when flipping one.
S.creditGate = false;
/// The cap per user of the dynamic workflows: default 8 like on the real server.
S.dynWfCap = 8;
/// The size guideline of the dynamic workflows: default medium like on the real server.
S.dynWfSize = "medium";
S.administration = null; // Administration: seeded on the first retrieval in routes-settings.mjs (`administrationStatus`)
/// The percentage mark of the gate comes from the SERVER (limits.START_GATE_PERCENT), so the label in the app keeps no second, own 99.
const CREDIT_GATE_THRESHOLD = 99;
/// The credit state ("extra usage"), field by field like `creditStatus()` in limits.js. Amounts come ALREADY converted beside the raw values —
/// computing happens on the server because the division by 100 does not apply to JPY/KRW/VND. `active: false` would mean "this account
/// has no credit pot at all"; then the row would disappear in the app entirely and there would be nothing to check.
const creditSeed = () => ({
  active: true, unlimited: false, limit: 20, consumed: 2.4, currency: "USD",
  percent: 12, reason: "", blocked: false,
});
/// The time in the finished sentence comes from `dueAt`, so the row does not claim something other than the field beside it. Format as
/// `clockText` on the real server.
const limitClockTime = (ts) => new Date(ts).toLocaleString("de-DE", {
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
/// A waiting run, otherwise the section "Waiting for a reset" has nothing to show.
const autoContinueWaitingSeed = () => {
  const now = Date.now();
  const due = now + 45 * 60_000;
  return [{
    chatId, kind: "run", provider: "claude", group: "session", label: "5-Stunden-Limit",
    limitText: "Claude · 5-Stunden-Limit", reason: "reset",
    resetsAt: due, dueAt: due,
    attempts: 0, probes: 0, maxAttempts: 6, evidence: "", workflow: false, gate: false,
    createdAt: now, updatedAt: now,
    text: `Fortsetzung um ${limitClockTime(due)}`,
  }];
};
S.autoContinueWaiting = autoContinueWaitingSeed();

/// GitLab accounts. The token never leaves the fixture — the row carries only `hasToken`.
const gitlabAccountId = "a0000000-0000-4000-8000-000000000001";
const gitlabAccountsSeed = () => {
  const now = Date.now();
  return [{
    id: gitlabAccountId, label: "Examplecorp", host: "https://git.example",
    userName: "maintainer", userId: 42, hasToken: true, status: "",
    checkedAt: now - 3_600_000, createdAt: now - 86_400_000, updatedAt: now - 3_600_000,
  }];
};
S.gitlabAccounts = gitlabAccountsSeed();
S.gitlabSeq = 1;
/// Counter of the check runs ("Check" button). The display value in the view does not prove the delivery — this counter does.
S.gitlabTests = 0;

/// The tokens lie BESIDE the accounts, not in them — exactly as the real server keeps them in the column and its mapper
/// (`store.mapGitlabAccount`) cuts them off on reading. If the token lay in the account object, it would go out with the `{ ...acc }`
/// spread of every answer, and the promise "the token never leaves the server" would be exactly the one not checked in the test rig.
const gitlabTokensSeed = () => new Map([[gitlabAccountId, "glpat-fixture-seed"]]);
S.gitlabTokens = gitlabTokensSeed();
/// Accounts whose token the played GitLab no longer accepts. That is the only way to the error branch of `POST …/test`: a token that
/// GitLab rejects on creation never enters the stock — the case arises in reality because a valid token is withdrawn LATER. Set via
/// `POST /fixture/gitlab { id, valid: false }`.
S.gitlabRevoked = new Set();

/// The played GitLab: the one place where a token is decided. It stands here and not three times in the routes, so creating, changing
/// and checking cannot drift apart. A token that starts with "glpat-" and was not revoked is accepted; the error message is that of
/// the real server (`gitlab.js`, 401 branch), because the view shows it unchanged.
function gitlabCheck(accountId, token) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, error: "No token stored." };
  if (!t.startsWith("glpat-") || (accountId && S.gitlabRevoked.has(accountId))) {
    return { ok: false, error: "Token ungültig oder abgelaufen (401)." };
  }
  // The same user as in the seed: a check run writes `userName` back to the account, and a differing name would make the row jump from
  // "@maintainer" to another after every click on "Check" — in real operation that only happens if the token really belongs to
  // another account.
  return { ok: true, userName: "maintainer", userId: 42, name: "Maintainer Doe" };
}

/// Fixed OpenRouter: the access behind `GET/PUT/DELETE /api/openrouter` (contract OPENROUTER_*, routes-usage.mjs) — WITHOUT a key from
/// the factory (the provider is "not connected" and appears in no model choice), both privacy switches on. `lastPut` is the last body
/// that arrived WITHOUT the key itself (`apiKey: true|false|""`), `defaultModel` what `PUT /api/default-model` set per provider.
/// `resetSettings` clears. The free third-party providers (`providerConfigs`, presets, model catalog) are gone.
const openrouterSeed = () => ({ key: "", onlyWithoutSaving: true, noDataUsage: true, lastPut: null });
S.openrouter = openrouterSeed();
S.defaultModel = {};

/// Default level per provider: what `PUT /api/default-effort` set. Empty = preset, like the server (providers/index.js effortStandard):
/// for Claude on the fallback model Sonnet 5.5 the fallback level high (DEFAULT_EFFORT_FALLBACK), for Codex the catalog level of Sol
/// (medium), otherwise medium. `/api/providers` delivers it as `defaultEffort`; `resetSettings` clears it.
const DEFAULT_LEVEL_PREFILL = { codex: "medium", claude: "high", flat: "medium", openrouter: "medium" };
S.defaultLevel = {};
const defaultLevelOf = (id) => S.defaultLevel[id] || DEFAULT_LEVEL_PREFILL[id] || "medium";

/// App agents: the settings row per key as on the server (`agent_model_<key>` → {provider?, model?, effort?}) and the last PUT body per
/// key — from it the test checks that "Default" arrived AS "" and not as an omitted key. `effective` replays the resolution of the
/// server: Haiku for the cheap one-shots (no levels ⇒ no choice), Sonnet for curator and services scan, otherwise the active provider
/// (codex/Sol).
// The four `manager_*` are gone — as in settings/agent-models.js.
const AGENT_MODEL_KEYS = ["title", "goal", "workflow", "compact", "curator", "classify", "services", "channel_status", "adjust"];
const AGENT_HAIKU = new Set(["title", "goal", "workflow", "channel_status", "adjust"]);
const AGENT_SONNET = new Set(["curator", "services"]);
S.agentModels = {};
S.agentModelsPut = {};
const agentEffective = (key) => {
  const z = S.agentModels[key] || {};
  if (z.provider && z.model) return { provider: z.provider, model: z.model };
  if (AGENT_HAIKU.has(key)) return { provider: "claude", model: "claude-haiku-4-5-20251001" };
  if (AGENT_SONNET.has(key)) return { provider: "claude", model: "claude-sonnet-5" };
  return { provider: "codex", model: "gpt-5.6-sol" };
};

/// The OpenRouter catalog (excerpt — the real one carries hundreds of models with tools): twenty entries, more than a menu would hold, so
/// the search of the model choice (Kit/ModelSelection.swift) has something to find. Without `efforts`, like third-party models.
const OPENROUTER_MODELS = [
  ["z-ai/glm-5.3-flash", "GLM 5.3 Flash"], ["z-ai/glm-5.3", "GLM 5.3"], ["deepseek/deepseek-v4", "DeepSeek V4"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"], ["qwen/qwen4-coder", "Qwen4 Coder"], ["qwen/qwen4-235b", "Qwen4 235B"],
  ["moonshotai/kimi-k3", "Kimi K3"], ["mistralai/devstral-3", "Devstral 3"], ["mistralai/mistral-large-4", "Mistral Large 4"],
  ["google/gemini-3.5-pro", "Gemini 3.5 Pro"], ["google/gemini-3.5-flash", "Gemini 3.5 Flash"], ["x-ai/grok-5", "Grok 5"],
  ["x-ai/grok-5-mini", "Grok 5 Mini"], ["meta-llama/llama-5-405b", "Llama 5 405B"], ["minimax/minimax-m3", "MiniMax M3"],
  ["nousresearch/hermes-5", "Hermes 5"], ["cohere/command-a-2", "Command A 2"], ["amazon/nova-pro-2", "Geo Pro 2"],
  ["openai/gpt-oss-240b", "gpt-oss-240b"], ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"],
].map(([id, label]) => ({ id, label, context: 262_144 }));

/// Agent hooks (loop engine). The list stays EMPTY: that is the neutral state.
///
/// The events are VERBATIM those of the real server (`server/backend/electron/server/toolchain/profiles.js`, constant `HOOK_EVENTS` —
/// search with `grep -a`, otherwise grep takes the file for binary). A shorter list would be especially costly here: the first THREE
/// are also the hard-coded fallback of the view (`AgentHooksSettings.swift`, `events`). If only they stand in the fixture,
/// no test can tell whether the view read the list from the answer or silently used its fallback — the regression "the app shows only
/// the first three" would stay green. With all nine, the mere presence of `SessionStart` separates the two cases.
const HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "SessionEnd",
  "PreCompact", "SubagentStop", "Stop", "Notification",
];
S.agentHooks = [];

/// All new settings back to the seed. Call at the test START, not via `defer` — the suite runs with `continueAfterFailure = false`, a
/// failure skips every `defer`.
function resetSettings() {
  S.ttsConfig = ttsSeed();
  S.webSearch = webSearchSeed();
  S.permissionRules = permissionRulesSeed();
  S.autoContinueEnabled = true;
  S.autoContinueWaiting = autoContinueWaitingSeed();
  // The credit gate is a GLOBAL switch like those above and must go back for the same reason: a test that switches it on and then fails
  // skips its `defer` (`continueAfterFailure = false`) — the next run would find it on and check the default against a setting it
  // never set.
  S.creditGate = false;
  S.dynWfCap = 8;
  S.dynWfSize = "medium";
  S.administration = null;
  // And the waiting state on the chat: a run parked by the gate is a one-time state like the queue. If it stayed, the next test would
  // show an orange strip including "Start anyway" without having seeded it.
  S.limitWait = null;
  S.limitAttemptAnyway = null;
  S.gitlabAccounts = gitlabAccountsSeed();
  S.gitlabSeq = 1;
  S.gitlabTests = 0;
  S.gitlabTokens = gitlabTokensSeed();
  S.gitlabRevoked = new Set();
  S.openrouter = openrouterSeed();
  S.defaultModel = {};
  S.defaultLevel = {};
  S.agentModels = {};
  S.agentModelsPut = {};
  S.agentHooks = [];
  // Auto-compact belongs here although it is older than the rest of this function: without these four lines
  // `testAutocompactSettingAndPerChatOverride` was green only against a FRESHLY started fixture. Its first step claims "default off"; a
  // second run in the same process inherited the 60 % of its predecessor and failed with "("60") is not equal to ("0")" — a failure
  // that looks like a defect in the app and was none.
  S.autocompactPercent = 0;
  S.autocompactMax = 0;
  // The choice per chat is the same setting one level down and must go back with it: if it stayed, the next run would check the default
  // against a deviation it never set.
  S.chat.autocompact = null;
  S.chat.autocompactMax = null;
  for (const entry of extraChats) { entry.autocompact = null; entry.autocompactMax = null; }
}
// "default" is never stored — otherwise there would be two spellings for the same state.
function notifyChoice(raw, allowed = NOTIFY_CHAT_KINDS) {
  const out = {};
  for (const [kind, value] of Object.entries(raw || {})) {
    if (allowed.includes(kind) && (value === "on" || value === "off")) out[kind] = value;
  }
  return out;
}
// Approval card: on request (`POST /fixture/approval`) ONE open card in the history of the main chat. Default without, otherwise the
// row tests would count one card too many; `POST /fixture/approval {off:true}` clears it (like `/fixture/channel {off:true}`, not
// `reset-run`: it is seeded BEFORE the app start).
S.approvalSeed = false;
S.approvalDecision = null;
const APPROVAL_REQUEST_ID = "perm-approval-0001";
const APPROVAL_INPUT = { chat: "Test Contact A", text: "Testsystem steht — bitte morgen abnehmen." };
function approvalRows(id) {
  if (!S.approvalSeed || id !== chatId) return [];
  const at = 1_800_000_260_000;
  const rows = [{
    role: "approval", ts: at, attachments: [],
    text: JSON.stringify({
      requestId: APPROVAL_REQUEST_ID, toolName: "mcp__teams__teams_send_message", server: "Teams-Archiv", key: "teams",
      tool: "teams_send_message", description: "Send a message. [writes to Teams]", writing: true,
      input: APPROVAL_INPUT, at,
    }),
  }];
  if (S.approvalDecision) {
    rows.push({
      role: "approval_ruling", ts: at + 60_000, attachments: [],
      text: JSON.stringify({ requestId: APPROVAL_REQUEST_ID, toolName: "mcp__teams__teams_send_message", ...S.approvalDecision, origin: "user", at: at + 60_000 }),
    });
  }
  return rows;
}
// ── Channels ──
// A channel between the main chat and the extra chat "Zahlungs-Bug im Checkout", seeded on request (`POST /fixture/channel`). The
// default stays WITHOUT channel: the row counts of the chat tests would otherwise see one channel card more. `POST /fixture/channel
// {off:true}` clears it again.
const channelId = "90000000-0000-4000-8000-000000000001";
const channelPartnerId = "20000000-0000-4000-8000-000000000003";
S.channelSeed = false;
S.channel = null;
function channelSeed() {
  return {
    id: channelId, workspaceId, name: "Kasse-Umbau", status: "open", cap: 8, agentsSinceHuman: 1,
    lastSeq: 2, readSeq: 0, creatorChatId: channelPartnerId, proposalItemId: null,
    createdAt: 1_800_000_300_000, updatedAt: 1_800_000_301_000,
    participants: [
      { chatId: channelPartnerId, participantKind: "chat", cursor: 2, name: "Zahlungs-Bug im Checkout", kind: "normal", unread: 0, running: false },
      { chatId, participantKind: "chat", cursor: 2, name: "Queue-Test", kind: "normal", unread: 0, running: false },
    ],
    messages: [
      { messageId: 1, seq: 1, sender: { kind: "chat", chatId: channelPartnerId, name: "Zahlungs-Bug im Checkout" }, systemKind: "", text: "Bitte zuerst den Zahlungsfluss prüfen — die Belege liegen in der Ablage.", files: [], at: 1_800_000_300_000 },
      { messageId: 2, seq: 2, sender: { kind: "chat", chatId, name: "Queue-Test" }, systemKind: "", text: "Zahlungsfluss geprüft: zwei Stellen offen, Plan liegt bei.", files: [{ name: "plan.md", size: 1240, origin: "workspace", file: "channel-2-1-plan.md" }], at: 1_800_000_301_000 },
    ],
  };
}
// `publicChannel` of the server: participants with cursor rest, unread of the user against the read mark; the messages only on request
// (single view), as cards with channel name.
function channelView(k, { messages = false } = {}) {
  const { messages: n, ...rest } = k;
  const out = { ...rest, unreadUser: Math.max(0, k.lastSeq - k.readSeq) };
  if (messages) out.messages = n.map((m) => ({ channelId: k.id, channelName: k.name, direction: "log", ...m }));
  return out;
}
function channelSystem(k, kind, text) {
  k.lastSeq += 1;
  k.messages.push({ messageId: k.lastSeq, seq: k.lastSeq, sender: { kind: "system", chatId: null, name: "System" }, systemKind: kind, text, files: [], at: Date.now() });
  k.updatedAt = Date.now();
}
// The channel rows in the history of a participant (role "channel"): "out" on the sender, "in" on the recipient, system messages as
// "log" — like `channelCard` on the server.
function channelRows(participantChatId) {
  if (!S.channelSeed || !S.channel || !S.channel.participants.some((t) => t.chatId === participantChatId)) return [];
  return S.channel.messages.map((m) => ({
    role: "channel", ts: m.at, attachments: [],
    text: JSON.stringify({
      channelId: S.channel.id, channelName: S.channel.name, messageId: m.messageId, seq: m.seq,
      direction: m.sender.kind === "system" ? "log" : m.sender.chatId === participantChatId ? "out" : "in",
      sender: m.sender, systemKind: m.systemKind, text: m.text, files: m.files, at: m.at,
    }),
  }));
}

// ── Terminal (fixture) ──────────────────────────────────────────────────────
// PTY substitute: output via SSE, input via POST, size is recorded. The first output is deliberately SHORT (so one can check that it
// starts at the top and does not stand in the middle) and contains a long line that respects the reported column width. It imitates
// the stream of the server (terminal-stream.js, same functions: buffer, counter `end`, `id:`/`until`, resume, `replaced`);
// subscribing and re-creating are in routes-devtools.mjs.
const terminalId = "50000000-0000-4000-8000-000000000001";
const terminalState = { cols: 0, rows: 0, streams: new Set(), input: [], buffer: "", end: 0 };

function terminalWrite(text) {
  terminalState.buffer = truncateBuffer(terminalState.buffer + text);
  terminalState.end += text.length;
  const line = dataRow(text, terminalState.end);
  for (const stream of terminalState.streams) {
    try {
      stream.write(line);
    } catch {
      terminalState.streams.delete(stream);
    }
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function event(streams, body) {
  const line = `data: ${JSON.stringify(body)}\n\n`;
  for (const response of streams) {
    if (S.silentStreams.has(response)) continue;
    try {
      response.write(line);
    } catch {
      streams.delete(response);
    }
  }
}

function chatEvent(body) {
  event(chatStreams, body);
}

function globalEvent(body) {
  event(globalStreams, body);
}

// ── Archive ──────────────────────────────────────────────────────────────────
// `chats`/`folder`: id → archivedAt (ms). `withFolder`: chat id → folder id of the chats that went to the archive WITH their folder
// (only they come back with it). `deleted`: finally deleted chats (the constant `extraChats` stays untouched). The switches of the
// tests: `open` (pre-check: null | "open" | "question"), `shells` (open shells per chat), `delete409` (DELETE of a chat answers 409
// as for a running one), `contextFiles` (folder id → number), `dismissed` (number of questions discarded — the test reads it).
function archiveEmpty() {
  return {
    chats: new Map(), folder: new Map(), withFolder: new Map(), deleted: new Set(),
    open: null, shells: 0, delete409: false, contextFiles: {}, dismissed: 0,
  };
}

/// The page of the lists (`archive=without|only|including`, default without) — an unknown value is `null` (400 as on the server).
/// Verbatim like `archivePage` in server/backend/electron/server/runs/archive.js: only a MISSING parameter is "without", an EMPTY one
/// (`?archive=`) is an unknown value (`|| "without"` made it a silent 200, and a client defect that sends `archive=` would stay green
/// in every UI test). Bound in web/test/ios-archive.test.mjs.
function archivePage(url) {
  const v = url.searchParams.get("archive");
  if (v === null) return "without";
  return ["without", "only", "including"].includes(v) ? v : null;
}

function matchesArchive(page, archived) {
  return page === "including" || (page === "only") === archived;
}

function withArchive(entry) {
  return { ...entry, archivedAt: S.archive.chats.get(entry.id) ?? null };
}

/// What the final DELETE deletes on an archived folder — and with it what the confirmation names (GET …/archive). Like `finalSet`
/// on the server: only archived chats of the folder (there are only Coding folders).
function finalSet(folder) {
  return [S.chat, ...extraChats].filter((c) => c.folderId === folder.id && S.archive.chats.has(c.id) && !S.archive.deleted.has(c.id));
}

/// The reasons for open work — the texts verbatim as `runs/archive.js` (the server writes them), in German here because ShellUITests matches them.
function archiveOpen(id) {
  const open = [];
  if (id === chatId && S.running) open.push({ reason: "running", text: "Ein Lauf ist aktiv" });
  if (S.archive.open === "open") {
    open.push({ reason: "running", text: "Ein Lauf ist aktiv" });
    open.push({ reason: "queue", text: "1 Nachricht wartet in der Warteschlange" });
  }
  if (S.archive.open === "question") open.push({ reason: "question", text: "Eine Rückfrage wartet auf Antwort" });
  return open;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function schedule(delay, action) {
  const timer = setTimeout(action, delay);
  S.timers.push(timer);
}

function clearRun() {
  for (const timer of S.timers) clearTimeout(timer);
  S.timers = [];
  S.running = false;
  S.waiting = false;
  S.runStreamText = ""; // without a run no unsaved text (like `runStreamText.delete` on the server)
  S.runStreamFull = "";
}

function publicQueue() {
  // `controllable` since the user-message split: only user messages can be steered, and the strip shows the "Steer" button only then. In the
  // fixture they are always user messages.
  return S.queue.map(({ id, text }) => ({ id, text, controllable: true }));
}
// The library of the dynamic workflows (see `S.dynWorkflows`). The script stands BYTE-IDENTICAL in the entry; the lists do not hand it
// out (`dynShort`, like the short entry on the server).
function dynScript(name, rest = "") {
  return `export const meta = {\n  name: "${name}",\n  description: "Fixture",\n};\n\n// Tab:\t| Umlaut: äöü | Zeichen: {}[]<>\n${rest}await agent("go");\n`;
}
function dynWorkflowsDefault() {
  return [{ id: "61000000-0000-4000-8000-000000000001", name: "daily-report", description: "Collects the day in three phases.", title: null, whenToUse: null, phases: [{ title: "Collect" }], createdAt: 0, updatedAt: 0, script: dynScript("daily-report") }];
}
function dynLibrarySeed() {
  return [
    ...dynWorkflowsDefault(),
    {
      id: "61000000-0000-4000-8000-000000000002", name: "review.v2-final_x", description: "Checks a diff in two rounds.", title: "Review v2",
      whenToUse: "Wenn ein Merge Request vor dem Abnehmen steht.", phases: [{ title: "Lesen", detail: "Diff und Tickets" }, { title: "Urteilen" }],
      createdAt: 0, updatedAt: 0, script: dynScript("review.v2-final_x", "const rounds = 2;\n"),
    },
    {
      id: "61000000-0000-4000-8000-000000000003", name: "review-v2-final-x", description: "The neighbor with an almost identical name.", title: null,
      whenToUse: null, phases: [], createdAt: 0, updatedAt: 0, script: dynScript("review-v2-final-x"),
    },
    // WITHOUT whenToUse and WITHOUT phases — the fields are missing entirely (an older state, a foreign server).
    { id: "61000000-0000-4000-8000-000000000004", name: "without-meta", description: "Nur Name und Beschreibung.", createdAt: 0, updatedAt: 0, script: dynScript("without-meta") },
  ];
}
function dynShort(w) {
  const { script: _script, ...short } = w;
  return short;
}

export { AGENT_MODEL_KEYS, dynWorkflowsDefault, dynLibrarySeed, dynShort, dynScript, agentEffective, workspaceId, chatId, projectId, workspace, workspaceId2, workspace2, extraChats, chatStreams, globalStreams, browserId, browserState, crc32, pngChunk, framePng, fixturePng, fixtureFiles, defaultWorkflows, defaultSkills, defaultPagesSkills, longSkillBody, limitWaitState, limitWaitFor, limitEvent, autoContinueList, stepsOf, emptyRun, runOf, lockOf, LOCK_SCOPES_FIXTURE, workflowMeta, workflowFull, artifactSha, artifactMeta, ASK_REQUEST_ID, ASK_QUESTIONS, ASK_QUESTIONS_THREE, fileByPath, fileTree, browserFrame, resetGit, gitTree, gitGraph, gitCommitPart, gitViewRows, gitViewResponse, NOTIFY_KINDS, NOTIFY_CHAT_KINDS, NOTIFY_SCHEDULE_KINDS, AUTOCOMPACT_STAGES, AUTOCOMPACT_MAX_STAGES, autocompactDoc, ttsSeed, TTS_VOICES, WEB_SEARCH_PROVIDERS, webSearchSeed, permissionRulesSeed, CREDIT_GATE_THRESHOLD, creditSeed, limitClockTime, autoContinueWaitingSeed, gitlabAccountId, gitlabAccountsSeed, gitlabTokensSeed, gitlabCheck, openrouterSeed, OPENROUTER_MODELS, defaultLevelOf, HOOK_EVENTS, resetSettings, notifyChoice, APPROVAL_REQUEST_ID, APPROVAL_INPUT, approvalRows, channelId, channelSeed, channelView, channelSystem, channelRows, archiveEmpty, archivePage, matchesArchive, withArchive, archiveOpen, finalSet, terminalId, terminalState, terminalWrite, json, event, chatEvent, globalEvent, body, schedule, clearRun, publicQueue, servicesProject2, servicesSeed, serviceResources, SERVICES_HOST_GATEWAY, SERVICES_HOST_BACKEND, SERVICES_AGENT_BROWSER, channelPartnerId };
