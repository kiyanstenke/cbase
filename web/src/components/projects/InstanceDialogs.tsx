"use client";

// The dialogs of the "Instances" tab. All three are the kit `Modal` (`cb-overlay` + `cb-sheet`, via portal on the body, `cb-kit` on
// the overlay node).
//
//  · CopyCreate   Name (preset k<n> — the first free one next to the tree; the suggestion follows every new tree until the human
//                   edits the name themselves), base from `baseOptions` (every ready instance, main first; with no tree read yet
//                   "loading…", never "no instance is ready" — the tab opens the dialog only with a tree), per repo the branch from
//                   GET …/instances/<base>/repos (the checked-out one preselected). What goes out is `baseInstance` (the instance name
//                   "main" or "copy-<name>", as stacks/routes.js BODY_FIELDS reads it) ALWAYS, plus only what DEVIATES (`base` as
//                   `{ "<rel>": ref }`, the project folder is "." there), and NEVER a `chatId` (the copy belongs to no chat).
//                   The server takes a ready copy as the template (stacks/request.js). What can fail while the dialog is open (the
//                   template vanished or left `ready`) is put into the dialog's words by `baseErrorText` — 400 BASE_INSTANCE_INVALID,
//                   409 TEMPLATE_UNKNOWN / TEMPLATE_NOT_READY / TEMPLATE_UNREADABLE —, the server's sentence shows small below it. If
//                   the chosen base drops out of the options (the tree refreshes every 5 s), it stays visible as "not ready" and
//                   "Create" is off — the dialog never shows a different base than the one it would send (a `<select>` without a
//                   matching option would silently show the first).
//  · CopyDelete  the SAME component in the tab and the services pill. The delete preview (GET …/stack-copies/:name/state) shows per
//                   repo what lands in main as `copy/<name>/…` (always saved, no checkbox), and the copy's chats. Without a preview
//                   (copy not ready, read failed) the reason shows and deleting stays possible — "not read" is never "nothing to
//                   save". 409 INSTANCE_WORKING stays in the dialog and names the chats.
//  · BranchSwitch per repo: choose a branch (local + remote); open files show BEFORE the switch, each with "Discard" after a
//                   confirmation (discarding exists only here, file by file). After the switch "Restart stack" (nothing happens
//                   automatically).
import { useEffect, useMemo, useState } from "react";
import {
  errorFields, loadInstanceRepos, loadInstancesTree, loadCopyStatus, createCopy, deleteCopy, restartStack, subscribeGlobalEvents, dismissFiles, switchBranch,
  type WorkingChat, type ErrorFields, type InstanceRepo, type InstanceRepos, type CopyStatus,
} from "@/lib/api";
import { MAIN, actionFrom, baseOptions, copyName, readTree, type Tree, type TreeAction } from "@/lib/instances-tree";
import { clearAwayQuestion } from "@/lib/services-status";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { Hint, Modal, ModalTitle, Spinner, field, ghost, primary, quietDanger, quietDangerSm, select } from "@/components/CbKit";

type Translator = ReturnType<typeof useT>;

/** The name of an instance for humans: "Main" or "Copy k1". */
export function instanceTitle(name: string, t: Translator): string {
  const k = copyName(name);
  return k ? t("Copy {name}", { name: k }) : t("Main");
}

/** The first free name k<n> (n ≥ 1) next to the instances of the tree. */
export function freeCopyName(tree: Tree | null): string {
  const occupied = new Set((tree?.instances ?? []).map((i) => i.name));
  for (let n = 1; ; n++) if (!occupied.has(`copy-k${n}`)) return `k${n}`;
}

