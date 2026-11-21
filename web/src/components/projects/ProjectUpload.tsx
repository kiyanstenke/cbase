"use client";

// Upload into an existing project, after creation.
//
// `useRetroactive` drives the three paths of the project row (menu: upload files / folder / ZIP), drag & drop onto the row
// (a single `.zip` first asks whether to unpack it), the overwrite / skip / abort question ("N files already exist", with the
// project's running services) and the actions of open-operation rows (resume, discard, abort, overwrite, skip; see
// lib/project-setup.ts retroactiveDisplay). The paths themselves live in lib/project-upload.ts; the server is the boundary
// (409 while a setup is open, for the layout, or when the instance is not ready).
//
// The target is the root: files go to the root, a folder to `<folder name>/`, a ZIP to `<top folder>/` or `<zip name>/`.
// No layout preview. An upload this tab drives shows its progress here; if it aborts or fails, the server's row offers
// "Resume / Discard", and "Resume" takes the selection from memory. If the tab closes the operation stays with the server:
// "Resume" then opens the same dialog as before, and a mixed deposit has to be dropped again.
//
// Questions are queued — the oldest is shown, each has its own answer (a second question must not replace the first, or its
// upload hangs forever). Abort on the row or closing the sheet HALTS the upload (it stays resumable); only "Abort" in the
// sheet discards it.
import { useCallback, useRef, useState } from "react";
import { api, type RetroactiveUpload, type Project } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { Modal, ModalTitle, ghost, ghostSm, primary } from "@/components/CbKit";
import { selectionOf, gitFilesOf, zipErrorText } from "@/components/projects/ProjectCreate";
import { sizeText } from "@/components/projects/ProjectLayout";
import { type Rules, treeFromSelection } from "@/lib/project-layout";
import type { UploadAction } from "@/lib/project-setup";
import {
  type Abort, type Result, type Progress, type RememberedOperation, type SelectedSource, type UploadFile, type ConflictResponse,
  type ConflictQuestion, UploadAborted, sameArchive, fileOf, unpackWithQuestion, finishedWithQuestion, rememberedOperation,
  uploadRetroactive, uploadRetroactiveArchive, readDeposit, readZip, rememberOperation, retroactiveFiles,
  checkArchiveIfComplete, separateInvalid, forgetOperation,
} from "@/lib/project-upload";

type Choice = (kind: "folder" | "files" | "zip") => Promise<SelectedSource | null>;
type ProjectShort = { id: string; name: string };

/** An upload THIS tab drives (one list per project). `operation` is set once `begin` assigned it. An aborted run disappears
 *  (the server's row takes over); a failed one stays with its message until dismissed. */
export interface AfterRun {
  id: number;
  operation?: string;
  title: string;
  state: "read" | "running" | "error";
  read?: number;
  progress?: Progress;
  error?: string;
  abort: Abort;
}

/** What a run uploads — kept in this tab's memory so "Resume" continues here without a new choice (also for a mixed deposit). */
type Source =
  | { kind: "files"; files: UploadFile[]; title: string; choice: RememberedOperation["choice"]; name: string }
  | { kind: "zip"; file: File; title: string };

interface OpenQuestion {
  id: number;
  f: ConflictQuestion;
  project: string;
  title: string;
  /** When resuming a placement: part is already in the project, "Abort" only discards the rest. */
  partial: boolean;
  services: string[] | null;
  respond: (a: ConflictResponse) => void;
  halt: () => void;
  abort?: Abort;
}
interface ZipQuestion { name: string; respond: (a: "file" | "unpack" | null) => void }

const key = (pid: string, operation: string) => `${pid}\u0000${operation}`;

