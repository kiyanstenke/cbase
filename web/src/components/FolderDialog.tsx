"use client";

// "Folder + name" dialog for a new workspace, and, on the local server (no project container), for a new project.
// Shared by the page and `projects/ProjectsPane.tsx`; an App Router page may only export its config, so it lives here.
import { useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useGateway } from "@/lib/gateway";
import { Modal, ModalTitle, Overline, field, ghost, primary } from "@/components/CbKit";

export function FolderDialog({
  title,
  pickTitle,
  pathPlaceholder,
  submitLabel,
  onCreate,
  onClose,
}: {
  title: string;
  pickTitle: string;
  pathPlaceholder: string;
  submitLabel: string;
  onCreate: (path: string, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  // Gateway mode: only the name is asked for; the server assigns the folder.
  const gw = useGateway();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function pick() {
    setPicking(true);
    try {
      const r = await api<{ path?: string; canceled?: boolean; unavailable?: boolean }>("/api/pick-folder", {
        method: "POST",
        body: JSON.stringify({ title: pickTitle }),
      });
      if (r.path) {
        setPath(r.path);
        if (!name.trim()) setName(r.path.split("/").filter(Boolean).pop() ?? "");
      } else if (r.unavailable) {
        alert(t("The folder dialog is only available in the app — please type the path."));
      }
    } catch (e) {
      alert(t("Error: {msg}", { msg: (e as Error).message }));
    } finally {
      setPicking(false);
    }
  }

  async function submit() {
    if (gw ? !name.trim() : !path.trim()) return;
    setBusy(true);
    try {
      await onCreate(gw ? "" : path.trim(), name.trim());
    } catch (e) {
      alert(t("Error: {msg}", { msg: (e as Error).message }));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={520} label={title}>
      <ModalTitle>{title}</ModalTitle>
      {!gw && (
        <label className="mb-3.5 block">
          <Overline>{t("Folder")}</Overline>
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={pathPlaceholder}
              className={`${field} min-w-0 flex-1 font-mono text-[12px]`}
            />
            <button
              onClick={pick}
              disabled={picking}
              className={`${ghost} shrink-0`}
            >
              {picking ? "…" : t("Choose…")}
            </button>
          </div>
        </label>
      )}
      <label className="mb-4 block">
        <Overline>Name</Overline>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={`${field} w-full`} autoFocus={!!gw}
               onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
      </label>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={ghost}>
          {t("Cancel")}
        </button>
        <button
          onClick={submit}
          disabled={(gw ? !name.trim() : !path.trim()) || busy}
          className={`${primary} disabled:opacity-40`}
        >
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}
