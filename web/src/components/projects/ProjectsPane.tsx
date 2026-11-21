"use client";

// The "Projects" tab of a workspace.
//
// In server mode (`GET /api/projectCreation/rules` → `mode: "container"`) "+ Project" is a menu (empty project · upload folder ·
// upload ZIP · clone Git repository), and each row shows its setup state (lib/project-setup.ts) with the matching actions; a
// clone without credentials also offers "Create access" (`GitAccessForm.tsx`). Without server mode (local) the old
// "folder + name" dialog stays.
//
// THIS component runs the uploads after creation (it survives the dialog closing): source by source, with progress and
// "Abort" on the row. If the tab closes, the source stays "waiting for upload" and the row offers "Resume upload".
//
// Uploading later: menu "Upload files / folder / ZIP" and drag & drop onto the row — only without an open setup and with a
// ready instance (lib/project-setup.ts uploadPossible); `ProjectUpload.tsx` useRetroactive runs the paths, retroactiveDisplay
// computes the rows of open operations (`uploads`).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeGlobalEvents, type Project } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { FolderDialog } from "@/components/FolderDialog";
import { ProjectServicesPane } from "@/components/ProjectServicesPane";
import { OldContainerRemove } from "@/components/projects/OldContainerRemove";
import { EmptySentence, Menu, MenuEntry, Modal, ModalTitle, Point, COLUMN, PagesHeader, RowsArrow, ghostSm, primary } from "@/components/CbKit";
import { ProjectView, type ProjectTab } from "@/components/projects/ProjectView";
import { FACTS, Fact, SELECTED, Tile, LIST_ROW, S, instanceColor, textOf } from "@/components/projects/ProjectForm";
import { InstancesPage } from "@/components/projects/InstancesPage";
import { stateWord } from "@/lib/instance-state";
import { GitAccessForm } from "@/components/projects/GitAccessForm";
import { type Rules, treeFromSelection } from "@/lib/project-layout";
import {
  type Action, type ActionKind, type LayoutActionKind, type UploadActionKind, type Row,
  LAYOUT_STEP_NAMES, STEP_NAMES, setupDisplay, layoutRow, uploadPossible, retroactiveDisplay,
} from "@/lib/project-setup";
import {
  type Abort, type Progress, type SourceUpload, UploadAborted,
  depositEntries, sameArchive, resumptionFiles, rememberedChoice, rememberedArchive, uploadArchive, uploadSource, rememberMapping, forgetMapping,
} from "@/lib/project-upload";
import { RetroactiveRunRows, useRetroactive } from "@/components/projects/ProjectUpload";
import { LayoutPage } from "@/components/projects/LayoutPage";
import { GitView } from "@/components/projects/git/GitView";
import { Timeline } from "@/components/timeline/Timeline";
import { showInCode } from "@/lib/code-show";
import { ProjectCreate, selectionOf, gitFilesOf, useSourceChoice, zipErrorText } from "@/components/projects/ProjectCreate";
import { sizeText } from "@/components/projects/ProjectLayout";

// "Context" is no path of the projects page; it stays reachable via its own tab in an entered project, and a remembered
// "context" opens the services (workspaces/page.tsx).
export type OpenProject = { id: string; name: string; view: ProjectTab };

/** The "at least 1 repo" check for the "Git" tab, from the project list's `repos` field: a number decides (`> 0`) and is
 *  remembered per project; `null` = not read does not show the tab but does not hide one already shown (the last remembered
 *  value stands — empty is not unknown); if the field is missing (old server) the tab counts as present. `remembered` is held
 *  by the page (one ref per mount). */
export function hasGitRepos(p: Project | undefined, remembered: Map<string, boolean>): boolean {
  if (!p) return false;
  if (p.repos === undefined) return true;
  if (typeof p.repos === "number") {
    remembered.set(p.id, p.repos > 0);
    return p.repos > 0;
  }
  return remembered.get(p.id) ?? false;
}
type PortConflicts = Record<string, { items: { port: number; name: string; owner: string }[] }>;

// Once per page: which creation path applies, and its rules — ONE question to `GET /api/projectCreation/rules` (field `mode`).
// In server mode `/api/health` is answered by the GATEWAY itself, without the creation mode, so it always said "folder"; health
// stays only as a fallback for a server without the field. A failure is not remembered (the next call asks again).
let creationQuestion: Promise<{ mode: "container" | "folder"; rules: Rules | null }> | null = null;
function questionCreation() {
  return api<Rules & { mode?: string }>("/api/projectCreation/rules")
    .catch(() => null)
    .then(async (r) => {
      let mode = r?.mode;
      if (mode !== "container" && mode !== "folder") {
        mode = (await api<{ projectCreation?: string }>("/api/health")).projectCreation;
      }
      return { mode: mode === "container" ? "container" as const : "folder" as const, rules: r };
    });
}
function useCreation(): { mode: "container" | "folder" | null; rules: Rules | null } {
  const [mode, setMode] = useState<"container" | "folder" | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  useEffect(() => {
    let alive = true;
    creationQuestion ??= questionCreation().catch((e) => { creationQuestion = null; throw e; });
    creationQuestion.then((a) => {
      if (!alive) return;
      setMode(a.mode);
      if (a.mode === "container" && a.rules) setRules(a.rules);
      // Container path without rules (the answer failed): ask again on the next open.
      if (a.mode === "container" && !a.rules) creationQuestion = null;
    }).catch(console.error);
    return () => { alive = false; };
  }, []);
  return { mode, rules };
}

