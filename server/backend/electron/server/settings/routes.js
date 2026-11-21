// Routes: settings. Each function takes ctx = { req, res, url, p, m } and returns NEXT when it is not responsible;
// any other return value means "answered". Call order: ROUTES in server.js.
// Functions: settingsRoutes (ui-lang, agent-models, auto-continue, credit-gate, chat-auto-archive, agent-hooks, permission-rules,
// web-search, tts/*, playwright-headless) · adjustRoutes · autocompactNotifyRoutes.

import fs from "node:fs";
import { runOnce } from "../claude.js";
import { isProviderId, resolveModelRef } from "../providers/index.js";
import { effortSavable } from "../workflows.js";
import * as limits from "../limits.js";
import * as store from "../store.js";
import { T, getUiLang, getUiZone, setUiLang, setUiZone, zoneValid } from "../i18n.js";
import * as notifications from "../notify.js";
import * as autocompact from "../autocompact.js";
import * as adjust from "../adjust.js";
import { AGENT_MODEL_DEFAULTS, AGENT_MODEL_KEYS, agentEffortSetting, agentRunFor, agentModelFor, agentModelSetting, agentRow } from "./agent-models.js";
import { AUTO_CONTINUE_SETTING, CREDIT_GATE_SETTING, autoContinueEnabled, creditGateOn } from "../runs/limit-gate.js";
import { HOOK_EVENTS, loadAgentHooks } from "../toolchain/profiles.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { TTS_DEFAULT_BASE, TTS_DEFAULT_MODEL, TTS_DEFAULT_VOICE, loadTtsConfig, plainForSpeech, ttsCachePath } from "./tts.js";
import { WEB_SEARCH_PROVIDERS, loadPermissionRules, loadWebSearchConfig, savePermissionRules } from "../runs/permissions.js";
import { sandboxed } from "../runs/sandboxing.js";

import { autoContinueView, cancelAutoContinue, fireAutoContinue } from "../runs/auto-continue.js";
import { playwrightHeadless } from "../toolchain/playwright.js";
import { USER_CAP_MAX, runCap, userCap, userCapDefault, setUserCap } from "../dynworkflows/cap.js";
import { SIZES, SIZE_DEFAULT, size, setSize } from "../dynworkflows/size.js";
import { wakeGateWaiting } from "../dynworkflows/parking.js";
import { autoArchiveSetting, setAutoArchive } from "../chats/auto-archive.js";
import { saverOn, setSaver } from "../runs/saver.js";
import { onceBooking } from "../runs/booking.js";

/**
 * What an app agent REALLY runs with — the `effective` of `GET/PUT /api/agent-models`, computed by the SAME functions
 * as its run, not by a replica:
 *   • `compact` without its own choice runs with model and provider of the respective CHAT (runs/post-run.js) — there is
 *     no single model, and the route says so (`asChat: true`, provider and model empty) instead of inventing one;
 *   • every other one is a oneshot: `agentRunFor(k).model` (= `agentModelFor(k)`), resolved like `runOnce`.
 * @param {string} key
 * @returns {{provider: string, model: string, asChat?: true}}
 */
function agentEffective(key) {
  if (key === "compact" && !agentModelSetting(key)) return { provider: "", model: "", asChat: true };
  const r = resolveModelRef(agentModelFor(key));
  return { provider: r.providerId, model: r.model || "" };
}

