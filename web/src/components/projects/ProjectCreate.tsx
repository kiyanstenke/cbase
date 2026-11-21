"use client";

// Create a new project: name (empty) and sources (folders, files, ZIP, a git repository — `CloneForm.tsx`) on the left, the layout
// in creation mode on the right. "Create" is disabled while the layout shows an error. The project then goes into the list at once;
// `ProjectsPane` runs the upload (it survives closing this dialog, but not closing the tab — "Resume upload").
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Project } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { type Rules, type Step, treeFromSelection, computePlan } from "@/lib/project-layout";
import {
  type Abort, type SelectedSource, type SourceUpload, UploadAborted, ZipDenied,
  creationBody, fromFileList, cloneSource, readDirectory, readZip, rememberMapping, directoryChoicePossible, selectDirectory,
} from "@/lib/project-upload";
import { ZipError } from "@/lib/zip-directory";
import { Hint, Menu, MenuEntry, Modal, ModalTitle, Overline, field, ghost, ghostSm, primary } from "@/components/CbKit";
import { ProjectLayout, sizeText, noticeText } from "@/components/projects/ProjectLayout";
import { CloneForm } from "@/components/projects/CloneForm";

/** The keys of the `.git` files for `treeFromSelection`: `<seq>:<origin>`. */
export function gitFilesOf(sources: { seq: number; q: SelectedSource }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { seq, q } of sources) {
    for (const [rel, content] of Object.entries(q.gitContents)) {
      const origin = q.kind !== "files" ? `${q.name.normalize("NFC")}/${rel.normalize("NFC")}` : rel.normalize("NFC");
      out[`${seq}:${origin}`] = content;
    }
  }
  return out;
}

/** For the layout a ZIP is a folder (`readZip`): the same computation, the same default. */
export const selectionOf = (sources: { seq: number; q: SelectedSource }[]) =>
  sources.map(({ seq, q }) => ({ seq, kind: q.kind === "files" ? "files" as const : q.kind === "clone" ? "clone" as const : "folder" as const, name: q.name, files: q.entries }));

/** The error when reading a ZIP, in words. */
export function zipErrorText(e: unknown, t: (s: string, v?: Record<string, string | number>) => string): string | null {
  if (e instanceof ZipDenied) {
    const names = e.names.slice(0, 3).join(", ");
    if (e.reason === "encrypted") return t("The archive contains encrypted entries and is not accepted: {names}", { names: names });
    if (e.reason === "encoding") return t("The archive contains names that cannot be read and is not accepted: {names}", { names: names });
    return t("The archive contains unsafe paths and is not accepted: {names}", { names: names });
  }
  if (e instanceof ZipError) {
    if (e.code === "MULTIPART") return t("Multi-part archives are not supported.");
    if (e.code === "NO_ZIP") return t("This is not a ZIP file.");
    return t("The ZIP archive is damaged.");
  }
  return null;
}

/** Choose and read folders or files — ONE path for creation and "Resume upload". */
export function useSourceChoice(rules: Rules | null) {
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const wait = useRef<((q: SelectedSource | null) => void) | null>(null);
  const abort = useRef<Abort>({ aborted: false });
  const [read, setRead] = useState<number | null>(null);

  const select = async (kind: "folder" | "files" | "zip"): Promise<SelectedSource | null> => {
    if (!rules) return null;
    if (kind === "folder" && directoryChoicePossible()) {
      const h = await selectDirectory();
      if (!h) return null;
      abort.current = { aborted: false };
      setRead(0);
      try { return await readDirectory(h, rules, { onCount: setRead, abort: abort.current }); }
      catch (e) { if (e instanceof UploadAborted) return null; throw e; }
      finally { setRead(null); }
    }
    return new Promise((finished) => {
      wait.current = finished;
      (kind === "folder" ? folderInput : kind === "zip" ? zipInput : fileInput).current?.click();
    });
  };
  const take = async (list: FileList | null, kind: "folder" | "files" | "zip") => {
    const w = wait.current;
    wait.current = null;
    if (!w) return;
    if (!list?.length) { w(null); return; }
    // An error (not a ZIP, rejected) goes to whoever waits — as a rejection, so the caller shows it.
    setRead(kind === "zip" ? 0 : list.length);
    try { w(kind === "zip" ? await readZip(list[0]) : await fromFileList(list, kind)); }
    catch (e) { errorFor.current?.(e); }
    finally { setRead(null); }
  };
  const errorFor = useRef<((e: unknown) => void) | null>(null);
  // Rendered and invisible instead of display:none — otherwise the programmatic click opens no file dialog.
  const inputs = (
    <>
      <input
        ref={folderInput}
        type="file"
        multiple
        className="pointer-events-none absolute h-px w-px opacity-0"
        onChange={(e) => { void take(e.target.files, "folder"); e.target.value = ""; }}
        {...({ webkitdirectory: "" } as Record<string, string>)}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        className="pointer-events-none absolute h-px w-px opacity-0"
        onChange={(e) => { void take(e.target.files, "files"); e.target.value = ""; }}
      />
      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="pointer-events-none absolute h-px w-px opacity-0"
        onChange={(e) => { void take(e.target.files, "zip"); e.target.value = ""; }}
      />
    </>
  );
  /** Like the plain choose, but a read error (ZIP) throws instead of silently returning `null`. */
  const selectOrThrow = (kind: "folder" | "files" | "zip") => new Promise<SelectedSource | null>((ok, no) => {
    errorFor.current = (e) => { errorFor.current = null; no(e); };
    select(kind).then((q) => { errorFor.current = null; ok(q); }, (e) => { errorFor.current = null; no(e); });
  });
  return { select: selectOrThrow, inputs, read, abort: () => { abort.current.aborted = true; } };
}

