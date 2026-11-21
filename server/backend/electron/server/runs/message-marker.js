// An agent's message to another run (cause "message") — ONE form, built in ONE place (agent communication).
//
// For the recipient it is the input of a turn and is stored as role `user` — but it is a KIND OF ITS OWN, recognised by its start,
// like a subagent's completion notice (runs/completionNotice.js):
//
//   <cbase-message from="<display name of the sender>" kind="agent|outer_loop" address="<chat:<id>|graph:<startId>|…>">
//   <text, XML-defused>
//   </cbase-message>
//
// The content is FOREIGN TEXT: in the prompt it stands fenced like this (a `</cbase-message>` in the text arrives as `&lt;/…&gt;` and
// does not close the fence), in the history the UIs show it as a card "Message from <from>" instead of a user bubble — read with THE
// SAME rule (web/src/lib/agents-message.ts, mobile/CbaseMobile/Chat/InboundAgentMessage.swift; bound in
// web/test/agents-message-binding.test.mjs). It never counts as human input (runs/human-input.js: only the cause "user" is human).
//
// A leaf without imports — domain-free like the hub (import-direction.test.js).

export const MESSAGE_MARKER = "<cbase-message";
export const MESSAGE_KINDS = Object.freeze(["agent", "outer_loop"]);

const END = "</cbase-message>";

/** XML-defused: & < > " — in this order (the & first, otherwise it would be defused twice). */
export const disarm = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Way back: the &amp; last — otherwise "&amp;lt;" (a typed "&lt;") would become "<".
const back = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

/** The message in its form. A `kind` outside MESSAGE_KINDS is a programming error (throws). */
export function buildMessage({ from, kind = "agent", address = "", text }) {
  if (!MESSAGE_KINDS.includes(kind)) throw new Error(`buildMessage: kind ${JSON.stringify(kind)} — allowed: ${MESSAGE_KINDS.join(", ")}`);
  return `${MESSAGE_MARKER} from="${disarm(from)}" kind="${kind}" address="${disarm(address)}">\n${disarm(text)}\n${END}`;
}

// Reading follows THE SAME five rules as web/src/lib/agents-message.ts and mobile/CbaseMobile/Chat/InboundAgentMessage.swift
// (bound in web/test/agents-message-binding.test.mjs): 1. kind = the text STARTS with the marker; 2. header up to the FIRST `>`;
// 3. values per name="…", the first counts, a missing one is empty; 4. body up to the LAST end element, one line break at each edge
// is dropped; 5. `&amp;` back last. (Demanding here the exact form the server builds itself would make a text without line breaks
// a card for the UI and a user input for the server.)
export function readMessage(text) {
  if (!isMessage(text)) return null;
  const headerEnd = text.indexOf(">", MESSAGE_MARKER.length);
  if (headerEnd < 0) return null;
  const rest = text.slice(headerEnd + 1);
  const end = rest.lastIndexOf(END);
  if (end < 0) return null;
  const values = new Map();
  for (const m of text.slice(MESSAGE_MARKER.length, headerEnd).matchAll(/([a-z_]+)="([^"]*)"/g)) {
    if (!values.has(m[1])) values.set(m[1], back(m[2]));
  }
  let body = rest.slice(0, end);
  if (body.startsWith("\n")) body = body.slice(1);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return { from: values.get("from") ?? "", kind: values.get("kind") ?? "", address: values.get("address") ?? "", text: back(body) };
}

/** Is this a message of this kind? Rule 1: the start decides — a text that begins like this is never a user input. */
export function isMessage(text) { return typeof text === "string" && text.startsWith(MESSAGE_MARKER); }
