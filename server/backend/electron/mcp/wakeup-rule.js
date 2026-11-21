// The ONE promise of the wakeup. It stands verbatim in the system prompt (server/runs/system-prompt.js, "Waiting for something"), in
// the description of cbase_wakeup (mcp/tools/services.js) and — as an instruction after setting — in the answer of the route
// (server/runs/wakeup.js `setWakeup`). All three used to say "the run stays open until then": the wakeup kept the turn's process
// open, and the chat stood as "running" until the wake time. Now it belongs to the chat, like a monitor (mcp/monitor-rule.js).
//
// A leaf without imports: the MCP server (own process) and the server both read it. Guard:
// server/backend/test/wakeup-over-the-turn.test.js.

/** The lifetime of the wakeup — in prompt and description. */
export const WAKEUP_LIFETIME = "The wakeup belongs to the chat: after setting it you end your turn, the chat is free and the user can write in between; at the wake time a new turn begins with your prompt (if one is running, it comes after). At most one per chat — a new one replaces the old; stop=true cancels it, the human can stop it under Background Tasks (you learn that in the next turn). It survives a server restart; if its time has passed in the meantime, it comes right after.";

/** The instruction in the answer to setting. */
export const WAKEUP_AFTER_SETTING = "The wakeup is set. End your turn now — do not sleep, do not poll. At the stated time a new turn begins with your prompt; if the user writes before then, you answer them, and the wakeup stays set.";