// One run per (project, source): each source carries the abort of ITS call. A second call in the same project (resuming one
// source while another uploads) replaces only its own entries.
interface SourceRun { seq: number; target: string; state: "waiting" | "running" | "finished" | "error" | "aborted"; progress?: Progress; error?: string; abort: Abort }
interface Run { sources: SourceRun[] }
const abortRun = (run?: Run) => { for (const q of run?.sources ?? []) q.abort.aborted = true; };

const ACTION_TEXT: Record<ActionKind, string> = {
  resume: "Resume upload",
  takeOver: "Take as is",
  leaveOut: "Continue without this source",
  abort: "Cancel",
  again: "Try again",
  overwrite: "Overwrite",
  skip: "Skip",
  "conflict-abort": "Cancel",
  erase: "Delete",
  access: "Add access",
};
const UPLOAD_TEXT: Record<UploadActionKind, string> = {
  resume: "Resume",
  dismiss: "Dismiss",
  abort: "Cancel",
  overwrite: "Overwrite",
  skip: "Skip",
};
const LAYOUT_TEXT: Record<LayoutActionKind, string> = {
  waitlist: "Waiting list",
  revert: "Undo",
  "check-again": "Check again",
  again: "Try again",
};
// State as a dot with a word: the dot carries the colour, the word stays calm — only an error keeps the warning colour in the
// text, it is the one state that must not be overlooked.
const POINT: Record<Row["tone"], string> = { running: "bg-accent", waiting: "bg-warn", error: "bg-danger" };
const WORD: Record<Row["tone"], string> = { running: "text-dim", waiting: "text-fg", error: "text-danger" };
const stateRow = "mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5";

/** The title of a clone row: address and branch (the row itself only names the target). */
function cloneTitle(p: Project, seq: number | undefined): string | undefined {
  const q = seq === undefined ? undefined : p.setup?.sources.find((x) => x.seq === seq);
  if (q?.kind !== "clone" || !q.url) return undefined;
  return q.branch ? `${q.url} (${q.branch})` : q.url;
}

