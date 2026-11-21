"use client";
// Provider/model and effort level of an agent, used by "Scheduled".
import { ModelChoice } from "@/components/ModelChoice";
import { select } from "@/components/CbKit";
import { type EffortCatalog, effortEntries, effortPicker, effortStandardLabel } from "@/lib/effort";
import { useT } from "@/lib/i18n";

export type ProviderMeta = { id: string; label: string; connected: boolean; models: { id: string; label: string }[] };

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";

// Provider/model: a model pulls its provider along.
export function ProviderModel({ provider, model, providers, onChange }: {
  provider: string; model: string; providers: ProviderMeta[];
  onChange: (provider: string, model: string) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-2 @md/detail:grid-cols-2">
      <label className="flex min-w-0 flex-col gap-1">
        <span className={lab}>{t("Providers")}</span>
        <select value={provider} onChange={(e) => onChange(e.target.value, "")} className={select}>
          <option value="">{t("Default (global)")}</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1">
        <span className={lab}>{t("Model")}</span>
        {/* The shared model picker with search (components/ModelChoice.tsx); OpenRouter carries the whole catalog. A
            model also determines its provider: the group of the chosen row. */}
        <ModelChoice
          label={t("Model")}
          value={model}
          onChoice={(m, g) => onChange(m && g ? g.key : provider, m)}
          top={[{ value: "", label: t("Provider's default") }]}
          groups={(provider ? providers.filter((p) => p.id === provider) : providers).map((p) => ({ key: p.id, label: p.label, options: p.models.map((m) => ({ value: m.id, label: m.label })) }))}
          className="w-full"
          data={{ "data-agent-model": "" }}
        />
      </label>
    </div>
  );
}

// The effort level of an agent (of the scheduled jobs): the empty entry reads "Default · <level>" (resolved at
// run time, clamped to the model), and on a model without levels (Haiku 4.5) or with a provider without
// `caps.effort` there is NO choice. "Default (global)" computes with the globally active provider, with
// Claude if none is known.
//
// The globally active provider arrives as a prop (`global`, "" = unknown).
export function LevelChoice({ provider, model, effort, catalog, global, onChange }: {
  provider: string; model: string; effort: string; catalog: EffortCatalog; global: string;
  onChange: (effort: string) => void;
}) {
  const t = useT();
  const active = global || "claude";
  if (!catalog.length || !effortPicker(provider, model, catalog, active)) return null;
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className={lab}>{t("Effort")}</span>
      <select value={effort} onChange={(e) => onChange(e.target.value)} className={select}>
        {effortEntries(provider, model, catalog, effort, effortStandardLabel(provider, model, catalog, t, active), t, active).map((w) => (
          <option key={w.id || "standard"} value={w.id} title={w.marker}>{w.label}</option>
        ))}
      </select>
    </label>
  );
}
