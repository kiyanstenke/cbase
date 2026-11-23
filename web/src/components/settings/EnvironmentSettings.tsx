"use client";

// Settings → "Environment" (gateway mode only): the own, closed server environment — storage use of the personal volume, available
// space (quota, otherwise free space on the server) and container status. Plus the container's own limits, READ-ONLY: only an
// admin may set them, under Settings → Administration. They come from the same answer `GET /gw/env` (`ENV_ADDITION_FIELDS`), read
// through `normOwnResources`.
//
// Deliberately NO larger storage picture: the bar stays a bar. It comes only from `SettingsKit` instead of its own classes — the
// same number thus carries the same thresholds as the header's usage ring.
//
// At the end the own account can be deleted (App Store guideline 5.1.1(v), the same route as iOS): re-authenticated with the
// password, everything on this server goes, and after the gateway's 202 the page reloads into the login.
import { useCallback, useEffect, useState } from "react";
import { Hint, Modal, ModalTitle, field, ghost, ghostSm, quietDangerSm } from "@/components/CbKit";
import { ProgressBar, Group, Row } from "@/components/settings/SettingsKit";
import { useT, dateLocale } from "@/lib/i18n";
import { accountDeleteErrorText, deleteOwnAccount, normOwnResources, type CpuPrio, type OwnResources } from "@/lib/api";

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
  const [deleting, setDeleting] = useState(false);

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

      <Group title={t("Account")}>
        <Row title={t("Delete account")}>
          <button type="button" className={quietDangerSm} onClick={() => setDeleting(true)} data-account-action="delete">
            {t("Delete account…")}
          </button>
        </Row>
      </Group>
      {deleting && <DeleteAccountSheet onClose={() => setDeleting(false)} />}
    </div>
  );
}

function DeleteAccountSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    if (running || !password) return;
    setRunning(true); setError("");
    // 202: the session is gone — the reload lands in the login (or the setup, if this was the only account).
    try { await deleteOwnAccount(password); window.location.reload(); }
    catch (e) { setError(accountDeleteErrorText(e, t)); setRunning(false); }
  }
  return (
    <Modal onClose={onClose} width={460} label={t("Delete account")} z="z-[70]">
      <ModalTitle hint={t("All your workspaces, chats, projects and provider logins stored on this server are deleted. This cannot be undone.")}>
        {t("Delete your account?")}
      </ModalTitle>
      <label className="block text-[12px] text-dim">
        {t("Password")}
        <input
          className={`${field} mt-1 w-full`}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
          autoComplete="current-password"
          autoFocus
          data-account-action="delete-password"
        />
      </label>
      {error && <div className="mt-3"><Hint tone="danger">{error}</Hint></div>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={ghost} onClick={onClose}>{t("Cancel")}</button>
        <button
          type="button"
          className="rounded-full bg-danger px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          onClick={run}
          disabled={running || !password}
          data-account-action="delete-confirm"
        >
          {running ? t("Deleting…") : t("Delete account")}
        </button>
      </div>
    </Modal>
  );
}
