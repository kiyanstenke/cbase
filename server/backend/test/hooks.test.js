// The hook register (runs/hooks.js) as a unit - without server, without harness, without fake CLI. What is checked is the
// CONTRACT: order = registration order, double registration and unknown kind/run kind throw, `name` is mandatory, a throwing
// hook does not stop the chain (logged), `wait` per registration serializes or not, and the proof seam observeHooks sees
// every firing - also that of a hook that throws afterwards - and costs the run nothing if it throws itself. Also:
// `detects` is mandatory at registration, `runKindFor(chat)` takes the FIRST matching run kind (order = registration) and
// `null` for an ordinary chat, `runKindDefault(chat)` carries the shape that doRun reads. The hook kinds (eighteen, frozen
// in the order of their moments), the SWITCH (responders with a result: synchronous, the first answer != undefined counts, a
// promise passes through, a synchronous throw too - the caller waits itself; three switch kinds), the observer reports
// `phase: "start"` and for awaited hooks and every switch also `"end"`, and registerEmpty/resetHooks see all three
// registers. The run-kind names "administrator"/"pipeline" below are only example names.
//
// This file imports NO other test file (their tests would otherwise run twice). The user hooks of the channels are something
// else and not checked here.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  HOOK_KINDS,
  SWITCHES_KINDS,
  observeHooks,
  fireHooks,
  resetHooks,
  runKindProvider,
  runKindFor,
  runKindDefault,
  registerEmpty,
  registerHook,
  registerRunKind,
  registerSwitch,
  turnout,
} from "../electron/server/runs/hooks.js";

beforeEach(resetHooks);

