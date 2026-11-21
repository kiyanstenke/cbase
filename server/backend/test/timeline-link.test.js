// Guards for the links of the timeline:
//
//   (1) C append-only: UPDATE/DELETE on `timeline_revisions` fail at the trigger; deleting the project clears the revisions with it.
//   (2) C human: POST …/timeline/:eid/revision - both fields missing => 400, unknown => 404, equal => 409 UNCHANGED, new => 200 and the
//       list shows the new revision with its history (the first stays in the row), a dismissed one => 409 DISMISSED, cap => 409 TOO_MANY;
//       the agent's search finds the old AND the new wording.
//   (3) C agent: action "revise" - without justification => 400, foreign field => 400, without marker => 403, with marker => 200 from
//       "agent"; the MCP tool passes `revision` through flat (source read) and the server knows the same action (AGENT_ACTIONS <-> enum).
//   (4) A links: a repo with a GitLab remote => MR/commit/branch links and identifiers in title/text; two repos => only what is unambiguous
//       ("frontend!171" yes, "o!31", "!5" and the ambiguous "backend!2" no); GitHub paths; an SSH alias without a dot => no links; a token
//       in the remote never leaves the server; the agent gets no links.
//   (5) B agenda: `agendaItem` with the text of the item from the agenda of the citation chat (gone => text null); GET …/timeline/proofs
//       (chat missing => 400, foreign chat => 404) returns exactly the events with an agenda item, also parts.
//
// COUNTER-TESTS: trigger `timeline_revisions_no_update` struck => (1) red; the `DISMISSED` check struck in revisions.js => (2) red;
// `r.length === 1` replaced by `r.length >= 1` in references.js => (4) red ("o!31" linked); `agendaItem` without the agenda text in
// read.js => (5) red.
//
// CBASE_EMBED_OFFLINE=1 CBASE_OPENROUTER_OFFLINE=1 CBASE_CHAT_BROWSER_OFF=1 node --test --test-reporter=tap server/backend/test/timeline-link.test.js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { AGENT_ACTIONS, timelineAgentAction } from "../electron/server/timeline/agent.js";
import { REVISIONS_MAX } from "../electron/server/timeline/revisions.js";
import { timelineEvent, searchTimeline } from "../electron/server/timeline/read.js";
import { identifiers, remotesFromConfig, forgetReferences } from "../electron/server/timeline/references.js";
import { json, makeWorkspace, makeProject, ok, withServer } from "./server-harness.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const withServerValue = (fn) => withServer(async (ctx) => {
  try { await fn(ctx); } finally { for (const l of store.outerLoopRunsOpen()) store.outerLoopRunEnd(l.id, { state: "aborted" }); forgetReferences(); }
});
const newChat = (base, workspaceId, projectId) => ok(`${base}/api/chats`, {
  method: "POST", body: JSON.stringify({ workspaceId, projectId, provider: "claude", model: MODEL, permissionMode: "bypassPermissions" }),
});
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
function repo(dir, remote, branch = null) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  // The cases write the first 10 characters of this SHA into a text, and the link recognition takes hex only with a letter in it
  // (a run of digits is a number, see "hex only with a digit and a letter" below). A random SHA starts with 10 digits in about 1 %
  // of runs (seen in the gate, 21.11.2026: 3505458463…) — amend until the prefix carries a letter, so the case tests what it names.
  for (let i = 0; i < 50 && !/[a-f]/.test(git(dir, "rev-parse", "HEAD").slice(0, 10)); i++) git(dir, "commit", "-q", "--amend", "-m", `one ${i}`);
  if (remote) git(dir, "remote", "add", "origin", remote);
  if (branch) git(dir, "branch", branch);
  return git(dir, "rev-parse", "HEAD");
}
let seq = 0;
const one = (proj, chat, fields = {}) => {
  const id = `tl_${++seq}_${crypto.randomUUID().slice(0, 6)}`;
  store.enterTimeline({ id, projectId: proj.id, workspaceId: proj.workspaceId, kind: "git", title: "t", text: "", at: Date.now(),
    citationKind: "message", citationRef: String(1000 + seq), chatId: chat?.id ?? null, ...fields });
  return id;
};

