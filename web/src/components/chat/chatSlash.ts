// The command switch of the coding chat (/help, /cost, /clear, /goal, /compact, /model, /effort, /mode, /browser).
// `runSlash(text, attachments, h)`: what it needs from the ChatPane component's closure it gets as handler map `h`
// (`SlashHandler`) and pulls out in ONE line at the head (destructuring instead of an `h.` prefix, so every body line
// stays plain and a handler is called without `this`). ChatPane holds the wrapper `runSlash(text, attachments)` and builds
// the map at the call from its states and handlers, each under its own name (`web/test/composer-contract.test.mjs` counts
// map, destructuring and type against each other). No React, no state, no ref writing: the switch reads the chat only
// through `h` (activeIdRef read only). NOT a leaf module like chatBubbles.ts: the catalog (`ChatCatalog.tsx`: SLASH_COMMANDS,
// SLASH_RE, the aliases, the model fallbacks) carries JSX (withSlashGlow), so values come via `@/`, not relative.
import { api, type Attachment } from "@/lib/api";
import { isInsertion, targetText } from "@/lib/slash";
import { CLAUDE_MODELS, CODEX_MODELS, EFFORT_ALIAS, MODEL_ALIAS, MODE_ALIAS, PERM_MODES, SLASH_COMMANDS, SLASH_RE, aliasProvider } from "@/components/chat/ChatCatalog";
import { type EffortCatalog, ULTRACODE, effortSelection, effortEntryLabel, effortLevels, effortWithoutSelection, effortWithoutSelectionText } from "@/lib/effort";

// What the switch needs from ChatPane, one line per value, in the order of first access in the body. Values are the state of
// the render in which `send` ran; handlers are ChatPane's functions. `/effort` computes the fallback itself instead of
// taking apart a finished label, so the map carries `currentEffort`.
export type SlashHandler = {
  t: (key: string, params?: Record<string, string | number>) => string;
  pushInfo: (title: string, body: string) => void; // info bubble into the history
  showCost: () => void; // /cost: the computation over the run summaries stays in ChatPane
  clearContext: () => Promise<void>; // /clear
  goal: string; // the goal of the open chat (state of the render)
  clearGoal: () => Promise<void>;
  activeIdRef: { readonly current: string | null }; // read only: the id of the open chat at the time of access
  ensureChat: () => Promise<string>; // creates the chat if none is open yet
  goalPaused: boolean; // the goal rests: `/goal` without text names it
  setGoal: (target: string) => void;
  loadList: () => Promise<unknown>; // refresh the list (the goal lives on the chat)
  compact: (instruction?: string) => Promise<void>; // /compact [instruction]
  pickerProviders: { id: string; label: string; models: { id: string; label: string }[] }[]; // all CONNECTED providers with models: /model picks from these, and what is not connected could not be started
  currentModelLabel: string;
  currentProvider: string;
  pickModel: (providerId: string, id: string) => Promise<"applied" | "deferred">;
  effectiveModel: string; // the EFFECTIVE model (an empty chat choice already resolved to the provider default): /effort needs it because levels hang on the model and '' is in no catalog
  allProviders: EffortCatalog; // ALL providers, also unconnected ones: which levels a model carries depends on the model, not the login
  currentEffort: string; // the SET level, raw ('' only for a chat without a stored level, which thinks with the default): /effort names the level that really thinks (label plus fallback), not the finished button label
  ultracode: boolean; // ultracode: the open chat's toggle or the preselection; /effort names it, `/effort ultracode` flips it (locally, never to the CLI)
  setUltracode: (on: boolean) => Promise<void>; // the toggle alone, the level stays
  pickEffort: (id: string) => Promise<void>;
  currentPermLabel: string;
  pickPerm: (id: string) => Promise<void>;
};

