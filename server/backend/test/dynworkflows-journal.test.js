// "1:1 on resume" proven, not claimed: the key chain of dynworkflows/journal.js against a REAL Claude Code journal. The fixture
// (fixtures/dynworkflows-journal/<pin>/) was written by the binary of the pinned version itself: a harmless workflow with
// fixture prompts (script.js), run against an API mock (generate.mjs, path and answers in the stamp). Never an anonymised
// foreign journal: every replacement would change the hashes and the proof would become circular.
//
// The journal of the original carries per agent only key, agentId, label, phase and result, not prompt and options. Those come
// from the script: it runs here through the SAME sandbox as in the server (sandbox.js), the answers from the journal; the test
// computes every key at the moment the sandbox reports the call (on the lane it hands along) and holds it against that of the
// original. This also proves that the sandbox forks, joins and calls like Claude Code (otherwise nothing would match from the
// first difference on). Model in the key: against the fixture the calculation of the original applies (`chainOptions`, values as
// in the script); the additive resolution to `provider::model` (`normOptions`) is a step of its own before it and left out here.
//
// TWO FIXTURES, TWO CHAIN KINDS (journal.js head):
//   - the pin's ("branches" since 2.1.322): the script really enters the branch calculation: a branch with TWO agents in a row,
//     an agent AFTER the parallel() (hangs on the join), a nested parallel() with one agent behind the inner join, a pipeline()
//     with two stages, a parallel() that is NOT awaited with an agent() next to it (fork synchronous, join on the moved state),
//     disallowedTools/bashCommandClamp with duplicates and unsorted. And it carries TWO PASSES in the same journal: the second
//     (`resumeFromRunId`) serves the agents before "fuenf" from the journal, runs "fuenf" anew (it failed in the first) and
//     everything behind it under NEW keys: the lane goes on behind the newly run "replaced" (sha256(key || \0replaced\0 ||
//     agentId)). The boundary of the passes is the first `started` of a key that already has one.
//   - that of 2.1.296 ("linear"): the proof of the FALLBACK; a journal of the old calculation still hits. It stays untouched
//     (its script.js in the same folder) and is never regenerated.
//
// When the pin in server/backend/Dockerfile jumps this test is red until the fixture of the new version is generated
// (`node server/backend/test/fixtures/dynworkflows-journal/generate.mjs`).
//
// The rename to cbase changed ONE word in each script.js: the product name in `meta.description`. The CLI wrote the journal, we
// the script; no journal.jsonl was touched, and the description does not enter any key (the key tests below hold that on the
// unchanged journal). The sha256 of script.js in the stamps was therefore taken anew with the rename (`filesHint` in the
// stamp). That every fixture differs from its state at the branch point 07417c18 only by the rename (the run script carries the
// generator's sha256 there, the stamp is otherwise field for field the generator's) is held against that recorded state in the
// maintainers' suite, outside the public tree; here every anchor of every stamp is held, and which fixtures carry the hint.
// COUNTER-TESTS of the anchor test: changing one character in 2.1.322/journal.jsonl without adjusting the sha256 turns it red;
// a `filesHint` in a fixture generated after the rename turns it red; removing the hint from 2.1.280 turns it red.
//
// COUNTER-TESTS (each turns the named test red):
//   - `sorted` in journal.js flat instead of recursive (or gone) => "key chain" red (at the schema of "drei");
//   - removing the separator `\0` between prompt and options => "key chain" red;
//   - removing `|| e.kind === "failed"` in createChain => "prefix rule" red (failed/skipped);
//   - a merely started entry breaking the prefix (`e.kind !== "result"`) => "prefix rule" red (only started).
// Counter-tests of the branch chains:
//   - `branchKey` with the slot without number (`slot:` instead of `slot:<i>`) => "key chain (branches)" red from "drei";
//   - `connect` without the states of the slots (empty list) => red from "vier" (the agent behind the join);
//   - `fork` leaving the state of the lane (no "fork") => red at "vierzehn" (the agent() next to the open parallel());
//   - sandbox.js: `fork("parallel")` only AFTER `await waitZero()` => red at "vierzehn" (the fork must stand at the call);
//   - sandbox.js: pipeline() without the slot per element => red at "elf-X";
//   - sandbox.js: the body starting WITHOUT the root lane (`run()` instead of `lanes.run(ROOT, run)`) => red ("without lane" > 0
//     and keys behind the first `await` wrong);
//   - the list options unnormalised (duplicates, unsorted) => red at "neun";
//   - the result never replacing (`return false`) => "second pass" red from "sechs"; replacing ALWAYS (without `hadEnd`) =>
//     "key chain (branches)" red from "zwei" (the agent behind "eins");
//   - the hit not taking the detour (`cache.replaced` not computed) => "third pass" red from "sechs";
//   - `chainKindOf`: a missing field gives "branches" instead of "linear" => "fallback" red (the linear journal then hits only "eins");
//   - `statusTheBranches`: a renewed start not taking the result back => "branches: state of the old journal" red;
//   - the prefix never breaking (`broken = true` removed in branchChain, per lane instead of across all) => "prefix rule
//     (branches)" and "prediction of the tree (branches)" red.
// The counter-tests at the main seam (run.js: lane at `further`, `fork` at the host, `replaced` at result and hit) are in the head
// of dynworkflows-resume.test.js, those of the lane guidance (AsyncLocalStorage) in dynworkflows-sandbox.test.js.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHAIN_KIND_NEW, ChainKindError, servedFromTheJournal, replacedKey, createChain, createPlayback, chainKindOf, chainOptions,
  normOptions, key as keyName, branchKey,
} from "../electron/server/dynworkflows/journal.js";
import { startScript } from "../electron/server/dynworkflows/sandbox.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const PIN = /@anthropic-ai\/claude-code@(\S+)/.exec(fs.readFileSync(path.join(REPO, "server/backend/Dockerfile"), "utf8"))[1];
const LINEAR = "2.1.296"; // the last fixture of the linear calculation: the proof of the fallback
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function fixture(version) {
  const folder = path.join(HERE, "fixtures/dynworkflows-journal", version);
  const read = (n) => fs.readFileSync(path.join(folder, n));
  const journal = read("journal.jsonl").toString("utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z));
  // The boundary of the passes: the first `started` of a key that already has one (without a second pass: the end).
  const seen = new Set();
  let cut = journal.length;
  journal.forEach((e, i) => { if (e.type !== "started") return; if (seen.has(e.key)) cut = Math.min(cut, i); seen.add(e.key); });
  return { folder, read, journal, script: read("script.js").toString("utf8"), stamp: JSON.parse(read("stamp.json")), one: journal.slice(0, cut), two: journal.slice(cut) };
}
const FX = fixture(PIN);
// label -> key and key -> outcome in a piece of the original journal
const startOf = (j) => new Map(j.filter((e) => e.type === "started").map((e) => [e.label, e.key]));
const outcomeOf = (j) => new Map(j.filter((e) => e.type === "result" || e.type === "failed").map((e) => [e.key, e]));
const START1 = startOf(FX.one), START2 = startOf(FX.two);
// What the script gets back per label: the result of the latest pass, null on "failed" like the original.
const valuePerLabel = (...chunks) => {
  const m = new Map();
  for (const j of chunks) { const output = outcomeOf(j); for (const [label, key] of startOf(j)) { const e = output.get(key); m.set(label, e?.type === "result" ? e.result : null); } }
  return m;
};

// The journal of the original in the form createChain reads ({ kind, key, value }). The original derives "replaced" from the
// order (its reader: a result for a key that already had a result or a failure); cbase writes it at the result
// (`replaced: <agentId>`, journal.js head); the translation stands here.
function asEntries(j) {
  const hadEnd = new Set();
  const out = [];
  for (const e of j) {
    if (!e.key) continue;
    if (e.type === "result") out.push({ kind: "result", key: e.key, value: e.result, ...(hadEnd.has(e.key) ? { replaced: e.agentId } : {}) });
    else out.push({ kind: e.type, key: e.key });
    if (e.type === "result" || e.type === "failed") hadEnd.add(e.key);
  }
  return out;
}

// Run a script through the cbase sandbox, the chain computes at the call (like run.js). `values`: label -> answer for a LIVE
// call; a hit answers with the value from the journal. `agentIdOf(key)`: the agentId with which a live call reports its result
// (for "replaced"). `change`: change the prompt of a label.
// Returns the calls in call order: { label, n, key, cache, prompt, opts }
async function run({ script, chain, values, agentIdOf = () => "agent-x", change = null }) {
  const list = [];
  const run2 = startScript({
    script,
    host: {
      ...(chain.kind === "branches" ? { fork: (b, variety) => chain.fork(b, variety) } : {}),
      agent(a, lane) {
        const label = a.opts?.label;
        const prompt = change?.[label] ?? a.prompt;
        const segment = chain.further(prompt, chainOptions(a.opts, chain.kind), [], lane);
        list.push({ label, n: a.n, key: segment.key, cache: segment.cache, prompt: a.prompt, opts: a.opts });
        if (segment.cache) return segment.cache.value;
        const value = values.get(label) ?? null;
        if (value !== null) segment.result(agentIdOf(segment.key));
        return value;
      },
    },
  });
  try {
    const r = await run2.end;
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(run2.withoutLane(), 0, "no agent() and no fork without a lane (sandbox.js, AsyncLocalStorage across the vm boundary)");
  } finally {
    run2.abort();
  }
  return list;
}
const perLabel = (list, f) => Object.fromEntries(list.map((a) => [a.label, f(a)]));
const LABELS = ["eins", "zwei", "drei", "vier", "fuenf", "sechs", "sieben", "acht", "neun", "zehn", "elf-X", "elf-Y", "zwoelf-X", "zwoelf-Y", "dreizehn", "vierzehn", "fuenfzehn"];

test(`fixture ${PIN}: generated in Claude Code, with stamp, generation path and sha256 per file; two passes in one journal`, () => {
  const { stamp, journal, read } = FX;
  assert.equal(stamp.claudeVersion, PIN, "the fixture belongs to the pin of the Dockerfile");
  assert.equal(stamp.way, "api-mock");
  assert.match(stamp.pack, new RegExp(`^@anthropic-ai/claude-code-[a-z0-9]+-[a-z0-9]+@${PIN.replace(/\./g, "\\.")}$`));
  assert.match(stamp.binarySha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(REPO, stamp.generatedWith)), `generation path ${stamp.generatedWith}`);
  assert.match(stamp.runId, /^wf_[a-z0-9-]{6,}$/);
  for (const [n, h] of Object.entries(stamp.files)) assert.equal(sha(read(n)), h, `sha256 ${n}`);
  assert.deepEqual(Object.keys(stamp.files).sort(), ["journal.jsonl", "script.js"]);
  // The run script is that of the generation path, otherwise the fixture would have come from another script.
  assert.equal(FX.script, fs.readFileSync(path.join(HERE, "fixtures/dynworkflows-journal/script.js"), "utf8"));
  // Shape of the original: one launched, per agent started and result|failed with a v2 key.
  assert.deepEqual(journal[0], { type: "launched" });
  assert.deepEqual([...new Set(journal.map((e) => e.type))].sort(), ["failed", "launched", "result", "started"]);
  for (const e of journal.filter((x) => x.type !== "launched")) assert.match(e.key, /^v2:[0-9a-f]{64}$/);
  // First pass: every agent of the script, "fuenf" failed. Second (resumeFromRunId): "fuenf" under the SAME key anew and with a
  // result, everything behind it under new keys, nothing before it.
  assert.equal(stamp.passes, 2);
  assert.deepEqual([...START1.keys()].sort(), [...LABELS].sort());
  assert.equal(outcomeOf(FX.one).get(START1.get("fuenf")).type, "failed");
  const behind = LABELS.slice(LABELS.indexOf("fuenf"));
  assert.deepEqual([...START2.keys()].sort(), [...behind].sort());
  assert.equal(START2.get("fuenf"), START1.get("fuenf"));
  assert.equal(outcomeOf(FX.two).get(START2.get("fuenf")).type, "result");
  for (const l of behind.slice(1)) assert.notEqual(START2.get(l), START1.get(l), `${l}: new key behind the one run anew`);
});

