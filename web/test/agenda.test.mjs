// The agenda in the right chat rail: the pure computations (src/lib/agenda.ts, src/lib/api/agenda.ts) EXECUTED, plus
// the bindings that no type error reports:
//   (a) shape: `normAgenda` reads every response with a default per field: a step without id drops out, an unknown
//       status reads as "open" (as in the server), `version` 0 and `changedAt` null mean "never written"; plus the
//       tree fields `parent`, `depth`, `subitems`, `done`, `total`, `project` without field loss;
//   (b) tree: `visibleRows`: stage = min(depth, 3), default "open unless done", a deviation wins, the WHOLE subtree of
//       a collapsed point is missing (also under a collapsed middle point), a leaf is never open; `toggleFold`
//       remembers only deviations; `readDeviations` turns every read error into the default; progress and "in work"
//       count only leaves; empty means without title, description, point;
//   (c) which version applies: load response and event cross; the higher version wins, a version of ANOTHER chat
//       never (late response after the chat switch), the event only for `harness/agenda` of this chat;
//   (d) "updated … ago" without negative times, every key translated;
//   (e) server <-> web: the status list stands word for word in server/backend/electron/server/store/agenda.js, the
//       event is called `agenda` there and here, the route is the same;
//   (f) wiring: the section stands directly after Git in BAR_SECTIONS, the rail renders AgendaPanel in its branch,
//       the shell (ChatPane.onEvent) passes EVERY event on to `agendaEvent`, the panel edits nothing (no write
//       path), shows only headings (note and description only behind the character, as cb-pop on the body) and
//       remembers folding in localStorage only inside try/catch;
//   (g) every sentence of the panel and the rail is in i18n-de.ts;
//   (h) the agenda keeper's marking: `normAgenda` reads `upkeep` only with a known kind (otherwise `null`), `prior`
//       only with `status`; `upkeepExplanation` builds "Added by the agenda keeper · … ago" or "… set · before: …"
//       from translated keys; the panel draws the ring only on a marked point, absolute around the character (the
//       row stays one row), with the explanation as title and sr-only; `afterwards` only with a known value
//       (otherwise `null`, the marking stays), the explanation ends with its word ("… afterwards taken back by the
//       main agent"), `open` and unknown say nothing.
//
// Counter-tests (one sabotage each, shown red):
//   src/lib/agenda.ts: `return fresh.version > old.version ? fresh : old;` -> `return fresh;`                      => (c) red
//   src/lib/agenda.ts: the check `evt.chatId !== chatId` missing                                              => (c) red
//   src/lib/api/agenda.ts: steps without id stay (`.filter(…)` missing)                                       => (a) red
//   src/components/chat/ChatPane.tsx: line `agendaEvent(evt);` commented out                                  => (f) red
//   src/lib/agenda.ts: `hidden.add(p.id);` missing in the hidden branch (grandchildren of a collapsed point
//     appear)                                                                                                 => (b) visibleRows red
//   src/lib/agenda.ts: `stage: Math.min(p.depth, AGENDA_STAGES)` -> `stage: p.depth`                          => (b) visibleRows red
//   src/lib/agenda.ts: `if (open !== foldDefault(…)) fresh[…] = open;` -> always remember                      => (b) toggleFold red
//   src/lib/api/agenda.ts: `project: normProject(s.project),` -> `project: null,`                              => (a) tree fields red
//   src/components/chat/AgendaPanel.tsx: the row's NoteButton -> `<span>{p.note}</span>`                      => (f) red
//   src/components/chat/chatAgenda.ts: `readFold` without try/catch                                           => (f) red
//   src/lib/api/agenda.ts: `upkeep: normUpkeep(s.upkeep),` -> `upkeep: null,`                                  => (h) red
//   src/lib/api/agenda.ts: the kind check missing in normUpkeep (every kind applies)                          => (h) red
//   src/components/chat/AgendaPanel.tsx: `{upkeep ? <UpkeepMarker …/> : <Marker …/>}` -> always `<Marker …/>`   => (h) red
//   src/lib/api/agenda.ts: normUpkeep `afterwards: null` (binding red too); src/lib/agenda.ts: one word of
//   UPKEEP_AFTERWARDS_WORD changed (binding red too); AgendaPanel.tsx: explanation without `afterwards`            => (h) red
//
// Run:  node --test web/test/agenda.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");
const withoutComments = (code) => code.split("\n").filter((z) => !/^\s*(\/\/|\*|\/\*)/.test(z)).join("\n");

