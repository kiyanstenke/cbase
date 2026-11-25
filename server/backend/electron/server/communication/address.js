// The address of a `cbase_agent_send`. A leaf without imports: the tool's `to` becomes the kind of target — the ONE reading
// that the send route (send.js) and the guards hang on.
//
//   wf:<runId>:<n>   an agent of a running dynamic workflow; wf:<runId>:<label> by label (also one not started yet);
//                    wf:<runId> every agent the script starts from now on
//   graph:<startId>  the node agent of a graph workflow in the background
//   channel:<id>     a channel in which the sender is a participant
//   chat:<id>        another chat of the workspace
//   outerloop:<id>   an outer-loop agent — the sender address of its cards; as a TARGET send.js refuses it (400: an outer-loop
//                    agent accepts no messages). It is read so that it never counts as a subagent named "outerloop:…".
//   otherwise        a subagent of one's own: agentId or label (runs/agents.js resolveAgent)
//
// A known prefix without a rest (`chat:`) is NOT a subagent named "chat:": it keeps its kind, with an empty id, and the
// handler answers with the error of its kind — a typo in the prefix would otherwise land silently at a subagent.

const PREFIXES = Object.freeze(["wf", "graph", "channel", "chat", "outerloop"]);

/** `to` → `{kind:"subagent", id}` | `{kind:"wf", runId, n, label?, all?}` | `{kind:"graph", startId}` | `{kind:"channel", channelId}` | `{kind:"chat", chatId}` | `{kind:"outerloop", agentId}`. */
export function readAddress(to) {
  const raw = String(to ?? "").trim();
  const colon = raw.indexOf(":");
  const prefix = colon > 0 ? raw.slice(0, colon) : "";
  if (!PREFIXES.includes(prefix)) return { kind: "subagent", id: raw };
  const rest = raw.slice(colon + 1).trim();
  if (prefix === "channel") return { kind: "channel", channelId: rest };
  if (prefix === "chat") return { kind: "chat", chatId: rest };
  if (prefix === "graph") return { kind: "graph", startId: rest };
  if (prefix === "outerloop") return { kind: "outerloop", agentId: rest };
  // wf:<runId>:<n> — the number is the agent's number in the run (the tree counts from 1); if it is missing or not an
  // integer, `n` stays null and the handler refuses.
  // wf:<runId>:<label> names an agent by its label — also one the script has not called yet (dynworkflows/message.js
  // earmarks it for the next agent with that label); wf:<runId> alone means every agent the script starts from now on.
  const second = rest.lastIndexOf(":");
  const runId = second > 0 ? rest.slice(0, second) : rest;
  const nRaw = second > 0 ? rest.slice(second + 1).trim() : "";
  if (/^\d+$/.test(nRaw)) return { kind: "wf", runId, n: Number(nRaw) };
  return nRaw ? { kind: "wf", runId, n: null, label: nRaw } : { kind: "wf", runId, n: null, all: true };
}