/** The chats of a 409 INSTANCE_WORKING or of a preview as a list — a running one carries the dot. */
export function ChatList({ chats, t }: { chats: WorkingChat[]; t: Translator }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1" data-instance-chats>
      {chats.map((c, i) => (
        <li key={c.id || i} className="flex min-w-0 items-center gap-2 text-[12.5px]">
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.running ? "bg-accent" : "bg-dim/40"}`} />
          <span className="min-w-0 truncate">{c.title || t("New chat")}</span>
          {c.reason && <span className="shrink-0 text-[11.5px] text-dim">{c.reason}</span>}
          {c.running && !c.reason && <span className="shrink-0 text-[11.5px] text-dim">{t("running")}</span>}
        </li>
      ))}
    </ul>
  );
}

/** An error from the server's answer, with the chats of a working lock below. `explanation`: the dialog's sentence for a known
 *  code — the server's sentence then shows small below it (it names states and names the dialog does not know). */
function ErrorRow({ f, t, explanation }: { f: ErrorFields; t: Translator; explanation?: string | null }) {
  return (
    <div className="mt-3" data-instance-error={f.code || "error"}>
      <Hint tone="danger">
        {explanation || f.text}
        {explanation && f.text && <div className="mt-1 text-[11.5px] opacity-80" data-instance-error-server>{f.text}</div>}
        {f.code === "INSTANCE_WORKING" && f.chats && f.chats.length > 0 && <ChatList chats={f.chats} t={t} />}
      </Hint>
    </div>
  );
}

/**
 * The rejection of a chosen base in the dialog's words (stacks/request.js) — `null` for any other code (the server's sentence then
 * speaks alone). `base` is the instance the POST sent, not the one chosen now.
 */
export function baseErrorText(code: string, base: string, t: Translator): string | null {
  const who = instanceTitle(base, t);
  switch (code) {
    case "BASE_INSTANCE_INVALID": return t("“{base}” is not an instance of this project — main and any ready copy can be the base.", { base: base });
    case "TEMPLATE_UNKNOWN": return t("{who} no longer exists — choose another base.", { who: who });
    case "TEMPLATE_NOT_READY": return t("{who} is not ready right now — a copy can only be made from a ready instance. If it is stopped, start it first; otherwise wait until it is ready, or choose another base.", { who: who });
    // Without a running main its refs are not readable — also for a copy made from a copy.
    case "MAIN_STOPPED": return t("Main is stopped — no copy can be made without a running main instance (not even from another copy). Start main in this list, then create the copy.");
    case "TEMPLATE_UNREADABLE": return t("cbase could not read the code state of {who} — without it, it is unclear which repos the copy carries. Try again or choose another base.", { who: who });
    default: return null;
  }
}

const relKey = (rel: string) => (rel === "" ? "." : rel);
const repoName = (r: { rel: string; name: string }, t: Translator) => (r.rel === "" ? t("Project folder") : r.rel || r.name);

// ── Create a copy ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function CopyCreate({ projectId, tree, preselection, onClose, onCreated }: {
  projectId: string;
  tree: Tree | null;
  /** The preselected base (the "Copy from this instance" entry in the ⋯ menu); otherwise main. */
  preselection: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const t = useT();
  const options = useMemo(() => baseOptions(tree), [tree]);
  // The suggestion follows the tree (a copy that is meanwhile called "k1" turns it into "k2") until the human types —
  // `ownName` null means "the suggestion applies". (Computed once at open, it would be "k1" whenever the tree was still missing.)
  const [ownName, setOwnName] = useState<string | null>(null);
  const name = ownName ?? freeCopyName(tree);
  const [base, setBase] = useState(() => (options.some((o) => o.name === preselection) ? preselection : options[0]?.name ?? MAIN));
  // Is the chosen base (still) among the ready instances? Otherwise it stays visibly chosen, but "Create" is off (header).
  const baseReady = options.some((o) => o.name === base);
  const [repos, setRepos] = useState<InstanceRepos | null>(null);
  const [repoError, setRepoError] = useState("");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ f: ErrorFields; base: string } | null>(null);

  // The repos of the BASE — refetched on every change; until the answer "loading", never "no repos".
  useEffect(() => {
    let alive = true;
    setRepos(null);
    setRepoError("");
    setChoice({});
    loadInstanceRepos(projectId, base)
      .then((r) => { if (alive) setRepos(r); })
      .catch((e) => { if (alive) setRepoError(errorFields(e).text); });
    return () => { alive = false; };
  }, [projectId, base]);

  const deviating = repos?.loaded ? repos.repos.filter((r) => choice[r.rel] && choice[r.rel] !== r.branch) : [];
  const create = async () => {
    const sent = base; // the base of THIS call — the error text names it, even if another is chosen afterwards
    setBusy(true);
    setError(null);
    try {
      const k = await createCopy(projectId, {
        name: name.trim(), baseInstance: sent,
        ...(deviating.length ? { base: Object.fromEntries(deviating.map((r) => [relKey(r.rel), choice[r.rel]])) } : {}),
      });
      onCreated(k.name);
      onClose();
    } catch (e) {
      setError({ f: errorFields(e), base: sent });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={t("Create copy")} width={560}>
      <div data-copy-create>
        <ModalTitle hint={t("A copy is a separate instance of the project with its own containers and its own code. It belongs to no chat and lives until it is deleted.")}>
          {t("Create copy")}
        </ModalTitle>
        <label className="block text-[12px] font-medium text-dim" htmlFor="copy-name">{t("Name")}</label>
        <input id="copy-name" value={name} onChange={(e) => setOwnName(e.target.value)} className={`${field} mt-1 w-full`} data-copy-name autoFocus />
        <label className="mt-4 block text-[12px] font-medium text-dim" htmlFor="copy-base">{t("Base")}</label>
        {!tree ? (
          <p className="mt-1 flex items-center gap-2 text-[12.5px] text-dim" data-copy-base-loading><Spinner /> {t("Loading…##inline")}</p>
        ) : options.length ? (
          <select id="copy-base" value={base} onChange={(e) => setBase(e.target.value)} className={`${select} mt-1`} data-copy-base>
            {!baseReady && <option value={base} disabled>{t("{who} · not ready", { who: instanceTitle(base, t) })}</option>}
            {options.map((o) => <option key={o.name} value={o.name}>{instanceTitle(o.name, t)}</option>)}
          </select>
        ) : (
          <p className="mt-1 text-[12.5px] text-dim">{t("No instance is ready — a copy can only be made from a running instance.")}</p>
        )}
        {options.length > 0 && !baseReady && (
          <p className="mt-1.5 text-[11.5px] text-dim" data-copy-base-gone>{t("{who} is not ready right now — choose another base or wait until it is ready.", { who: instanceTitle(base, t) })}</p>
        )}
        {base !== MAIN && baseReady && (
          <p className="mt-1.5 text-[11.5px] text-dim" data-copy-base-template>{t("A copy carries over its whole state — open changes, index, reflogs and stashes; with a different branch, no repo carries over open changes. It pauses briefly for this.")}</p>
        )}

        <div className="mt-4 text-[12px] font-medium text-dim">{t("Branch per repo")}</div>
        {repoError ? (
          <p className="mt-1 text-[12.5px] text-danger">{t("Repos unreadable: {reason} — the copy starts with the state of the base.", { reason: repoError })}</p>
        ) : !repos ? (
          <p className="mt-1 flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> {t("Loading…##inline")}</p>
        ) : !repos.loaded ? (
          <p className="mt-1 text-[12.5px] text-dim">{t("Repos unreadable: {reason} — the copy starts with the state of the base.", { reason: repos.error || repos.state || "?" })}</p>
        ) : repos.repos.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-dim">{t("No code repos in this instance.")}</p>
        ) : (
          <div className="mt-1 flex flex-col divide-y divide-edge" data-copy-repos>
            {repos.repos.map((r) => (
              <div key={r.rel} className="flex items-center gap-3 py-1.5" data-copy-repo={r.rel}>
                <span className="min-w-0 flex-1 truncate text-[12.5px]" title={r.rel || r.name}>{repoName(r, t)}</span>
                <BranchChoice repo={r} value={choice[r.rel] ?? r.branch} onChange={(b) => setChoice((w) => ({ ...w, [r.rel]: b }))} t={t} />
              </div>
            ))}
          </div>
        )}

        {error && <ErrorRow f={error.f} t={t} explanation={baseErrorText(error.f.code, error.base, t)} />}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={ghost} onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className={primary} disabled={busy || !tree || !name.trim() || !baseReady} onClick={() => void create()} data-copy-create-ok>
            {busy ? t("Creating …") : t("Create")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The choice of a branch: local ones, remote ones below; a detached state stays selectable as its own entry. */
function BranchChoice({ repo, value, onChange, t }: { repo: InstanceRepo; value: string; onChange: (b: string) => void; t: Translator }) {
  const local = repo.branches ?? [];
  const removed = (repo.remotes ?? []).filter((b) => !local.includes(b));
  const without = !local.includes(value) && !removed.includes(value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${select} max-w-[60%]`} aria-label={t("Branch")} data-branch-choice>
      {without && <option value={value}>{repo.detached && value === repo.branch ? t("detached · {id}", { id: value }) : value}</option>}
      {local.length > 0 && <optgroup label={t("Local")}>{local.map((b) => <option key={b} value={b}>{b}</option>)}</optgroup>}
      {removed.length > 0 && <optgroup label={t("Remote##distant")}>{removed.map((b) => <option key={`r:${b}`} value={b}>{b}</option>)}</optgroup>}
    </select>
  );
}

