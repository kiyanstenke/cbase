// Reasoning effort: which levels a model REALLY supports — also the picker decision, "Default · <level>" and Ultracode.
//
// The three pickers on the web used to offer the same five levels — low, medium, high, xhigh,
// max — for every model of every provider. Measured with real `codex exec` oneshots (production
// CLI 0.153.1 in the user container, ChatGPT account) that is wrong: `-c model_reasoning_effort=max`
// with `-m gpt-5.5` answers with HTTP 400 ("Unsupported value: 'max' is not supported with the
// 'gpt-5.5' model.") — the whole turn is lost before it begins.
//
// The list comes from the provider catalog: `GET /api/providers` delivers an `efforts` per
// model. That is cbase's OWN measurement (providers/connectors/codex.js), explicitly
// not OpenAI's `models_cache.json` — the provider's catalog is a lower bound, not the truth.
//
// There are FIVE levels. A sixth used to exist that meant something different per provider (on Claude it ran as max, on
// Codex it switched on its own delegation, invisible to cbase); it is gone from the order, the
// catalogs and all pickers; a stored old value migrates to `max` when the server starts
// (`store/chats.js:migrateUltraToMax`). Codex' `none`/`minimal` offers no choice.
//
// If the field is missing (third-party provider, a model outside the catalog, a provider list not loaded yet;
// Claude carries it per model), the five from before apply; an EMPTY list means "no levels".
// cbase knows nothing about foreign models, and an invented lock would be worse than none.
//
// This selection is NOT a protection: the computation happens in the run (`effortRunning`, providers/index.js), clamped at spawn
// (`mapEffort` in codex.js, `mapClaudeEffort` in claude.js, `wireLevel` for the presets) — with a console line
// when it replaces something. It does not drop an unsupported level but replaces it with the highest supported one that is NOT ABOVE
// the wanted one — `effortFallback` below computes the same way, so the UI can say which level
// then really thinks. Here it is only about sparing the user a choice that would be replaced there anyway.

/**
 * The ORDER of the levels, ascending — the only source of the order on the web.
 *
 * It is the web half of `EFFORT_LEVELS` in server/backend/electron/server/workflows.js and stands
 * here because `lib/effort.ts` is a leaf module without imports (the client cannot import the server).
 * It is bound not by discipline but by `web/test/effort.test.mjs`: list against list, plus the key order of
 * `EFFORT_LABEL` and the union in `lib/api/workflows.ts`.
 *
 * Whoever adds a further level enters it HERE (and in the server) — everything else hangs on it.
 */
export const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The levels without a catalog entry — the fallback (bound to `CLAUDE_EFFORTS`). It is character-equal to the order; it
 * stays a list of its own because it says something different ("what a model without a measurement supports" versus
 * "what exists at all").
 */
export const EFFORT_DEFAULT: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Label per level — ONE table for composer and workflow editor. */
export const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

// The marker on a level that does not run here — THREE i18n keys, because not everyone
// rejects it for the same reason (see `effortMarker`).
const NOT_SUPPORTED_MODEL = "not supported by the model";
const NOT_SUPPORTED_PROVIDER = "not listed by this provider";

/**
 * The marker on a level the (provider, model) does not support — an i18n key.
 *
 * WHO rejects it is not the same everywhere, and the marker says so. Three cases, three sentences:
 *
 *   • **Codex** — the level goes out as `-c model_reasoning_effort` and OpenAI answers with
 *     HTTP 400 (measured: `max` on gpt-5.5). Here the MODEL really rejects.
 *   • **Claude** — the catalog carries `efforts` per model (measured against the pinned CLI):
 *     not supported there is what the MODEL does not support (Haiku 4.5: no level —
 *     the CLI accepts `--effort` and the level silently evaporates). The CLI knows all five, the model decides.
 *   • **Everything else** (the three preset connectors, third-party providers) — there CBASE's wire clamps before
 *     an endpoint can reject anything: every preset connector sends `efforts` per model along, and the generic
 *     openai-chat carries only low/medium/high (a foreign endpoint might answer 400 to more). It is cbase's own list that does not
 *     CARRY the level, not the provider that rejects it. Saying "not supported by the model" there would blame an
 *     uninvolved party.
 */
export const effortMarker = (provider: string): string =>
  provider === "codex" || provider === "claude" ? NOT_SUPPORTED_MODEL : NOT_SUPPORTED_PROVIDER;

