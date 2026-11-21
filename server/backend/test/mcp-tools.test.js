// Guard for the ONE computation over the tool choice of a coding MCP server (toolchain/mcp-tools.js). Pure, without a server.
// Every case carries its counter-test: the same check at the input where the rule must deliver the OPPOSITE; a test that does
// not tell both sides apart proves nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { carryForward, filtered, baselineOpen, hasFree, withoutNew, writingOf, verdict, DESCRIPTION_MAX } from "../electron/server/toolchain/mcp-tools.js";

const W = (name, ro) => ({ name, description: `Description ${name}`, ...(ro === undefined ? {} : { annotations: { readOnlyHint: ro } }) });
// A server from before the switch day (never loaded, autoMarkerFirst false) and a newly created one (autoMarkerFirst true).
const INVENTORY = { tools: [], toolsAt: 0, choice: null, markers: [], autoMarkerFirst: false };
const FRESH = { ...INVENTORY, autoMarkerFirst: true };
const after = (server, list) => ({ ...server, ...carryForward(server, list), toolsAt: 1 });

test("writing is the coding rule of its own: false => true, true => false, otherwise unclear", () => {
  assert.equal(writingOf(W("a", false)), true);
  assert.equal(writingOf(W("a", true)), false);
  assert.equal(writingOf(W("a")), null);
  assert.equal(writingOf({ name: "a", annotations: { readOnlyHint: "false" } }), null, "only the boolean value counts");
});

test("baseline: the inventory on the switch day gets NO marker; counter-test: newly created => marked", () => {
  const list = [W("read", true), W("send", false), W("unclear")];
  assert.equal(baselineOpen(INVENTORY), true);
  const b = carryForward(INVENTORY, list);
  assert.deepEqual(b.markers, [], "inventory: no marker");
  assert.deepEqual(b.tools.map((w) => [w.name, w.writing, w.fresh]), [["read", false, false], ["send", true, false], ["unclear", null, false]]);
  // Counter-test: the same set on a newly created server.
  assert.equal(baselineOpen(FRESH), false);
  assert.deepEqual(carryForward(FRESH, list).markers, ["send"], "newly created: the writing tool carries the automatic marker");
});

test("automatic marker on an inventory server: a LATER new writing tool is marked; counter-test: the old one stays free", () => {
  const afterBaseline = after(INVENTORY, [W("send", false)]);
  assert.equal(baselineOpen(afterBaseline), false, "after the first load the baseline is closed");
  const two = carryForward(afterBaseline, [W("send", false), W("erase", false)]);
  assert.deepEqual(two.markers, ["erase"], "only the new writing tool");
  assert.ok(!two.markers.includes("send"), "counter-test: the inventory tool stays unmarked");
});

test("unclear stays free; counter-test: the same tool with readOnlyHint false is marked", () => {
  assert.deepEqual(carryForward(FRESH, [W("unclear")]).markers, []);
  assert.deepEqual(carryForward(FRESH, [W("unclear", false)]).markers, ["unclear"]);
  assert.deepEqual(carryForward(FRESH, [W("read", true)]).markers, [], "reading stays free as well");
});

test("a failure does not set toolsAt: the baseline stays open until a load SUCCEEDS", () => {
  // The failure writes only the tools error (toolchain/mcp-load.js); the server looks as before afterwards.
  const afterError = { ...INVENTORY, toolsError: "no answer within 30 s" };
  assert.equal(baselineOpen(afterError), true);
  assert.deepEqual(carryForward(afterError, [W("send", false)]).markers, [], "the next successful load sets the baseline without a marker");
  // Counter-test: after a success (toolsAt > 0) the baseline is closed and a new writing tool is marked.
  assert.deepEqual(carryForward({ ...afterError, toolsAt: 5 }, [W("send", false)]).markers, ["send"]);
});

