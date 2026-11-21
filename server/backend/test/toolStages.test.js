// Tool stages: mixed groups of the catalog can also be chosen READ-ONLY. Proves the one statement every caller shares: an
// agent with the read subset gets the read line (and no mention of tools it does not have), with a maintaining tool the
// full line. Covers toolchain/tool-catalog.js (the coding groups context, communication, gitlab, chosen by the outer-loop
// agents, outerloop/catalog.js). There is no role: with cbase_agent_send the read part stands WITHOUT "You cannot write to
// any other chat" and without a write path — whoever gives the tool explains that.
// Counter-test: LORE_COMMUNICATION.line set to the readRow => "communication with write tool" turns red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODING_GROUPS, CODING_LORE, toolPrimer } from "../electron/server/toolchain/tool-catalog.js";

const names = (text, name) => new RegExp(`\\b${name}\\b`).test(text);
const SUBAGENTS_TOOLS = ["cbase_agent", "cbase_agent_output", "cbase_agent_stop"];

test("catalog: `read` is a real subset, and exactly the mixed group carries it", () => {
  const including = CODING_GROUPS.filter((g) => g.read);
  // Communication is mixed: find and read versus write.
  assert.deepEqual(including.map((g) => g.key), ["communication"]);
  assert.ok(CODING_GROUPS.every((g) => !("standard" in g)));
  for (const g of including) {
    assert.ok(g.read.length > 0 && g.read.length < g.tools.length, g.key);
    assert.ok(g.read.every((t) => g.tools.includes(t)), `${g.key}: read ⊂ tools`);
    // Read-only means search/get/list/read/status — nothing that creates, changes, deletes or writes into.
    assert.ok(g.read.every((t) => /_(search|get|list|read|status)$/.test(t)), `${g.key}: ${g.read.join()}`);
    assert.ok(g.tools.filter((t) => !g.read.includes(t)).every((t) => /_(create|update|write|move|delete|import|submit|withdraw|send|install|remove|run)$/.test(t)), g.key);
    // Whoever has only the read subset gets tool guidance that names its read tools and NO maintaining one.
    const lore = toolPrimer(g.read);
    for (const t of g.read) assert.ok(lore.includes(t), `${g.key}: ${t} in the read guidance`);
    for (const t of g.tools.filter((t) => !g.read.includes(t))) assert.ok(!lore.includes(t), `${g.key}: ${t} NOT in the read guidance`);
  }
  // Every line of the tool guidance belongs to a catalog group — a line without a group would explain a tool nobody chooses.
  const selectable = new Set(CODING_GROUPS.flatMap((g) => g.tools));
  for (const k of CODING_LORE) for (const t of k.tools) assert.ok(selectable.has(t), `${t} is in the guidance but in no group`);
});

test("communication read: the read line explains finding and reading, but no subagent tool and no writing", () => {
  const lore = toolPrimer(["cbase_agents_list", "cbase_projects_list"]);
  assert.ok(names(lore, "cbase_agents_list"), lore);
  assert.match(lore, /view \"chat\"/);
  for (const t of [...SUBAGENTS_TOOLS, "cbase_agent_send"]) assert.ok(!names(lore, t), `${t} is not in the read guidance`);
  assert.ok(!/inbox|approval|\bcap\b|\bposting\b/i.test(lore), "no write path in the read line");
  assert.match(lore, /You cannot write to any other chat/);
});

test("communication with write tool: the read part without \"You cannot write\", without inbox, posting and approval", () => {
  const lore = toolPrimer(["cbase_agents_list", "cbase_agent_send"]);
  assert.ok(names(lore, "cbase_agents_list"), lore);
  assert.doesNotMatch(lore, /You cannot write to any other chat/, "it HAS cbase_agent_send — the guidance says nothing false");
  assert.ok(!/inbox|approval|\bcap\b|\bposting\b/i.test(lore), `no removed path: ${lore}`);
  // Without cbase_agent no line about subagents.
  for (const t of SUBAGENTS_TOOLS) assert.ok(!names(lore, t), `${t} not explained`);
  // Without the read choice the line is still there: agent_send belongs to the group, its line only names reading.
  assert.equal(toolPrimer(["cbase_agent_send"]), lore);
});