// The fixtures that already lay at the last state before the rename to cbase: the CLI ran them with the script of THAT
// state, so their script anchor was taken anew with the rename and carries the hint. A fixture generated later carries none; the
// pin's fixture loses it when it is run anew (another run).
const BEFORE_RENAME = ["2.1.280", "2.1.296", "2.1.322"];
const RENAME_HINT = /^script\.js: sha256 taken anew on 12\.11\.2026 with the rename to cbase; the only difference to the old anchor is the name/;
const FX_ROOT = "server/backend/test/fixtures/dynworkflows-journal";

test("every stamp anchors its files; exactly the fixtures from before the rename to cbase carry the adjusted anchor of script.js", () => {
  const versions = fs.readdirSync(path.join(REPO, FX_ROOT)).filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort();
  for (const v of BEFORE_RENAME) assert.ok(versions.includes(v), `${v}: a fixture from before the rename is gone (they are never regenerated)`);
  for (const v of versions) {
    const { stamp, read } = fixture(v);
    assert.deepEqual(Object.keys(stamp.files).sort(), ["journal.jsonl", "script.js"], `${v}: the anchored files`);
    for (const [n, h] of Object.entries(stamp.files)) assert.equal(sha(read(n)), h, `${v}: sha256 ${n}`);
    if (!BEFORE_RENAME.includes(v)) assert.equal(stamp.filesHint, undefined, `${v}: a fixture from after the rename carries no adjusted anchor`);
    else if (v !== PIN || stamp.filesHint !== undefined) assert.match(stamp.filesHint, RENAME_HINT, `${v}: the hint at the anchor`);
  }
});

