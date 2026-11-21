// runs/upstream-display.js — the provider BEHIND a router that delivered the last response, and its context window. DISPLAY ONLY:
// OpenRouter picks the provider anew PER REQUEST (by price and load), and the computation keeps using the catalog number `context`
// (transcript budget, `compactAt`, post-run.js).
//
// The engine puts the name on message_start (`message.provider`), runs/do-run.js calls `report(name)` at every
// message_start of the main stream, the connector resolves the window (`providerWindow`, providers/openrouter-endpoints.js). Asynchronous
// and caught: the event path never waits, an error never disturbs the run; window 0 = unknown, the name counts anyway.
//
// Split out of do-run.js so that the three promises have a path that runs without a clock (server/backend/test/upstream-display.test.js):
//   1. The NEWEST resolution of a chat wins — across runs. The counter therefore lives per chat in the module, not per run: a lookup
//      that hung in the previous run would otherwise overwrite the next run's provider after its end.
//   2. If the chat's model or provider changed meanwhile, nothing is written (the name belonged to the old model; store/chats.js
//      updateChat clears both fields on a change).
//   3. Every run begins EMPTY and resolves the first reported name anew (the endpoint cache, 1 h, makes that cheap). Preloaded from
//      the chat, the window of the old model stayed after a change of the DEFAULT model (chat.model = "") as long as the same name
//      answered — measured 1,048,576 instead of 131,072.
// Within a run: a name that is being resolved or already has a window is not asked again; one without a window gets ONE attempt per run.
//
// A leaf without imports: store, stream and connector come as callbacks.

// chatId → number of the newest started resolution. A small counter per chat that is never deleted (one number per chat that
// ever ran through a router).
const followUps = new Map();

/**
 * @param {{ chatId: string, model: string, provider: string,
 *           resolve: (name: string) => Promise<number>|number,
 *           getChat: (id: string) => ({ model?: string, provider?: string }|null|undefined),
 *           write: (name: string, window: number) => void }} o
 *   `model`/`provider`: as they stood on the chat AT RUN START (`chat.model` may be "" = default).
 * @returns {(name: string) => Promise<boolean>|null}  `report`: null = not asked; otherwise whether it was written.
 */
export function upstreamReporter({ chatId, model, provider, resolve, getChat, write }) {
  let state = { provider: "", window: 0 };
  let flightText = "";
  const attempted = new Set();
  return function report(name) {
    if (!name || name === flightText) return null;
    if (name === state.provider && (state.window > 0 || attempted.has(name))) return null;
    attempted.add(name);
    flightText = name;
    const followUp = (followUps.get(chatId) || 0) + 1;
    followUps.set(chatId, followUp);
    return Promise.resolve()
      .then(() => resolve(name))
      .catch(() => 0)
      .then((f) => {
        if (flightText === name) flightText = "";
        if (followUps.get(chatId) !== followUp) return false;
        const now = getChat(chatId);
        if (!now || (now.model || "") !== (model || "") || (now.provider || "") !== (provider || "")) return false;
        const window = Number(f) > 0 ? Math.floor(Number(f)) : 0;
        state = { provider: name, window };
        write(name, window);
        return true;
      })
      .catch(() => false);
  };
}
