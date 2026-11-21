// The model and effort choice of the coding chat as a hook: `useModelChoice(deps)` holds the provider lists (loaded from
// /api/providers), the preselection of the NEXT chat (provider, model, level), the provider's default, the EFFECTIVE model
// with its label, the current level with its label, and setting the level (`pickEffort`, with the open state of its
// picker). What the bodies read as closure in ChatPane (the open chat `activeId`/`activeChat`, the ref for the moment of the
// click, and the list loader) comes in as arguments. Why an object and not a getter as with `useHistoryCache`: the values
// are needed in the RENDER (composer, stage, bar, slash switch), and ChatPane calls the hook only after `activeChat`.
//
// NOT here: `pickModel`/`doProviderSwitch` with the warning sheet (they read the history and open the provider-switch sheet;
// `composer-contract.test.mjs` keeps them in ChatPane) and the open state of the model picker (pickModel closes it).
// Permissions and browser also stay in ChatPane; they are no model choice.
//
// The effort follow-ups docked here (no "Auto": the preselection is the clamped default level; ultracode: `ultracode`,
// `effortForCreation`), because ChatPane sits at the line guard.
import { useEffect, useState } from "react";
import { api, type Chat } from "@/lib/api";
import { effortFallback, effortLabel, effortChoiceBody, ultracodeBody, type EffortTranslator } from "@/lib/effort";
import { CLAUDE_MODELS, CODEX_MODELS, DEFAULT_MODEL_FALLBACK, modelLabelFor } from "@/components/chat/ChatCatalog";
import type { ProviderMeta } from "@/components/chat/ChatCatalog";

// The model line of a chat row's tooltip (components/chat/ChatTooltip.tsx): "Opus 5.5 · High", "… · Ultracode", for a third
// party "GLM 5.3 Flash · OpenRouter". `marker` picks the sign: the two subscription providers carry their own mark, any
// other a neutral one (ProviderMark would draw Claude's for it).
//
// Computed like the server (`providerForChat`, doRun): an empty provider is the GLOBALLY active one (`active`), an empty
// model is that provider's default model from /api/providers. Both are only known with the loaded list; before that
// (`active === null`) a chat without its own provider or model gets NO line: "claude" or the static fallback would be a
// claim (trigger chats and old chats carry `provider: ""`, and with Codex active the card showed the Claude mark and model).
export type ModelRow = { marker: "claude" | "codex" | "third"; text: string };
export function modelRow(
  chat: { provider?: string; model?: string; effort?: string; ultracode?: boolean },
  catalog: ProviderCatalog,
  t: EffortTranslator,
): ModelRow | null {
  const { providers, active } = catalog;
  const prov = chat.provider || active;
  if (!prov || (!chat.model && active === null)) return null;
  const marker = prov === "claude" ? "claude" : prov === "codex" || prov === "openai" ? "codex" : "third";
  const model = chat.model || providers.find((p) => p.id === prov)?.defaultModel || DEFAULT_MODEL_FALLBACK[prov] || "";
  const name = modelLabelFor(prov, model, providers);
  const provider = providers.find((p) => p.id === prov)?.label || prov;
  const parts: string[] = [name || provider];
  if (marker === "third" && name) parts.push(provider);
  // Level and ultracode are two axes: both appear in the line, each on its own.
  if (chat.effort) parts.push(t(effortLabel(chat.effort)));
  if (chat.ultracode) parts.push("Ultracode");
  return { marker, text: parts.join(" · ") };
}

/** The provider list from /api/providers with the globally active provider; `active: null` while it is not loaded. */
export type ProviderCatalog = { providers: ProviderMeta[]; active: string | null };

// What the hook reads from ChatPane, one line per value.
export type ModelChoiceDeps = {
  activeId: string | null; // open chat (render state): does it carry its own values, or does the preselection apply?
  activeChat: Chat | null | undefined; // its settings (provider, model, level): `chats.find(…) ?? archiveChat`
  activeIdRef: { readonly current: string | null }; // read only: the open chat at the MOMENT of the click (pickEffort)
  loadList: () => Promise<unknown>; // after the PATCH reload the list; it carries the chat's settings
};