test("key chain (branches): every key of the cbase run == the key in the real Claude Code journal: branch with two agents, join, nested, pipeline, open parallel()", async () => {
  const list = await run({ script: FX.script, chain: createChain(), values: valuePerLabel(FX.one) });
  assert.equal(createChain().kind, "branches");
  assert.equal(CHAIN_KIND_NEW, "branches");
  assert.deepEqual(perLabel(list, (a) => a.key), Object.fromEntries(list.map((a) => [a.label, START1.get(a.label)])), "chain != original");
  // EVERY key of the first pass is computed; none stays unproven.
  assert.deepEqual(list.map((a) => a.label).sort(), [...LABELS].sort());
  assert.deepEqual([...new Set(FX.one.filter((e) => e.key).map((e) => e.key))].sort(), list.map((a) => a.key).sort());
  // The branch calculation is really entered: the same calls computed LINEARLY match only up to the first parallel().
  const linear = await run({ script: FX.script, chain: createChain([], { kind: "linear" }), values: valuePerLabel(FX.one) });
  assert.deepEqual(linear.filter((a) => a.key === START1.get(a.label)).map((a) => a.label), ["eins"]);
  // Without options `{}`, label and phase do not enter, keys recursively sorted (at the schema of "drei").
  const opts = perLabel(list, (a) => a.opts);
  assert.equal(chainOptions({ label: "x", phase: "y" }), "{}");
  assert.equal(chainOptions(opts.drei), '{"schema":{"properties":{"wort":{"type":"string"},"zahl":{"type":"number"}},"required":["wort","zahl"],"type":"object"}}');
  // disallowedTools/bashCommandClamp: without duplicates, sorted (the script writes Write, Edit, Write and ls before echo).
  assert.equal(chainOptions(opts.neun), '{"bashCommandClamp":["Bash(echo hi)","Bash(ls)"],"disallowedTools":["Edit","Write"]}');
  assert.equal(chainOptions({ disallowedTools: [] }), "{}");
  assert.equal(chainOptions(opts.neun, "linear"), "{}", "the linear calculation does not know the two lists (that is how its journals were written)");
  // The additive cbase deviation is a step BEFORE: the same calculation with the resolved model (and repo).
  for (const a of list) {
    assert.equal(normOptions(a.opts, { model: "claude::claude-opus-5-5" }), chainOptions({ ...a.opts, model: "claude::claude-opus-5-5" }));
  }
});

