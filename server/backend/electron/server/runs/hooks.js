// The run's hook register: three named connections through which `runs/` talks to the domain side WITHOUT importing
// it — run kind providers (registerRunKind, runKindFor, runKindProvider, runKindDefault), event hooks (registerHook,
// fireHooks) and switches (registerSwitch, turnout) — plus the guard of the registration list (registerEmpty), the
// proof seam observeHooks, resetHooks for tests and the counter openHooks (quiet computation).
//
// This module is a LEAF: not a single import — none from a domain (workflows/, projects/, channels/, …), none from
// the root modules and none from server.js. That is why it exists: if `runs/` (the hub of the run) imported names of
// the domain side, every domain would drag the hub behind it on load and the hub all domains. Here the direction
// turns: the domain side registers, `runs/` only asks.
//
// Why THREE connections: `runs/` talks to the domain side in three forms. BEFORE the turn doRun asks per run kind
// what this run needs — system prompt, toolset, model, MCP servers: ONE call, `runKindFor(chat)` finds the
// registered run kind, its provider supplies the preparation (form below, `runKindDefault`). AFTER the turn (and
// after a question, at a discarded wait row, after a caught-up compaction, before and after an approval, at the
// delivery of a message, at the restart grace after a restart) the domain side wants to learn what happened; those
// are the HOOKS. And at some places `runs/` needs an ANSWER from the domain side: does a waiting workflow take the
// queued message instead of a turn of its own (startFollowUpRun), where does a parked workflow verdict re-enter
// (resumeJudge); those are the SWITCHES. A provider ANSWERS (one run kind, one result), a hook LISTENS (many per
// kind, no result), a switch ASKS IN TURN (many per kind, the first responsible one answers, the chain stops) —
// three contracts, three names; a shared connection would have to tell them apart with flags, and a missing provider
// must throw while a missing hook is only silence and a switch without a responder returns `undefined` (the caller
// then goes its own way).
//
// Why the registration list is ONE place in server.js and no module registers itself on load: the order of the
// completion hooks is a promise, not a coincidence — curating (the project curator, projects/context.js), auto
// title, workflow gate, target gate, scheduled end (scheduled/run.js), event "end" (channel delivery, outer loop),
// follow-up run. It is taken over from the code order in do-run.js, not justified; whether one stage depends on
// another is not measured — the golden runs (hooks.jsonl) hold it. It does NOT run as one firing: curating, auto
// title and workflow gate only after `run_done` of a clean turn, the scheduled end in the finally before the
// broadcast, "end" after that and only without follow-up run and workflow, the target gate (internal to runs) after
// "end" and after the compaction. Compaction, "end" and target gate only run once no background work is open
// (runs/background.js); if some is still open, only "turnEnd" fires in the place of "end" (the channel delivery to
// the chat). So there is a hook kind of its own per point in time (HOOK_KINDS, below), and the registration order
// holds WITHIN a kind; which kind fires when is said by the comment at the list in server.js. If every module
// registered itself on load, the order would be the import order — a property of the import graph nobody reads and
// that a new import elsewhere would silently shift; and a module that a test loads without server.js would hang
// mutely in the register. So the list stands at ONE place, next to `setStartGate(…)`, commented, readable top to
// bottom, without priority numbers: order = registration.
//
// Why kind names at call sites AND registrations must be string literals: the tree guard
// (tools/check/lib/tree-rules.mjs) reads them STATICALLY — every `fireHooks("<kind>", …)` and
// `turnout("<kind>", …)` call in `runs/` needs a registrant in server.js and every registrant a call. A variable or
// a composed string would be invisible to the guard, and exactly the typo it is meant to catch would slip through.
// `HOOK_KINDS` and `SWITCHES_KINDS` are frozen so that the set of kinds stands here and grows nowhere else. For the
// RUN KINDS no name stands in `runs/`: doRun asks `runKindFor(chat)`, not `runKindProvider("<name>")` — the names
// stand only at the registration (as literals, for the guard); `runKindProvider` stays for tests and the guard.
//
// Why detection stands at the REGISTRATION: `runs/` does not know what a special chat is — that is domain knowledge
// (columns of the chat row). So every registration brings its predicate `detects(chat)`; `runKindFor(chat)` returns
// the FIRST registered run kind whose predicate is true. The registration order in server.js is the precedence
// order. The same rule holds for the hooks: the condition under which a subscriber is responsible stands IN the
// subscriber. Exception: a condition that ALSO controls something in `runs/` (whether the workflow gate is due also
// decides on the target gate) stays in doRun and travels as a field in the payload — otherwise the subscriber would
// read the state a second time after a predecessor changed it.
//
// The FORM of the preparation: it carries doRun's variables under their names so that doRun reads them unchanged,
// see `runKindDefault(chat)` below. A provider is SYNCHRONOUS (an `await` here would shift the timing against the
// stream) and is called with `(chat, ctx)`, `ctx = { cause }`.
//
// Why `wait` stands per registration: the followers behave differently, and the register unifies nothing. NONE of
// today's sites waits — so every registration has `wait: false` (the default), the synchronous ones too:
// `wait: true` would mean `await undefined`, i.e. a microtask between two hooks that does not exist today. The
// re-entries of parked verdicts are NOT hooks but the switch "verdict": a result is read there, and the caller
// awaits the returned promise itself (see below). `wait: true` stays in the contract (and in the test) for
// subscribers that must be awaited some day.
//
// Errors: a hook must cost the observed run nothing — every hook has its own try/catch. A synchronous throw and a
// rejection are logged with `[hooks] <kind>/<name>:`, the chain goes on — and where a site had its own error
// handling, the SUBSCRIBER carries it on; the frame here is the second net. A SWITCH does NOT catch: it answers in
// the caller's place, and the caller's error handling applies. A MISSING provider throws: a typo in the run kind
// must not silently lose the system prompt — the caller only asks for special run kinds, an ordinary chat does not
// pass here.
//
// The SWITCH: `registerSwitch(kind, fn, { name })`, `turnout(kind, payload)` calls the responders in registration
// order and returns the FIRST result `!== undefined` — the chain stops there; nobody responsible ⇒ `undefined`. It
// is SYNCHRONOUS: the responder decides synchronously whether it is responsible and returns its result or a promise
// for its work. Whoever needs the result awaits the promise itself (resumeJudge); whoever does not lets it run
// (startFollowUpRun stays fire-and-forget). An `await` in the switch itself would put a microtask before `doRun`
// there. Kinds (SWITCHES_KINDS):
//   "verdict"       payload `{ at, chatId, chat, payload, overruled }`; answer `false` = the situation no longer
//                   fits, a promise = taken over — the caller waits and reports true; `at === "goal"` stays in
//                   runs/, see resumeJudge.
//   "followUpRun"   payload `{ chat, next }`; answer `true` = a waiting workflow took the queued message.
//   "hold"          do-run.js, at the preparation: does the domain side hold this turn open while its background
//                   work lives, EVEN IF the run kind says "do not hold"? payload `{ chat }` → `true` = hold (a graph
//                   workflow is open in this chat: its step is only finished when the reports of its agents are
//                   processed in the SAME turn — only then do completion check, review and the next node run, and
//                   the follow-up turn does not count as a visit). Nobody responsible ⇒ the run kind's answer
//                   applies. Asked only where the run kind does NOT hold (the ordinary coding chat), once per run
//                   and before the prompt is built — the driver sets "running" before it calls doRun. A responder
//                   that is not responsible answers `undefined`, not `false`: otherwise the chain would stop before
//                   the next one (dynamic workflows).
//   A responder reads live, at the same point in time as the function it replaces — not a field of the preparation,
//   because what it rules on can change DURING a turn.
//
// observeHooks(fn) is the test and proof seam (like setStartGate): `fn(info, payload)` is called BEFORE every hook
// call (`info = { kind, name, index, wait, phase: "start" }`), even if the hook then throws, and for an AWAITED
// hook (`wait: true`) once more AFTER the await with `phase: "end"` (for `wait: false` only "start" — the register
// does not see its end). For a switch: "start" before every asked responder, "end" with `takenOver: true|false`
// after its (synchronous) answer. `payload` goes along so the observer can name the chat without this module
// knowing the form of the payloads. Purpose: the golden harness (server/backend/test/golden-harness.mjs) records the
// hook sequence per scenario as hooks.jsonl — so the order is provable, not just claimed. A throwing observer is
// logged and costs the run nothing. resetHooks() empties all three registers and the observer — ONLY for tests; the
// server never resets.

