"use client";

// The big git overview: Coding → Projects → Project → Git. Only for a converted project with at least one repo (ProjectsPane
// `gitTab`). Read-only — the existing git actions stay where they are.
//
// HEADER: repo choice (only with more than one repo; without a choice the server takes the first; a jump "All branches →" preselects
// it, lib/project-jump.ts `takeProjectGitTarget` — not remembered: a remembered repo that no longer exists would leave the page on
// an error), the window as kit `Segments` (7 d · 30 d · All, remembered per browser), the kit `Search` (sent debounced as `search`
// to the SERVER — it searches before the cap), a toggle per group (kit `FilterChip` with a count) and per instance "Remote state
// N min ago" with ⟳ (`auto: false`). Below it list + detail in the kit `SplitPane` (`listWide`: the timeline fills the width, from
// `@5xl/kit` the detail is the right column, below it slides over the timeline with ‹).
//
// FRESHNESS (like the "Instances" tab): every 5 s while the page is mounted AND the document visible, and with `fresh=1` after the
// events `project/instance`/`project/copy` of this project and after every fetch that ran. At most ONE request at a time
// (lib/retrieval-airlock.ts); an answer to an older choice (repo, search) is dropped — its follow-up comes. The view reads only
// ready instances and never wakes one (the server; an unread one is shown with its reason above the list).
//
// FETCH ON OPEN: as soon as a repo's first answer is there, ONE `fetch` with `auto: true` goes out for main and every read (= ready)
// copy — the server holds the throttle (5 min per repo and instance) and otherwise answers `skipped`. Once per repo and instance
// per mount. A failed auto fetch stays silent at its instance (text in the title), no notice.
//
// EMPTY IS NOT UNKNOWN: before the first answer "loading…", after an error the error; `rows: null` means "not read"; the cap says
// it is one ("400 of 1,873 — search narrows"). If NO instance is read (`noRead`), the server sends `rows: []` — that too means "not
// read", with the reasons per instance, never "No branches." and never groups with 0.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { retrievalAirlock, type Airlock } from "@/lib/retrieval-airlock";
import {
  GIT_VIEW_WINDOW_DEFAULT, GIT_VIEW_GROUPS, errorFields, gitViewFetch, fetchGitView, subscribeGlobalEvents,
  type GitView as View, type GitViewInstance, type GitViewRow, type GitWindow, type GitGroup,
} from "@/lib/api";
import { windowFrom } from "@/lib/git-view-time";
import { PROJECT_JUMP_EVENT, takeProjectGitTarget } from "@/lib/project-jump";
import { dateLocale, useT } from "@/lib/i18n";
import { FilterChip, Hint, Loading, EmptySentence, Menu, MenuEntry, Placeholder, Segments, SplitPane, Search } from "@/components/CbKit";
import { Timeline, keyColor, rowKey } from "@/components/projects/git/Timeline";
import { GitViewDetail } from "@/components/projects/git/GitViewDetail";
import { reasonWord, groupWord, instanceWord, beforeWord, type GitLocation, type Translator } from "@/components/projects/git/GitWords";

const TICK_MS = 5000;
const SEARCH_MS = 300;
const WINDOW_KEY = "cbase-git-view-window";
// Every storage access in try/catch: without it (private window, blocked) the default applies for this session.
const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* without storage it stays for this session */ } };
const countText = (n: number) => n.toLocaleString(dateLocale());

type Request = { repo: string | null; search: string };

