"use client";

// The "Layout" page of an existing project in the "Projects" tab.
//
// On the left the tree (ProjectLayout.tsx in mode `inventory`): it comes level by level from the server (`GET …/layout?path=`, read
// in the project container), every action becomes a step — the same computation as in creation. On the right check and adopt
// (LayoutTakeOver.tsx). An open job shows its steps in the tree, view only; so does a project with an open setup, an open copy,
// one being relocated, or one whose root is itself a code repo — the reason shows on the right.
//
// The tree here is only what is loaded: rules that need the WHOLE tree (two equal targets in a folder never opened, more than 25
// code repos) are computed by the server's check. So that a move into a folder shows at once whether something of the same name is
// already there, the page loads every target directory — and for every step whose source (or target folder) lies in a not yet loaded
// level, the levels leading there (otherwise a waiting job would show up as "does not fit (any more)" on return). While such a
// level loads, the step does not count as an error; a level whose load failed is retried only on an explicit action (unfold,
// "Reload") or after the event `project/instance` (ready). After the cutover the tree in the project is already rebuilt — the page
// then shows it as it is, without the steps on top. The draft (the steps) survives leaving the page (module memory per project),
// not reloading the window.
//
// The page is the "Layout" tab in the project view (ProjectView.tsx) — `embedded`: no own header and back path, tree and sections
// without a surface (`flat` on the tree), in the form of the instances (ProjectForm.tsx): no hairlines, both columns as a section
// with a tile — "Folder" (the tree) and "Adopt" (check and adopt).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeGlobalEvents } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { BackButton, Hint, Loading, ghostSm } from "@/components/CbKit";
import { type Node, type NodeKind, type Plan, type Rules, type Step, parentOf, computePlan } from "@/lib/project-layout";
import { ProjectLayout } from "@/components/projects/ProjectLayout";
import { LayoutTakeOver, type Situation, jobOpen, useLayoutJob } from "@/components/projects/LayoutTakeOver";
import { SectionHeader, S } from "@/components/projects/ProjectForm";

interface Entry {
  name: string;
  kind: "file" | "folder" | "code-repo" | "worktree";
  isRepo?: boolean;
  worktreeOf?: string;
  gitFile?: boolean;
  reference?: boolean;
  special?: boolean;
}
interface Level extends Situation {
  path: string;
  entries: Entry[];
  truncated?: { cap: number; total: number };
}

const connect = (a: string, b: string) => (a ? `${a}/${b}` : b);

const NO: Step[] = [];

/** The draft per project — survives "Open in the Code tab", "Back" and switching tabs. */
const drafts = new Map<string, Step[]>();

/** Which levels are missing so the steps can be computed: for each step with STEP_UNKNOWN/STEP_INVALID the deepest existing ancestor of
 *  its source (or target folder) in the state BEFORE the step — if its level is not loaded, it is loaded, and the step (with all later
 *  ones) is "open" instead of wrong. */
