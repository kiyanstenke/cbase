// The timeline per project in the web:
//   (a) Wire: lib/api/timeline.ts builds the routes (GET with filters and `until`, PUT `{ active }`, POST …/dismiss), reads form E
//       with a default per field and carries the error code of the server up to the UI (`timelineError`), with a fake fetch;
//   (b) Server <-> web: the set of kinds is the same as store/timeline.js `TIMELINE_KINDS`, the event name `timeline` the same as
//       timeline/agent.js `reportTimeline`, and every kind has ONE icon and a translated word (components/timeline/TimelineForm.tsx);
//   (c) the row jump: `targetIndex` takes the last bubble whose first log row is not behind the row, bubbles created live
//       do not count; the stage carries `data-row` and calls the hook;
//   (d) wiring: tab "Timeline" of the project view, section of the right bar only with a project, "Show all" via the
//       project jump, every sentence of the timeline is in i18n-de.ts;
//   (e) the timeline bar: per row a node with the kind icon on the line (a line per day from the first to the last
//       node), node role dismissed > collective > normal, the detail card via portal at the body (no click catcher `fixed inset-0`),
//       its position never out of the window: in the bar left of the list, in the tab below or above the row;
//   (f) links and revisions on the wire: `links`, `references` (only http(s) becomes a link), `revisions`, `agendaItem`; the routes
//       of the new revision and of the proofs; the card draws chunks, links, agenda and revisions, the row and the card "Edit …";
//   (g) agenda <-> timeline: proofs per item, the agenda jump (only its chat, expires), wiring in bar, ChatPane and AgendaPanel,
//       every new sentence in i18n-de.ts.
// Counter-tests: `<=` replaced by `<` in `targetIndex` turns (c) red; deleting the line
// `if (key === "timeline" && !gitProjectId) return null;` in ChatRightSidebar turns (d) red; deleting `"ops"` from TIMELINE_KINDS in
// lib/api/timeline.ts turns (b) red; `top: !first` replaced by `top: true` in `linesChunks` turns (e) red; swapping the order
// dismissed/collective in `nodeRole` turns (e) red; `document.body` replaced by the list element in TimelineCard.tsx turns (e) red;
// `address` without the http(s) check in lib/api/timeline.ts turns (f) red; deleting `projectId={activeProject?.id ?? null}` on AgendaPanel
// in ChatRightSidebar turns (g) red; deleting the chat check in `agendaWish` in lib/agenda-jump.ts turns (g) red.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-timeline-web-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const translate = (rel, name) => {
  const target = path.join(out, name);
  execFileSync(process.execPath, [
    tsc, path.join(webDir, rel), "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck",
    "--lib", "es2022,dom", "--outDir", target,
  ], { cwd: webDir, stdio: "pipe" });
  return import(pathToFileURL(path.join(target, path.basename(rel).replace(/\.ts$/, ".js"))).href);
};
const wire = await translate("src/lib/api/timeline.ts", "api");
const jump = await translate("src/lib/rows-jump.ts", "jump");
const bar = await translate("src/lib/timeline-bar.ts", "bar");
const agendaJump = await translate("src/lib/agenda-jump.ts", "agenda-jump");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

function withFetch(response) {
  const prior = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : null });
    const { status = 200, body = {} } = typeof response === "function" ? response() : response;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, back: () => { globalThis.fetch = prior; } };
}

test("(a) Wire: routes, form E with a default per field, error code up to the UI", async () => {
  const event = {
    id: "tl_1", kind: "git", title: "Push", text: "", at: 5,
    citation: { kind: "tool", ref: "42", from: "subagent:ag1", chatId: "c1", chatTitle: "Build", tool: "Bash" },
    anchor: { branch: "main", sha: "abcdef1234", mrIid: null }, agendaItemId: null, tags: ["push"],
    dismissed: null, parts: [{ id: "tl_2", kind: "unknown", citation: {} }, { title: "without id" }],
  };
  const f = withFetch({ body: { active: true, events: [event, { without: "id" }], further: 3 } });
  try {
    const s = await wire.loadTimeline("p 1", { kind: "git", chat: "c1", word: " Push ", until: 9, limit: 999 });
    assert.equal(f.calls[0].url, "/api/projects/p%201/timeline?until=9&limit=200&kind=git&chat=c1&word=push");
    assert.equal(s.active, true);
    assert.equal(s.further, 3);
    assert.equal(s.events.length, 1, "an event without id drops out");
    const e = s.events[0];
    assert.deepEqual(e.citation, event.citation);
    assert.equal(e.parts.length, 1, "a part without id drops out");
    assert.equal(e.parts[0].kind, "other", "an unknown kind reads as other");
    assert.equal(e.parts[0].citation.kind, "message");
    assert.deepEqual(e.parts[0].parts, [], "parts carry no parts (one level)");
  } finally { f.back(); }

  const g = withFetch({ body: { ok: true, active: false } });
  try {
    assert.equal(await wire.setTimelineActive("p1", false), false);
    assert.deepEqual(g.calls[0], { url: "/api/projects/p1/timeline", method: "PUT", body: { active: false } });
  } finally { g.back(); }

  const h = withFetch({ status: 409, body: { ok: false, code: "ALREADY_DISMISSED", error: "tl_1 is already dismissed." } });
  try {
    await assert.rejects(wire.dismissTimelineEvent("p1", "tl_1", "wrong"), (e) => {
      assert.deepEqual(wire.timelineError(e), { code: "ALREADY_DISMISSED", text: "tl_1 is already dismissed.", status: 409 });
      return true;
    });
    assert.deepEqual(h.calls[0], { url: "/api/projects/p1/timeline/tl_1/dismiss", method: "POST", body: { justification: "wrong" } });
  } finally { h.back(); }
});