// Intercept console.error: the test counts the log lines instead of letting them into the output.
// The REAL console.error is saved ONCE at the module head and ALWAYS reset to it in the finally - not "to the previous
// state": if the runner aborts a test while its hook is still sleeping (unhandledRejection), the next test would otherwise
// start WITH the intercepted console.error, save it as its "previous" and restore it at the end - then every following
// test would be silent exactly when the module is broken.
const REAL_ERROR = console.error;
function withConsole(fn) {
  const rows = [];
  console.error = (...a) => { rows.push(a.map(String).join(" ")); };
  return Promise.resolve()
    .then(() => fn(rows))
    .finally(() => { console.error = REAL_ERROR; });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("HOOK_KINDS: the eighteen kinds in the order of their moments, frozen; SWITCHES_KINDS the three", () => {
  assert.deepEqual([...HOOK_KINDS], [
    "beforeDeliver", // before the run, at the delivery
    "afterRun", "afterRunFailed",
    "turnStart", // the turn is past the gate (do-run.js behind turnBegins)
    "beforeRunBroadcast", "end",
    "turnEnd", // in the place of "end" while background work is open
    "afterLimitCancel",
    "inputDismissed", // a queued entry is discarded (queue.js cancelRunInput)
    "afterCompactResume",
    "beforePermission", "afterPermission", // the approval in the run
    // the restart after boot
    "restartGrace", "restartGraceWorkflows", "restartGraceAbandoned",
    "chatClosed", // every delete path (chats/erase.js -> runs/agents.js closeAgentsOfTheChat)
    "chatRestored", // per chat that comes out of the archive (runs/archive.js reportArchive)
    "serverEnd", // the process end (runs/server-end.js endServer), last
  ]);
  assert.ok(Object.isFrozen(HOOK_KINDS));
  // No "open-work" switch: the workflows are the second source of the ONE query runs/background.js (setBackgroundSource).
  assert.deepEqual([...SWITCHES_KINDS], ["verdict", "followUpRun", "hold"]);
  assert.ok(Object.isFrozen(SWITCHES_KINDS));
  // A switch kind is no hook kind and vice versa - otherwise a registration could land in the wrong register.
  for (const w of SWITCHES_KINDS) assert.ok(!HOOK_KINDS.includes(w), `${w} is a switch, not a hook`);
});

test("order = registration: three hooks run in the order in which they were registered", async () => {
  const log = [];
  registerHook("afterRun", (p) => log.push(`audit:${p.chat}`), { name: "audit" });
  registerHook("afterRun", (p) => log.push(`curate:${p.chat}`), { name: "curate" });
  registerHook("afterRun", (p) => log.push(`title:${p.chat}`), { name: "title" });
  const n = await fireHooks("afterRun", { chat: "c1" });
  assert.equal(n, 3);
  assert.deepEqual(log, ["audit:c1", "curate:c1", "title:c1"]);
  // Another kind stays untouched: nothing registered, nothing called.
  assert.equal(await fireHooks("inputDismissed", {}), 0);
  assert.deepEqual(log, ["audit:c1", "curate:c1", "title:c1"]);
});

const NEVER = () => false;

test("run kind: provider comes back, double registration throws with the name, empty/non-string throws", () => {
  const provider = (chat) => ({ ...runKindDefault(chat), toolset: "manager" });
  registerRunKind("administrator", provider, { detects: NEVER });
  assert.equal(runKindProvider("administrator"), provider);
  assert.throws(() => registerRunKind("administrator", () => ({}), { detects: NEVER }), /"administrator" is already registered/);
  assert.throws(() => registerRunKind("", provider, { detects: NEVER }), /needs a name/);
  assert.throws(() => registerRunKind(undefined, provider, { detects: NEVER }), /needs a name/);
  assert.throws(() => registerRunKind("pipeline", "no-provider", { detects: NEVER }), /must be a function/);
});

test("run kind: unknown name throws - a typo must not silently lose the prompt", () => {
  registerRunKind("pipeline", () => ({}), { detects: NEVER });
  assert.throws(() => runKindProvider("pipelien"), /unknown run kind "pipelien"/);
  assert.throws(() => runKindProvider(""), /unknown run kind/);
});

test("run kind: `detects` is mandatory - without predicate, with a non-function or without options the registration throws", () => {
  assert.throws(() => registerRunKind("probe", () => ({})), /detection must be a function/);
  assert.throws(() => registerRunKind("probe", () => ({}), {}), /detection must be a function/);
  assert.throws(() => registerRunKind("probe", () => ({}), { detects: "chat.kind === 'probe'" }), /detection/);
  // None of it was registered - the name is still free.
  assert.doesNotThrow(() => registerRunKind("probe", () => ({}), { detects: (c) => c.kind === "probe" }));
});

test("runKindFor: the FIRST registered run kind whose detects(chat) is true - order = registration; null for the ordinary chat", () => {
  const administrator = (chat) => ({ ...runKindDefault(chat), toolset: "manager", promptBeforeFocus: "V" });
  const pipeline = (chat) => ({ ...runKindDefault(chat), toolset: "manager", promptBeforeFocus: "P" });
  const manager = (chat) => ({ ...runKindDefault(chat), toolset: "manager", promptBeforeFocus: "M" });
  registerRunKind("administrator", administrator, { detects: (c) => c.kind === "manager" && c.specialRole === "administrator" });
  registerRunKind("pipeline", pipeline, { detects: (c) => c.kind === "manager" && c.specialRole === "pipeline" });
  // Deliberately the WIDE predicate (every manager chat), so that the order visibly decides.
  registerRunKind("manager-agent", manager, { detects: (c) => c.kind === "manager" });
  const v = runKindFor({ kind: "manager", specialRole: "administrator" });
  assert.equal(v.name, "administrator");
  assert.equal(v.provider, administrator);
  assert.equal(runKindFor({ kind: "manager", specialRole: "pipeline" }).name, "pipeline");
  assert.equal(runKindFor({ kind: "manager", specialRole: "" }).name, "manager-agent");
  assert.equal(runKindFor({ kind: "manager", specialRole: "future" }).name, "manager-agent");
  assert.equal(runKindFor({ kind: "normal" }), null, "an ordinary chat has no run kind");
  // The provider delivers the shape of the default with its overrides - what doRun then reads.
  const chat = { id: "c1", kind: "manager", specialRole: "administrator", permissionMode: "" };
  const preparation = v.provider(chat, { cause: "user" });
  assert.equal(preparation.chat, chat);
  assert.equal(preparation.toolset, "manager");
  assert.equal(preparation.promptBeforeFocus, "V");
  assert.deepEqual(Object.keys(preparation), Object.keys(runKindDefault(chat)), "a provider adds no fields and omits none");
});

test("runKindFor: if the wide predicate registers FIRST, it wins - the registration order is the precedence order", () => {
  registerRunKind("manager-agent", () => ({}), { detects: (c) => c.kind === "manager" });
  registerRunKind("administrator", () => ({}), { detects: (c) => c.kind === "manager" && c.specialRole === "administrator" });
  assert.equal(runKindFor({ kind: "manager", specialRole: "administrator" }).name, "manager-agent");
});

test("runKindDefault: the default of an ordinary run - exactly the values with which doRun creates its variables", () => {
  const chat = { id: "c1", kind: "normal", permissionMode: "" };
  const v = runKindDefault(chat);
  assert.deepEqual(v, {
    chat,
    toolset: "",
    promptBeforeFocus: "",
    builtinTools: null,
    permissionMode: "bypassPermissions",
    timeZone: "",
    // Whether a living background agent holds the turn is a question to the run kind; the default is NO - a coding chat
    // does not hold its turn, the agent reports by completion notice; the special run kinds announce "hold" explicitly,
    // graph chats via the switch "hold".
    hold: false,
  });
  // The permission mode of the chat stays if it has one (do-run.js: `chat.permissionMode || "bypassPermissions"`).
  assert.equal(runKindDefault({ id: "c2", permissionMode: "plan" }).permissionMode, "plan");
  // Every call delivers a FRESH object - a provider may write into it without hitting the next run.
  const a = runKindDefault(chat);
  a.toolset = "x";
  assert.equal(runKindDefault(chat).toolset, "");
});

test("unknown hook kind throws - at registerHook AND at fireHooks", async () => {
  assert.throws(() => registerHook("afterRunn", () => {}, { name: "x" }), /unknown hook kind "afterRunn"/);
  await assert.rejects(() => fireHooks("afterRunn", {}), /unknown hook kind "afterRunn"/);
  await assert.rejects(() => fireHooks(undefined, {}), /unknown hook kind/);
});

test("registerHook: name missing => throws; same name twice under the same kind => throws; fn not a function => throws", () => {
  assert.throws(() => registerHook("afterRun", () => {}), /needs a name/);
  assert.throws(() => registerHook("afterRun", () => {}, { name: "" }), /needs a name/);
  assert.throws(() => registerHook("afterRun", () => {}, { name: 42 }), /needs a name/);
  assert.throws(() => registerHook("afterRun", "not-callable", { name: "x" }), /must be a function/);
  registerHook("afterRun", () => {}, { name: "audit" });
  assert.throws(() => registerHook("afterRun", () => {}, { name: "audit" }), /"audit" is already registered/);
  // The same name under ANOTHER kind is allowed - the name is unique per kind.
  assert.doesNotThrow(() => registerHook("inputDismissed", () => {}, { name: "audit" }));
});

test("a throwing hook does not stop the chain: the third runs, console.error exactly once", async () => {
  await withConsole(async (rows) => {
    const log = [];
    registerHook("afterRun", () => log.push("one"), { name: "one" });
    registerHook("afterRun", () => { throw new Error("broken"); }, { name: "two" });
    registerHook("afterRun", () => log.push("three"), { name: "three" });
    const n = await fireHooks("afterRun", {});
    assert.equal(n, 3);
    assert.deepEqual(log, ["one", "three"]);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^\[hooks\] afterRun\/two: broken$/);
  });
});