test("second pass on the real journal (resumeFromRunId): hits up to before the failed one, it runs anew under its key, and behind it the lane goes on \"replaced\" like the original", async () => {
  const aus2 = outcomeOf(FX.two);
  const list = await run({ script: FX.script, chain: createChain(asEntries(FX.one)), values: valuePerLabel(FX.one, FX.two), agentIdOf: (key) => aus2.get(key)?.agentId });
  assert.deepEqual(list.filter((a) => a.cache).map((a) => a.label), ["eins", "zwei", "drei", "vier"], "from the journal");
  assert.deepEqual(list.find((a) => a.label === "drei").cache.value, { wort: "GAMMA", zahl: 3 }, "a structured result comes back as an object");
  // Every LIVE call stands in the second pass of the original under exactly this key.
  const live = list.filter((a) => !a.cache);
  assert.deepEqual(perLabel(live, (a) => a.key), Object.fromEntries(live.map((a) => [a.label, START2.get(a.label)])), "chain != original (second pass)");
  assert.deepEqual([...new Set(FX.two.map((e) => e.key))].sort(), live.map((a) => a.key).sort(), "every key of the second pass is computed");
  // The detour itself: behind "fuenf" the root stands on sha256(key || \0replaced\0 || agentId of the NEW run).
  const k5 = START2.get("fuenf");
  assert.equal(replacedKey(k5, aus2.get(k5).agentId), crypto.createHash("sha256").update(k5).update("\0replaced\0").update(aus2.get(k5).agentId).digest("hex"));
});

test("third pass (computed): a resume from the whole journal hits EVERYTHING; the hit on a replaced result takes the same detour", async () => {
  const old = asEntries(FX.journal);
  assert.deepEqual(old.filter((e) => e.replaced !== undefined).map((e) => e.key), [START2.get("fuenf")], "replaced is exactly the result run anew");
  const list = await run({ script: FX.script, chain: createChain(old), values: new Map() });
  assert.deepEqual(list.filter((a) => !a.cache).map((a) => a.label), [], "nothing runs anew");
  assert.deepEqual(perLabel(list, (a) => a.key), Object.fromEntries(list.map((a) => [a.label, START2.get(a.label) ?? START1.get(a.label)])));
  assert.equal(list.find((a) => a.label === "fuenf").cache.value, "FUENF", "the result of the second pass, not the failure of the first");
});

// The whole journal (both passes) as an old journal, and variations of it: the outcome of ONE label removed (`kind` null =>
// only started) or replaced by `failed`.
const WHOLE = asEntries(FX.journal);
const KEY = (label) => START2.get(label) ?? START1.get(label);
const without = (label, kind) => WHOLE.flatMap((e) => (e.key === KEY(label) && e.kind !== "started" ? (kind && e.kind === "result" ? [{ kind, key: e.key }] : []) : [e]));
const VALUES = valuePerLabel(FX.one, FX.two);
const hitsLabels = (list) => list.filter((a) => a.cache).map((a) => a.label);