async function seed({ base, wsPath }, { remote = "git@gitlab.example.com:group/frontend.git", under = null } = {}) {
  const projPath = path.join(wsPath, `p${++seq}`);
  let sha = null;
  if (under) {
    fs.mkdirSync(projPath, { recursive: true });
    for (const [name, url, branch] of under) sha = repo(path.join(projPath, name), url, branch);
  } else sha = repo(projPath, remote, "feature/x");
  const ws = await makeWorkspace(base, `W${seq}`, wsPath);
  const pj = await makeProject(base, ws.id, projPath);
  const proj = store.getProject(pj.id);
  const chat = await newChat(base, ws.id, pj.id);
  return { ws, proj, chat, sha };
}

test("(1) C append-only: timeline_revisions knows neither UPDATE nor DELETE; deleting the project clears them", async () => {
  await withServerValue(async (ctx) => {
    const { ws, proj, chat } = await seed(ctx);
    const id = one(proj, chat, { title: "old" });
    store.appendTimelineRevision({ eventId: id, title: "fresh", from: "human" });
    assert.throws(() => rawDb.prepare("UPDATE timeline_revisions SET title = 'x' WHERE event_id = ?").run(id), /timeline-only-append/, "UPDATE went through");
    assert.throws(() => rawDb.prepare("DELETE FROM timeline_revisions WHERE event_id = ?").run(id), /timeline-only-append/, "DELETE went through");
    assert.ok(store.deleteProject(ws.id, proj.id));
    assert.equal(rawDb.prepare("SELECT count(*) AS n FROM timeline_revisions").get().n, 0, "revisions after deleting the project");
  });
});

test("(2) C human: revision 400/404/409/200, history, DISMISSED, cap; the search finds old and new wording", async () => {
  await withServerValue(async (ctx) => {
    const { proj, chat } = await seed(ctx);
    const url = `${ctx.base}/api/projects/${proj.id}/timeline`;
    const id = one(proj, chat, { title: "MR !45 merged", text: "short" });
    const post = (eid, body) => json(`${url}/${eid}/revision`, { method: "POST", body: JSON.stringify(body) });
    let r = await post(id, {});
    assert.deepEqual([r.status, r.body.code], [400, "BODY"], "a missing field is no statement");
    r = await post("tl_nix", { title: "x" });
    assert.deepEqual([r.status, r.body.code], [404, "UNKNOWN"]);
    r = await post(id, { title: "  MR !45 merged  " });
    assert.deepEqual([r.status, r.body.code], [409, "UNCHANGED"]);
    r = await post(id, { title: "x".repeat(201) });
    assert.deepEqual([r.status, r.body.code], [400, "BODY"], "title cap as when entering");
    r = await post(id, { title: "MR !45 merged: export invoices as CSV", justification: "Subject missing" });
    assert.equal(r.status, 200);
    assert.equal(r.body.event.title, "MR !45 merged: export invoices as CSV");
    assert.equal(r.body.event.text, "short", "a missing field stays as it is");
    assert.deepEqual(r.body.event.revisions.map((f) => [f.title, f.from]), [["MR !45 merged", "agent"], ["MR !45 merged: export invoices as CSV", "human"]]);
    assert.equal(store.timelineRow(id).title, "MR !45 merged", "the event's row stays the first revision");
    const list = (await json(url)).body.events;
    assert.equal(list.find((e) => e.id === id).title, "MR !45 merged: export invoices as CSV", "the list shows the current one");
    assert.ok(searchTimeline(proj.id, { q: "csv" }).events.some((e) => e.id === id), "new wording found");
    assert.ok(searchTimeline(proj.id, { q: "!45 merged" }).events.some((e) => e.id === id), "old wording found");
    // Dismissed => no new revision.
    const v = one(proj, chat, { title: "wrong" });
    store.dismissTimeline({ eventId: v, from: "user", justification: "never happened" });
    r = await post(v, { title: "correct" });
    assert.deepEqual([r.status, r.body.code], [409, "DISMISSED"]);
    assert.equal(store.timelineRevisionsOf([v]).size, 0);
    // The cap.
    const d = one(proj, chat, { title: "d0" });
    for (let i = 1; i <= REVISIONS_MAX; i++) store.appendTimelineRevision({ eventId: d, title: `d${i}`, from: "agent", justification: "b" });
    r = await post(d, { title: "one more" });
    assert.deepEqual([r.status, r.body.code], [409, "TOO_MANY"]);
  });
});