export async function settingsRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── UI language (mirrored from the renderer, see i18n.js) ──
      if (p === "/api/ui-lang" && m === "GET") return send(res, 200, { lang: getUiLang(), zone: getUiZone() });
      if (p === "/api/ui-lang" && m === "PUT") {
        const b = await readBody(req);
        if (b.lang !== "de" && b.lang !== "en") return send(res, 400, { error: T("lang must be 'de' or 'en'") });
        // The user's time zone (i18n.js clockText) travels along: a MISSING field means "unchanged" (older clients).
        // An INVALID zone never fails the language switch: the language is what this request announces, the zone is an
        // extra the client reads from the device — Chromium reports "Etc/Unknown" when the system zone cannot be
        // determined, and the browser's ICU knows zones the container's does not. So: language saved, zone left
        // unchanged, and both the response (`zoneRejected`) and the log say so.
        setUiLang(b.lang);
        store.setSetting("ui_lang", getUiLang());
        const zoneRejected = b.zone !== undefined && !zoneValid(b.zone);
        if (zoneRejected) console.log(`[ui-lang] zone ${JSON.stringify(String(b.zone).slice(0, 80))} is not a valid IANA time zone — ignored, language ${getUiLang()} applied.`);
        else if (b.zone !== undefined) store.setSetting("ui_zone", setUiZone(b.zone));
        return send(res, 200, { ok: true, lang: getUiLang(), zone: getUiZone(), ...(zoneRejected ? { zoneRejected: true } : {}) });
      }

      // ── App agent models: provider+model per internal LLM task (Settings → Models).
      //    Empty = auto (the defaults); takes effect on the next run of that task. ──
      if (p === "/api/agent-models" && m === "GET") {
        const agents = {};
        // Per key also the effort level ("" = default) and the model the oneshot REALLY runs with (`effective`, from
        // `agentEffective` — the same functions as the run), so the UI derives selection and "Default · <level>" from it
        // instead of rebuilding this file's defaults. Two maps of their own rather than a field in `agents`: there
        // `null` means "auto model", and a level alone is not a model.
        const efforts = {};
        const effective = {};
        for (const k of AGENT_MODEL_KEYS) {
          agents[k] = agentModelSetting(k);
          efforts[k] = agentEffortSetting(k);
          effective[k] = agentEffective(k);
        }
        return send(res, 200, { agents, defaults: AGENT_MODEL_DEFAULTS, efforts, effective });
      }
      if (p === "/api/agent-models" && m === "PUT") {
        const b = await readBody(req);
        const key = String(b.key || "");
        if (!AGENT_MODEL_KEYS.includes(key)) return send(res, 400, { error: T("unknown agent key") });
        // Two halves of one row, each only when ANNOUNCED (a missing field is not an instruction): the model via
        // `provider`/`model` (both empty = auto), the level via `effort` ("" = default). A body with neither
        // changes nothing and is a 400 — otherwise a foreign field would silently switch back to auto.
        const modelAnnounced = b.provider !== undefined || b.model !== undefined;
        const levelAnnounced = b.effort !== undefined;
        if (!modelAnnounced && !levelAnnounced) return send(res, 400, { error: T("„model“ or „effort“ is missing") });
        const row = agentRow(key);
        const fresh = {};
        if (modelAnnounced) {
          if (b.provider && b.model) {
            if (!isProviderId(String(b.provider))) return send(res, 400, { error: T("unknown provider") });
            Object.assign(fresh, { provider: String(b.provider), model: String(b.model).slice(0, 200) });
          } // otherwise auto: no model half
        } else if (row.provider && row.model) Object.assign(fresh, { provider: row.provider, model: row.model });
        const level = levelAnnounced ? effortSavable(b.effort) : effortSavable(row.effort);
        if (levelAnnounced && level.kind === "unknown") return send(res, 400, { error: level.error });
        if (level.kind === "level") fresh.effort = level.level;
        store.setSetting(`agent_model_${key}`, Object.keys(fresh).length ? JSON.stringify(fresh) : ""); // empty = auto + default
        return send(res, 200, { ok: true, value: agentModelSetting(key), effort: agentEffortSetting(key), effective: agentEffective(key) });
      }

      // ── Auto-continue at the usage limit (on/off) ────────────────────────────
      // Off only disables the WAITING: a limit hit stays visible but is treated like a
      // normal error. Runs already waiting are released.
      if (p === "/api/auto-continue" && m === "GET") {
        // Running chats drop out (autoContinueView returns null for them) — their row is
        // only the attempt counter, not a waiting state.
        return send(res, 200, { enabled: autoContinueEnabled(), waiting: store.listPendingResumes().map(autoContinueView).filter(Boolean) });
      }
      if (p === "/api/auto-continue" && m === "PUT") {
        const b = await readBody(req);
        // A missing `enabled` is NOT an instruction. The reading below turns everything except
        // `false`/`"0"`/`0` into ON — a body with a FOREIGN field would silently flip this setting.
        // So the field is required instead of guessed.
        if (b.enabled === undefined || b.enabled === null)
          return send(res, 400, { error: T("„enabled“ is missing") });
        const on = b.enabled !== false && b.enabled !== "0" && b.enabled !== 0;
        store.setSetting(AUTO_CONTINUE_SETTING, on ? "1" : "0");
        if (!on) {
          for (const row of store.listPendingResumes()) {
            // Gate rows belong to the credit gate, not to this switch: the gate parked the turn
            // and it also wakes it — independent of auto-continue.
            if (row.reason === "credit") continue;
            cancelAutoContinue(row.chatId, { kind: "off", note: T("Auto-continue was switched off.") });
          }
        }
        return send(res, 200, { ok: true, enabled: on });
      }

      // ── Credit gate ──────────────────────────────────────────────────────────
      // Global, not per workspace or chat: credit is a property of the ACCOUNT. `threshold` travels
      // along so the labels in web and iOS need not keep a second 99 of their own — one number, one source.
      if (p === "/api/credit-gate" && m === "GET") {
        return send(res, 200, { enabled: creditGateOn(), threshold: limits.START_GATE_PERCENT, provider: "claude" });
      }
      if (p === "/api/credit-gate" && m === "PUT") {
        const b = await readBody(req);
        // The same trap as the route above with the opposite sign: here a missing field would
        // silently mean OFF. That, too, is a decision nobody made.
        if (b.enabled === undefined || b.enabled === null)
          return send(res, 400, { error: T("„enabled“ is missing") });
        const on = b.enabled === true || b.enabled === "1" || b.enabled === 1;
        store.setSetting(CREDIT_GATE_SETTING, on ? "1" : "0");
        // When switching OFF, release the runs the gate already parked — they wait for a rule that
        // no longer exists. Time-limit wait rows stay untouched: they wait for the provider, not for
        // this setting. `manual` without an override: the gate is off, so no one-time release is needed.
        if (!on) {
          for (const row of store.listPendingResumes()) {
            if (row.reason !== "credit") continue;
            fireAutoContinue(row.chatId, { manual: true })
              .catch((e) => console.error("[credit-gate] release:", e?.message || e));
          }
          // The same for workflow agents waiting at the gate: they are in no wait row but in their run's
          // journal — without this wake-up they would wait until the window resets.
          wakeGateWaiting();
        }
        return send(res, 200, { ok: true, enabled: on, threshold: limits.START_GATE_PERCENT });
      }

      // ── Per-user cap of dynamic workflows: how many workflow agents run at once, across ALL workflows of this
      // server (container or local server). Default 8. `runCap` travels along so the label can name the second cap
      // (per run, default 8) without recomputing it — one number, one source. A missing field is not an
      // instruction: PUT without `cap` ⇒ 400.
      if (p === "/api/dyn-workflow-cap" && m === "GET") {
        return send(res, 200, { cap: userCap(), preset: userCapDefault(), max: USER_CAP_MAX, runCap: runCap() });
      }
      if (p === "/api/dyn-workflow-cap" && m === "PUT") {
        const b = await readBody(req);
        const r = setUserCap(b.cap);
        if (!r.ok) {
          return send(res, 400, r.error === "missing"
            ? { error: T("“cap” is missing") }
            : { error: T`“cap” must be a whole number from 1 to ${USER_CAP_MAX}` });
        }
        return send(res, 200, { ok: true, cap: r.cap, preset: userCapDefault(), runCap: runCap() });
      }
      // ── Size guideline of dynamic workflows: small · medium · large · unrestricted, default medium — given to the
      // model as a hint in the description of cbase_dynamic_workflow (dynworkflows/size.js). The stages come from the
      // SERVER, the clients only label them. PUT without `size` ⇒ 400, an unknown one ⇒ 400.
      if (p === "/api/dyn-workflow-size" && m === "GET") {
        return send(res, 200, { size: size(), preset: SIZE_DEFAULT, stages: SIZES });
      }
      if (p === "/api/dyn-workflow-size" && m === "PUT") {
        const b = await readBody(req);
        const r = setSize(b.size);
        if (r.error) {
          return send(res, 400, r.error === "missing"
            ? { error: T("“size” is missing") }
            : { error: T`“size” must be one of ${SIZES.join(", ")}` });
        }
        return send(res, 200, { ok: true, size: r.size, preset: SIZE_DEFAULT });
      }

      // ── CPU saver: ONE switch, off by default — background work (subagents, workflow agents, outer-loop agents,
      // monitors) runs under nice and its Bash waits under full load. Read at every spawn (runs/saver.js).
      // PUT requires `enabled` as a boolean — missing or not a boolean ⇒ 400.
      if (p === "/api/cpu-saver" && m === "GET") return send(res, 200, { enabled: saverOn() });
      if (p === "/api/cpu-saver" && m === "PUT") {
        const b = await readBody(req);
        const r = setSaver(b?.enabled);
        if (r.error) {
          return send(res, 400, r.error === "missing"
            ? { error: T("„enabled“ is missing") }
            : { error: T("„enabled“ must be true or false") });
        }
        return send(res, 200, { enabled: r.enabled });
      }

      // ── Auto-archive chats ───────────────────────────────────────────────────
      // Global, off by default, 30 days. PUT requires BOTH fields — `enabled` boolean, `days` an integer 1–365 —, otherwise
      // 400 with a message; a PUT that switches on or changes the days triggers a pass that starts only AFTER this
      // response (setImmediate, in chunks — run synchronously in the handler it would block the server for everyone).
      // The response is `{ enabled, days }` as saved. Rules, storage and pass: chats/auto-archive.js.
      if (p === "/api/chat-auto-archive" && m === "GET") return send(res, 200, autoArchiveSetting());
      if (p === "/api/chat-auto-archive" && m === "PUT") {
        const b = await readBody(req);
        const r = setAutoArchive(b);
        if (!r.ok) return send(res, 400, { error: r.error });
        return send(res, 200, r.value);
      }

      // ── Agent hooks (loop engine): shell commands on tool events. Takes effect on the next run. ──
      if (p === "/api/agent-hooks" && m === "GET") return send(res, 200, { hooks: loadAgentHooks(), events: HOOK_EVENTS });
      if (p === "/api/agent-hooks" && m === "PUT") {
        const b = await readBody(req);
        const arr = Array.isArray(b.hooks) ? b.hooks : null;
        if (!arr) return send(res, 400, { error: T("expected hooks array") });
        for (const h of arr) {
          if (!h || !HOOK_EVENTS.includes(h.event)) return send(res, 400, { error: T`unknown event: ${h?.event}` });
          if (typeof h.command !== "string" || !h.command.trim()) return send(res, 400, { error: T("command required") });
        }
        store.setSetting("agent_hooks", JSON.stringify(arr.slice(0, 50)));
        return send(res, 200, { ok: true, hooks: loadAgentHooks() });
      }

      // ── Permanent tool approvals ("don't ask again"). Notation as in Claude Code's
      //    settings.json: "Bash(git status:*)", "Read(src/**)", "WebFetch". ──
      if (p === "/api/permission-rules" && m === "GET") return send(res, 200, { rules: loadPermissionRules() });
      if (p === "/api/permission-rules" && m === "PUT") {
        const b = await readBody(req);
        if (!Array.isArray(b.rules)) return send(res, 400, { error: T("expected rules array") });
        return send(res, 200, { ok: true, rules: savePermissionRules(b.rules.map((r) => String(r || ""))) });
      }

      // ── Web search of the own harness (WebSearch tool). Like other secrets the key is
      //    NEVER returned — only THAT one is stored. ──
      if (p === "/api/web-search" && m === "GET") {
        const c = loadWebSearchConfig();
        return send(res, 200, { provider: c.provider, baseUrl: c.baseUrl, hasKey: Boolean(c.apiKey), providers: WEB_SEARCH_PROVIDERS });
      }
      if (p === "/api/web-search" && m === "PUT") {
        const b = await readBody(req);
        const cur = loadWebSearchConfig();
        const provider = WEB_SEARCH_PROVIDERS.includes(b.provider) ? b.provider : "duckduckgo";
        // An empty apiKey means "keep" (the UI never shows it); an explicit null deletes it.
        const apiKey = b.apiKey === null ? "" : (typeof b.apiKey === "string" && b.apiKey ? b.apiKey : cur.apiKey);
        const next = { provider, apiKey, baseUrl: String(b.baseUrl ?? cur.baseUrl ?? "") };
        store.setSetting("web_search", JSON.stringify(next));
        return send(res, 200, { ok: true, provider: next.provider, baseUrl: next.baseUrl, hasKey: Boolean(next.apiKey) });
      }

      // ── Read aloud (text-to-speech) ─────────────────────────────────────
      if (p === "/api/tts/config" && m === "GET") {
        const c = loadTtsConfig();
        return send(res, 200, { hasKey: Boolean(c.apiKey), voiceId: c.voiceId, modelId: c.modelId, baseUrl: c.baseUrl });
      }
      if (p === "/api/tts/config" && m === "PUT") {
        const b = await readBody(req);
        const cur = loadTtsConfig();
        // An empty apiKey means "keep" (the UI never shows it); an explicit null deletes it.
        const apiKey = b.apiKey === null ? "" : (typeof b.apiKey === "string" && b.apiKey ? b.apiKey : cur.apiKey);
        const next = {
          apiKey,
          voiceId: String(b.voiceId ?? cur.voiceId ?? "") || TTS_DEFAULT_VOICE,
          modelId: String(b.modelId ?? cur.modelId ?? "") || TTS_DEFAULT_MODEL,
          baseUrl: String(b.baseUrl ?? cur.baseUrl ?? "") || TTS_DEFAULT_BASE,
        };
        store.setSetting("tts", JSON.stringify(next));
        return send(res, 200, { ok: true, hasKey: Boolean(next.apiKey), voiceId: next.voiceId, modelId: next.modelId, baseUrl: next.baseUrl });
      }
      // The account's voice list — only for choosing in the settings.
      if (p === "/api/tts/voices" && m === "GET") {
        const c = loadTtsConfig();
        if (!c.apiKey) return send(res, 409, { error: T("No ElevenLabs key configured") });
        try {
          const r = await fetch(`${c.baseUrl}/v1/voices`, { headers: { "xi-api-key": c.apiKey } });
          if (!r.ok) return send(res, 502, { error: `ElevenLabs ${r.status}` });
          const data = await r.json();
          const voices = (data?.voices || []).map((v) => ({ id: v.voice_id, name: v.name, labels: v.labels || {} }));
          return send(res, 200, { voices });
        } catch (e) { return send(res, 502, { error: String(e?.message || e) }); }
      }
      // Speech output of ONE message. The response is the MP3 itself (audio/mpeg) so the
      // clients can play it directly. Without a key: 409 — the clients then fall back
      // to the system voice.
      if (p === "/api/tts" && m === "POST") {
        const b = await readBody(req);
        const spoken = plainForSpeech(b.text).slice(0, 5000);
        if (!spoken) return send(res, 400, { error: T("No text to speak") });
        const c = loadTtsConfig();
        if (!c.apiKey) {
          return send(res, 409, {
            error: T("No ElevenLabs key configured"),
            fallback: "system",
          });
        }
        const voiceId = String(b.voiceId || c.voiceId);
        const cached = ttsCachePath(spoken, voiceId, c.modelId);
        if (fs.existsSync(cached)) {
          const body = fs.readFileSync(cached);
          res.writeHead(200, {
            "Content-Type": "audio/mpeg",
            "Content-Length": body.length,
            // Only the own client may cache this (not the tunnel edge).
            "Cache-Control": "private, max-age=3600",
          });
          return res.end(body);
        }
        try {
          const r = await fetch(`${c.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
            method: "POST",
            headers: { "xi-api-key": c.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify({ text: spoken, model_id: c.modelId }),
          });
          if (!r.ok) {
            const detail = await r.text().catch(() => "");
            return send(res, 502, { error: `ElevenLabs ${r.status}: ${detail.slice(0, 300)}` });
          }
          const audio = Buffer.from(await r.arrayBuffer());
          try { fs.writeFileSync(cached, audio); } catch { /* the cache is optional */ }
          res.writeHead(200, {
            "Content-Type": "audio/mpeg",
            "Content-Length": audio.length,
            "Cache-Control": "private, max-age=3600",
          });
          return res.end(audio);
        } catch (e) { return send(res, 502, { error: String(e?.message || e) }); }
      }

      // ── Playwright browser: ALWAYS headless (toolchain/playwright.js). Both routes remain for older
      //    clients and report the truth; a PUT changes nothing (no switch that would silently have no effect). ──
      if (p === "/api/playwright-headless" && m === "GET") return send(res, 200, { headless: playwrightHeadless() });
      if (p === "/api/playwright-headless" && m === "PUT") {
        await readBody(req);
        return send(res, 200, { ok: true, headless: playwrightHeadless() });
      }
  return NEXT;
}

export async function adjustRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      // ── Adjust: rephrase selected text following an instruction ──────────────
      // Web and iOS select text (approval card, history), ask for an instruction and put the
      // result on the clipboard. The instructions are remembered — with a title,
      // editable, the last 20. Model: app agent "adjust" (Settings → Models).
      if (p === "/api/adjust/prompts" && m === "GET") {
        return send(res, 200, { items: adjust.loadPrompts(store.getSetting), max: adjust.MAX_PROMPTS });
      }
      const adjustMatch = p.match(/^\/api\/adjust\/prompts\/([^/]+)$/);
      if (adjustMatch && m === "PATCH") {
        const b = await readBody(req);
        let r;
        try { r = adjust.refreshPrompt(adjust.loadPrompts(store.getSetting), adjustMatch[1], { title: b?.title, prompt: b?.prompt }); }
        catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
        if (!r) return send(res, 404, { error: T("Instruction not found") });
        adjust.savePrompts(store.setSetting, r.items);
        return send(res, 200, r.entry);
      }
      if (adjustMatch && m === "DELETE") {
        const rest = adjust.removePrompt(adjust.loadPrompts(store.getSetting), adjustMatch[1]);
        if (!rest) return send(res, 404, { error: T("Instruction not found") });
        adjust.savePrompts(store.setSetting, rest);
        return send(res, 200, { ok: true, items: rest });
      }
      if (p === "/api/adjust" && m === "POST") {
        const b = await readBody(req);
        const text = String(b?.text ?? "");
        if (!text.trim()) return send(res, 400, { error: T("text missing") });
        if (text.length > adjust.TEXT_MAX) return send(res, 400, { error: T`Text too long (max ${adjust.TEXT_MAX} characters)` });
        const items = adjust.loadPrompts(store.getSetting);
        const promptId = String(b?.promptId || "");
        let prompt = "";
        if (promptId) {
          const e = items.find((i) => i.id === promptId);
          if (!e) return send(res, 404, { error: T("Instruction not found") });
          prompt = e.prompt;
        } else {
          prompt = String(b?.prompt ?? "").trim();
          if (!prompt) return send(res, 400, { error: T("Instruction missing") });
          if (prompt.length > adjust.PROMPT_MAX) return send(res, 400, { error: T("Instruction too long") });
        }
        const { model: model, effort } = agentRunFor("adjust");
        let fresh = "";
        try {
          const out = await runOnce(adjust.adjustPrompt({ text, instruction: prompt }), {
            timeoutMs: Number(process.env.CBASE_ADJUST_TIMEOUT_MS) || 90_000, model: model, effort, atConsumption: onceBooking("adjust"), ...sandboxed(),
          });
          fresh = adjust.resultSanitize(out);
        } catch (e) {
          return send(res, 502, { error: T`Adjusting failed: ${String(e?.message || e).slice(0, 300)}`, model });
        }
        if (!fresh) return send(res, 502, { error: T("The model returned no text."), model });
        // Remembered only AFTER success: an instruction that delivered nothing does not belong
        // in the list — next time it would appear there as proven.
        const { items: list, entry } = adjust.rememberPrompt(items, { id: promptId, prompt, title: String(b?.title || "") });
        adjust.savePrompts(store.setSetting, list);
        return send(res, 200, { fresh, model, promptId: entry.id, title: entry.title });
      }
  return NEXT;
}

export async function autocompactNotifyRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      if (p === "/api/autocompact" && m === "GET") {
        return send(res, 200, {
          percent: autocompact.globalValueOf(store.getSetting),
          stages: autocompact.STAGES,
          maxTokens: autocompact.globalerMax(store.getSetting),
          maxStages: autocompact.MAX_STAGES,
        });
      }
      if (p === "/api/autocompact" && m === "PUT") {
        const b = await readBody(req);
        // Both fields can be set individually — the UI has two controls, and setting one
        // must not require sending the other.
        let st = autocompact.globalValueOf(store.getSetting);
        if (b?.percent !== undefined) {
          st = autocompact.stage(b.percent);
          if (st === null) {
            return send(res, 400, { error: T`Invalid level — allowed are 0 (off) or ${autocompact.STAGES.join(", ")} %.` });
          }
        }
        let max = autocompact.globalerMax(store.getSetting);
        if (b?.maxTokens !== undefined) {
          max = autocompact.maxStage(b.maxTokens);
          if (max === null) {
            return send(res, 400, { error: T`Invalid cap — allowed are 0 (none) or ${autocompact.MAX_STAGES.join(", ")} tokens.` });
          }
        }
        store.setSetting(autocompact.SETTING_KEY, String(st));
        store.setSetting(autocompact.MAX_KEY, String(max));
        return send(res, 200, { ok: true, percent: st, stages: autocompact.STAGES, maxTokens: max, maxStages: autocompact.MAX_STAGES });
      }
      // ── Notifications: the global defaults per kind ─────────────────────────
      // Installation-wide and not per workspace: so are the devices delivered to.
      // A workspace switch would claim a separation the recipient does not have.
      if (p === "/api/notify" && m === "GET") {
        const global = notifications.globalDefaults(store.getSetting);
        return send(res, 200, {
          kinds: notifications.KINDS.map((a) => ({
            key: a.key, chat: a.chat, preset: a.preset, value: global[a.key],
            label: notifications.kindLabel(a.key), hint: notifications.kindHint(a.key),
          })),
          chatKinds: notifications.CHAT_KINDS,
          scheduleKinds: notifications.SCHEDULE_KINDS,
        });
      }
      if (p === "/api/notify" && m === "PUT") {
        const b = await readBody(req);
        for (const a of notifications.KINDS) {
          if (!(a.key in (b || {}))) continue;
          store.setSetting(`push.${a.key}`, b[a.key] ? "1" : "0");
        }
        const global = notifications.globalDefaults(store.getSetting);
        return send(res, 200, { ok: true, values: global });
      }
  return NEXT;
}
