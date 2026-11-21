"use client";

// The "Instances" tab of a project. Only for a relocated project (ProjectView `instances`).
//
// LIST + DETAIL: no surface (`cb-kit-pane`), no divider lines — rows are rounded and light up under the pointer, the selected one
// carries the accent tint. On the left ONE row per instance (main on top, then the copies): tile with a house (main) or two boxes
// (copy), the icon in the color of its state; name, state (only if not ready), below it with small icons the branch (`*` = open
// changes, `+N` = more repos), containers "x/y" (yellow if one is stopped) and the public links; computed in `rowOf`
// (lib/instances-tree.ts, bound to iOS). On the right the detail of the SELECTED instance: header with tile, state, base, RAM · CPU,
// "Created by", start chat · code · terminal with their icons and the ⋯ menu (kit `Menu`: `cb-pop` on the body, click catcher via
// document mousedown), below it the sections Containers · Services · Repos · Chats stacked (repos and services without an
// assignment), each with a tile of its icon (the same language as the Coding rail), the container section with a bar strip (one
// stroke per container). Below the split threshold (kit `SplitPane`, `@5xl/kit`) the detail replaces the list, with a back button.
// The choice is remembered per project (`cbase-instances-choice:<pid>`, every access in try/catch); with no choice, or after the
// chosen copy is deleted, main applies.
//
// The computation "what the tree shows" lives in lib/instances-tree.ts (the contract between web and iOS, twin of
// mobile/CbaseMobile/Code/InstancesTree.swift): `readTree` (allowlist — a part without `loaded` is NEVER an empty list), `openParam`,
// `situationOf`, `partSituation`, `actionsOf`, `serviceAction`, `workingChats`, `rowOf`. Only loading, showing and acting live here.
//
// FRESHNESS: every 5 s while the page is mounted AND the document is visible, and at once after the events `project/instance`,
// `project/copy` (of this project) and `preview/*`. The server reads containers and repos for EVERY ready instance, cached up to
// 30 s (projectbox/instances-tree.js "SUMMARY") — the selected one goes along as `?open=` and is fresh on every tick; after an event of
// this project and after every own action the page asks with `fresh=1` (all reread). At most ONE fetch runs (lib/retrieval-airlock.ts):
// every answer counts; an event or action in the meantime yields exactly one follow-up, the tick nothing; a `fresh` from the
// meantime goes out with the follow-up (`freshRef`).
//
// EMPTY IS NOT UNKNOWN: before the first answer "loading…", after an error the error — never "no instances"; a part the server could
// not read shows its error, never "no containers"; a row without read containers shows no number instead of "0/0".
//
// The service row: start/stop as in the services pill (`?instance=<identifier>`, simple start), with `startable: false` "Enter start
// command" (leads to the services page; also in main), plus `PreviewButton`/`PreviewArea` with `instance` = THIS instance of the tree
// (never the forwarding one of the pill). An existing link shows address, expiry, copy, revoke; re-assigning does not exist. The
// source of the link is the TREE (`d.link`, renewed on the tick; the state of `usePreviewLinks` only adds, see lib/preview-links.ts
// `linkInTree`), and a stopped instance (`linkStopped`) shows it with the neutral dot and "Instance stopped". "Create copy" works only
// with a tree read (without it there would be neither base nor free name). "Restart stack" is always in the ⋯ menu, after a branch
// switch additionally on the "Repos" section.
//
// PROGRESS OF A COPY: a copy that is waiting or being built carries `progress` in the tree (step of six, stage of the start, share and
// remaining time estimated from the project's last finished copy — lib/instances-tree.ts, bound to iOS). The row shows in its facts the
// step ("Step 3 of 6 · Second clone") with "about 4 min left" and below it the thin bar, the detail header the same sentence instead of
// the raw phase, below it bar and — on overrun — "taking longer than last time" (form and words: projects/CopyProgress.tsx, the same as
// in the "Active runs" pill). The tab polls every 5 s anyway and after every `project/copy`.
//
// JUMP FROM OUTSIDE (lib/project-jump.ts): "Create copy …" on a chat's instance choice opens the dialog here with the chat's
// instance as the base (once the tree is read), a copy in the pill selects that copy.
import { useCallback, useEffect, useRef, useState } from "react";
import { retrievalAirlock, type Airlock } from "@/lib/retrieval-airlock";
import { showNewChat } from "@/lib/chat-draft";
import {
  api, abortInstanceStart, errorFields, fetchCopy, loadInstancesTree, startInstance, restartStack, stopInstance, subscribeGlobalEvents,
  type WorkingChat,
} from "@/lib/api";
import {
  MAIN, actionsOf, workingChats, serviceAction, progressDetail, copyName, situationOf, readTree, linkStopped, openParam, partSituation, rowOf,
  type Tree, type TreeAction, type TreeService, type TreeInstance, type Reason, type Situation, type Part,
} from "@/lib/instances-tree";
import { CopyProgressBar, OverrunHint, restSet, stepSet } from "@/components/projects/CopyProgress";
import { fmtBytes } from "@/lib/services-status";
import { linkInTree } from "@/lib/preview-links";
import { showInstanceInCode } from "@/lib/code-show";
import { PROJECT_JUMP_EVENT, takeInstancesTarget, type InstancesTarget } from "@/lib/project-jump";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { usePreviewLinks } from "@/components/preview/usePreviewLinks";
import { PreviewArea, PreviewButton } from "@/components/preview/PreviewShare";
import {
  Hint, Loading, Menu, MenuEntry, MenuSeparator, Point, Spinner, SplitBackButton, SplitPane, Word, RowsArrow, ghostSm, primary, quietDangerSm,
} from "@/components/CbKit";
import { Section, SELECTED, Tile, S, ROW, ROW_INSIDE, instanceColor, textOf } from "@/components/projects/ProjectForm";
import { BranchSwitch, ChatList, CopyCreate, CopyDelete, instanceTitle } from "@/components/projects/InstanceDialogs";

