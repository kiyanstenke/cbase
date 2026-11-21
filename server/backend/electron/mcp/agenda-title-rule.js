// The ONE rule for understandable agenda texts (the same rule exists for the timeline, server/outerloop/input.js RULE_TIMELINE).
// Agendas used to contain items like "o#47 part 2 package 3": not understandable for the human who sees only the headings in the
// right rail, nor for other chats that read the agenda without the history.
//
// It stands verbatim in the system prompt of the main run (server/runs/system-prompt.js AGENDA_SET), in the description of
// cbase_agenda_write and cbase_agenda_maintain (mcp/tools/agenda.js) and in the fixed frame of the agenda keeper
// (server/outerloop/input.js ruleAgenda; its English key carries it verbatim) — whoever writes gets the same instruction. A
// leaf without imports: the MCP server (own process) and the server both read it. Guard: server/backend/test/agenda-title-rule.test.js.

export const AGENDA_TITLE_RULE = "Title and items must be understandable without the history: name identifiers (issue #123, MR !45, branch) together with what it is about — never just numbers or internal shorthand (good: \"#47 rebuild reference list: check on name clash\", bad: \"o#47 T2 P3\"); the description says in plain words what is to be achieved and why.";