export function useRetroactive({ rules, select, errorText, onChanged }: {
  rules: Rules | null;
  select: Choice;
  errorText: (e: unknown) => string;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const confirm = useConfirm();
  const [runs, setRuns] = useState<Record<string, AfterRun[]>>({});
  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const [zipQuestion, setZipQuestion] = useState<ZipQuestion | null>(null);
  /** Operations whose upload was aborted or failed in this tab (key `key(pid, operation)`). */
  const [endedSet, setEnded] = useState<ReadonlySet<string>>(new Set());
  /** Project → operation waiting for a new deposit on its row (resuming a mixed deposit after a reload). */
  const [depositWaiting, setDepositWaiting] = useState<Record<string, string>>({});
  const sources = useRef(new Map<string, Source>());
  const counter = useRef(0);
  const questionsCounter = useRef(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const markEnded = (pid: string, operation: string, on: boolean) => setEnded((m) => {
    const k = key(pid, operation);
    if (m.has(k) === on) return m;
    const n = new Set(m);
    if (on) n.add(k); else n.delete(k);
    return n;
  });

  // The question is a queue; the oldest is shown. If the project has running services the sheet names them (they see old and
  // new files side by side during placement); the list arrives after opening, a failure drops the sentence. A question whose
  // upload is aborted ends with `UploadAborted` — halted, not discarded.
  const questionFor = useCallback((p: ProjectShort, title: string, o: { abort?: Abort; partial?: boolean } = {}) =>
    (f: ConflictQuestion) => new Promise<ConflictResponse>((finished, no) => {
      if (o.abort?.aborted) { no(new UploadAborted()); return; }
      const id = ++questionsCounter.current;
      const drop = () => setQuestions((l) => l.filter((x) => x.id !== id));
      const respond = (a: ConflictResponse) => { drop(); finished(a); };
      const halt = () => { drop(); no(new UploadAborted()); };
      setQuestions((l) => [...l, { id, f, project: p.name, title, partial: Boolean(o.partial), services: null, respond, halt, abort: o.abort }]);
      api<{ services: { name: string; status?: { running?: boolean } }[] }>(`/api/projects/${p.id}/services`)
        .then((d) => (d.services ?? []).filter((s) => s.status?.running).map((s) => s.name))
        .catch(() => [] as string[])
        .then((services) => setQuestions((l) => l.map((x) => (x.id === id ? { ...x, services } : x))));
    }), []);

  /** Halt a run: set its abort flag and end an open question of this run. */
  const bringToHalt = (abort: Abort) => {
    abort.aborted = true;
    for (const x of questionsRef.current) if (x.abort === abort) x.halt();
  };

  const set = (pid: string, id: number, patch: Partial<AfterRun>) => setRuns((l) => {
    const x = l[pid];
    return x ? { ...l, [pid]: x.map((q) => (q.id === id ? { ...q, ...patch } : q)) } : l;
  });
  const remove = useCallback((pid: string, id: number) => setRuns((l) => {
    const x = (l[pid] ?? []).filter((q) => q.id !== id);
    const n = { ...l };
    if (x.length) n[pid] = x; else delete n[pid];
    return n;
  }), []);

  type Run = (c: {
    abort: Abort; question: (f: ConflictQuestion) => Promise<ConflictResponse>; onOperation: (v: string) => void;
    onProgress: (f: Progress) => void; read: (n: number) => void; running: () => void;
  }) => Promise<Result | null>;

  /**
   * Drive an upload: `run` gets abort, question and callbacks. "placed"/"dismissed" clear the row; an abort clears it too
   * (the server's row then shows the operation as interrupted); an error stays with its message.
   */
  async function run(p: ProjectShort, title: string, job: Run, o: { operation?: string; read?: boolean; source?: Source } = {}) {
    const pid = p.id;
    const id = ++counter.current;
    const abort: Abort = { aborted: false };
    let operation = o.operation;
    const rememberSource = (v: string) => { if (o.source) sources.current.set(key(pid, v), o.source); };
    if (operation) { markEnded(pid, operation, false); rememberSource(operation); }
    setRuns((l) => ({ ...l, [pid]: [...(l[pid] ?? []), { id, title, state: o.read ? "read" : "running", abort, ...(operation ? { operation } : {}) }] }));
    try {
      const r = await job({
        abort,
        question: questionFor(p, title, { abort }),
        onOperation: (v) => { operation = v; rememberSource(v); set(pid, id, { operation: v }); },
        onProgress: (f) => set(pid, id, { progress: f }),
        read: (n) => set(pid, id, { read: n }),
        running: () => set(pid, id, { state: "running" }),
      });
      remove(pid, id);
      if (r && operation) { forgetOperation(pid, operation); sources.current.delete(key(pid, operation)); }
    } catch (e) {
      if (operation) markEnded(pid, operation, true);
      if (e instanceof UploadAborted) remove(pid, id);
      else set(pid, id, { state: "error", error: errorText(e) });
    }
    await changed.current().catch(() => {});
  }

  /**
   * Target paths of a selection: origin per the layout calculation (skip list, dead `.git` files). Targets the server would
   * not accept (control characters etc.) are left out, after a question that names them; `null` means "do not upload".
   */
  async function filesFrom(chosen: SelectedSource): Promise<UploadFile[] | null> {
    if (!rules) return [];
    const out = treeFromSelection(selectionOf([{ seq: 1, q: chosen }]), rules, gitFilesOf([{ seq: 1, q: chosen }]));
    const { files, invalid } = separateInvalid(retroactiveFiles(chosen, out.upload["1"] ?? []), rules);
    if (invalid.length) {
      const names = invalid.slice(0, 5).map((z) => JSON.stringify(z)).join(", ");
      const ok = await confirm(
        t("{n} files have names the project does not accept (control characters or similar, often invisible system files such as “Icon” of a folder with a custom icon): {names}. Upload without them?", { n: invalid.length, names: names }),
        { ok: t("Upload without them") },
      );
      if (!ok) return null;
    }
    return files;
  }
  const titleOf = (chosen: SelectedSource, n: number) =>
    chosen.kind === "folder" ? t("Folder “{name}”", { name: chosen.name }) : n === 1 ? t("1 file") : t("{n} files", { n });

  /** Upload computed files (new, or into operation `operation`). */
  function loadFilesUp(p: ProjectShort, files: UploadFile[], title: string, choice: RememberedOperation["choice"], name: string, operation?: string) {
    void run(p, title, (c) => uploadRetroactive({
      projectId: p.id, files, operation, question: c.question, abort: c.abort, onProgress: c.onProgress,
      onOperation: (v) => { c.onOperation(v); rememberOperation(p.id, v, { choice, name }); },
    }), { operation, source: { kind: "files", files, title, choice, name } });
  }

  async function loadFiles(p: ProjectShort, chosen: SelectedSource, choice: "folder" | "files", operation?: string) {
    const files = await filesFrom(chosen);
    if (!files) return;
    if (!files.length) { alert(t("Nothing in this selection would be uploaded.")); return; }
    loadFilesUp(p, files, titleOf(chosen, files.length), choice, chosen.name, operation);
  }

  function loadArchive(p: ProjectShort, file: File, operation?: string) {
    const title = t("ZIP “{name}”", { name: file.name });
    void run(p, title, (c) => uploadRetroactiveArchive({
      projectId: p.id, archive: file, operation, question: c.question, abort: c.abort, onProgress: c.onProgress,
      onOperation: (v) => { c.onOperation(v); rememberOperation(p.id, v, { choice: "zip", name: file.name, size: file.size, changed: file.lastModified }); },
    }), { operation, source: { kind: "zip", file, title } });
  }

  async function selectOrReport(kind: "folder" | "files" | "zip"): Promise<SelectedSource | null> {
    try { return await select(kind); } catch (e) { alert(zipErrorText(e, t) ?? String((e as Error).message || e)); return null; }
  }

  /** Menu: upload files / folder / ZIP. */
  async function start(p: Project, kind: "files" | "folder" | "zip") {
    const chosen = await selectOrReport(kind);
    if (!chosen || chosen.kind === "clone") return;
    if (chosen.zip) { loadArchive(p, chosen.zip.file); return; }
    await loadFiles(p, chosen, chosen.kind === "folder" ? "folder" : "files");
  }

  /**
   * Drag & drop onto the project row. The caller reads the entries SYNCHRONOUSLY in `drop` (lib/project-upload.ts
   * readDeposit). If an operation on this row waits for its deposit (resuming after a reload), the deposit goes into it.
   */
  async function deposit(p: Project, entries: FileSystemEntry[]) {
    if (!entries.length || !rules) return;
    const resumeIn = depositWaiting[p.id];
    if (!resumeIn && entries.length === 1 && entries[0].isFile && /\.zip$/i.test(entries[0].name)) {
      // A dropped ZIP is either a file of the project or an archive to unpack — only the person knows.
      const a = await new Promise<"file" | "unpack" | null>((finished) => setZipQuestion({ name: entries[0].name, respond: (x) => { setZipQuestion(null); finished(x); } }));
      if (!a) return;
      if (a === "unpack") {
        let file: File;
        try { file = await fileOf(entries[0] as FileSystemFileEntry); await readZip(file); }
        catch (e) { alert(zipErrorText(e, t) ?? String((e as Error).message || e)); return; }
        loadArchive(p, file);
        return;
      }
    }
    if (resumeIn) setDepositWaiting((w) => { const n = { ...w }; delete n[p.id]; return n; });
    // A single folder is remembered like the menu's "upload folder"; anything else as a deposit (resumed only via a new deposit).
    const choice = entries.length === 1 && entries[0].isDirectory ? "folder" : entries.length === 1 ? "files" : "deposit";
    const name = choice === "folder" ? entries[0].name : "";
    const title = choice === "folder" ? t("Folder “{name}”", { name }) : t("Dropped files");
    void run(p, title, async (c) => {
      const chosen = await readDeposit(entries, rules, { onCount: c.read, abort: c.abort });
      const files = await filesFrom(chosen);
      if (!files) throw new UploadAborted();
      if (!files.length) throw new Error(t("Nothing in this selection would be uploaded."));
      const source: Source = { kind: "files", files, title, choice, name };
      if (resumeIn) sources.current.set(key(p.id, resumeIn), source);
      c.running();
      return uploadRetroactive({
        projectId: p.id, files, operation: resumeIn, question: c.question, abort: c.abort, onProgress: c.onProgress,
        onOperation: (v) => { c.onOperation(v); rememberOperation(p.id, v, { choice, name }); sources.current.set(key(p.id, v), source); },
      });
    }, { read: true, ...(resumeIn ? { operation: resumeIn } : {}) });
  }

  const titleFrom = (u: RetroactiveUpload, g: RememberedOperation | null) =>
    g?.choice === "zip" || u.kind === "archive" ? t("ZIP “{name}”", { name: g?.name || "" }) : g?.choice === "folder" && g.name ? t("Folder “{name}”", { name: g.name }) : t("Upload##noun");

  /** "Resume" of an open operation. */
  async function resume(p: Project, u: RetroactiveUpload) {
    const remembered = rememberedOperation(p.id, u.operation);
    if (u.state !== "upload") {
      // Placement or unpacking interrupted or failed: `finished` once more (repeatable; for an archive with its mode). Part is
      // already in the project — "Abort" in the question only discards the rest.
      const questionP6 = questionFor(p, titleFrom(u, remembered), { partial: true });
      if ((await finishedWithQuestion(p.id, u.operation, undefined, questionP6)) === "placed") forgetOperation(p.id, u.operation);
      return;
    }
    // The selection is still in this tab's memory: continue without a new choice (what is already staged is not uploaded again).
    const q = sources.current.get(key(p.id, u.operation));
    if (q?.kind === "files") { loadFilesUp(p, q.files, q.title, q.choice, q.name, u.operation); return; }
    if (q?.kind === "zip") { loadArchive(p, q.file, u.operation); return; }
    if (u.kind === "archive") {
      // If the archive is already complete (the tab closed after the last chunk), continue without a new choice.
      const pr = await checkArchiveIfComplete(p.id, u.operation);
      if (pr) { if ((await unpackWithQuestion(p.id, pr, questionFor(p, titleFrom(u, remembered)))) === "placed") forgetOperation(p.id, u.operation); return; }
      const chosen = await selectOrReport("zip");
      if (!chosen?.zip) return;
      const file = chosen.zip.file;
      const old = remembered?.choice === "zip" ? { name: remembered.name, size: remembered.size, changed: remembered.changed } : null;
      if (!sameArchive(file, { bytes: u.bytes }, old)) {
        // A DIFFERENT archive appended foreign bytes to the started beginning — start over as a new operation.
        const ok = await confirm(t("“{fresh}” cannot be shown to be the archive that is already partly uploaded. Discard the started upload and upload this archive from scratch?", { fresh: file.name }), { ok: t("Upload from scratch") });
        if (!ok) return;
        await api(`/api/projects/${p.id}/upload/${u.operation}`, { method: "DELETE" });
        forgetOperation(p.id, u.operation);
        loadArchive(p, file);
        return;
      }
      loadArchive(p, file, u.operation);
      return;
    }
    if (remembered?.choice === "deposit") {
      // A mixed deposit (several folders, folders and files) is not a file dialog's content — it has to be dropped on the row again.
      setDepositWaiting((w) => ({ ...w, [p.id]: u.operation }));
      return;
    }
    const choice = remembered?.choice === "folder" || remembered?.choice === "files" ? remembered.choice : (u.newFolders?.length ? "folder" : "files");
    const chosen = await selectOrReport(choice);
    if (!chosen || chosen.kind === "clone" || chosen.zip) return;
    if (remembered?.choice === "folder" && remembered.name && chosen.kind === "folder" && chosen.name !== remembered.name) {
      const ok = await confirm(t("“{fresh}” is not the folder “{old}” that is already partly uploaded. Add it to this upload anyway?", { fresh: chosen.name, old: remembered.name }), { ok: t("Resume") });
      if (!ok) return;
    }
    await loadFiles(p, chosen, chosen.kind === "folder" ? "folder" : "files", u.operation);
  }

  /** An action on the row of an open operation. */
  async function action(p: Project, a: UploadAction) {
    const u = p.uploads?.find((x) => x.operation === a.operation);
    if (!u) return;
    try {
      switch (a.kind) {
        case "resume": await resume(p, u); break;
        case "dismiss": {
          // After placement what is already in the project stays — the text says so.
          const text = u.state === "upload"
            ? t("Discard this upload? Whatever of it is already on the server is deleted; nothing in the project changes.")
            : t("Discard this upload? What is still on the server is deleted; what has already been placed into the project stays there.");
          if (!(await confirm(text, { ok: t("Dismiss"), danger: true }))) return;
          await api(`/api/projects/${p.id}/upload/${u.operation}`, { method: "DELETE" });
          forgetOperation(p.id, u.operation);
          sources.current.delete(key(p.id, u.operation));
          markEnded(p.id, u.operation, false);
          break;
        }
        case "abort": await api(`/api/projects/${p.id}/upload/${u.operation}/abort`, { method: "POST" }); break;
        case "overwrite":
        case "skip":
          await api(`/api/projects/${p.id}/upload/${u.operation}/finished`, { method: "POST", body: JSON.stringify({ conflict: a.kind }) });
          forgetOperation(p.id, u.operation);
          break;
      }
    } catch (e) {
      if (!(e instanceof UploadAborted)) alert(t("Error: {msg}", { msg: errorText(e) }));
    }
    await changed.current().catch(() => {});
  }

  /** The operations this tab is currently uploading for a project — their server row is hidden (running ones only). */
  const own = (pid: string) => new Set((runs[pid] ?? [])
    .filter((l) => l.state === "read" || l.state === "running").map((l) => l.operation).filter((v): v is string => Boolean(v)));
  /** Operations whose upload was aborted or failed in this tab — they count as interrupted at once. */
  const ended = (pid: string) => {
    const prefix = `${pid}\u0000`;
    return new Set([...endedSet].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  };
  /** Is an upload into this project running in this tab? (Deleting stays blocked meanwhile.) */
  const active = (pid: string) => (runs[pid] ?? []).some((l) => l.state === "read" || l.state === "running");
  const abortRun = (l: AfterRun) => bringToHalt(l.abort);
  const abortAll = (pid: string) => { for (const l of runs[pid] ?? []) bringToHalt(l.abort); };
  const forgetDeposit = (pid: string) => setDepositWaiting((w) => { const n = { ...w }; delete n[pid]; return n; });

  const question = questions[0];
  const dialogs = (
    <>
      {question && <ConflictSheet key={question.id} question={question} additional={questions.length - 1} />}
      {zipQuestion && (
        <Modal onClose={() => zipQuestion.respond(null)} width={420} label={t("Drop “{name}”", { name: zipQuestion.name })}>
          <ModalTitle hint={t("As a file, the archive goes unchanged into the project root; when extracted, its content becomes a folder in the project.")}>
            {t("Drop “{name}”", { name: zipQuestion.name })}
          </ModalTitle>
          <div className="text-[13px]">{t("Drop it as a file or extract it?")}</div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className={ghost} onClick={() => zipQuestion.respond(null)}>{t("Cancel")}</button>
            <button type="button" className={ghost} onClick={() => zipQuestion.respond("file")} data-zip-question="file">{t("Drop as file")}</button>
            <button type="button" className={primary} onClick={() => zipQuestion.respond("unpack")} data-zip-question="unpack">{t("Extract")}</button>
          </div>
        </Modal>
      )}
    </>
  );

  return { runs, start, deposit, action, remove, own, ended, active, abortRun, abortAll, depositWaiting, forgetDeposit, dialogs };
}

function ConflictSheet({ question, additional }: { question: OpenQuestion; additional: number }) {
  const t = useT();
  const { f, services, respond, halt } = question;
  return (
    // Closing (Escape, click outside) only HALTS the upload — it stays resumable; it is discarded only via "Abort".
    <Modal onClose={halt} width={460} label={t("{n} files already exist", { n: f.existing })}>
      <ModalTitle hint={question.partial
        ? t("Overwrite replaces them with the uploaded ones, Skip leaves them as they are. Cancel discards the rest of the upload; files already placed stay in the project. Closing only pauses it.")
        : t("Overwrite replaces them with the uploaded ones, Skip leaves them as they are. Cancel discards the upload; closing only pauses it.")}>
        {f.existing === 1 ? t("1 file already exists") : t("{n} files already exist", { n: f.existing })}
      </ModalTitle>
      <div className="mb-2 text-[12px] text-dim" data-conflict-upload>
        {t("{title} in “{project}”", { title: question.title, project: question.project })}
        {additional > 0 && <> · {additional === 1 ? t("1 more question waiting") : t("{n} more questions waiting", { n: additional })}</>}
      </div>
      {f.examples.length > 0 && (
        <ul className="cb-kit-pane divide-y divide-edge overflow-hidden rounded-xl font-mono text-[11.5px]" data-conflict-examples>
          {f.examples.map((b) => <li key={b} className="truncate px-3 py-1.5" title={b}>{b}</li>)}
          {f.existing > f.examples.length && <li className="px-3 py-1.5 text-dim">{t("and {n} more", { n: f.existing - f.examples.length })}</li>}
        </ul>
      )}
      {services && services.length > 0 && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-warn" data-conflict-services>
          {t("Services of this project are running ({names}) — while the files are placed, they see old and new files side by side.", { names: services.join(", ") })}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" className={ghost} onClick={() => respond("abort")} data-conflict="abort">{t("Cancel")}</button>
        <button type="button" className={ghost} onClick={() => respond("skip")} data-conflict="skip">{t("Skip")}</button>
        <button type="button" className={primary} onClick={() => respond("overwrite")} data-conflict="overwrite">{t("Overwrite")}</button>
      </div>
    </Modal>
  );
}

/**
 * The uploads this tab runs into a project — progress, abort (halts; the server's row then offers resume / discard), the
 * message after an error. Plus the hint when an operation waits for a new deposit on the row.
 */
export function RetroactiveRunRows({ runs, depositWaiting, onAbort, onHide, onForgetDeposit }: {
  runs: AfterRun[];
  depositWaiting: boolean;
  onAbort: (l: AfterRun) => void;
  onHide: (l: AfterRun) => void;
  onForgetDeposit: () => void;
}) {
  const t = useT();
  if (!runs.length && !depositWaiting) return null;
  return (
    <div className="mt-1.5 space-y-1.5" onClick={(e) => e.stopPropagation()} data-project-retroactive>
      {depositWaiting && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-warn" data-project-deposit-waiting>
          <span>{t("To resume, drag the same folders and files onto this row again.")}</span>
          <button type="button" onClick={onForgetDeposit} className={ghostSm}>{t("Cancel")}</button>
        </div>
      )}
      {runs.map((l) => {
        const f = l.progress;
        const share = f && f.bytesTotal ? Math.max(2, (f.bytes / f.bytesTotal) * 100) : 2;
        const running = l.state === "read" || l.state === "running";
        return (
          <div key={l.id}>
            <div className="flex items-center justify-between gap-2 text-[11.5px]">
              <span className={`truncate ${l.state === "error" ? "text-danger" : "text-dim"}`}>
                {l.state === "read" ? t("{title}: reading ({n} files)", { title: l.title, n: l.read ?? 0 })
                  : l.state === "error" ? t("{title}: {error}", { title: l.title, error: l.error ?? "" })
                  : t("{title}: uploading", { title: l.title })}
              </span>
              {f && l.state === "running" && (
                <span className="shrink-0 tabular-nums text-dim">
                  {t("{done} / {total} files · {sent} / {size}", { done: f.files, total: f.filesTotal, sent: sizeText(f.bytes), size: sizeText(f.bytesTotal) })}
                </span>
              )}
            </div>
            {running && (
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg">
                <div className={`h-full rounded-full bg-accent transition-all ${l.state === "read" ? "w-full animate-pulse opacity-50" : ""}`} style={l.state === "running" ? { width: `${share}%` } : undefined} />
              </div>
            )}
            <div className="mt-1 flex items-center gap-2">
              {running ? (
                <>
                  <span className="text-[11px] text-dim">{t("Keep this tab open until the upload is done.")}</span>
                  <button type="button" onClick={() => onAbort(l)} className={ghostSm}>{t("Cancel")}</button>
                </>
              ) : (
                <button type="button" onClick={() => onHide(l)} className={ghostSm}>{t("Dismiss##hide")}</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