test("prefix rule on the real journal (branches): ONE prefix across all lanes in call order; failed/skipped/changed breaks it, only started does not", async () => {
  const followUp = (await run({ script: FX.script, chain: createChain(WHOLE), values: VALUES })).map((a) => a.label);
  // The call order of the cbase sandbox with immediate answers (the expectations below depend on it).
  assert.deepEqual(followUp, ["eins", "zwei", "drei", "vier", "fuenf", "sechs", "sieben", "acht", "neun", "zehn", "elf-X", "elf-Y", "zwoelf-X", "zwoelf-Y", "vierzehn", "dreizehn", "fuenfzehn"]);
  const until = (label) => followUp.slice(0, followUp.indexOf(label));
  const including = async (old, o = {}) => hitsLabels(await run({ script: FX.script, chain: createChain(old), values: VALUES, ...o }));
  // Failed in the middle of a branch: from there on (in call order, also in the OTHER lanes) nothing from the cache.
  assert.deepEqual(await including(without("acht", "failed")), until("acht"), "failed");
  // Skipped counts like failed (original: null, in the journal failed).
  assert.deepEqual(await including(without("eins", "failed")), [], "skipped");
  // Only started: it runs anew itself, the following ones still hit, also the agent behind the join of its branch ("zehn").
  assert.deepEqual(await including(without("acht", null)), followUp.filter((l) => l !== "acht"), "only started");
  assert.deepEqual(await including(without("zwoelf-X", null)), followUp.filter((l) => l !== "zwoelf-X"), "only started (pipeline)");
  // Changed call: prefix up to before it.
  assert.deepEqual(await including(WHOLE, { change: { sechs: "Fixture prompt 6: (changed)" } }), until("sechs"), "changed");
});

// The prediction of the progress tree (journal.js servedFromTheJournal: which agents a restart serves from the journal,
// computed over `n` instead of prompt and options) is the SAME calculation as the chain: for every old journal of the prefix
// rule above it predicts exactly the calls that createChain serves from the cache.
// COUNTER-TESTS: in servedFromTheJournal a merely started entry also breaking (`else break` without the launched/started
// exception) turns "only started" red; `continue` instead of `break` (a failed one does not break) turns "failed" red.
test("prediction of the tree (branches): servedFromTheJournal == the hits of createChain (complete, failed, skipped, only started)", async () => {
  for (const [what, entries] of [["complete", WHOLE], ["failed", without("acht", "failed")], ["skipped", without("eins", "failed")], ["only started", without("acht", null)]]) {
    const list = await run({ script: FX.script, chain: createChain(entries), values: VALUES });
    // In cbase form: one `launched` per call with `n`, key and chain kind, behind it the entries of the old journal with their `n`.
    const nOf = new Map(list.map((a) => [KEY(a.label), a.n]));
    const cbase = [
      ...list.map((a) => ({ kind: "launched", n: a.n, key: KEY(a.label), chain: "branches" })),
      ...entries.filter((e) => nOf.has(e.key)).map((e) => ({ ...e, n: nOf.get(e.key) })),
    ];
    assert.deepEqual([...servedFromTheJournal(cbase)].sort((a, b) => a - b), list.filter((a) => a.cache).map((a) => a.n).sort((a, b) => a - b), what);
  }
  assert.deepEqual([...servedFromTheJournal([])], [], "without an old journal the restart serves nothing");
  assert.deepEqual([...servedFromTheJournal([{ kind: "launched", n: 1, key: "k", chain: "comes-still" }, { kind: "result", n: 1, key: "k", value: 1 }])], [], "a journal of an unknown kind serves nothing");
});

test("playback: hits go back in the completion order of the old run", () => {
  const old = asEntries(FX.one);
  // The first two results behind "eins", in the order in which the original wrote them.
  const [e1, e2] = old.filter((e) => e.kind === "result" && e.key !== START1.get("eins")).map((e) => e.key);
  const w = createPlayback(old);
  const output = [];
  w.hold(START1.get("eins"), () => output.push("eins"));
  w.hold(e2, () => output.push("second")); // called before the first, it finished after it
  assert.deepEqual(output, ["eins"], "the second waits for the first");
  w.hold(e1, () => output.push("first"));
  assert.deepEqual(output, ["eins", "first", "second"]);
  // If the expected predecessor never comes (script changed), quiet releases the earliest held one.
  const w2 = createPlayback(old);
  const aus2 = [];
  w2.hold(START1.get("vier"), () => aus2.push("vier"));
  w2.quiet({ onlyHeldOpen: false });
  assert.deepEqual(aus2, []);
  w2.quiet({ onlyHeldOpen: true });
  assert.deepEqual(aus2, ["vier"]);
});