test("(b) Server <-> web: kinds, event name, one icon and one translated word per kind", () => {
  const store = read("server/backend/electron/server/store/timeline.js");
  const m = /(?:export )?const TIMELINE_KINDS = Object\.freeze\((\[[^\]]*\])\)/.exec(store);
  assert.ok(m, "TIMELINE_KINDS is missing in store/timeline.js");
  assert.deepEqual([...wire.TIMELINE_KINDS], JSON.parse(m[1]), "the kinds of the web are those of the server");
  assert.match(read("server/backend/electron/server/timeline/agent.js"), /broadcast\(\{ type: "timeline", projectId: String\(projectId\) \}\)/);
  const timeline = read("web/src/components/timeline/Timeline.tsx");
  assert.match(timeline, /evt\.type === "timeline" && String\(evt\.projectId \?\? ""\) === projectId/, "the view does not listen to the stream");
  const form = read("web/src/components/timeline/TimelineForm.tsx");
  const en = read("web/src/lib/i18n-de.ts");
  for (const kind of wire.TIMELINE_KINDS) {
    const z = new RegExp(`\\n  ${kind}: \\{ word: "([^"]+)", icon: `).exec(form);
    assert.ok(z, `KIND_FORM has no row for ${kind}`);
    assert.ok(en.includes(`\n  "${z[1]}": `), `the word "${z[1]}" is missing in i18n-de.ts`);
  }
});

test("(c) Row jump: the bubble of the row, bubbles created live do not count, the stage carries the marker", () => {
  const { targetIndex, rowsWish, rowsWishDone, ROWS_JUMP_VALID_MS } = jump;
  assert.equal(targetIndex([10, 14, 20], 14), 1, "the row is the first of its bubble");
  assert.equal(targetIndex([10, 14, 20], 17), 1, "a tool call sits in the answer that began before it");
  assert.equal(targetIndex([10, 14, undefined], 99), 1, "a bubble created live is no target");
  assert.equal(targetIndex([10, 14], 3), -1, "before the first bubble there is no target");
  // The wish: only for its chat, expires after the deadline.
  const events = [];
  globalThis.window = { dispatchEvent: (e) => events.push(e.type) };
  globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
  jump.openChatRow("c1", 42, 1000);
  assert.deepEqual(events, ["cbase-open-chat", "cbase-open-row"], "the jump opens the chat via the shared path");
  assert.equal(rowsWish("c2", 1000), null, "a foreign chat does not get the wish");
  const w = rowsWish("c1", 1000);
  assert.equal(w?.row, 42);
  rowsWishDone(w);
  assert.equal(rowsWish("c1", 1000), null, "served once it is gone");
  jump.openChatRow("c1", 7, 0);
  assert.equal(rowsWish("c1", ROWS_JUMP_VALID_MS + 1), null, "an expired wish no longer scrolls");
  const stage = read("web/src/components/chat/ChatStage.tsx");
  assert.match(stage, /<Fragment key=\{i\}>\s*\{day && <DaySeparator key="day" marker=\{day\} \/>\}\s*<Contained key="row" ck=\{ck\} row=\{rowOfTheBubble\(b\)\}>/);
  // Contract addition: also `window` and `loadOlder`: if the row lies before the window, the hook loads up to it
  // (guard web/test/chat-open.test.mjs "Window: wiring ...").
  assert.match(stage, /useRowsJump\(\{ activeId, chatLoading, count: bubbles\.length, msgsRef, stickRef, window: timeWindow, loadOlder \}\);/);
  assert.match(read("web/src/lib/contain.tsx"), /data-contain="" data-row=\{row\}/);
});

