// Quotes from the history: "Reply" on selected text. The selection appears as ChatGPT shows it: a card above the input (per quote "1.",
// "Selected text:", the quote, pencil and trash can) and in the field the mark "1 comment" with an × for all.
//
// ChatPane holds the quotes as their own list beside the text, and only on sending does it become exactly what used to be in the field:
// every line with "> " (the fence around foreign text; a quote is data, not an instruction), several quotes separated by a blank line,
// the person's own message behind them. A quote in front also means the message never begins with "/" and is thus never read as a
// command (the composer therefore does not offer the slash picker while quotes are waiting). iOS computes the same in
// `Chat/ChatViewModel+Quotes.swift`.
//
// And not in the MIDDLE of the text either: the server reads `/workflow:<shortname>` anywhere in the message, but skips a quote line
// (`server/backend/electron/server/workflows/shortName.js:mentions`). Otherwise a quoted agent sentence containing `/workflow:x` would
// become the person's instruction, and a quoted unknown name would make the reply unsendable. The "> " on EVERY line is therefore a
// contract: `web/test/slash.test.mjs` holds this form against the server computation.

/** A quote as a markdown quote block: every line with "> ". */
export function quoteBlock(text: string): string {
  return text.split("\n").map((row) => `> ${row}`).join("\n");
}

/** The message as it goes out: the quotes in front, the input behind them. Without quotes it is unchanged. */
export function withQuotes(quotes: readonly string[], text: string): string {
  const blocks = quotes.map((z) => z.trim()).filter(Boolean).map(quoteBlock);
  if (blocks.length === 0) return text;
  return text ? [...blocks, text].join("\n\n") : blocks.join("\n\n");
}
