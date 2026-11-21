"use client";

// Settings → "Environment" (gateway mode only): the own, closed server environment — storage use of the personal volume, available
// space (quota, otherwise free space on the server) and container status. Plus the container's own limits, READ-ONLY: only an
// admin may set them, under Settings → Administration. They come from the same answer `GET /gw/env` (`ENV_ADDITION_FIELDS`), read
// through `normOwnResources`.
//
// Deliberately NO larger storage picture: the bar stays a bar. It comes only from `SettingsKit` instead of its own classes — the
// same number thus carries the same thresholds as the header's usage ring.
import { useCallback, useEffect, useState } from "react";
import { ghostSm } from "@/components/CbKit";
import { ProgressBar, Group, Row } from "@/components/settings/SettingsKit";
import { useT, dateLocale } from "@/lib/i18n";
import { normOwnResources, type CpuPrio, type OwnResources } from "@/lib/api";

interface EnvInfo { state: string; startedAt?: string | null }
interface StorageInfo { usedBytes: number; quotaBytes: number | null; hostFreeBytes: number | null }

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} kB`;
}

const GIB = 1024 ** 3;
// Data values, translated at the render site — the same words as on the Administration page.
const PRIORITY_WORD: Record<CpuPrio, string> = { low: "low", normal: "normal", up: "high" };

/** The number at the right of a row: monospaced so the three line up. */
function Value({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[12.5px] font-medium tabular-nums">{children}</span>;
}

export function EnvironmentSettings() {
  const t = useT();
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [own, setOwn] = useState<OwnResources | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [e, s] = await Promise.all([
        fetch("/gw/env").then((r) => (r.ok ? r.json() : null)),
        fetch("/gw/env/storage").then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
      ]);
      setEnv(e); setStorage(s);
      setOwn(e ? normOwnResources(e) : null);
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Reference: the quota if the server gives one — otherwise used + free (physically possible).
  const total = storage ? (storage.quotaBytes ?? (storage.hostFreeBytes != null ? storage.usedBytes + storage.hostFreeBytes : null)) : null;
  const avail = storage ? (storage.quotaBytes != null ? Math.max(0, storage.quotaBytes - storage.usedBytes) : storage.hostFreeBytes) : null;
  const pct = storage && total ? Math.min(100, (storage.usedBytes / total) * 100) : 0;

  return (
    <div>
      {loading && !storage && <p className="text-[12.5px] text-dim">{t("Measuring storage…")}</p>}
      {err && <p className="text-[12.5px] text-danger">{t("Error: {msg}", { msg: err })}</p>}

      {storage && (
        // The sentence says WHOSE storage is shown here, and so belongs to the first group rather than to a single row.
        <Group
          title={t("Storage")}
          hint={t("Your personal, isolated environment on the server — home to your workspaces, chats, and provider logins.")}
        >
          <div className="flex items-center gap-3 px-3.5 py-3">
            <span className="min-w-0 flex-1"><ProgressBar percent={pct} /></span>
            <button onClick={load} disabled={loading} className={`${ghostSm} shrink-0 disabled:opacity-40`}>
              {loading ? "…" : t("Refresh")}
            </button>
          </div>
          <Row title={t("Used")}><Value>{fmtBytes(storage.usedBytes)}</Value></Row>
          <Row title={storage.quotaBytes != null ? t("Available (of quota)") : t("Available (free on the server)")}>
            <Value>{fmtBytes(avail)}</Value>
          </Row>
          {storage.quotaBytes != null && (
            <Row title={t("Quota")}><Value>{fmtBytes(storage.quotaBytes)}</Value></Row>
          )}
        </Group>
      )}

      {own?.resources && (
        <Group title={t("Resources")} hint={t("The limits of your container. An admin can change them under Settings → Admin.")}>
          <Row title={t("RAM limit")}><Value>{own.resources.ramGiB} GiB</Value></Row>
          {own.consumption?.ramBytes != null && (
            <div className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1"><ProgressBar percent={(own.consumption.ramBytes / (own.resources.ramGiB * GIB)) * 100} /></span>
              <span className="shrink-0 text-[12px] text-dim">
                {t("{v} in use", { v: `${(own.consumption.ramBytes / GIB).toLocaleString(dateLocale(), { maximumFractionDigits: 1 })} GiB` })}
              </span>
            </div>
          )}
          <Row title={t("CPU priority")}><Value>{t(PRIORITY_WORD[own.resources.cpuPrio])}</Value></Row>
          <Row title={t("CPU limit")}>
            <Value>{own.resources.cpuMax === null ? t("none") : t("{n} threads", { n: own.resources.cpuMax })}</Value>
          </Row>
        </Group>
      )}

      {env && (
        <Group>
          <Row
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${env.state === "running" ? "bg-ok" : "bg-dim/40"}`} aria-hidden />
                <span className="truncate">{env.state === "running" ? t("Environment running") : t("Environment stopped")}</span>
              </span>
            }
          >
            {env.state === "running" && env.startedAt && (
              <span className="text-[12px] text-dim">
                {t("since {time}", { time: new Date(env.startedAt).toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) })}
              </span>
            )}
          </Row>
        </Group>
      )}
    </div>
  );
}