// ── The branch calculation as pure functions (journal.js) ─────────────────────────────────────────────────────────────
test("branches: fork/slot/join and \"replaced\" as a pure calculation, wording of the original (2.1.322 Zo/jn)", () => {
  const h = (...parts) => { const x = crypto.createHash("sha256"); for (const t of parts) x.update(t); return x.digest("hex"); };
  assert.equal(branchKey("P", "parallel", "fork"), h("P", "\0", "parallel", "\0", "fork"));
  assert.equal(branchKey("P", "pipeline", 3), h("P", "\0", "pipeline", "\0", "slot:3"));
  assert.equal(branchKey("P", "parallel", ["a", "", "c"]), h("P", "\0", "parallel", "\0", "join", "\0", "a", "\0", "", "\0", "c"));
  assert.equal(branchKey("P", "parallel", []), h("P", "\0", "parallel", "\0", "join"));
  assert.equal(replacedKey("v2:k", "agent"), h("v2:k", "\0replaced\0", "agent"));
  assert.equal(replacedKey("v2:k", undefined), h("v2:k", "\0replaced\0"));
  // The chain: the fork sets the lane to "fork", every slot starts at the state BEFORE the fork, the join computes on the state
  // the lane then has (here: moved on by an agent()); a slot that never existed enters empty.
  const k = createChain();
  const a = k.further("A", "{}").key;
  const g = k.fork(null, "parallel");
  const p2 = g.slot(2);
  const b = k.further("B", "{}", [], p2).key;
  assert.equal(b, keyName(branchKey(a, "parallel", 2), "B", "{}"));
  const c = k.further("C", "{}").key; // in the root, next to the open fork
  assert.equal(c, keyName(branchKey(a, "parallel", "fork"), "C", "{}"));
  g.connect();
  assert.equal(k.further("D", "{}").key, keyName(branchKey(c, "parallel", ["", "", b]), "D", "{}"));
  // Linear knows no lanes: the fork changes nothing, `slot` returns none.
  const l = createChain([], { kind: "linear" });
  const la = l.further("A", "{}").key;
  const lg = l.fork(null, "parallel");
  assert.equal(lg.slot(0), null);
  lg.connect();
  assert.equal(l.further("B", "{}").key, keyName(la, "B", "{}"));
  assert.equal(la, a, "without parallel()/pipeline() both kinds are equal");
});

// Counter-test `statusTheBranches` (see head).
test("branches: state of the old journal like the reader of the original; a result with a later restart no longer hits and breaks; \"replaced\" only if the key already had an end and the lane still stands on it", () => {
  const kA = keyName("", "A", "{}"), kB = keyName(kA, "B", "{}");
  const start = (key) => ({ kind: "launched", key, chain: "branches" });
  // A done, B done, then B started once more (an attempt that ran it anew and aborted): the result of B no longer counts.
  const old = [start(kA), { kind: "result", key: kA, value: "a" }, start(kB), { kind: "result", key: kB, value: "b" }, start(kB), { kind: "started", key: kB }];
  const k = createChain(old);
  assert.equal(k.kind, "branches");
  assert.equal(k.further("A", "{}").cache.value, "a");
  const b = k.further("B", "{}");
  assert.equal(b.cache, null, "taken back");
  // It runs live; its key had an end => the lane goes on replaced, and the next call computes on it.
  assert.equal(b.result("new-1"), true);
  const c = k.further("C", "{}");
  assert.equal(c.key, keyName(replacedKey(kB, "new-1"), "C", "{}"));
  assert.equal(c.cache, null, "the prefix is broken");
  assert.equal(c.result("new-2"), false, "a new key had no end: nothing to replace");
  // The lane no longer stands on the key (a second agent() was called before the first was done): no detour.
  const k2 = createChain(old);
  k2.further("A", "{}");
  const b2 = k2.further("B", "{}");
  const c2 = k2.further("C", "{}");
  assert.equal(b2.result("new-1"), false);
  assert.equal(c2.key, keyName(kB, "C", "{}"));
  // A failed one, healed later: the result hits; with `replaced` at the result the hit takes the detour.
  const kC = keyName(replacedKey(kB, "new-1"), "C", "{}");
  const healed = [start(kA), { kind: "result", key: kA, value: "a" }, start(kB), { kind: "failed", key: kB }, start(kB), { kind: "result", key: kB, value: "b2", replaced: "new-1" }, start(kC), { kind: "result", key: kC, value: "c" }];
  const k3 = createChain(healed);
  assert.deepEqual(["A", "B", "C"].map((p) => k3.further(p, "{}").cache?.value ?? null), ["a", "b2", "c"]);
  assert.deepEqual([...servedFromTheJournal(healed.map((e) => ({ ...e, n: e.key === kA ? 1 : e.key === kB ? 2 : 3 })))], [1, 2, 3]);
  // The hit passes `replaced` on (run.js writes it to its result; a resume of THIS run needs it).
  assert.equal(createChain(healed).further("A", "{}").cache.replaced, undefined);
  const k4 = createChain(healed);
  k4.further("A", "{}");
  assert.equal(k4.further("B", "{}").cache.replaced, "new-1");
});

