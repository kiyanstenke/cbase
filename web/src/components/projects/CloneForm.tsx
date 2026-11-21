"use client";

// A git repository as the source of project creation: only address, branch and the host's access are entered here; the server
// fetches submodules and LFS in the container.
//
// https only: cbase does not know SSH addresses. Access applies per host for the workspace (`GET/PUT …/git/creds`, the same
// store as the git bar); public repositories need none. The field check is `lib/project-clone.ts` — the server checks the
// same again (400 before any creation).
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { type CloneDetail, type CloneError, checkClone } from "@/lib/project-clone";
import { Overline, field, ghostSm, pillSm } from "@/components/CbKit";
import { GitAccessForm } from "@/components/projects/GitAccessForm";

export const CLONE_ERROR_TEXT: Record<CloneError, string> = {
  EMPTY: "Please enter the repository's https address.",
  ONLY_HTTPS: "https addresses only. cbase does not handle SSH addresses — please use the https address.",
  WITH_USER: "The address contains a user or a password — please enter it without either. cbase then keeps the access here per host.",
  WITH_QUERY: "The address contains a query (“?…”) — please remove it.",
  WITH_FRAGMENT: "The address contains a “#” — please remove it.",
  CHARACTER: "The address contains characters that are not allowed in a URL (for example spaces).",
  HOST_UNCLEAR: "The host of the address is ambiguous (only letters, digits, “.” and “-”, plus a port up to 65535) — please check the address.",
  BRANCH: "The branch name is invalid (letters, digits, “.”, “_”, “/” and “-”, not starting with “-”).",
  INVALID: "This is not a valid repository address.",
};

/** The stored accesses of a workspace (host and user only — the token never leaves the server). `list`: `null` = loading,
 *  `"error"` = not loadable (empty is not unknown: a network error would otherwise read as "no access", and a newly created one
 *  would silently replace the existing one), otherwise the list. */
export function useGitAccesses(workspaceId: string) {
  const [list, setList] = useState<{ host: string; username: string }[] | "error" | null>(null);
  const load = async () => {
    try {
      const r = await api<{ creds: { host: string; username: string }[] }>(`/api/workspaces/${workspaceId}/git/creds`);
      setList(Array.isArray(r?.creds) ? r.creds : "error");
    } catch { setList("error"); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId]);
  const save = async (z: { host: string; username: string; secret: string }) => {
    await api(`/api/workspaces/${workspaceId}/git/creds`, { method: "PUT", body: JSON.stringify(z) });
    await load();
  };
  return { list, save, load };
}

export function CloneForm({ workspaceId, onAdd, onAbort }: {
  workspaceId: string;
  onAdd: (a: CloneDetail) => void;
  onAbort: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [accessOpen, setAccessOpen] = useState(false);
  const accesses = useGitAccesses(workspaceId);
  const check = useMemo(() => checkClone(url, branch), [url, branch]);
  const host = check.ok ? check.detail.host : "";
  const loaded = Array.isArray(accesses.list) ? accesses.list : null;
  const access = host && loaded ? loaded.find((z) => z.host === host) : undefined;
  // The error shows only once something is entered — an empty field is not an error, just not done yet.
  const error = !check.ok && (url.trim() || check.code === "BRANCH") ? t(CLONE_ERROR_TEXT[check.code]) : null;
  // An open access form would lose its input on adding: save or close it first.
  const addReady = check.ok && !accessOpen;
  const add = () => { if (addReady && check.ok) onAdd(check.detail); };

  return (
    <div className="cb-kit-pane rounded-2xl px-3 py-3" data-project-clone>
      <Overline>{t("Git repository")}</Overline>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://gitlab.com/group/repo.git"
        className={`${field} w-full`}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        inputMode="url"
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        data-project-clone-url
      />
      <input
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        placeholder={t("Branch (empty = repository default)")}
        className={`${field} mt-2 w-full`}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        data-project-clone-branch
      />
      {error && <div className="mt-2 text-[11.5px] leading-relaxed text-danger">{error}</div>}
      {host && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-dim" data-project-clone-host>
          {accesses.list === null ? (
            <span>{t("Checking access for {host}…", { host })}</span>
          ) : accesses.list === "error" ? (
            <span className="text-danger">{t("The stored access entries could not be loaded.")}</span>
          ) : access ? (
            <span>{t("Access for {host}: {user}", { host, user: access.username })}</span>
          ) : (
            <span>{t("No access stored for {host} — a public repository needs none.", { host })}</span>
          )}
          {accesses.list === "error" && (
            <button type="button" onClick={() => void accesses.load()} className={ghostSm} data-project-clone-new-load>
              {t("Reload")}
            </button>
          )}
          {loaded && !accessOpen && (
            <button type="button" onClick={() => setAccessOpen(true)} className={ghostSm} data-project-clone-access>
              {access ? t("Change access") : t("Add access")}
            </button>
          )}
        </div>
      )}
      {host && accessOpen && (
        <div className="mt-2 rounded-xl bg-bg px-3 py-2.5">
          <GitAccessForm
            key={host}
            host={host}
            hostFixed
            save={async (z) => { await accesses.save(z); setAccessOpen(false); }}
            abort={() => setAccessOpen(false)}
            button={t("Save access")}
            buttonBusy={t("Saving…")}
            hint={t("Applies to the whole workspace and all Git actions on {host}. A personal access token with read permission works as the password.", { host })}
          />
        </div>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-dim">
        {t("Cloning happens in the project's container, including submodules and LFS files — this tab does not need to stay open.")}
      </p>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        {check.ok && accessOpen && <span className="mr-auto text-[11px] text-dim">{t("Save or close the access first.")}</span>}
        <button type="button" onClick={onAbort} className={ghostSm}>{t("Cancel")}</button>
        <button type="button" onClick={add} disabled={!addReady}
                className={`${pillSm} bg-dark text-white hover:opacity-90 disabled:opacity-40`} data-project-clone-add>
          {t("Add")}
        </button>
      </div>
    </div>
  );
}
