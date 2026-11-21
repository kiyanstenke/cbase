"use client";

// The fields of a git access (host, username, token) — ONE form for the git bar's access modal (`GitSidebar.tsx`
// `GitAuthModal`), the clone in the create dialog and "Create access" on a failed clone row. The caller saves (`save`): it knows
// the route (`PUT …/git/creds` of the workspace or of the view) and what happens next (repeat the action, "Try again").
// The token leaves the field only through `save` — never into a URL, never into a log.
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { field, ghostSm, pillSm } from "@/components/CbKit";

export interface GitAccess { host: string; username: string; secret: string }

export function GitAccessForm({
  host: hostDefault, hostFixed, save, abort, button: buttonEl, buttonBusy, hint, autoFocus = true,
}: {
  /** Preset host; with `hostFixed` not editable (clone, error row: the host is fixed). */
  host?: string;
  hostFixed?: boolean;
  /** Throws on an error — the message then shows in the form. */
  save: (z: GitAccess) => Promise<void>;
  abort?: () => void;
  button: string;
  buttonBusy: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  const t = useT();
  const [host, setHost] = useState(hostDefault ?? "");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fieldName = `${field} mt-1 w-full`;
  const ready = !busy && Boolean(host.trim()) && Boolean(username.trim()) && Boolean(secret);

  async function run() {
    if (!ready) return;
    setBusy(true);
    setErr("");
    try {
      await save({ host: host.trim().toLowerCase(), username: username.trim(), secret });
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-git-access-form>
      <p className="mt-1.5 text-[12px] leading-relaxed text-dim">
        {hint ?? t("Stored for this workspace and used for all Git actions. A personal access token works best as the password.")}
      </p>
      {hostFixed ? (
        <div className="mt-3 text-[12px] text-dim">Host <span className="font-medium text-fg">{host}</span></div>
      ) : (
        <label className="mt-3 block text-[12px] font-medium text-dim">Host
          <input className={fieldName} value={host} onChange={(e) => setHost(e.target.value)} placeholder="gitlab.com" spellCheck={false} />
        </label>
      )}
      <label className="mt-3 block text-[12px] font-medium text-dim">{t("Username")}
        <input className={fieldName} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={autoFocus} spellCheck={false} autoComplete="off" />
      </label>
      <label className="mt-3 block text-[12px] font-medium text-dim">{t("Token / password")}
        <input className={fieldName} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password"
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(); } }} />
      </label>
      {err && <div className="mt-3 max-h-[70px] overflow-y-auto text-[11.5px] text-danger">{err}</div>}
      <div className="mt-4 flex justify-end gap-2">
        {abort && <button type="button" onClick={abort} className={ghostSm}>{t("Cancel")}</button>}
        <button type="button" onClick={() => void run()} disabled={!ready}
                className={`${pillSm} bg-dark text-white hover:opacity-90 disabled:opacity-50`} data-git-access-save>
          {busy ? buttonBusy : buttonEl}
        </button>
      </div>
    </div>
  );
}