/**
 * The whole sentence for tooltip and screen-reader label: what does not run here, and what thinks INSTEAD
 * ({effort} and {fallback} are filled by the caller). The same cut as in `effortMarker` — and it stands
 * here and not in the component, because three pickers could show it and a sentence written out three times
 * ages three times.
 *
 * It must not say "the run starts with the CLI default": all five clamps REPLACE an unsupported
 * level instead of dropping it. A guard that pins a false statement is worse than none
 * (`web/test/composer-contract.test.mjs` once pinned exactly such a sentence verbatim).
 */
export const effortHint = (provider: string): string =>
  provider === "codex"
    ? "{effort} is not supported by this model — the run thinks with {fallback}. Pick a level from the list."
    : provider === "claude"
      ? "This Claude model does not support {effort} — the run thinks with {fallback}. Pick a level from the list."
      : "This provider does not list {effort} — the run thinks with {fallback}. Pick a level from the list.";

/** Label of a level; an unknown one shows itself instead of silently disappearing. */
export const effortLabel = (id: string): string => EFFORT_LABEL[id] ?? id;

/**
 * The provider catalog as far as this module reads it (`/api/providers`). `caps.effort` is the provider's switch:
 * explicitly `false` means "this provider supports no reasoning level" — no picker, `/effort` says so. If `caps` is missing (fallback before the
 * fetch, an older server), that is "unknown" and shows the picker as before.
 */
export type EffortCatalog = readonly { id: string; defaultModel?: string; defaultEffort?: string; caps?: { effort?: boolean }; models: readonly { id: string; efforts?: string[] }[] }[];

/**
 * The levels the (provider, model) supports according to the catalog — otherwise the five default levels.
 *
 * An empty `model` is NOT "unknown" but "the provider's default": then `defaultModel` from /api/providers is run, and its levels apply.
 * That is the same rule as in the backend (`chat.model || defaultModelFor(provider)` in runs/do-run.js) and as on the iPhone
 * (`EffortLevels`). Falling back to the five default levels here would offer "Max" to a suggestion item or a
 * workflow run without a model of its own, although the provider default is gpt-5.5 and answers HTTP 400 to it.
 * (The chat composer was never affected: ChatPane resolves the model to `effectiveModel` beforehand.)
 *
 * If nothing is left after that (no provider chosen, list not loaded yet, model outside the catalog, model WITHOUT `efforts`),
 * the five default levels apply: nothing is invented about the unknown. An EMPTY list on the other hand is a statement — "no levels"
 * (Haiku 4.5) — and stays empty: the same distinction as `effortFallback` in workflows.js and `EffortLevels`
 * on iOS (bound in effort.test.mjs / effort-ios.test.mjs).
 */
export function effortLevels(provider: string, model: string, catalog: EffortCatalog = []): string[] {
  const list = catalogList(provider, model, catalog);
  return Array.isArray(list) ? [...list] : [...EFFORT_DEFAULT];
}

/** The `efforts` entry of the catalog for (provider, model) — `undefined` if there is none. */
function catalogList(provider: string, model: string, catalog: EffortCatalog = []): readonly string[] | undefined {
  const providerName = catalog.find((p) => p.id === provider);
  const id = model || providerName?.defaultModel || "";
  return providerName?.models.find((mo) => mo.id === id)?.efforts;
}

/**
 * Does the catalog say that (provider, model) supports NO levels? True only for an explicitly empty list
 * (Haiku 4.5) — a missing `efforts` is "unknown" and shows the default levels. Then
 * there is no picker, and `/effort` sets nothing.
 */
export function effortNoLevels(provider: string, model: string, catalog: EffortCatalog = []): boolean {
  const list = catalogList(provider, model, catalog);
  return Array.isArray(list) && !list.some((g) => EFFORT_LEVELS.includes(String(g || "").toLowerCase()));
}

/**
 * The provider a selection COMPUTES with: the set one, otherwise the globally active one (`active` from
 * `/api/providers`). "Default (global)" on suggestion items and workflow runs is an empty provider —
 * and empty is not unknown: computing with "" there would offer the five default levels although
 * the run thinks on the global provider and its default model. An old chat without a stored provider resolves the same way
 * (chatModelChoice: `activeChat.provider || globalProvider`). If `active` is also empty (list not loaded), it stays "" — and thus at
 * the fallback to the default levels.
 */
export const effortProvider = (provider: string, active = ""): string => provider || active || "";