test("\"new\": with a choice a later new tool is off and new until it is ticked; counter-test: without a choice never new", () => {
  const selected = { ...after(FRESH, [W("a", true)]), choice: ["a"] };
  const r = carryForward(selected, [W("a", true), W("b", true)]);
  assert.deepEqual(r.tools.map((w) => [w.name, w.fresh]), [["a", false], ["b", true]]);
  assert.equal(verdict({ ...selected, ...r }, "b"), "locked", "new means off");
  // "new" holds across a further load as long as it is not ticked ...
  const again = carryForward({ ...selected, ...r }, [W("a", true), W("b", true)]);
  assert.equal(again.tools.find((w) => w.name === "b").fresh, true);
  // ... and falls only on ticking.
  assert.equal(withoutNew(r.tools, ["a", "b"]).find((w) => w.name === "b").fresh, false);
  assert.equal(withoutNew(r.tools, ["a"]).find((w) => w.name === "b").fresh, true, "not ticked => stays new");
  assert.equal(withoutNew(r.tools, null).find((w) => w.name === "b").fresh, false, "choice null ticks all");
  // Counter-test: without a choice (null = all) a new tool is free and not "new".
  const withoutChoice = carryForward(after(FRESH, [W("a", true)]), [W("a", true), W("b", true)]);
  assert.equal(withoutChoice.tools.find((w) => w.name === "b").fresh, false);
});

test("vanished => drops out of the cache, the decision stays; when it returns it applies; counter-test: a really new one", () => {
  const s = { ...after(FRESH, [W("a", false), W("b", false)]), choice: ["a"] };
  assert.deepEqual(s.markers, ["a", "b"]);
  const gone = { ...s, ...carryForward(s, [W("b", false)]) };
  assert.deepEqual(gone.tools.map((w) => w.name), ["b"], "a drops out of the cache");
  assert.deepEqual(gone.choice, ["a"], "the choice keeps a");
  assert.ok(gone.markers.includes("a"), "the marker keeps a");
  const back = carryForward(gone, [W("a", false), W("b", false)]);
  const a = back.tools.find((w) => w.name === "a");
  assert.equal(a.fresh, false, "returned => not new, the old choice applies");
  assert.equal(verdict({ ...gone, ...back }, "a"), "card");
  // Counter-test: a tool that choice and markers never named is new (and writing => marked).
  const foreign = carryForward(gone, [W("b", false), W("c", false)]);
  assert.equal(foreign.tools.find((w) => w.name === "c").fresh, true);
  assert.ok(foreign.markers.includes("c"));
});

test("verdict: null = all, [] = none, list = exactly these; marker => card; unknown name with a choice locked", () => {
  const s = { tools: [{ name: "a" }, { name: "b" }], choice: null, markers: ["b"] };
  assert.equal(verdict(s, "a"), "free");
  assert.equal(verdict(s, "b"), "card");
  assert.equal(verdict(s, "unknown"), "free", "without a choice even an unloaded name is free");
  // Counter-test null vs []: the same names, empty choice => everything locked.
  assert.equal(verdict({ ...s, choice: [] }, "a"), "locked");
  assert.equal(verdict({ ...s, choice: [] }, "b"), "locked", "a marker does not free a deselected tool");
  assert.equal(verdict({ ...s, choice: ["a"] }, "a"), "free");
  assert.equal(verdict({ ...s, choice: ["a"] }, "unknown"), "locked");
});

test("hasFree: null => yes (even an empty cache); [] => no; a list with only names outside the cache => no", () => {
  assert.equal(hasFree({ tools: [], choice: null }), true);
  assert.equal(hasFree({ tools: [{ name: "a" }], choice: [] }), false);
  assert.equal(hasFree({ tools: [{ name: "a" }], choice: ["a"] }), true);
  assert.equal(hasFree({ tools: [{ name: "a" }], choice: ["gone"] }), false, "only vanished tools chosen");
  assert.equal(hasFree({ tools: [{ name: "a" }], choice: ["a"], markers: ["a"] }), true, "a card counts as free");
});

test("filtered: the list of the wrapper carries only \"free\" and \"card\"", () => {
  const s = { tools: [], choice: ["a", "b"], markers: ["b"] };
  assert.deepEqual(filtered(s, [W("a"), W("b"), W("c")]).map((t) => t.name), ["a", "b"]);
  assert.deepEqual(filtered({ ...s, choice: null }, [W("a"), W("c")]).map((t) => t.name), ["a", "c"], "counter-test: without a choice everything");
});

test("description in the cache at most 600 characters, duplicate names once", () => {
  const r = carryForward(FRESH, [{ name: "a", description: "x".repeat(2000) }, { name: "a", description: "second" }]);
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].description.length, DESCRIPTION_MAX);
});