type Translator = ReturnType<typeof useT>;
const TICK_MS = 5000;

// The icons and the row and section form live in ProjectForm.tsx — the other project pages share the same language.
const rememberKey = (pid: string) => `cbase-instances-choice:${pid}`;
const readChoice = (pid: string): string => {
  try {
    const w = localStorage.getItem(rememberKey(pid));
    return w && w.trim() ? w : MAIN;
  } catch { return MAIN; }
};
const writeChoice = (pid: string, name: string) => {
  try { localStorage.setItem(rememberKey(pid), name); } catch { /* without storage it stays for this session */ }
};

/** The state as a word. */
function situationWord(situation: Situation, i: TreeInstance, t: Translator): string {
  switch (situation) {
    case "ready": return t("ready");
    case "starts": return t("starting");
    case "stops": return t("stopping");
    case "stopped": return t("stopped");
    case "waiting": return i.waiting?.reason === "storage" ? t("waiting for memory") : t("waiting in line");
    case "build": return t("being created");
    case "clearAway": return t("being removed");
    case "error": return t("Error");
    default: return t("unknown");
  }
}

/** The color of the state word — the same language as the dot: yellow waits, red is broken, everything else muted. */
const situationTone = (situation: Situation) => (situation === "error" ? "text-danger" : situation === "waiting" || situation === "clearAway" ? "text-warn" : "text-dim");

/** Why an action is unavailable — the sheet's key as a sentence. */
function reasonText(g: Reason | null, t: Translator): string | undefined {
  switch (g) {
    case "not-ready": return t("The instance is not ready right now.");
    case "not-stopped": return t("Starting only works from “stopped”.");
    case "start-waiting": return t("The start is already waiting for memory.");
    case "main": return t("Main cannot be deleted.");
    case "gets-cleared-away": return t("The copy is being torn down.");
    case "no-repos": return t("No code repos in this instance.");
    case "repos-closed": return t("The repos have not been read yet.");
    default: return undefined;
  }
}

