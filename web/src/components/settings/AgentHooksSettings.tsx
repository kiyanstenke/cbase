"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { RemoveButton, field, ghost, primary, select } from "@/components/CbKit";
import { Group, Chain, type ChainPlace } from "@/components/settings/SettingsKit";

// Settings page "Hooks": Claude-Code-style hooks for the own harness (loop engine, i.e. third-party providers such as Nebius). Each
// hook runs a shell command on an agent event; the command gets the event as JSON on stdin. PreToolUse can block a tool (exit code
// 2 or stdout {"decision":"block","reason":…}), Post/UserPrompt can supply extra context (stdout {"additionalContext":…} or raw
// text). Takes effect on the next run.
//
// On top the event chain — one dot per point in the run, filled with the number of hooks hanging there. A list of select fields
// does not say that the points have an ORDER and that an empty one lies between two occupied ones. Below it the groups, built from
// the kit blocks: ONE surface per list with hairlines instead of a card per row, no page heading and intro paragraph (the title is
// carried by the modal's header, the explanatory text stands above its own group).

interface Hook { event: string; matcher: string; command: string; }

// The points in the run, in CHRONOLOGICAL order — the select list comes from the server and is sorted by creation
// (`HOOK_EVENTS` in toolchain/profiles.js), which is no sequence.
//
// This list is SUBORDINATE to the server's: an event it offers that is missing here is appended at the end with its raw name. A
// missing dot would otherwise be indistinguishable from "nothing hangs here" — and the chain would claim a completeness it does not
// have. The event names themselves deliberately do not go through t(); they stand as `title` on the dot, so that the picture and
// the select list below speak the same language.
const CHAIN: { event: string; label: string }[] = [
  { event: "SessionStart", label: "Session start" },
  { event: "UserPromptSubmit", label: "Input" },
  { event: "PreToolUse", label: "Before the tool" },
  { event: "Notification", label: "Approve##noun" },
  { event: "PostToolUse", label: "After the tool" },
  { event: "SubagentStop", label: "Subagent done" },
  { event: "PreCompact", label: "Before compacting" },
  { event: "Stop", label: "End of the run" },
  { event: "SessionEnd", label: "Session end" },
];

export function AgentHooksSettings() {
  const t = useT();
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [events, setEvents] = useState<string[]>(["PreToolUse", "PostToolUse", "UserPromptSubmit"]);
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<{ hooks: Hook[]; events: string[] }>("/api/agent-hooks")
      .then((d) => { setHooks(d.hooks || []); if (d.events?.length) setEvents(d.events); setLoaded(true); })
      .catch((e) => setStatus(String((e as Error).message)));
  }, []);

  const update = (i: number, patch: Partial<Hook>) => setHooks((hs) => hs.map((h, k) => (k === i ? { ...h, ...patch } : h)));
  const add = () => setHooks((hs) => [...hs, { event: events[0], matcher: "*", command: "" }]);
  const remove = (i: number) => setHooks((hs) => hs.filter((_, k) => k !== i));

  async function save() {
    setStatus(t("Saving…"));
    try {
      const clean = hooks.filter((h) => h.command.trim());
      const r = await api<{ hooks: Hook[] }>("/api/agent-hooks", { method: "PUT", body: JSON.stringify({ hooks: clean }) });
      setHooks(r.hooks || []);
      setStatus(t("Saved."));
    } catch (e) { setStatus(String((e as Error).message)); }
  }

  const places: ChainPlace[] = useMemo(() => {
    // Even an event for which the server offers no choice (any more) gets its point while a hook hangs on it — otherwise it would
    // have disappeared from the picture and still be in the form.
    const existing = new Set([...events, ...hooks.map((h) => h.event)]);
    const known = new Set(CHAIN.map((s) => s.event));
    const followUp = [
      ...CHAIN.filter((s) => existing.has(s.event)).map((s) => ({ event: s.event, text: t(s.label) })),
      ...[...existing].filter((e) => !known.has(e)).map((e) => ({ event: e, text: e })),
    ];
    return followUp.map((s) => {
      const n = hooks.filter((h) => h.event === s.event && h.command.trim()).length;
      return { label: s.text, occupied: n > 0, n, title: s.event };
    });
  }, [events, hooks, t]);

  return (
    <div>
      {/* Group without a mark: the picture needs no heading, it IS the overview. */}
      <Group>
        <div className="px-3.5 py-4"><Chain places={places} /></div>
      </Group>

      <Group
        title={t("Hooks")}
        hint={t("Shell commands the own harness (third-party providers like Nebius) runs at agent events — like in Claude Code. The command receives the event as JSON on stdin. PreToolUse can block a tool (exit code 2 or output {\"decision\":\"block\",\"reason\":…}); PostToolUse and UserPromptSubmit can add context (output {\"additionalContext\":…} or plain text). Claude/Codex use their own CLI hooks.")}
      >
        {hooks.map((h, i) => (
          <div key={i} className="flex flex-col gap-2 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <select
                value={h.event}
                onChange={(e) => update(i, { event: e.target.value })}
                className={`${select} shrink-0 cursor-pointer`}
              >
                {events.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
              </select>
              <input
                value={h.matcher}
                onChange={(e) => update(i, { matcher: e.target.value })}
                placeholder={t("Tool pattern (regex) or *")}
                className={`${field} w-[180px] shrink-0 font-mono text-[12px]`}
              />
              <span className="ml-auto"><RemoveButton label={t("Remove")} onClick={() => remove(i)} /></span>
            </div>
            <input
              value={h.command}
              onChange={(e) => update(i, { command: e.target.value })}
              placeholder={t("Shell command, e.g. jq -r .tool_input.command | tee -a /tmp/agent.log")}
              className={`${field} w-full font-mono text-[12px]`}
            />
          </div>
        ))}
        {loaded && !hooks.length && (
          <p className="px-3.5 py-3.5 text-[12.5px] text-dim">{t("No hooks configured.")}</p>
        )}

        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <button type="button" onClick={add} className={ghost}>{t("+ Hook")}</button>
          <button type="button" onClick={save} disabled={!loaded} className={`${primary} disabled:opacity-50`}>{t("Save")}</button>
          {status && <span className="text-[12px] text-dim">{status}</span>}
        </div>
      </Group>

      <PermissionRulesSettings />
      <WebSearchSettings />
      <TtsSettings />
    </div>
  );
}

