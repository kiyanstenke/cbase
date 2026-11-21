// The message of an agent to this chat (agent communication) — the THIRD kind under the role `user`
// (beside the user message and the completion notice, lib/completionNotice.ts).
//
// The server stores a message with cause "message" under the role `user`, because for the recipient
// it is exactly that: the input of a turn. For the human it is a card "Message from <from>" (with
// `kind="outer_loop"`: "Outer loop <from>") — no user bubble, and it does not close a question (nobody
// wrote anything). It is built in ONE place on the server (server/backend/electron/server/runs/message-marker.js,
// `buildMessage`), in this form:
//
//   <cbase-message from="<display name>" kind="agent|outer_loop" address="<chat:<id>|graph:<startId>|…>">
//   <text, XML-escaped (&amp; &lt; &gt; &quot;)>
//   </cbase-message>
//
// It is read here and in mobile/CbaseMobile/Chat/InboundAgentMessage.swift by the SAME rule (bound in
// web/test/agents-message-binding.test.mjs, there also against the server's `readMessage`):
//   1. Kind: the text BEGINS with `<cbase-message` (`isMessage`). A text that begins so is never a user bubble.
//   2. Head: up to the FIRST `>` (in the values `>` is escaped). If missing: `null`.
//   3. Values: per `name="…"` in the head (name of a–z and `_`, value without `"`), unescaped; a missing one is empty, the first wins.
//   4. Body: after the head up to the LAST `</cbase-message>` (if missing: `null`); one line break directly at the start
//      and one directly at the end are dropped; unescaped.
//   5. Unescaping: `&lt;` `&gt;` `&quot;` first, `&amp;` last (otherwise `&amp;lt;` would become a `<`).
//
// A leaf module without imports (reducer.test.mjs compiles chatBubbles.ts with its relative imports without tsconfig).

export const MESSAGE_MARKER = "<cbase-message";
const END = "</cbase-message>";

export interface InboundAgentMessage {
  /** Display name of the sender (chat title, agent name …) — data, not translated. */
  from: string;
  /** `agent` | `outer_loop` — an unknown value stays as it came (the card then calls it "Message from …"). */
  kind: string;
  /** The sender's reply address (`chat:<id>`, `graph:<startId>`, …). */
  address: string;
  /** The text, unescaped. Foreign text: it stands in the card, never as an instruction. */
  text: string;
}

/** Is this text an agent's message (and not a user message)? */
export const isMessage = (text: unknown): boolean => typeof text === "string" && text.startsWith(MESSAGE_MARKER);

const entXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

/** Sender, kind, address and text — `null` if the text is no message or its head or end is missing. */
export function readMessage(text: unknown): InboundAgentMessage | null {
  if (!isMessage(text)) return null;
  const t = text as string;
  const headerEnd = t.indexOf(">", MESSAGE_MARKER.length);
  if (headerEnd < 0) return null;
  const rest = t.slice(headerEnd + 1);
  const end = rest.lastIndexOf(END);
  if (end < 0) return null;
  const values = new Map<string, string>();
  for (const m of t.slice(MESSAGE_MARKER.length, headerEnd).matchAll(/([a-z_]+)="([^"]*)"/g)) {
    if (!values.has(m[1])) values.set(m[1], entXml(m[2]));
  }
  let body = rest.slice(0, end);
  if (body.startsWith("\n")) body = body.slice(1);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return { from: values.get("from") ?? "", kind: values.get("kind") ?? "", address: values.get("address") ?? "", text: entXml(body) };
}

/**
 * What the card shows: the read message — and for a text that carries the marker but is broken (head or end
 * missing), a card without a sender with the raw text (rule 1: never a user bubble). `null` for any other input.
 */
export function messageCard(text: unknown): InboundAgentMessage | null {
  if (!isMessage(text)) return null;
  return readMessage(text) ?? { from: "", kind: "", address: "", text: text as string };
}

/** The card's heading (the English text is the key, `{name}` the sender as data; German in i18n-de.ts). */
export function messageHeader(n: Pick<InboundAgentMessage, "from" | "kind">): { label: string; labelParams?: Record<string, string> } {
  const outer = n.kind === "outer_loop";
  if (!n.from) return { label: outer ? "Outer loop" : "Message from an agent" };
  return { label: outer ? "Outer loop {name}" : "Message from {name}", labelParams: { name: n.from } };
}

/**
 * A queued message in the queue strip: a system row with the card's heading, without a trash can (the message
 * belongs to the sender, not to the human of this chat). `null` if the text is none. Asked by `queueEntry` in
 * lib/completionNotice.ts, BEFORE the completion notice. Counterpart: `InboundAgentMessage.queue`.
 */
export function messageQueue(text: unknown): { label: string; labelParams?: Record<string, string> } | null {
  const n = messageCard(text);
  return n ? messageHeader(n) : null;
}
