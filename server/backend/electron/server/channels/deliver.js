// Delivery to ONE chat (deliverToChat): as a user message would do it — a waiting workflow, otherwise deliverUserPrompt.
// Its only caller is the general delivery of every channel (./delivery.js deliverChannel). An open question card holds
// EVERY channel delivery like a gate — deliverChannel checks that before the call, and if one arrives here anyway, nothing
// is delivered.

import * as store from "../store.js";
import { answerWorkflow } from "../workflows/gates.js";
import { openAskOf } from "../runs/ask.js";
import { sse } from "../runtime/sse.js";
import { deliverUserPrompt } from "../runs/queue.js";

// DELIVER a message to a chat as a user message would: if the chat's workflow is waiting for an answer, the text IS the
// answer (as on the /message path); otherwise normal delivery through deliverUserPrompt. There is exactly ONE place that
// knows what "writing to a chat" means.
// `opts`: `prompt` = what the model gets (default: the text itself); `cause`/`silent` are passed on to deliverUserPrompt;
// `overChannel` names the channel.
function deliverToChat(chat, text, opts = {}) {
  // `cause` has no default: if it is missing, deliverUserPrompt runs as "user" but does not count it as human input.
  const { prompt = text, display = text, cause, silent = false } = opts;
  // An open question card is the question to the human: it holds the delivery — nothing is delivered.
  if (openAskOf(chat.id)) return { delivered: false, viaAsk: false, held: "question" };
  if (store.getWorkflowRun(chat.id)?.status === "waiting") {
    // `silent`: the channel card is already in the history, a user row next to it would be a second one.
    if (!silent) {
      store.addMessage(chat.id, "user", text, Date.now());
      sse(chat.id, { type: "harness", subtype: "user_message", text, attachments: [] });
    }
    answerWorkflow(chat, text).catch((e) => console.error("[deliver] workflow answer:", e?.message || e));
    return { delivered: true, viaAsk: false, workflow: true };
  }
  const delivery = deliverUserPrompt(chat, { prompt, display, cause, silent });
  return { delivered: true, viaAsk: false, delivery };
}

export { deliverToChat };