export function ProjectsPane({
  workspaceId, projects, portConflicts, gw, openProject, setOpenProject, onEnter, onCode, onChanged, inProject = false,
}: {
  workspaceId: string;
  projects: Project[];
  portConflicts: PortConflicts;
  gw: boolean;
  openProject: OpenProject | null;
  setOpenProject: (p: OpenProject | null) => void;
  onEnter: (p: { id: string; name: string }) => void;
  /** Enter and show the code tab ("Open in code tab" in the layout). */
  onCode?: (p: { id: string; name: string }) => void;
  onChanged: () => Promise<void>;
  /** The entry inside an ENTERED project (coding tab "project") — the same view for `openProject`, without back link and without
   *  "Enter" (there is no list to go back to). The page then holds `openProject` itself. */
  inProject?: boolean;
}) {
  const t = useT();
  const question = useConfirm();
  const { mode, rules } = useCreation();
  const choice = useSourceChoice(rules);
  const [create, setCreate] = useState<null | "empty" | "folder" | "zip" | "clone">(null);
  // "Create access" on a clone row: the host is fixed; "Try again" after saving.
  const [accessFor, setAccessFor] = useState<{ project: string; host: string } | null>(null);
  const [folderDialog, setFolderDialog] = useState(false);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [now, setNow] = useState(() => Date.now());
  const changed = useRef(onChanged);
  changed.current = onChanged;
  // What `hatGitRepos` last knew per project from a read number (a later `null` does not hide the tab again).
  const gitRemembered = useRef(new Map<string, boolean>());

  // The list follows the setup: every event of a project reloads (batched), and the clock runs while a setup is open — after the
  // upload quiet period without an event "upload running" turns into "waiting for upload".
  useEffect(() => {
    let time: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeGlobalEvents((evt) => {
      if (evt.type !== "project/setup" && evt.type !== "project/instance" && evt.type !== "project/upload" && evt.type !== "project/layout" && evt.type !== "project/superseded") return;
      if (evt.type === "project/layout" && evt.kind === "check") return; // a check changes no row
      if (time) clearTimeout(time);
      time = setTimeout(() => { void changed.current().catch(() => {}); }, 300);
    });
    return () => { off(); if (time) clearTimeout(time); };
  }, []);
  const open = projects.some((p) => p.setup || p.detection?.status === "running" || (p.uploads ?? []).some((u) => u.state === "upload" && !u.interrupted));
  useEffect(() => {
    if (!open) return;
    const i = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(i);
  }, [open]);

  const errorText = useCallback((e: unknown): string => {
    const f = e as Error & { code?: string; free?: number; needed?: number };
    // Without a measurement (df failed, `free`/`needed` null) the server's message says what is going on.
    if (f.code === "SLOT" && typeof f.free === "number" && typeof f.needed === "number") return t("Not enough space on the server: {free} free, {needed} needed.", { free: sizeText(f.free), needed: sizeText(f.needed) });
    if (f.code === "SETUP_ERROR") return t("Setup failed: {reason}", { reason: (f as { reason?: string }).reason ?? "" });
    if (f.code === "UPLOAD_RUNNING") return t("An upload is already running for this source (in another tab?).");
    return String(f.message || e);
  }, [t]);
  const retro = useRetroactive({ rules, select: choice.select, errorText, onChanged });
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const startUploads = useCallback(async (pid: string, uploads: SourceUpload[], resume: boolean) => {
    if (!uploads.length) return;
    const abort: Abort = { aborted: false };
    const nrs = new Set(uploads.map((u) => u.seq));
    setRuns((l) => {
      const old = l[pid]?.sources ?? [];
      for (const q of old) if (nrs.has(q.seq)) q.abort.aborted = true; // an older call for the same source ends
      const fresh: SourceRun[] = uploads.map((u) => ({ seq: u.seq, target: u.target, state: "waiting", abort }));
      return { ...l, [pid]: { sources: [...old.filter((q) => !nrs.has(q.seq)), ...fresh].sort((a, b) => a.seq - b.seq) } };
    });
    const set = (seq: number, patch: Partial<SourceRun>) => setRuns((l) => {
      const x = l[pid];
      return x ? { ...l, [pid]: { sources: x.sources.map((q) => (q.seq === seq && q.abort === abort ? { ...q, ...patch } : q)) } } : l;
    });
    let everythingGood = true;
    for (const u of uploads) {
      if (abort.aborted) { set(u.seq, { state: "aborted" }); everythingGood = false; continue; }
      set(u.seq, { state: "running" });
      try {
        const onProgress = (f: Progress) => set(u.seq, { progress: f });
        if (u.archive) await uploadArchive({ projectId: pid, seq: u.seq, archive: u.archive, resume, fresh: u.fresh, abort, onProgress });
        else await uploadSource({ projectId: pid, seq: u.seq, files: u.files, resume, abort, onProgress });
        set(u.seq, { state: "finished" });
        forgetMapping(pid, u.seq);
      } catch (e) {
        everythingGood = false;
        set(u.seq, e instanceof UploadAborted ? { state: "aborted" } : { state: "error", error: errorText(e) });
      }
    }
    if (everythingGood) setRuns((l) => {
      const x = l[pid];
      if (!x) return l;
      const rest = x.sources.filter((q) => q.abort !== abort);
      const n = { ...l };
      if (rest.length) n[pid] = { sources: rest }; else delete n[pid];
      return n;
    });
    await changed.current().catch(() => {});
  }, [errorText]);

  async function resume(p: Project, seq: number) {
    const q = p.setup?.sources.find((x) => x.seq === seq);
    if (!q || !rules) return;
    let chosen;
    try {
      chosen = await choice.select(rememberedChoice(p.id, seq) ?? (q.kind === "files" ? "files" : q.kind === "zip" ? "zip" : "folder"));
    } catch (e) {
      alert(zipErrorText(e, t) ?? String((e as Error).message || e));
      return;
    }
    if (!chosen || chosen.kind === "clone") return;
    if (chosen.zip) {
      // An archive resumes where the server stands (`begin` names the size) — but only the same one: a DIFFERENT one would append
      // foreign bytes to the old beginning. If sameness cannot be shown, it uploads from the start after a question.
      if (q.kind !== "zip") { alert(t("This source was not a ZIP archive.")); return; }
      const file = chosen.zip.file;
      let fresh = false;
      if (!sameArchive(file, q, rememberedArchive(p.id, seq))) {
        const old = q.name || rememberedArchive(p.id, seq)?.name || "";
        const text = old
          ? t("“{fresh}” cannot be confirmed to be the archive that is already partly uploaded (“{old}”). Upload from the start? What the server already holds will be replaced; the layout stays the one chosen at creation.", { fresh: file.name, old })
          : t("Whether “{fresh}” is the archive that is already partly uploaded cannot be checked. Upload from the start? What the server already holds will be replaced; the layout stays the one chosen at creation.", { fresh: file.name });
        if (!(await question(text, { ok: t("Upload from the start") }))) return;
        fresh = true;
        rememberMapping(p.id, seq, { kind: "zip", name: file.name, mapping: [], size: file.size, changed: file.lastModified });
      }
      void startUploads(p.id, [{ seq, source: 1, kind: "zip", target: q.target, files: [], bytes: file.size, archive: file, fresh }], true);
      return;
    }
    const tree = treeFromSelection(selectionOf([{ seq: 1, q: chosen }]), rules, gitFilesOf([{ seq: 1, q: chosen }]));
    const { files, notCaptured } = resumptionFiles(p.id, q, chosen, tree.upload["1"] ?? []);
    if (!files.length) { alert(t("Nothing in this selection belongs to this source.")); return; }
    if (notCaptured > 0 && !(await question(t("{n} files don't belong to this source and are left out. Resume anyway?", { n: notCaptured }), { ok: t("Resume") }))) return;
    void startUploads(p.id, [{ seq, source: 1, kind: chosen.kind, target: q.target, files, bytes: files.reduce((s, d) => s + d.size, 0) }], true);
  }

  async function deleteProject(pid: string) {
    // Gateway mode: the server created the folder — removing deletes it with its contents.
    // Local: conservative, the folder on the own disk stays.
    const msg = gw ? t("Remove project? The folder and its contents will be permanently deleted.") : t("Remove project? (folder is kept)");
    if (!(await question(msg, { ok: t("Remove"), danger: true }))) return;
    abortRun(runs[pid]);
    retro.abortAll(pid);
    // Every rejection of the server must reach the person (otherwise it left the click as an unhandled exception and the list
    // stood still). If a copy is alive the server starts clearing it away and answers 409 COPY_CLEAR_AWAY: "remove again
    // afterwards" must be shown. The list reloads in any case — it shows the clearing in progress.
    try {
      await api(`/api/workspaces/${workspaceId}/projects/${pid}${gw ? "?purge=1" : ""}`, { method: "DELETE" });
    } catch (e) {
      const f = e as Error & { code?: string; copies?: { name?: string }[] };
      const names = (Array.isArray(f.copies) ? f.copies : []).map((k) => String(k?.name ?? "")).filter(Boolean);
      alert(f.code === "COPY_CLEAR_AWAY" && names.length
        ? (names.length === 1
          ? t("The copy {names} is being removed — remove the project again afterwards.", { names: names[0] })
          : t("The copies {names} are being removed — remove the project again afterwards.", { names: names.join(", ") }))
        : t("Project not removed: {msg}", { msg: f.message || String(e) }));
    } finally {
      await onChanged().catch(() => {});
    }
  }

  async function action(p: Project, a: Action) {
    const path = `/api/projects/${p.id}/setup`;
    try {
      switch (a.kind) {
        case "resume": await resume(p, a.seq as number); return;
        case "erase": await deleteProject(p.id); return;
        case "takeOver": {
          // In `error`/`aborted` (part of the archive unpacked, an abort) the server accepts it only with the explicit
          // `takeOver: true`; in `wait-upload` it does not read the body.
          const source = p.setup?.sources.find((q) => q.seq === a.seq);
          const waiting = source?.state === "wait-upload";
          const text = source?.kind === "clone"
            ? t("Take over the repository without the missing submodules or LFS files?")
            : waiting
            ? t("Take what has been uploaded so far? Whatever is still missing won't be in the project.")
            : t("Take what is already staged? Whatever is missing will not be added to the project.");
          if (!(await question(text, { ok: t("Take as is") }))) return;
          await api(`${path}/sources/${a.seq}/finished`, { method: "POST", body: JSON.stringify({ takeOver: true }) });
          forgetMapping(p.id, a.seq as number);
          break;
        }
        case "access": {
          const host = p.setup?.sources.find((q) => q.seq === a.seq)?.host;
          if (host) setAccessFor({ project: p.id, host });
          return;
        }
        case "leaveOut": {
          const clone = p.setup?.sources.find((q) => q.seq === a.seq)?.kind === "clone";
          const text = clone
            ? t("Continue without this repository? Whatever has already been cloned is discarded.")
            : t("Continue without this source? Whatever was uploaded from it is discarded.");
          if (!(await question(text, { ok: t("Continue without this source"), danger: true }))) return;
          await api(`${path}/sources/${a.seq}/leaveOut`, { method: "POST" });
          forgetMapping(p.id, a.seq as number);
          break;
        }
        case "abort": await api(`${path}/sources/${a.seq}/abort`, { method: "POST" }); break;
        case "again": await api(`${path}/again`, { method: "POST" }); break;
        case "overwrite":
        case "skip":
          await api(`${path}/conflict`, { method: "POST", body: JSON.stringify({ mode: a.kind }) });
          break;
        case "conflict-abort":
          await api(`${path}/conflict`, { method: "POST", body: JSON.stringify({ mode: "abort" }) });
          break;
      }
    } catch (e) {
      alert(t("Error: {msg}", { msg: errorText(e) }));
    }
    await onChanged().catch(() => {});
  }

  async function createFolderProject(path: string, name: string) {
    await api(`/api/workspaces/${workspaceId}/projects`, { method: "POST", body: JSON.stringify({ path, name }) });
    setFolderDialog(false);
    await onChanged();
  }

  async function layoutAction(p: Project, a: LayoutActionKind) {
    const path = `/api/projects/${p.id}/layout/job`;
    try {
      if (a === "waitlist" || a === "check-again") { setOpenProject({ id: p.id, name: p.name, view: "layout" }); return; }
      if (a === "revert") {
        if (!(await question(t("Withdraw the outline? Nothing in the project has changed yet."), { ok: t("Undo") }))) return;
        await api(path, { method: "DELETE" });
      }
      if (a === "again") await api(`${path}/again`, { method: "POST" });
    } catch (e) {
      alert(t("Error: {msg}", { msg: errorText(e) }));
    }
    await onChanged().catch(() => {});
  }

  // The project view: tabs on the left (services, layout, instances, git, timeline), content on the right — all embedded, without
  // their own header. The layout tab is selectable where the entry in the menu was (server mode, project container, no open
  // setup); without server mode it does not exist.
  if (openProject) {
    const op = openProject;
    const live = projects.find((x) => x.id === op.id);
    const name = live?.name ?? op.name;
    const layoutTab = mode === "folder" ? null : {
      reason: mode === null ? t("Loading…")
        : !live?.instance?.converted ? t("The outline needs the project container.")
        : setupDisplay(live.setup, live.detection, now).locked.layout ? t("The project is still being set up — the outline is available afterwards.")
        : null,
    };
    // Leaving the layout reloads the list (a job changes the row).
    const leave = () => { if (op.view === "layout") void onChanged().catch(() => {}); };
    // The "Instances" tab only for a converted project; a remembered tab of a project that (still) has no instance shows the
    // services — it stays chosen until someone switches.
    const instancesTab = Boolean(live?.instance?.converted);
    // The "Git" tab under the same condition plus the "at least 1 repo" check (`hatGitRepos`); a remembered one falls like instances.
    const gitTab = instancesTab && hasGitRepos(live, gitRemembered.current);
    const view: ProjectTab = (op.view === "instances" && !instancesTab) || (op.view === "git" && !gitTab) ? "services" : op.view;
    const selectTab = (r: ProjectTab) => { leave(); setOpenProject({ id: op.id, name: op.name, view: r }); };
    return (
      <ProjectView
        projectId={op.id}
        name={name}
        state={live?.instance?.state}
        tooltip={live && (live.instance || !gw) ? <Tooltip p={live} gw={gw} header /> : undefined}
        tab={view}
        onTab={selectTab}
        layout={layoutTab}
        instances={instancesTab}
        git={gitTab}
        onBack={inProject ? undefined : () => { leave(); setOpenProject(null); }}
        onEnter={inProject ? undefined : () => onEnter({ id: op.id, name })}
      >
        {view === "timeline" ? (
          // The project's timeline — on every project, components/timeline/.
          <Timeline key={op.id} projectId={op.id} workspaceId={workspaceId} />
        ) : view === "git" ? (
          // The big git overview (components/projects/git/GitView.tsx); it picks up the wish of a jump (lib/project-jump.ts
          // `takeProjectGitTarget`: the chosen repo) on mount and on the event.
          <GitView key={op.id} projectId={op.id} workspaceId={workspaceId} />
        ) : view === "instances" ? (
          <InstancesPage
            key={op.id}
            projectId={op.id}
            projectName={name}
            workspaceId={workspaceId}
            onTab={selectTab}
            onCode={() => onCode?.({ id: op.id, name })}
          />
        ) : view === "layout" ? (
          <LayoutPage
            key={op.id}
            embedded
            project={{ id: op.id, name }}
            rules={rules}
            onRepoOpen={onCode ? (path) => { showInCode(op.id, path); onCode({ id: op.id, name }); } : undefined}
          />
        ) : (
          <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
            <ProjectServicesPane
              key={op.id}
              embedded
              projectId={op.id}
              projectName={name}
              startLocked={live && layoutRow(live.layout).services ? t("The outline is being applied — starting services has to wait until it is done.") : null}
              addition={live ? <OldContainerRemove key={live.id} projectId={live.id} count={live.superseded ?? 0} onFinished={() => void onChanged().catch(() => {})} /> : null}
            />
          </div>
        )}
      </ProjectView>
    );
  }

  const inOps = mode === "container";
  // The list: no surface, no card — rows directly on the stage, in the shape of the instances (ProjectForm.tsx): no hairlines,
  // rounded, light under the pointer; in front the tile with the folder in the project container's colour, below it the facts
  // with small icons and the state rows as dot with word. Above the list the summary instead of the explanatory sentence (which
  // stays while there is no project).
  return (
    <section className={`${COLUMN} flex min-h-0 flex-1 flex-col`}>
      {choice.inputs}
      {retro.dialogs}
      <PagesHeader
        title={t("Projects")}
        under={projects.length ? <span className="tabular-nums" data-projects-summary>{summary(projects, inOps, t)}</span> : t("A project is a folder of the workspace with its own services and chats.")}
      >
        {inOps ? (
          <Menu
            label={t("New project")}
            width={220}
            button={{ content: t("+ Project"), className: primary, data: { "data-project-new": "1" } }}
          >
            <MenuEntry label={t("Empty project")} disabled={!rules} onClick={() => setCreate("empty")} data={{ "data-project-new-empty": "1" }} />
            <MenuEntry label={t("Upload folder")} disabled={!rules} onClick={() => setCreate("folder")} data={{ "data-project-new-folder": "1" }} />
            <MenuEntry label={t("Upload ZIP")} disabled={!rules} onClick={() => setCreate("zip")} data={{ "data-project-new-zip": "1" }} />
            <MenuEntry label={t("Clone Git repository")} disabled={!rules} onClick={() => setCreate("clone")} data={{ "data-project-new-clone": "1" }} />
          </Menu>
        ) : (
          <button onClick={() => setFolderDialog(true)} disabled={mode === null} className={`${primary} disabled:opacity-40`}>
            {t("+ Project")}
          </button>
        )}
      </PagesHeader>
      {projects.length === 0 ? (
        <EmptySentence title={t("No projects yet.")}>{inOps ? t("Create a project — empty or with a folder from your device.") : t("Create a project.")}</EmptySentence>
      ) : (
        <div className="flex shrink-0 flex-col gap-0.5" data-project-list>
          {projects.map((p) => {
            const display = setupDisplay(p.setup, p.detection, now);
            const run = runs[p.id];
            // What this tab is uploading right now it shows with its own progress — the server's row for it is dropped.
            const own = new Set((run?.sources ?? []).filter((q) => q.state === "waiting" || q.state === "running").map((q) => q.seq));
            const rows = display.rows.filter((z) => z.seq === undefined || !own.has(z.seq));
            const afterDisplay = retroactiveDisplay(p.uploads, retro.own(p.id), retro.ended(p.id), now);
            const segment = layoutRow(p.layout);
            const deleteLocked = display.locked.erase || own.size > 0 || afterDisplay.locked.erase || retro.active(p.id) || segment.locked.erase;
            // Upload later: only in server mode, without an open setup, with a ready instance — otherwise greyed.
            const upload = inOps && Boolean(rules) && uploadPossible(p, { upload: display.locked.upload || segment.locked.upload });
            // The layout needs the project container; during setup there is none (viewing would work, but the tree is only being
            // built). The same condition carries the project view's layout tab.
            const layout = inOps && Boolean(p.instance?.converted) && !display.locked.layout;
            const draggable = inOps && Boolean(p.instance);
            const notUploadReason = p.setup ? t("The project is still being set up — uploading into it only works afterwards.")
              : segment.locked.upload ? t("An outline is pending — uploading into the project only works afterwards.")
              : !rules ? t("The server's rules have not loaded yet — try again in a moment.")
              : t("The project container is not ready right now — uploading into it only works afterwards.");
            return (
              <div
                key={p.id}
                onClick={() => setOpenProject({ id: p.id, name: p.name, view: "services" })}
                title={t("Open project")}
                // The drop marker is the accent tint of the selected row (`SELECTED`). No `cb-row`: the unlayered rule
                // `.cb-kit .cb-row` sets `border-radius: 0` and would beat the rounding (and any `bg-…`) on the element.
                className={`${LIST_ROW} cursor-pointer items-start ${dropTarget === p.id ? SELECTED : "hover:bg-hover"}`}
                data-active={dropTarget === p.id ? "1" : undefined}
                data-project-row={p.id}
                // Drag & drop: folders and files into the root; a single ZIP asks. Even a row that cannot take anything right now
                // accepts the drop — otherwise the browser would open the file instead of the page — and says why not. Hence ALWAYS
                // "copy": with "none" the drop counts as failed, `drop` never fires, and the explanation would never appear.
                onDragOver={draggable ? (e) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (dropTarget !== p.id) setDropTarget(p.id); } : undefined}
                onDragLeave={draggable ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((z) => (z === p.id ? null : z)); } : undefined}
                onDrop={draggable ? (e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(null);
                  if (!upload) { alert(notUploadReason); return; }
                  const entries = depositEntries(e.dataTransfer);
                  void retro.deposit(p, entries);
                } : undefined}
              >
                <Tile
                  color={p.instance ? textOf(instanceColor(p.instance.state)) : "text-fg/80"}
                  title={p.instance ? stateWord(p.instance.state, t) : undefined}
                  data={{ "data-project-tile": p.instance?.state ?? "" }}
                >
                  {S.project(16)}
                </Tile>
                <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center">
                  <span className="truncate text-[14px] font-medium tracking-[-0.01em]">{p.name}</span>
                  {(p.instance || !gw || (portConflicts[p.id]?.items.length ?? 0) > 0) && (
                    <span className={`mt-0.5 ${FACTS}`}>
                      <Tooltip p={p} gw={gw} />
                      {(portConflicts[p.id]?.items.length ?? 0) > 0 && (
                        // Only a DISPLAY: a click goes into the project's services as everywhere on the row.
                        <span className="group/warn relative flex shrink-0 items-center gap-1 text-warn" data-project-port-conflict>
                          {S.warn(12)}
                          {portConflicts[p.id].items.length === 1 ? t("{n} port conflict", { n: 1 }) : t("{n} port conflicts", { n: portConflicts[p.id].items.length })}
                          <span className="cb-pop pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-[280px] rounded-xl px-3 py-2 text-left text-[11px] font-normal text-fg group-hover/warn:block">
                            <span className="mb-0.5 block font-semibold">{t("Port conflicts")}</span>
                            {portConflicts[p.id].items.map((c, ci) => (
                              <span key={ci} className="block">{t(":{port} ({name}) — owned by \"{owner}\"", { port: c.port, name: c.name, owner: c.owner })}</span>
                            ))}
                          </span>
                        </span>
                      )}
                    </span>
                  )}
                  {rows.map((z, i) => (
                    <div key={i} className={stateRow} data-project-setup={z.tone}>
                      <span
                        className={`flex min-w-0 items-center gap-1.5 text-[12px] ${WORD[z.tone]}`}
                        title={z.text === "{n} files already exist" ? (p.setup?.conflict?.examples ?? []).join("\n") : cloneTitle(p, z.seq)}
                      >
                        <Point color={POINT[z.tone]} />
                        {t(z.text, { ...(z.values ?? {}), ...(z.step ? { step: t(STEP_NAMES[z.step]) } : {}) })}
                      </span>
                      {z.actions.map((a, j) => (
                        <button
                          key={j}
                          type="button"
                          disabled={(a.kind === "erase" && deleteLocked) || (a.kind === "resume" && !rules)}
                          onClick={(e) => { e.stopPropagation(); void action(p, a); }}
                          className={`${ghostSm} disabled:opacity-40`}
                          data-project-action={a.kind}
                        >
                          {a.change ? t("Change access") : t(ACTION_TEXT[a.kind])}
                        </button>
                      ))}
                    </div>
                  ))}
                  {(p.remoteHints ?? []).map((h, i) => (
                    // Remote hint: names only — the access itself appears in no answer; cbase rewrites nothing.
                    <div key={`r${i}`} className={`${stateRow} text-[12px] text-fg`} data-project-remote-hint
                         title={t("Every agent in the project can read this address. Better store the credentials as a Git access and set the address without them.")}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Point color="bg-warn" />
                        {t("Remote “{remote}” in {repo} contains credentials in its URL", { remote: h.remote, repo: h.repo || "/" })}
                      </span>
                    </div>
                  ))}
                  {segment.row && (
                    <div className={stateRow} data-project-layout={segment.row.tone}>
                      <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${WORD[segment.row.tone]}`} title={segment.row.reason || undefined}>
                        <Point color={POINT[segment.row.tone]} />
                        {t(segment.row.text, {
                          ...(segment.row.values ?? {}),
                          ...(segment.row.step !== undefined ? { step: LAYOUT_STEP_NAMES[segment.row.step] ? t(LAYOUT_STEP_NAMES[segment.row.step]) : segment.row.step } : {}),
                        })}
                      </span>
                      {segment.row.actions.map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void layoutAction(p, a); }}
                          className={ghostSm}
                          data-project-layout-action={a}
                        >
                          {t(LAYOUT_TEXT[a])}
                        </button>
                      ))}
                    </div>
                  )}
                  {run && <RunRows run={run} onClose={() => setRuns((l) => { const n = { ...l }; delete n[p.id]; return n; })} />}
                  {afterDisplay.rows.map((z) => (
                    <div key={z.operation} className={stateRow} data-project-upload={z.tone}>
                      <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${WORD[z.tone]}`} title={z.examples?.join("\n")}>
                        <Point color={POINT[z.tone]} />
                        {t(z.text, z.values ?? {})}
                      </span>
                      {z.actions.map((a) => (
                        <button
                          key={a.kind}
                          type="button"
                          disabled={a.kind === "resume" && !rules}
                          onClick={(e) => { e.stopPropagation(); void retro.action(p, a); }}
                          className={`${ghostSm} disabled:opacity-40`}
                          data-project-upload-action={a.kind}
                        >
                          {t(UPLOAD_TEXT[a.kind])}
                        </button>
                      ))}
                    </div>
                  ))}
                  <RetroactiveRunRows
                    runs={retro.runs[p.id] ?? []}
                    depositWaiting={Boolean(retro.depositWaiting[p.id])}
                    onAbort={(l) => retro.abortRun(l)}
                    onHide={(l) => retro.remove(p.id, l.id)}
                    onForgetDeposit={() => retro.forgetDeposit(p.id)}
                  />
                </div>
                <div className="flex h-8 shrink-0 items-center gap-1.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); onEnter({ id: p.id, name: p.name }); }}
                    title={t("Enter the project — focused chat (workspace skills remain)")}
                    className={ghostSm}
                  >
                    {t("Enter")}
                  </button>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Menu label={t("More")} silent width={200}>
                      {inOps && (
                        <>
                          <MenuEntry label={t("Outline")} disabled={!layout} onClick={() => setOpenProject({ id: p.id, name: p.name, view: "layout" })} data={{ "data-project-layout-open": "1" }} />
                          <MenuEntry label={t("Upload files")} disabled={!upload} onClick={() => void retro.start(p, "files")} data={{ "data-project-upload-files": "1" }} />
                          <MenuEntry label={t("Upload folder")} disabled={!upload} onClick={() => void retro.start(p, "folder")} data={{ "data-project-upload-folder": "1" }} />
                          <MenuEntry label={t("Upload ZIP")} disabled={!upload} onClick={() => void retro.start(p, "zip")} data={{ "data-project-upload-zip": "1" }} />
                        </>
                      )}
                      <MenuEntry label={t("Services")} onClick={() => setOpenProject({ id: p.id, name: p.name, view: "services" })} />
                      <MenuEntry label={t("Remove")} danger disabled={deleteLocked} onClick={() => void deleteProject(p.id)} />
                    </Menu>
                  </span>
                  <RowsArrow />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {create && rules && (
        <ProjectCreate
          workspaceId={workspaceId}
          rules={rules}
          start={create}
          onClose={() => setCreate(null)}
          onCreated={(proj, uploads) => {
            void onChanged().catch(() => {});
            void startUploads(proj.id, uploads, false);
          }}
        />
      )}
      {accessFor && (
        <Modal onClose={() => setAccessFor(null)} width={400} label={t("Git access for {host}", { host: accessFor.host })}>
          <ModalTitle>{t("Git access for {host}", { host: accessFor.host })}</ModalTitle>
          <GitAccessForm
            host={accessFor.host}
            hostFixed
            abort={() => setAccessFor(null)}
            button={t("Save & retry")}
            buttonBusy={t("Trying…")}
            save={async (z) => {
              await api(`/api/workspaces/${workspaceId}/git/creds`, { method: "PUT", body: JSON.stringify(z) });
              await api(`/api/projects/${accessFor.project}/setup/again`, { method: "POST" });
              setAccessFor(null);
              await onChanged().catch(() => {});
            }}
          />
        </Modal>
      )}
      {folderDialog && (
        <FolderDialog
          title={t("New project")}
          pickTitle={t("Choose project folder")}
          pathPlaceholder={t("/path/to/project (created if new)")}
          submitLabel={t("Create")}
          onCreate={createFolderProject}
          onClose={() => setFolderDialog(false)}
        />
      )}
    </section>
  );
}

/** The muted short info under the name (list row and project view header) as facts with small icons: the project container's
 *  state as a word only if it is not ready (the tile carries it as colour; in the header "ready" is shown too, being the only
 *  line there), the number of copies, without server mode the folder. */
function Tooltip({ p, gw, header = false }: { p: Project; gw: boolean; header?: boolean }) {
  const t = useT();
  const copies = p.instance?.copies?.length ?? 0;
  const z = p.instance?.state;
  const tone = z === "error" ? "text-danger" : z === "clearAway" || z === "waiting_queue" || z === "waiting_storage" ? "text-warn" : "";
  return (
    <>
      {p.instance && (header || z !== "ready") && (
        <Fact className={`shrink-0 ${tone}`} data={{ "data-project-state": z ?? "" }}>
          {header && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${instanceColor(z)}`} aria-hidden />}
          {stateWord(z ?? "", t)}
        </Fact>
      )}
      {copies > 0 && (
        <Fact symbol={S.copy(12)} className="shrink-0 tabular-nums">{copies === 1 ? t("1 copy") : t("{n} copies", { n: copies })}</Fact>
      )}
      {!gw && <Fact symbol={S.project(12)}><span className="min-w-0 truncate font-mono text-[11.5px]">{p.path}</span></Fact>}
    </>
  );
}

/** The line above the list: how many projects, in server mode how many of them are ready and how many copies exist. */
function summary(projects: Project[], inOps: boolean, t: ReturnType<typeof useT>): string {
  const n = projects.length;
  const parts = [n === 1 ? t("1 project") : t("{n} projects", { n })];
  if (inOps) {
    parts.push(t("{n} ready", { n: projects.filter((p) => p.instance?.state === "ready").length }));
    const copies = projects.reduce((s, p) => s + (p.instance?.copies?.length ?? 0), 0);
    if (copies) parts.push(copies === 1 ? t("1 copy") : t("{n} copies", { n: copies }));
  }
  return parts.join(" · ");
}

function RunRows({ run, onClose }: { run: Run; onClose: () => void }) {
  const t = useT();
  const active = run.sources.some((q) => q.state === "waiting" || q.state === "running");
  return (
    <div className="mt-2.5 space-y-2" onClick={(e) => e.stopPropagation()} data-project-upload>
      {run.sources.map((q) => {
        const f = q.progress;
        const share = f && f.bytesTotal ? Math.max(2, (f.bytes / f.bytesTotal) * 100) : 2;
        return (
          <div key={q.seq}>
            <div className="flex items-center justify-between gap-2 text-[11.5px]">
              <span className={`truncate ${q.state === "error" ? "text-danger" : q.state === "aborted" ? "text-warn" : "text-dim"}`}>
                {q.state === "waiting" ? t("{source}: waiting for the container…", { source: q.target || "/" })
                  : q.state === "finished" ? t("{source}: uploaded", { source: q.target || "/" })
                  : q.state === "aborted" ? t("{source}: upload interrupted — can be resumed", { source: q.target || "/" })
                  : q.state === "error" ? t("{source}: {error}", { source: q.target || "/", error: q.error ?? "" })
                  : t("{source}: uploading", { source: q.target || "/" })}
              </span>
              {f && (
                <span className="shrink-0 tabular-nums text-dim">
                  {t("{done} / {total} files · {sent} / {size}", { done: f.files, total: f.filesTotal, sent: sizeText(f.bytes), size: sizeText(f.bytesTotal) })}
                </span>
              )}
            </div>
            {(q.state === "running" || q.state === "waiting") && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-edge">
                <div className={`h-full rounded-full bg-accent transition-all ${q.state === "waiting" ? "w-full animate-pulse opacity-50" : ""}`} style={q.state === "running" ? { width: `${share}%` } : undefined} />
              </div>
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        {active ? (
          <>
            <span className="text-[11px] text-dim">{t("Keep this tab open until the upload is done.")}</span>
            <button type="button" onClick={() => abortRun(run)} className={ghostSm}>{t("Cancel")}</button>
          </>
        ) : (
          <button type="button" onClick={onClose} className={ghostSm}>{t("Dismiss##hide")}</button>
        )}
      </div>
    </div>
  );
}
