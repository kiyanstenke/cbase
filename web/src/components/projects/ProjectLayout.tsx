"use client";

// The layout of a project as a tree, shown in the create dialog so folders can be moved before creation (project root + sub-projects =
// code repos).
//
// Display and input only: every action becomes a STEP (`onSteps`), and the tree shown here is always `computePlan(…)` over all
// steps (lib/project-layout.ts) — the same computation with which the upload determines the target paths. What you see here is
// therefore exactly where every file goes.
//
// Operation: dragging onto a folder or the root moves; double-click on the name or F2 renames; the menu per row offers Rename, Move
// to…, Leave out, Mark as code repo (and in creation: remove the mark). Code repos are closed blocks. Errors block "Create",
// warnings do not; both show on the node. Below that the combined list of changes — each can be undone individually.
import { useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  type Node, type Notice, type Mode, type Plan, type Step,
  actionsFor, parentOf, isBlock, nameOf, targetsFor,
} from "@/lib/project-layout";
import { Chevron, Hint, Menu, MenuEntry, MenuSeparator, field, ghostSm, menuRow } from "@/components/CbKit";

const connect = (a: string, b: string) => (a ? `${a}/${b}` : b);

export function sizeText(n: number | undefined): string {
  if (n === undefined) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

/** The text of a message from the computation (error, warning or hint from the selection). */
export function noticeText(m: Notice, t: (k: string, p?: Record<string, string | number>) => string, limitRepos?: number): string {
  const path = m.path || "/";
  switch (m.code) {
    case "NAME_INVALID": return t("Name not allowed: {path}", { path: path });
    case "TARGET_DUPLICATE": return t("Two entries with the same target: {path}", { path: path });
    case "CODE_REPO_LOCATION": return t("The repo search cannot find a code repo here (too deep or below an excluded folder): {path}", { path: path });
    case "TOO_MANY_REPOS": return t("More than {n} code repos", { n: limitRepos ?? 25 });
    case "REPO_IN_REPO": return t("A code repo lies inside another one: {path}", { path: path });
    case "IN_CODE_REPO": return t("Lies inside a code repo: {path}", { path: path });
    case "STEP_UNKNOWN":
    case "STEP_INVALID": return t("Change {n} does not fit (any more): {path}", { n: (m.step ?? 0) + 1, path: path });
    case "DEPENDENCY": return t("“{name}” is a dependency folder and stays out of the project repo", { name: nameOf(path) });
    case "MEMORY": return t("{name} only takes effect in the project root", { name: nameOf(path) });
    case "REPO_SHARED": return t("One code repo becomes two");
    case "GIT_FILE_TOT": return t("A .git file without a valid target is left out: {path}", { path: path });
    case "SOURCE_EMPTY": return t("Nothing to upload: {path}", { path: path });
    case "NAME_SUPPLEMENTED": return t("“{old}” already existed — now called “{fresh}”", { old: m.second ?? "", fresh: path });
    // The path here carries exactly the characters no line can take — shown as "?".
    case "NAME_OMITTED": return t("Left out, the name contains control characters: {path}", { path: path.replace(/[\u0000-\u001f\u007f-\u009f]|[\ud800-\udfff]/g, "?") });
    case "FOLDER_EMPTY": return t("Empty folder, will not be created: {path}", { path: path });
    default: return `${m.code}${m.path ? `: ${m.path}` : ""}`;
  }
}

function stepText(s: Step, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (s.kind === "move") {
    return parentOf(s.from) === parentOf(s.to)
      ? t("“{from}” renamed to “{fresh}”", { from: s.from, fresh: nameOf(s.to) })
      : t("“{from}” to “{to}”", { from: s.from, to: s.to });
  }
  if (s.kind === "leaveOut") return t("“{path}” left out", { path: s.path });
  if (s.kind === "code-repo") return t("“{path}” marked as code repo", { path: s.path });
  return t("Code repo mark removed from “{path}”", { path: s.path });
}

const KindIcon = ({ k }: { k: Node }) => {
  const p = (c: React.ReactNode) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-dim">{c}</svg>
  );
  if (isBlock(k.kind) || k.codeRepo) return p(<><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="8" r="2.2" /><path d="M6 8.2v7.6" /><path d="M18 10.2c0 4-6 3-11 6" /></>);
  if (k.kind === "folder") return p(<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />);
  return p(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>);
};