test("rejected promise with wait:false is logged, fireHooks does not throw", async () => {
  await withConsole(async (rows) => {
    const log = [];
    registerHook("afterLimitCancel", async () => { await sleep(5); throw new Error("broken later"); }, { name: "later" });
    registerHook("afterLimitCancel", () => log.push("afterwards"), { name: "afterwards" });
    const n = await fireHooks("afterLimitCancel", {});
    assert.equal(n, 2);
    assert.deepEqual(log, ["afterwards"]);
    // The rejection arrives AFTER fireHooks (not awaited) - wait briefly, then the line is there.
    assert.equal(rows.length, 0);
    await sleep(20);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^\[hooks\] afterLimitCancel\/later: broken later$/);
  });
});

test("rejected promise with wait:true is likewise only logged, the chain goes on", async () => {
  await withConsole(async (rows) => {
    const log = [];
    registerHook("inputDismissed", async () => { throw new Error("awaited broken"); }, { name: "a", wait: true });
    registerHook("inputDismissed", () => log.push("b"), { name: "b" });
    assert.equal(await fireHooks("inputDismissed", {}), 2);
    assert.deepEqual(log, ["b"]);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^\[hooks\] inputDismissed\/a: awaited broken$/);
  });
});

test("wait:true serializes - the second hook sees the result of the first only after it resolves", async () => {
  let result = null;
  let seen = "indeterminate";
  registerHook("afterRun", async () => { await sleep(20); result = "finished"; }, { name: "slow", wait: true });
  registerHook("afterRun", () => { seen = result; }, { name: "reader" });
  const t0 = Date.now();
  await fireHooks("afterRun", {});
  assert.equal(seen, "finished");
  assert.ok(Date.now() - t0 >= 15, "fireHooks must have awaited the 20 ms of the first hook");
});