// ── The fallback: journals of the linear calculation (up to 2.1.296) ───────────────────────────────────────────────────────
const OLD_FIXTURE = fixture(LINEAR);
const OLD_START = startOf(OLD_FIXTURE.journal);
const OLD_LABELS = ["eins", "zwei", "drei", "vier", "fuenf"];
// A journal in cbase form as a server wrote it BEFORE the change: one `launched` per agent() WITHOUT `chain`.
const cbaseOld = (entries, list) => {
  const nOf = new Map(list.map((a) => [a.key, a.n]));
  return [...list.map((a) => ({ kind: "launched", n: a.n, key: a.key })), ...entries.map((e) => ({ ...e, n: nOf.get(e.key) }))];
};

test("chain kind of a journal: if it is missing at the launched it is the linear one, ONE place (chainKindOf); without launched the new one; an unknown one does not resume", () => {
  assert.equal(chainKindOf([]), null);
  assert.equal(chainKindOf([{ kind: "result", key: "k", value: 1 }]), null, "without launched there is nothing to hit");
  assert.equal(chainKindOf([{ kind: "launched", n: 1, key: "k" }]), "linear", "missing means explicitly linear");
  assert.equal(chainKindOf([{ kind: "launched", n: 1, key: "k", chain: "branches" }]), "branches");
  assert.equal(chainKindOf([{ kind: "launched", n: 1, key: "k", chain: "linear" }]), "linear");
  // The LAST launched counts (after a rollback and forward again: the kind of the latest attempt).
  assert.equal(chainKindOf([{ kind: "launched", n: 1, key: "k", chain: "branches" }, { kind: "launched", n: 1, key: "k2" }]), "linear");
  assert.equal(createChain([]).kind, "branches");
  assert.equal(createChain([{ kind: "launched", n: 1, key: "k" }]).kind, "linear");
  assert.equal(createChain([{ kind: "launched", n: 1, key: "k", chain: "branches" }]).kind, "branches");
  assert.throws(() => createChain([{ kind: "launched", n: 1, key: "k", chain: "comes-still" }]), ChainKindError);
});

test(`fallback (fixture ${LINEAR}, linear): the journal of the old calculation matches key for key; and a cbase journal without chain kind resumes linearly and hits`, async () => {
  for (const [n, h] of Object.entries(OLD_FIXTURE.stamp.files)) assert.equal(sha(OLD_FIXTURE.read(n)), h, `sha256 ${n}: the old fixture stays unchanged`);
  assert.equal(OLD_FIXTURE.stamp.claudeVersion, LINEAR);
  const values = valuePerLabel(OLD_FIXTURE.journal);
  const list = await run({ script: OLD_FIXTURE.script, chain: createChain([], { kind: "linear" }), values });
  assert.deepEqual(list.map((a) => a.label), OLD_LABELS, "call order like in the script");
  assert.deepEqual(list.map((a) => a.key), OLD_LABELS.map((l) => OLD_START.get(l)), "linear chain != original 2.1.296");
  // The new calculation would NOT hit this journal (hence the fallback): behind the first parallel() every key is different.
  const branches = await run({ script: OLD_FIXTURE.script, chain: createChain([], { kind: "branches" }), values });
  assert.deepEqual(branches.filter((a) => a.key === OLD_START.get(a.label)).map((a) => a.label), ["eins"]);
  // Resume: the journal in cbase form from before the change (launched without `chain`) => the chain computes linearly and
  // serves the four results; the failed fifth runs anew.
  const old = cbaseOld(asEntries(OLD_FIXTURE.journal), list);
  const chain = createChain(old);
  assert.equal(chain.kind, "linear");
  const again = await run({ script: OLD_FIXTURE.script, chain, values });
  assert.deepEqual(hitsLabels(again), ["eins", "zwei", "drei", "vier"]);
  assert.deepEqual(again.map((a) => a.key), list.map((a) => a.key), "the resuming run writes on the same (linear) keys");
  assert.deepEqual([...servedFromTheJournal(old)].sort(), [1, 2, 3, 4], "the prediction of the tree computes the same journal linearly");
});

