"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AutocompactSetting } from "@/components/Autocompact";
import { Hint, select } from "@/components/CbKit";
import { ModelChoice } from "@/components/ModelChoice";
import { Group, Row } from "@/components/settings/SettingsKit";
import { type EffortCatalog, effortEntries, effortPicker, effortStandardLabel } from "@/lib/effort";

// Settings page "Models": provider + model per internal task (auto title, compact, curator, classification, services scan).
// "Auto" = the default behaviour (fixed defaults or chat model / provider default); a choice takes effect on the next run of the
// respective task — no restart needed.
//
// No heading and no intro paragraph (the page title is carried by the modal's header); instead four groups by OCCASION rather than
// thirteen uniform select fields one under the other. The explanation per agent (`desc`) is a visible hint in its row; if it runs
// beyond three lines, `Row` cuts it itself and shows an (i) with the full wording.

interface ProviderInfo {
  id: string;
  label: string;
  connected: boolean;
  defaultModel?: string;
  defaultEffort?: string;
  caps?: { effort?: boolean };
  models: { id: string; label: string; efforts?: string[] }[];
}
type AgentChoice = { provider: string; model: string } | null;
// The model the oneshot REALLY runs with (server: the same resolution as `runOnce`) — the effort selection and the label
// "Default · <level>" depend on it, even for "Auto". `asChat`: compaction without its own choice runs with the model of the
// respective CHAT — there is no single model, the server says so (provider and model empty), and the page invents none.
type Effective = { provider: string; model: string; asChat?: boolean };

// key = backend key; label/desc are dictionary keys (via t()).
//
// WARNING: `web/test/app-agents-catalog.test.mjs` cuts this block out of the file by regex and holds the SET against
// `AGENT_MODEL_KEYS` (backend) and against the iOS picker, label and desc additionally word for word against iOS. The declaration
// must therefore keep exactly this form (one `const AGENTS` array of key/label/desc, one per line) — grouping happens below via a
// second structure that POINTS to the keys instead of breaking up this list.
const AGENTS: { key: string; label: string; desc: string }[] = [
  { key: "title", label: "Auto title", desc: "Names new chats after the first exchange." },
  { key: "goal", label: "Goal check", desc: "Judges after each run with an active /goal whether the goal is achieved (line in the chat)." },
  { key: "workflow", label: "Workflow verdicts", desc: "Decides conditions in running workflows, produces loop lists, interprets answers at the round cap and checks a step's completion. One short call per verdict; the completion-check model can be overridden per workflow in its run settings." },
  { key: "compact", label: "Compact context", desc: "Summarizes the history on /compact. Auto = the respective chat's model." },
  { key: "curator", label: "Context curator", desc: "Routes dumpster drops into projects and merges project context." },
  { key: "classify", label: "Context classification", desc: "Assigns dropped snippets to a category (title, summary, tags). Auto = the active provider's default model." },
  { key: "services", label: "Service scan", desc: "Inventories a project's stack (services, ports) on creation or re-scan." },
  { key: "channel_status", label: "Summary on request", desc: "Summarises a chat freshly on request — for any reader that reads it via cbase_agents_list (summarize), not just over channels. One call per request, sandboxed." },
  { key: "adjust", label: "Adjust text", desc: "Rephrases selected text according to your instruction (“Adjust” on an approval card) and puts the result on the clipboard. One short call per adjustment, sandboxed — a fast model is enough." },
];

// The order of the page: by the OCCASION at which the task arises. It points to the keys above and does NOT carry the entries
// itself — otherwise the catalog would exist twice and the guard checks only one half. What is missing here does not disappear:
// everything unassigned stands at the bottom in a group of its own (see `rest`).
const GROUPS: { title: string; keys: string[] }[] = [
  // `channel_status` used to be in the group "Manager" — it stayed when the four `manager_*` fell away.
  { title: "Chat side tasks", keys: ["title", "goal", "compact", "adjust", "channel_status"] },
  { title: "Projects & context", keys: ["curator", "classify", "services"] },
  { title: "Workflows", keys: ["workflow"] },
];