test("wait:false does NOT serialize - the second runs before the first is resolved", async () => {
  let result = null;
  let seen = "indeterminate";
  let resolved;
  const finished = new Promise((r) => { resolved = r; });
  registerHook("afterRun", async () => { await sleep(20); result = "finished"; resolved(); }, { name: "slow" });
  registerHook("afterRun", () => { seen = result; }, { name: "reader" });
  await fireHooks("afterRun", {});
  // The proof is logical, not the clock: the reader saw `null`, so it ran BEFORE the slow hook (20 ms timer) was resolved -
  // a time bound "< n ms" would be shaky under the load of the test bench.
  assert.equal(seen, null, "the reader ran before the slow hook was done");
  assert.equal(result, null, "fireHooks returned before the slow hook was done");
  await finished;
  assert.equal(result, "finished");
});

test("observeHooks sees every firing with {kind,name,index,wait,phase} in order - also that of the throwing hook; an awaited hook also reports its end", async () => {
  await withConsole(async (rows) => {
    const trace = [];
    observeHooks((info, payload) => trace.push({ ...info, chat: payload?.chat?.id }));
    registerHook("afterRun", () => {}, { name: "audit" });
    registerHook("afterRun", () => { throw new Error("x"); }, { name: "curate", wait: true });
    registerHook("afterRun", () => {}, { name: "title" });
    await fireHooks("afterRun", { chat: { id: "c1" } });
    assert.deepEqual(trace, [
      { kind: "afterRun", name: "audit", index: 0, wait: false, phase: "start", chat: "c1" },
      { kind: "afterRun", name: "curate", index: 1, wait: true, phase: "start", chat: "c1" },
      // "end" only for the AWAITED hook - and also when it throws (finally): the golden file hooks.jsonl thus shows WHEN a
      // waiting consumer was done, a fire-and-forget hook has no end.
      { kind: "afterRun", name: "curate", index: 1, wait: true, phase: "end", chat: "c1" },
      { kind: "afterRun", name: "title", index: 2, wait: false, phase: "start", chat: "c1" },
    ]);
    assert.equal(rows.length, 1);
    // observeHooks(null) ends that: a further firing no longer reaches the trace.
    observeHooks(null);
    await fireHooks("afterRun", {});
    assert.equal(trace.length, 4);
  });
});

test("observeHooks: the awaited hook reports \"end\" only AFTER its resolution, the next start comes behind it", async () => {
  const trace = [];
  observeHooks((info) => trace.push(`${info.name}:${info.phase}`));
  registerHook("afterRun", async () => { await sleep(15); trace.push("slow:done"); }, { name: "slow", wait: true });
  registerHook("afterRun", () => trace.push("reader:runs"), { name: "reader" });
  await fireHooks("afterRun", {});
  assert.deepEqual(trace, ["slow:start", "slow:done", "slow:end", "reader:start", "reader:runs"]);
});

test("a throwing observer costs nothing: the hook runs anyway, the throw is logged", async () => {
  await withConsole(async (rows) => {
    let run = 0;
    observeHooks(() => { throw new Error("observer broken"); });
    registerHook("beforePermission", () => { run++; }, { name: "approval" });
    assert.equal(await fireHooks("beforePermission", {}), 1);
    assert.equal(run, 1);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^\[hooks\] observer: observer broken$/);
  });
});