test("(3) C agent: revise - justification required, foreign field 400, without marker 403, with marker 200; MCP and server know the same action", async () => {
  await withServerValue(async (ctx) => {
    const { ws, proj, chat } = await seed(ctx);
    const agent = store.createOuterLoopAgent({ id: `${ws.id}-tlv`, workspaceId: ws.id, name: "Timeline" });
    const run = store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: chat.id, trigger: "quiet" });
    const outerLoop = `${agent.id}:${run.id}`;
    const isTimeline = () => true;
    const id = one(proj, chat, { title: "Push" });
    const calls = (body) => timelineAgentAction(proj, { action: "revise", outerLoop, eventId: id, ...body }, { isTimeline });
    let r = await calls({ title: "Push to main: login fixed" });
    assert.deepEqual([r.status, r.body.code], [400, "JUSTIFICATION"]);
    r = await calls({ title: "x", justification: "b", kind: "code" });
    assert.deepEqual([r.status, r.body.code], [400, "BODY"]);
    r = await timelineAgentAction(proj, { action: "revise", eventId: id, title: "x", justification: "b" }, { isTimeline });
    assert.equal(r.status, 403);
    r = await calls({ title: "Push to main: login fixed", justification: "Subject added" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.event.revisions.map((f) => f.from), ["agent", "agent"]);
    assert.equal(r.body.event.revisions[1].justification, "Subject added");
    assert.equal("links" in r.body.event, false, "the agent gets no links");
    // Seam MCP <-> server: the action is in the tool's enum and in AGENT_ACTIONS; the tool passes `revision` through flat.
    const mcp = fs.readFileSync(fileURLToPath(new URL("../electron/mcp/tools/timeline.js", import.meta.url)), "utf8");
    const enumRow = mcp.match(/const WRITE_ACTIONS = (\[[^\]]+\]);/);
    if (!enumRow) throw new Error("anchor WRITE_ACTIONS not found in mcp/tools/timeline.js");
    assert.deepEqual(JSON.parse(enumRow[1]), [...AGENT_ACTIONS]);
    assert.match(mcp, /a\.action === "revise" && revision && typeof revision === "object" \? \{ \.\.\.rest, \.\.\.revision \}/);
  });
});