/** "Remote state 3 min ago ⟳" of an instance — not read: the reason instead of the time. */
function RemoteState({ i, now, busy, error, t, onFetch }: {
  i: GitViewInstance; now: number; busy: boolean; error: string | null; t: Translator; onFetch: () => void;
}) {
  const who = instanceWord(i.name, t);
  const state = !i.read ? t("not read: {reason}", { reason: reasonWord(i.reason, t) })
    : i.remoteState?.at != null ? t("Remote state {when}", { when: beforeWord(i.remoteState.at, now, t) ?? "—" })
    : i.remoteState ? t("Remote state unknown") : t("Remote state not provided");
  return (
    <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[11.5px] text-dim" data-git-instance={i.name} data-git-remote-state={i.remoteState?.at ?? ""}>
      {i.color !== null && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: keyColor(i.color) }} aria-hidden />}
      <span className="min-w-0 truncate" title={error ? t("Fetch failed: {reason}", { reason: error }) : undefined}>
        {who} · {state}{error && <span className="text-warn"> !</span>}
      </span>
      {i.read && (
        <button type="button" onClick={onFetch} disabled={busy} title={t("Fetch remote now")} aria-label={t("Fetch remote now")}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-50" data-git-fetch={i.name}>
          {busy ? <span className="text-[10px]">…</span> : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          )}
        </button>
      )}
    </span>
  );
}