export function InstancesPage({ projectId, projectName, workspaceId, onTab, onCode }: {
  projectId: string;
  projectName: string;
  workspaceId: string;
  /** "Enter start command": to the services page of the same view. */
  onTab: (r: "services") => void;
  /** "Code"/"Terminal": into the project's Code tab (the instance is then already fixed via lib/code-show.ts). */
  onCode: () => void;
}) {
  const t = useT();
  const question = useConfirm();
  const [tree, setTree] = useState<Tree | null>(null);
  const [loadError, setLoadError] = useState("");
  const [choice, setChoice] = useState<string>(() => readChoice(projectId));
  // Below the split threshold: is the detail (instead of the list) open? Above it both show, and the detail always shows the choice.
  const [detailOpen, setDetailOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "danger"; text: string; chats?: WorkingChat[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "create"; base: string }
    | { kind: "erase"; name: string }
    | { kind: "branch"; instance: string; rel: string }
    | null
  >(null);
  // After a branch switch the "Repos" section of this instance offers "Restart stack" — until the page is mounted again.
  const [afterSwitch, setAfterSwitch] = useState<Set<string>>(new Set());
  const { status: preview, takeOver: previewTakeOver } = usePreviewLinks(true);
  const [shareOpen, setShareOpen] = useState<string | null>(null);

  // Loading through the airlock (lib/retrieval-airlock.ts): ONE fetch at a time, every answer counts; `load()` (cause: event, action,
  // choice) remembers exactly one follow-up while a fetch runs, `load(false)` (the tick) does not. `load(true, true)` additionally
  // demands all instances fresh (`freshRef`, consumed by the next fetch — also by the follow-up). One airlock per project: on a
  // change or unmount the old one is ended, its late answer discarded. Choice and last tree are read through refs so the tick is
  // not rebuilt on every choice.
  const choiceRef = useRef(choice);
  choiceRef.current = choice;
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const freshRef = useRef(false);
  const airlock = useRef<Airlock | null>(null);
  const load = useCallback((afterRun = true, fresh = false) => {
    if (fresh) freshRef.current = true;
    airlock.current?.nudge(afterRun);
  }, []);

  useEffect(() => {
    const fetch = () => {
      const fresh = freshRef.current;
      freshRef.current = false;
      return loadInstancesTree(projectId, openParam([choiceRef.current], treeRef.current), fresh);
    };
    const s = retrievalAirlock(fetch, {
      ok: (raw) => {
        const b = readTree(raw);
        if (!b) { setLoadError(t("The server's answer is not a tree.")); return; }
        treeRef.current = b; // a follow-up right after already asks with this tree (openParam)
        setTree(b);
        setLoadError("");
      },
      // Even without ever having a state: the error shows, not "loading…" (empty is not unknown).
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
      else if (type.startsWith("preview/")) load();
    });
    return () => {
      s.end();
      if (airlock.current === s) airlock.current = null;
      clearInterval(tick);
      document.removeEventListener("visibilitychange", visible);
      off();
    };
  }, [load, projectId, t]);

  const select = (name: string) => {
    setDetailOpen(true);
    if (name === choiceRef.current) return;
    choiceRef.current = name;
    setChoice(name);
    writeChoice(projectId, name);
    setShareOpen(null);
    load(); // the details of the one just chosen at once (if a fetch is already running: exactly one follow-up)
  };

  // A jump from outside (lib/project-jump.ts): "Create copy …" on a chat's instance choice opens the dialog with the chat's instance
  // as the base, a copy in the "Active runs" pill selects that copy. Picked up on mount and on the event (the tab is already
  // there); the dialog waits for the first tree — before that it knows neither ready bases nor taken names.
  const [target, setTarget] = useState<InstancesTarget | null>(null);
  useEffect(() => {
    const fetch = () => { const z = takeInstancesTarget(projectId); if (z) setTarget(z); };
    fetch();
    const on = (e: Event) => { if ((e as CustomEvent<{ projectId?: unknown }>).detail?.projectId === projectId) fetch(); };
    window.addEventListener(PROJECT_JUMP_EVENT, on);
    return () => window.removeEventListener(PROJECT_JUMP_EVENT, on);
  }, [projectId]);
  useEffect(() => {
    if (!target) return;
    if (target.createFrom !== undefined && !tree) return;
    setTarget(null);
    if (target.instance) select(target.instance);
    if (target.createFrom !== undefined) setDialog({ kind: "create", base: target.createFrom });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, tree]);

  // An action with feedback: errors (with the chats of a working lock) on top as a notice, then reload at once and fresh.
  const handle = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const ok = await fn();
      if (ok) setNotice({ tone: "ok", text: ok });
    } catch (e) {
      const f = errorFields(e);
      setNotice({ tone: "danger", text: f.text, ...(f.code === "INSTANCE_WORKING" && f.chats?.length ? { chats: f.chats } : {}) });
    } finally {
      setBusy(null);
      load(true, true);
    }
  };

  // The confirmation for stopping and starting names the instance's chats (stopping main hits all chats of the project).
  const chatSentence = (i: TreeInstance) => {
    if (!i.chats.length) return t("No chat is working in this instance.");
    const run = workingChats(i);
    const names = i.chats.map((c) => `„${c.title || t("New chat")}“${c.running ? ` (${t("running")})` : ""}`).join(", ");
    return run.length
      ? t("Working in it: {names}. While a chat is running, the server refuses.", { names: names })
      : t("Working in it: {names}.", { names: names });
  };
  const stop = async (i: TreeInstance) => {
    const title = instanceTitle(i.name, t);
    const yes = await question(`${t("Stop {instance}? The containers shut down, the memory is freed, the data stays. The next turn of a chat starts it again.", { instance: title })} ${chatSentence(i)}`,
      { ok: t("Stop"), danger: true, title: t("Stop {instance}", { instance: title }) });
    if (yes) await handle(`stop:${i.name}`, async () => { await stopInstance(projectId, i.name); return null; });
  };
  const start = async (i: TreeInstance) => {
    const title = instanceTitle(i.name, t);
    const yes = await question(`${t("Start {instance}? The containers come back up — if memory is full, the start waits until it frees up.", { instance: title })} ${chatSentence(i)}`,
      { ok: t("Start"), title: t("Start {instance}", { instance: title }) });
    if (yes) {
      await handle(`start:${i.name}`, async () => {
        const r = await startInstance(projectId, i.name);
        return r.kind === "waiting" ? t("{instance} is waiting for memory and starts on its own as soon as it is free.", { instance: title }) : null;
      });
    }
  };
  const abortStart = (i: TreeInstance) => handle(`cancel:${i.name}`, async () => { await abortInstanceStart(projectId, i.name); return null; });
  // "Start chat" opens a DRAFT in this instance: it is created on the first send, with project and instance from the job
  // (chat/chatDraft.ts) — otherwise every click without a message would leave an empty chat behind.
  const startChat = (i: TreeInstance) => handle(`chat:${i.name}`, async () => {
    showNewChat({ workspaceId, projectId, instance: i.name });
    return null;
  });
  const fetch = (i: TreeInstance, name: string) => handle(`fetch:${i.name}`, async () => {
    await fetchCopy(projectId, name);
    return t("Fetched — the copy's commits are in main under copy/{name}/….", { name });
  });
  // 202 — the restart runs in the server; its state and result sit on the instance (`action`).
  const stackNew = (i: TreeInstance) => handle(`restart:${i.name}`, async () => {
    await restartStack(projectId, i.name);
    setAfterSwitch((m) => { const x = new Set(m); x.delete(i.name); return x; });
    return t("The stack is restarting — the result will show on the instance.");
  });
  const code = (i: TreeInstance, terminal: boolean) => {
    showInstanceInCode(projectId, i.name === MAIN ? null : i.identifier, { terminal });
    onCode();
  };
  const service = (i: TreeInstance, d: TreeService, kind: "start" | "stop") => handle(`service:${i.name}#${d.id}`, async () => {
    const path = `/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(d.id)}/${kind === "start" ? "start" : "stop"}?instance=${encodeURIComponent(i.identifier)}`;
    const r = await api<unknown>(path, { method: "POST", body: JSON.stringify(kind === "start" ? { mode: "simple" } : {}) });
    // The stop answers 200 with `stopped: false` and the reason when it could not stop safely.
    const s = (r ?? {}) as { stopped?: unknown; error?: unknown };
    if (kind === "stop" && s.stopped === false) throw new Error(typeof s.error === "string" && s.error ? s.error : t("{name} could not be safely stopped — something may still be running on the port.", { name: d.name }));
    return null;
  });

  // The selected instance; if it is gone (a deleted copy), the first applies — main.
  const selected = tree ? (tree.instances.find((i) => i.name === choice) ?? tree.instances[0] ?? null) : null;

  const detail = (i: TreeInstance) => (
    <InstanceDetail
      key={i.name}
      i={i}
      t={t}
      busy={busy}
      afterSwitch={afterSwitch.has(i.name)}
      onBack={() => setDetailOpen(false)}
      onChat={() => void startChat(i)}
      onCode={() => code(i, false)}
      onTerminal={() => code(i, true)}
      onStartAbort={() => void abortStart(i)}
      menu={
        <InstanceMenu
          i={i}
          t={t}
          onStop={() => void stop(i)}
          onStart={() => void start(i)}
          onStartAbort={() => void abortStart(i)}
          onStackNew={() => void stackNew(i)}
          onCopy={() => setDialog({ kind: "create", base: i.name })}
          onFetch={() => { const k = copyName(i.name); if (k) void fetch(i, k); }}
          onDelete={() => { const k = copyName(i.name); if (k) setDialog({ kind: "erase", name: k }); }}
        />
      }
      onBranch={(rel) => setDialog({ kind: "branch", instance: i.name, rel })}
      onStackNew={() => void stackNew(i)}
      onService={(d, kind) => void service(i, d, kind)}
      onStartCommand={() => onTab("services")}
      onChatOpen={(id) => window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: id }))}
      preview={(d) => {
        const serviceId = Number(d.id);
        if (!tree || !Number.isFinite(serviceId)) return null;
        // The link from the TREE (renewed on the tick); the links state only adds (lib/preview-links.ts linkImTree).
        const link = linkInTree(d.link, tree.asOf, preview, { projectId, instance: i.name, serviceId, serviceName: d.name, port: d.port });
        const key = `${i.name}#${d.id}`;
        return {
          button: <PreviewButton state={preview} port={d.port} link={link} open={shareOpen === key} onToggle={() => setShareOpen((v) => (v === key ? null : key))} />,
          area: (
            <PreviewArea
              state={preview}
              projectId={projectId}
              instance={i.name}
              serviceId={serviceId}
              link={link}
              instanceStopped={linkStopped(i)}
              open={shareOpen === key}
              onClose={() => setShareOpen((v) => (v === key ? null : v))}
              takeOver={previewTakeOver}
              onNotice={(text) => setNotice(text ? { tone: "danger", text } : null)}
            />
          ),
        };
      }}
    />
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-instances-page={projectId}>
      <div className="flex shrink-0 flex-wrap items-center gap-3 pb-4">
        <p className="min-w-0 flex-1 text-[13px] tabular-nums text-dim" data-instances-summary>
          {tree ? summary(tree, t) : " "}
        </p>
        {/* Only with a tree read — before that the dialog knows neither ready bases nor taken names. */}
        <button type="button" className={primary} disabled={!tree} title={tree ? undefined : t("Only once the instances have been read.")}
          onClick={() => setDialog({ kind: "create", base: MAIN })} data-instance-copy-create>
          {t("Create copy")}
        </button>
      </div>
      {notice && (
        <div className="mb-3 flex shrink-0 items-start gap-2" data-instance-notice={notice.tone}>
          <div className="min-w-0 flex-1">
            <Hint tone={notice.tone}>
              {notice.text}
              {notice.chats && <ChatList chats={notice.chats} t={t} />}
            </Hint>
          </div>
          <button type="button" className={ghostSm} onClick={() => setNotice(null)}>{t("Dismiss##hide")}</button>
        </div>
      )}
      {!tree || !selected ? (
        <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
          {loadError
            ? <Hint tone="danger">{t("The instances could not be loaded: {reason}", { reason: loadError })}</Hint>
            : <Loading />}
        </div>
      ) : (
        <>
          {loadError && <div className="mb-3 shrink-0"><Hint tone="warn">{t("Reload failed ({reason}) — the state below is the last one read.", { reason: loadError })}</Hint></div>}
          <SplitPane
            list={
              <div className="flex flex-col gap-0.5" data-instances-list>
                {tree.instances.map((i) => (
                  <InstanceRow key={i.name} i={i} active={i.name === selected.name} t={t} onSelect={() => select(i.name)} />
                ))}
              </div>
            }
            detail={detailOpen ? detail(selected) : null}
            placeholder={detail(selected)}
          />
        </>
      )}
      {dialog?.kind === "create" && (
        <CopyCreate
          projectId={projectId}
          tree={tree}
          preselection={dialog.base}
          onClose={() => setDialog(null)}
          onCreated={(name) => {
            setNotice({ tone: "ok", text: t("Copy {name} is being created — its state is shown in the list.", { name }) });
            // Show the new copy at once: its build is what one looks at now.
            const fresh = `copy-${name}`;
            choiceRef.current = fresh;
            setChoice(fresh);
            writeChoice(projectId, fresh);
            load(true, true);
          }}
        />
      )}
      {dialog?.kind === "erase" && (
        <CopyDelete
          projectId={projectId}
          projectName={projectName}
          name={dialog.name}
          onClose={() => setDialog(null)}
          onDeleted={() => { setNotice({ tone: "ok", text: t("Copy {name} is being deleted — everything is saved in main under copy/{name}/….", { name: dialog.name }) }); load(true, true); }}
        />
      )}
      {dialog?.kind === "branch" && (
        <BranchSwitch
          projectId={projectId}
          instance={dialog.instance}
          rel={dialog.rel}
          onClose={() => { setDialog(null); load(true, true); }}
          onSwitched={() => setAfterSwitch((m) => new Set(m).add(dialog.instance))}
        />
      )}
    </section>
  );
}