// The hook kinds in the order in which a run reaches them (see header and the comment at the registration list in
// server.js); the permission kinds fire DURING the turn, the restart kinds from the 2.5 s timer after boot
// (server.js → runs/resume.js).
//   beforeDeliver       a message is handed to the chat (runs/queue.js deliverUserPrompt) — BEFORE the decision
//                       whether it is queued, injected or started as a run, for EVERY cause. payload { chat, cause }
//   afterRun            the turn ended cleanly (code 0), after `run_done`. payload { chat, text, resultText,
//                       runStart, approval, parkedAfterOk, workflowRunning }
//   afterRunFailed      the turn was aborted (aborted, code 0) or failed with exit ≠ 0 without the limit having
//                       parked it. payload { chat, code, aborted }
//   turnStart           a turn is past the gate, its inputs are fixed (do-run.js after turnBegins; on a resume retry
//                       a second time for the same turn). Subscriber: the real beginning of a scheduled run
//                       (scheduled/run.js). payload { chat, cause, inputs }
//   beforeRunBroadcast  in the finally: all marks of the run are cleared, result or error are fixed, the clients do
//                       not know yet. payload { chat, error, resultText, parked, cause, aborted, inputs } — the
//                       scheduled run ends only for cause "schedule", an aborted one is not repeated, and the mark
//                       `scheduledRun` in the inputs assigns the end to its run; at all four firing sites
//                       (do-run.js, and in limit-gate.js stop in the gate, project lock and a throw in the gate)
//   end                 the event "end": a real end state — no follow-up run, no running or waiting workflow — or
//                       an abandoned resumption (runs/resume.js). payload { chat, ...event payload }
//   turnEnd             fires in the place of "end" while background work of the chat is still open (see header).
//   afterLimitCancel    a chat's wait row is discarded (auto-continue.js cancelAutoContinue: user, toggle, attempt
//                       cap, situation), the chat is not running. payload { chat, row, note, kind, reason } — `kind`
//                       (who discards: "cancel" the human, otherwise the machine) and `reason` (the wording)
//   inputDismissed      the human discarded a queued entry — ONLY runs/queue.js cancelRunInput.
//                       payload { chatId, entry }
//   afterCompactResume  a parked compaction was caught up and not limited again (auto-continue.js
//                       fireAutoContinueInner). payload { chat, row }
//   beforePermission    a permission request stands (runs/permissions.js requestPermission): the entry in
//                       pendingPermissions is set, the clients do not know yet (BEFORE the SSE event). For EVERY
//                       request — runs/ writes the coding card itself.
//                       payload { chat, chatId, requestId, toolName, input, approval, at }
//   afterPermission     a permission is decided (resolvePermission: user, stop; clearChatPermissions: end of run) —
//                       BEFORE the waiting call is resolved (`p.resolve`), so the ruling row is in the history
//                       before the run goes on. payload { chatId, request, decision, origin, reason }
//   restartGrace        the server has restarted, the wait rows are scheduled again, STILL BEFORE the selection of
//                       the interrupted runs (runs/resume.js) — what starts a turn here counts as "already running"
//                       there. payload {}
//   restartGraceWorkflows  the interrupted runs are fixed (at least one, or a workflow): the workflow side catches
//                       up locks and drives its runs interrupted between two steps — BEFORE the chat runs are
//                       resumed. payload { flows }
//   restartGraceAbandoned  a run is not taken up again after MAX_RESUME_ATTEMPTS — BEFORE the broadcast and before
//                       "end" (a running workflow run of this chat is closed; an occurrence ends too).
//                       payload { chat, attempts, cause }
//   chatClosed          a chat falls — EVERY delete path (chat, folder, workspace, fork rollback) goes through
//                       chats/erase.js → runs/agents.js closeAgentsOfTheChat and fires there, BEFORE the chat's
//                       cores: the domain side closes what belongs to it in this chat (dynamic workflows).
//                       payload { chatId }
//   chatRestored        a chat comes out of the archive — PER AFFECTED CHAT, fired in runs/archive.js reportArchive
//                       (PUT routes and fetchBack), AFTER the write. The domain side delivers what it held back for
//                       the archive (channel buffer). payload { chatId }
//   serverEnd           the process is to end (SIGTERM/SIGINT at server/backend/headless.js): runs/server-end.js
//                       endServer fires it ONCE and waits — with a product cap —, BEFORE the connections close and
//                       server.close triggers the server-end subscribers. Fired ONLY there, never in the `close`
//                       event: the golden scenarios and every test that closes a server get no new line. payload {}
export const HOOK_KINDS = Object.freeze(["beforeDeliver", "afterRun", "afterRunFailed", "turnStart", "beforeRunBroadcast", "end", "turnEnd", "afterLimitCancel", "inputDismissed", "afterCompactResume", "beforePermission", "afterPermission", "restartGrace", "restartGraceWorkflows", "restartGraceAbandoned", "chatClosed", "chatRestored", "serverEnd"]);
export const SWITCHES_KINDS = Object.freeze(["verdict", "followUpRun", "hold"]);