test("(d) Wiring: tab of the project view, section of the bar only with a project, \"Show all\", i18n", () => {
  assert.match(read("web/src/components/projects/ProjectView.tsx"), /\{ key: "timeline", label: t\("Timeline"\), icon: TIMELINE_SYMBOL\(15\), reason: null \}/);
  assert.match(read("web/src/components/projects/ProjectsPane.tsx"), /view === "timeline" \? \(\n[^\n]*\n\s*<Timeline key=\{op\.id\} projectId=\{op\.id\} workspaceId=\{workspaceId\} \/>/);
  const bar = read("web/src/components/chat/ChatRightSidebar.tsx");
  assert.match(bar, /if \(key === "timeline" && !gitProjectId\) return null;/, "without a project the button would sit at the rail");
  assert.match(bar, /<Timeline key=\{`timeline:\$\{gitProjectId\}`\} projectId=\{gitProjectId\} workspaceId=\{wsId\} compact onEverything=\{\(\) => showProjectTimeline\(/);
  assert.match(read("web/src/lib/project-jump.ts"), /timeline: \{\},/, "the sub-item \"timeline\" is missing in the project jump");
  // Every sentence of the timeline components and of the bar branch is translated.
  const en = read("web/src/lib/i18n-de.ts");
  const sets = new Set();
  for (const file of ["web/src/components/timeline/Timeline.tsx", "web/src/components/timeline/TimelineRow.tsx", "web/src/components/timeline/TimelineCard.tsx"]) {
    for (const m of read(file).matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)) sets.add(m[1]);
  }
  sets.add("This chat is not assigned to a project — the timeline belongs to a project.");
  for (const w of ["executed", "reported", "Today", "Yesterday"]) sets.add(w);
  const missing = [...sets].filter((s) => !en.includes(`\n  "${s}": `));
  assert.deepEqual(missing, [], "sentence without a German entry in i18n-de.ts");
});

test("(e) Timeline: node on the line, role of the node, detail card at the body and inside the window", () => {
  const { TIMELINE, linesChunks, nodeRole, timelineCardsSituation } = bar;
  // The line: per day from the first to the last node, at the middle of the node column.
  assert.deepEqual(linesChunks(true, true), { top: false, bottom: false, x: TIMELINE.clockTime + TIMELINE.gap + TIMELINE.node / 2 },
    "a single event of the day has no line");
  assert.deepEqual([linesChunks(true, false).top, linesChunks(true, false).bottom], [false, true], "the first row: only below the node");
  assert.deepEqual([linesChunks(false, true).top, linesChunks(false, true).bottom], [true, false], "the last row: only above the node");
  assert.deepEqual([linesChunks(false, false).top, linesChunks(false, false).bottom], [true, true]);
  // The role: dismissed before collective before normal.
  assert.equal(nodeRole({ dismissed: { from: "agent" }, parts: [{}] }), "dismissed");
  assert.equal(nodeRole({ dismissed: null, parts: [{}] }), "collecting");
  assert.equal(nodeRole({ dismissed: null, parts: [] }), "normal");
  // The position: bar (lateral) left of the list; without room or in the tab below the row, flush with the title; otherwise above.
  const window = { w: 1400, h: 900 };
  const card = { w: 400, h: 200 };
  const row = { left: 1100, top: 300, right: 1380, bottom: 330 };
  const list = { left: 1080, top: 0, right: 1400, bottom: 900 };
  assert.deepEqual(timelineCardsSituation(row, list, card, window, { lateral: true, x: 1150 }),
    { left: 674, top: 300, width: 400, maxHeight: 884, page: "left" });
  const bottom = timelineCardsSituation({ left: 300, top: 300, right: 1000, bottom: 330 }, { left: 280, top: 0, right: 1200, bottom: 900 }, card, window, { lateral: false, x: 360 });
  assert.deepEqual([bottom.left, bottom.top, bottom.page], [360, 336, "bottom"]);
  const top = timelineCardsSituation({ left: 300, top: 800, right: 1000, bottom: 830 }, { left: 280, top: 0, right: 1200, bottom: 900 }, card, window, { lateral: false, x: 360 });
  assert.deepEqual([top.top, top.page], [594, "top"]);
  const margin = timelineCardsSituation(row, { left: 100, top: 0, right: 1400, bottom: 900 }, card, window, { lateral: true, x: 1300 });
  assert.equal(margin.left, window.w - 8 - card.w, "never beyond the right window edge");
  // Wiring: row with node and line, card via portal at the body, no click catcher.
  const rowSrc = read("web/src/components/timeline/TimelineRow.tsx");
  assert.match(rowSrc, /data-timeline-node=\{role\}/, "the row carries no node");
  assert.match(rowSrc, /\{form\.icon\(part \? 10 : 12\)\}/, "the node does not carry the kind icon");
  assert.match(rowSrc, /const line = linesChunks\(first, last\);/);
  const cardSrc = read("web/src/components/timeline/TimelineCard.tsx");
  assert.match(cardSrc, /createPortal\(\n\s*<Card [^\n]*\n[^\n]*\/>,\n\s*document\.body,/, "the card is not attached to the body");
  assert.match(cardSrc, /data-timeline-card-text/, "the card does not show the description");
  for (const file of ["Timeline.tsx", "TimelineRow.tsx", "TimelineCard.tsx"]) {
    assert.doesNotMatch(read(`web/src/components/timeline/${file}`), /fixed inset-0/, `${file}: click catcher fixed inset-0`);
  }
  assert.match(read("web/src/components/timeline/Timeline.tsx"), /const card = useTimelineCard\(\{ lateral: compact, projectId, workspaceId, onEdit: setEdit \}\);/);
});

test("(f) Links and revisions: wire with default, only http(s) as a link, routes of the revision and of the proofs, card and sheet", async () => {
  const raw = {
    id: "tl_9", kind: "git", title: "frontend!171 merged", text: "", at: 1, citation: { kind: "message", ref: "3" },
    references: { title: [{ t: "frontend!171", url: "https://gl.example/g/f/-/merge_requests/171", kind: "mr" }, { t: " merged" }, { t: "x", url: "javascript:alert(1)", kind: "mr" }], text: null },
    links: { repo: { rel: "", name: "f", provider: "gitlab", web: "https://gl.example/g/f" }, mr: "https://gl.example/g/f/-/merge_requests/171", commit: "file:///etc/passwd", branch: null, gitView: { repo: "", branch: "main" } },
    revisions: [{ title: "old", text: "", from: "agent", justification: "", at: 1 }, { title: "frontend!171 merged", from: "human", justification: "Reason", at: 2 }],
    agendaItem: { id: "s1", chatId: "c1", text: "Login", status: "open" },
  };
  const e = wire.normEvent(raw);
  assert.deepEqual(e.references.title[0], { t: "frontend!171", url: "https://gl.example/g/f/-/merge_requests/171", kind: "mr" });
  assert.deepEqual(e.references.title[2], { t: "x", url: null, kind: null }, "an address without http(s) never becomes a link");
  assert.equal(e.links.commit, null, "file:// is no link");
  assert.deepEqual(e.links.gitView, { repo: "", branch: "main" });
  assert.deepEqual(e.revisions.map((f) => f.from), ["agent", "human"]);
  assert.deepEqual(e.agendaItem, { id: "s1", chatId: "c1", text: "Login", status: "open" });
  const empty = wire.normEvent({ id: "tl_0" });
  assert.deepEqual([empty.links, empty.references, empty.revisions, empty.agendaItem], [null, { title: null, text: null }, [], null], "an older server: defaults");
  assert.equal(wire.normEvent({ id: "tl_1", agendaItem: { id: "s9", chatId: "c1", text: null } }).agendaItem.text, null, "gone from the agenda stays null, not \"\"");

  const f = withFetch({ body: { ok: true, event: raw } });
  try {
    await wire.reviseTimelineEvent("p 1", "tl/9", { title: "fresh" });
    assert.deepEqual(f.calls[0], { url: "/api/projects/p%201/timeline/tl%2F9/revision", method: "POST", body: { title: "fresh" } });
  } finally { f.back(); }
  const g = withFetch({ body: { ok: true, proofs: [raw, { ...raw, id: "tl_8", agendaItemId: "s2" }, { ...raw, id: "tl_7", agendaItemId: "s2" }], clipped: false } });
  try {
    const r = await wire.loadTimelineProofs("p1", "c 1");
    assert.equal(g.calls[0].url, "/api/projects/p1/timeline/proofs?chat=c%201");
    const perItem = wire.proofsPerItem(r.proofs);
    assert.deepEqual([...perItem.keys()], ["s2"], "without agendaItemId no proof");
    assert.deepEqual(perItem.get("s2").map((x) => x.id), ["tl_8", "tl_7"]);
  } finally { g.back(); }

  const card = read("web/src/components/timeline/TimelineCard.tsx");
  assert.match(card, /<Chunks chunks=\{e\.references\.title\} text=\{e\.title\} \/>/, "the title of the card does not draw the chunks");
  assert.match(card, /<Chunks chunks=\{e\.references\.text\} text=\{e\.text\} \/>/, "the text of the card does not draw the chunks");
  assert.match(card, /<Links e=\{e\} t=\{t\} workspaceId=\{workspaceId\} projectId=\{projectId\} \/>/);
  assert.match(card, /showProjectGit\(\{ workspaceId, projectId, repo: ga\.repo, search: ga\.branch \}\)/, "the jump into the Git overview does not carry repo and branch");
  assert.match(card, /openAgendaPoint\(e\.agendaItem!\.chatId!, e\.agendaItem!\.id\)/);
  assert.match(card, /<Revisions revisions=\{e\.revisions\} t=\{t\} \/>/);
  assert.match(card, /href=\{s\.url\} target="_blank" rel="noreferrer"/);
  const row = read("web/src/components/timeline/TimelineRow.tsx");
  assert.match(row, /data-timeline-action": "edit"/);
  assert.match(row, /await reviseTimelineEvent\(projectId, event\.id, \{/);
  // The second client (iOS) reads the same fields and routes (a warning in the web does not protect iOS).
  const ios = read("mobile/CbaseMobile/Models/TimelineModels.swift");
  assert.match(ios, /case id, kind, title, text, at, citation, anchor, agendaItemId, tags, dismissed, parts, revisions, links, references, agendaItem\n/);
  assert.match(ios, /enum ReferenceKeys: String, CodingKey \{ case title, text \}/);
  assert.match(ios, /"\/api\/projects\/\\\(projectId\)\/timeline\/\\\(e\.id\)\/revision"/, "iOS does not write the revision to the route of the server");
  assert.match(ios, /schema == "https" \|\| schema == "http"/, "iOS takes only http(s) as a link");
  assert.match(read("mobile/CbaseMobile/Chat/AgendaSheet.swift"), /"\/api\/projects\/\\\(pid\)\/timeline\/proofs"/);
  const git = read("web/src/components/projects/git/GitView.tsx");
  assert.match(git, /const \[input, setInput\] = useState\(start\?\.search \?\? ""\);/, "the Git overview does not take the search of the jump");
});

test("(g) Agenda <-> timeline: jump only into its chat, proofs on the agenda, wiring, i18n", () => {
  const events = [];
  globalThis.window = { dispatchEvent: (e) => events.push([e.type, e.detail]) };
  globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
  agendaJump.openAgendaPoint("c1", "s3", 1000);
  assert.deepEqual(events, [["cbase-open-chat", "c1"], ["cbase-open-agenda", null]]);
  assert.equal(agendaJump.agendaWish("c2", 1000), null, "a foreign chat does not get the wish");
  const w = agendaJump.agendaWish("c1", 1000);
  assert.equal(w?.pointId, "s3");
  agendaJump.agendaWishDone(w);
  assert.equal(agendaJump.agendaWish("c1", 1000), null);
  agendaJump.openAgendaPoint("c1", "s3", 0);
  assert.equal(agendaJump.agendaWish("c1", agendaJump.AGENDA_JUMP_VALID_MS + 1), null, "an expired wish no longer jumps");

  const barSrc = read("web/src/components/chat/ChatRightSidebar.tsx");
  assert.match(barSrc, /<AgendaPanel key=\{`agenda:\$\{activeId\}`\} t=\{t\} chatId=\{activeId\} projectId=\{activeProject\?\.id \?\? null\} \/>/, "the agenda does not know the project of the chat, so no proofs");
  assert.match(read("web/src/components/chat/ChatPane.tsx"), /useAgendaJump\(\{ off: Boolean\(onlyChat\), activeId, chatLoading, open: \(\) => openRightRef\.current\("agenda"\) \}\);/);
  const panel = read("web/src/components/chat/AgendaPanel.tsx");
  assert.match(panel, /loadTimelineProofs\(projectId, chatId\)/);
  assert.match(panel, /evt\.type === "timeline" && String\(evt\.projectId \?\? ""\) === projectId/, "the proofs do not listen to the stream");
  assert.match(panel, /proofs=\{proofs\.get\(z\.point\.id\)\} highlight=\{highlight === z\.point\.id\}/);
  assert.match(panel, /character=\{TIMELINE_SYMBOL\(12\)\} count=\{proofs\.length\}/, "the row shows only the sign and the number");
  const en = read("web/src/lib/i18n-de.ts");
  const missing = [...panel.matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)].map((m) => m[1]).filter((s) => !en.includes(`\n  "${s}": `));
  assert.deepEqual(missing, [], "sentence of the agenda without a German entry");
});
