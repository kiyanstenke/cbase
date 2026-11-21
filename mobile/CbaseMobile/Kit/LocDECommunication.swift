import Foundation

// German translations: agent communication.
let LocDECommunication: [String: String] = [
    "Write this agent a message — also a waiting one: it then reads it when it starts.": "Diesem Agenten eine Nachricht schreiben — auch einem wartenden: dann liest er sie beim Start.",
    "The agent sees it as “Message from the human”.": "Beim Agenten steht sie als „Nachricht vom Menschen“.",
    "after its turn": "nach seinem Turn",
    "queued": "vorgemerkt",
    "not delivered": "nicht zugestellt",
    "Message from the human": "Nachricht vom Menschen",
    "Message from the main agent": "Nachricht vom Hauptagenten",
    "Reason: {reason}": "Grund: {reason}",
    // Channel and agent message card
    "to {name}": "an {name}",
    "This many agent rounds run without you; then the channel pauses (0 = no cap).": "So viele Agentenrunden laufen ohne dich, dann pausiert der Kanal (0 = ohne Deckel).",
    "Message from {name}": "Nachricht von {name}",
    "Message from an agent": "Nachricht eines Agenten",
    "Outer loop {name}": "Outer Loop {name}",
    "Outer loop": "Outer Loop",
    // Channel reopen, system kinds and wait reasons (not literal; checked by web/test/list-binding.test.mjs)
    "Reopen": "Wieder öffnen",
    "The chats can write to each other again": "Die Chats können einander wieder schreiben",
    "Nothing is delivered until you resume — messages are kept": "Nichts wird zugestellt, bis du fortsetzt — Nachrichten werden abgelegt",
    "It delivers nothing afterwards until you reopen it here in the ⋯ menu; the log stays readable.": "Danach stellt er nichts mehr zu, bis du ihn hier im ⋯-Menü wieder öffnest; der Verlauf bleibt lesbar.",
    "Target archived": "Ziel archiviert",
    "Reopened": "Wieder geöffnet",
    "Expired": "Verfallen",
    "Delivered after its turn": "Wird nach seinem Turn zugestellt",
    "Chat archived — delivered when you restore it": "Chat archiviert — wird zugestellt, wenn du ihn zurückholst",
    "Waiting for your answer in the chat": "Wartet auf deine Antwort im Chat",
    "Waiting for a workflow gate": "Wartet auf ein Gate des Workflows",
    "Not delivered yet — the run is still going": "Noch nicht zugestellt — der Lauf ist noch nicht fertig",
    // Channels and subagents
    "A channel is created when an agent writes to this chat or this chat writes to another coding chat.": "Ein Kanal entsteht, wenn ein Agent diesem Chat schreibt oder dieser Chat einem anderen Coding-Chat.",
    "When set, ONLY what is listed applies: built-in tools and cbase tools (cbase_projects_list, all: mcp__cbase). MCP servers are not listed here — they are chosen on the web at the agent type under “MCP servers”; saving here keeps them. Codex keeps its built-in tools (shell, patch, web search) — there the list only applies to cbase tools.": "Gesetzt gilt NUR das Gelistete: eingebaute Werkzeuge und cbase-Werkzeuge (cbase_projects_list, alle: mcp__cbase). MCP-Server stehen hier nicht — die wählt man im Web am Agententyp unter „MCP-Server“; ein Speichern hier lässt sie stehen. Codex behält seine eingebauten Werkzeuge (Shell, Patch, Websuche) — dort gilt die Liste nur für cbase-Werkzeuge.",
    "1 MCP server": "1 MCP-Server",
    "{n} MCP servers": "{n} MCP-Server",
]