// The registers themselves. All three are MUTATED, never rebound (the same rule as for the maps in state.js):
// resetHooks empties them in place.
const runKinds = new Map(); // name → { provider(chat, ctx) → preparation, detects(chat) → boolean } in registration order
const hooks = new Map(HOOK_KINDS.map((kind) => [kind, []])); // kind → [{ name, fn, wait }] in registration order
const switches = new Map(SWITCHES_KINDS.map((kind) => [kind, []])); // kind → [{ name, fn }] in registration order
let observer = null;
// Promises of hooks that are not awaited and still running (quiet computation, runs/routes.js): curator and auto
// title hang as `wait: false` behind the end of the run — `running` is empty by then, their work is not. Only what
// the hook RETURNS is counted; a hook that starts a promise and keeps it to itself counts via that work's own
// entries (verdicts, oneshots). Bookkeeping only: the chain still does not wait.
let hooksOpen = 0;
export const openHooks = () => hooksOpen;

const nameOk =(name) => typeof name === "string" && name.trim().length > 0;

function log(kind, name, e) {
  console.error(`[hooks] ${kind}/${name}:`, e?.message || e);
}

// ── Run kind providers ───────────────────────────────────────────────────────
// The default of an ORDINARY run (coding chat). A provider overrides what its run kind does differently
// (`{ ...runKindDefault(chat), … }`); doRun then reads ONE path, special run kind or not. The fields, in doRun order:
//   chat                  the chat row — a provider may return a NEW row (doRun reassigns `chat`)
//   toolset               named toolset of the MCP server ("" = the full one)
//   promptBeforeFocus     prompt addition BEFORE the project focus
//   builtinTools          builtin tools: null = full set, [] = none, list = exactly these
//   permissionMode        the run's permission mode
//   timeZone              time zone of the MCP server ("" = none); a job chat takes the zone of its job (do-run.js)
//   hold                  true ⇒ a living background agent holds the turn open until it is finished and its report
//                         is delivered. A question to the run kind, not a special query in the core. false (THE
//                         DEFAULT, the coding chat) ⇒ the turn ends without its agents, they keep running at their
//                         owner (runs/agents.js) and report as a completion notice via the wake path. Exception:
//                         the switch "hold" answers true — an open graph workflow always holds.
export function runKindDefault(chat) {
  return {
    chat,
    toolset: "",
    promptBeforeFocus: "",
    builtinTools: null,
    permissionMode: chat.permissionMode || "bypassPermissions",
    timeZone: "",
    hold: false,
  };
}

