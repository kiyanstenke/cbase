// Guard for the ONE rule for understandable agenda texts (mcp/agenda-title-rule.js): whoever writes the agenda gets it - the main
// run in the system prompt (AGENDA_SET), both write tools in their description, the agenda keeper in its fixed frame.
// Counter-test: remove the rule from one of the four places => the matching case turns red; a run without agenda write access
// does not get it (description side = execution side).
import assert from "node:assert/strict";
import test from "node:test";

import { AGENDA_TITLE_RULE } from "../electron/mcp/agenda-title-rule.js";
import { setUiLang } from "../electron/server/i18n.js";
import { buildSystemPrompt } from "../electron/server/runs/system-prompt.js";
import { agendaTools } from "../electron/mcp/tools/agenda.js";
import { outerLoopFrame } from "../electron/server/outerloop/input.js";

// The English wording lives only as a key in the keeper's fixed frame (outerloop/input.js ruleAgenda): the frame sentence that
// carries the rule, in the English UI.
const KEEPER_SET = { cbase: ["cbase_agenda", "cbase_agenda_maintain"], builtin: [], extern: [], dropped: { fence: [], approval: [], locked: [], genus: [] } };
function ruleEnglish() {
  setUiLang("en");
  try {
    const frame = outerLoopFrame({ name: "Agenda keeper", provider: "claude", agendaKeeper: true }, { id: "c1", title: "Chat" }, KEEPER_SET);
    return frame.split("\n").find((row) => /never just numbers/.test(row)) || "";
  } finally { setUiLang("de"); }
}

test("the rule itself: identifier AND content, with good and bad example, in the rule and in the English frame", () => {
  const AGENDA_TITLE_RULE_EN = ruleEnglish();
  for (const r of [AGENDA_TITLE_RULE, AGENDA_TITLE_RULE_EN]) {
    assert.match(r, /#123/);
    assert.match(r, /!45/);
    assert.match(r, /o#47 T2 P3/, "the bad example");
  }
  assert.match(AGENDA_TITLE_RULE, /never just numbers/);
  assert.match(AGENDA_TITLE_RULE_EN, /never just numbers/);
});

test("system prompt: the main run with agenda carries the rule, a run without agenda does not", () => {
  assert.ok(buildSystemPrompt("", { agenda: true }).includes(AGENDA_TITLE_RULE));
  assert.ok(!buildSystemPrompt("", { agenda: false }).includes(AGENDA_TITLE_RULE));
});

test("tool descriptions: cbase_agenda_write and cbase_agenda_maintain carry it, the read tool does not", () => {
  const tools = [].concat(typeof agendaTools === "function" ? agendaTools({}) : agendaTools);
  const from = (n) => tools.find((t) => t.name === n);
  for (const n of ["cbase_agenda_write", "cbase_agenda_maintain"]) {
    assert.ok(from(n), n);
    assert.ok(from(n).description.includes(AGENDA_TITLE_RULE), n);
  }
  assert.ok(!from("cbase_agenda").description.includes(AGENDA_TITLE_RULE));
});

test("agenda keeper: the fixed frame carries the rule, an agent without the maintain tool does not", () => {
  const chat = { id: "c1", title: "Chat" };
  const including = outerLoopFrame({ name: "Agenda keeper", provider: "claude", agendaKeeper: true }, chat,
    { cbase: ["cbase_agenda", "cbase_agenda_maintain"], builtin: [], extern: [], dropped: { fence: [], approval: [], locked: [], genus: [] } });
  assert.match(including, /Titel und Punkte müssen ohne den Verlauf verständlich sein/, "German UI: the German wording");
  assert.ok(ruleEnglish().includes(AGENDA_TITLE_RULE), "English UI: verbatim the ONE rule");
  const without = outerLoopFrame({ name: "Observer", provider: "claude" }, chat, { cbase: [], builtin: [], extern: [], dropped: { fence: [], approval: [], locked: [], genus: [] } });
  assert.ok(!without.includes(AGENDA_TITLE_RULE) && !/never just numbers/.test(without));
});