export function GitView({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // A waiting jump ("All branches →" with a repo) preselects; otherwise the server chooses. The jump may also bring a search
  // (the branch of a timeline event, lib/project-jump.ts).
  const [start] = useState(() => takeProjectGitTarget(projectId));
  const [repo, setRepo] = useState<string | null>(start?.repo ?? null);
  const [timeWindow, setWindow] = useState<GitWindow>(() => windowFrom(read(WINDOW_KEY)) ?? GIT_VIEW_WINDOW_DEFAULT);
  const [input, setInput] = useState(start?.search ?? "");
  const [search, setSearch] = useState(start?.search ?? "");
  const [from, setFrom] = useState<ReadonlySet<GitGroup>>(new Set());
  const [choice, setChoice] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [fetchBusy, setFetchBusy] = useState<ReadonlySet<string>>(new Set());
  const [fetchError, setFetchError] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  // Loading through the airlock (like InstancesPage): ONE request at a time; `load()` (cause) remembers a follow-up, `load(false)`
  // (tick) does not; `load(true, true)` asks every ready instance fresh. Repo and search via refs — the tick is not rebuilt on
  // every choice, and an answer to an older choice is dropped.
  const requestRef = useRef<Request>({ repo, search });
  requestRef.current = { repo, search };
  const freshRef = useRef(false);
  const airlock = useRef<Airlock | null>(null);
  const load = useCallback((afterRun = true, fresh = false) => {
    if (fresh) freshRef.current = true;
    airlock.current?.nudge(afterRun);
  }, []);

  useEffect(() => {
    const fetch = async () => {
      const fresh = freshRef.current;
      freshRef.current = false;
      const request = { ...requestRef.current };
      return { request, a: await fetchGitView(projectId, { repo: request.repo, search: request.search, fresh }) };
    };
    const s = retrievalAirlock(fetch, {
      ok: ({ request, a }) => {
        const current = requestRef.current;
        if (request.repo !== current.repo || request.search !== current.search) return; // an older choice — the follow-up brings the new one
        setView(a);
        setLoadError("");
        setNow(Date.now());
      },
      // Even without ever having a state: the error is shown, not "loading…" (empty is not unknown).
      error: (e) => setLoadError(errorFields(e).text),
    });
    airlock.current = s;
    load();
    const tick = setInterval(() => { if (document.visibilityState === "visible") load(false); }, TICK_MS);
    const visible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", visible);
    const off = subscribeGlobalEvents((evt) => {
      const type = String(evt.type ?? "");
      if ((type === "project/instance" || type === "project/copy") && String(evt.projectId ?? "") === projectId) load(true, true);
    });
    return () => {
      s.end();
      if (airlock.current === s) airlock.current = null;
      clearInterval(tick);
      document.removeEventListener("visibilitychange", visible);
      off();
    };
  }, [load, projectId]);

  // The search goes to the server debounced; every new choice (repo, search) loads at once.
  useEffect(() => {
    const h = setTimeout(() => setSearch(input.trim()), SEARCH_MS);
    return () => clearTimeout(h);
  }, [input]);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    load();
  }, [repo, search, load]);

  // A jump while the page already stands (the event comes after mount): choose the repo.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ projectId?: unknown }>).detail?.projectId !== projectId) return;
      const z = takeProjectGitTarget(projectId);
      if (z?.repo !== undefined) setRepo(z.repo);
      if (z?.search !== undefined) { setInput(z.search); setSearch(z.search); }
    };
    window.addEventListener(PROJECT_JUMP_EVENT, on);
    return () => window.removeEventListener(PROJECT_JUMP_EVENT, on);
  }, [projectId]);

  // fetch per instance. `auto` on open (throttle in the server), the ⟳ button without. If it ran (not `skipped`) a fresh read follows.
  const fetchRemote = useCallback(async (rel: string, instance: string, auto: boolean) => {
    setFetchBusy((s) => new Set(s).add(instance));
    if (!auto) setNotice("");
    try {
      const r = await gitViewFetch(projectId, { repo: rel, instance, auto });
      setFetchError((f) => { const { [instance]: _dropped, ...rest } = f; return rest; });
      if (!r.skipped) load(true, true);
    } catch (e) {
      const text = errorFields(e).text;
      setFetchError((f) => ({ ...f, [instance]: text }));
      if (!auto) setNotice(t("Fetch in {instance} failed: {reason}", { instance: instanceWord(instance, t), reason: text }));
    } finally {
      setFetchBusy((s) => { const n = new Set(s); n.delete(instance); return n; });
    }
  }, [load, projectId, t]);
  const autoFetched = useRef(new Set<string>());
  useEffect(() => {
    const rel = view?.repo?.rel;
    if (rel === undefined || !view?.instances) return;
    for (const i of view.instances) {
      const k = `${rel}\u0000${i.name}`;
      if (!i.read || autoFetched.current.has(k)) continue;
      autoFetched.current.add(k);
      void fetchRemote(rel, i.name, true);
    }
  }, [view, fetchRemote]);

  const selectRepo = (rel: string) => {
    if (rel === (repo ?? view?.repo?.rel)) return;
    setRepo(rel);
    setChoice(null);
    setDetailOpen(false);
  };
  const selectWindow = (k: string) => {
    const f = windowFrom(k);
    if (!f) return;
    setWindow(f);
    write(WINDOW_KEY, f);
  };
  const toggle = (g: GitGroup) => setFrom((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });

  // No instance read (all stopped, starting, error): the server's empty list says nothing about branches.
  const noRead = Boolean(view?.instances && !view.instances.some((i) => i.read));
  const rows = noRead ? null : view?.rows ?? null;
  const counts = useMemo(() => {
    const m = new Map<GitGroup, number>();
    for (const z of rows ?? []) m.set(z.group, (m.get(z.group) ?? 0) + 1);
    return m;
  }, [rows]);
  const selected: GitViewRow | null = choice && rows ? rows.find((z) => rowKey(z) === choice) ?? null : null;
  const location: GitLocation = { workspaceId, projectId };
  const repos = view?.repos ?? [];
  const unread = (view?.instances ?? []).filter((i) => !i.read);
  const colorOf = (name: string) => view?.instances?.find((i) => i.name === name)?.color ?? null;

  const detail = (z: GitViewRow) => (
    <GitViewDetail
      key={rowKey(z)}
      projectId={projectId}
      repo={view?.repo?.rel ?? repo ?? ""}
      row={z}
      mainBranch={view?.mainBranch?.name ?? null}
      color={colorOf(z.instance)}
      location={location}
      now={now}
      t={t}
      onBack={() => setDetailOpen(false)}
    />
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-git-view={projectId}>
      <div className="flex shrink-0 flex-col gap-2 pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {repos.length > 1 && (
            <Menu
              label={t("Choose repository: {name}", { name: view?.repo?.name ?? "—" })}
              alignment="left"
              width={260}
              button={{
                content: (open) => (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate font-mono">{view?.repo?.name ?? t("Choose repository")}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}><path d="M6 9l6 6 6-6" /></svg>
                  </span>
                ),
                className: "flex h-7 max-w-[16rem] min-w-0 items-center rounded-full bg-bg px-3 text-[12.5px] font-medium transition-colors hover:bg-hover",
                data: { "data-git-repo-choice": view?.repo?.rel ?? "" },
              }}
            >
              {repos.map((r) => (
                <MenuEntry key={r.rel} label={r.name} selected={r.rel === view?.repo?.rel} onClick={() => selectRepo(r.rel)} data={{ "data-git-repo": r.rel }} />
              ))}
            </Menu>
          )}
          <Segments
            label={t("Time window")}
            value={timeWindow}
            onChange={selectWindow}
            items={[
              { key: "7d", label: t("7 d"), data: { "data-git-window": "7d" } },
              { key: "30d", label: t("30 d"), data: { "data-git-window": "30d" } },
              { key: "everything", label: t("All##everything"), data: { "data-git-window": "everything" } },
            ]}
          />
          <Search value={input} onChange={setInput} placeholder={t("Search branches…")} className="min-w-[10rem] flex-1 @3xl/kit:max-w-[18rem]" />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          {GIT_VIEW_GROUPS.map((g) => (
            <FilterChip key={g} label={groupWord(g, t)} n={rows ? (counts.get(g) ?? 0) : null} active={!from.has(g)} onClick={() => toggle(g)}
              title={from.has(g) ? t("Show {group}", { group: groupWord(g, t) }) : t("Hide {group}", { group: groupWord(g, t) })} />
          ))}
          <span className="flex-1" />
          {(view?.instances ?? []).map((i) => (
            <RemoteState key={i.name} i={i} now={now} busy={fetchBusy.has(i.name)} error={fetchError[i.name] ?? null} t={t}
              onFetch={() => { const rel = view?.repo?.rel; if (rel !== undefined) void fetchRemote(rel, i.name, false); }} />
          ))}
        </div>
      </div>

      {notice && (
        <div className="mb-2 shrink-0" data-git-view-notice>
          <Hint tone="danger">{notice}</Hint>
        </div>
      )}
      {view && (view.clipped || unread.length > 0 || loadError) && (
        <div className="mb-2 flex shrink-0 flex-col gap-1.5" data-git-view-hints>
          {view.clipped && (
            <Hint tone="warn">
              <span data-git-view-clipped={view.clipped.total}>
                {t("{shown} of {total} — search narrows it down", { shown: countText(view.clipped.shown), total: countText(view.clipped.total) })}
              </span>
            </Hint>
          )}
          {unread.length > 0 && (
            <Hint tone="warn">
              <span data-git-view-unread={unread.map((i) => i.name).join(" ")}>
                {unread.map((i) => t("{instance} not read: {reason}", { instance: instanceWord(i.name, t), reason: reasonWord(i.reason, t) })).join(" · ")}
              </span>
            </Hint>
          )}
          {loadError && <Hint tone="warn">{t("Reload failed ({reason}) — the state below is the last one read.", { reason: loadError })}</Hint>}
        </div>
      )}

      {!view ? (
        <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
          {loadError ? <Hint tone="danger">{t("The Git overview could not be loaded: {reason}", { reason: loadError })}</Hint> : <Loading />}
        </div>
      ) : !view.repo && repos.length === 0 ? (
        <div className="cb-scroll min-h-0 flex-1 overflow-y-auto"><EmptySentence title={t("No Git repository was found in the project.")} /></div>
      ) : rows === null ? (
        <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
          <Hint tone="warn">{t("The branches have not been read.")}</Hint>
        </div>
      ) : rows.length === 0 ? (
        <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
          <EmptySentence title={search ? t("No branch matches “{search}”.", { search: search }) : t("No branches.")} />
        </div>
      ) : (
        <SplitPane
          listWide
          list={
            <Timeline view={view} rows={rows} window={timeWindow} from={from} now={now} choice={selected ? choice : null} location={location} t={t}
              onSelect={(z) => { setChoice(rowKey(z)); setDetailOpen(true); }} />
          }
          detail={detailOpen && selected ? detail(selected) : null}
          placeholder={selected ? detail(selected) : <Placeholder title={t("Choose a branch")}>{t("The detail shows commits, files, the MR and who uses the branch.")}</Placeholder>}
        />
      )}
    </section>
  );
}