// Intercept native slash commands (known ones only; everything else goes to the LLM as usual, so real messages like paths
// "/Users/…" are not hijacked).
// Return: false = no command, true = handled locally, {send, display} = command executed AND the text is to be sent as a task
// (/goal counts as a prompt, as in the CLI); display = the original input including the "/goal" prefix for bubble + history.
// `attachments`: what currently hangs in the composer; /goal folds insertions of it into the goal.
export async function runSlash(text: string, attachments: Attachment[], h: SlashHandler): Promise<boolean | { send: string; display: string }> {
  const { t, pushInfo, showCost, clearContext, goal, clearGoal, activeIdRef, ensureChat, goalPaused, setGoal, loadList, compact, pickerProviders, currentModelLabel, currentProvider, pickModel, effectiveModel, allProviders, currentEffort, ultracode, setUltracode, pickEffort, currentPermLabel, pickPerm } = h;
  // `/workflow:<short name>` is NOT a command of this switch: `workflow` is not in SLASH_COMMANDS, the line falls through to
  // `SLASH_RE` below and goes to the server as an ordinary message.
  const m = text.match(SLASH_RE);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();
  if (cmd === "help") {
    // The line is set HERE, only the description is translated: name and argument form of a command are the same characters in
    // every language.
    const rows = SLASH_COMMANDS.map((b) => `**/${b.name}**${b.arg ? ` \`${b.arg}\`` : ""} — ${t(b.description)}`);
    pushInfo("Commands", rows.join("\n\n"));
    return true;
  }
  if (cmd === "cost") { showCost(); return true; }
  if (cmd === "clear") {
    await clearContext();
    return true;
  }
  if (cmd === "goal") {
    // /goal clear (or `löschen`): remove the goal, as in the Claude Code CLI.
    if (/^(clear|löschen)$/i.test(arg)) {
      if (!goal.trim()) { pushInfo("Goal", t("No goal set. Use `/goal <text>` to set one.")); return true; }
      await clearGoal();
      pushInfo("Goal cleared", t("The overarching goal has been removed."));
      return true;
    }
    const id = activeIdRef.current || (await ensureChat());
    // Pasted text belongs INTO the goal (targetText in lib/slash.ts): it stood behind "/goal" in the field before the composer
    // turned it into a file. The file is already at the server (addPastedText uploads on paste); the in-memory preview carries
    // only 420 characters.
    const insertions = await Promise.all(attachments.filter(isInsertion).map(async (a) => {
      try { return String(await api<string>(`/api/chats/${id}/attachments/${encodeURIComponent(a.file)}`)); }
      catch { return ""; }
    }));
    const target = targetText(arg, insertions);
    if (!target) {
      const state = goalPaused ? t("Current goal of this chat (paused):\n\n{goal}", { goal }) : t("Current goal of this chat:\n\n{goal}", { goal });
      pushInfo("Goal", goal ? state : t("No goal set. Use `/goal <text>` to set one."));
      return true;
    }
    await api(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ goal: target }) });
    setGoal(target);
    loadList().catch(console.error);
    // The typed text counts as a prompt too (the insertion travels along as an attachment); the bubble shows the input with "/goal".
    return { send: arg, display: text.trim() };
  }
  if (cmd === "compact") {
    if (!activeIdRef.current) { pushInfo("Note", t("There is no history to compact yet.")); return true; }
    compact(arg);
    return true;
  }
  if (cmd === "model") {
    const key = arg.toLowerCase().replace(/\s+/g, "");
    // All models of ALL connected providers are searchable (the choice sets the provider too).
    const all = pickerProviders.flatMap((pv) => pv.models.map((mo) => ({ provider: pv.id, id: mo.id, label: mo.label })));
    if (!key) { pushInfo("Model", t("Current: **{model}**\n\nAvailable: {list}. Use e.g. `/model {example}`.", { model: t(currentModelLabel), list: all.filter((x) => x.id).map((x) => x.label).join(", "), example: currentProvider === "codex" ? "gpt-6-sol" : "sonnet" })); return true; }
    let hit = all.find((x) => x.id.toLowerCase() === key || x.label.toLowerCase().replace(/\s+/g, "") === key);
    if (!hit && (key === "standard" || key === "default")) hit = { provider: currentProvider, id: "", label: "Default" };
    if (!hit && key in MODEL_ALIAS) {
      const id = MODEL_ALIAS[key];
      hit = { provider: aliasProvider(id), id, label: [...CLAUDE_MODELS, ...CODEX_MODELS].find((m) => m.id === id)?.label ?? "Default" };
    }
    if (!hit) { pushInfo("Model", t("Unknown: \"{arg}\". Available: {list}.", { arg, list: all.filter((x) => x.id).map((x) => x.label).join(", ") })); return true; }
    const outcome = await pickModel(hit.provider, hit.id);
    // A provider switch with history opens the warning modal and is applied only after confirmation; so do NOT report "Model set"
    // prematurely (the user takes over confirm/cancel).
    if (outcome === "deferred") return true;
    pushInfo("Model set", t(hit.label));
    return true;
  }
  if (cmd === "effort") {
    // Short forms: `mid`/`med` ⇒ medium, `x-high` ⇒ xhigh, from the bound table (ChatCatalog.tsx), then checked like any word.
    const raw = arg.toLowerCase().replace(/\s+/g, "");
    const key = Object.hasOwn(EFFORT_ALIAS, raw) ? EFFORT_ALIAS[raw] : raw;
    // `/effort ultracode` flips the TOGGLE locally, also with an attachment and also on a model without levels: the switch ends
    // here, the word never reaches the CLI (it knows `--effort ultracode` and would run its own mode otherwise). The level stays.
    if (key === ULTRACODE) {
      await setUltracode(!ultracode);
      pushInfo("Effort", t(ultracode ? "Ultracode off." : "Ultracode on."));
      return true;
    }
    // Which levels apply depends on the MODEL, not on the command: gpt-5.5 rejects "max" with HTTP 400, so a fixed list here
    // would offer it anyway. A word outside the list answers "Unknown" and sets nothing. Without a catalog entry (third party, a
    // model outside the catalog) it stays the five default levels (lib/effort.ts). Asked is the EFFECTIVE model and in ALL
    // providers: a chat without its own choice carries '' (in no catalog), and a provider whose login reports `connected:false`
    // still runs its models with the same levels; both would otherwise fall back to the five default levels and offer "max"
    // where a 400 waits. If the model carries NO levels (Haiku 4.5), there is nothing to choose or set; the command says so
    // instead of an empty list, and nothing goes to the CLI. The same when the provider has `caps.effort` off: the decision
    // stands ONCE in the building block (`effortWithoutSelection`), the sentence names the reason.
    const without = effortWithoutSelection(currentProvider, effectiveModel, allProviders);
    if (without) {
      pushInfo("Effort", t(effortWithoutSelectionText(without)));
      return true;
    }
    const levels = effortLevels(currentProvider, effectiveModel, allProviders);
    const list = levels.join(", ");
    if (!key) {
      // Named is the level that THINKS, not the stored one. If the model does not carry it, the spawn clamps it
      // (`effortFallback`), and "Current: **Max**" above a list without "max" would be half the truth. Labelled through the same
      // helper as the three pickers; a fourth wording ages a fourth time. Ultracode is named beside it, each on its own.
      const choice = effortSelection(currentProvider, effectiveModel, allProviders, currentEffort).find((w) => w.id === currentEffort);
      // Without a stored level `currentEffort` already names the running one (default, clamped; `useModelChoice`).
      const now = (choice ? effortEntryLabel(choice, t) : t("Default")) + (ultracode ? " · Ultracode" : "");
      pushInfo("Effort", t("Current: **{effort}**\n\nChoose: {list}.", { effort: now, list: `${list}, ${ULTRACODE}` }));
      return true;
    }
    // "auto" no longer exists: a word like any other outside the list; "Unknown", local, it never reaches the CLI (the switch
    // ends here, also with an attachment).
    if (!levels.includes(key)) { pushInfo("Effort", t("Unknown: \"{arg}\". Available: {list}.", { arg, list: list })); return true; }
    await pickEffort(key);
    pushInfo("Effort set", key);
    return true;
  }
  if (cmd === "mode") {
    const key = arg.toLowerCase().replace(/\s+/g, "");
    if (!key) { pushInfo("Mode", t("Current: **{mode}**\n\nChoose: full, auto, plan, ask.", { mode: t(currentPermLabel) })); return true; }
    if (!(key in MODE_ALIAS)) { pushInfo("Mode", t("Unknown: \"{arg}\". Available: full, auto, plan, ask.", { arg })); return true; }
    const id = MODE_ALIAS[key];
    await pickPerm(id);
    pushInfo("Mode set", t(PERM_MODES.find((mo) => mo.id === id)?.label ?? id));
    return true;
  }
  if (cmd === "browser") {
    // The agents' browser ALWAYS runs headless; the command stays so that "/browser …" does not go to the CLI (an unknown
    // command swallows the message there), and says how it is.
    pushInfo("Browser", t("The agents' browser always runs in the background (headless). In the browser of the right chat sidebar you can watch it and take over."));
    return true;
  }
  return false;
}