export function useModelChoice({ activeId, activeChat, activeIdRef, loadList }: ModelChoiceDeps) {
  const [modelSel, setModelSel] = useState(""); // model for the next (not yet created) chat
  const [effortSelected, setEffortSel] = useState(""); // effort for the next (not yet created) chat, as chosen
  const [ultracodeSel, setUltracodeSel] = useState(false); // ultracode for the next chat
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  // Active provider (global) + all providers (models/connection status); the model picker shows the models of ALL connected
  // providers, and the choice sets the chat's provider too.
  const [globalProvider, setGlobalProvider] = useState<string>("claude");
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [providerSel, setProviderSel] = useState(""); // provider of the next (not yet created) chat; "" = global default
  useEffect(() => {
    api<{ active: string; providers: ProviderMeta[] }>("/api/providers")
      .then((d) => { setGlobalProvider(d.active || "claude"); setProviders(d.providers || []); })
      .catch(() => {});
  }, []);

  // Active provider of this context: the open chat carries its own, a new chat the preselection.
  const currentProvider = (activeId ? (activeChat?.provider || globalProvider) : (providerSel || globalProvider)) || "claude";
  // All known providers, also NOT connected ones, with their measured effort levels (`efforts` per model; the type for it is
  // `EffortCatalog` from lib/effort.ts, so the field does not silently vanish at the next rewrite of this line).
  //
  // Two lists with ONE difference, for a reason: the model picker shows only connected ones (a model of a logged-out provider
  // could not start). Which reasoning levels a model carries depends on the model, not on the login. If the connected-only
  // list were used, a user whose Codex shows `connected:false` would fall PERMANENTLY back to the five default levels, so
  // "max" even for gpt-5.5 (HTTP 400). The window is not short either: /api/providers waits on `codex login status` with a
  // 15 s timeout. `providers` itself carries every provider with its `connected` flag; the server filters nothing out.
  const allProviders: { id: string; label: string; caps?: { effort?: boolean }; models: { id: string; label: string; efforts?: string[] }[] }[] =
    providers.length ? providers : [
      { id: "claude", label: "Claude Code", models: CLAUDE_MODELS },
      { id: "codex", label: "OpenAI Codex", models: CODEX_MODELS },
    ];
  // Model picker: models of ALL connected providers (fallback before the fetch: both).
  const pickerProviders: { id: string; label: string; models: { id: string; label: string }[] }[] =
    providers.length ? providers.filter((p) => p.connected) : allProviders;
  // Default model of a provider (from /api/providers, selectable in settings), fallback before the fetch. An empty chat model
  // ('' = old chat or no choice) is resolved to it, so the picker NEVER shows "Default" but always a concrete name.
  function providerDefault(prov: string) {
    return providers.find((p) => p.id === prov)?.defaultModel || DEFAULT_MODEL_FALLBACK[prov] || "";
  }
  // Current model: for the open chat its setting, otherwise the composer preselection. '' means "no own choice" (new chat,
  // old chat without a model); what then REALLY runs is the provider default. Outward therefore goes only `effectiveModel`:
  // context window, label, model picker, effort choice and /effort all hang on the effective model, and a '' would have no
  // context window, no levels and no name there (see composer and chatSlash).
  const currentModel = activeId ? (activeChat?.model ?? "") : modelSel;
  const effectiveModel = currentModel || providerDefault(currentProvider);
  // The label comes from `modelLabelFor` and not from `currentModels`: a model that /api/providers withholds (gpt-5.4 and
  // gpt-5.4-mini while the account is a ChatGPT subscription) is in NO loaded list; the pill would then show the raw id and
  // the picker no check mark.
  const currentModelLabel = modelLabelFor(currentProvider, effectiveModel, providers);

  // The level of the NEXT chat: chosen, otherwise the default level of its provider from /api/providers, clamped to the
  // effective model, so creation stores a concrete level. A model without levels clamps to "" (no level); without a loaded
  // provider list it stays empty, and the run resolves the default itself (`effortRunning` on the server; that is the guard,
  // not this preset).
  const defaultLevel = providers.find((p) => p.id === currentProvider)?.defaultEffort || "";
  const effortSel = effortSelected || (defaultLevel ? effortFallback(currentProvider, effectiveModel, allProviders, defaultLevel) : "");
  // An open chat without a stored level (only one a server path created empty) shows the level that RUNS: the provider's
  // default level, clamped to its model, the same resolution as `effortRunning` on the server. "" remains only without
  // levels (Haiku) or without a loaded list.
  const chatStandard = defaultLevel ? effortFallback(currentProvider, effectiveModel, allProviders, defaultLevel) : "";
  const currentEffort = activeId ? (activeChat?.effort || chatStandard) : effortSel;
  // Ultracode: a TOGGLE next to the level. Open chat ⇒ its field, new chat ⇒ the preselection. A chat from an old server
  // does not carry the field; then the mode is off, not unknown-on.
  const ultracode = activeId ? activeChat?.ultracode === true : ultracodeSel;
  // Label of the set level. It comes from the SHARED table, not from a list of selectable levels: only what the model
  // carries is selectable, but a chat that stored another level should still show it legibly. The level alone; the composer
  // shows ultracode next to it.
  const currentEffortLabel = currentEffort ? `Effort: ${effortLabel(currentEffort)}` : "Effort: Standard";
  // Choosing a level in the picker and via `/effort <level>`: sets ONLY the level, the ultracode toggle stays. There is no
  // empty entry ("Auto"); the server rejects `{effort: ""}` with 400. The body is the ONE of the explicit choice
  // (lib/effort.ts `effortChoiceBody`, with `effortChoice: true`).
  async function pickEffort(id: string) {
    setEffortPickerOpen(false);
    if (!id) return;
    if (activeIdRef.current) {
      await api(`/api/chats/${activeIdRef.current}`, { method: "PATCH", body: JSON.stringify(effortChoiceBody(id)) });
      loadList().catch(console.error);
    } else {
      setEffortSel(id);
    }
  }
  // The ultracode toggle (toggle in the effort sheet and `/effort ultracode`): sets ONLY the toggle, the level stays.
  async function setUltracode(on: boolean) {
    if (activeIdRef.current) {
      await api(`/api/chats/${activeIdRef.current}`, { method: "PATCH", body: JSON.stringify(ultracodeBody(on)) });
      loadList().catch(console.error);
    } else {
      setUltracodeSel(on);
    }
  }
  // What creating the next chat sends along (three creation paths in ChatPane): the level and, if preselected, the toggle.
  const effortForCreation: { effort: string; ultracode?: true } = ultracodeSel ? { effort: effortSel, ultracode: true } : { effort: effortSel };

  // The model line of the tooltip of ANY chat in the list (not the open one), with the loaded provider list and the globally
  // active provider (a chat without its own runs with it, like `currentProvider` above). Loaded means the list is not empty;
  // /api/providers carries every provider, also unconnected ones; before that `globalProvider` is only the preset "claude",
  // no information.
  const describeModel = (chat: Chat, t: EffortTranslator) =>
    modelRow(chat, { providers, active: providers.length ? globalProvider : null }, t);

  return {
    describeModel,
    providers, providerSel, setProviderSel, modelSel, setModelSel, effortPickerOpen, setEffortPickerOpen,
    currentProvider, allProviders, pickerProviders, providerDefault, currentModel, effectiveModel, currentModelLabel,
    currentEffort, currentEffortLabel, pickEffort, ultracode, setUltracode, effortForCreation,
  };
}
