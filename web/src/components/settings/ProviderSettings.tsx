"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api, removeOpenRouterKey, loadOpenRouterAccess, loadConsumption, setOpenRouterAccess, OPENROUTER_ID,
  type AccountStatus, type OpenRouterAccess,
} from "@/lib/api";
import { AuthLoginConsole } from "@/components/AuthLoginConsole";
import { useT, dateLocale } from "@/lib/i18n";
import { defaultLevelEntries } from "@/lib/effort";
import { AnthropicMark, OpenAIMark, OpenRouterMark } from "@/components/ProviderMarks";
import { ModelChoice, type ModelGroup, type ModelOption } from "@/components/ModelChoice";
import { field, ghostSm, primary, quietDangerSm, Toggle, select as selectCls } from "@/components/CbKit";
import { Group, Info, Ring, Row, type Tone } from "@/components/settings/SettingsKit";
import { usd } from "@/components/settings/UsageKit";
import type { RingWindow } from "@/components/TopNav";

// Settings → Providers. EXACTLY three: Claude and Codex with their subscription (PTY login), OpenRouter with a key. "Add
// provider", the free-endpoint editor (preset, base URL, model list, tier mapping, extra fields, capabilities) and the
// third-party card are deleted, not parked — the server no longer knows the routes. OpenRouter has a FIXED card: set and
// remove the key plus the two privacy toggles (`GET/PUT/DELETE /api/openrouter`, contract `OPENROUTER_*` in
// account/usage-contract.js, bound in web/test/usage-binding.test.mjs). Models, prices and context windows come from the
// OpenRouter catalog — several hundred models, so the default-model row picks through the shared search
// (components/ModelChoice.tsx).
type ProviderCaps = { ownsAgentLoop?: boolean; permissionPrompt: boolean; fork: boolean; effort: boolean; plan: boolean; vision?: boolean; streaming?: boolean; reasoning?: boolean };
interface ProviderInfo {
  id: string;
  label: string;
  models: { id: string; label: string; efforts?: string[] }[];
  caps: ProviderCaps;
  connected: boolean;
  authMethod: string;
  defaultModel: string;
  // The default effort level: the chosen one, else the catalog level of the default model, else medium. Optional: an
  // older server does not send it — then there is no selection.
  defaultEffort?: string;
}
interface ProvidersResp { active: string; providers: ProviderInfo[]; }

// ── The numbers on the cards come from the SAME routes as the "Usage" page ──────────────────
// `/api/usage` (Claude), `/api/usage/codex` and `/api/usage/consumption` (OpenRouter, 30 days). The number appears in
// two places but has ONE source: a separate computation here would reproduce the error the app-agent catalog carried
// for a week — two lists that drift apart.
// The window choice is not reinvented either: `ring` is the session window and carries a value even when the legacy
// fields stay empty (exactly at the limit) — the header in `TopNav` follows the same order.
interface ClaudeUsage {
  fiveHour: { utilization: number | null; resetsAt: string | null };
  sevenDay: { utilization: number | null; resetsAt: string | null };
  ring?: RingWindow | null;
  blocking?: RingWindow | null;
}
interface CodexWindow { usedPercent: number | null; windowMinutes: number | null; resetsAt: string | null }
interface CodexUsage { connected: boolean; primary?: CodexWindow | null; secondary?: CodexWindow | null; planType?: string; ring?: RingWindow | null; blocking?: RingWindow | null }

/**
 * What stands at the top right of the card.
 *
 * `window` is a subscription quota with a reset — the card draws the ring for it.
 * `cost` is the answer for OpenRouter: there is no quota, only a price per token. A ring needs a denominator; without a
 * cap the card would have to invent one, and a ring at 100% ("everything left") would simply be a lie for a credit
 * account. The cost of the last 30 days answers the same question — "how much is gone" — with the only number this
 * provider has for it (the same as under Usage → OpenRouter).
 */
type Quota =
  | { kind: "window"; utilization: number; resetsAt: string | null; name: string }
  | { kind: "cost"; text: string }
  | null;