export function AgentModelSettings() {
  const t = useT();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentChoice>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  // The effort level per internal task: "" = Default — in the same settings row as the model.
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [effective, setEffective] = useState<Record<string, Effective>>({});
  // The FULL provider catalog (not only the connected ones): levels, default level and `caps.effort` per provider.
  const [providerCatalog, setProviderCatalog] = useState<EffortCatalog>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ providers: ProviderInfo[] }>("/api/providers"),
      api<{ agents: Record<string, AgentChoice>; defaults: Record<string, string>; efforts?: Record<string, string>; effective?: Record<string, Effective> }>("/api/agent-models"),
    ])
      .then(([pv, agentModels]) => {
        setProviders((pv.providers || []).filter((p) => p.connected && p.models.length));
        setProviderCatalog(pv.providers || []);
        setAgents(agentModels.agents || {});
        setDefaults(agentModels.defaults || {});
        setEfforts(agentModels.efforts || {});
        setEffective(agentModels.effective || {});
      })
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setLoaded(true)); // otherwise the selects stay disabled for good on a fetch error
  }, []);

  const catalog = useMemo(() => new Map(AGENTS.map((a) => [a.key, a])), []);
  // An agent nobody assigned to a group would otherwise be invisible on this page — exactly the harm the catalog guard is built
  // against, one level deeper. It therefore stands at the bottom in a group without a mark instead of silently missing.
  const rest = useMemo(() => {
    const assigned = new Set(GROUPS.flatMap((g) => g.keys));
    return AGENTS.filter((a) => !assigned.has(a.key));
  }, []);

  // Display name of a model (label from the provider list, otherwise the raw id).
  const modelLabel = (provider: string, model: string) => {
    const p = providers.find((x) => x.id === provider);
    return p?.models.find((m) => m.id === model)?.label || model;
  };

  // "Auto" label per task: fixed default → its label; "" → dynamic.
  const autoLabel = (key: string) => {
    const d = defaults[key] || "";
    if (!d) return key === "compact" ? t("Auto (chat model)") : t("Auto (provider default)");
    for (const p of providers) {
      const hit = p.models.find((m) => m.id === d);
      if (hit) return `${t("Auto")} (${hit.label})`;
    }
    return `${t("Auto")} (${d})`;
  };

  async function pick(key: string, value: string) {
    const prev = agents[key] ?? null;
    let next: AgentChoice = null;
    if (value) {
      const i = value.indexOf("|");
      next = { provider: value.slice(0, i), model: value.slice(i + 1) };
    }
    setAgents((a) => ({ ...a, [key]: next })); // optimistic
    try {
      const r = await api<{ effective?: Effective }>("/api/agent-models", { method: "PUT", body: JSON.stringify({ key, provider: next?.provider || "", model: next?.model || "" }) });
      if (r?.effective) setEffective((w) => ({ ...w, [key]: r.effective as Effective }));
    } catch (e) {
      setAgents((a) => ({ ...a, [key]: prev })); // roll back
      setError(String((e as Error).message));
    }
  }

  // The effort level is the second half of the same row — ONLY `effort` is sent ("" = Default, explicitly), the model stays as it
  // is (the server reads a missing field as "unchanged").
  async function pickEffort(key: string, value: string) {
    const prev = efforts[key] ?? "";
    setEfforts((e) => ({ ...e, [key]: value }));
    try {
      await api("/api/agent-models", { method: "PUT", body: JSON.stringify({ key, effort: value }) });
    } catch (e) {
      setEfforts((x) => ({ ...x, [key]: prev }));
      setError(String((e as Error).message));
    }
  }

  const row = (a: { key: string; label: string; desc: string }) => {
    const cur = agents[a.key] ?? null;
    const value = cur ? `${cur.provider}|${cur.model}` : "";
    // "No longer in the list" — that is all the client knows, and all it may claim. It used to say "Auto applies." here; that is
    // wrong: `agentModelSetting` (settings/agent-models.js) checks only the PROVIDER (`isProviderId`), never the model — a saved
    // model that dropped out of the list (e.g. gpt-5.4 under a ChatGPT account) still goes out on the next run and gets its HTTP
    // 400 there. Conversely the entry really falls back to Auto once the provider is gone entirely. Which of the two cases applies
    // this page does not see: its list is filtered to `connected`, the server's registry knows no such difference.
    const stale = cur && !providers.some((p) => p.id === cur.provider && p.models.some((m) => m.id === cur.model));
    // What the effort level computes against: the choice, otherwise the effective model of "Auto". No selection on a model without
    // levels (Haiku 4.5) and for a provider without `caps.effort` — there the oneshot runs without a level.
    // "Like the chat": no model to compute against — the default levels and an empty entry without a level.
    const run: Effective = cur ?? effective[a.key] ?? { provider: "", model: "" };
    const asChat = !cur && run.asChat === true;
    const set = efforts[a.key] ?? "";
    const withLevel = loaded && (asChat || (!!run.provider && effortPicker(run.provider, run.model, providerCatalog)));
    return (
      <div key={a.key}>
        <Row title={t(a.label)} hint={t(a.desc)}>
          {withLevel && (
            <select
              value={set}
              onChange={(e) => pickEffort(a.key, e.target.value)}
              aria-label={t("Effort for {agent}", { agent: t(a.label) })}
              data-agent-effort={a.key}
              className={`${select} w-[150px] shrink-0 cursor-pointer`}
            >
              {effortEntries(run.provider, run.model, providerCatalog, set, asChat ? t("Default") : effortStandardLabel(run.provider, run.model, providerCatalog, t), t).map((w) => (
                <option key={w.id || "standard"} value={w.id} title={w.marker}>{w.label}</option>
              ))}
            </select>
          )}
          {/* The shared model choice with search (components/ModelChoice.tsx) — OpenRouter carries the whole catalog. A value that is
              no longer in the list is shown at the top in warning colour (the warning below says why). */}
          <ModelChoice
            label={t(a.label)}
            value={value}
            onChoice={(w) => pick(a.key, w)}
            disabled={!loaded}
            top={[
              { value: "", label: autoLabel(a.key) },
              ...(stale && cur ? [{ value: value, label: `${cur.provider}: ${modelLabel(cur.provider, cur.model)}`, warn: true }] : []),
            ]}
            groups={providers.map((p) => ({ key: p.id, label: p.label, options: p.models.filter((m) => m.id).map((m) => ({ value: `${p.id}|${m.id}`, label: m.label })) }))}
            warn={!!stale}
            className="w-[220px] shrink-0"
            data={{ "data-agent-model": a.key }}
          />
        </Row>
        {/* The warning stands UNDER the row, not in its hint: that is cut to three lines, and a cut-off warning is none. */}
        {stale && (
          <p className="-mt-1 px-3.5 pb-2.5 text-[11.5px] leading-relaxed text-warn">
            {t("The selected model is no longer on the list. Whether it still goes out or “Auto” takes over is decided only by the next run — only a new choice is reliable.")}
          </p>
        )}
      </div>
    );
  };

  return (
    <div>
      {error && <div className="mb-4"><Hint tone="danger">{error}</Hint></div>}

      {GROUPS.map((g, i) => (
        <Fragment key={g.title}>
          <Group title={t(g.title)}>
            {/* A key that does not (or no longer) exist in the catalog drops out silently here — the opposite direction is caught
                by `rest` further down. */}
            {g.keys.map((k) => catalog.get(k)).filter((a) => a !== undefined).map((a) => row(a))}
          </Group>
          {/* Autocompact: the level stands next to the model that writes the summary ("Compact context" one row above) — hence here
              and not at the top of the page. The section brings its own frame (component in components/Autocompact.tsx). */}
          {i === 0 && <div className="mt-5"><AutocompactSetting /></div>}
        </Fragment>
      ))}
      {rest.length > 0 && <Group>{rest.map(row)}</Group>}

      <p className="mt-4 text-[12px] leading-relaxed text-dim">
        {t("Chat replies are unaffected — you pick their model per chat in the composer.")}
      </p>
    </div>
  );
}