test(`prefix rule (linear, fixture ${LINEAR}): a failed or skipped entry breaks the prefix, a merely started one does not; same prediction of the tree`, async () => {
  const values = valuePerLabel(OLD_FIXTURE.journal);
  const list = await run({ script: OLD_FIXTURE.script, chain: createChain([], { kind: "linear" }), values });
  const old = asEntries(OLD_FIXTURE.journal);
  const withoutOld = (label, kind) => old.flatMap((e) => (e.key === OLD_START.get(label) && e.kind !== "started" ? (kind ? [{ kind, key: e.key }] : []) : [e]));
  const enabled = async (entries, o = {}) => (await run({ script: OLD_FIXTURE.script, chain: createChain(entries, { kind: "linear" }), values, ...o })).map((a) => a.cache !== null);
  // Complete: four results from the cache, the failed fifth runs anew.
  assert.deepEqual(await enabled(old), [true, true, true, true, false]);
  // Failed in the middle: from there on nothing from the cache.
  assert.deepEqual(await enabled(withoutOld("zwei", "failed")), [true, false, false, false, false], "failed");
  // Skipped counts like failed (original: null, in the journal failed).
  assert.deepEqual(await enabled(withoutOld("eins", "failed")), [false, false, false, false, false], "skipped");
  // Only started: it runs anew itself, the following ones still hit.
  assert.deepEqual(await enabled(withoutOld("zwei", null)), [true, false, true, true, false], "only started");
  // Changed call: prefix up to before it.
  assert.deepEqual(await enabled(old, { change: { drei: "Fixture prompt 3: (changed)" } }), [true, true, false, false, false], "changed");
  for (const [what, entries] of [["complete", old], ["failed", withoutOld("zwei", "failed")], ["skipped", withoutOld("eins", "failed")], ["only started", withoutOld("zwei", null)]]) {
    const expected = (await enabled(entries)).flatMap((c, i) => (c ? [i + 1] : []));
    assert.deepEqual([...servedFromTheJournal(cbaseOld(entries, list))].sort((a, b) => a - b), expected, what);
  }
});

// A run that resolved "codex::gpt-5.5" before the retirement stands under its keys in the journal; afterwards the same call
// resolves "codex::gpt-6-sol" (migration of the chat, default model, mapping at run time); without an alias a restart across
// the deploy would run EVERY agent() anew, including worktree changes. `substitute` names the options of the predecessor
// (dynworkflows/run.js computes them from providers/retired.js); a hit there counts with the OLD key, and the chain goes on on
// it. COUNTER-TEST: `further` not knowing the third parameter turns "with substitute" red (no hit). Both chain kinds (without
// parallel()/pipeline() they compute the same keys).
for (const kind of ["linear", "branches"]) test(`alias of a retired predecessor (${kind}): with substitute options the same call hits the key of the old model and the chain goes on on it; a break stays a break`, () => {
  const createChainTheKind = (entries) => createChain(entries, { kind });
  const opt = (model, effort = "") => normOptions({ effort }, { model });
  // The old run: three calls under codex::gpt-5.5; "max" ran there as xhigh (gpt-5.5 carried no max).
  const callsOld = [["A", ""], ["B", "xhigh"], ["C", ""]];
  const oldKeys = [];
  const oldEntries = [];
  let v = "";
  for (const [p, e] of callsOld) {
    const key = keyName(v, p, opt("codex::gpt-5.5", e));
    v = key;
    oldKeys.push(key);
    oldEntries.push({ kind: "launched", key }, { kind: "result", key, value: `old ${p}` });
  }
  // The new run: the same calls, resolved as codex::gpt-6-sol (B with max, which the successor carries).
  const fresh = [["A", opt("codex::gpt-6-sol"), [opt("codex::gpt-5.5")]], ["B", opt("codex::gpt-6-sol", "max"), [opt("codex::gpt-5.5", "xhigh")]], ["C", opt("codex::gpt-6-sol"), [opt("codex::gpt-5.5")]]];

  const without = createChainTheKind(oldEntries);
  assert.deepEqual(fresh.map(([p, n]) => without.further(p, n).cache), [null, null, null], "without substitute: everything fresh (the finding)");

  const including = createChainTheKind(oldEntries);
  const r = fresh.map(([p, n, fallback]) => including.further(p, n, fallback));
  assert.deepEqual(r.map((x) => x.cache?.value ?? null), ["old A", "old B", "old C"], "with substitute: everything from the journal");
  assert.deepEqual(r.map((x) => x.key), oldKeys, "under the keys of the old run (journal and playback speak its language)");

  // A changed call breaks the chain; afterwards the substitute does not help either (B and C hit only through the old predecessor).
  const breakage = createChainTheKind(oldEntries);
  assert.equal(breakage.further("A changed", opt("codex::gpt-6-sol"), [opt("codex::gpt-5.5")]).cache, null);
  assert.equal(breakage.further("B", opt("codex::gpt-6-sol", "max"), [opt("codex::gpt-5.5", "xhigh")]).cache, null);

  // The own key comes first: a journal that already carries the call with the successor hits without a detour.
  const kNew = keyName("", "A", opt("codex::gpt-6-sol"));
  const own = createChainTheKind([{ kind: "result", key: kNew, value: "new A" }, ...oldEntries]);
  const t = own.further("A", opt("codex::gpt-6-sol"), [opt("codex::gpt-5.5")]);
  assert.deepEqual([t.key, t.cache?.value], [kNew, "new A"]);
});