/** The line above the list: how many instances, how many of them ready, how many public links. */
function summary(tree: Tree, t: Translator): string {
  const n = tree.instances.length;
  const ready = tree.instances.filter((i) => situationOf(i) === "ready").length;
  const links = tree.instances.reduce((s, i) => s + rowOf(i).links.length, 0);
  const parts = [
    n === 1 ? t("1 instance") : t("{n} instances", { n }),
    t("{n} ready", { n: ready }),
    ...(links ? [links === 1 ? t("1 public link") : t("{n} public links", { n: links })] : []),
  ];
  return parts.join(" · ");
}

/** The small step icon in the facts line (12 px like the others): a circle with a two-thirds arc. */
const StepIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="8.5" opacity="0.35" />
    <path d="M12 3.5a8.5 8.5 0 0 1 7.4 12.7" />
  </svg>
);

/** The tile of an instance: house (main) or two offset boxes (copy), the icon in the color of the state — the same language as
 *  the dot (`instanceColor`: green ready, accent in transition, yellow waiting, red error, muted stopped). */
function InstanceTile({ i, large = false, t }: { i: TreeInstance; large?: boolean; t: Translator }) {
  const situation = situationOf(i);
  const color = situation === "waiting" ? "text-warn" : situation === "stopped" || situation === "unknown" ? "text-dim" : textOf(instanceColor(i.state));
  return (
    <Tile color={color} large={large} title={situationWord(situation, i, t)} data={{ "data-instance-tile": situation }}>
      {i.name === MAIN ? S.main(large ? 19 : 16) : S.copy(large ? 19 : 16)}
    </Tile>
  );
}

