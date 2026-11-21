// Which names a saved dynamic workflow may carry — a leaf without imports.
//
// A saved workflow used to be callable as `/name` (today the message route refuses on a hit, slash.js). A name that
// something else already carries would run the OTHER command through `/name`:
//   · the clients' local slash commands — web `SLASH_COMMANDS` (web/src/components/chat/ChatCatalog.tsx), iOS
//     `slashCatalog` (mobile/CbaseMobile/Chat/ChatViewModel+Slash.swift). This list is a COPY and bound to both
//     (web/test/list-binding.test.mjs);
//   · `workflows`, the Claude CLI command of the same name (a slash that reaches the CLI runs ITS command);
//   · a skill of the same workspace — the route checks that against the database.
// The comparison ignores case: the clients' slash switch reads `/Goal` as `/goal`.

export const LOCAL_SLASH_COMMANDS = Object.freeze(["goal", "compact", "clear", "model", "effort", "mode", "browser", "cost", "help"]);
export const CLI_COMMANDS = Object.freeze(["workflows"]);
export const RESERVED_NAMES = Object.freeze([...LOCAL_SLASH_COMMANDS, ...CLI_COMMANDS]);

// A name is one word for `/name`: no whitespace, no slash, at most 64 characters.
const FORM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Why this name is not allowed — `"form"`, `"reserved"` — or `null` (the route checks skills and duplicates against the DB). */
export function nameForbidden(name) {
  const n = String(name ?? "");
  if (!FORM.test(n)) return "form";
  if (RESERVED_NAMES.includes(n.toLowerCase())) return "reserved";
  return null;
}