// Compile the real sources with the local tsc (lib/agenda.ts pulls in lib/api/agenda.ts and core.ts).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-agenda-"));
execFileSync(process.execPath, [
  tsc, path.join(src, "lib", "agenda.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom",
], { cwd: webDir, stdio: "pipe" });
const L = await import(pathToFileURL(path.join(out, "agenda.js")).href);
const A = await import(pathToFileURL(path.join(out, "api", "agenda.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const step = (o = {}) => ({ id: "s1", text: "Measure", note: "", status: "open", createdAt: 10, changedAt: 10, doneAt: null, ...o });
const agenda = (o = {}) => ({ chatId: "c1", title: "Plan", description: "", steps: [], version: 1, changedAt: 100, ...o });

test("(a) normAgenda: default per field, step without id drops out, unknown status is open, never written is recognizable", () => {
  assert.deepEqual(A.normAgenda(undefined, "c1"), { chatId: "c1", title: "", description: "", steps: [], version: 0, changedAt: null });
  const a = A.normAgenda({
    chatId: "c1", title: "T", description: "## Goal", version: 3, changedAt: 500,
    steps: [
      { id: "s1", text: "One", status: "in_work", createdAt: 1, changedAt: 2 },
      { text: "without id" },
      { id: "s3", text: "Three", status: "finished", createdAt: 3 },
      { id: "s4", text: "Four", status: "done", createdAt: 4, changedAt: 5, doneAt: 6, note: 7 },
      null,
    ],
  }, "c1");
  assert.deepEqual(a.steps.map((s) => [s.id, s.status]), [["s1", "in_work"], ["s3", "open"], ["s4", "done"]]);
  assert.equal(a.steps[1].changedAt, 3, "without changedAt, createdAt applies");
  assert.equal(a.steps[2].doneAt, 6);
  assert.equal(a.steps[2].note, "", "a number is not a note");
  assert.equal(a.steps[0].doneAt, null);
  assert.equal(A.normAgenda({ chatId: "", title: 5 }, "c9").chatId, "c9", "without chatId the asked chat applies");
  assert.deepEqual([...A.AGENDA_STATUS], ["open", "in_work", "done"]);
  // An older server does not send the tree fields: every point is a leaf of the top level.
  assert.deepEqual(
    [a.steps[0].parent, a.steps[0].depth, a.steps[0].subitems, a.steps[0].done, a.steps[0].total, a.steps[0].project],
    [null, 0, 0, 0, 0, null],
  );
});

test("(a) normAgenda: the tree fields arrive without loss, nonsense falls back to the default", () => {
  const raw = {
    id: "s3", parent: "s1", depth: 2, text: "Login", note: "**bold**", status: "in_work", subitems: 2, done: 1, total: 3,
    project: { id: "p1", name: "Shop", color: "whatever" }, createdAt: 1, changedAt: 2, doneAt: null,
  };
  const [s] = A.normAgenda({ steps: [raw] }, "c1").steps;
  assert.deepEqual(s, { ...raw, project: { id: "p1", name: "Shop" }, upkeep: null }, "every field stays (only the unknown project color drops; without a keeper marking `upkeep: null`)");
  const broken = A.normAgenda({ steps: [
    { id: "a", parent: "", depth: -1, subitems: "2", done: Number.NaN, total: 2.9, project: { name: "without id" } },
    { id: "b", parent: 7, depth: 4.6, project: { id: "p2" } },
    { id: "c", project: "p3" },
  ] }, "c1").steps;
  assert.deepEqual(broken.map((x) => [x.parent, x.depth, x.subitems, x.done, x.total, x.project]), [
    [null, 0, 0, 0, 2, null],
    [null, 4, 0, 0, 0, { id: "p2", name: "" }],
    [null, 0, 0, 0, 0, null],
  ], "depth and counts are integers >= 0 (truncated), a project needs an id, an empty parent is the top level");
});

// A tree in pre-order, as the server sends it: s1 with two children, below them s3 → s4 → s5 → s6 (depth 4), s7 entirely
// done, s10 a leaf of the top level. The status of the parent points is the server's COMPUTED one.
const point = (id, parent, depth, status, subitems = 0, o = {}) =>
  step({ id, parent, depth, text: id, status, subitems, done: 0, total: 0, project: null, ...o });
const TREE = [
  point("s1", null, 0, "in_work", 2, { done: 1, total: 2, project: { id: "p1", name: "Shop" } }),
  point("s2", "s1", 1, "done"),
  point("s3", "s1", 1, "open", 1, { total: 1 }),
  point("s4", "s3", 2, "open", 1, { total: 1 }),
  point("s5", "s4", 3, "open", 1, { total: 1 }),
  point("s6", "s5", 4, "open"),
  point("s7", null, 0, "done", 2, { done: 2, total: 2 }),
  point("s8", "s7", 1, "done"),
  point("s9", "s7", 1, "done"),
  point("s10", null, 0, "open"),
];
const view = (rows) => rows.map((z) => `${z.point.id}:${z.stage}${z.point.subitems ? (z.open ? "+" : "-") : ""}`);

test("(b) visibleRows: stage up to 3, open unless done, a deviation wins, the whole subtree of a collapsed point is missing", () => {
  assert.deepEqual(view(L.visibleRows(TREE, {})), ["s1:0+", "s2:1", "s3:1+", "s4:2+", "s5:3+", "s6:3", "s7:0-", "s10:0"],
    "default: the done subtree s7 is closed, depth 4 sits on stage 3");
  assert.deepEqual(view(L.visibleRows(TREE, { s3: false })), ["s1:0+", "s2:1", "s3:1-", "s7:0-", "s10:0"],
    "a collapsed middle point takes its whole subtree with it, down to depth 4");
  assert.deepEqual(view(L.visibleRows(TREE, { s3: false, s5: true })), ["s1:0+", "s2:1", "s3:1-", "s7:0-", "s10:0"],
    "an open point under a collapsed one stays hidden");
  assert.deepEqual(view(L.visibleRows(TREE, { s7: true })), ["s1:0+", "s2:1", "s3:1+", "s4:2+", "s5:3+", "s6:3", "s7:0+", "s8:1", "s9:1", "s10:0"],
    "the deviation \"open\" wins over the default of the done subtree");
  assert.deepEqual(view(L.visibleRows(TREE, { s1: false })), ["s1:0-", "s7:0-", "s10:0"]);
  const sheet = L.visibleRows(TREE, { s2: true, s10: true });
  assert.equal(sheet.find((z) => z.point.id === "s2").open, false, "a leaf is never open, even with a deviation");
  assert.equal(sheet.find((z) => z.point.id === "s10").open, false);
  assert.deepEqual(view(L.visibleRows([point("x1", "missing", 1, "open"), point("x2", null, 0, "open")], { missing: false })), ["x1:1", "x2:0"],
    "an unknown parent point hides nothing");
  assert.deepEqual(view(L.visibleRows([], {})), []);
  assert.equal(L.AGENDA_STAGES, 3);
});

test("(b) toggleFold remembers only deviations from the default; readDeviations turns every read error into the default", () => {
  const row = (id, deviation = {}) => L.visibleRows(TREE, deviation).find((z) => z.point.id === id);
  assert.deepEqual(L.toggleFold({}, row("s1"), TREE), { s1: false }, "open to closed is a deviation");
  assert.deepEqual(L.toggleFold({ s1: false }, row("s1", { s1: false }), TREE), {}, "back to the default deletes the entry");
  assert.deepEqual(L.toggleFold({}, row("s7"), TREE), { s7: true }, "a done subtree: closed to open is the deviation");
  assert.deepEqual(L.toggleFold({ way: true, s7: true }, row("s1", { s7: true }), TREE), { s7: true, s1: false }, "entries of vanished points drop out");
  const deviation = { s7: true };
  assert.equal(L.toggleFold(deviation, row("s2"), TREE), deviation, "on a leaf nothing changes");
  assert.equal(L.foldKey("c1"), "cbase-agenda-fold:c1");
  for (const raw of [null, undefined, "", "broken", "[true]", "null", "5", '"s1"']) assert.deepEqual(L.readDeviations(raw), {}, `read error ${raw}`);
  assert.deepEqual(L.readDeviations('{"s1":true,"s2":"yes","s3":false,"":true,"s4":1}'), { s1: true, s3: false }, "only booleans count");
  assert.deepEqual(Object.keys(L.readDeviations('{"__proto__":true}')), []);
});

test("(b) progress and \"in work\" count only leaves; empty means without title, description and point; whitespace does not count", () => {
  assert.deepEqual(L.agendaProgress(agenda({ steps: TREE })), { done: 3, total: 5 }, "leaves s2, s6, s8, s9, s10; done s2, s8, s9");
  assert.equal(L.agendaInWork(agenda({ steps: TREE })), false, "s1 is computed as \"in work\" because a leaf is done; no one is working on any");
  assert.equal(L.agendaInWork(agenda({ steps: [...TREE, point("s11", null, 0, "in_work")] })), true);
  assert.deepEqual(L.agendaProgress(agenda({ steps: [step({ id: "s1", status: "done" }), step({ id: "s2" })] })), { done: 1, total: 2 }, "flat as before");
  assert.deepEqual(L.agendaProgress(null), { done: 0, total: 0 });
  assert.equal(L.agendaEmpty(null), true);
  assert.equal(L.agendaEmpty(agenda({ title: "  ", description: "\n" })), true);
  assert.equal(L.agendaEmpty(agenda({ title: "", description: "x" })), false);
  assert.equal(L.agendaEmpty(agenda({ title: "", steps: [step()] })), false);
});

test("(c) which version applies: the higher version wins, a foreign chat never; the event only for harness/agenda of this chat", () => {
  const v1 = agenda({ version: 1, title: "old" });
  const v2 = agenda({ version: 2, title: "fresh" });
  assert.equal(L.effectiveAgenda(null, v1, "c1"), v1);
  assert.equal(L.effectiveAgenda(v1, v2, "c1"), v2);
  assert.equal(L.effectiveAgenda(v2, v1, "c1"), v2, "the late load response does not carry the old state back");
  assert.equal(L.effectiveAgenda(v2, agenda({ version: 2, title: "equal" }), "c1"), v2, "same version: no redraw");
  assert.equal(L.effectiveAgenda(v1, agenda({ chatId: "c2", version: 9 }), "c1"), v1, "the version of another chat never applies");
  assert.equal(L.effectiveAgenda(agenda({ chatId: "c2" }), null, "c1"), null, "the state of the old chat does not apply after the switch");
  const evt = { type: "harness", subtype: "agenda", chatId: "c1", agenda: { chatId: "c1", title: "Live", version: 4, steps: [] } };
  assert.equal(L.agendaFromEvent(evt, "c1").title, "Live");
  assert.equal(L.agendaFromEvent({ ...evt, chatId: "c2" }, "c1"), null, "foreign chat");
  assert.equal(L.agendaFromEvent({ ...evt, chatId: undefined }, "c1"), null, "without chat id no knowing which one");
  assert.equal(L.agendaFromEvent({ ...evt, subtype: "artifact_changed" }, "c1"), null);
  assert.equal(L.agendaFromEvent({ ...evt, type: "assistant" }, "c1"), null);
  assert.equal(L.agendaFromEvent(null, "c1"), null);
});

test("(d) \"updated … ago\": minutes, hours, days, never negative; and every key is translated", () => {
  const now = 10 * 86_400_000;
  assert.equal(L.sinceText(null, now), null, "never written: no time text");
  assert.deepEqual(L.sinceText(now - 30_000, now), { key: "just now", n: 0 });
  assert.deepEqual(L.sinceText(now + 120_000, now), { key: "just now", n: 0 }, "a clock running behind is not \"-2 min ago\"");
  assert.deepEqual(L.sinceText(now - 5 * 60_000, now), { key: "{n} min ago", n: 5 });
  assert.deepEqual(L.sinceText(now - 3 * 3_600_000, now), { key: "{n} h ago", n: 3 });
  assert.deepEqual(L.sinceText(now - 30 * 3_600_000, now), { key: "1 day ago", n: 1 });
  assert.deepEqual(L.sinceText(now - 3 * 86_400_000, now), { key: "{n} days ago", n: 3 });
  const en = read("lib/i18n-de.ts");
  const key = [...new Set([...read("lib/agenda.ts").matchAll(/key: (?:[^"]*\? )?"([^"]+)"/g), ...read("lib/agenda.ts").matchAll(/: "([^"]+ ago)"/g)].map((m) => m[1]))];
  assert.ok(key.length >= 5, `too few keys found (${key.length})`);
  assert.deepEqual(key.filter((k) => !en.includes(`\n  "${k}":`)), [], "without German translation");
});

test("(e) server <-> web: status list, event name and route are the same", () => {
  const store = fs.readFileSync(path.join(repo, "server/backend/electron/server/store/agenda.js"), "utf8");
  const m = /const AGENDA_STATUS = Object\.freeze\((\[[^\]]*\])\)/.exec(store);
  assert.ok(m, "store/agenda.js no longer carries AGENDA_STATUS in the expected form");
  assert.deepEqual(JSON.parse(m[1]), [...A.AGENDA_STATUS], "the status list of the server and of the web client");
  // The ONE write path (agenda/change.js) sends the event, no longer the route; there must be no second one there
  // (a second sender with its own line would send a state the write path never wrote).
  const change = fs.readFileSync(path.join(repo, "server/backend/electron/server/agenda/change.js"), "utf8");
  assert.match(change, /sse\(id, \{ type: "harness", subtype: "agenda", chatId: id, agenda \}\)/, "the server sends harness/agenda with chatId and agenda");
  const routes = fs.readFileSync(path.join(repo, "server/backend/electron/server/agenda/routes.js"), "utf8");
  assert.doesNotMatch(routes, /subtype: "agenda"/, "the route does not send the event itself");
  assert.match(routes, /sub === "\/agenda" && m === "GET"/);
  assert.match(read("lib/api/agenda.ts"), /`\/api\/chats\/\$\{encodeURIComponent\(chatId\)\}\/agenda`/);
  assert.match(read("lib/agenda.ts"), /evt\.subtype !== "agenda"/);
});

test("(f) wiring: section after Git, branch with AgendaPanel, the shell passes every event on, no write path", () => {
  const bar = read("lib/chat-bar.ts");
  assert.match(bar, /BAR_SECTIONS = \["gitlab", "agenda", /, "the agenda stands directly after Git");
  const sidebar = withoutComments(read("components/chat/ChatRightSidebar.tsx"));
  assert.match(sidebar, /rightSidebarTab === "agenda" \? \(/);
  assert.match(sidebar, /<AgendaPanel key=\{`agenda:\$\{activeId\}`\} t=\{t\} chatId=\{activeId\} projectId=\{activeProject\?\.id \?\? null\} \/>/); // with project (timeline evidence)
  assert.match(sidebar, /agenda: \{ label: t\("Agenda"\), icon: AgendaIcon, badge: 0 \}/, "without badge");
  const pane = withoutComments(read("components/chat/ChatPane.tsx"));
  const onEvent = pane.slice(pane.indexOf("function onEvent("), pane.indexOf('if (evt.type === "harness")', pane.indexOf("function onEvent(")));
  assert.ok(onEvent.includes("agendaEvent(evt);"), "onEvent does not pass the events on to chat/chatAgenda.ts");
  assert.match(pane, /import \{ agendaEvent \} from "@\/components\/chat\/chatAgenda";/);
  const hook = withoutComments(read("components/chat/chatAgenda.ts"));
  assert.match(hook, /effectiveAgenda\(/, "the hook accepts versions through effectiveAgenda");
  assert.match(hook, /agendaFromEvent\(evt, chatId\)/);
  assert.match(hook, /if \(chatRef\.current !== chatId\) return;/, "a response for the old chat is discarded");
  const panel = withoutComments(read("components/chat/AgendaPanel.tsx"));
  for (const forbidden of ["method:", "PUT", "<textarea", "<input", "contentEditable"]) assert.ok(!panel.includes(forbidden), `the panel edits: ${forbidden}`);
  assert.match(panel, /@container\/agenda/, "container queries, no window queries");
  assert.ok(!/rounded-xl bg-panel/.test(panel), "no card per row");
  // Headings only: note and description never appear in the flow, only behind the character, as markdown in the cb-pop.
  assert.ok(!/<Markdown src=\{(agenda\.description|[a-z]\.note)\}/.test(panel), "description or note appear in the flow");
  assert.ok(!/(?<!=)\{\s*[a-z]\.note\s*\}/.test(panel), "a note appears as text in the flow (as a child, not as an attribute)");
  assert.match(panel, /<NoteButton label=\{t\("Show note"\)\} identifier=\{p\.id\} header=\{p\.text\} markdown=\{p\.note\} \/>/);
  assert.match(panel, /<NoteButton label=\{t\("Show description"\)\}[^>]*markdown=\{agenda\.description\}/);
  assert.match(panel, /<Markdown src=\{markdown\} \/>/, "in the sheet markdown as in the chat");
  assert.match(panel, /className=\{`cb-pop [^`]*fixed/, "the sheet is a cb-pop");
  assert.match(panel, /document\.body,\s*\)/, "the sheet hangs on the body through a portal");
  assert.match(panel, /closest\?\.\("\[data-agenda-pop\]"\)/, "click outside through closest, no catcher");
  assert.ok(!/fixed inset-0/.test(panel), "no fixed-inset-0 catcher");
  assert.ok(!/agendaGroups/.test(panel), "the groups are gone; the tree is the view");
  assert.match(panel, /visibleRows\(agenda\.steps, deviations\)/);
  assert.match(panel, /const \[deviations, flip\] = useAgendaFold\(chatId\);/);
  assert.match(panel, /paddingLeft: z\.stage \* INSET_PX/);
  assert.match(panel, /const INSET_PX = 12;/, "indent 12 px per stage");
  assert.match(panel, /className=\{`min-w-0 flex-1 truncate /, "the point text is one line, truncated");
  // The folding memo note: only in try/catch (private window, blocked storage mean "default").
  const fold = hook.slice(hook.indexOf("function readFold("));
  assert.match(fold, /try \{ return readDeviations\(window\.localStorage\.getItem\(foldKey\(chatId\)\)\); \}\s*catch \{ return \{\}; \}/);
  assert.match(fold, /try \{\s*if \(Object\.keys\(deviations\)\.length\) window\.localStorage\.setItem\(foldKey\(chatId\), JSON\.stringify\(deviations\)\);\s*else window\.localStorage\.removeItem\(foldKey\(chatId\)\);\s*\} catch/);
  assert.equal((hook.match(/localStorage/g) || []).length, 3, "no localStorage access outside the two protected places");
});

test("(g) every sentence of the panel and of the agenda branch of the bar is in i18n-de.ts", () => {
  const en = read("lib/i18n-de.ts");
  const panel = read("components/chat/AgendaPanel.tsx");
  const sidebar = read("components/chat/ChatRightSidebar.tsx");
  const branch = sidebar.slice(sidebar.indexOf('rightSidebarTab === "agenda" ? ('), sidebar.indexOf('rightSidebarTab === "channels" ? ('));
  const sets = [...new Set([...panel.matchAll(/\bt\("([^"]+)"/g), ...branch.matchAll(/\bt\("([^"]+)"/g), ...sidebar.matchAll(/aria-label=\{t\("([^"]+)"/g)].map((m) => m[1]))];
  assert.ok(sets.length >= 10, `too few sentences found (${sets.length})`);
  assert.deepEqual(sets.filter((k) => !en.includes(`\n  "${k}":`)), [], "without German translation");
  const duplicate = [...en.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]).filter((k, i, all) => all.indexOf(k) !== i);
  assert.deepEqual(duplicate.filter((k) => sets.includes(k)), [], "duplicate keys (TS1117)");
});

test("(h) agenda keeper: `upkeep` only with a known kind, `prior` only with status; the explanation from translated keys; the ring only on the marked point", (t) => {
  const p = (upkeep) => A.normAgenda({ steps: [step({ upkeep })] }, "c1").steps[0].upkeep;
  assert.deepEqual(p({ agentId: "ws-a9e0da", runId: "l1", at: 500, kind: "status", prior: "in_work", afterwards: "corrected" }),
    { agentId: "ws-a9e0da", runId: "l1", at: 500, kind: "status", prior: "in_work", afterwards: "corrected" });
  assert.deepEqual(p({ agentId: "ws-a9e0da", runId: "l1", at: 500, kind: "fresh", prior: "open" }),
    { agentId: "ws-a9e0da", runId: "l1", at: 500, kind: "fresh", prior: null, afterwards: null }, "with `fresh` there is no prior; without `afterwards` unknown");
  for (const d of ["open", "confirmed", "corrected", "outdated"]) assert.equal(p({ kind: "fresh", afterwards: d }).afterwards, d);
  assert.equal(p({ kind: "fresh", afterwards: "deleted" }).afterwards, null, "an unknown `afterwards` (a newer server) says nothing; the marking stays");
  assert.equal(p({ agentId: "x", runId: "l", at: 1, kind: "erase" }), null, "an unknown kind shows nothing");
  assert.equal(p(undefined), null, "without the field no marking (older server, unmarked point)");
  assert.equal(p("fresh"), null, "a text is no marking");
  assert.deepEqual(p({ kind: "status", prior: "finished", at: "yesterday" }), { agentId: "", runId: "", at: 0, kind: "status", prior: null, afterwards: null },
    "an unknown prior status drops out, an unreadable time is 0");

  const now = 10 * 86_400_000;
  assert.deepEqual(L.upkeepExplanation({ agentId: "a", runId: "l", at: now - 4 * 60_000, kind: "fresh", prior: null, afterwards: "open" }, now),
    { key: "Added by the agenda keeper", prior: null, since: { key: "{n} min ago", n: 4 }, afterwards: null }, "open says nothing about it");
  assert.deepEqual(L.upkeepExplanation({ agentId: "a", runId: "l", at: now - 4 * 60_000, kind: "status", prior: "in_work", afterwards: "corrected" }, now),
    { key: "Set by the agenda keeper · before: {prior}", prior: "In progress", since: { key: "{n} min ago", n: 4 }, afterwards: "taken back by the main agent afterwards" });
  assert.deepEqual(L.upkeepExplanation({ agentId: "a", runId: "l", at: 0, kind: "status", prior: null, afterwards: null }, now),
    { key: "Set by the agenda keeper", prior: null, since: null, afterwards: null }, "without a time no \"… ago\", without prior no \"before:\", unknown no \"afterwards\"");
  // The ring stays: every `afterwards` except open has a word, and there are three different ones.
  const words = ["confirmed", "corrected", "outdated"].map((d) => L.upkeepExplanation({ agentId: "a", runId: "l", at: 0, kind: "fresh", prior: null, afterwards: d }, now).afterwards);
  assert.deepEqual(words, ["edited by the main agent afterwards", "taken back by the main agent afterwards", "taken over by the main agent afterwards"]);
  assert.deepEqual(Object.keys(L.UPKEEP_AFTERWARDS_WORD), [...A.AGENDA_UPKEEP_AFTERWARDS], "one word per value of `afterwards`");
  const en = read("lib/i18n-de.ts");
  const agendaTs = read("lib/agenda.ts");
  const key = [...new Set([...agendaTs.matchAll(/"((?:Added|Set) by the agenda keeper[^"]*)"/g), ...agendaTs.matchAll(/(?:open|in_work|done): "([^"]+)"/g),
    ...agendaTs.matchAll(/"([^"]* by the main agent afterwards)"/g)].map((m) => m[1]))];
  t.diagnostic(`keys of the explanation: ${key.length}`);
  assert.ok(key.length >= 9, "keys of the explanation not found");
  assert.deepEqual(key.filter((k) => !en.includes(`\n  "${k}":`)), [], "without German translation");

  const panel = withoutComments(read("components/chat/AgendaPanel.tsx"));
  assert.match(panel, /\{upkeep \? <UpkeepMarker status=\{p\.status\} explanation=\{upkeepText\} \/> : <Marker status=\{p\.status\} \/>\}/,
    "the ring sits only on a marked point");
  const marker = panel.slice(panel.indexOf("function UpkeepMarker("), panel.indexOf("const NoteCharacter"));
  assert.match(marker, /title=\{explanation\}/, "the explanation sits behind the character");
  assert.match(marker, /className="relative grid h-3 w-3 shrink-0/, "the character measures like every mark; the row does not shift");
  assert.match(marker, /absolute -inset-\[3px\] rounded-full ring-1 ring-accent\//, "the ring lies absolute, in accent");
  assert.match(marker, /<span className="sr-only">\{explanation\}: <\/span>/, "screen readers hear the explanation");
  assert.match(panel, /upkeepExplanation\(p\.upkeep, now\)/);
  assert.match(panel, /upkeep\.afterwards \? t\(upkeep\.afterwards\) : ""/, "the explanation says what happened afterwards (translated)");
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(marker), "no fixed color values");
});