test("(4) A links: GitLab remote, identifiers in the text, two repos only if unambiguous, GitHub, SSH alias, no token to the outside", async (t) => {
  await withServerValue(async (ctx) => {
    // One repo, GitLab over SSH.
    const a = await seed(ctx);
    const e1 = one(a.proj, a.chat, { title: "frontend!171 merged", text: "See #47, Pipeline #9001 and Commit " + a.sha.slice(0, 10) + ".",
      branch: "feature/x", sha: a.sha, mrIid: 171 });
    const l1 = (await json(`${ctx.base}/api/projects/${a.proj.id}/timeline`)).body.events.find((e) => e.id === e1);
    const web = "https://gitlab.example.com/group/frontend";
    assert.deepEqual(l1.links.repo, { rel: "", name: path.basename(a.proj.path), provider: "gitlab", web });
    assert.equal(l1.links.mr, `${web}/-/merge_requests/171`);
    assert.equal(l1.links.commit, `${web}/-/commit/${a.sha}`);
    assert.equal(l1.links.branch, `${web}/-/tree/feature/x`);
    assert.deepEqual(l1.links.gitView, { repo: "", branch: "feature/x" });
    assert.deepEqual(l1.references.title, [{ t: "frontend!171", url: `${web}/-/merge_requests/171`, kind: "mr" }, { t: " merged" }]);
    const urls = l1.references.text.filter((s) => s.url).map((s) => [s.t, s.url]);
    assert.deepEqual(urls, [["#47", `${web}/-/issues/47`], ["Pipeline #9001", `${web}/-/pipelines/9001`], [a.sha.slice(0, 10), `${web}/-/commit/${a.sha.slice(0, 10)}`]]);
    assert.equal(l1.references.text.map((s) => s.t).join(""), "See #47, Pipeline #9001 and Commit " + a.sha.slice(0, 10) + ".", "the pieces make up the text");

    // Two repos: only the unambiguous; plus a token in the remote, a GitHub repo and an SSH alias.
    forgetReferences();
    const b = await seed(ctx, { under: [
      ["frontend", "https://oauth2:SECRET-TOKEN@gitlab.example.com/group/frontend.git", "feature/y"],
      ["backend", "git@github.com:org/backend.git", null],
      ["alias", "gitlab-work:group/alias.git", null],
      ["two", "git@gitlab.example.com:group/backend.git", null],
    ] });
    const e2 = one(b.proj, b.chat, { title: "o!31 and frontend!171 and !5 and backend!2 and org/backend!2 and alias!3" });
    const e3 = one(b.proj, b.chat, { title: "Branch", branch: "feature/y" });
    const e4 = one(b.proj, b.chat, { title: "SHA only", sha: b.sha });
    const raw = await json(`${ctx.base}/api/projects/${b.proj.id}/timeline`);
    assert.equal(JSON.stringify(raw.body).includes("SECRET"), false, "the remote's token never leaves the server");
    const l2 = raw.body.events.find((e) => e.id === e2);
    const linked = l2.references.title.filter((s) => s.url).map((s) => [s.t, s.url]);
    assert.deepEqual(linked, [["frontend!171", "https://gitlab.example.com/group/frontend/-/merge_requests/171"], ["org/backend!2", "https://github.com/org/backend/pull/2"]],
      "o!31 (unknown prefix), !5 (several repos, no anchor), backend!2 (two repos are called that: folder backend and the remote of two) and alias!3 (SSH alias without a web host) stay text");
    const l3 = raw.body.events.find((e) => e.id === e3);
    assert.equal(l3.links.branch, "https://gitlab.example.com/group/frontend/-/tree/feature/y", "the only repo that knows the branch");
    assert.deepEqual(l3.links.gitView, { repo: "frontend", branch: "feature/y" });
    const l4 = raw.body.events.find((e) => e.id === e4);
    assert.deepEqual([l4.links.repo, l4.links.commit], [null, null], "a SHA alone in several repos stays unlinked (open)");
    // The agent sees no links.
    assert.equal("references" in timelineEvent(b.proj.id, e2), false);
    // Pure: identifiers and remotes.
    assert.deepEqual(identifiers("x!1 y#2 abc!3").map((k) => [k.kind, k.number, k.prefix]), [["mr", 1, "x"], ["issue", 2, "y"], ["mr", 3, "abc"]]);
    assert.deepEqual(identifiers("deadbeef 1234567 a1b2c3d http://h/p!3 x.y/#4").map((k) => k.sha ?? k.number), ["a1b2c3d"], "hex only with a digit and a letter; no match in the middle of a path");
    assert.deepEqual(remotesFromConfig('[core]\n url = no\n[remote "up"]\n\turl = a:b/c\n[remote "origin"]\n url = "x:y/z" # k\n'), [{ name: "up", url: "a:b/c" }, { name: "origin", url: "x:y/z" }]);
    t.diagnostic(`Links: ${linked.length} of 6 identifiers in the title linked unambiguously`);
  });
});

