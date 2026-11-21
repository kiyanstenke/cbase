// The two jumps of the Git overview, web and iOS:
//   - "Agent in the chat": src/lib/agent-jump.ts (the agentId is the key; subagent via `Agent.agentId`, fallback `Agent.id`,
//     a workflow agent as a row of its run; wait until the chat is loaded, after the grace period only the bar, a chat that never
//     opens is discarded) — compiled with tsc and executed; plus by path the wiring: the hook chat/chatAgentJump.ts listens to
//     `cbase-open-agent`, opens via `cbase-open-chat`, ChatPane calls it exactly once (not in the chat of a job) and passes
//     `workflowChoice` via ChatRightSidebar and AgentBar down to the run's card; iOS `AppState.openChat(_:agent:)` and the
//     request in `MobileChatView`;
//   - "Projects → Git": src/lib/project-jump.ts (ONE mechanism per sub-item — the wish for "Git" is a different one from that for
//     "Instances"; the instances themselves are held by active-runs.test.mjs), address there and back, and by path: the "Git" tab in
//     ProjectView.tsx, the remembered value "git" survives in app/workspaces/page.tsx, ProjectsPane shows it under the condition of
//     the instances plus the check `hatGitRepos`; iOS `projectGitShow` and the segment.
// Reads only source text and compiles two sheets without imports — also runs on Linux.
//
// COUNTER-TESTS (each red once): in `agentJumpTarget` the fallback via `Agent.id` removed => "Agent in the chat (sheet)" red; in
// app/workspaces/page.tsx `asProjectTab(savedProjectTab) ?? "services"` replaced by the old allow-list => "Projects → Git (web)" red.
// Built in (runs on every run): `openTargetProcedure` without the protection for the open chat => "jump onto the open chat" throws.
//
// A jump onto the already OPEN chat does not reload it (lib/archive.ts `openTargetProcedure` with `openId`, passed by the receiver in
// ChatPane — ONE place for all senders of `cbase-open-chat`); an expired agent jump on iOS is consumed before it opens a sheet.
//
// `showProjectGit` has no sender on the web (the "Branches" section of the web Git bar is gone): the mechanism (wish, event, address
// `?git=<p>`) is still held by "Projects → Git (sheet)", the receiver (GitView `takeProjectGitTarget`) stays. iOS keeps its jump
// receiver (`ProjectGitPage`), held by the iOS test below.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..");
const appDir = path.join(webDir, "..", "mobile", "CbaseMobile");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-jumps-"));
const translate = (rel, name) => {
  const target = path.join(out, name);
  execFileSync(process.execPath, [
    tsc, path.join(webDir, rel), "--outDir", target, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
    "--lib", "es2022,dom",
  ], { stdio: "pipe" });
  return import(pathToFileURL(path.join(target, path.basename(rel).replace(/\.ts$/, ".js"))).href);
};
const agent = await translate("src/lib/agent-jump.ts", "agent");
const project = await translate("src/lib/project-jump.ts", "project");
// A version of a sheet from text (for the built-in counter-test).
const translateText = (text, name) => {
  const d = path.join(out, `${name}-source`);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${name}.ts`);
  fs.writeFileSync(file, text);
  execFileSync(process.execPath, [
    tsc, file, "--outDir", path.join(out, name), "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--lib", "es2022,dom",
  ], { stdio: "pipe" });
  return import(pathToFileURL(path.join(out, name, `${name}.js`)).href);
};
const archiveSource = fs.readFileSync(path.join(webDir, "src/lib/archive.ts"), "utf8");
const archive = await translateText(archiveSource, "archive");

const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");
const web = (rel) => withoutComments(fs.readFileSync(path.join(webDir, rel), "utf8"));
const swift = (rel) => withoutComments(fs.readFileSync(path.join(appDir, rel), "utf8"));

// Catches the window events of a call (the sheet only knows `window.dispatchEvent`).
const sent = (f) => {
  const list = [];
  const prior = globalThis.window;
  globalThis.window = { dispatchEvent: (e) => { list.push({ type: e.type, detail: e.detail }); return true; } };
  try { f(); } finally { if (prior === undefined) delete globalThis.window; else globalThis.window = prior; }
  return list;
};

test("agent in the chat (sheet): the agentId is the key — subagent, fallback via the id, workflow row, nothing else", () => {
  const { agentJumpTarget } = agent;
  const agents = [{ id: "toolu_1", agentId: "a1" }, { id: "a2", agentId: "" }];
  const runs = [{ runId: "r1", agents: [{ n: 1, agentId: "w1" }, { n: 2, agentId: "w2" }] }];
  assert.deepEqual(agentJumpTarget("a1", agents, runs), { kind: "agent", id: "toolu_1" }, "the block is found via Agent.agentId");
  assert.deepEqual(agentJumpTarget("a2", agents, runs), { kind: "agent", id: "a2" },
    "an agent reported live without a tool call carries the agentId as id (lib/agents.ts) — the fallback is missing");
  assert.deepEqual(agentJumpTarget("w2", agents, runs), { kind: "workflow", runId: "r1", n: 2 });
  assert.equal(agentJumpTarget("unknown", agents, runs), null);
  assert.equal(agentJumpTarget("", [{ id: "", agentId: "" }], []), null, "an empty agentId matches no entry without an id");
});

test("agent in the chat (sheet): wait until the chat stands, then the target — otherwise after the grace period the bar, a chat that never opens expires", () => {
  const { agentJumpStep, AGENT_JUMP_VALID_MS, AGENT_JUMP_GRACE_PERIOD_MS } = agent;
  const w = { chatId: "c1", agentId: "a1", at: 1000 };
  const empty = { agents: [], runs: [] };
  assert.deepEqual(agentJumpStep(w, { ready: false, ...empty }, 1000 + AGENT_JUMP_VALID_MS), { kind: "wait" });
  assert.deepEqual(agentJumpStep(w, { ready: false, ...empty }, 1001 + AGENT_JUMP_VALID_MS), { kind: "dismiss" });
  const including = { agents: [{ id: "toolu_1", agentId: "a1" }], runs: [] };
  assert.deepEqual(agentJumpStep(w, { ready: false, ...including }, 1001), { kind: "wait" }, "before the chat was loaded it picked in the old one");
  assert.deepEqual(agentJumpStep(w, { ready: true, ...including }, 1001), { kind: "agent", id: "toolu_1" });
  const ready = { ...w, readySince: 5000 };
  assert.deepEqual(agentJumpStep(ready, { ready: true, ...empty }, 5000 + AGENT_JUMP_GRACE_PERIOD_MS - 1), { kind: "wait" });
  assert.deepEqual(agentJumpStep(ready, { ready: true, ...empty }, 5000 + AGENT_JUMP_GRACE_PERIOD_MS), { kind: "bar" });
  assert.deepEqual(agentJumpStep(w, { ready: true, ...empty }, 999_999), { kind: "wait" }, "without `readySince` the grace period only begins");
});

test("agent in the chat (sheet): `openAgent` sends `{ chatId, agentId }` under its own name, `agentJumpFrom` validates", () => {
  const { openAgent, agentJumpFrom, AGENT_EVENT } = agent;
  assert.equal(AGENT_EVENT, "cbase-open-agent");
  assert.deepEqual(sent(() => openAgent("c1", "a1")), [{ type: "cbase-open-agent", detail: { chatId: "c1", agentId: "a1" } }]);
  assert.deepEqual(sent(() => openAgent("c1", "")), [], "no jump without agentId");
  assert.deepEqual(agentJumpFrom({ chatId: " c1 ", agentId: "a1" }), { chatId: "c1", agentId: "a1" });
  for (const d of [null, "c1", { chatId: "c1" }, { chatId: "", agentId: "a1" }, { chatId: 5, agentId: "a1" }]) {
    assert.equal(agentJumpFrom(d), null, JSON.stringify(d));
  }
});

test("agent in the chat (wiring): hook listens to the event and opens via cbase-open-chat; ChatPane calls it once; the choice reaches the card", () => {
  const hook = web("src/components/chat/chatAgentJump.ts");
  assert.match(hook, /window\.addEventListener\(AGENT_EVENT, on\)/);
  assert.match(hook, /window\.dispatchEvent\(new CustomEvent\("cbase-open-chat", \{ detail: s\.chatId \}\)\)/,
    "the jump does not open the chat via the path of bell and channel bar (tab, marker)");
  assert.match(hook, /if \(disabled\) return;/, "the chat of a scheduled job listened too — two ChatPanes opened the same jump");
  assert.match(hook, /const ready = activeId === w\.chatId && !chatLoading;/);
  assert.match(hook, /open\.current\(step\.kind === "agent" \? step\.id : ""\);/);
  const pane = web("src/components/chat/ChatPane.tsx");
  assert.equal((pane.match(/useAgentJump\(/g) ?? []).length, 1);
  assert.match(pane, /const \{ workflowChoice \} = useAgentJump\(\{ off: Boolean\(onlyChat\), activeId, chatLoading, agents, dynTree, onAgentOpen \}\);/);
  assert.match(pane, /workflowChoice=\{workflowChoice\}/);
  assert.ok(pane.split("\n").length <= 2000, "ChatPane.tsx over the guard");
  assert.match(web("src/components/chat/ChatRightSidebar.tsx"), /workflows=\{dynTree\}\s*workflowChoice=\{workflowChoice\}/);
  assert.match(web("src/components/AgentBar.tsx"), /<DynWorkflowCard [^>]*choice=\{workflowChoice\?\.runId === e\.run\.runId \? workflowChoice : null\}/);
  const tree = web("src/components/chat/DynWorkflowTree.tsx");
  assert.match(tree, /useEffect\(\(\) => \{ if \(choice\) \{ setOpen\(true\); setSelected\(choice\.n\); \} \}, \[choice\]\);/);
  assert.match(tree, /jump=\{choice && b\.rows\.some\(\(z\) => z\.n === choice\.n\) \? choice\.nonce : undefined\}/);
  assert.match(tree, /useEffect\(\(\) => \{ if \(jump !== undefined\) setChoice\(true\); \}, \[jump\]\);/, "the row's phase would stay closed");
});

// A jump onto a chat: what `openTargetProcedure` opens and whether it reports "already open".
async function jumpOn(M, id, open) {
  const opened = [];
  let already = 0;
  const r = await M.openTargetProcedure(id, Promise.resolve([{ id: "c1" }, { id: "c2" }]), {
    applies: () => true, loadChat: async () => null, setMeta: () => {}, open: async (x) => { opened.push(x); },
    wsId: "w1", project: null, openOtherwise: true, openId: open, alreadyOpen: () => { already += 1; },
  });
  return { r, opened, already };
}
async function checkOpenChat(M) {
  assert.deepEqual(await jumpOn(M, "c1", "c1"), { r: true, opened: [], already: 1 },
    "a jump onto the open chat reopened it (open() clears attachments and approval cards, resets busy, rebuilds the stream)");
  assert.deepEqual(await jumpOn(M, "c2", "c1"), { r: true, opened: ["c2"], already: 0 }, "another chat opens as before");
  assert.deepEqual(await jumpOn(M, "c2", null), { r: true, opened: ["c2"], already: 0 }, "without an open chat it opens as before");
}

test("jump onto the open chat (sheet): `openTargetProcedure` reopens nothing, another one opens — counter-test without the protection", async () => {
  await checkOpenChat(archive);
  const protection = "if (openId !== null && openId === id) { alreadyOpen?.(); return true; }";
  assert.ok(archiveSource.includes(protection), "the protection in openTargetProcedure has a different wording — the counter-test no longer applies");
  const without = await translateText(archiveSource.replace(protection, ""), "archive-without-protection");
  await assert.rejects(() => checkOpenChat(without), "the check does not measure the protection");
});

test("jump onto the open chat (wiring): the receiver passes the open chat, the archive hook forwards it", () => {
  const pane = web("src/components/chat/ChatPane.tsx");
  assert.equal((pane.match(/window\.addEventListener\("cbase-open-chat"/g) ?? []).length, 1, "ChatPane is no longer the ONE receiver");
  assert.match(pane, /openTarget\(chatId, loadList\(\), \{ projectCheck: false, openOtherwise: true, openId: activeIdRef\.current, alreadyOpen: \(\) => setFolderView\(null\) \}\)/,
    "the receiver of cbase-open-chat does not pass the open chat — every jump onto it reloads it");
  assert.ok(pane.split("\n").length <= 2000, "ChatPane.tsx over the guard");
  const hook = web("src/components/chat/chatArchive.ts");
  assert.match(hook, /openId: opts\.openId \?\? null, alreadyOpen: opts\.alreadyOpen,/, "useArchive.openTarget does not pass `openId` on to openTargetProcedure");
  // The agent-jump hook never opens by itself — only via the event; if its chat already stands, the next step serves it.
  const jump = web("src/components/chat/chatAgentJump.ts");
  assert.ok(!/\bopen\(|openTarget\(/.test(jump), "chatAgentJump.ts opens the chat past the protection point");
});

test("Projects → Git (sheet): a separate wish per sub-item, the event names it, address there and back", () => {
  const { showProjectGit, takeProjectGitTarget, takeInstancesTarget, projectGitAddress, projectFromAddress, rememberProjectTarget,
    isProjectSubitem, JUMP_PARAMETER, PROJECT_JUMP_EVENT, VALID_MS } = project;
  rememberProjectTarget("instances", "p1", { instance: "copy-k1" });
  assert.deepEqual(sent(() => showProjectGit({ workspaceId: "w1", projectId: "p1", repo: "apps/web" })),
    [{ type: PROJECT_JUMP_EVENT, detail: { workspaceId: "w1", projectId: "p1", subitem: "git" } }]);
  assert.deepEqual(takeProjectGitTarget("p1"), { repo: "apps/web" });
  assert.equal(takeProjectGitTarget("p1"), null, "once picked up it is gone");
  assert.deepEqual(takeInstancesTarget("p1"), { instance: "copy-k1" }, "the Git jump took the instances wish with it");
  sent(() => showProjectGit({ workspaceId: "w1", projectId: "p2", repo: "" }));
  assert.deepEqual(takeProjectGitTarget("p2"), {}, "an empty repo is no choice");
  rememberProjectTarget("git", "p3", { repo: "x" }, 0);
  assert.equal(takeProjectGitTarget("p3", VALID_MS + 1), null, "an expired wish chooses nothing any more");

  const address = projectGitAddress({ workspaceId: "w 1", projectId: "p1", repo: "apps/web" });
  assert.equal(address, "/workspaces/?ws=w+1&git=p1&repo=apps%2Fweb");
  assert.deepEqual(projectFromAddress(new URLSearchParams(address.slice(address.indexOf("?") + 1))),
    { subitem: "git", projectId: "p1", target: { repo: "apps/web" } });
  assert.deepEqual(projectFromAddress(new URLSearchParams("git=p1&repo=")), { subitem: "git", projectId: "p1", target: {} });
  assert.equal(projectFromAddress(new URLSearchParams("ws=w1&repo=x")), null, "no jump without sub-item");
  for (const k of ["instances", "instance", "create", "git", "repo"]) assert.ok(JUMP_PARAMETER.includes(k), `${k} would stay in the address`);
  assert.equal(isProjectSubitem("git"), true);
  assert.equal(isProjectSubitem("services"), false, "\"Services\" is no jump target");
});

test("Projects → Git (web): \"Git\" tab under the condition of the instances, remembered as \"git\", containing the large Git overview", () => {
  const view = web("src/components/projects/ProjectView.tsx");
  assert.match(view, /export const PROJECT_TAB = \["services", "layout", "instances", "git", "timeline"\] as const;/);
  assert.match(view, /\.\.\.\(git \? \[\{ key: "git" as const, label: t\("Git"\)/);
  const page = web("src/app/workspaces/page.tsx");
  assert.match(page, /setProjectTab\(asProjectTab\(savedProjectTab\) \?\? "services"\);/, "a remembered tab \"git\" would fall back to \"Services\"");
  assert.match(page, /const view = op\?\.view === "context" \? "services" : asProjectTab\(op\?\.view\);/);
  const pane = web("src/components/projects/ProjectsPane.tsx");
  // The check reads the field `repos` of the project list and remembers the last count read per project.
  assert.match(pane, /const gitTab = instancesTab && hasGitRepos\(live, gitRemembered\.current\);/);
  assert.match(pane, /\(op\.view === "git" && !gitTab\) \? "services" : op\.view/, "a remembered tab \"git\" on a project without it");
  assert.match(pane, /git=\{gitTab\}/);
  assert.match(pane, /<GitView key=\{op\.id\} projectId=\{op\.id\} workspaceId=\{workspaceId\} \/>/, "the \"Git\" tab does not show the large overview");
  assert.ok(!pane.includes("Git overview follows"), "the placeholder \"Git overview follows\" is still there");
  // The large view picks up the wish of a jump (the repo) on mount and on the event.
  const viewGit = web("src/components/projects/git/GitView.tsx");
  // Picked up once (`start`) for repo AND search (the branch of a timeline event).
  assert.match(viewGit, /const \[start\] = useState\(\(\) => takeProjectGitTarget\(projectId\)\);\n\s*const \[repo, setRepo\] = useState<string \| null>\(start\?\.repo \?\? null\);/, "GitView does not pick up the wish on mount");
  assert.match(viewGit, /window\.addEventListener\(PROJECT_JUMP_EVENT, on\)/, "GitView does not listen to the jump event");
});

test("Projects → Git (web): hatGitRepos — the count decides, `null` does not hide again, without the field as before", async () => {
  // The function sits in ProjectsPane.tsx (a component with many imports) — here its body, cut from the source and compiled
  // without types: the real text is checked, not a replica.
  const pane = web("src/components/projects/ProjectsPane.tsx");
  const m = /export function hasGitRepos\(p: Project \| undefined, remembered: Map<string, boolean>\): boolean \{\n([\s\S]*?)\n\}\n/.exec(pane);
  assert.ok(m, "hatGitRepos(p, remembered) missing in ProjectsPane.tsx");
  const hasGitRepos = new Function("p", "remembered", m[1]);
  const g = new Map();
  assert.equal(hasGitRepos(undefined, g), false, "no tab without a project");
  assert.equal(hasGitRepos({ id: "alt" }, g), true, "without the field (old server) as before");
  assert.equal(hasGitRepos({ id: "p", repos: null }, g), false, "not read and never shown => do not show");
  assert.equal(hasGitRepos({ id: "p", repos: 2 }, g), true);
  assert.equal(hasGitRepos({ id: "p", repos: null }, g), true, "a `null` afterwards does not hide the shown tab again");
  assert.equal(hasGitRepos({ id: "p", repos: 0 }, g), false, "a read 0 hides it");
  assert.equal(hasGitRepos({ id: "p", repos: null }, g), false, "… and a `null` afterwards does not show it again");
  // Counter-test: a check that reads `null` as "no repos" (the silent empty) fails.
  const wrong = new Function("p", "remembered", m[1].replace("return remembered.get(p.id) ?? false;", "return false;"));
  const g2 = new Map();
  wrong({ id: "p", repos: 2 }, g2);
  assert.notEqual(wrong({ id: "p", repos: null }, g2), true, "the counter-test no longer applies (wording changed?)");
});

test("iOS (text): openChat(_:agent:) with a request the chat consumes; projectGitShow and the segment \"Git\"", () => {
  const app = swift("Models/AppState.swift");
  assert.match(app, /func openChat\(_ id: String, agent agentId: String\) \{\s*agentJump = [^\n]*AgentJump\(chatId: id, agentId: agentId\)\s*openChat\(id\)/);
  const jump = swift("Chat/AgentJump.swift");
  assert.match(jump, /let block = blockIdOfAgent\(agentId\)/, "the block does not come via blockIdOfAgent");
  assert.match(jump, /SubagentsRequest\(selection: "", wf: DynTreeSelection\(runId: run\.runId, n: a\.n\)\)/);
  const chat = swift("Chat/ChatView.swift");
  assert.match(chat, /\.task\(id: state\.agentJump\?\.id\) \{ await agentJumpLead\(\) \}/);
  // An expired jump is consumed BEFORE the question about the chat — otherwise a never-opened target chat would open the agent
  // sheet minutes later; the grace period starts anew after every reload.
  assert.match(chat, /guard let jump = state\.agentJump else \{ return \}\s*guard !jump\.expired else \{ state\.agentJump = nil; return \}\s*guard jump\.chatId == model\.chat\.id else \{ return \}/,
    "an expired agent jump is not consumed before the question about the chat");
  assert.match(chat, /if model\.loadingLog \{\s*readySince = nil/, "the grace period is not reset on reload");
  assert.equal((chat.match(/state\.agentJump = nil/g) ?? []).length, 4, "the request is not consumed on every exit");
  assert.match(chat, /SubagentsSheet\(model: model, initialSelection: request\.selection, initialWf: request\.wf,/);
  assert.match(swift("Chat/ChatDetailSheet.swift"), /\.task \{ if let initialWf \{ wfSelection = initialWf \} \}/);
  const view = swift("Code/ProjectView.swift");
  assert.match(view, /func projectGitShow\(projectId: String, repo: String\? = nil\) \{\s*projectShow\(ProjectWish\(projectId: projectId, page: \.git, repo: repo\)\)/);
  // The check reads `repos` of the project list; an unread one (`nil`) keeps the last state read.
  assert.match(view, /private var gitPossible: Bool \{ instancesPossible && \(Self\.hasGitRepos\(project\) \?\? gitRepos\) \}/);
  assert.match(view, /static func hasGitRepos\(_ project: Project\) -> Bool\? \{ project\.repos\.map \{ \$0 > 0 \} \}/);
  assert.match(view, /\(gitPossible \? \[CbSegment\(value: ProjectPage\.git, label: L\("Git"\), id: "project-git"\)\] : \[\]\)/);
  assert.match(view, /if !possible && page == \.git \{ page = \.services \}/);
  // The wish is picked up by the large view (Code/GitView.swift), only when in front and only its own — including the repo.
  const large = swift("Code/GitView.swift");
  assert.match(large, /guard visible, let w = state\.projectWish, w\.page == \.git, w\.projectId == project\.id else \{ return \}\s*state\.projectWish = nil\s*guard !w\.expired else \{ return \}\s*if let r = w\.repo \{ model\.repo = r \}/);
});