// One provider per run kind: `(chat, ctx) => preparation` (form: runKindDefault), plus the predicate
// `detects(chat)` — mandatory, because without it nobody could determine a chat's run kind except `runs/` itself,
// and that is exactly what it must not do (see header). Double registration throws — two providers for one run
// kind would mean that one silently wins.
export function registerRunKind(name, provider, { detects } = {}) {
  if (!nameOk(name)) throw new Error("registerRunKind: a run kind needs a name (non-empty string)");
  if (typeof provider !== "function") throw new Error(`registerRunKind("${name}"): provider must be a function`);
  if (typeof detects !== "function") throw new Error(`registerRunKind("${name}"): detection must be a function ({ detects })`);
  if (runKinds.has(name)) throw new Error(`registerRunKind: run kind "${name}" is already registered`);
  runKinds.set(name, { provider, detects });
}

// A chat's run kind: the FIRST registered one whose `detects(chat)` is true, as `{ name, provider }` — `null` means
// ordinary run (doRun then takes runKindDefault). A throwing predicate throws through: it is a programming error of
// the registration, not a runtime case.
export function runKindFor(chat) {
  for (const [name, { provider, detects }] of runKinds) {
    if (detects(chat)) return { name, provider };
  }
  return null;
}

// Returns the provider for a name. Unknown name ⇒ throw (see header: a typo must not silently lose the prompt).
// doRun does not call it (runKindFor); tests and the tree guard do.
export function runKindProvider(name) {
  const entry = runKinds.get(name);
  if (!entry) throw new Error(`runKindProvider: unknown run kind "${name}" — no provider registered (registration list in server.js)`);
  return entry.provider;
}