function InstanceRow({ i, active, t, onSelect }: { i: TreeInstance; active: boolean; t: Translator; onSelect: () => void }) {
  const situation = situationOf(i);
  const z = rowOf(i);
  const facts: React.ReactNode[] = [];
  if (z.branch) {
    const b = z.branch;
    facts.push(
      <span key="branch" className="flex min-w-0 items-center gap-1" data-row-branch
        title={[b.detached ? t("detached · {id}", { id: b.name }) : b.name, b.changed ? t("uncommitted changes") : "", b.additional > 0 ? t("{n} more repos", { n: b.additional }) : ""].filter(Boolean).join(" · ")}>
        <span className="shrink-0 opacity-80">{S.repos(12)}</span>
        <span className="truncate font-mono text-[12px]">{b.detached ? `@${b.name}` : b.name || "—"}</span>
        {b.changed && <span className="font-mono text-warn">*</span>}
        {b.additional > 0 && <span className="shrink-0">+{b.additional}</span>}
      </span>,
    );
  }
  if (z.stack) {
    const s = z.stack;
    facts.push(
      <span key="stack" className={`flex shrink-0 items-center gap-1 tabular-nums ${s.run < s.total ? "text-warn" : ""}`} data-row-stack
        title={s.down.length ? t("down: {names}", { names: s.down.join(", ") }) : undefined}>
        <span className="opacity-80">{S.container(12)}</span>
        {s.total ? `${s.run}/${s.total}` : t("no containers")}
      </span>,
    );
  }
  for (const l of z.links) {
    facts.push(
      <span key={`link:${l.service}`} className={`flex min-w-0 shrink items-center gap-1 ${l.stopped ? "text-dim line-through decoration-dim/60" : "text-accent"}`} data-row-link
        title={l.stopped ? t("Public link to {service} — instance stopped", { service: l.service }) : t("Public link to {service}", { service: l.service })}>
        <span className="shrink-0">{S.link(12)}</span>
        <span className="truncate">{l.service}</span>
      </span>,
    );
  }
  if (i.base && i.name !== MAIN) facts.push(<span key="base" className="shrink-0">{t("from {base}", { base: instanceTitle(i.base, t) })}</span>);
  // A copy being built: the step (waiting is already said by the state word) with remaining time first in the facts, the bar below.
  const detail = i.name === MAIN ? null : progressDetail(i.progress, i.state);
  if (detail) {
    const step = stepSet(detail, t);
    const rest = restSet(detail, t);
    if (step || rest) {
      facts.unshift(
        <span key="progress" className="flex min-w-0 items-center gap-1 tabular-nums" data-row-progress={detail.kind}>
          <span className="shrink-0 opacity-80"><StepIcon /></span>
          <span className="truncate">{[step, rest].filter(Boolean).join(" · ")}</span>
        </span>,
      );
    }
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      data-active={active ? "1" : undefined}
      data-instance={i.name}
      data-instance-situation={situation}
      className={`group flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors ${active ? SELECTED : "hover:bg-hover"}`}
    >
      <InstanceTile i={i} t={t} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[14px] font-medium tracking-[-0.01em]">{instanceTitle(i.name, t)}</span>
          {situation !== "ready" && <span className={`shrink-0 text-[12px] ${situationTone(situation)}`} data-instance-word>{situationWord(situation, i, t)}</span>}
        </span>
        {facts.length > 0 && <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-dim">{facts}</span>}
        {detail && (
          <span className="mt-1.5 flex min-w-0 flex-col gap-1 text-[11.5px]">
            <CopyProgressBar a={detail} className="max-w-[280px]" />
            <OverrunHint a={detail} t={t} />
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center @5xl/kit:hidden"><RowsArrow /></span>
    </button>
  );
}

function InstanceMenu({ i, t, onStop, onStart, onStartAbort, onStackNew, onCopy, onFetch, onDelete }: {
  i: TreeInstance;
  t: Translator;
  onStop: () => void;
  onStart: () => void;
  onStartAbort: () => void;
  onStackNew: () => void;
  onCopy: () => void;
  onFetch: () => void;
  onDelete: () => void;
}) {
  const a = actionsOf(i);
  const copy = i.name !== MAIN;
  const ready = situationOf(i) === "ready";
  return (
    <Menu label={t("Actions for {instance}", { instance: instanceTitle(i.name, t) })} width={252}>
      {a.abortStart.on ? (
        <MenuEntry label={t("Cancel start")} onClick={onStartAbort} data={{ "data-instance-action": "start-abort" }} />
      ) : i.state === "stopped" ? (
        <MenuEntry label={t("Start")} disabled={!a.start.on} hint={a.start.on ? undefined : reasonText(a.start.reason, t)} onClick={onStart} data={{ "data-instance-action": "start" }} />
      ) : (
        <MenuEntry label={t("Stop")} disabled={!a.stop.on} hint={a.stop.on ? undefined : reasonText(a.stop.reason, t)} onClick={onStop} data={{ "data-instance-action": "stop" }} />
      )}
      <MenuEntry label={t("Restart stack")} disabled={!ready} hint={ready ? t("Rebuild and restart this instance’s compose stacks") : reasonText("not-ready", t)} onClick={onStackNew} data={{ "data-instance-action": "stack-new" }} />
      <MenuSeparator />
      <MenuEntry label={t("Copy from this instance")} disabled={!a.asBase.on} hint={a.asBase.on ? undefined : reasonText(a.asBase.reason, t)} onClick={onCopy} data={{ "data-instance-action": "copy" }} />
      {copy && (
        <>
          <MenuEntry label={t("Fetch changes into main")} disabled={!ready} hint={ready ? t("The copy's commits into main under copy/{name}/…", { name: copyName(i.name) ?? "" }) : reasonText("not-ready", t)} onClick={onFetch} data={{ "data-instance-action": "fetch" }} />
          <MenuSeparator />
          <MenuEntry label={t("Delete …")} danger disabled={!a.erase.on} hint={a.erase.on ? undefined : reasonText(a.erase.reason, t)} onClick={onDelete} data={{ "data-instance-action": "erase" }} />
        </>
      )}
    </Menu>
  );
}

/** A part (containers, repos) as a state: "loading…", the error or "none" — the caller renders the list. The detail always asks for its
 *  instance with `?open=`: a part not read is therefore on its way, never "none". */
function PartState<T>({ part, empty, t }: { part: Part<T>; empty: string; t: Translator }) {
  const situation = partSituation(part);
  if (situation === "closed" || situation === "loading") return <p className="py-1.5 text-[12px] text-dim">{t("Loading…##inline")}</p>;
  if (situation === "error") return <p className="py-1.5 text-[12px] text-danger" data-part-error>{part.error || t("unreadable")}</p>;
  if (situation === "empty") return <p className="py-1.5 text-[12px] text-dim">{empty}</p>;
  return part.error ? <p className="pb-1 text-[12px] text-danger" data-part-error>{part.error}</p> : null;
}

/** The containers as a strip: one stroke per container, green runs, muted stands — the stack's state at a glance. From 24 on a "+N". */
function StackBar({ run, total }: { run: number; total: number }) {
  const show = Math.min(total, 24);
  const green = Math.min(run, show);
  return (
    <span className="flex items-center gap-[3px]" aria-hidden data-stack-bar={`${run}/${total}`}>
      {Array.from({ length: show }, (_, n) => (
        <span key={n} className={`h-3 w-[5px] rounded-full ${n < green ? "bg-ok" : "bg-dim/35"}`} />
      ))}
      {total > show && <span className="pl-0.5 text-[11px]">+{total - show}</span>}
    </span>
  );
}

// The running (or last failed) action of the human on the instance — a stack restart keeps running in the server for up to 30 min, a
// failed branch switch names its reason. A successful, finished branch switch/discard does not show (the repos show its result), a
// successful stack restart once with its stacks.
function ActionRow({ action, t }: { action: TreeAction; t: Translator }) {
  const what = action.kind === "stack-restart" ? t("Stack restart") : action.kind === "branch" ? t("Branch switch") : action.kind === "dismiss" ? t("Discarding files") : action.kind;
  if (!action.running && action.ok && action.kind !== "stack-restart") return null;
  return (
    <div data-instance-action={action.running ? "running" : action.ok ? "ok" : "error"}>
      {action.running ? (
        <p className="flex items-center gap-2 text-[13px] text-dim"><Spinner /> {t("{what} running …", { what })}</p>
      ) : (
        <Hint tone={action.ok ? "ok" : "danger"}>
          {action.ok ? t("{what} done.", { what }) : t("{what} failed: {reason}", { what, reason: action.error || "?" })}
        </Hint>
      )}
      {action.stacks && action.stacks.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px]">
          {action.stacks.map((s) => (
            <li key={s.project} className={s.ok ? "text-dim" : "text-danger"}>{s.ok ? t("{project}: restarted", { project: s.project }) : t("{project}: {error}", { project: s.project, error: s.error || "?" })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InstanceDetail({ i, t, busy, afterSwitch, menu, onBack, onChat, onCode, onTerminal, onStartAbort, onBranch, onStackNew, onService, onStartCommand, onChatOpen, preview }: {
  i: TreeInstance;
  t: Translator;
  busy: string | null;
  afterSwitch: boolean;
  menu: React.ReactNode;
  onBack: () => void;
  onChat: () => void;
  onCode: () => void;
  onTerminal: () => void;
  onStartAbort: () => void;
  onBranch: (rel: string) => void;
  onStackNew: () => void;
  onService: (d: TreeService, kind: "start" | "stop") => void;
  onStartCommand: () => void;
  onChatOpen: (id: string) => void;
  preview: (d: TreeService) => { button: React.ReactNode; area: React.ReactNode } | null;
}) {
  const situation = situationOf(i);
  const a = actionsOf(i);
  const z = rowOf(i);
  // A copy being built: the step in words instead of the raw phase, below it bar, remaining time and the hint on overrun.
  const detail = i.name === MAIN ? null : progressDetail(i.progress, i.state);
  const step = detail ? stepSet(detail, t) : null;
  const rest = detail ? restSet(detail, t) : null;
  const counts = i.cpu !== null || i.memBytes !== null
    ? `${i.memBytes !== null ? fmtBytes(i.memBytes) : "—"} · ${i.cpu !== null ? `${i.cpu} %` : "—"}`
    : null;
  // What is stopped, first: a failed container is what one looks for in the list.
  const container = partSituation(i.container) === "list" ? [...i.container.list].sort((x, y) => Number(x.running) - Number(y.running)) : [];
  const serviceRun = i.services.filter((d) => d.running).length;
  const buttonEl = (kind: "chat" | "code" | "terminal", sym: React.ReactNode, label: string, on: boolean, reason: Reason | null, onClick: () => void) => (
    <button type="button" className={`${ghostSm} inline-flex items-center gap-1.5`} disabled={!on || busy !== null} title={on ? undefined : reasonText(reason, t)} onClick={onClick} data-instance-button={kind}>
      {sym}{label}
    </button>
  );
  return (
    <div className="flex min-w-0 flex-col gap-8 pb-10 pr-2 @5xl/kit:pl-2" data-instance-details={i.name}>
      <SplitBackButton label={t("Instances")} onClick={onBack} />

      <div className="flex min-w-0 flex-col gap-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <InstanceTile i={i} large t={t} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[16px] font-semibold leading-6 tracking-[-0.01em]">{instanceTitle(i.name, t)}</h3>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px] text-dim">
              <span className={situation === "ready" ? "" : situationTone(situation)} data-instance-word>
                {situationWord(situation, i, t)}{step ? ` · ${step}` : !detail && i.phase && situation !== "ready" && situation !== "stopped" ? ` · ${i.phase}` : ""}
              </span>
              {i.base && i.name !== MAIN && <span>{t("Base: {base}", { base: instanceTitle(i.base, t) })}</span>}
              {counts && <span className="tabular-nums" title={t("RAM · CPU")} data-instance-counts>{counts}</span>}
              {i.createdOf && (
                <span className="min-w-0 truncate" data-instance-created-of={i.createdOf.chatId}>
                  {t("Created by chat {title}", { title: `„${i.createdOf.title ?? t("(deleted)")}“` })}
                </span>
              )}
            </div>
          </div>
          {menu}
        </div>
        {detail && (
          <div className="flex max-w-[420px] flex-col gap-1 pl-[52px] text-[12px] text-dim" data-instance-progress={detail.kind}>
            <CopyProgressBar a={detail} />
            {(rest || detail.overrun) && (
              <span className="flex flex-wrap gap-x-3 tabular-nums">
                {rest && <span>{rest}</span>}
                <OverrunHint a={detail} t={t} />
              </span>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 pl-[52px]">
          {buttonEl("chat", S.chats(13), t("Start chat"), a.chat.on, a.chat.reason, onChat)}
          {buttonEl("code", S.code(13), t("Code"), a.code.on, a.code.reason, onCode)}
          {buttonEl("terminal", S.terminal(13), t("Terminal"), a.terminal.on, a.terminal.reason, onTerminal)}
          {a.abortStart.on && (
            <button type="button" className={quietDangerSm} disabled={busy !== null} onClick={onStartAbort} data-instance-start-abort>
              {t("Cancel start")}
            </button>
          )}
        </div>
      </div>

      {(i.error || i.action) && (
        <div className="flex flex-col gap-2">
          {i.error && <Hint tone="danger">{i.error}</Hint>}
          {i.action && <ActionRow action={i.action} t={t} />}
        </div>
      )}

      <Section
        symbol={S.container(15)}
        title={t("container")}
        data={{ "data-instance-group": "container" }}
        right={z.stack && z.stack.total > 0 ? (
          <>
            <StackBar run={z.stack.run} total={z.stack.total} />
            <span className={`tabular-nums ${z.stack.run < z.stack.total ? "text-warn" : ""}`}>{t("{run} of {total} running", { run: z.stack.run, total: z.stack.total })}</span>
          </>
        ) : undefined}
      >
        <PartState part={i.container} empty={t("No containers in this instance.")} t={t} />
        {container.length > 0 && (
          <ul className="flex flex-col">
            {container.map((c) => (
              <li key={c.name} className={ROW} data-instance-container={c.name}>
                <Point color={c.running ? "bg-ok" : "bg-dim/40"} />
                <span className="min-w-0 truncate text-[13px]">{c.service || c.name}</span>
                {c.service && c.service !== c.name && <span className="hidden min-w-0 truncate font-mono text-[12px] text-dim @md/detail:inline" title={c.name}>{c.name}</span>}
                <span className={`ml-auto shrink-0 truncate text-[12px] ${c.running ? "text-dim" : "text-fg"}`} title={c.status}>{c.status || (c.running ? t("running") : t("off"))}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        symbol={S.services(15)}
        title={t("Services")}
        data={{ "data-instance-group": "services" }}
        right={i.services.length > 0 ? <span className="tabular-nums">{t("{run} of {total} running", { run: serviceRun, total: i.services.length })}</span> : undefined}
      >
        {i.services.length === 0 ? (
          <p className="py-1.5 text-[12px] text-dim">{t("No registered services.")}</p>
        ) : (
          <ul className="flex flex-col">
            {i.services.map((d) => {
              const kind = serviceAction(d, i);
              const v = preview(d);
              const key = `service:${i.name}#${d.id}`;
              return (
                <li key={d.id} className="-mx-2 rounded-lg px-2 py-2 transition-colors hover:bg-hover" data-instance-service={d.id}>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <Point color={d.running ? "bg-ok" : d.holdsStart ? "bg-warn" : "bg-dim/40"} />
                    <span className="min-w-0 truncate text-[13px]">{d.name || d.id}</span>
                    {d.port !== null && <span className="shrink-0 font-mono text-[12px] text-dim">:{d.port}</span>}
                    {d.holdsStart && !d.running && <span className="shrink-0 text-[12px] text-warn" title={t("Running, but not reachable on its port.")}>{t("blocks start")}</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      {v?.button}
                      {kind === "stop" && (
                        <button type="button" className={quietDangerSm} disabled={busy !== null} onClick={() => onService(d, "stop")} data-instance-service-action="stop">
                          {busy === key ? t("…") : t("Stop")}
                        </button>
                      )}
                      {kind === "start" && (
                        <button type="button" className={ghostSm} disabled={busy !== null} onClick={() => onService(d, "start")} data-instance-service-action="start">
                          {busy === key ? t("…") : t("Start")}
                        </button>
                      )}
                      {kind === "startCommand" && (
                        <button type="button" className={ghostSm} onClick={onStartCommand} title={t("The service has no start command — add one on the services page.")} data-instance-service-action="startCommand">
                          {t("Add start command")}
                        </button>
                      )}
                    </span>
                  </div>
                  {v?.area}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        symbol={S.repos(15)}
        title={t("Repos")}
        data={{ "data-instance-group": "repos" }}
        right={afterSwitch ? (
          <button type="button" className={ghostSm} disabled={busy !== null} onClick={onStackNew} data-instance-stack-new>
            {busy === `restart:${i.name}` ? t("Restarting …") : t("Restart stack")}
          </button>
        ) : undefined}
      >
        <PartState part={i.repos} empty={t("No code repos in this instance.")} t={t} />
        {partSituation(i.repos) === "list" && (
          <ul className="flex flex-col">
            {i.repos.list.map((r) => (
              <li key={r.rel} className={ROW} data-instance-repo={r.rel}>
                <span className="min-w-0 shrink-0 truncate text-[13px]" title={r.rel}>{r.rel || t("Project folder")}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1 text-dim" title={r.branch}>
                  <span className="shrink-0 opacity-80">{S.repos(12)}</span>
                  <span className="truncate font-mono text-[12px]">{r.detached ? t("detached · {id}", { id: r.branch }) : r.branch || "—"}</span>
                </span>
                {r.open > 0 && <span className="shrink-0 text-[12px] text-warn">{t("{n} open", { n: r.open })}</span>}
                {r.error && <span className="shrink-0 text-[12px] text-danger" title={r.error}>!</span>}
                {a.branch.on && (
                  <button type="button" className={ghostSm} onClick={() => onBranch(r.rel)} data-instance-branch={r.rel}>{t("Branch …")}</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section symbol={S.chats(15)} title={t("Chats")} data={{ "data-instance-group": "chats" }}>
        {i.chats.length === 0 ? (
          <p className="py-1.5 text-[12px] text-dim">{t("No chat works in this instance.")}</p>
        ) : (
          <ul className="flex flex-col">
            {i.chats.map((c) => (
              <li key={c.id} className="-mx-2">
                <button type="button" onClick={() => onChatOpen(c.id)} className={`group w-full text-left ${ROW_INSIDE}`} data-instance-chat={c.id}>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{c.title || t("New chat")}</span>
                  {c.running && <Word loud>{t("running")}</Word>}
                  <RowsArrow />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