function missingLevels(node: Node[], steps: Step[], rules: Rules, plan: Plan, loaded: Set<string>, failed: Set<string>) {
  const load = new Set<string>();
  let first = Infinity;
  for (const f of plan.error) {
    if (f.step === undefined || (f.code !== "STEP_UNKNOWN" && f.code !== "STEP_INVALID")) continue;
    const s = steps[f.step];
    if (!s) continue;
    const q = f.code === "STEP_UNKNOWN" ? (s.kind === "move" ? s.from : s.path) : s.kind === "move" ? `${parentOf(s.to)}/_` : "";
    if (!q || q.startsWith("/")) continue;
    const before = computePlan(node, steps.slice(0, f.step), rules, "inventory").finalTree;
    for (let a = parentOf(q); ; a = parentOf(a)) {
      if (!a) break; // the root is loaded: the path really is missing
      const k = before.find((x) => x.path === a);
      if (!k) continue;
      const start = k.origin ?? k.path;
      if (k.kind !== "file" && !loaded.has(start) && !failed.has(start)) { load.add(start); first = Math.min(first, f.step); }
      break;
    }
  }
  return { load, first };
}
export function LayoutPage({
  project, rules, onBack, onRepoOpen, embedded = false,
}: {
  project: { id: string; name: string };
  rules: Rules | null;
  /** The way back in its own header — only without `embedded`. */
  onBack?: () => void;
  /** In a view that shows the way back and project name itself: no own header, the tree without a surface. */
  embedded?: boolean;
  /** "Open in the Code tab" on a block — the path relative to the project root. */
  onRepoOpen?: (path: string) => void;
}) {
  const t = useT();
  const jobState = useLayoutJob(project.id);
  const { job } = jobState;
  const [node, setNode] = useState<Node[]>([]);
  const [info, setInfo] = useState<Map<string, Entry>>(() => new Map());
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [truncated, setTruncated] = useState<Record<string, { cap: number; total: number }>>({});
  const [situation, setSituation] = useState<Situation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [steps, setStepsRaw] = useState<Step[]>(() => drafts.get(project.id) ?? []);
  const setSteps = useCallback((s: Step[]) => {
    if (s.length) drafts.set(project.id, s); else drafts.delete(project.id);
    setStepsRaw(s);
  }, [project.id]);
  // Every new generation (reload after adopting) discards the answers of the old one.
  const generation = useRef(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const load = useCallback(async (start: string) => {
    if (loadedRef.current.has(start) || loadingRef.current.has(start)) return;
    const gen = generation.current;
    setLoading((s) => new Set(s).add(start));
    try {
      const r = await api<Level>(`/api/projects/${project.id}/layout?path=${encodeURIComponent(start)}`);
      if (gen !== generation.current) return;
      const fresh: Node[] = r.entries.map((e) => {
        const path = connect(start, e.name);
        return { path, kind: e.kind as NodeKind, origin: path };
      });
      setNode((k) => [...k.filter((x) => parentOf(x.path) !== start || !fresh.some((n) => n.path === x.path)), ...fresh]);
      setInfo((m) => { const n = new Map(m); for (const e of r.entries) n.set(connect(start, e.name), e); return n; });
      setLoaded((s) => new Set(s).add(start));
      if (r.truncated) setTruncated((g) => ({ ...g, [start]: r.truncated! }));
      setSituation({ rootIsRepo: r.rootIsRepo, copyOpen: r.copyOpen, locked: r.locked });
      setFailed((s) => { if (!s.has(start)) return s; const n = new Set(s); n.delete(start); return n.size ? n : new Set(); });
      setLoadError(null);
    } catch (e) {
      if (gen === generation.current) {
        setLoadError(String((e as Error).message || e));
        setFailed((s) => new Set(s).add(start));
      }
    } finally {
      if (gen === generation.current) setLoading((s) => { const n = new Set(s); n.delete(start); return n; });
    }
  }, [project.id]);

  const loadAgain = useCallback(() => {
    generation.current += 1;
    setNode([]);
    setInfo(new Map());
    setLoaded(new Set());
    setLoading(new Set());
    setTruncated({});
    setFailed(new Set());
    setLoadError(null);
    loadedRef.current = new Set();
    loadingRef.current = new Set();
    void load("");
  }, [load]);
  useEffect(() => { loadAgain(); }, [loadAgain]);

  // An open job shows ITS steps (view only); one that failed before the cutover hands them back for editing.
  // After the cutover the tree in the project is already (partly) rebuilt: the steps would no longer fit it — the tree then
  // shows as it is and is reread with every step of the job.
  const open = jobOpen(job);
  const rebuilt = open && Boolean(job?.turned);
  const displayed = open && job ? (rebuilt ? NO : job.steps) : steps;
  const rebuildStatus = rebuilt && job ? `${job.state}:${job.step}` : "";
  useEffect(() => { if (rebuildStatus) loadAgain(); }, [rebuildStatus, loadAgain]);

  // Project container ready again: retry what could not be loaded.
  const again = useRef<() => void>(() => {});
  again.current = () => { if (!loadedRef.current.has("")) loadAgain(); else setFailed(new Set()); };
  useEffect(() => subscribeGlobalEvents((evt) => {
    if (evt.type === "project/instance" && String(evt.projectId ?? "") === project.id && evt.state === "ready") again.current();
  }), [project.id]);

  const raw = useMemo(() => (rules ? computePlan(node, displayed, rules, "inventory") : null), [node, displayed, rules]);
  const missing = useMemo(
    () => (raw && rules ? missingLevels(node, displayed, rules, raw, loaded, failed) : { load: new Set<string>(), first: Infinity }),
    [raw, node, displayed, rules, loaded, failed],
  );
  // Steps from the first one whose level is still loading count as open — their errors would show only briefly.
  const plan = useMemo(
    () => (raw && missing.first < Infinity ? { ...raw, error: raw.error.filter((f) => f.step === undefined || f.step < missing.first) } : raw),
    [raw, missing.first],
  );

  // Load levels on demand (see header): targets of a move — via the START PATH of the target folder — and the levels of the sources.
  useEffect(() => {
    if (!raw) return;
    const starts = new Set(missing.load);
    for (const s of displayed) {
      if (s.kind !== "move") continue;
      const target = parentOf(s.to);
      if (!target) continue;
      const k = raw.finalTree.find((x) => x.path === target && x.kind === "folder");
      const start = k?.origin ?? k?.path;
      if (start !== undefined) starts.add(start);
    }
    for (const start of starts) if (!loaded.has(start) && !loading.has(start) && !failed.has(start)) void load(start);
  }, [displayed, raw, missing.load, loaded, loading, failed, load]);
  const levelsOpen = missing.load.size > 0;

  const onlyView = open || Boolean(situation?.locked) || !rules;
  // Unfolding is an explicit action: a failed level may retry.
  const loadExplicit = useCallback((start: string) => {
    setFailed((s) => { if (!s.has(start)) return s; const n = new Set(s); n.delete(start); return n; });
    void load(start);
  }, [load]);
  const sourceMarker = useCallback((k: Node) => {
    const e = info.get(k.origin ?? k.path);
    if (!e) return null;
    if (e.kind === "worktree" && e.worktreeOf) return t("of {repo}", { repo: e.worktreeOf === "." ? t("Project root") : e.worktreeOf });
    if (e.gitFile) return t(".git file");
    if (e.reference) return t("Symlink");
    if (e.special) return t("Special file");
    return null;
  }, [info, t]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" data-layout-page={project.id}>
      {!embedded && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
          {onBack && <BackButton label={t("Projects")} onClick={onBack} />}
          <h3 className="min-w-0 truncate text-[14px] font-semibold tracking-tight">{t("Outline · {name}", { name: project.name })}</h3>
        </div>
      )}
      {loadError && <Hint tone="danger">{loadError}</Hint>}
      {Object.entries(truncated).map(([p, g]) => (
        <Hint key={p} tone="warn">{t("“{path}” has {total} entries — the first {cap} are shown.", { path: p || "/", total: g.total, cap: g.cap })}</Hint>
      ))}
      {!loaded.has("") ? (
        loadError ? (
          <div className="flex justify-start">
            <button type="button" onClick={loadAgain} className={ghostSm} data-layout-new-load>{t("Reload")}</button>
          </div>
        ) : <Loading />
      ) : plan ? (
        <div className={`grid min-h-0 flex-1 grid-cols-1 ${embedded ? "gap-6 @6xl/kit:grid-cols-2" : "gap-3 @5xl/kit:grid-cols-2"}`}>
          <Column embedded={embedded} symbol={S.layout(15)} title={t("Folder")} data="tree">
            <ProjectLayout
              rootName={project.name}
              plan={plan}
              steps={displayed}
              onSteps={setSteps}
              mode="inventory"
              onlyView={onlyView}
              limitRepos={rules?.limits.repos}
              sourceMarker={sourceMarker}
              levels={{ loaded, loading, load: loadExplicit }}
              onRepoOpen={onRepoOpen ? (k) => onRepoOpen(k.origin ?? k.path) : undefined}
              emptyText={t("The project is empty.")}
              flat={embedded}
            />
          </Column>
          <div className="cb-scroll min-h-0 overflow-y-auto">
            <Column embedded={embedded} symbol={S.check(15)} title={t("Adopt")} data="takeOver">
              <LayoutTakeOver
                projectId={project.id}
                steps={steps}
                planError={open ? 0 : plan.error.length + (levelsOpen ? 1 : 0)}
                situation={situation}
                jobState={jobState}
                onSteps={setSteps}
                onFinishedSeen={loadAgain}
              />
            </Column>
          </div>
        </div>
      ) : (
        <Hint tone="warn">{t("The server's rules have not loaded yet — try again in a moment.")}</Hint>
      )}
    </div>
  );
}

/** One column of the page: embedded (tab of the project view) a section with a tile, otherwise just the content. */
function Column({ embedded, symbol, title, data, children }: {
  embedded: boolean;
  symbol: React.ReactNode;
  title: string;
  data: string;
  children: React.ReactNode;
}) {
  if (!embedded) return <div className="flex min-h-0 flex-col">{children}</div>;
  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-2.5" data-layout-column={data}>
      <SectionHeader symbol={symbol} title={title} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