// Read aloud under every message. Without a key the device's system voice speaks — so the button works without setup;
// ElevenLabs is the better voice, not the condition.
function TtsSettings() {
  const t = useT();
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [voiceId, setVoiceId] = useState("");
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    api<{ hasKey: boolean; voiceId: string }>("/api/tts/config")
      .then((d) => { setHasKey(d.hasKey); setVoiceId(d.voiceId || ""); })
      .catch((e) => setStatus(String((e as Error).message)));
  }, []);

  async function save() {
    setStatus(t("Saving…"));
    try {
      const r = await api<{ hasKey: boolean }>("/api/tts/config", {
        method: "PUT",
        body: JSON.stringify({ apiKey: apiKey || undefined, voiceId }),
      });
      setHasKey(r.hasKey);
      setApiKey("");
      setStatus(t("Saved."));
    } catch (e) { setStatus(String((e as Error).message)); }
  }

  async function loadVoices() {
    setStatus(t("Loading…"));
    try {
      const r = await api<{ voices: { id: string; name: string }[] }>("/api/tts/voices");
      setVoices(r.voices || []);
      setStatus("");
    } catch (e) { setStatus(String((e as Error).message)); }
  }

  async function removeKey() {
    setStatus(t("Saving…"));
    try {
      const r = await api<{ hasKey: boolean }>("/api/tts/config", { method: "PUT", body: JSON.stringify({ apiKey: null }) });
      setHasKey(r.hasKey);
      setVoices([]);
      setStatus(t("Saved."));
    } catch (e) { setStatus(String((e as Error).message)); }
  }

  return (
    <Group
      title={t("Read aloud (ElevenLabs)")}
      hint={t("Without a key the device's system voice reads aloud. An ElevenLabs key sounds more natural; identical messages are cached so they are not paid for twice.")}
    >
      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        <input
          type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off"
          placeholder={hasKey ? `•••••••• (${t("leave empty to keep")})` : t("ElevenLabs key")}
          className={`${field} w-full`}
        />
        {voices.length > 0 ? (
          <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} aria-label={t("Voice")} className={`${select} w-fit`}>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        ) : (
          <input
            value={voiceId} onChange={(e) => setVoiceId(e.target.value)}
            placeholder={t("Voice")} className={`${field} w-full`}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <button type="button" onClick={save} className={primary}>{t("Save")}</button>
        {hasKey && (
          <>
            <button type="button" onClick={() => { loadVoices().catch(console.error); }} className={ghost}>{t("Load voices")}</button>
            <button type="button" onClick={() => { removeKey().catch(console.error); }} className={ghost}>{t("Remove key")}</button>
            <span className="text-[12px] text-ok">{t("Key stored")}</span>
          </>
        )}
        {status && <span className="text-[12px] text-dim">{status}</span>}
      </div>
    </Group>
  );
}

