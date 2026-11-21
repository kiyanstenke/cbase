// Coding -> Scheduled on the web.
//
// The promises, each from a way that breaks it:
//
// (a) THE FORM SAYS WHAT THE SERVER SAYS. `lib/scheduled.ts:planFromForm` builds the plan that `scheduled/cadence.js` checks: time of
//     day two-digit, days sorted and unique, day of month 1-28, a one-time appointment as a timestamp in ms in the future. A plan the
//     server rejects with 400 would be an error seen only after the click; one it silently reads differently (ISO without offset in
//     the zone of the job instead of the browser's) a wrong appointment without any message.
// (b) THE CHOICE CONTAINS EXACTLY THE CADENCES OF THE CONTRACT. `CADENCE_CHOICE` == `SCHEDULED_CADENCES` (lib/api/scheduled.ts) as a
//     set, `DAYS_OF_MONTH` == 1...`SCHEDULED_DAY_OF_MONTH.max`, the weekdays 0-6 once each.
// (c) A NUMBER AS ID IS AN ID. A run has a number as id on the server (AUTOINCREMENT, store/scheduled.js) -- a normalizer that only
//     accepted text as id dropped EVERY run: the runs sheet showed "No run yet.", the last run was missing on every row. And an
//     unknown status is `null`, not "active".
// (d) THE SEAMS OF THE PAGE. `/todos` redirects to Scheduled; ChatPane in `onlyChat` mode shows no chat list and does not remember
//     the chat as the last opened one of the scope (else Coding -> Chats would open the job's chat instead of the own one); the page
//     renders the tab with `ScheduledTab`.
// (f) "DEFAULT" WHEN EDITING IS A LEVEL. A chat has no empty level; `levelToSave` resolves the choice "Default" into the model's
//     default level instead of silently leaving the old level.
// (g) SEGMENT AND CHOICE. The detail shows a row OF THE segment (`selectedRow`); the segment follows only after an action of its own,
//     never on reload.
// (h) THE CHAT DOES NOT LOAD. Then "Advanced" shows no run values (they would be the defaults, not the chat's), and a note says that
//     only instructions and repetition are saved.
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
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");