const NATIVE = new Set(["claude", "codex"]);
const PLAN: Record<string, string> = { team: "Team", pro: "Pro", max: "Max", enterprise: "Enterprise", free: "Free" };

const CAPS: { key: keyof ProviderCaps; label: string }[] = [
  { key: "permissionPrompt", label: "Permission prompts" },
  { key: "plan", label: "Plan mode" },
  { key: "fork", label: "Fork" },
  { key: "effort", label: "Reasoning effort" },
  { key: "vision", label: "Images" },
];

function Dot({ ok }: { ok: boolean }) { return <span className={`h-2 w-2 shrink-0 rounded-full ${ok ? "bg-[#1a7f37]" : "bg-dim/40"}`} />; }
function CheckIcon() { return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5l3.5 3.5L13 4.5" /></svg>; }
function DashIcon() { return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M4 8h8" /></svg>; }

function CapChip({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${ok ? "bg-accent/12 text-accent" : "bg-hover text-dim/60"}`}>{ok ? <CheckIcon /> : <DashIcon />}{label}</span>;
}
function Meta({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline gap-3"><span className="w-[84px] shrink-0 text-[11px] text-dim">{label}</span><span className="min-w-0 flex-1 truncate text-[12px] font-medium">{value}</span></div>;
}

// Card frame — ONE shape for native and third-party cards, so a new provider does not look different from a built-in
// one. `edge`/accent edge means "active" here.
const card = (on: boolean) =>
  `flex h-full flex-col rounded-2xl border p-4 text-left transition-colors ${on ? "border-accent/55 bg-accent/[0.035]" : "border-edge bg-bg"}`;
const markerTile = "grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-edge bg-panel text-fg";

/**
 * The "Active" mark with its explanation.
 *
 * The sentence explains exactly THIS mark, so it sits on it instead of in a paragraph under the page heading.
 */
function ActiveMarker() {
  const t = useT();
  return (
    <span className="flex items-center gap-1">
      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">{t("Active")}</span>
      <Info text={t("The active provider handles new chats and all AI side tasks (titles, context curation). Sign in here and switch between providers anytime.")} />
    </span>
  );
}

/**
 * The ring (or the cost figure) at the top right of the card.
 *
 * The ring shows what is LEFT — a fuel gauge: a full ring means plenty of quota. The COLOR therefore does not come from
 * its own value (that would invert the thresholds: 95% left would be red) but from the utilization, with the same 70/90
 * marks as the header ring and the bars of the usage page. The tooltip says that the number is the remainder, not the
 * consumption, with the same wording the usage page writes under its bars.
 */
function QuotaBlock({ k }: { k: Quota }) {
  const t = useT();
  const loc = dateLocale();
  if (!k) return null;
  if (k.kind === "cost") {
    return (
      <div className="shrink-0 text-right">
        <div className="text-[10px] uppercase tracking-wide text-dim">{t("Cost, 30 days")}</div>
        <div className="mt-0.5 text-[14px] font-semibold tabular-nums">{k.text}</div>
      </div>
    );
  }
  const rest = Math.max(0, Math.min(100, Math.round(100 - k.utilization)));
  const tone: Tone = k.utilization >= 90 ? "danger" : k.utilization >= 70 ? "warn" : "accent";
  const reset = k.resetsAt ? new Date(k.resetsAt).toLocaleString(loc, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div
      className="shrink-0"
      title={`${k.name} · ${t("{rem} % left", { rem: rest })}${reset ? ` · ${t("resets {reset}", { reset })}` : ""}`}
    >
      <Ring
        percent={rest}
        tone={tone}
        size={46}
        label={
          <span className="block max-w-[112px]">
            {k.name}
            {reset && <><br />{t("resets {reset}", { reset })}</>}
          </span>
        }
      />
    </div>
  );
}

// Window name — the same mapping as the bars of the usage page: credits and spend cap have no time window at all, a
// model-specific limit carries its model name.
function windowName(r: RingWindow, t: (s: string, p?: Record<string, string | number>) => string): string {
  if (r.group === "credits") return t("Credits");
  if (r.group === "spend") return t("Spend limit");
  if (r.scope) return t("{name} limit", { name: r.scope });
  return r.group === "weekly" ? t("7-day limit") : t("5-hour limit");
}

export function ProviderSettings() {
  const t = useT();
  const loc = dateLocale();
  const [data, setData] = useState<ProvidersResp | null>(null);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsage | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  // OpenRouter: the access (key set? two toggles) and the cost of the last 30 days. `null` means "not loaded yet" or
  // "unknown" — never "no key" or "nothing consumed".
  const [access, setAccess] = useState<OpenRouterAccess | null>(null);
  const [orCost, setOrCost] = useState<number | null>(null);

  const load = useCallback(async (): Promise<ProvidersResp | null> => {
    try {
      const [d, a, z] = await Promise.all([
        api<ProvidersResp>("/api/providers"),
        api<AccountStatus>("/api/account").catch(() => null),
        loadOpenRouterAccess().catch(() => null),
      ]);
      setData(d); setAccount(a); setAccess(z); setError("");
      return d;
    } catch (e) { setError(String((e as Error).message)); return null; }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!connecting) return;
    const iv = setInterval(async () => {
      const d = await load();
      if (d?.providers.find((p) => p.id === connecting)?.connected) setConnecting(null);
    }, 2500);
    return () => clearInterval(iv);
  }, [connecting, load]);

  // The quotas do NOT hang on the 2.5-second poll of the sign-in flow: they change by the minute, not by the second.
  // They are measured again when the set of connected providers changes — after a sign-in and after a disconnect.
  // `null` means "we do not know yet who is connected" and is not an empty set: measuring starts with the first
  // response of /api/providers.
  const connected = data ? data.providers.filter((p) => p.connected).map((p) => p.id).sort().join(",") : null;
  useEffect(() => {
    if (connected === null) return;
    let stale = false;
    Promise.allSettled([
      api<ClaudeUsage>("/api/usage").then((d) => { if (!stale) setClaudeUsage(d); }),
      api<CodexUsage>("/api/usage/codex").then((d) => { if (!stale) setCodexUsage(d); }),
      loadConsumption(OPENROUTER_ID, "30d").then((v) => { if (!stale) setOrCost(v.sums?.costUsd ?? null); }),
    ]);
    return () => { stale = true; };
  }, [connected]);

  async function setActive(id: string) {
    if (switching || data?.active === id) return;
    setSwitching(id);
    try {
      await api("/api/provider", { method: "POST", body: JSON.stringify({ provider: id }) });
      await load();
      window.dispatchEvent(new CustomEvent("cbase-provider-changed", { detail: { active: id } }));
    } catch (e) { setError(String((e as Error).message)); }
    finally { setSwitching(null); }
  }

  async function changeDefaultModel(id: string, model: string) {
    setSavingModel(id);
    try { await api("/api/default-model", { method: "PUT", body: JSON.stringify({ provider: id, model }) }); await load(); }
    catch (e) { setError(String((e as Error).message)); }
    finally { setSavingModel(null); }
  }

  async function changeDefaultEffort(id: string, effort: string) {
    setSavingModel(id);
    try { await api("/api/default-effort", { method: "PUT", body: JSON.stringify({ provider: id, effort }) }); await load(); }
    catch (e) { setError(String((e as Error).message)); }
    finally { setSavingModel(null); }
  }

  async function logoutNative(id: string) {
    setBusy(id);
    try { await api(id === "claude" ? "/api/account/logout" : "/api/account/codex/logout", { method: "POST", body: JSON.stringify({}) }); await load(); }
    catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(null); }
  }

  // OpenRouter: every change goes out as a PUT with BOTH toggles (required fields of the contract — a missing field is
  // not a statement), the key only when one is entered. Afterwards the page re-reads the state instead of trusting the
  // response: the server decides what is stored.
  async function saveOpenRouter(toggle: { onlyWithoutSaving: boolean; noDataUsage: boolean }, apiKey?: string) {
    setBusy(OPENROUTER_ID); setError("");
    try { await setOpenRouterAccess(toggle, apiKey); await load(); return true; }
    catch (e) { setError(String((e as Error).message)); return false; }
    finally { setBusy(null); }
  }
  async function removeOpenRouter() {
    setBusy(OPENROUTER_ID); setError("");
    try { await removeOpenRouterKey(); await load(); }
    catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(null); }
  }

  const active = data?.active;

  const nativeProviders = (data?.providers || []).filter((p) => NATIVE.has(p.id));
  const orderedNative = ["claude", "codex"].map((id) => nativeProviders.find((p) => p.id === id)).filter((p): p is ProviderInfo => !!p);
  const openRouter = (data?.providers || []).find((p) => p.id === OPENROUTER_ID) ?? null;
  // Only providers with at least one model get a "Default model" row below — otherwise it would be an empty select with
  // nothing to choose.
  const withModels = (data?.providers || []).filter((p) => p.models.filter((m) => m.id).length > 0);

  function quotaFor(p: ProviderInfo): Quota {
    if (!p.connected) return null;
    if (p.id === "claude") {
      const r = claudeUsage?.ring;
      // A credit pot is NOT a window. `ring` reports it as `{group:"credits", percent:100}` as soon as it is not open —
      // the 100 mean "not available", not "used up". Led as a ring, the card claimed "0% left" while the 5-hour window
      // stood at 84%. The pot has its own row on the usage page; here the card falls back to the window the user
      // really consumes.
      if (r && r.group !== "credits") return { kind: "window", utilization: r.percent, resetsAt: r.resetsAt, name: windowName(r, t) };
      if (claudeUsage?.fiveHour?.utilization != null) {
        return { kind: "window", utilization: claudeUsage.fiveHour.utilization, resetsAt: claudeUsage.fiveHour.resetsAt, name: t("5-hour limit") };
      }
      return null;
    }
    if (p.id === "codex") {
      if (!codexUsage?.connected) return null;
      const r = codexUsage.ring;
      // The same clamp as for Claude — `ring` is the same field for both providers, and what does not occur here today
      // will with the next provider update.
      if (r && r.group !== "credits") return { kind: "window", utilization: r.percent, resetsAt: r.resetsAt, name: windowName(r, t) };
      const lang = codexUsage.secondary?.usedPercent != null;
      const w = lang ? codexUsage.secondary : codexUsage.primary;
      if (w?.usedPercent != null) {
        return { kind: "window", utilization: w.usedPercent, resetsAt: w.resetsAt ?? null, name: lang ? t("Long window") : t("Short window") };
      }
      return null;
    }
    return null;
  }

  return (
    <div>
      {loading && !data && <p className="text-[12.5px] text-dim">{t("Loading providers…")}</p>}

      {/* Grid instead of list: one card per provider, all states comparable side by side. */}
      <div className="grid grid-cols-1 gap-3 @2xl/kit:grid-cols-2">
        {orderedNative.map((p) => (
          <NativeCard key={p.id} p={p} active={active} quota={quotaFor(p)} connecting={connecting}
            switching={switching} busy={busy} account={account} onActivate={setActive}
            onConnect={(id) => { setError(""); setConnecting(id); }} onLogout={logoutNative} />
        ))}
        {data && (
          <OpenRouterCard
            p={openRouter}
            access={access}
            active={active}
            // Without a key no cost figure — "$ 0.00" could not be told from "never ran".
            quota={access?.keySet && orCost !== null ? { kind: "cost", text: usd(orCost, loc) } : null}
            switching={switching}
            busy={busy === OPENROUTER_ID}
            onActivate={setActive}
            onSave={saveOpenRouter}
            onRemove={removeOpenRouter}
          />
        )}
      </div>

      {/* The sign-in console sits BELOW the grid, not in the card: only one provider signs in at a time, and a terminal in
          a grid cell would either have burst the cell or squeezed the terminal to 300 px. */}
      {connecting && (
        <div className="mt-4 rounded-2xl border border-edge bg-bg p-4">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] text-dim">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />{t("Waiting for authorization in your browser…")}<span className="flex-1" />
            <button onClick={() => setConnecting(null)} className={ghostSm}>{t("Cancel")}</button>
          </div>
          <AuthLoginConsole
            onExit={load}
            connectPath={connecting === "claude" ? "/api/account/connect" : "/api/account/codex/connect"}
            title={connecting === "claude" ? "Claude sign-in" : "Codex sign-in"}
          />
        </div>
      )}

      {withModels.length > 0 && (
        <Group title={t("Default model")}>
          {withModels.map((p) => (
            <DefaultModelRow key={p.id} p={p} catalog={data?.providers} savingModel={savingModel} onModelChange={changeDefaultModel} onEffortChange={changeDefaultEffort} />
          ))}
        </Group>
      )}

      {error && !connecting && <p className="mt-3 text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}

// ── Default model of a provider — ONE row per provider ─────────────────
//
// A controlled `<select>` whose `value` is in no option silently showed the FIRST entry. The row now picks through the
// shared search (`ModelChoice`; OpenRouter carries several hundred models), and the rule still holds: a value the list
// does not carry stands there as itself. Otherwise the page would claim a default nobody ever set — exactly when the
// stored value does not run: gpt-5.4 and gpt-5.4-mini drop out of /api/providers while the Codex login reports
// "chatgpt" (they answer HTTP 400 there).
//
// Server-side this can no longer happen: `defaultModelFor` picks only from the models visible for THIS account kind,
// and `PUT /api/default-model` rejects an invisible one with 400 and two distinguishable reasons. A display that is only
// right as long as the server does nothing wrong says the wrong thing without a word — so a value without an option
// stands in the list itself, with the reason next to it and in a warning ring.
//
// Next to it the default effort level: the level of every chat of this provider that carries none of its own, resolved
// in the run (`effortRunning`) and clamped there to the chat's model. The selection shows the levels of the default
// model (the same building block as every effort selection, without an empty entry — the default IS a level); it is
// absent when the provider has no thinking level, the default model has no levels, or the server sends none.
function DefaultModelRow({ p, catalog, savingModel, onModelChange, onEffortChange }: {
  p: ProviderInfo;
  catalog: ProviderInfo[] | undefined;
  savingModel: string | null;
  onModelChange: (id: string, model: string) => void;
  onEffortChange: (id: string, effort: string) => void;
}) {
  const t = useT();
  const models = p.models.filter((mo) => mo.id);
  const missing = !models.some((mo) => mo.id === p.defaultModel);
  // No row without a default level, without a thinking level of the provider and on a default model without levels.
  const levels = defaultLevelEntries(p, catalog, t);
  const groups: ModelGroup[] = [{ key: p.id, label: p.label, options: models.map((mo) => ({ value: mo.id, label: mo.label || mo.id })) }];
  // The stored value without an option stands as its own row above the list, with the reason — in warning color, the
  // button in a warning ring (instead of a warning text color: a second text color on the same element wins in Tailwind
  // by its value, not by order — the ring collides with nothing).
  const top: ModelOption[] = missing
    ? [{ value: p.defaultModel, warn: true, label: p.defaultModel ? `${p.defaultModel} — ${t("cannot run on the signed-in account")}` : t("no default set") }]
    : [];
  return (
    <Row title={p.label}>
      <div className="flex items-center gap-2">
      <ModelChoice
        groups={groups}
        top={top}
        value={p.defaultModel}
        onChoice={(value) => { if (value !== p.defaultModel) onModelChange(p.id, value); }}
        disabled={savingModel === p.id}
        label={t("Default model")}
        warn={missing}
        className="max-w-[240px]"
        data={{ "data-default-model": p.id }}
      />
      {levels.length > 0 && (
        <select
          value={p.defaultEffort}
          onChange={(e) => onEffortChange(p.id, e.target.value)}
          disabled={savingModel === p.id}
          aria-label={t("Default effort")}
          data-default-level={p.id}
          className={`${selectCls} max-w-[160px] disabled:opacity-50`}
        >
          {levels.map((e) => <option key={e.id} value={e.id} title={e.marker}>{e.label}</option>)}
        </select>
      )}
      </div>
    </Row>
  );
}

// ── Native card (Claude/Codex, PTY login) ──────────────────────────────────
// Deliberately at MODULE level: a component defined in render would get a NEW identity on every parent render → React
// remounts the card. On the 2.5 s connection poll that used to destroy the login terminal continuously (typing/pasting
// impossible).
function NativeCard({ p, active, quota, connecting, switching, busy, account, onActivate, onConnect, onLogout }: {
  p: ProviderInfo;
  active: string | undefined;
  quota: Quota;
  connecting: string | null;
  switching: string | null;
  busy: string | null;
  account: AccountStatus | null;
  onActivate: (id: string) => void;
  onConnect: (id: string) => void;
  onLogout: (id: string) => void;
}) {
  const t = useT();
  const on = active === p.id;
  const isClaude = p.id === "claude";
  const mark = isClaude ? <AnthropicMark /> : <OpenAIMark />;
  const subtitle = isClaude ? t("Runs via the Claude Code CLI with your Claude plan.") : t("Runs via the codex CLI with your ChatGPT subscription.");
  const statusSuffix = !isClaude && p.connected && p.authMethod === "chatgpt" ? t("ChatGPT subscription") : "";
  const accountData = isClaude && p.connected && account && (account.email || account.orgName || account.subscriptionType);
  return (
    <article className={card(on)} data-set-provider={p.id}>
      <div className="flex items-start gap-3">
        <span className={markerTile}>{mark}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[14.5px] font-semibold">{p.label}</h3>
            {on && <ActiveMarker />}
          </div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-dim">{subtitle}</p>
        </div>
        <QuotaBlock k={quota} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
        <Dot ok={p.connected} />
        <span className="text-[12.5px] font-medium">
          {p.connected ? t("Connected") : t("Not connected")}
          {statusSuffix && <span className="font-normal text-dim"> · {statusSuffix}</span>}
        </span>
        <span className="flex-1" />
        {!on && p.connected && (
          <button onClick={() => onActivate(p.id)} disabled={!!switching} className={`${ghostSm} disabled:opacity-50`}>
            {switching === p.id ? t("Switching…") : t("Activate")}
          </button>
        )}
        {!p.connected && connecting !== p.id && (
          <button onClick={() => onConnect(p.id)} className={primary}>{isClaude ? t("Connect with Claude") : t("Connect with ChatGPT")}</button>
        )}
        {p.connected && (
          <button onClick={() => onLogout(p.id)} disabled={busy === p.id} className={`${quietDangerSm} disabled:opacity-40`}>
            {busy === p.id ? t("Signing out…") : t("Disconnect")}
          </button>
        )}
      </div>

      {accountData && (
        <div className="mt-3 flex flex-col gap-1 border-t border-edge pt-3">
          {account.email && <Meta label={t("Email")} value={account.email} />}
          {account.orgName && <Meta label={t("Organization")} value={account.orgName} />}
          {account.subscriptionType && <Meta label={t("Plan##subscription")} value={PLAN[account.subscriptionType] || account.subscriptionType} />}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">{CAPS.map((c) => <CapChip key={c.key} ok={!!p.caps[c.key]} label={t(c.label)} />)}</div>
    </article>
  );
}

// ── OpenRouter: the fixed third card ─────────────────
// Only the key and two privacy toggles are settable: "Only providers without data storage" (OpenRouter `zdr`) and "No
// data use by providers" (`data_collection: deny`). Routing, sorting, extra fields and capabilities of the old editor
// are gone. The key never leaves the server — the card only sees `keySet`; the field is for setting or replacing and is
// cleared after saving. A toggle without a loaded state (`null`) is locked: a PUT always sends BOTH, and a guessed
// second value would overwrite the stored one.
function OpenRouterCard({ p, access, active, quota, switching, busy, onActivate, onSave, onRemove }: {
  p: ProviderInfo | null;
  access: OpenRouterAccess | null;
  active: string | undefined;
  quota: Quota;
  switching: string | null;
  busy: boolean;
  onActivate: (id: string) => void;
  onSave: (toggle: { onlyWithoutSaving: boolean; noDataUsage: boolean }, apiKey?: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const t = useT();
  const [key, setKey] = useState("");
  const on = active === OPENROUTER_ID;
  const set = access?.keySet === true;
  const connected = p?.connected ?? set;
  const state = access && access.onlyWithoutSaving !== null && access.noDataUsage !== null
    ? { onlyWithoutSaving: access.onlyWithoutSaving, noDataUsage: access.noDataUsage }
    : null;
  const subtitle = t("The whole catalog with tools behind one key — billed by usage.");
  const modelCount = p ? p.models.filter((m) => m.id).length : 0;

  async function save() {
    const k = key.trim();
    if (!k || !state) return;
    if (await onSave(state, k)) setKey("");
  }

  return (
    <article className={card(on)} data-set-provider={OPENROUTER_ID}>
      <div className="flex items-start gap-3">
        <span className={markerTile}><OpenRouterMark /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[14.5px] font-semibold">{p?.label || "OpenRouter"}</h3>
            {on && <ActiveMarker />}
          </div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-dim">{subtitle}</p>
        </div>
        <QuotaBlock k={quota} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
        <Dot ok={set} />
        <span className="text-[12.5px] font-medium" data-openrouter-key={access === null ? "unknown" : set ? "set" : "missing"}>
          {access === null ? t("state unknown") : set ? t("Key stored") : t("No key")}
          {set && modelCount > 0 && <span className="font-normal text-dim"> · {t("{n} models", { n: modelCount })}</span>}
        </span>
        <span className="flex-1" />
        {!on && connected && (
          <button onClick={() => onActivate(OPENROUTER_ID)} disabled={!!switching} className={`${ghostSm} disabled:opacity-50`}>
            {switching === OPENROUTER_ID ? t("Switching…") : t("Activate")}
          </button>
        )}
        {set && (
          <button onClick={onRemove} disabled={busy} className={`${quietDangerSm} disabled:opacity-40`} data-openrouter-remove>
            {busy ? "…" : t("Remove key")}
          </button>
        )}
      </div>

      <form className="mt-3 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={set ? t("Enter a new key to replace it") : "sk-or-…"}
          aria-label={t("API key")}
          autoComplete="off"
          data-openrouter-input
          className={`${field} min-w-0 flex-1`}
        />
        <button type="submit" disabled={busy || !state || !key.trim()} className={`${primary} shrink-0 disabled:opacity-40`}>
          {busy ? t("Saving…") : set ? t("Replace") : t("Save")}
        </button>
      </form>

      <div className="mt-3 flex flex-col gap-2.5 border-t border-edge pt-3">
        <div className="flex items-center gap-3" data-openrouter-toggle="onlyWithoutSaving">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium">{t("Only providers without data retention")}</div>
            <div className="text-[11.5px] leading-snug text-dim">{t("Requests only go to endpoints that keep nothing (zero data retention).")}</div>
          </div>
          <Toggle
            on={state?.onlyWithoutSaving === true}
            disabled={!state || busy}
            onClick={() => { if (state) void onSave({ ...state, onlyWithoutSaving: !state.onlyWithoutSaving }); }}
          />
        </div>
        <div className="flex items-center gap-3" data-openrouter-toggle="noDataUsage">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium">{t("No data use by providers")}</div>
            <div className="text-[11.5px] leading-snug text-dim">{t("Providers that store requests or use them for training are skipped.")}</div>
          </div>
          <Toggle
            on={state?.noDataUsage === true}
            disabled={!state || busy}
            onClick={() => { if (state) void onSave({ ...state, noDataUsage: !state.noDataUsage }); }}
          />
        </div>
      </div>

      {p && <div className="mt-3 flex flex-wrap items-center gap-1.5">{CAPS.map((c) => <CapChip key={c.key} ok={!!p.caps[c.key]} label={t(c.label)} />)}</div>}
    </article>
  );
}