/**
 * Why there is NO effort selection — "" means: there is one. THE decision "picker yes/no" on the web,
 * ONCE here and not at the call sites (composer, suggestion item,
 * workflow run, `/effort`; the new chat is the composer on the web):
 *
 *   • `"provider"` — the provider has `caps.effort` explicitly off (a third-party provider without reasoning);
 *   • `"model"` — the model supports NO levels according to the catalog (empty list: Haiku 4.5);
 *   • `""` — otherwise, also for a model OUTSIDE the catalog and a provider without `caps`: nothing is invented about the
 *     unknown, the default levels apply there.
 *
 * The provider is resolved as in `effortProvider`. Bound to `EffortLevels` on the
 * iPhone (web/test/effort-ios.test.mjs).
 */
export function effortWithoutSelection(provider: string, model: string, catalog: EffortCatalog = [], active = ""): "" | "provider" | "model" {
  const id = effortProvider(provider, active);
  if (catalog.find((p) => p.id === id)?.caps?.effort === false) return "provider";
  return effortNoLevels(id, model, catalog) ? "model" : "";
}

/** Is there an effort selection for (provider, model)? The short form of `effortWithoutSelection`. */
export const effortPicker = (provider: string, model: string, catalog: EffortCatalog = [], active = ""): boolean =>
  effortWithoutSelection(provider, model, catalog, active) === "";

/**
 * The answer of `/effort` when there is no selection — an i18n key, one sentence per reason. The
 * command then sets nothing and passes nothing to the CLI.
 */
export const effortWithoutSelectionText = (reason: "provider" | "model"): string =>
  reason === "provider"
    ? "This provider has no thinking level — /effort sets nothing here."
    : "This model has no thinking levels — /effort sets nothing here.";

/**
 * Which level REALLY runs instead of the set one.
 *
 * The same computation as the clamp at spawn: it stands in the backend ONCE as `effortFallback` in
 * server/backend/electron/server/workflows.js, and all five clamps call it (`codexEffortFallback`,
 * `mapClaudeEffort` and for the three presets `wireLevel` in providers/preset-levels.js). Here is its web version, line for
 * line the same computation over the same order.
 *
 * THE RULE: the highest supported level that is NOT ABOVE the wanted one. If there is none
 * below, it is the lowest supported one.
 *
 * So the substitute is never above the wish, and that is the REASON and not just the form:
 * one level more means more thinking tokens, and the user pays them from their subscription limit. That is why it clamps
 * DOWN, never up — whoever chose `xhigh` did not order `max`. Taking the LAST element of the supported list would, for a model with a
 * GAP (gpt-5.5 supports a level above the missing `max`), jump over the supported
 * `xhigh` to a level ABOVE the wish while the other clamps clamped down.
 * Now: `max` ⇒ `xhigh`.
 *
 * Ordering is by `EFFORT_LEVELS`, not by the catalog's writing order: that the
 * `efforts` lists are written ascending is a habit, not a promise — an
 * unsorted entry would otherwise silently yield a different substitute than the clamp at spawn.
 *
 * `web/test/effort.test.mjs` recomputes this function against the backend versions, pair by
 * pair — a UI that names a different level than the one that thinks would be worse than one
 * that stays silent.
 *
 * No set level is no substitute: "" stays "", and what is not in `EFFORT_LEVELS`
 * is no level and also gives "" — exactly like the server, which sends no flag for it.
 * A model outside the catalog is unknown here: there this module computes with the five default levels,
 * the server passes the level through character for character — the same answer, because the default
 * carries all levels of the order. An EMPTY catalog list gives "" on both sides.
 */
export function effortFallback(provider: string, model: string, catalog: EffortCatalog | undefined, set: string): string {
  const e = String(set || "").toLowerCase();
  if (!EFFORT_LEVELS.includes(e)) return "";
  const rank = (g: string) => EFFORT_LEVELS.indexOf(g);
  const list = effortLevels(provider, model, catalog)
    .map((g) => String(g || "").toLowerCase())
    .filter((g) => EFFORT_LEVELS.includes(g))
    .sort((a, b) => rank(a) - rank(b));
  if (!list.length) return ""; // no levels (empty catalog list): no flag, as at spawn
  if (list.includes(e)) return e;
  const below = list.filter((g) => rank(g) < rank(e));
  return below.length ? below[below.length - 1] : list[0];
}

/**
 * Does (provider, model) support the SET level? '' (no default) is no level and
 * thus always supported. The same computation as in `effortSelection` — it stands here separately because
 * the COLLAPSED effort button must carry the marker too: otherwise only whoever opened the picker saw it, and "Max" stood there
 * calmly next to a run that silently thinks with the CLI default. A cap must say that it is one.
 */
