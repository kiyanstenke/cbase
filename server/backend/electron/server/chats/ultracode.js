// Ultracode is a TOGGLE beside the effort level — two independent axes.
//
//   • `chats.effort` and `chats.ultracode` do NOT affect each other. Enabling does not change the level, a new level does
//     not disable the mode, a model switch leaves it, and a model without levels can carry it.
//   • Ultracode only steers BEHAVIOUR: reminder and guide for dynamic workflows (`dynworkflows/reminder.js`), their opt-in
//     (`dynworkflows/approval.js`) and no subagent cap (`runs/agents.js`).
//
// ONE place for all write paths: every `store.updateChat`/`store.createChat` in the server tree whose fields can carry
// level, model, provider or mode passes them through `ultracodeFollowUp` — guard
// `server/backend/test/ultracode-rule.test.js` (rule AND source: no such call bypasses it). The rule is the independence
// itself: it normalises the toggle to 0/1 (SQLite binds no booleans) and touches no other value. A future path that wants
// to couple again must do it HERE — and turns the guard red.

/**
 * The fields of a chat write, with the toggle as 0/1 — otherwise unchanged.
 * @param {object|null} _chat  the chat BEFORE the write (`null` on creation) — the rule no longer needs it
 * @param {object} fields      the fields for `store.updateChat`/`store.createChat`
 * @returns {object} without `ultracode` the same object; with `ultracode` a new one, the toggle as 0/1, level/model/provider
 *   exactly as passed.
 */
export function ultracodeFollowUp(_chat, fields) {
  if (!("ultracode" in fields)) return fields;
  return { ...fields, ultracode: fields.ultracode ? 1 : 0 };
}