test("resetHooks clears run kinds, hooks, switches and observers", async () => {
  const trace = [];
  observeHooks((i) => trace.push(i));
  registerRunKind("pipeline", () => ({}), { detects: (c) => c.specialRole === "pipeline" });
  registerHook("afterRun", () => {}, { name: "audit" });
  registerSwitch("followUpRun", () => true, { name: "workflow-response" });
  resetHooks();
  assert.throws(() => runKindProvider("pipeline"), /unknown run kind/);
  assert.equal(runKindFor({ kind: "manager", specialRole: "pipeline" }), null, "after the reset nobody detects anything");
  assert.equal(await fireHooks("afterRun", {}), 0);
  assert.equal(turnout("followUpRun", {}), undefined, "after the reset no switch answers any more");
  registerHook("afterRun", () => {}, { name: "audit" }); // free again after the reset
  await fireHooks("afterRun", {});
  assert.deepEqual(trace, []);
});

test("registerEmpty: the guard of the registration list reads the REGISTER - true before any registration, false after a run kind OR a hook, true again after the reset", async () => {
  assert.equal(registerEmpty(), true, "fresh: nothing registered");
  registerRunKind("administrator", () => ({}), { detects: (c) => c.specialRole === "administrator" });
  assert.equal(registerEmpty(), false, "a run kind suffices");
  resetHooks();
  assert.equal(registerEmpty(), true, "empty again after the reset");
  registerHook("inputDismissed", () => {}, { name: "channel" });
  assert.equal(registerEmpty(), false, "a hook alone suffices too - the guard sees both registers");
  resetHooks();
  assert.equal(registerEmpty(), true);
  registerSwitch("verdict", () => undefined, { name: "workflow" });
  assert.equal(registerEmpty(), false, "a switch alone suffices too - the guard sees all three registers");
  resetHooks();
  assert.equal(registerEmpty(), true);
  // The reason for the derivation: the list in server.js may run AGAIN after a reset - with a mark of its own it would stay
  // mute and an administrator chat would run as an ordinary one (runKindFor => null).
  const logIn = () => { if (registerEmpty()) registerRunKind("administrator", () => ({ x: 1 }), { detects: (c) => c.specialRole === "administrator" }); };
  logIn(); logIn(); // twice in a row: no throw, the second round skips
  assert.equal(runKindFor({ specialRole: "administrator" })?.name, "administrator");
  resetHooks();
  assert.equal(runKindFor({ specialRole: "administrator" }), null);
  logIn(); // after the reset the list registers again
  assert.equal(runKindFor({ specialRole: "administrator" })?.name, "administrator");
});

// ── Switches: responders WITH a result ─────────────────────────────────────────────────────────────
test("switch: the FIRST answer != undefined counts, the responders after it no longer run - order = registration", () => {
  const log = [];
  registerSwitch("followUpRun", (p) => { log.push("a"); return undefined; }, { name: "a" });
  registerSwitch("followUpRun", (p) => { log.push("b"); return p.response; }, { name: "b" });
  registerSwitch("followUpRun", (p) => { log.push("c"); return "never"; }, { name: "c" });
  assert.equal(turnout("followUpRun", { response: true }), true);
  assert.deepEqual(log, ["a", "b"], "c was not reached any more");
  log.length = 0;
  // `false` is an answer (the verdict switch says "discarded" with it) - only `undefined` means "not responsible".
  assert.equal(turnout("followUpRun", { response: false }), false);
  assert.deepEqual(log, ["a", "b"]);
});

test("switch: no responder or all not responsible => undefined; the caller then does its usual thing", () => {
  assert.equal(turnout("verdict", { at: "goal" }), undefined, "empty register");
  registerSwitch("verdict", () => undefined, { name: "workflow" });
  assert.equal(turnout("verdict", { at: "goal" }), undefined, "a responder that feels not responsible");
});

