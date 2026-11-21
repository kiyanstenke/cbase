// The seam of the scheduled jobs: backend, web and iOS on ONE sheet.
//
// `server/backend/electron/server/scheduled/contract.js` (a leaf without imports) carries the lists the server computes with:
// cadences, day of month, weekday, the states of a job and of a run, the causes, the derived state, the fields of the answers (job,
// run, the field `job` on GET /api/chats) and what a PATCH may change. Web (lib/api/scheduled.ts, lib/scheduled.ts) and iOS
// (Models/ScheduledModels.swift) carried them only by convention -- a renamed cadence on the server made both clients silently
// show a job without a cadence (`null` or no `ScheduledCadence`).
//
// What is bound here:
//   (a) Web, EXECUTED (compiled without tsconfig, as scheduled-form.test.mjs): every list of lib/api/scheduled.ts equals the
//       contract; `normScheduledJob`/`normScheduledRun`/`normChatJob` get an object of EXACTLY the fields of the contract and return
//       every field with its value, in the order of the contract (the id of a run goes on as text); every cadence, status, cause
//       and state survives the normalization; the ways read the keys the routes send (read from `scheduled/routes.js`: list
//       `{items, now}`, creation `{job, chat}`, run `{run, job}`, runs `{items, next}`); the PATCH carries only PATCH_FIELDS; the
//       literal of `scheduled/chat-field.js:chatJobField` carries exactly CHAT_JOB_FIELDS. lib/scheduled.ts: the choice of cadences,
//       weekdays, days of month and segments are the sets of the contract, every run status, cause (except the tick -- the normal
//       case has no word) and state has its word. In the type the fields hang on the lists via `SCHEDULED_TYPES_BOUND` (tsc); the
//       compared literals in components/scheduled/ are checked by tsc through the types (`status: ScheduledStatus | null`).
//   (b) The PLAN, EXECUTED against `scheduled/cadence.js`: on a table of cases (every cadence, limits of the time of day, weekdays,
//       day of month 0/1/28/29, one-time in future and past) and zones including daylight-saving changes the server accepts every
//       plan that `planFromForm` builds and cleans it to THE SAME plan; what the form rejects, the server rejects too. No client
//       computes an appointment itself (web and iOS show `nextAt` and `cadenceText` of the server) -- guard (e) holds that.
//   (c) iOS, read as TEXT (pattern preview-binding): `ScheduledContract` (lists, ranges, maximum length) and the cases of
//       `ScheduledCadence` equal the contract; the `CodingKeys` of `ScheduledJob`/`ScheduledRun` equal the fields and each is read;
//       `ChatJob` with exactly CHAT_JOB_FIELDS; `ScheduledPlan` with exactly the keys that cadence.js cleans; `ScheduledChange` equals
//       PATCH_FIELDS and is encoded synthesized (no `encode(to:)`, no `CodingKeys` -- only so nil means "unchanged"); the answers
//       `ScheduledList`/`ScheduledRuns`/`ScheduledCreationResponse`/`ScheduledRunResponse` with the keys of the routes; the words in
//       `ScheduledWord` for every value; the segments; the compared literals in Code/ScheduledPane.swift, Code/ScheduledDetail.swift
//       and Chat/WorkspaceViews.swift are a subset of the contract.
//   (d) The notification kinds of a job chat: the server accepts JOB_NOTIFICATIONS (`scheduled/chat-field.js` = kinds of a chat union
//       kinds of a schedule from notify.js); the web sheet computes them with `jobNotificationKinds`, the iOS sheet with the same
//       union; every kind that scheduled/notification.js reports is in it, and the run-end kind that the job dialog writes is the one
//       notification.js reads. The iOS sheet "Notifications" of a job opens only with the choice of the chat (from the chat list or
//       fresh from the server) -- with `[:]` the first toggle deleted the other choices.
//   (f) The zone: both clients send the zone of the device with the POST (the web dialog sent none, the server then took the
//       remembered one of the workspace, without one "UTC" -- an "08:00" typed on the web ran at 08:00 UTC), the browser's zone is
//       taken by cadence.js, and `foreignZone` names a zone only if it differs from the own one.
//   (g) Editing: cadence and plan go out and are checked only if the repetition was touched -- web `jobChange` executed, iOS as
//       text (no `ScheduledChange(...)` with cadence/plan as argument). Before, a finished one-time job could not be changed in any
//       dialog without setting a new point in time.
//   (e) One built-in sabotage per binding on a copy in memory: a renamed cadence (web and iOS), a renamed field in
//       `normScheduledRun`, a contract with a foreign status, a day of month 31 in the form, a renamed decoder key, a foreign
//       literal, the union of the kinds without those of a schedule.
//
// Found while binding and fixed on the client side: the run read neither `workspaceId` nor `queuedAt` on the web, on iOS not
// `workspaceId`; the sheet "Notifications" of a job chat showed on the web only the kinds of a chat (the run end `schedule` was
// missing, which iOS offers).
//
// Counter-tests: in lib/api/scheduled.ts "workdays" in SCHEDULED_CADENCES to "workday" => (a) red; in ScheduledModels.swift
// `workspaceId` removed from the CodingKeys of ScheduledRun => (c) red; in lib/scheduled.ts `scheduleKinds` removed from
// `jobNotificationKinds` => (d) red. A field removed from SCHEDULED_RUN_FIELDS additionally makes tsc red (`SCHEDULED_TYPES_BOUND`:
// "Type 'true' is not assignable to type 'false'"). `ScheduledChange` extended by `enum CodingKeys` + own `encode(to:)` => (c) red;
// in chat-field.js `nextAt:` to `next:` => (a) server red.
//
// Run:  node --test --test-reporter=tap web/test/scheduled-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as V from "../../server/backend/electron/server/scheduled/contract.js";
import { cadenceOff } from "../../server/backend/electron/server/scheduled/cadence.js";
import * as N from "../../server/backend/electron/server/notify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const src = (...p) => path.join(webDir, "src", ...p);
const ios = (...p) => path.join(repo, "mobile", "CbaseMobile", ...p);
const server = (...p) => path.join(repo, "server", "backend", "electron", "server", ...p);
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (p) => fs.readFileSync(p, "utf8");
const set = (xs) => [...new Set(xs)].sort();
const area = ({ min, max }) => Array.from({ length: max - min + 1 }, (_, i) => min + i);

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

/** Collects deviations instead of stopping at the first difference -- the counter-tests ask for a specific one. */
function collator(page) {
  const deviations = [];
  const equal = (holds, desired, what) => { try { assert.deepStrictEqual(holds, desired); } catch { deviations.push(`${what}: ${page} ${JSON.stringify(holds)}, contract ${JSON.stringify(desired)}`); } };
  return { deviations, equal };
}