// ── Delete copy ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function CopyDelete({ projectId, projectName, name, onClose, onDeleted }: {
  projectId: string;
  projectName: string;
  /** The name of the copy without "copy-" ("k1"). */
  name: string;
  onClose: () => void;
  /** After the accepted DELETE (202) with the server's body — the dialog is already closed by then. */
  onDeleted: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<CopyStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorFields | null>(null);

  useEffect(() => {
    let alive = true;
    loadCopyStatus(projectId, name)
      .then((s) => { if (alive) setStatus(s); })
      .catch((e) => { if (alive) setStatusError(errorFields(e).text); });
    return () => { alive = false; };
  }, [projectId, name]);

  const erase = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await deleteCopy(projectId, name);
      onClose();
      onDeleted(body ?? {});
    } catch (e) {
      setError(errorFields(e));
    } finally {
      setBusy(false);
    }
  };

  // The wording of the question is the same as in the pill and the Apps page (lib/services-status.ts clearAwayQuestion):
  // what lands in main and what is lost.
  const hint = clearAwayQuestion({ identifier: `${projectId}/copy-${name}`, name }, projectName, t);
  const run = status?.loaded ? status.chats.filter((c) => c.running) : [];
  return (
    <Modal onClose={onClose} label={t("Delete copy {name}", { name })} width={560}>
      <div data-copy-delete={name}>
        <ModalTitle hint={hint}>{t("Delete copy {name}", { name })}</ModalTitle>
        {statusError ? (
          <Hint tone="warn">{t("cbase could not read the state of the copy: {reason} — deleting still saves everything.", { reason: statusError })}</Hint>
        ) : !status ? (
          <p className="flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> {t("Loading…##inline")}</p>
        ) : !status.loaded ? (
          <Hint tone="warn">{t("cbase could not read the state of the copy: {reason} — deleting still saves everything.", { reason: status.error || "?" })}</Hint>
        ) : (
          <>
            <div className="text-[12px] font-medium text-dim">{t("Lands in main under copy/{name}/…", { name })}</div>
            {status.repos.length === 0 ? (
              <p className="mt-1 text-[12.5px] text-dim">{t("No code repos in this copy.")}</p>
            ) : (
              <div className="mt-1 flex flex-col divide-y divide-edge" data-copy-status>
                {status.repos.map((r) => (
                  <div key={r.rel} className="py-1.5" data-copy-status-repo={r.rel}>
                    <div className="flex items-center gap-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate">{repoName(r, t)}{r.fresh && <span className="text-dim"> · {t("new repo")}</span>}</span>
                      <span className="shrink-0 font-mono text-[11.5px] text-dim">{r.detached ? t("detached · {id}", { id: r.branch }) : r.branch}</span>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-dim">
                      {[
                        r.commits === null ? t("Commits: not counted") : t("{n} commit(s)", { n: r.commits }),
                        (r.openCount ?? r.open.length) > 0 ? t("{n} open file(s) as a backup", { n: r.openCount ?? r.open.length }) : t("no open files"),
                      ].join(" · ")}
                    </div>
                    {r.open.length > 0 && (
                      <ul className="mt-0.5 font-mono text-[11px] text-dim">
                        {r.open.slice(0, 8).map((p) => <li key={p} className="truncate">{p}</li>)}
                        {(r.openCount ?? r.open.length) > 8 && <li>{t("… and {n} more", { n: (r.openCount ?? r.open.length) - 8 })}</li>}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 text-[12px] font-medium text-dim">{t("Chats in this copy")}</div>
            {status.chats.length === 0
              ? <p className="mt-1 text-[12.5px] text-dim">{t("No chat works in this copy.")}</p>
              : <ChatList chats={status.chats} t={t} />}
            {status.chats.length > 0 && <p className="mt-1.5 text-[11.5px] text-dim">{t("After deletion these chats continue in main; their history stays.")}</p>}
            {run.length > 0 && <div className="mt-2"><Hint tone="warn">{t("While a chat is running in the copy, it cannot be deleted.")}</Hint></div>}
          </>
        )}
        {error && <ErrorRow f={error} t={t} />}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={ghost} onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className={quietDanger} disabled={busy} onClick={() => void erase()} data-copy-delete-ok>
            {busy ? t("…") : t("Delete")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Switch branch ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function BranchSwitch({ projectId, instance, rel, onClose, onSwitched }: {
  projectId: string;
  /** "main" or "copy-<name>". */
  instance: string;
  /** The `rel` of the repo row ("" = the project folder). */
  rel: string;
  onClose: () => void;
  onSwitched: () => void;
}) {
  const t = useT();
  const question = useConfirm();
  const [repo, setRepo] = useState<InstanceRepo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorFields | null>(null);
  // The open files: from the repo row, after a 409 OPEN_CHANGES from its list.
  const [open, setOpen] = useState<{ files: string[]; count: number } | null>(null);
  // Ignored files that the target branch carries (409 IGNORED_FILES) — they are not "open" and cannot be discarded here; the human
  // saves or clears them away themselves.
  const [ignored, setIgnored] = useState<{ files: string[]; count: number } | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  // The restart keeps running in the server (202) — `since` recognises ITS action in the event `project/instance`, `action` is its
  // latest state (intermediate state per stack, then the end). If the human closes the dialog, it keeps running anyway.
  const [restart, setRestart] = useState<{ since: number | null; action: TreeAction | null } | null>(null);
  const restartSince = restart?.since ?? null;
  const restartRunning = restart !== null && !(restart.action && !restart.action.running);
  useEffect(() => {
    if (!restartRunning) return;
    let alive = true;
    const takeOver = (a: TreeAction | null) => {
      if (!alive || !a || a.kind !== "stack-restart" || (restartSince !== null && a.since !== restartSince)) return;
      setRestart((n) => (n ? { ...n, action: a } : n));
    };
    const off = subscribeGlobalEvents((evt) => {
      if (evt.type !== "project/instance" || String(evt.projectId ?? "") !== projectId || String(evt.instance ?? "") !== instance) return;
      takeOver(actionFrom(evt.action));
    });
    // The subscription exists only after the 202 answer: a restart that ends faster (no stack) would have reported its end before it.
    // Read the tree once AFTER the subscription exists — what came before is in its field `action`, what comes after the subscription brings.
    loadInstancesTree(projectId, null)
      .then((raw) => takeOver(readTree(raw)?.instances.find((i) => i.name === instance)?.action ?? null))
      .catch(() => {});
    return () => { alive = false; off(); };
  }, [restartRunning, restartSince, projectId, instance]);

  useEffect(() => {
    let alive = true;
    loadInstanceRepos(projectId, instance)
      .then((r) => {
        if (!alive) return;
        if (!r.loaded) { setLoadError(r.error || r.state || "?"); return; }
        const z = r.repos.find((x) => x.rel === rel) ?? null;
        if (!z) { setLoadError(t("The repo no longer exists in this instance.")); return; }
        setRepo(z);
        setTarget(z.branch);
        if (z.open) setOpen({ files: z.open, count: z.openCount ?? z.open.length });
      })
      .catch((e) => { if (alive) setLoadError(errorFields(e).text); });
    return () => { alive = false; };
  }, [projectId, instance, rel, t]);

  const changeOver = async () => {
    setBusy("change-over");
    setError(null);
    try {
      const fresh = await switchBranch(projectId, instance, { repo: rel, branch: target });
      if (fresh) setRepo(fresh);
      setSwitched(fresh?.branch || target);
      onSwitched();
    } catch (e) {
      const f = errorFields(e);
      if (f.code === "OPEN_CHANGES" && f.files) setOpen({ files: f.files, count: f.count ?? f.files.length });
      setIgnored(f.code === "IGNORED_FILES" && f.files ? { files: f.files, count: f.count ?? f.files.length } : null);
      setError(f);
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (path: string) => {
    if (!(await question(t("Discard the changes to {path}? They will be gone — this cannot be undone.", { path: path }), { ok: t("Dismiss"), danger: true }))) return;
    setBusy(`v:${path}`);
    setError(null);
    try {
      const fresh = await dismissFiles(projectId, instance, { repo: rel, files: [path] });
      if (fresh) { setRepo(fresh); setOpen(fresh.open ? { files: fresh.open, count: fresh.openCount ?? fresh.open.length } : null); }
      else setOpen((o) => (o ? { files: o.files.filter((d) => d !== path), count: Math.max(0, o.count - 1) } : o));
    } catch (e) {
      setError(errorFields(e));
    } finally {
      setBusy(null);
    }
  };
  const stackNew = async () => {
    setBusy("restart");
    setError(null);
    try { const r = await restartStack(projectId, instance); setRestart({ since: r.since, action: null }); } catch (e) { setError(errorFields(e)); } finally { setBusy(null); }
  };

  const title = repo ? repoName(repo, t) : rel || t("Project folder");
  return (
    <Modal onClose={onClose} label={t("Switch branch")} width={560}>
      <div data-branch-switch={rel}>
        <ModalTitle hint={t("{instance} · {repo}", { instance: instanceTitle(instance, t), repo: title })}>{t("Switch branch")}</ModalTitle>
        {loadError ? (
          <Hint tone="danger">{t("Repo unreadable: {reason}", { reason: loadError })}</Hint>
        ) : !repo ? (
          <p className="flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> {t("Loading…##inline")}</p>
        ) : switched !== null ? (
          <>
            <Hint tone="ok">{t("Checked out: {branch}. Running services and containers keep the old state until the stack restarts.", { branch: switched })}</Hint>
            {restart && (
              <ul className="mt-2 flex flex-col gap-1 text-[12.5px]" data-stack-restart={restartRunning ? "running" : "finished"}>
                {restartRunning && <li className="flex items-center gap-2 text-dim"><Spinner /> {t("The stack is restarting — this can take a while. You can close the dialog; the result will show on the instance.")}</li>}
                {!restartRunning && restart.action?.stacks?.length === 0 && <li className="text-dim">{t("No Compose stack in this instance.")}</li>}
                {(restart.action?.stacks ?? []).map((s) => (
                  <li key={s.project} className={s.ok ? "" : "text-danger"}>{s.ok ? t("{project}: restarted", { project: s.project }) : t("{project}: {error}", { project: s.project, error: s.error || "?" })}</li>
                ))}
                {!restartRunning && !restart.action?.stacks && restart.action?.error && <li className="text-danger">{restart.action.error}</li>}
              </ul>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-dim">{repo.detached ? t("detached · {id}", { id: repo.branch }) : t("now: {branch}", { branch: repo.branch })}</span>
              <span className="ml-auto" />
              <BranchChoice repo={repo} value={target} onChange={setTarget} t={t} />
            </div>
            {open && open.count > 0 && (
              <div className="mt-4" data-branch-open>
                <div className="text-[12px] font-medium text-dim">{t("{n} open file(s) — discard or commit first", { n: open.count })}</div>
                <ul className="mt-1 flex flex-col divide-y divide-edge">
                  {open.files.map((p) => (
                    <li key={p} className="flex items-center gap-2 py-1">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={p}>{p}</span>
                      <button type="button" className={quietDangerSm} disabled={busy !== null} onClick={() => void dismiss(p)} data-branch-dismiss={p}>
                        {busy === `v:${p}` ? t("…") : t("Dismiss")}
                      </button>
                    </li>
                  ))}
                </ul>
                {open.count > open.files.length && <p className="mt-1 text-[11.5px] text-dim">{t("… and {n} more", { n: open.count - open.files.length })}</p>}
              </div>
            )}
          </>
        )}
        {error && <ErrorRow f={error} t={t} />}
        {ignored && ignored.count > 0 && (
          <div className="mt-2" data-branch-ignored>
            <ul className="flex flex-col divide-y divide-edge">
              {ignored.files.map((p) => <li key={p} className="truncate py-1 font-mono text-[11.5px]" title={p}>{p}</li>)}
            </ul>
            {ignored.count > ignored.files.length && <p className="mt-1 text-[11.5px] text-dim">{t("… and {n} more", { n: ignored.count - ignored.files.length })}</p>}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={ghost} onClick={onClose}>{switched !== null ? t("Close") : t("Cancel")}</button>
          {switched !== null ? (
            <button type="button" className={primary} disabled={busy !== null || restartRunning} onClick={() => void stackNew()} data-stack-new-start>
              {busy === "restart" || restartRunning ? t("Restarting …") : t("Restart stack")}
            </button>
          ) : (
            <button type="button" className={primary} disabled={busy !== null || !repo || !target || target === repo.branch} onClick={() => void changeOver()} data-branch-switch-ok>
              {busy === "change-over" ? t("…") : t("Switch")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