// Web search of the own harness. Without a key the WebSearch tool runs via DuckDuckGo scraping — that works, but depends on a
// foreign page's HTML. With a real API it is stable.
function WebSearchSettings() {
  const t = useT();
  const [provider, setProvider] = useState("duckduckgo");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [providers, setProviders] = useState<string[]>(["duckduckgo", "brave", "tavily", "searxng"]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    api<{ provider: string; baseUrl: string; hasKey: boolean; providers: string[] }>("/api/web-search")
      .then((d) => { setProvider(d.provider); setBaseUrl(d.baseUrl || ""); setHasKey(d.hasKey); if (d.providers?.length) setProviders(d.providers); })
      .catch((e) => setStatus(String((e as Error).message)));
  }, []);

  async function save() {
    setStatus(t("Saving…"));
    try {
      const r = await api<{ hasKey: boolean }>("/api/web-search", { method: "PUT", body: JSON.stringify({ provider, baseUrl, apiKey: apiKey || undefined }) });
      setHasKey(r.hasKey); setApiKey("");
      setStatus(t("Saved."));
    } catch (e) { setStatus(String((e as Error).message)); }
  }

  const LABEL: Record<string, string> = {
    duckduckgo: "DuckDuckGo (no key, best effort)", brave: "Brave Search API", tavily: "Tavily", searxng: "SearxNG (self-hosted)",
  };

  return (
    <Group
      title={t("Web search")}
      hint={t("Source for the WebSearch tool of the built-in harness (third-party chats). Without a key it scrapes DuckDuckGo's HTML page, which breaks as soon as that page changes. Claude and Codex use their own search.")}
    >
      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label={t("Web search")} className={`${select} w-fit`}>
          {providers.map((p) => <option key={p} value={p}>{t(LABEL[p] || p)}</option>)}
        </select>
        {provider === "searxng" && (
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://searx.example.org" className={`${field} w-full font-mono`} />
        )}
        {provider !== "duckduckgo" && provider !== "searxng" && (
          <input
            type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off"
            placeholder={hasKey ? `•••••••• (${t("leave empty to keep")})` : t("API key")}
            className={`${field} w-full`}
          />
        )}
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button type="button" onClick={save} className={primary}>{t("Save")}</button>
        {status && <span className="text-[12px] text-dim">{status}</span>}
      </div>
    </Group>
  );
}

// Permanent tool approvals. They arise in everyday use through "Always allow" on the approval card; here they can be read, added
// to and removed again. Notation as in Claude Code's settings.json — an entry copied from there works unchanged.
function PermissionRulesSettings() {
  const t = useT();
  const [rules, setRules] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<{ rules: string[] }>("/api/permission-rules")
      .then((d) => { setRules(d.rules || []); setLoaded(true); })
      .catch((e) => setStatus(String((e as Error).message)));
  }, []);

  async function put(next: string[]) {
    setStatus(t("Saving…"));
    try {
      const r = await api<{ rules: string[] }>("/api/permission-rules", { method: "PUT", body: JSON.stringify({ rules: next }) });
      setRules(r.rules || []);
      setStatus(t("Saved."));
    } catch (e) { setStatus(String((e as Error).message)); }
  }

  return (
    <Group
      title={t("Standing permissions")}
      hint={t("Tool calls that go through without asking in the \"Ask\" and \"Auto-edit\" modes. They usually come from \"Always allow\" on the permission card. Same notation as Claude Code: Bash(git status:*) allows everything starting like that, Read(src/**) a path area, WebFetch the whole tool.")}
    >
      {/* The rules as rows with hairlines — the surface belongs to the group, not to the rule. */}
      {rules.map((r) => (
        <div key={r} className="flex items-center gap-2 px-3.5 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{r}</span>
          <RemoveButton label={t("Remove")} onClick={() => put(rules.filter((x) => x !== r))} />
        </div>
      ))}
      {loaded && !rules.length && (
        <p className="px-3.5 py-3.5 text-[12.5px] text-dim">{t("No standing permissions — every sensitive call asks.")}</p>
      )}

      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { put([...rules, draft.trim()]); setDraft(""); } }}
          placeholder="Bash(npm run test:*)"
          className={`${field} min-w-0 flex-1 font-mono text-[12px]`}
        />
        <button
          type="button"
          disabled={!draft.trim()}
          onClick={() => { put([...rules, draft.trim()]); setDraft(""); }}
          className={`${ghost} shrink-0 disabled:opacity-50`}
        >
          {t("Add")}
        </button>
        {status && <span className="shrink-0 text-[12px] text-dim">{status}</span>}
      </div>
    </Group>
  );
}