// ── The keys of the answers, as scheduled/routes.js sends them ────────────────────────────────────────────────

/** The keys of the top level of an object literal from `start` (the index of the opening brace) -- shorthand and `k:`. */
function upperLiteral(text, start) {
  let depth = 0, part = "", i = start;
  const parts = [];
  for (; i < text.length; i++) {
    const z = text[i];
    if ("({[".includes(z)) { depth++; if (depth === 1) continue; }
    if (")}]".includes(z)) { depth--; if (depth === 0) break; }
    if (depth === 1 && z === ",") { parts.push(part); part = ""; continue; }
    part += z;
  }
  parts.push(part);
  return parts.map((t) => /^\s*(\w+)\s*(?::|$)/.exec(t)?.[1]).filter(Boolean);
}

/** The four answers of the routes, each found via a marker that stands only there. */
function routesKey(text = read(server("scheduled", "routes.js"))) {
  const at = (marker) => {
    const i = text.indexOf(marker);
    assert.ok(i >= 0, `"${marker}" is no longer in scheduled/routes.js -- update the marker of this test`);
    return upperLiteral(text, text.indexOf("{", i));
  };
  return {
    list: at("return send(res, 200, { items: store.listScheduledJobs("),
    creation: at("return send(res, 201, { job: publicJob(fresh.job)"),
    run: at("return send(res, 201, { run:"),
    runs: at("return send(res, 200, { items, next"),
  };
}

// ── (a) Web ──────────────────────────────────────────────────────────────────────────────────────

