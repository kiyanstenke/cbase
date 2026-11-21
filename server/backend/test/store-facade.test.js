// The store facade.
//
// `store.js` is a facade: `export { initStore, nowMs, isUniqueViolation } from "./store/db.js"` plus `export *` per topic
// file. Two things about that are silently dangerous, and this test makes them loud:
//  · `export *` SWALLOWS name collisions silently — if the same name is in two store/ files, it is missing on the facade, and
//    the error would only show at run time as `store.x is not a function`.
//  · A forgotten `export *` drops a whole topic file from the facade — 70 importers notice only when their route answers 500.
// Therefore the old names are FROZEN here (OLD_NAMES), `db` and `skillResRoot` must NOT leave the facade (the live binding
// stays internal), and no name may be declared in two store/ files. Counter-proof in the last test: a deliberate duplicate in
// a temp tree turns it red.
//
// The frozen list may only shrink when the function itself falls ON PURPOSE (a feature removed) — never to turn a red gate
// green. Removed so far: the architecture map, the registration agent's conflict-chat helpers, the workspace skill toggles
// (replaced by the opt-out wrapper exports), the free provider configs and the cost/subscription reports (replaced by
// wrapper exports of store/provider.js and account/usage-report.js), the seven store topics of the removed managing area, the C4
// planner topic file, `listAgentChats`, and the teardown of Managing with the schedule migration (store/teardown-transaction.js,
// store/boards-teardown.js, store/scheduled-migration.js). The remaining exports with a managing name have a caller (channel and
// suggestion readers).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, "../electron/server/store.js");
const STORE_DIR = path.join(HERE, "../electron/server/store");

// The exports of the monolith — alphabetical, as `Object.keys(...).sort()` returns them.
const OLD_NAMES = [
  "CHANNEL_STATUS", "LINK_KINDS", "abandonWorkflowRuns", "acquireLock", "addChannelMessage", "addChannelParticipants", "addMessage",
  "addProject", "addProjectService", "addRunStep", "addUsageEvent", "adoptableWorkspaceContextCategories",
  "adoptedWorkspaceContext", "bumpActiveRunAttempts", "bumpPendingResumeAttempts", "categories", "chatFolderCounts", "chatStats",
  "claimedPorts", "clearActiveRun", "clearContextEmbeddings", "clearGlobalProviderChatSessions", "clearPendingResume",
  "clearRunInputs", "clearSessionsForProvider", "contextEmbeddingBacklog", "contextEmbeddingStats", "countProjectVars",
  "countVars", "createAgent", "createChat", "createChatFolder", "createGitlabAccount", "createChannel", "createMcpServer",
  "createProjectContext", "createProjectVar", "createSkill", "createVar", "createWorkflow", "createWorkspace", "deleteAgent",
  "deleteChat", "deleteChatFolder", "deleteContext", "deleteGitCred", "deleteGitlabAccount", "deleteMcpServer",
  "deleteMessagesFrom", "deleteProject", "deleteProjectContext", "deleteProjectService", "deleteProjectVar", "deleteSkill",
  "deleteVar", "deleteWorkflow", "deleteWorkflowRun", "deleteWorkspace", "effectiveAgents", "effectiveMcpServers",
  "effectiveProjectVars", "effectiveSkills", "effectiveWorkflows", "effectiveWorkspaceVars", "ensureTriggerState", "finishRunStep",
  "ftsSearchContextItems", "ftsSearchProjectContext", "getAgent", "getAllSettings", "getChat", "getChatFolder",
  "getContextEmbeddings", "getContextItem", "getGitCred", "getGitlabAccount", "getGitlabAccountWithToken", "getChannel",
  "getChannelMessage", "getChannelMessageBySeq", "getChannelParticipants", "getLock", "getMcpServer", "getPendingResume", "getProject",
  "getProjectContext", "getProjectService", "getProjectVarByKey", "getSetting", "getSkill", "getSkillByName",
  "getStartInstructions", "getSuggestion", "getTriggerState", "getVarByKey", "getWorkflow", "getWorkflowByName", "getWorkflowRun",
  "getWorkflowRunById", "getWorkspace", "initStore", "insertContext", "insertSuggestion", "isUniqueViolation", "channelUnread",
  "channelUnreadOf", "lastRunStepId", "listActiveRuns", "listActiveWorkflows", "listAdoptedContextCategories",
  "listAllProjectServices", "listAllProjects", "listChatFolders", "listChats", "listChatsInFolder", "listContext",
  "listEnabledAgentIds", "listEnabledWorkflowNames", "listExcludedMcpServerIds", "listExcludedWorkspaceVarIds", "listGitCreds",
  "listGitlabAccounts", "listChannels", "listChannelsOfChat", "listChannelMessages", "listChannelParticipants", "listLocks",
  "listMcpServers", "listMessages", "listMessagesSince", "listMonitoredServices", "listOpenChannels", "listOpenAsks",
  "listOpenWorkflowRuns", "listPendingResumes", "listProjectAgents", "listProjectContext", "listProjectMcpServers",
  "listProjectServices", "listProjectSkills", "listProjectVars", "listProjectWorkflows", "listRunInputs", "listRunSteps",
  "listScannedPorts", "listSuggestions", "listTriggerStates", "listVars", "listWorkflowRuns", "listWorkspaceAgents",
  "listWorkspaceSkills", "listWorkspaceWorkflows", "listWorkspaces", "lockHolder", "lockOfRun", "messageStats", "normalizeLinks",
  "nowMs", "pendingSuggestionCounts", "projectContextCategories", "projectContextSlugs", "projectPortConflicts", "pruneRunHistory",
  "pruneTriggerStates", "reapStaleLocks", "releaseLock", "removeChannelParticipants", "renameProject", "renameWorkflowAdoptions",
  "renameWorkspace", "replaceProjectServices", "replaceRunInputs", "reschedulePendingResume", "resolveProjectVar",
  "resolveWorkspaceVar", "serviceCommandHistory", "setActiveRun", "setAgentEnabled", "setContextCategoryAdopted",
  "setContextEmbedding", "setGitCred", "setChannelCursor", "setChannelRead", "setMcpServerAvailable", "setPendingResume",
  "setSetting", "setStartInstructions", "setSuggestionStatus", "setWorkflowEnabled", "setWorkspaceVarAvailable",
  "skillResourceDir", "slugifyTitle", "startWorkflowRun", "uniqueSlug", "updateAgent", "updateChat", "updateChatFolder",
  "updateContext", "updateGitlabAccount", "updateChannel", "updateChannelMessageText", "updateMcpServer", "updateProjectContext",
  "updateProjectService", "updateProjectVar", "updateSkill", "updateTriggerState", "updateVar", "updateWorkflow",
  "updateWorkflowRun", "updateWorkflowRunById", "usageByRun",
];