// ── Event hooks ──────────────────────────────────────────────────────────────
// `name` is mandatory: it appears in the log, in the observer's trace and in the tree guard. The same name twice
// under the same kind throws — otherwise a follower registered twice could not be told from two different ones in
// the trace.
export function registerHook(kind, fn, { name, wait = false } = {}) {
  const list = hooks.get(kind);
  if (!list) throw new Error(`registerHook: unknown hook kind "${kind}" (allowed: ${HOOK_KINDS.join(", ")})`);
  if (typeof fn !== "function") throw new Error(`registerHook(${kind}): hook must be a function`);
  if (!nameOk(name)) throw new Error(`registerHook(${kind}): hook needs a name ({ name })`);
  if (list.some((h) => h.name === name)) throw new Error(`registerHook(${kind}): hook "${name}" is already registered`);
  list.push({ name, fn, wait: wait === true });
}

// Calls the hooks of a kind SERIALLY in registration order. Own try/catch per hook: a throw is logged and does not
// stop the chain. `wait: false` (default) means fire-and-forget — a returned promise is NOT awaited, its rejection
// only logged; `wait: true` means: the promise is awaited before the next hook is up. Returns the number of called
// hooks (for tests). The list is copied so that a registration IN THE MIDDLE of the chain (only conceivable in
// tests) does not shift the running sequence. If all hooks of a kind are `wait: false`, the whole chain runs
// SYNCHRONOUSLY within the call (no await is reached) — the call sites in `runs/` rely on that and do not await the
// call.
export async function fireHooks(kind, payload) {
  const list = hooks.get(kind);
  if (!list) throw new Error(`fireHooks: unknown hook kind "${kind}" (allowed: ${HOOK_KINDS.join(", ")})`);
  let n = 0;
  for (const [index, h] of [...list].entries()) {
    n++;
    report({ kind, name: h.name, index, wait: h.wait, phase: "start" }, payload);
    try {
      const r = h.fn(payload);
      if (h.wait) await r;
      else if (r && typeof r.then === "function") {
        hooksOpen += 1;
        r.catch((e) => log(kind, h.name, e)).finally(() => { hooksOpen -= 1; });
      }
    } catch (e) {
      log(kind, h.name, e);
    } finally {
      if (h.wait) report({ kind, name: h.name, index, wait: true, phase: "end" }, payload);
    }
  }
  return n;
}