/** Existing project (`inventory`): the tree comes level by level from the server (`GET …/layout?path=`). `loaded`/`loading` name START PATHS
 *  (the origin of a node = its path at load time) — a moved folder therefore loads under its old path. */
export interface Levels {
  loaded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  load: (start: string) => void;
}

export function ProjectLayout({
  rootName, plan, steps, onSteps, mode, onlyView = false, limitRepos, sourceMarker, levels, onRepoOpen, emptyText, flat = false,
}: {
  rootName: string;
  plan: Plan;
  steps: Step[];
  onSteps: (s: Step[]) => void;
  mode: Mode;
  onlyView?: boolean;
  limitRepos?: number;
  /** Creation: the mark of the source on a node — e.g. "ZIP" on the top node of an archive.
   *  Existing project: e.g. "from <repo>" on a worktree block, "Link" on a link. */
  sourceMarker?: (k: Node) => string | null;
  /** Existing project: load levels on demand (see `Levels`). Without: the tree is complete (creation). */
  levels?: Levels;
  /** Existing project: "Open in the Code tab" on a code repo or worktree block (its inside is not shown by the layout). */
  onRepoOpen?: (k: Node) => void;
  emptyText?: string;
  /** Without a surface (the "Layout" tab of the project view): tree, changes and target choice without hairlines. The create dialog keeps the surface. */
  flat?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [rename, setRename] = useState<{ path: string; name: string } | null>(null);
  const [move, setMove] = useState<Node | null>(null);
  const [over, setOver] = useState<string | null>(null); // target under the pointer while dragging ("" = root)
  const pulled = useRef<Node | null>(null);

  const finalTree = plan.finalTree;
  // Children per parent path; a duplicate path (TARGET_DUPLICATE) stays twice — the error then shows on both.
  const children = useMemo(() => {
    const m = new Map<string, Node[]>();
    for (const k of finalTree) {
      const e = parentOf(k.path);
      const l = m.get(e);
      if (l) l.push(k); else m.set(e, [k]);
    }
    for (const l of m.values()) l.sort((a, b) => Number(b.kind !== "file") - Number(a.kind !== "file") || a.path.localeCompare(b.path));
    return m;
  }, [finalTree]);
  const noticesOn = useMemo(() => {
    const m = new Map<string, { error: Notice[]; warnings: Notice[] }>();
    const enabled = (p: string) => { let x = m.get(p); if (!x) { x = { error: [], warnings: [] }; m.set(p, x); } return x; };
    for (const f of plan.error) if (f.path !== undefined && f.step === undefined) enabled(f.path).error.push(f);
    for (const w of plan.warnings) if (w.path !== undefined) enabled(w.path).warnings.push(w);
    return m;
  }, [plan]);
  const freeError = plan.error.filter((f) => f.path === undefined || f.step !== undefined || !finalTree.some((k) => k.path === f.path));
  const stepError = new Set(plan.error.filter((f) => f.step !== undefined).map((f) => f.step as number));

  const fresh = (s: Step) => onSteps([...steps, s]);
  const targetsOf = (k: Node) => targetsFor(k, finalTree);
  const mayAfter = (k: Node | null, target: string) => Boolean(k) && targetsOf(k as Node).includes(target);
  const letFallen = (target: string) => {
    const k = pulled.current;
    pulled.current = null;
    setOver(null);
    if (k && mayAfter(k, target)) fresh({ kind: "move", from: k.path, to: connect(target, nameOf(k.path)) });
  };
  const renamePath = () => {
    if (!rename) return;
    const name = rename.name.trim();
    const old = rename.path;
    setRename(null);
    if (name && name !== nameOf(old)) fresh({ kind: "move", from: old, to: connect(parentOf(old), name) });
  };
  const startOf = (k: Node) => k.origin ?? k.path;
  const unloaded = (k: Node) => Boolean(levels) && k.kind === "folder" && !levels?.loaded.has(startOf(k));
  const toggle = (k: Node) => {
    const p = k.path;
    const on = !open.has(p);
    setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
    if (on && unloaded(k) && !levels?.loading.has(startOf(k))) levels?.load(startOf(k));
  };

  const row = (k: Node, depth: number, i: number): React.ReactNode => {
    const hasChildren = !isBlock(k.kind) && ((children.get(k.path)?.length ?? 0) > 0 || unloaded(k));
    const on = open.has(k.path);
    const acts = actionsFor(k, finalTree, mode, onlyView);
    const msg = noticesOn.get(k.path);
    const isTarget = k.kind === "folder" && over === k.path;
    return (
      <div key={`${k.path}#${i}`}>
        <div
          data-layout-node={k.path}
          tabIndex={0}
          draggable={acts.move && !rename}
          onDragStart={(e) => { pulled.current = k; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k.path); }}
          onDragEnd={() => { pulled.current = null; setOver(null); }}
          onDragOver={(e) => { if (k.kind === "folder" && mayAfter(pulled.current, k.path)) { e.preventDefault(); e.stopPropagation(); setOver(k.path); } }}
          onDragLeave={() => setOver((u) => (u === k.path ? null : u))}
          onDrop={(e) => { if (k.kind === "folder") { e.preventDefault(); e.stopPropagation(); letFallen(k.path); } }}
          onKeyDown={(e) => { if (e.key === "F2" && acts.rename) { e.preventDefault(); setRename({ path: k.path, name: nameOf(k.path) }); } }}
          className={`group flex items-center gap-1.5 rounded-lg py-1 pr-1.5 outline-none transition-colors hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent/50 ${isTarget ? "bg-accent/15 ring-1 ring-accent/50" : ""}`}
          style={{ paddingLeft: 6 + depth * 16 }}
        >
          <button
            type="button"
            onClick={() => hasChildren && toggle(k)}
            aria-label={hasChildren ? (on ? t("Collapse") : t("Expand")) : undefined}
            className={`grid h-4 w-4 shrink-0 place-items-center text-dim ${hasChildren ? "" : "invisible"}`}
          >
            <span className={on ? "" : "-rotate-90"}><Chevron open={false} size={11} /></span>
          </button>
          <KindIcon k={k} />
          {rename?.path === k.path ? (
            <input
              autoFocus
              value={rename.name}
              onChange={(e) => setRename({ path: k.path, name: e.target.value })}
              onBlur={renamePath}
              onKeyDown={(e) => { if (e.key === "Enter") renamePath(); if (e.key === "Escape") setRename(null); e.stopPropagation(); }}
              className={`${field} min-w-0 flex-1 py-0.5 text-[12.5px]`}
            />
          ) : (
            <span
              onDoubleClick={() => acts.rename && setRename({ path: k.path, name: nameOf(k.path) })}
              className={`min-w-0 truncate text-[12.5px] ${msg?.error.length ? "text-danger" : ""}`}
              title={k.path}
            >
              {nameOf(k.path)}
            </span>
          )}
          {sourceMarker?.(k) && (
            <span className="shrink-0 rounded-md bg-hover px-1.5 py-px text-[10px] font-medium text-dim">{sourceMarker(k)}</span>
          )}
          {(isBlock(k.kind) || k.codeRepo) && (
            <span className="shrink-0 rounded-full bg-accent/12 px-1.5 py-px text-[10.5px] font-medium text-accent">
              {k.kind === "worktree" ? t("Worktree") : k.kind === "clone" ? t("Clone") : t("Code repo")}
            </span>
          )}
          {msg && (msg.error.length > 0 || msg.warnings.length > 0) && (
            <span
              className={`shrink-0 text-[11px] ${msg.error.length ? "text-danger" : "text-warn"}`}
              title={[...msg.error, ...msg.warnings].map((m) => noticeText(m, t, limitRepos)).join("\n")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" />
              </svg>
            </span>
          )}
          <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-dim">{sizeText(k.size)}</span>
          {((!onlyView && (acts.rename || acts.move || acts.leaveOut || acts.mark || acts.unmark)) || (onRepoOpen && isBlock(k.kind))) && (
            <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <Menu label={t("Actions")} silent width={220}>
                {onRepoOpen && isBlock(k.kind) && <MenuEntry label={t("Open in the Code tab")} onClick={() => onRepoOpen(k)} />}
                {acts.rename && <MenuEntry label={t("Rename")} onClick={() => setRename({ path: k.path, name: nameOf(k.path) })} />}
                {acts.move && <MenuEntry label={t("Move to…")} disabled={!targetsOf(k).length} onClick={() => setMove(k)} />}
                {acts.mark && <MenuEntry label={t("Mark as code repo")} onClick={() => fresh({ kind: "code-repo", path: k.path })} />}
                {acts.unmark && <MenuEntry label={t("Remove code repo mark")} onClick={() => fresh({ kind: "code-repo-off", path: k.path })} />}
                {acts.leaveOut && (
                  <>
                    <MenuSeparator />
                    <MenuEntry label={mode === "creation" ? t("Leave out (don't upload)") : t("Leave out")} danger onClick={() => fresh({ kind: "leaveOut", path: k.path })} />
                  </>
                )}
              </Menu>
            </span>
          )}
        </div>
        {hasChildren && on && (children.get(k.path) ?? []).map((c, j) => row(c, depth + 1, j))}
        {hasChildren && on && unloaded(k) && (
          <div className="py-1 text-[11.5px] text-dim" style={{ paddingLeft: 6 + (depth + 1) * 16 + 22 }}>
            {levels?.loading.has(startOf(k)) ? t("Loading…") : t("Not loaded")}
          </div>
        )}
      </div>
    );
  };

  const rootTarget = over === "";
  return (
    <div className="flex min-h-0 flex-col gap-2" data-layout>
      {/* `flat` (the "Layout" tab of the project view): no hairlines, like the instances (ProjectForm.tsx). */}
      <div className={flat ? "cb-scroll min-h-0 flex-1 overflow-auto" : "cb-kit-pane min-h-0 flex-1 overflow-auto rounded-2xl p-1.5"}>
        <div
          onDragOver={(e) => { if (mayAfter(pulled.current, "")) { e.preventDefault(); setOver(""); } }}
          onDragLeave={() => setOver((u) => (u === "" ? null : u))}
          onDrop={(e) => { e.preventDefault(); letFallen(""); }}
          className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1 ${rootTarget ? "bg-accent/15 ring-1 ring-accent/50" : ""}`}
        >
          <KindIcon k={{ path: "", kind: "folder" }} />
          <span className="truncate text-[12.5px] font-semibold">{rootName || t("Project root")}</span>
          <span className="text-[11px] text-dim">{t("Project root")}</span>
        </div>
        {(children.get("") ?? []).map((k, i) => row(k, 1, i))}
        {finalTree.length === 0 && <div className="px-3 py-2 text-[12px] text-dim">{emptyText ?? t("Nothing chosen yet — an empty project.")}</div>}
      </div>

      {freeError.length > 0 && (
        <Hint tone="danger">
          {freeError.slice(0, 6).map((f, i) => <div key={i}>{noticeText(f, t, limitRepos)}</div>)}
          {freeError.length > 6 && <div>{t("… and {n} more", { n: freeError.length - 6 })}</div>}
        </Hint>
      )}

      {steps.length > 0 && (
        <div className={flat ? "flex flex-col gap-0.5 pt-2" : "cb-kit-pane divide-y divide-edge rounded-2xl"} data-layout-changes>
          <div className={`flex items-center justify-between ${flat ? "px-2 pb-0.5" : "px-3 py-1.5"}`}>
            <span className="text-[11.5px] font-semibold text-dim">{t("Changes ({n})", { n: steps.length })}</span>
            {!onlyView && <button type="button" onClick={() => onSteps([])} className={ghostSm}>{t("Undo all")}</button>}
          </div>
          {steps.map((s, i) => (
            <div key={i} className={`flex items-center gap-2 text-[12px] ${flat ? "rounded-lg px-2 py-1.5 transition-colors hover:bg-hover" : "px-3 py-1.5"}`}>
              <span className={`min-w-0 flex-1 truncate ${stepError.has(i) ? "text-danger" : ""}`}>{stepText(s, t)}</span>
              {!onlyView && <button type="button" onClick={() => onSteps(steps.filter((_, j) => j !== i))} className={ghostSm}>{t("Undo")}</button>}
            </div>
          ))}
        </div>
      )}

      {/* The target choice sits in the tree instead of a second modal: Escape would otherwise close the create dialog below as well. */}
      {move && (
        <div className={flat ? "pt-2" : "cb-kit-pane rounded-2xl p-2"} data-layout-target-choice>
          <div className="px-2.5 pb-1.5 text-[11.5px] font-semibold text-dim">{t("Move “{path}” to:", { path: move.path })}</div>
          <div className="max-h-[30vh] overflow-auto">
            {targetsOf(move).map((z) => (
              <button
                key={z || "/"}
                type="button"
                onClick={() => { fresh({ kind: "move", from: move.path, to: connect(z, nameOf(move.path)) }); setMove(null); }}
                className={`${menuRow} text-[12.5px]`}
              >
                <span className="min-w-0 flex-1 truncate">{z ? z : `${rootName || t("Project root")} (${t("root")})`}</span>
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex justify-end">
            <button type="button" onClick={() => setMove(null)} className={ghostSm}>{t("Cancel")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