// Rule R: the names are gone, not just struck from the frozen list. Counter-proof: restoring the old store/chats.js makes
// this red for all of them; restoring the old wrapper exports likewise.
test("listManagerChats, getPipelineChat, getSpecialChat, chatsWithRolesLevel, setLevelInstead and listAgentChats are no longer on the facade", async () => {
  const st = await import(STORE);
  for (const n of ["listManagerChats", "getPipelineChat", "getSpecialChat", "chatsWithRolesLevel", "setLevelInstead", "listAgentChats"]) assert.equal(n in st, false, n);
});

test("the facade carries all 212 old names", async () => {
  assert.equal(OLD_NAMES.length, 212, "the frozen list itself");
  const st = await import(STORE);
  const have = new Set(Object.keys(st));
  const missing = OLD_NAMES.filter((n) => !have.has(n));
  assert.deepEqual(missing, [], `missing on the facade: ${missing.join(", ")}`);
});

// The facade is wider than the monolith, and that should be NAMED: `export *` also passes on the wrapper exports
// (`export { … };` at the end of a topic file — helpers that a sibling needs and that were private in the monolith). Every
// name on the facade that is not old must come from exactly such a line — otherwise a topic file became silently more
// public than the cut demands.
test("every NEW name on the facade is a wrapper export of a topic file — no other", async () => {
  const st = await import(STORE);
  const old = new Set(OLD_NAMES);
  const wrapper = new Set();
  for (const f of fs.readdirSync(STORE_DIR).filter((n) => n.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(STORE_DIR, f), "utf8");
    for (const m of text.matchAll(/^export \{([^}]*)\};$/gm)) {
      for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) wrapper.add(n);
    }
  }
  const fresh = Object.keys(st).filter((n) => !old.has(n));
  const foreign = fresh.filter((n) => !wrapper.has(n));
  assert.deepEqual(foreign, [], `on the facade, neither old nor wrapper: ${foreign.join(", ")}`);
  // db and skillResRoot are wrappers of db.js, but must NOT pass — the facade names db.js explicitly with three names
  // instead of `export *` (test below).
  assert.ok(fresh.length > 0, "the split brings wrapper exports (cross imports between topic files)");
});

test("db and skillResRoot stay invisible — the live binding is store/db.js's business", async () => {
  const st = await import(STORE);
  assert.equal(st.db, undefined);
  assert.equal(st.skillResRoot, undefined);
  assert.equal(typeof st.initStore, "function");
  assert.equal(typeof st.nowMs, "function");
  assert.equal(typeof st.isUniqueViolation, "function");
});

// Exported top-level names of an ESM file — only the declaration forms that occur in the store:
// `export function x`, `export const x`/`export let x` (also several per line), `export { a, b };`.
export function exportedNames(text) {
  const out = [];
  for (const m of text.matchAll(/^export (?:async )?function\s+(\w+)/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^export (?:const|let|var)\s+(\w+)/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^export \{([^}]*)\};?/gm)) {
    for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) out.push(n.split(/\s+as\s+/).pop());
  }
  return out;
}

export function duplicates(dir) {
  const seen = new Map();
  const dup = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
    for (const n of exportedNames(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (seen.has(n) && seen.get(n) !== f) dup.push(`${n}: ${seen.get(n)} and ${f}`);
      seen.set(n, f);
    }
  }
  return dup;
}

test("no exported name is in two store/ files (export * would swallow it silently)", () => {
  assert.ok(fs.existsSync(STORE_DIR), "store/ exists");
  assert.deepEqual(duplicates(STORE_DIR), []);
});

test("counter-proof: a deliberate duplicate is reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-store-facade-"));
  try {
    fs.writeFileSync(path.join(dir, "a.js"), "export function listChats() {}\nexport const X = 1;\n");
    fs.writeFileSync(path.join(dir, "b.js"), "function listChats() {}\nexport const Y = 2;\n\nexport { listChats };\n");
    assert.deepEqual(duplicates(dir), ["listChats: a.js and b.js"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
