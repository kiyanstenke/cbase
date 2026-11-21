"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Toggle, field, select } from "@/components/CbKit";
import { Group, Row } from "@/components/settings/SettingsKit";

// Settings → Workflows: the settings of the dynamic workflows. They are BEHAVIOR, not consumption; the page therefore
// stands in the group "Behavior" after "Chats" (key WORKFLOWS_PAGE in lib/api/usage.ts, bound to the contract).
// Wording and routes are shared with the other clients (web/test/settings-form.test.mjs holds routes and levels against
// iOS and the server).

export function WorkflowsSettings() {
  return (
    <div>
      <WorkflowCapGroup />
      <SaverGroup />
    </div>
  );
}

// ── CPU saver ──
// ONE toggle, off by default: background work (subagents, workflow and outer-loop agents, monitors) runs with lower CPU
// priority, and a new command of it waits up to two minutes under full load. The server requires `enabled` (without ⇒
// 400) and reads the toggle at every start. Own route, own state like the group above. iOS counterpart:
// Settings/SaverSection.swift (same page, same wording).
const SAVER_ROUTE = "/api/cpu-saver";

function SaverGroup() {
  const t = useT();
  // `null` = not loaded yet: claim neither "on" nor "off".
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ enabled: boolean }>(SAVER_ROUTE)
      .then((d) => setOn(d.enabled === true))
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  async function toggle() {
    if (on === null) return;
    const fresh = !on;
    setOn(fresh);
    try {
      const d = await api<{ enabled: boolean }>(SAVER_ROUTE, { method: "PUT", body: JSON.stringify({ enabled: fresh }) });
      setOn(d.enabled === true);
      setError("");
    } catch (e) {
      setOn(!fresh);
      setError(String((e as Error).message));
    }
  }

  return (
    <Group title={t("Computing power")}>
      <div data-cpu-saver>
        <Row
          title={t("Spare computing power")}
          hint={t("Commands of subagents, workflow and outer-loop agents and monitors run at lower CPU priority, and under full load a new command of theirs waits up to two minutes — a chat's main agent never does.")}
        >
          <Toggle on={on ?? false} onClick={() => void toggle()} disabled={on === null} title={t("Spare computing power")} />
        </Row>
        {error && <span className="block px-1 pt-1 text-[12px] text-danger">{error}</span>}
      </div>
    </Group>
  );
}

// ── Concurrency of the dynamic workflows ──
// The per-user cap: how many workflow agents run at once, over ALL workflows together (in server mode the user
// container). Surplus ones wait in the journal as "waiting" (reason cap). Own route, own state, own loading — like the
// two toggles above: if it fails, the rest stays operable. The second cap (per run, fixed 8) is not settable; its
// number comes from the SERVER so the label does not recompute it. iOS counterpart: Settings/WorkflowCapSection.swift.
const DYNWF_CAP_ROUTE = "/api/dyn-workflow-cap";
type DynWfCap = { cap: number; preset: number; max: number; runCap: number };

function WorkflowCapGroup() {
  const t = useT();
  // `null` = not loaded yet (not "8"): a number the server does not hold at all would be a claim.
  const [status, setStatus] = useState<DynWfCap | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<DynWfCap>(DYNWF_CAP_ROUTE)
      .then((d) => { setStatus(d); setDraft(String(d.cap)); })
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  async function save(raw: string) {
    if (!status) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > status.max || n === status.cap) { setDraft(String(status.cap)); return; }
    try {
      const d = await api<{ cap: number; runCap: number }>(DYNWF_CAP_ROUTE, { method: "PUT", body: JSON.stringify({ cap: n }) });
      setStatus({ ...status, cap: d.cap, runCap: d.runCap });
      setDraft(String(d.cap));
      setError("");
    } catch (e) {
      setDraft(String(status.cap));
      setError(String((e as Error).message));
    }
  }

  return (
    <Group title={t("Dynamic workflows")}>
      <div data-dynwf-cap>
        <Row
          title={t("Concurrent workflow agents")}
          hint={t("At most this many agents run at the same time, across all workflows together (default {n}). The rest wait and start as soon as a slot frees up. A single run is additionally limited to {run}.", { n: status?.preset ?? 8, run: status?.runCap ?? "—" })}
        >
          <input
            type="number" min={1} max={status?.max ?? 64} step={1}
            value={draft} disabled={!status}
            aria-label={t("Concurrent workflow agents")}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => save(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className={`${field} w-[72px] text-right tabular-nums`}
          />
        </Row>
        {error && <span className="block px-1 pt-1 text-[12px] text-danger">{error}</span>}
      </div>
      <WorkflowSizeRow />
    </Group>
  );
}

// ── Size guideline of the dynamic workflows ──
// small · medium · large · unrestricted, default medium — handed to the model as a hint when it plans workflows
// (description of cbase_dynamic_workflow). The levels come from the SERVER (`stages`), here stands only their label.
// Own route, own state like the cap above. iOS counterpart: Settings/WorkflowSizeSection.swift.
const DYNWF_SIZE_ROUTE = "/api/dyn-workflow-size";
const SIZE_LABEL: Record<string, string> = {
  small: "Small (under 5 agents)",
  medium: "Medium (under 10 agents)",
  large: "Large (under 50 agents)",
  unrestricted: "Unrestricted",
};
type DynWfSize = { size: string; preset: string; stages: string[] };

function WorkflowSizeRow() {
  const t = useT();
  // `null` = not loaded yet — claim no level the server does not hold.
  const [status, setStatus] = useState<DynWfSize | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<DynWfSize>(DYNWF_SIZE_ROUTE)
      .then((d) => setStatus(d))
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  async function selectSize(size: string) {
    if (!status || size === status.size) return;
    try {
      // The server requires the field (without `size` ⇒ 400) — the body always carries it.
      const d = await api<{ size: string }>(DYNWF_SIZE_ROUTE, { method: "PUT", body: JSON.stringify({ size }) });
      setStatus({ ...status, size: d.size });
      setError("");
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <div data-dynwf-size>
      <Row
        title={t("Dynamic workflow size")}
        hint={t("How large the agent plans dynamic workflows — a hint to the model, not a hard limit. Independently, a run with more than 25 agents or 1.5M tokens gets a warning (not in Ultracode mode). A hard ceiling is set by “+500k” in the message.")}
      >
        <select
          value={status?.size ?? ""} disabled={!status}
          aria-label={t("Dynamic workflow size")}
          onChange={(e) => selectSize(e.target.value)}
          className={`${select} w-fit cursor-pointer`}
        >
          {!status && <option value="">—</option>}
          {(status?.stages ?? []).map((g) => <option key={g} value={g}>{t(SIZE_LABEL[g] ?? g)}</option>)}
        </select>
      </Row>
      {error && <span className="block px-1 pt-1 text-[12px] text-danger">{error}</span>}
    </div>
  );
}