export function ProjectCreate({
  workspaceId, rules, start, onClose, onCreated,
}: {
  workspaceId: string;
  rules: Rules;
  /** From the menu "Upload folder" / "Upload ZIP": the choice opens at once; "Clone git repository": the form. */
  start: "empty" | "folder" | "zip" | "clone";
  onClose: () => void;
  onCreated: (p: Project, uploads: SourceUpload[]) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [sources, setSources] = useState<{ seq: number; q: SelectedSource }[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = useRef(1);
  const choice = useSourceChoice(rules);
  const started = useRef(false);
  const [cloneOpen, setCloneOpen] = useState(start === "clone");

  const addAdd = async (kind: "folder" | "files" | "zip") => {
    setError(null);
    try {
      const q = await choice.select(kind);
      if (q) setSources((l) => [...l, { seq: next.current++, q }]);
    } catch (e) {
      setError(zipErrorText(e, t) ?? t("Error: {msg}", { msg: String((e as Error).message || e) }));
    }
  };
  // From the menu "Upload folder"/"Upload ZIP": once, still inside the user gesture of the menu click (the browser's dialog
  // requires it).
  useEffect(() => {
    if (start === "empty" || start === "clone" || started.current) return;
    started.current = true;
    void addAdd(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  const output = useMemo(() => treeFromSelection(selectionOf(sources), rules, gitFilesOf(sources)), [sources, rules]);
  const plan = useMemo(() => computePlan(output.node, steps, rules, "creation"), [output, steps, rules]);
  // An open clone form blocks too: what is in it would otherwise silently be left out.
  const locked = !name.trim() || plan.error.length > 0 || busy || choice.read !== null || cloneOpen;
  const withUpload = sources.some(({ q }) => q.kind !== "clone");

  const remove = (seq: number) => {
    setSources((l) => l.filter((x) => x.seq !== seq));
    // Changes refer to paths — without the source they would no longer fit.
    setSteps([]);
  };

  async function create() {
    if (locked) return;
    setBusy(true);
    setError(null);
    try {
      const { body, uploads } = creationBody(name, sources, output, plan);
      const proj = await api<Project>(`/api/workspaces/${workspaceId}/projects`, { method: "POST", body: JSON.stringify(body) });
      for (const u of uploads) {
        const q = sources.find((x) => x.seq === u.source);
        // ZIP: name, size and modification time are remembered (resuming checks that the same archive is chosen); the server
        // knows the mapping.
        rememberMapping(proj.id, u.seq, q?.q.zip
          ? { kind: "zip", name: q.q.zip.file.name, mapping: [], size: q.q.zip.file.size, changed: q.q.zip.file.lastModified }
          : { kind: q && q.q.kind !== "clone" ? q.q.kind : u.kind, name: q?.q.name ?? "", mapping: plan.mapping[String(u.source)] ?? [] });
      }
      onCreated(proj, uploads);
      onClose();
    } catch (e) {
      setError(String((e as Error).message || e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={980} label={t("New project")}>
      <ModalTitle hint={t("The project gets its own container right away. Folders, files, archives and repositories end up exactly as the outline on the right shows.")}>
        {t("New project")}
      </ModalTitle>
      {choice.inputs}
      <div className="flex flex-wrap gap-5">
        <div className="flex min-w-[260px] flex-1 basis-[300px] flex-col gap-3.5">
          <label className="block">
            <Overline>Name</Overline>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Project name")}
              className={`${field} w-full`}
              autoFocus={start === "empty"}
              onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
              data-project-create-name
            />
          </label>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Overline>{t("Sources")}</Overline>
              <Menu
                label={t("Add source")}
                width={200}
                button={{ content: t("+ Source"), className: ghostSm, data: { "data-project-source-new": "1" } }}
              >
                <MenuEntry label={t("Folder…")} onClick={() => void addAdd("folder")} />
                <MenuEntry label={t("Files…")} onClick={() => void addAdd("files")} />
                <MenuEntry label={t("ZIP archive…")} onClick={() => void addAdd("zip")} />
                <MenuEntry label={t("Git repository…")} disabled={cloneOpen} onClick={() => setCloneOpen(true)} data={{ "data-project-source-clone": "1" }} />
              </Menu>
            </div>
            {sources.length === 0 && cloneOpen ? null : sources.length === 0 ? (
              <div className="rounded-xl bg-bg px-3 py-2.5 text-[12px] text-dim">
                {choice.read !== null ? (choice.read === 0 ? t("Reading…") : t("Reading… {n} files", { n: choice.read })) : t("No source — the project starts empty.")}
              </div>
            ) : (
              <div className="cb-kit-pane divide-y divide-edge rounded-2xl">
                {sources.map(({ seq, q }) => {
                  const up = output.upload[String(seq)] ?? [];
                  const bytes = up.reduce((s, d) => s + d.size, 0);
                  if (q.clone) {
                    return (
                      <div key={seq} className="flex items-center gap-2 px-3 py-2" data-project-source-kind="clone">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[12.5px] font-medium">{q.name}</span>
                            <span className="shrink-0 rounded-md bg-hover px-1.5 py-px text-[10px] font-medium text-dim">Git</span>
                          </div>
                          <div className="truncate text-[11px] text-dim" title={q.clone.url}>
                            {q.clone.url}{q.clone.branch && ` · ${t("branch {branch}", { branch: q.clone.branch })}`}
                          </div>
                        </div>
                        <button type="button" onClick={() => remove(seq)} className={ghostSm}>{t("Remove")}</button>
                      </div>
                    );
                  }
                  return (
                    <div key={seq} className="flex items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[12.5px] font-medium">{q.zip ? q.zip.file.name : q.kind === "folder" ? q.name : t("Files")}</span>
                          {q.zip && <span className="shrink-0 rounded-md bg-hover px-1.5 py-px text-[10px] font-medium text-dim">ZIP</span>}
                        </div>
                        <div className="text-[11px] text-dim">
                          {t("{n} files · {size}", { n: up.length, size: sizeText(bytes) })}
                          {q.zip && ` · ${t("archive {size}", { size: sizeText(q.zip.file.size) })}`}
                          {q.skippedFolder > 0 && ` · ${t("{n} folders skipped", { n: q.skippedFolder })}`}
                        </div>
                      </div>
                      <button type="button" onClick={() => remove(seq)} className={ghostSm}>{t("Remove")}</button>
                    </div>
                  );
                })}
                {choice.read !== null && <div className="px-3 py-2 text-[11.5px] text-dim">{choice.read === 0 ? t("Reading…") : t("Reading… {n} files", { n: choice.read })}</div>}
              </div>
            )}
            {choice.read !== null && (
              <div className="mt-1.5 flex justify-end"><button type="button" onClick={choice.abort} className={ghostSm}>{t("Stop reading##import")}</button></div>
            )}
            {cloneOpen && (
              <div className={sources.length ? "mt-2" : ""}>
                <CloneForm
                  workspaceId={workspaceId}
                  onAbort={() => setCloneOpen(false)}
                  onAdd={(a) => {
                    setSources((l) => [...l, { seq: next.current++, q: cloneSource(a.url, a.branch, a.name) }]);
                    // The project name stays as it is (always typed in by the user).
                    setCloneOpen(false);
                  }}
                />
              </div>
            )}
          </div>
          {(output.omitted > 0 || output.hints.length > 0) && (
            <div className="space-y-1 text-[11.5px] leading-relaxed text-dim">
              {output.omitted > 0 && <div>{t("{n} files are left out (dependencies, build output, .DS_Store).", { n: output.omitted })}</div>}
              {output.hints.slice(0, 5).map((h, i) => <div key={i}>{noticeText(h, t)}</div>)}
            </div>
          )}
          {withUpload && (
            <p className="text-[11.5px] leading-relaxed text-dim">
              {t("After creating, this tab uploads the files — please keep it open until the row shows “ready”. An interrupted upload can be resumed.")}
            </p>
          )}
          {error && <Hint tone="danger">{error}</Hint>}
        </div>
        <div className="flex min-h-[320px] min-w-[300px] flex-[1.4] basis-[420px] flex-col">
          <Overline>{t("Outline")}</Overline>
          <div className="flex max-h-[60vh] min-h-0 flex-1 flex-col">
            <ProjectLayout
              rootName={name.trim()}
              plan={plan}
              steps={steps}
              onSteps={setSteps}
              mode="creation"
              limitRepos={rules.limits.repos}
              sourceMarker={(k) => {
                const q = sources.find((x) => x.seq === k.source)?.q;
                return q?.zip && k.origin === q.name.normalize("NFC") ? "ZIP" : null;
              }}
            />
          </div>
        </div>
      </div>
      <div className="mt-5 flex items-center justify-end gap-2">
        {plan.error.length > 0 && <span className="mr-auto text-[11.5px] text-danger">{t("The outline has errors — fix them first, then create.")}</span>}
        {plan.error.length === 0 && cloneOpen && <span className="mr-auto text-[11.5px] text-dim">{t("Add the repository or close the form first.")}</span>}
        <button type="button" onClick={onClose} className={ghost}>{t("Cancel")}</button>
        <button type="button" onClick={() => void create()} disabled={locked} className={`${primary} disabled:opacity-40`} data-project-create>
          {busy ? t("Creating…") : t("Create")}
        </button>
      </div>
    </Modal>
  );
}
