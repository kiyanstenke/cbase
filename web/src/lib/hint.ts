// The hint row in the history (message role `hint`) — ONE switch for the history views: coding chat (`buildBubbles` in
// components/chat/chatBubbles.ts). The agent dock did not know the role and silently dropped the row.
//
// Leaf module without imports: chatBubbles.ts imports values only relatively from lib/ (reducer.test.mjs transpiles it without
// tsconfig). The row is drawn by `SeparatorRow` (components/chat/SeparatorRow.tsx).

/**
 * The kinds under the bubble role `divider`: without `kind` the compaction, otherwise one of these — including the start and end
 * marker of a dynamic workflow (lib/workflow-marker.ts `markerSeparator`).
 */
export type SeparatorKind = "completionNotice" | "hint" | "workflow-start" | "workflow-end";

/**
 * The separator row from a history row of the role `hint` — the text is already written in the language of the UI (e.g.
 * "Thinking level now medium (before: none)" from chats/auto-gone.js). Empty text ⇒ `null`, no row.
 */
export function hintSeparator(text: string): { role: "divider"; blocks: []; kind: "hint"; label: string } | null {
  return text ? { role: "divider", blocks: [], kind: "hint", label: text } : null;
}