export function effortSupported(provider: string, model: string, catalog: EffortCatalog | undefined, set: string): boolean {
  return !set || effortLevels(provider, model, catalog).includes(set);
}

/**
 * An entry of the selection: the level, whether the current model supports it — and the level that thinks
 * INSTEAD. For a supported one `fallback` is itself; so the three selections do not have to
 * distinguish whether they may compute.
 */
export type EffortChoice = { id: string; supported: boolean; fallback: string };

/**
 * The selection for a chat or run: the levels of the model — and, if the SET level is not among them, it
 * itself, marked. Leaving it out would show the user a change they never made
 * (the selection would jump to a foreign value); showing it unmarked would claim
 * it goes through. The order is that of the catalog, a foreign level is appended at the back.
 */
export function effortSelection(provider: string, model: string, catalog: EffortCatalog | undefined, set: string): EffortChoice[] {
  const levels = effortLevels(provider, model, catalog);
  const choice: EffortChoice[] = levels.map((id) => ({ id, supported: true, fallback: id }));
  if (set && !levels.includes(set)) {
    choice.push({ id: set, supported: false, fallback: effortFallback(provider, model, catalog, set) });
  }
  return choice;
}

/** The suffix on an unsupported entry — word for word the same as on the iPhone (`EffortLevels`). */
const RUNNING_AS = "runs as {fallback}";

/** The translator function of the UI as far as this leaf module needs it (`t` from i18n). */
export type EffortTranslator = (text: string, params?: Record<string, string | number>) => string;

/**
 * The label of ONE selection entry: "Max · runs as X-High" if the model does not support the level,
 * otherwise just "Max".
 *
 * The wording stands HERE and not three times in the components — a sentence written out three times
 * ages three times. The form is the mobile one ("{level} · runs as {substitute}"), with the same i18n key as in the iOS app.
 *
 * WHO rejects the level is deliberately not in the label but in the tooltip next to it
 * (`effortMarker`): in the picker the row is narrow, and what really thinks is the more urgent
 * information. Without a substitute (a stored value that is no level at all — filtered twice against
 * `EFFORT_LEVELS`, so unreachable) the bare label stays: better terse than wrong.
 */
export function effortEntryLabel(choice: EffortChoice, t: EffortTranslator): string {
  const name = t(effortLabel(choice.id));
  if (choice.supported || !choice.fallback || choice.fallback === choice.id) return name;
  return `${name} · ${t(RUNNING_AS, { fallback: t(effortLabel(choice.fallback)) })}`;
}

/**
 * A FINISHED entry of an effort selection: what the picker shows (`label`), whether it
 * sets it in warning color (`supported`), and what stands in the tooltip (`marker` — only on a level the model does not
 * support; otherwise `undefined`, then the element carries no `title` at all).
 */
export type EffortEntry = { id: string; label: string; supported: boolean; marker: string | undefined };

/**
 * THE building block of every effort selection on the web: from provider, model, catalog and
 * set level the entries in their order — first the empty entry (''), then the levels
 * of the model, then, if the model does not support it, the set level marked —, each with
 * label and marker.
 *
 * Without this block each of the three selections (composer button — also for the new chat —,
 * suggestion item, workflow settings) would assemble its entries itself: the same wiring three times, and every
 * change (no selection without levels, no empty entry "Auto", "Default · <level>" on inheriting fields, Ultracode as the top level)
 * the same change three times, with the same error risk three times. `web/test/effort.test.mjs` ensures
 * that no component builds the list itself any more.
 *
 * The label of the empty entry is given by the caller (`empty`, already translated). On the INHERITING fields
 * (suggestion item, workflow run, app agents), where empty means "Default" and stays allowed, it is
 * everywhere `effortStandardLabel` — "Default · <level>" with exactly the level that then thinks.
 * `null` means: NO empty entry — so the composer: a chat always carries a
 * level, going back to "none" does not exist (the server answers `{effort: ""}` with 400).
 * The iPhone has the same building block: `EffortSelection` (mobile/CbaseMobile/Kit/EffortSelection.swift).
 */
export function effortEntries(
  provider: string,
  model: string,
  catalog: EffortCatalog | undefined,
  set: string,
  empty: string | null,
  t: EffortTranslator,
  active = "",
): EffortEntry[] {
  // An empty provider ("Default (global)") computes with the globally active one (`effortProvider`).
  const providerName = effortProvider(provider, active);
  return [
    ...(empty === null ? [] : [{ id: "", label: empty, supported: true, marker: undefined }]),
    ...effortSelection(providerName, model, catalog, set).map((w) => ({
      id: w.id,
      label: effortEntryLabel(w, t),
      supported: w.supported,
      marker: w.supported ? undefined : t(effortMarker(providerName)),
    })),
  ];
}

