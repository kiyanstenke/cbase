// The graph as a CONTRACT between editor and driver: `normalizeGraph` must keep what the editor needs
// to draw (the sides at which the user attached an edge), drop nonsense, and the driver must NOT be
// influenced by any of it. Whatever `normalizeGraph` does not know is gone on the next load, which is
// how a user input gets lost silently.
import assert from "node:assert/strict";
import test from "node:test";

import * as wf from "../electron/server/workflows.js";

const graph = (edges) => wf.normalizeGraph({
  nodes: [
    { id: "a", type: "instruction", title: "A" },
    { id: "b", type: "instruction", title: "B" },
    { id: "c", type: "condition", title: "C" },
  ],
  edges,
});

test("An edge's sides survive saving, and only left/right count", () => {
  const g = graph([
    { from: "a", to: "b", fromSide: "left", toSide: "left" },
    { from: "b", to: "c", fromSide: "right", toSide: "nonsense" },
    { from: "c", to: "a", branch: "false" },
  ]);
  assert.deepEqual(g.edges.map((e) => [e.from, e.to, e.fromSide, e.toSide]), [
    ["a", "b", "left", "left"],
    ["b", "c", "right", ""],   // nonsense becomes "" = the editor decides itself
    ["c", "a", "", ""],        // no choice made
  ]);
  // Normalizing twice changes nothing (the editor loads, saves, loads ...).
  assert.deepEqual(wf.normalizeGraph(g).edges, g.edges);
});

test("The driver ignores the sides; presentation must not bend execution", () => {
  const including = graph([{ from: "a", to: "b", fromSide: "left", toSide: "left" }]);
  const without = graph([{ from: "a", to: "b" }]);
  assert.equal(wf.outgoing(including, "a", null), wf.outgoing(without, "a", null));
  const cursorWith = wf.advance(including, wf.initialCursor(including), null);
  const cursorWithout = wf.advance(without, wf.initialCursor(without), null);
  assert.equal(cursorWith.at, cursorWithout.at);
  assert.equal(cursorWith.at, "b");
  // Entry, step count and hints stay untouched as well.
  assert.equal(wf.entryNodeId(including), wf.entryNodeId(without));
  assert.deepEqual(wf.countSteps(including), wf.countSteps(without));
  assert.deepEqual(wf.checkGraph(including).map((p) => p.text), wf.checkGraph(without).map((p) => p.text));
});

test("Node commands are normalized and marked exactly once per visit", () => {
  const g = wf.normalizeGraph({
    nodes: [{ id: "a", type: "instruction", title: "A", command: "/go {{input}}" }],
    edges: [],
  });
  assert.equal(g.nodes[0].command, "/go {{input}}");
  let cursor = wf.initialCursor(g, "Job");
  assert.equal(wf.commandDone(cursor, "a"), false);
  cursor = wf.beginCommand(cursor, "a");
  cursor = wf.finishCommand(cursor, "a");
  assert.equal(wf.commandDone(cursor, "a"), true, "the same visit must not repeat the command");
  cursor = wf.countVisit(cursor, "a");
  assert.equal(wf.commandDone(cursor, "a"), false, "the next visit must run the command again");
  assert.equal(wf.countSteps(g).total, 2, "a free message plus the actual instruction are two turns");

  const native = wf.normalizeGraph({ nodes: [{ id: "s", type: "start", command: "/clear" }], edges: [] });
  assert.equal(wf.countSteps(native).total, 0, "/clear runs without an agent turn");
});