// Compile the real sources with the local tsc (lib/scheduled.ts is a leaf; lib/api/scheduled.ts pulls in core.ts).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-scheduled-"));
execFileSync(process.execPath, [
  tsc, path.join(src, "lib", "scheduled.ts"), path.join(src, "lib", "api", "scheduled.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom",
], { cwd: webDir, stdio: "pipe" });
const G = await import(pathToFileURL(path.join(out, "scheduled.js")).href);
const A = await import(pathToFileURL(path.join(out, "api", "scheduled.js")).href);

const form = (part) => ({ ...G.emptyCadenceForm(), ...part });

test("(a) planFromForm: the same forms and limits as scheduled/cadence.js", () => {
  assert.deepEqual(G.planFromForm(form({ cadence: "daily", clockTime: "8:05" })), { cadence: "daily", plan: { clockTime: "08:05" } });
  assert.deepEqual(G.planFromForm(form({ cadence: "workdays", clockTime: "22:00" })), { cadence: "workdays", plan: { clockTime: "22:00" } });
  assert.deepEqual(G.planFromForm(form({ cadence: "weekly", clockTime: "09:30", days: [5, 1, 1, 0] })), { cadence: "weekly", plan: { clockTime: "09:30", days: [0, 1, 5] } });
  assert.ok("error" in G.planFromForm(form({ cadence: "weekly", days: [] })), "no plan without a weekday");
  assert.deepEqual(G.planFromForm(form({ cadence: "monthly", day: 28 })), { cadence: "monthly", plan: { clockTime: "08:00", day: 28 } });
  assert.ok("error" in G.planFromForm(form({ cadence: "monthly", day: 29 })), "no 29th");
  assert.ok("error" in G.planFromForm(form({ clockTime: "24:00" })), "no time 24:00");
  assert.ok("error" in G.planFromForm(form({ clockTime: "" })), "no empty time (the server has no default 08:00)");
  const now = Date.UTC(2026, 9, 21, 12, 0);
  const tomorrow = G.localIso(now + 86_400_000);
  const r = G.planFromForm(form({ cadence: "oneTime", oneTime: tomorrow }), now);
  assert.equal(r.cadence, "oneTime");
  assert.equal(typeof r.plan.at, "number", "a one-time appointment goes out as ms -- never as ISO without offset");
  assert.equal(G.localIso(r.plan.at), tomorrow, "read in the browser's time, as the field shows it");
  assert.ok("error" in G.planFromForm(form({ cadence: "oneTime", oneTime: G.localIso(now - 60_000) }), now), "not in the past");
  assert.ok("error" in G.planFromForm(form({ cadence: "oneTime", oneTime: "" }), now), "not without a point in time");
});

test("(a) formFromJob: a stored plan comes back unchanged", () => {
  for (const [cadence, plan] of [["daily", { clockTime: "07:15" }], ["weekly", { clockTime: "18:00", days: [2, 4] }], ["monthly", { clockTime: "06:00", day: 3 }]]) {
    assert.deepEqual(G.planFromForm(G.formFromJob({ cadence, plan })), { cadence, plan });
  }
  assert.deepEqual(G.formFromJob({ cadence: "hours", plan: {} }), G.emptyCadenceForm(), "an unknown cadence falls back to the default");
});

test("(b) the choice carries exactly the cadences, days of month and weekdays of the contract", () => {
  assert.deepEqual(G.CADENCE_CHOICE.map((r) => r.value).sort(), [...A.SCHEDULED_CADENCES].sort());
  assert.deepEqual(G.DAYS_OF_MONTH, Array.from({ length: A.SCHEDULED_DAY_OF_MONTH.max - A.SCHEDULED_DAY_OF_MONTH.min + 1 }, (_, i) => i + A.SCHEDULED_DAY_OF_MONTH.min));
  assert.deepEqual(G.WEEKDAYS.map((d) => d.value).sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(G.SEGMENTS.map((s) => s.key), [...A.SCHEDULED_JOB_STATUS], "one segment per status, in the order of the contract");
});

test("(b) jobsIn: Upcoming by next appointment, without appointment last; an unknown status appears nowhere", () => {
  const l = [
    { id: "a", status: "active", nextAt: 300, updatedAt: 1 }, { id: "b", status: "active", nextAt: 0, updatedAt: 9 },
    { id: "c", status: "active", nextAt: 100, updatedAt: 2 }, { id: "d", status: null, nextAt: 50, updatedAt: 3 },
    { id: "e", status: "paused", nextAt: 0, updatedAt: 4 }, { id: "f", status: "paused", nextAt: 0, updatedAt: 8 },
  ];
  assert.deepEqual(G.jobsIn(l, "active").map((a) => a.id), ["c", "a", "b"]);
  assert.deepEqual(G.jobsIn(l, "paused").map((a) => a.id), ["f", "e"]);
  assert.ok(!G.SEGMENTS.some((s) => G.jobsIn(l, s.key).some((a) => a.id === "d")));
});

test("(c) normalizer: the number as run id stays, an unknown status is null, a job without id drops out", () => {
  const run = A.normScheduledRun({ id: 17, jobId: "x", status: "ok", cause: "hand", startedAt: 5 });
  assert.ok(run, "a run with a number as id does not drop out");
  assert.equal(run.id, "17");
  const a = A.normScheduledJob({ id: "u-1", status: "sleeps", cadence: "cron", lastRun: { id: 3, status: "error" } });
  assert.equal(a.status, null, "an unknown status is no claim");
  assert.equal(a.cadence, null);
  assert.equal(a.lastRun?.id, "3", "the last run on the row stays");
  assert.equal(A.normScheduledJob({ status: "active" }), null);
  assert.equal(A.normChatJob(undefined), null, "an older server without the field: no job");
  assert.deepEqual(A.normChatJob({ id: "u-1", name: "N", status: "active", nextAt: 9 }), { id: "u-1", name: "N", status: "active", nextAt: 9 });
});

test("(c) jobClock: active with occurrence names it, otherwise the status; without a job no clock", () => {
  assert.equal(G.jobClock(null), null);
  assert.deepEqual(G.jobClock({ status: "active", nextAt: 5 }), { key: "Scheduled · next run {when}", withWhen: true });
  assert.equal(G.jobClock({ status: "paused", nextAt: 5 }).withWhen, false);
});

test("(d) the seams of the page: /todos -> Scheduled, ChatPane onlyChat without list and without remembering, ScheduledTab in the tab", () => {
  assert.match(read("app/todos/page.tsx"), /router\.replace\(tabAddress\("scheduled"\)\)/, "/todos redirects to Coding -> Scheduled");
  const pane = read("components/chat/ChatPane.tsx");
  assert.ok(pane.includes("{!onlyChat && <ChatListPane"), "in onlyChat mode no chat list");
  assert.ok(pane.includes("if (!onlyChat) localStorage.setItem(chatKey, id);"), "onlyChat does not remember the chat as the last opened one of the scope");
  assert.ok(/if \(!chatId \|\| onlyChat\) return;/.test(pane), "onlyChat follows no foreign \"open chat\"");
  const page = read("app/workspaces/page.tsx");
  assert.ok(/tab === "scheduled" && activeWs && \(\s*<ScheduledTab/.test(page), "the tab renders ScheduledTab");
  assert.match(read("components/scheduled/ScheduledDetail.tsx"), /<ChatPane key=\{a\.chatId\} [^>]*onlyChat=\{a\.chatId\}/, "the detail shows the job's chat in onlyChat mode, one pane per chat");
});

test("(e) the hidden chat list follows the Scheduled tab: window event after every own action, `scheduled` of the stream", () => {
  // Job created, run, paused -- Coding -> Chats showed "No chats yet." although GET /api/chats returned the chat with its
  // `job`. The pane stays mounted, the server does not announce create and PATCH, and the running state reloads only for chats
  // already in the list.
  const tab = read("components/scheduled/ScheduledTab.tsx");
  assert.equal((tab.match(/reportScheduledChanged\(wsId\)/g) || []).length, 3, "change (detail), save and delete (dialog) report once each");
  const pane = read("components/chat/ChatPane.tsx");
  assert.ok(pane.includes("window.addEventListener(SCHEDULED_CHANGED, reload);"), "ChatPane listens to the window event");
  assert.ok(pane.includes('msg.type === "scheduled" && !onlyChat'), "ChatPane reloads on the stream's `scheduled` event");
  assert.equal(G.SCHEDULED_CHANGED, "cbase-scheduled-changed");
});

test("(f) levelToSave: \"Default\" when editing saves the model's default level, a model change leaves no foreign level behind", () => {
  // `effortChoiceBody("")` sent no `effort` -- the old level stayed on the chat, even after a model change.
  assert.equal(G.levelToSave("", "xhigh", "medium"), "medium", "\"Default\" instead of xhigh: the default level goes out");
  assert.equal(G.levelToSave("", "medium", "medium"), null, "default = the level already set: send nothing");
  assert.equal(G.levelToSave("", "", "high"), null, "nothing chosen, nothing set: send nothing");
  assert.equal(G.levelToSave("high", "low", "medium"), "high", "an explicit choice goes out unchanged");
  assert.equal(G.levelToSave("low", "low", "medium"), null);
  assert.equal(G.levelToSave("", "high", ""), null, "a model without levels: no empty level (it would be a 400)");
  const dialog = read("components/scheduled/JobDialog.tsx");
  assert.ok(dialog.includes("const level = levelToSave(values.effort, old.effort, effortDefaultLevel(") && dialog.includes("if (level) Object.assign(body, effortChoiceBody(level));"),
    "the dialog sends the level via levelToSave");
  assert.ok(!dialog.includes("effortChoiceBody(values.effort)"), "the choice never goes out raw as body (\"\" would mean: no effort)");
  // Counter-test: the old rule (every deviation raw) sends no level for "Default" -- this test establishes that.
  const oldRule = (choice, old) => (choice !== old ? (choice === "" ? null : choice) : null);
  assert.notEqual(oldRule("", "xhigh"), G.levelToSave("", "xhigh", "medium"));
});

test("(g) segment and choice: the detail shows one row of the segment, and only an own action switches the segment", () => {
  // The effect "selected row also switches the segment" ran on EVERY reload (every `chat_title` in the workspace) and threw
  // the view back from "Paused"/"Done" to "Upcoming"; the detail looked for the choice in the whole list.
  const l = [{ id: "a", status: "active", nextAt: 1, updatedAt: 1 }, { id: "p", status: "paused", nextAt: 0, updatedAt: 2 }];
  assert.equal(G.selectedRow(G.jobsIn(l, "paused"), "a")?.id, "p", "a choice from another segment does not show its detail");
  assert.equal(G.selectedRow(G.jobsIn(l, "active"), "a")?.id, "a");
  assert.equal(G.selectedRow(G.jobsIn(l, "done"), "a"), null, "an empty segment has no detail");
  assert.equal(G.segmentOf({ status: "paused" }), "paused");
  assert.equal(G.segmentOf({ status: null }), null);
  assert.equal(G.segmentOf(undefined), null);
  const tab = read("components/scheduled/ScheduledTab.tsx");
  assert.ok(tab.includes("const selected = selectedRow(inSegment, choice);"), "the detail computes via selectedRow");
  assert.ok(!/\}, \[list, choice\]\)/.test(tab), "no effect that sets the segment of the choice on every reload of the list");
  // Who sets the segment: the segment change (onChange) and `followUp` -- nobody else.
  const setter = [...tab.matchAll(/setSegment\(/g)].length;
  assert.equal(setter, 2, `setSegment appears ${setter}x -- only onChange of the segments and followUp() may set the segment`);
  assert.equal((tab.match(/\bfollowUp\(/g) || []).length, 3, "followUp() after an own action (detail, dialog) and on first load");
  // Counter-test: the old computation (choice in the whole list) shows the active job in the "Paused" segment.
  const old = (list, seg, choice) => list.find((a) => a.id === choice) ?? G.jobsIn(list, seg)[0] ?? null;
  assert.equal(old(l, "paused", "a")?.id, "a");
});

/** Deviations of the dialog when GET /api/chats/:id fails: no defaults as run values of the chat, no silently dropped choice. */
function chatLoadDeviations(dialog) {
  const output = [];
  const load = /api<Chat>\(`\/api\/chats\/\$\{encodeURIComponent\(job\.chatId\)\}`\)[\s\S]*?\.catch\(\(e\) => \{([^}]*)\}\);/.exec(dialog);
  if (!load) output.push("the dialog no longer loads the chat via api<Chat>(`/api/chats/...`) -- update this test");
  else if (!load[1].includes("setChatError(")) output.push("a failed load of the chat does not end up in chatError");
  if (!dialog.includes("const runValuesShown = fresh || chatState !== null;")) output.push("runValuesShown is missing");
  if (!dialog.includes("{expanded && runValuesShown && (\n          <div className=\"flex flex-col gap-3\" data-scheduled-expanded-content>")) output.push("\"Advanced\" shows the run values without them being the chat's");
  if (!/\{!fresh && !runValuesShown && \(chatError \|\| !job\.chatId\) && \(/.test(dialog)) output.push("no note that only instructions and repetition are saved");
  return output;
}

test("(h) the chat does not load: \"Advanced\" shows no defaults as the chat's values, the dialog says what is saved", () => {
  // If GET /api/chats/:id failed, "Advanced" showed the defaults of a NEW chat (full access, default) -- changes to them were
  // silently lost on save (`if (chatState)`).
  const dialog = read("components/scheduled/JobDialog.tsx");
  const output = chatLoadDeviations(dialog);
  assert.deepEqual(output, [], output.join("\n"));
  // Counter-test built in: the error in the general error field and "Advanced" without condition are caught.
  const old = chatLoadDeviations(dialog.replace("setChatError(e instanceof", "setError(e instanceof").replace("{expanded && runValuesShown && (", "{expanded && ("));
  assert.ok(old.some((z) => z.includes("chatError")) && old.some((z) => z.startsWith("\"Advanced\" shows")), old.join("\n"));
});