test("switch: a promise passes THROUGH as an answer - returned synchronously, the caller awaits it itself (resumeJudge)", async () => {
  let resolved = false;
  registerSwitch("verdict", () => sleep(10).then(() => { resolved = true; return "verdict"; }), { name: "workflow" });
  const response = turnout("verdict", { at: "workflow" });
  assert.ok(response && typeof response.then === "function", "the switch delivers the promise, no result");
  assert.equal(resolved, false, "the switch did NOT wait - it is synchronous");
  assert.equal(await response, "verdict");
  assert.equal(resolved, true);
});

test("switch: a synchronous throw in the responder goes to the caller - unlike hooks nothing is swallowed", () => {
  // Reason: a switch DECIDES (start the turn or not); a swallowed throw would mean "not responsible" and the caller would
  // silently start the turn that the responder just wanted to take over.
  registerSwitch("followUpRun", () => { throw new Error("broken"); }, { name: "a" });
  assert.throws(() => turnout("followUpRun", {}), /broken/);
});

test("switch: the observer sees start and end per responder with `takenOver`", () => {
  const trace = [];
  observeHooks((info, payload) => trace.push({ ...info, chat: payload?.chat?.id }));
  registerSwitch("followUpRun", () => undefined, { name: "a" });
  registerSwitch("followUpRun", () => true, { name: "b" });
  registerSwitch("followUpRun", () => true, { name: "c" });
  assert.equal(turnout("followUpRun", { chat: { id: "c1" } }), true);
  assert.deepEqual(trace, [
    { kind: "followUpRun", name: "a", index: 0, phase: "start", chat: "c1" },
    { kind: "followUpRun", name: "a", index: 0, phase: "end", takenOver: false, chat: "c1" },
    { kind: "followUpRun", name: "b", index: 1, phase: "start", chat: "c1" },
    { kind: "followUpRun", name: "b", index: 1, phase: "end", takenOver: true, chat: "c1" },
  ]);
});

test("switch: unknown kind throws (registerSwitch AND turnout), a hook kind is no switch kind, double name throws, name mandatory, fn a function", () => {
  assert.throws(() => registerSwitch("afterRun", () => true, { name: "x" }), /unknown switch kind "afterRun"/);
  assert.throws(() => turnout("afterRun", {}), /unknown switch kind "afterRun"/);
  assert.throws(() => registerHook("verdict", () => {}, { name: "x" }), /unknown hook kind "verdict"/);
  assert.throws(() => registerSwitch("verdict", () => true, {}), /name/);
  assert.throws(() => registerSwitch("verdict", "not a function", { name: "x" }), /must be a function/);
  registerSwitch("verdict", () => true, { name: "workflow" });
  assert.throws(() => registerSwitch("verdict", () => true, { name: "workflow" }), /workflow/);
});

test("the chain runs over a copy: a registration IN THE MIDDLE of the chain does not shift the running sequence", async () => {
  // Without the copy `[...list]` the array iterator would see the appended element (measured: expected 2, actual 3).
  const log = [];
  registerHook("afterRun", () => {
    log.push("one");
    // Registers DURING the firing - in the running chain it must not be reached any more.
    registerHook("afterRun", () => log.push("late"), { name: "late" });
  }, { name: "one" });
  registerHook("afterRun", () => log.push("two"), { name: "two" });
  assert.equal(await fireHooks("afterRun", {}), 2, "the running chain counts only the two that were registered at its start");
  assert.deepEqual(log, ["one", "two"]);
  // The NEXT firing sees it - at the back, in registration order (rebuild the register, because "one" would otherwise register
  // "late" a second time and the duplicate throws).
  resetHooks();
  log.length = 0;
  registerHook("afterRun", () => log.push("one"), { name: "one" });
  registerHook("afterRun", () => log.push("two"), { name: "two" });
  registerHook("afterRun", () => log.push("late"), { name: "late" });
  assert.equal(await fireHooks("afterRun", {}), 3);
  assert.deepEqual(log, ["one", "two", "late"]);
});

// Stays the LAST test of the file (node:test runs in file order): after all interceptions console.error is the original
// again - the promise of withConsole, measured instead of claimed.
test("zzz end: console.error is the original again", () => {
  assert.equal(console.error, REAL_ERROR, "console.error was not reset to the original");
});