// ── Switches ─────────────────────────────────────────────────────────────────
// The same rules as for the hooks: name mandatory, unique per kind, unknown kind throws.
export function registerSwitch(kind, fn, { name } = {}) {
  const list = switches.get(kind);
  if (!list) throw new Error(`registerSwitch: unknown switch kind "${kind}" (allowed: ${SWITCHES_KINDS.join(", ")})`);
  if (typeof fn !== "function") throw new Error(`registerSwitch(${kind}): responder must be a function`);
  if (!nameOk(name)) throw new Error(`registerSwitch(${kind}): responder needs a name ({ name })`);
  if (list.some((w) => w.name === name)) throw new Error(`registerSwitch(${kind}): responder "${name}" is already registered`);
  list.push({ name, fn });
}

// Asks the responders of a kind in registration order and returns the FIRST result `!== undefined`; the chain stops
// there. Nobody responsible ⇒ `undefined`. SYNCHRONOUS and without a net of its own (see header): a responder's
// throw goes to the caller, like the throw of the function it replaces.
export function turnout(kind, payload) {
  const list = switches.get(kind);
  if (!list) throw new Error(`turnout: unknown switch kind "${kind}" (allowed: ${SWITCHES_KINDS.join(", ")})`);
  for (const [index, w] of [...list].entries()) {
    report({ kind, name: w.name, index, phase: "start" }, payload);
    const r = w.fn(payload);
    report({ kind, name: w.name, index, phase: "end", takenOver: r !== undefined }, payload);
    if (r !== undefined) return r;
  }
  return undefined;
}

// ── Proof seam and reset (tests) ─────────────────────────────────────────────
function report(info, payload) {
  if (!observer) return;
  try { observer(info, payload); }
  catch (e) { console.error("[hooks] observer:", e?.message || e); }
}

// `fn(info, payload)` before every hook call (and after an awaited one), before and after every asked responder of
// a switch — form of `info` see header; `observeHooks(null)` removes it.
export function observeHooks(fn) {
  observer = typeof fn === "function" ? fn : null;
}

// Whether NOTHING is registered yet — no run kind, no hook, no switch. The guard of the registration list in
// server.js: it runs while the register is empty, i.e. once per process (the test harnesses start the server many
// times in the same process, and a second registration throws). Derived from the register instead of a flag in
// server.js so that the guard cannot deviate from the register: after resetHooks() the next startServer registers
// again instead of keeping an empty set with a set flag (then a special chat would silently run as an ordinary
// one). All THREE registers count: if the guard saw only two, a second startServer after a reset would register
// the third twice (or not at all).
export function registerEmpty() {
  if (runKinds.size > 0) return false;
  for (const list of hooks.values()) if (list.length > 0) return false;
  for (const list of switches.values()) if (list.length > 0) return false;
  return true;
}

// Tests only: empties all three registers and the observer (beforeEach in hooks.test.js).
export function resetHooks() {
  runKinds.clear();
  for (const list of hooks.values()) list.length = 0;
  for (const list of switches.values()) list.length = 0;
  observer = null;
}