let web = null;
async function loadWeb() {
  if (web) return web;
  assert.ok(fs.existsSync(tsc), "web/node_modules is missing (tsc) -- the binding cannot be checked without the compiler");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-scheduled-binding-"));
  execFileSync(process.execPath, [
    tsc, src("lib", "scheduled.ts"), src("lib", "api", "scheduled.ts"),
    "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  web = {
    G: await import(pathToFileURL(path.join(tmp, "scheduled.js")).href),
    A: await import(pathToFileURL(path.join(tmp, "api", "scheduled.js")).href),
  };
  return web;
}

/** A version of one of the two sources with changed text -- compiled next to the real one (same `./core.js` imports). */
async function loadSabotaged(which, change) {
  await loadWeb();
  const ts = createRequire(path.join(webDir, "package.json"))("typescript");
  const rel = which === "api" ? ["lib", "api", "scheduled.ts"] : ["lib", "scheduled.ts"];
  const js = ts.transpileModule(change(read(src(...rel))), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = path.join(tmp, ...(which === "api" ? ["api"] : []), `scheduled-sabotage-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, js);
  return { ...web, [which === "api" ? "A" : "G"]: await import(pathToFileURL(file).href) };
}

/** Example values per field of the contract -- none of them is the default of the normalization, else a lost field would look right. */
const EXAMPLE_RUN = {
  id: 7, jobId: "a1", workspaceId: "w1", chatId: "c1", cause: "caughtUp", scheduledAt: 101, queuedAt: 102, startedAt: 103,
  endedAt: 104, status: "missed", error: "broken", short: "finished", question: true,
};
const EXAMPLE_JOB = {
  id: "a1", workspaceId: "w1", chatId: "c1", instructions: "Enter times", cadence: "workdays", plan: { clockTime: "22:00" },
  timeZone: "Europe/Berlin", status: "paused", nextAt: 11, retryAt: 22, lastRunAt: 33, lastStatus: "error", lastError: "way",
  createdAt: 44, updatedAt: 55, name: "Working hours", projectId: "p1", cadenceText: "Workdays at 22:00", state: "parked",
  lastRun: EXAMPLE_RUN,
};
const EXAMPLE_CHAT_JOB = { id: "a1", name: "Working hours", status: "done", nextAt: 9 };

const fromFields = (fields, example, location) => Object.fromEntries(fields.map((f) => {
  assert.ok(Object.hasOwn(example, f), `the contract names "${f}" (${location}), this test has no example value for it -- add one`);
  return [f, example[f]];
}));
/** What the normalization should make of a run: the number as id goes on as text (lib/api/scheduled.ts `identifier`). */
const runDesired = (raw) => ({ ...raw, id: String(raw.id) });

/** All deviations of the web side from the contract (empty = bound). */
async function webDeviations({ G, A }, contract = V, routes = routesKey()) {
  const { deviations, equal } = collator("Web");
  equal([...A.SCHEDULED_CADENCES], [...contract.CADENCES], "Cadences");
  equal({ ...A.SCHEDULED_DAY_OF_MONTH }, { ...contract.DAY_OF_MONTH }, "Day of month");
  equal([...A.SCHEDULED_JOB_STATUS], [...contract.JOB_STATUS], "Status of a job");
  equal([...A.SCHEDULED_RUN_CAUSES], [...contract.RUN_CAUSES], "Causes of a run");
  equal([...A.SCHEDULED_RUN_STATUS], [...contract.RUN_STATUS], "Status of a run");
  equal([...A.SCHEDULED_STATES], [...contract.STATES], "States");
  equal(A.SCHEDULED_INSTRUCTIONS_MAX, contract.INSTRUCTIONS_MAX, "Maximum length of the instructions");
  equal([...A.SCHEDULED_PATCH_FIELDS], [...contract.PATCH_FIELDS], "PATCH fields");
  equal([...A.SCHEDULED_JOB_FIELDS], [...contract.JOB_FIELDS], "Fields of a job");
  equal([...A.SCHEDULED_JOB_DERIVED], [...contract.JOB_DERIVED], "Derived fields of a job");
  equal([...A.SCHEDULED_RUN_FIELDS], [...contract.RUN_FIELDS], "Fields of a run");
  equal([...A.SCHEDULED_CHAT_JOB_FIELDS], [...contract.CHAT_JOB_FIELDS], "Field job on GET /api/chats");

  // lib/scheduled.ts: the choice and the words.
  equal(set(G.CADENCE_CHOICE.map((r) => r.value)), set(contract.CADENCES), "Choice of the cadences (lib/scheduled.ts)");
  equal(set(G.WEEKDAYS.map((d) => d.value)), area(contract.WEEKDAY), "Weekdays of the bar");
  equal([...G.DAYS_OF_MONTH], area(contract.DAY_OF_MONTH), "Days of month of the choice");
  equal(set(G.SEGMENTS.map((s) => s.key)), set(contract.JOB_STATUS), "Segments of the list");
  for (const s of contract.RUN_STATUS) if (G.runWord(s) === "unknown") deviations.push(`runWord does not know the run status "${s}"`);
  for (const a of contract.RUN_CAUSES) if (a !== "tick" && !G.causeWord(a)) deviations.push(`causeWord does not know the cause "${a}"`);
  for (const z of contract.STATES) if (!G.stateWord(z)) deviations.push(`stateWord does not know the state "${z}"`);

  // The normalization: exactly the fields of the contract, with their value, in its order.
  const runRaw = fromFields(contract.RUN_FIELDS, EXAMPLE_RUN, "RUN_FIELDS");
  const run = A.normScheduledRun(runRaw);
  equal(run && Object.keys(run), [...contract.RUN_FIELDS], "normScheduledRun: keys");
  equal(run, runDesired(runRaw), "normScheduledRun: values");
  const jobRaw = fromFields([...contract.JOB_FIELDS, ...contract.JOB_DERIVED], { ...EXAMPLE_JOB, lastRun: runRaw }, "JOB_FIELDS");
  const job = A.normScheduledJob(jobRaw);
  equal(job && Object.keys(job), [...contract.JOB_FIELDS, ...contract.JOB_DERIVED], "normScheduledJob: keys");
  equal(job, { ...jobRaw, lastRun: runDesired(runRaw) }, "normScheduledJob: values");
  const chatRaw = fromFields(contract.CHAT_JOB_FIELDS, EXAMPLE_CHAT_JOB, "CHAT_JOB_FIELDS");
  const chat = A.normChatJob(chatRaw);
  equal(chat && Object.keys(chat), [...contract.CHAT_JOB_FIELDS], "normChatJob: keys");
  equal(chat, chatRaw, "normChatJob: values");
  for (const r of contract.CADENCES) equal(A.normScheduledJob({ ...jobRaw, cadence: r })?.cadence, r, `Cadence "${r}"`);
  for (const s of contract.JOB_STATUS) {
    equal(A.normScheduledJob({ ...jobRaw, status: s })?.status, s, `Status "${s}"`);
    equal(A.normChatJob({ ...chatRaw, status: s })?.status, s, `Status "${s}" on GET /api/chats`);
  }
  for (const z of contract.STATES) equal(A.normScheduledJob({ ...jobRaw, state: z })?.state, z, `State "${z}"`);
  for (const s of contract.RUN_STATUS) equal(A.normScheduledRun({ ...runRaw, status: s })?.status, s, `Run status "${s}"`);
  for (const a of contract.RUN_CAUSES) equal(A.normScheduledRun({ ...runRaw, cause: a })?.cause, a, `Cause "${a}"`);

  // The ways read what the routes send (fetch intercepted, the answers built from the keys of routes.js).
  const value = { items: null, now: 1, job: jobRaw, chat: { id: "c1" }, run: runRaw, next: 7 };
  const response = (key, items) => Object.fromEntries(key.map((k) => [k, k === "items" ? items : value[k] ?? null]));
  const sent = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url), m = opts?.method || "GET";
    sent.push({ u, m, body: opts?.body ? JSON.parse(opts.body) : null });
    let d = jobRaw;
    if (m === "GET" && u.includes("/runs")) d = response(routes.runs, [runRaw]);
    else if (m === "GET") d = response(routes.list, [jobRaw]);
    else if (m === "POST" && u.endsWith("/run")) d = response(routes.run);
    else if (m === "POST") d = response(routes.creation);
    return new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const list = await A.loadScheduledJobs("w1");
    equal(list.map((a) => a.id), ["a1"], "loadScheduledJobs reads the list of the route");
    const fresh = await A.setUpScheduledJob("w1", { instructions: "x", cadence: "daily", plan: { clockTime: "08:00" }, permissionMode: "default" });
    equal([fresh.job?.id, fresh.chatId], ["a1", "c1"], "setUpScheduledJob reads job and chat of the route");
    const now = await A.executeScheduledJob("w1", "a1");
    equal(now?.id, "a1", "executeScheduledJob reads the job of the route");
    const runs = await A.loadScheduledRuns("w1", "a1", { limit: 1 });
    equal([runs.items.map((l) => l.id), runs.next], [["7"], "7"], "loadScheduledRuns reads runs and `next` of the route");
    const patch = { instructions: "y", cadence: "workdays", plan: { clockTime: "07:00" }, status: "paused" };
    await A.changeScheduledJob("w1", "a1", patch);
    const body = sent.find((g) => g.m === "PATCH")?.body ?? {};
    equal(body, patch, "PATCH body as passed");
    for (const k of Object.keys(body)) if (!contract.PATCH_FIELDS.includes(k)) deviations.push(`the PATCH carries "${k}", which PATCH_FIELDS does not know`);
  } finally { globalThis.fetch = old; }
  return deviations;
}

test("(a) Web: Listen, Normierung and Ways from lib/api/scheduled.ts and die Selection from lib/scheduled.ts like contract.js", async () => {
  const deviations = await webDeviations(await loadWeb());
  assert.deepEqual(deviations, [], `web differs from contract.js:\n${deviations.join("\n")}`);
});

test("(a) CounterProbe: one renamed Cadence, one umbenanntes Field in normScheduledRun, one foreign Status and one foreign Response fallen on", async () => {
  const cadences = 'export const SCHEDULED_CADENCES = ["oneTime", "daily", "workdays", "weekly", "monthly"] as const;';
  const r = await loadSabotaged("api", (q) => {
    assert.ok(q.includes(cadences), "the line SCHEDULED_CADENCES no longer stands like this -- update the sabotage");
    return q.replace(cadences, cadences.replace('"workdays"', '"workday"'));
  });
  const a = await webDeviations(r);
  assert.ok(a.some((z) => z.startsWith("Cadences:")) && a.some((z) => z.startsWith('Cadence "workdays"')), `the renamed cadence went unnoticed:\n${a.join("\n")}`);

  const field = "queuedAt: count(raw.queuedAt)";
  const f = await loadSabotaged("api", (q) => {
    assert.ok(q.includes(field), "the line for the sabotage is no longer in normScheduledRun -- update");
    return q.replace(field, "queuedAm: count(raw.queuedAt)");
  });
  const b = await webDeviations(f);
  assert.ok(b.some((z) => z.startsWith("normScheduledRun: keys")), `the renamed field went unnoticed:\n${b.join("\n")}`);

  const c = await webDeviations(await loadWeb(), { ...V, JOB_STATUS: [...V.JOB_STATUS, "waiting"] });
  assert.ok(c.some((z) => z.startsWith("Status of a job")) && c.some((z) => z.startsWith('Status "waiting"')) && c.some((z) => z.startsWith("Segments")), c.join("\n"));

  const d = await webDeviations(await loadWeb(), V, { ...routesKey(), list: ["entries", "now"] });
  assert.ok(d.some((z) => z.startsWith("loadScheduledJobs")), d.join("\n"));
});

/** The keys of the literal in `scheduled/chat-field.js:chatJobField` -- the field `job` that GET /api/chats sends. */
function chatFieldKey(text = read(server("scheduled", "chat-field.js"))) {
  const i = text.indexOf("export function chatJobField(");
  const m = /return a \? \{([^}]*)\} : null;/.exec(i < 0 ? "" : text.slice(i));
  return m ? [...m[1].matchAll(/(\w+):/g)].map((x) => x[1]) : null;
}

test("(a) server: the field `job` on GET /api/chats (chat-field.js) carries exactly CHAT_JOB_FIELDS, in their order", () => {
  // The server side was not tied to the contract -- if it grew, both clients would follow and the server would never send the field.
  const k = chatFieldKey();
  assert.ok(k, "chatJobField no longer builds its literal as `return a ? { ... } : null;` -- update this test");
  assert.deepEqual(k, [...V.CHAT_JOB_FIELDS]);
});

test("(a) counter-test: a renamed field in chat-field.js is caught", () => {
  const text = read(server("scheduled", "chat-field.js"));
  assert.ok(text.includes("nextAt: a.nextAt"), "the line for the sabotage no longer stands like this -- update");
  assert.notDeepEqual(chatFieldKey(text.replace("nextAt: a.nextAt", "next: a.nextAt")), [...V.CHAT_JOB_FIELDS]);
});

// ── (b) The plan of the form against cadence.js ─────────────────────────────────────────────────

const ZONES = ["Europe/Berlin", "UTC", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"];
// Ordinary Monday; the night of the clocks going forward (2026-03-29) and back (2026-10-25) in Europe; New York goes back on 11-01.
const CLOCKS = [Date.UTC(2026, 9, 19, 9, 0), Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 10, 1, 5, 30)];
const HOUR = 3_600_000;

/** The cases: form part and whether the form should accept it -- a case that saw both sides equally wrong would otherwise slip through. */
function cases(G, now) {
  const at = (ms) => G.localIso(ms);
  return [
    [{ cadence: "daily", clockTime: "8:05" }, true], [{ cadence: "daily", clockTime: "00:00" }, true],
    [{ cadence: "daily", clockTime: "23:59" }, true], [{ cadence: "daily", clockTime: "24:00" }, false],
    [{ cadence: "daily", clockTime: "7:60" }, false], [{ cadence: "daily", clockTime: "" }, false],
    [{ cadence: "workdays", clockTime: "22:00" }, true], [{ cadence: "workdays", clockTime: "02:30" }, true],
    [{ cadence: "weekly", clockTime: "09:30", days: [5, 1, 1, 0] }, true], [{ cadence: "weekly", clockTime: "09:30", days: [6] }, true],
    [{ cadence: "weekly", clockTime: "02:30", days: [0] }, true],
    [{ cadence: "weekly", clockTime: "09:30", days: [] }, false], [{ cadence: "weekly", clockTime: "09:30", days: [7] }, false],
    [{ cadence: "monthly", clockTime: "08:00", day: 1 }, true], [{ cadence: "monthly", clockTime: "08:00", day: 28 }, true],
    [{ cadence: "monthly", clockTime: "08:00", day: 29 }, false], [{ cadence: "monthly", clockTime: "08:00", day: 0 }, false],
    [{ cadence: "oneTime", oneTime: at(now + 26 * HOUR) }, true], [{ cadence: "oneTime", oneTime: at(now - HOUR) }, false],
    [{ cadence: "oneTime", oneTime: "" }, false],
  ];
}

/** Deviations between the form (`G.planFromForm`) and the server (`cadenceOff`, cadence.js). */
function planDeviations(G, check = cadenceOff, contract = V) {
  const deviations = [];
  const seen = new Set();
  for (const timeZone of ZONES) for (const now of CLOCKS) {
    for (const [part, desired] of cases(G, now)) {
      const location = `${JSON.stringify(part)} in ${timeZone} at ${new Date(now).toISOString()}`;
      seen.add(part.cadence);
      const form = G.planFromForm({ ...G.emptyCadenceForm(), ...part }, now);
      if ("error" in form === desired) deviations.push(`Form ${desired ? "rejects" : "accepts"}: ${location}${form.error ? ` (${form.error})` : ""}`);
      if ("error" in form) {
        // What the form rejects, the server rejects too -- with what the field held.
        const raw = part.cadence === "oneTime" ? { at: part.oneTime ? new Date(part.oneTime).getTime() : undefined }
          : { clockTime: part.clockTime, ...(part.days ? { days: part.days } : {}), ...(part.day !== undefined ? { day: part.day } : {}) };
        if (check(part.cadence, raw, { timeZone, now }).ok) deviations.push(`Server accepts what the form rejects: ${location}`);
        continue;
      }
      const r = check(form.cadence, form.plan, { timeZone, now });
      if (!r.ok) { deviations.push(`Server rejects the plan of the form: ${location} -> ${JSON.stringify(form.plan)} (${r.error?.[0]})`); continue; }
      try { assert.deepStrictEqual(r.plan, form.plan); } catch { deviations.push(`Server cleans the plan differently: ${location} -> form ${JSON.stringify(form.plan)}, server ${JSON.stringify(r.plan)}`); }
    }
  }
  for (const r of contract.CADENCES) if (!seen.has(r)) deviations.push(`the table has no case for the cadence "${r}" -- add one`);
  return deviations;
}

test("(b) plan: every plan of the form is one that cadence.js accepts and cleans the same -- in five zones, across daylight saving", async () => {
  const deviations = planDeviations((await loadWeb()).G);
  assert.deepEqual(deviations, [], deviations.join("\n"));
});

test("(b) counter-test: a form including day of month 31 and a server without the 28th as limit are caught", async () => {
  const s = await loadSabotaged("form", (q) => {
    const z = "Array.from({ length: 28 }";
    assert.ok(q.includes(z), "the line DAYS_OF_MONTH no longer stands like this -- update the sabotage");
    return q.replace(z, "Array.from({ length: 31 }");
  });
  const a = planDeviations(s.G);
  assert.ok(a.some((z) => z.startsWith("Form accepts") && z.includes('"day":29')), a.join("\n"));
  const b = planDeviations((await loadWeb()).G, (r, p, o) => (r === "monthly" && p.day === 29 ? { ok: true, plan: p } : cadenceOff(r, p, o)));
  assert.ok(b.some((z) => z.startsWith("Server accepts what the form rejects")), b.join("\n"));
  const c = planDeviations((await loadWeb()).G, cadenceOff, { ...V, CADENCES: [...V.CADENCES, "hourly"] });
  assert.ok(c.some((z) => z.includes('"hourly"')), c.join("\n"));
});

// ── (c) iOS ──────────────────────────────────────────────────────────────────────────────────────

const MODELS = ios("Models", "ScheduledModels.swift");
const VIEWS = [ios("Code", "ScheduledPane.swift"), ios("Code", "ScheduledDetail.swift")];
const ROWS_CLOCK = ios("Chat", "WorkspaceViews.swift");
const NOTIFY_IOS = ios("Settings", "NotifySettings.swift");

/** A top-level type: from the header to the first `}` in column 0 (pattern archive-binding.test.mjs). */
function block(text, header) {
  const rows = text.split("\n");
  const start = rows.findIndex((z) => z.startsWith(header));
  if (start < 0) return null;
  const end = rows.findIndex((z, i) => i > start && z === "}");
  return end > start ? rows.slice(start, end + 1).join("\n") : null;
}

/** The keys of an `enum CodingKeys` -- one line or several. */
function codingKeys(b) {
  const m = /enum CodingKeys: String, CodingKey \{([\s\S]*?)\n?\s*\}/.exec(b ?? "");
  if (!m) return null;
  return m[1].split(/\n|(?=\bcase\b)/).flatMap((z) => (/\bcase\s+(.*)$/.exec(z.trim())?.[1] ?? "").split(",")).map((x) => x.trim()).filter(Boolean);
}

/** The stored properties of a type (`let x:` / `var x:` at the first indentation, without computed `var x: T { ... }`). */
const properties = (b) => [...(b ?? "").matchAll(/^ {4}(?:let|var) (\w+):[^\n{]*$/gm)].map((m) => m[1]);
/** The literals of a Swift list `static let <name> = [ ... ]`. */
const swiftList = (text, name) => {
  const m = new RegExp(`static let ${name} = \\[([^\\]]*)\\]`).exec(text);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
};
const swiftArea = (text, name) => {
  const m = new RegExp(`static let ${name} = (\\d+)\\.\\.\\.(\\d+)`).exec(text);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
};
/** The `case "..."` literals of a function of `ScheduledWord` (up to the next `static func`). */
function wordCases(text, name) {
  const i = text.indexOf(`static func ${name}(`);
  if (i < 0) return null;
  const j = text.indexOf("static func ", i + 1);
  const body = text.slice(i, j < 0 ? undefined : j);
  return [...body.matchAll(/case "([^"]+)"/g)].map((m) => m[1]);
}

/** The keys that cadence.js keeps in a cleaned plan -- over all cadences of the contract. */
function planKey(contract = V) {
  const now = Date.UTC(2026, 9, 19, 9, 0);
  const plan = { at: now + HOUR, clockTime: "08:00", days: [1], day: 1 };
  return set(contract.CADENCES.flatMap((r) => Object.keys(cadenceOff(r, plan, { timeZone: "UTC", now }).plan ?? {})));
}

/** All deviations of the iOS side from the contract; `texts` = { models, views: [...], row } (for sabotage on copies). */
function iosDeviations(texts, contract = V, routes = routesKey()) {
  const { deviations, equal } = collator("iOS");
  const m = texts.models;
  const vb = block(m, "enum ScheduledContract");
  if (!vb) deviations.push("enum ScheduledContract is missing in ScheduledModels.swift");
  equal(swiftList(vb ?? "", "cadences"), [...contract.CADENCES], "ScheduledContract.cadences");
  equal(swiftArea(vb ?? "", "dayOfMonth"), { ...contract.DAY_OF_MONTH }, "ScheduledContract.dayOfMonth");
  equal(swiftArea(vb ?? "", "weekday"), { ...contract.WEEKDAY }, "ScheduledContract.weekday");
  equal(swiftList(vb ?? "", "jobStatus"), [...contract.JOB_STATUS], "ScheduledContract.jobStatus");
  equal(swiftList(vb ?? "", "runCauses"), [...contract.RUN_CAUSES], "ScheduledContract.runCauses");
  equal(swiftList(vb ?? "", "runStatus"), [...contract.RUN_STATUS], "ScheduledContract.runStatus");
  equal(swiftList(vb ?? "", "states"), [...contract.STATES], "ScheduledContract.states");
  equal(Number(/static let instructionsMax = ([\d_]+)/.exec(vb ?? "")?.[1]?.replace(/_/g, "")), contract.INSTRUCTIONS_MAX, "ScheduledContract.instructionsMax");

  const rb = block(m, "enum ScheduledCadence");
  equal([...(rb ?? "").matchAll(/^ {4}case (\w+)$/gm)].map((x) => x[1]), [...contract.CADENCES], "Cases of ScheduledCadence");

  // Answers: decoder keys equal to the contract, each read.
  for (const [header, fields] of [
    ["struct ScheduledRun:", contract.RUN_FIELDS],
    ["struct ScheduledJob:", [...contract.JOB_FIELDS, ...contract.JOB_DERIVED]],
  ]) {
    const b = block(m, header);
    if (!b) { deviations.push(`${header} is missing in ScheduledModels.swift`); continue; }
    equal(set(codingKeys(b) ?? []), set(fields), `${header} CodingKeys`);
    equal(set(properties(b)), set(fields), `${header} properties`);
    const read = b.slice(b.indexOf("init(from decoder"));
    for (const f of fields) if (!new RegExp(`[(:]\\s*\\.${f}\\b`).test(read)) deviations.push(`${header} does not read "${f}"`);
  }
  const cb = block(m, "struct ChatJob:");
  equal(properties(cb), [...contract.CHAT_JOB_FIELDS], "ChatJob: properties");
  for (const f of contract.CHAT_JOB_FIELDS) if (!new RegExp(`\\(\\.${f}\\b`).test((cb ?? "").slice((cb ?? "").indexOf("init(from decoder")))) deviations.push(`ChatJob does not read "${f}"`);
  equal(set(properties(block(m, "struct ScheduledPlan:"))), planKey(contract), "ScheduledPlan: keys of the plan (cadence.js)");
  equal(set(properties(block(m, "struct ScheduledChange:"))), set(contract.PATCH_FIELDS), "ScheduledChange: PATCH_FIELDS");
  // "nil means unchanged" is carried only by the SYNTHESIZED Encodable (it omits nil). An own `encode(to:)` or own
  // `CodingKeys` could write nil as null -- on the server every change would then be a 400 (`status: null`, `timeZone: null`).
  const startAt = block(m, "struct ScheduledChange:") ?? "";
  if (/\bencode\(to\b/.test(startAt) || /\bCodingKeys\b/.test(startAt)) deviations.push("ScheduledChange is no longer encoded synthesized (encode(to:) or CodingKeys) -- nil would no longer mean \"unchanged\"");
  if (/^extension ScheduledChange\b/m.test(m)) deviations.push("an extension ScheduledChange -- the synthesized Encodable can no longer be proven");

  // The answers of the routes.
  equal(set(codingKeys(block(m, "struct ScheduledList:")) ?? []), set(routes.list), "ScheduledList: keys of GET .../scheduled");
  equal(set(codingKeys(block(m, "struct ScheduledRuns:")) ?? []), set(routes.runs), "ScheduledRuns: keys of GET .../runs");
  for (const [header, key] of [["struct ScheduledCreationResponse:", routes.creation], ["struct ScheduledRunResponse:", routes.run]]) {
    for (const f of properties(block(m, header))) if (!key.includes(f)) deviations.push(`${header} reads "${f}", which the route does not send (${key.join(", ")})`);
  }

  // The words per value.
  equal(set(wordCases(m, "status") ?? []), set(contract.JOB_STATUS), "ScheduledWord.status");
  equal(set(wordCases(m, "state") ?? []), set(contract.STATES), "ScheduledWord.state");
  equal(set(wordCases(m, "runStatus") ?? []), set(contract.RUN_STATUS), "ScheduledWord.runStatus");
  equal(set(wordCases(m, "cause") ?? []), set(contract.RUN_CAUSES), "ScheduledWord.cause");

  // The segments of the list: `case upcoming, paused, done` with `upcoming` => "active".
  const pane = texts.views[0];
  const pages = (/enum Page: String[^{]*\{\s*case ([^\n]+)/.exec(pane)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const fallback = /self == \.(\w+) \? "(\w+)" : rawValue/.exec(pane);
  equal(set(pages.map((s) => (fallback && s === fallback[1] ? fallback[2] : s))), set(contract.JOB_STATUS), "Segments (ScheduledPane.Page)");

  // Compared and sent literals.
  const views = texts.views.join("\n");
  const status = [...views.matchAll(/(?:\bjob|\ba|\$0)\.status\s*[!=]=\s*"([^"]+)"/g), ...texts.row.matchAll(/\bjob\.status\s*[!=]=\s*"([^"]+)"/g)].map((x) => x[1]);
  status.push(...[...views.matchAll(/status\([^)]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\)/g)].flatMap((x) => [x[1], x[2]]));
  const runStatus = [...views.matchAll(/\blastStatus\s*[!=]=\s*"([^"]+)"/g)].map((x) => x[1]);
  const states = [...views.matchAll(/\bstate\s*[!=]=\s*"([^"]+)"/g)].map((x) => x[1]);
  const sw = /switch a\.state \{([\s\S]*?)\n {8}\}/.exec(pane)?.[1] ?? "";
  states.push(...[...sw.matchAll(/^\s*case ([^:\n]+):/gm)].flatMap((x) => [...x[1].matchAll(/"([^"]+)"/g)].map((y) => y[1])));
  for (const s of set(status)) if (!contract.JOB_STATUS.includes(s)) deviations.push(`iOS compares the status "${s}", which the contract does not know`);
  for (const s of set(runStatus)) if (!contract.RUN_STATUS.includes(s)) deviations.push(`iOS compares the last run status "${s}", which the contract does not know`);
  for (const z of set(states)) if (!contract.STATES.includes(z)) deviations.push(`iOS compares the state "${z}", which the contract does not know`);
  if (status.length === 0 || states.length === 0) deviations.push("no status or state literals found -- does the test still read the right files?");
  return deviations;
}

const iosTexts = () => ({ models: read(MODELS), views: VIEWS.map(read), row: read(ROWS_CLOCK) });

test("(c) iOS: ScheduledContract, cadences, decoders, plan, PATCH, answers, words, segments and literals like contract.js", () => {
  const deviations = iosDeviations(iosTexts());
  assert.deepEqual(deviations, [], `iOS differs from contract.js:\n${deviations.join("\n")}`);
});

test("(c) counter-test: a renamed cadence, a renamed decoder key, a foreign literal and a new run status are caught", () => {
  const t = iosTexts();
  const row = 'static let cadences = ["oneTime", "daily", "workdays", "weekly", "monthly"]';
  assert.ok(t.models.includes(row), "ScheduledContract.cadences no longer stands like this -- update the sabotage");
  const a = iosDeviations({ ...t, models: t.models.replace(row, row.replace('"workdays"', '"workday"')).replace("    case workdays\n", "    case workday\n") });
  assert.ok(a.some((z) => z.startsWith("ScheduledContract.cadences")) && a.some((z) => z.startsWith("Cases of ScheduledCadence")), a.join("\n"));

  const key = "case id, jobId, workspaceId, chatId, cause,";
  assert.ok(t.models.includes(key), "the CodingKeys row of ScheduledRun no longer stands like this -- update");
  const b = iosDeviations({ ...t, models: t.models.replace(key, "case id, jobId, workspace, chatId, reason,") });
  assert.ok(b.some((z) => z.startsWith("struct ScheduledRun: CodingKeys")), b.join("\n"));

  const c = iosDeviations({ ...t, views: [t.views[0], `${t.views[1]}\nif job.status == "waiting" {}`] });
  assert.ok(c.some((z) => z.includes('the status "waiting"')), c.join("\n"));

  const d = iosDeviations(t, { ...V, RUN_STATUS: [...V.RUN_STATUS, "locked"] });
  assert.ok(d.some((z) => z.startsWith("ScheduledContract.runStatus")) && d.some((z) => z.startsWith("ScheduledWord.runStatus")), d.join("\n"));

  const e = iosDeviations(t, V, { ...routesKey(), list: ["items", "clock"] });
  assert.ok(e.some((z) => z.startsWith("ScheduledList")), e.join("\n"));

  // An own encode(to:) that wrote nil as null used to leave (c) green.
  const header = "struct ScheduledChange: Encodable, Sendable {\n";
  assert.ok(t.models.includes(header), "the header of ScheduledChange no longer stands like this -- update the sabotage");
  const f = iosDeviations({ ...t, models: t.models.replace(header, `${header}    enum CodingKeys: String, CodingKey { case instructions, cadence, plan, timeZone, status }
    func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(status, forKey: .status) }
`) });
  assert.ok(f.some((z) => z.startsWith("ScheduledChange is no longer encoded synthesized")), f.join("\n"));
});

// ── (d) Notification kinds of a job chat ────────────────────────────────────────────────────

/** The kinds the server accepts for a job chat -- computed from notify.js like `scheduled/chat-field.js`. */
function serverKinds(text = read(server("scheduled", "chat-field.js"))) {
  const def = "export const JOB_NOTIFICATIONS = Object.freeze([...new Set([...notifications.CHAT_KINDS, ...notifications.SCHEDULE_KINDS])]);";
  assert.ok(text.includes(def), "scheduled/chat-field.js no longer computes JOB_NOTIFICATIONS as a union -- update this test");
  return [...new Set([...N.CHAT_KINDS, ...N.SCHEDULE_KINDS])];
}

function kindsDeviations(G, iosNotify, dialog = read(src("components", "scheduled", "JobDialog.tsx")), notice = read(server("scheduled", "notification.js"))) {
  const { deviations, equal } = collator("Client");
  const desired = serverKinds();
  equal(G.jobNotificationKinds(N.CHAT_KINDS, N.SCHEDULE_KINDS), desired, "Web jobNotificationKinds");
  const expression = "key = job ? doc.chatKinds + doc.scheduleKinds.filter { !doc.chatKinds.contains($0) } : doc.chatKinds";
  if (!iosNotify.includes(expression)) deviations.push("NotifyChatSheet(job:) no longer computes the kinds as the union chatKinds + scheduleKinds");
  // Every kind that scheduled/notification.js reports is one that can be switched off on the job chat.
  for (const k of set([...notice.matchAll(/kind: "(\w+)"/g)].map((x) => x[1]))) if (!desired.includes(k)) deviations.push(`notification.js reports "${k}", which a job chat does not carry`);
  // The run-end kind: notification.js reads it on the choice of the chat, the dialog writes it.
  const reads = /chat\.notify\?\.(\w+) === OFF/.exec(notice)?.[1];
  if (!reads || !desired.includes(reads)) deviations.push(`notification.js reads the kind "${reads}" on the chat, which a job chat does not carry`);
  const writes = set([...dialog.matchAll(/notify\?\.(\w+) !== "off"|\{ (\w+): "off"/g)].map((x) => x[1] || x[2]));
  equal(writes, reads ? [reads] : [], "Run-end kind in the JobDialog (web)");
  return deviations;
}

test("(d) notification kinds: web and iOS offer on the job chat the same kinds that the server accepts and reports", async () => {
  const deviations = kindsDeviations((await loadWeb()).G, read(NOTIFY_IOS));
  assert.deepEqual(deviations, [], deviations.join("\n"));
});

test("(d) counter-test: a union without the kinds of a schedule (web and iOS) and a foreign kind in the dialog are caught", async () => {
  const s = await loadSabotaged("form", (q) => {
    const z = "return [...new Set([...chatKinds, ...scheduleKinds])];";
    assert.ok(q.includes(z), "jobNotificationKinds no longer stands like this -- update the sabotage");
    return q.replace(z, "return [...new Set([...chatKinds])];");
  });
  const t = read(NOTIFY_IOS);
  const a = kindsDeviations(s.G, t.replace("doc.chatKinds + doc.scheduleKinds.filter { !doc.chatKinds.contains($0) }", "doc.chatKinds"));
  assert.ok(a.some((z) => z.startsWith("Web jobNotificationKinds")) && a.some((z) => z.startsWith("NotifyChatSheet")), a.join("\n"));
  const b = kindsDeviations((await loadWeb()).G, t, read(src("components", "scheduled", "JobDialog.tsx")).replaceAll("schedule: \"off\"", "run: \"off\""));
  assert.ok(b.some((z) => z.startsWith("Run-end kind")), b.join("\n"));
});

// ── (f) The zone on creation ────────────────────────────────────────────────────────────────────

const DIALOG_WEB = src("components", "scheduled", "JobDialog.tsx");
const DIALOG_IOS = ios("Code", "ScheduledDetail.swift");

/** The call of `name(` up to the closing parenthesis (parentheses counted) -- `null` if there is none. */
function call(text, name) {
  const i = text.indexOf(`${name}(`);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i + name.length; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return text.slice(i, j + 1);
  }
  return null;
}

/** Deviations: does every client send a zone with the POST, and is the web one a zone the server accepts? */
function zonesDeviations(G, web = read(DIALOG_WEB), iosText = read(DIALOG_IOS)) {
  const deviations = [];
  const w = call(web, "setUpScheduledJob");
  if (!w) deviations.push("JobDialog.tsx no longer calls setUpScheduledJob -- update this test");
  else if (!/\btimeZone: ownTimeZone\(\)/.test(w)) deviations.push("Web: the POST carries no zone (timeZone: ownTimeZone()) -- the server would take the remembered one of the workspace, without one UTC");
  const i = call(iosText, "ScheduledCreation");
  if (!i) deviations.push("ScheduledDetail.swift no longer builds a ScheduledCreation -- update this test");
  else if (!/\btimeZone: TimeZone\.current\.identifier\b/.test(i)) deviations.push("iOS: the POST carries no zone (timeZone: TimeZone.current.identifier)");
  const zone = G.ownTimeZone();
  if (!cadenceOff("daily", { clockTime: "08:00" }, { timeZone: zone, now: Date.UTC(2026, 9, 21, 9, 0) }).ok) deviations.push(`Web: the server does not accept the browser zone "${zone}"`);
  // Dialog and header name the zone only if it differs.
  const f = [[G.foreignZone("Europe/Berlin", "Europe/Berlin"), null], [G.foreignZone("UTC", "Europe/Berlin"), "UTC"], [G.foreignZone("", "UTC"), null], [G.foreignZone(" UTC ", "UTC"), null]];
  f.forEach(([holds, desired], k) => { if (holds !== desired) deviations.push(`foreignZone case ${k}: ${JSON.stringify(holds)} instead of ${JSON.stringify(desired)}`); });
  return deviations;
}

test("(f) zone: web and iOS send the zone of the device on creation, and the zone of a job is shown where it differs", async () => {
  const deviations = zonesDeviations((await loadWeb()).G);
  assert.deepEqual(deviations, [], deviations.join("\n"));
});

test("(f) counter-test: a POST without zone (web and iOS) is caught", async () => {
  const { G } = await loadWeb();
  const web = read(DIALOG_WEB), iosText = read(DIALOG_IOS);
  assert.ok(web.includes(" timeZone: ownTimeZone(),") && iosText.includes("timeZone: TimeZone.current.identifier,"), "the lines for the sabotage no longer stand like this -- update");
  const a = zonesDeviations(G, web.replace(" timeZone: ownTimeZone(),", ""), iosText.replace("timeZone: TimeZone.current.identifier,", ""));
  assert.ok(a.some((z) => z.startsWith("Web: the POST")) && a.some((z) => z.startsWith("iOS: the POST")), a.join("\n"));
});

// ── (g) Editing: cadence and plan only if they changed ───────────────────────────────

/** Deviations: a finished one-time job can be changed without setting a new point in time. */
function changeDeviations(G, iosText = read(DIALOG_IOS)) {
  const deviations = [];
  const now = Date.UTC(2026, 9, 21, 12, 0);
  const past = { instructions: "Write report", cadence: "oneTime", plan: { at: now - 86_400_000 } };
  const form = G.formFromJob(past);
  // Web, executed: only the instructions changed => no error, no plan in the PATCH; nothing changed => empty PATCH.
  const onlyText = G.jobChange(past, "Write report and send", form, now);
  if ("error" in onlyText) deviations.push(`Web: a finished one-time job cannot be renamed/changed: ${onlyText.error}`);
  else if ("cadence" in onlyText.change || "plan" in onlyText.change) deviations.push("Web: the PATCH carries an unchanged plan");
  const nothing = G.jobChange(past, past.instructions, form, now);
  if ("error" in nothing || Object.keys(nothing.change).length) deviations.push(`Web: unchanged is not empty: ${JSON.stringify(nothing)}`);
  // Whoever touches the repetition is still checked (a check that never runs would be the other half of the error).
  const different = G.jobChange(past, past.instructions, { ...form, oneTime: G.localIso(now - 60_000) }, now);
  if (!("error" in different)) deviations.push("Web: a changed point in time in the past goes out unchecked");
  const daily = { instructions: "x", cadence: "daily", plan: { clockTime: "08:00" } };
  const fresh = G.jobChange(daily, "x", { ...G.formFromJob(daily), clockTime: "09:00" }, now);
  if ("error" in fresh || fresh.change.plan?.clockTime !== "09:00" || fresh.change.cadence !== "daily") deviations.push(`Web: a changed time of day does not go out: ${JSON.stringify(fresh)}`);
  // iOS, as text: no call `ScheduledChange(...)` carries cadence or plan as an argument -- they are set only when changed.
  for (let i = iosText.indexOf("ScheduledChange("); i >= 0; i = iosText.indexOf("ScheduledChange(", i + 1)) {
    const a = call(iosText.slice(i), "ScheduledChange");
    if (a && /\b(cadence|plan):/.test(a)) deviations.push(`iOS: ${a.replace(/\s+/g, " ").slice(0, 120)} always sends cadence/plan along`);
  }
  if (!/if let outcome, outcome\.cadence == cadence, outcome\.plan == plan \{\} else \{\s*change\.cadence = cadence\.rawValue\s*change\.plan = plan/.test(iosText)) {
    deviations.push("iOS: JobDialog.save no longer sets cadence and plan only on a change against `outcome` -- update this test");
  }
  return deviations;
}

test("(g) editing: web and iOS send cadence and plan only if the repetition was touched", async () => {
  const deviations = changeDeviations((await loadWeb()).G);
  assert.deepEqual(deviations, [], deviations.join("\n"));
});

test("(g) counter-test: the old iOS body and the old web check (every save checks the plan) are caught", async () => {
  const t = read(DIALOG_IOS);
  const newIos = "var change = ScheduledChange()";
  assert.ok(t.includes(newIos), "the iOS body no longer stands like this -- update the sabotage");
  const a = changeDeviations((await loadWeb()).G, t.replace(newIos, "var change = ScheduledChange(instructions: text, cadence: cadence.rawValue, plan: plan)"));
  assert.ok(a.some((z) => z.startsWith("iOS: ScheduledChange(")), a.join("\n"));
  const s = await loadSabotaged("form", (q) => {
    const z = "if (formCore(form) !== formCore(formFromJob(a))) {";
    assert.ok(q.includes(z), "jobChange no longer stands like this -- update the sabotage");
    return q.replace(z, "if (true) {");
  });
  const b = changeDeviations(s.G);
  assert.ok(b.some((z) => z.startsWith("Web: a finished one-time job")), b.join("\n"));
});

// ── (d) Addendum: the notification sheet of the job never opens from an empty state ────────────────

/** Deviations: `NotifyChatSheet` writes the WHOLE set -- if it opens with `[:]`, the first toggle deletes the other choices. */
function sheetDeviations(iosText = read(DIALOG_IOS)) {
  const deviations = [];
  const a = call(iosText, "NotifyChatSheet");
  if (!a) return ["ScheduledDetail.swift no longer opens a NotifyChatSheet -- update this test"];
  const choice = /\bchoice: ([^)]*?)\)\s*\{?/.exec(a)?.[1] ?? "";
  if (/\?\?\s*\[:\]/.test(choice) || /\?\?\s*\[:\]/.test(a)) deviations.push(`iOS: the notification sheet opens with a fallback state (${choice.trim()}) -- without the chat in the list the choice would be lost`);
  if (!/if let chatId = job\.chatId, let notifyChoice \{/.test(iosText)) deviations.push("iOS: the sheet does not open only with a loaded choice (notifyChoice)");
  if (!/let fresh: Chat = try await client\.get\("\/api\/chats\//.test(iosText)) deviations.push("iOS: without the chat in the list the sheet does not fetch the choice from the server");
  return deviations;
}

test("(d) iOS: the notification sheet of a job opens with the choice of the chat, never with an empty state", () => {
  const deviations = sheetDeviations();
  assert.deepEqual(deviations, [], deviations.join("\n"));
  // Counter-test built in: the old call (`choice: chat?.notify ?? [:]`) is caught.
  const old = read(DIALOG_IOS).replace("if let chatId = job.chatId, let notifyChoice {", "if let chatId = job.chatId {").replace("choice: notifyChoice)", "choice: chat?.notify ?? [:])");
  assert.ok(sheetDeviations(old).some((z) => z.includes("fallback state")), sheetDeviations(old).join("\n"));
});

// ── (e) No client computes an appointment ─────────────────────────────────────────────────────────

test("(e) no client computes the next appointment itself -- whoever builds that binds the computation to cadence.js", () => {
  // Marks of a weekday or date computation; the display (ScheduledWord, relative) only formats `nextAt` of the server.
  const attributes = [/\bgetU?T?C?Day\(/, /\bsetU?T?C?Date\(/, /\bnextDate\(/, /\.weekday\b/, /\bnextCron/];
  const files = [
    src("lib", "scheduled.ts"), src("lib", "api", "scheduled.ts"),
    ...fs.readdirSync(src("components", "scheduled")).filter((d) => d.endsWith(".tsx")).map((d) => src("components", "scheduled", d)),
    MODELS, ...VIEWS,
  ];
  const findings = files.flatMap((d) => attributes.filter((r) => r.test(read(d))).map((r) => `${path.relative(repo, d)}: ${r}`));
  assert.deepEqual(findings, [], `a client computes an appointment -- this computation belongs bound to scheduled/cadence.js here:\n${findings.join("\n")}`);
  // Counter-test built in: the mark bites.
  assert.ok(attributes.some((r) => r.test("const day = d.getDay();")), "the marks no longer recognize a weekday computation");
});