/**
 * The entries of the default-level selection next to the default model of a provider (Settings → Providers) — empty
 * means: NO row. None if the server sends no default level (a provider with `caps.effort: false` reports
 * `defaultEffort: ""`), the provider supports no reasoning level or the default model has no levels
 * (Haiku 4.5). Asking only `defaultEffort` and `caps.effort` would show on Haiku
 * a selection with exactly one unchangeable "Medium", while the iPhone hides the row
 * (`EffortSelection.shows`). Without an empty entry — the default IS a level.
 */
export function defaultLevelEntries(
  p: { id: string; defaultModel?: string; defaultEffort?: string },
  catalog: EffortCatalog | undefined,
  t: EffortTranslator,
): EffortEntry[] {
  const model = p.defaultModel || "";
  if (!p.defaultEffort || !effortPicker(p.id, model, catalog ?? [])) return [];
  return effortEntries(p.id, model, catalog, p.defaultEffort, null, t);
}

// ── "Default · <level>" on an inheriting field ─────────────────────────────────────────────────────────────────────────────
//
// An empty field means "default level of the provider" — resolved in the run (server `effortRunning`: `defaultEffort` from
// /api/providers, clamped to the model). The label names EXACTLY this level: a UI that names a different
// level than the one that thinks would be worse than one that stays silent. ONE computation for every place with an empty entry
// (app agents, suggestion items, workflow run) — iOS: `EffortLevels.standardLabel`.
// Computed against the spawn: server/backend/test/default-level-inherit.test.js (items, graph step, subagent inheritance).

/** The level an EMPTY field thinks with on (provider, model) — "" if none (model without levels, catalog missing). */
export function effortDefaultLevel(provider: string, model: string, catalog: EffortCatalog | undefined, active = ""): string {
  const providerName = effortProvider(provider, active);
  const standard = String(catalog?.find((p) => p.id === providerName)?.defaultEffort || "");
  return effortFallback(providerName, model, catalog, standard);
}

/**
 * The label of the empty entry: "Default · <level>", without a known level just "Default".
 *
 * Variant `asChat`: the run level of a workflow.
 * There empty transfers NOTHING (`chatFieldsFromRun`) — a manual start in an existing chat thinks with its level, only a
 * freshly created run chat gets the default level. Hence "As the chat · new: <level>" (without a level "As the
 * chat"); the same level, the same computation. iOS: `EffortLevels.standardLabel(…, asChat: true)`.
 */
export function effortStandardLabel(provider: string, model: string, catalog: EffortCatalog | undefined, t: EffortTranslator, active = "", asChat = false): string {
  const level = effortDefaultLevel(provider, model, catalog, active);
  if (asChat) return level ? t("As the chat · new: {level}", { level: t(effortLabel(level)) }) : t("As the chat");
  return level ? t("Default · {level}", { level: t(effortLabel(level)) }) : t("Default");
}

// ── Ultracode: a SWITCH next to the level ────────────────────────────────────────────────────────────────────────────────
//
// It is deliberately NOT in `EFFORT_LEVELS`: as a further entry of the order the substitute rule would clamp it to max. The chat
// carries it as a field of its own (`Chat.ultracode`), and level and switch are two independent axes:
// switching on and off leave the level alone, a level never switches it off, a model without levels can carry it
// (backend: `chats/ultracode.js`). The effort selection shows only the levels; next to it stands a switch of its own (CbKit
// `Toggle`). The word never goes to the CLI — `/effort ultracode` toggles locally.

/** The word with which `/effort ultracode` flips the switch — no level, never on the wire. */
export const ULTRACODE = "ultracode";

/**
 * The PATCH body (`/api/chats/:id`) of an EXPLICIT choice of the level — effort selection and `/effort <level>`, also Scheduled.
 * It carries ONLY the level: the Ultracode switch stays as it is.
 *
 * `effortChoice: true`: the server then ALWAYS makes the level the chat's own choice (`chats.effort_own`), even if it is the same as before.
 */
export function effortChoiceBody(level: string): { effort: string; effortChoice: true } {
  return { effort: level, effortChoice: true };
}

/** The PATCH body of the Ultracode switch — only the switch, never a level. */
export function ultracodeBody(on: boolean): { ultracode: boolean } {
  return { ultracode: on };
}