test("(5) B agenda: agendaItem with text from the chat's agenda; GET …/timeline/proofs 400/404/200, also parts", async () => {
  await withServerValue(async (ctx) => {
    const { proj, chat, ws } = await seed(ctx);
    store.agendaChange(chat.id, () => ({ title: "Plan", description: "", nextSeq: 3,
      steps: [{ id: "s1", text: "Fix login", status: "in_work" }, { id: "s2", text: "Export", status: "open" }] }));
    const including = one(proj, chat, { title: "Push", agendaItemId: "s1" });
    const part = one(proj, chat, { title: "Tests green", agendaItemId: "s2" });
    const collecting = one(proj, chat, { title: "Collect" });
    store.appendTimelineParts(collecting, [part]);
    const gone = one(proj, chat, { title: "Old", agendaItemId: "s9" });
    one(proj, chat, { title: "no item" });
    const url = `${ctx.base}/api/projects/${proj.id}/timeline`;
    const list = (await json(url)).body.events;
    assert.deepEqual(list.find((e) => e.id === including).agendaItem, { id: "s1", chatId: chat.id, text: "Fix login", status: "in_work" });
    assert.deepEqual(list.find((e) => e.id === gone).agendaItem, { id: "s9", chatId: chat.id, text: null, status: null }, "the item is no longer in the agenda");
    assert.equal(list.find((e) => e.id === collecting).agendaItem, null);
    let r = await json(`${url}/proofs`);
    assert.deepEqual([r.status, r.body.code], [400, "BODY"]);
    const foreign = await seed(ctx);
    r = await json(`${url}/proofs?chat=${encodeURIComponent(foreign.chat.id)}`);
    assert.deepEqual([r.status, r.body.code], [404, "UNKNOWN"]);
    r = await json(`${url}/proofs?chat=${encodeURIComponent(chat.id)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.proofs.map((e) => e.id).sort(), [including, part, gone].sort(), "exactly those with an agenda item, the part included");
    assert.equal(r.body.clipped, false);
    assert.equal(r.body.proofs.find((e) => e.id === part).agendaItem.text, "Export");
    assert.ok(ws.id);
  });
});

// (6) Incident: "ip!20 on 317f114" linked the commit into the repo `backend`, because of several repos only that one had a web address -
// "the only repo WITH a web address" is not "the only repo". Without a prefix an identifier is only unambiguous if the project has exactly
// ONE repo. Counter-test: in references.js the standard repo again "the only repo with a web address" (`know.length === 1`) => red.
test("(6) A links: an identifier without a prefix does not go to the only repo with a web address when there are more repos", async () => {
  const { referencesOf } = await import("../electron/server/timeline/references.js");
  const withWeb = { rel: "backend", name: "backend", root: "/x/backend", remotePath: "examplecorp/backend", provider: "gitlab", web: "https://git.example.com/examplecorp/backend" };
  const withoutWeb = { rel: "web-portal", name: "web-portal", root: "/x/ip", remotePath: null, provider: null, web: null };
  const e = { title: "ip!20 on 317f114 pushed", text: "Commit 317f114, MR !20", anchor: null };
  const two = referencesOf(e, [withWeb, withoutWeb]);
  assert.equal(two.references.title, null, JSON.stringify(two.references.title));
  assert.equal(two.references.text, null, JSON.stringify(two.references.text));
  assert.equal(two.links.repo, null);
  // Counterpart: the project has only this one repo => unambiguous, linked.
  const one2 = referencesOf(e, [withWeb]);
  assert.ok(one2.references.text?.some((s) => s.url === "https://git.example.com/examplecorp/backend/-/commit/317f114"));
});

// (7) The same incident, second cause: the event had an anchor (branch feat/47… in the backend repo), and the anchor repo applied to EVERY
// identifier without a prefix in the text - "ip!20 on 317f114 … Closes #19" landed in the backend repo. With several repos an identifier
// without a prefix only links if it is the anchor itself (its commit, its MR). Counter-test: strike the line
// `if (!k.prefix && onlyAnchor && !anchorSelf(k, onlyAnchor)) repo = null;` in segments => red.
test("(7) A links: with several repos only the anchor itself belongs to the anchor repo, not every identifier without a prefix in the text", async () => {
  const { segments } = await import("../electron/server/timeline/references.js");
  const orch = { rel: "backend", name: "backend", root: "/x/o", remotePath: "examplecorp/backend", provider: "gitlab", web: "https://git.example.com/examplecorp/backend" };
  const ip = { rel: "web-portal", name: "web-portal", root: "/x/ip", remotePath: "examplecorp/web-portal", provider: "gitlab", web: "https://git.example.com/examplecorp/web-portal" };
  const text = "o!31 on c05debc, ip!20 on 317f114, Closes #19";
  const st = segments(text, [orch, ip], orch, { onlyAnchor: { sha: "c05debc1234", mrIid: null } });
  const urls = (st || []).filter((x) => x.url).map((x) => `${x.t} ${x.url}`);
  assert.deepEqual(urls, ["c05debc https://git.example.com/examplecorp/backend/-/commit/c05debc"], JSON.stringify(urls));
  // One repo alone: without onlyAnchor everything stays unambiguous.
  const alone = segments("on 317f114, Closes #19", [orch], orch);
  assert.equal(alone.filter((x) => x.url).length, 2);
});
