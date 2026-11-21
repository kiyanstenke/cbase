"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Category, type Chat, type ContextItem, type Overview, type Workspace } from "@/lib/api";
import { AgentsTab } from "@/components/outerloop/AgentsTab";
import { OriginNames } from "@/components/Origin";
import { WorkflowsTab } from "@/components/workflow/WorkflowsTab";
import { ChatPane } from "@/components/chat/ChatPane";
import { ScheduledTab } from "@/components/scheduled/ScheduledTab";
import { CategoryBar, CategorySymbol } from "@/components/CategoryBar";
import { CodeArea } from "@/components/CodeArea";
import { TerminalsPane } from "@/components/TerminalsPane";
import { BrowserPane } from "@/components/BrowserPane";
import { ProjectContextPane } from "@/components/ProjectContextPane";
import { ProjectsPane, type OpenProject } from "@/components/projects/ProjectsPane";
import { asProjectTab, type ProjectTab } from "@/components/projects/ProjectView";
import { FolderDialog } from "@/components/FolderDialog";
import { VarsPane } from "@/components/VarsPane";
import { SkillsPane } from "@/components/SkillsPane";
import { useT, dateLocale } from "@/lib/i18n";
import { useEdgeClamp } from "@/lib/viewport";
import { textPx } from "@/lib/appearance";
import { useGateway } from "@/lib/gateway";
import { rememberWorkspace, setScopeProject } from "@/lib/active-scope";
import { PROJECT_JUMP_EVENT, JUMP_PARAMETER, isProjectSubitem, rememberProjectTarget, takeProjectTarget, projectFromAddress, type ProjectJump } from "@/lib/project-jump";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { TabFade } from "@/components/TabFade";
import { WorkspaceRail } from "@/components/WorkspaceRail";
import { SymbolRail } from "@/components/SymbolRail";
import { HeadersMiddle } from "@/components/HeadersMiddle";
import {
  Chevron, FACTS, Fact, SELECTED, Hint, Tile, LIST_ROW, EmptySentence, Menu, MenuEntry, MenuSeparator,
  Overline, RemoveButton, COLUMN, SYM, PagesHeader, Segments, Search, field, ghost, menuHeader, menuKeys, menuRow, popClassHeader, primary, select,
  type Tab,
} from "@/components/CbKit";

// Order, type and whitelist of the workspace tabs live in ONE place (lib/coding-tabs.ts). The "workflows" tab carries two kinds (graph ·
// dynamic); this page remembers the kind per workspace.
import {
  TAB_PARAMETER, codingTabKey, savedAgentKind, savedTab as savedTabOf, savedWorkflowKind, isCodingTab, tabOnLevel,
  tabFromAddress,
  type AgentKind, type CodingTab, type WorkflowKind,
} from "@/lib/coding-tabs";
import { McpServersPane } from "@/components/McpServersPane";
import { NEW_CHAT_EVENT } from "@/lib/chat-draft";
import { openCodingChat } from "@/lib/chat-jump";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { beginReading, reportWorkspaces } from "@/lib/buffer-coordinates";
import { DumpsterSendIcon, DumpsterSpinner } from "@/components/ContextKit";

export default function WorkspacesPage() {
  const t = useT();
  // Gateway mode (server operation): paths are the server's business, so show them nowhere.
  const gw = useGateway();
  const [list, setList] = useState<Workspace[]>([]);
  // "The list is settled" is a statement of its own: `list.length === 0` means "not there yet" before the first fetch, not "there
  // is none". The rail needs the difference (see the comment on `WorkspaceRail.loaded`).
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [ctxCategory, setCtxCategory] = useState<string | null>(null);
  const [ctxSearch, setCtxSearch] = useState("");
  const [ctxItems, setCtxItems] = useState<ContextItem[]>([]);
  const [dumpText, setDumpText] = useState("");
  const [dumpSource, setDumpSource] = useState("");
  const [dumpStatus, setDumpStatus] = useState<{ cls: string; text: string }>({ cls: "", text: "" });
  const [dumpBusy, setDumpBusy] = useState(false);
  const [dumpTarget, setDumpTarget] = useState("auto"); // "auto" | "workspace" | <projectId>
  const [dumpFiles, setDumpFiles] = useState<File[]>([]);
  const [dumpDragOver, setDumpDragOver] = useState(false);
  const [wsCtxSub, setWsCtxSub] = useState<"dumpster" | "memory">("memory"); // Sub-tab of the workspace context (as in the project)
  // The memory entry expanded in place (workspace level).
  const [ctxOpen, setCtxOpen] = useState<number | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [tab, setTab] = useState<CodingTab>("chats");
  // The code tab is mounted on first open and stays: unsaved tabs and a held copy survive the tab change. Only on first open, so a page
  // that never shows it loads neither list nor tree.
  const [codeVisited, setCodeVisited] = useState(false);
  if (tab === "code" && !codeVisited) setCodeVisited(true);
  // The kind in the "workflows" tab (graph · dynamic).
  const [wfKind, setWfKind] = useState<WorkflowKind>("graph");
  // The kind in the "agents" tab (subagents · outer loop).
  const [agentKind, setAgentsKind] = useState<AgentKind>("subagents");
  const [openProject, setOpenProject] = useState<OpenProject | null>(null);
  // The tab of the project view in the ENTERED project (coding tab "project"): the same view as under "Projects", its tab (services ·
  // layout · instances · git) remembered per workspace.
  const [projectTab, setProjectTab] = useState<ProjectTab>("services");
  // A jump to a sub-item of a project (lib/project-jump.ts): "Instances" from a chat's instance choice ("Create copy …") or from the
  // "Active runs" pill (a copy being created), "Git" via the address `?git=<p>`. It waits here until the overview of THIS workspace is
  // loaded (the project list names the project and says whether it still exists); the tab itself picks up the wish (choose copy, open
  // dialog, choose repo).
  const [projectJump, setProjectJump] = useState<ProjectJump | null>(null);
  // "Entered" a project: one level below the workspace. The breadcrumb then shows <Workspace> › <Project>, and the chat area is focused
  // on this project.
  const [enteredProject, setEnteredProject] = useState<{ id: string; name: string } | null>(null);
  const [projSwitchOpen, setProjSwitchOpen] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  // The project menu in the header: on narrow windows the correction pushes it back into view (via the translate property).
  const projSwitchRef = useEdgeClamp<HTMLDivElement>(projSwitchOpen);
  // Escape and a pointer press outside close the project menu; a click catcher over the page would no longer work: the content area is
  // a `@container`, and layout containment makes it the reference frame for `position: fixed` (see `Menu` in CbKit).
  useEffect(() => {
    if (!projSwitchOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setProjSwitchOpen(false); };
    const beside = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-kit-pop]")) setProjSwitchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", beside);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", beside); };
  }, [projSwitchOpen]);
  const [portConflicts, setPortConflicts] = useState<
    Record<string, { items: { port: number; name: string; owner: string }[] }>
  >({});
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The one-shot tab wish from `?tab=` (mount effect below), consumed by the first `open()`.
  const tabWish = useRef<CodingTab | null>(null);
  // The navigation of this page sits in TWO places outside the content (see the render below): the tabs as an icon rail on the left
  // (`SymbolRail`), Workspace › Project in the middle of the header (`HeadersMiddle`). The sidebar button of the workspace rail comes
  // from the shared `WorkspaceRail`. The state pills (services, agent browser, VS Code) are rendered by the TopNav itself on every page;
  // this page only supplies the scope (see `rememberWorkspace`/`setScopeProject` below) and no longer queries the services itself.

  // Tabs that fill the full height and scroll INSIDE (instead of letting the frame grow).
  const fullHeightPane =
    (tab === "context" && !!enteredProject) ||
    // The project view (tabs left, content right) scrolls in its content, the tabs stay put.
    (tab === "projects" && !!openProject) ||
    (tab === "project" && !!enteredProject) ||
    tab === "workflows" ||
    // Scheduled: list and detail scroll each on their own, the chat in the detail fills the height.
    tab === "scheduled";

  const activeWs = list.find((w) => w.id === activeId);
  const reloadChats = useCallback(async () => {
    if (activeId) setChats(await api<Chat[]>(`/api/chats?workspaceId=${encodeURIComponent(activeId)}`));
  }, [activeId]);

  const load = useCallback(async () => {
    const seq = beginReading(); // the number BEFORE the request: an older answer arriving after a younger one does not count
    const listItems = await api<Workspace[]>("/api/workspaces");
    setList(listItems);
    reportWorkspaces(listItems, seq); // the editors' coordinates (lib/buffer-coordinates.ts): which file belongs to which project
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch(console.error);
    // ?ws=… opens the workspace directly; otherwise restore the last open workspace (tab/project view per workspace is restored by
    // open() itself).
    const params = new URLSearchParams(window.location.search);
    // ?tab=<tab> (lib/coding-tabs.ts tabAddress, the /skills forward): remember the wish and remove it from the address; `open()`
    // applies it on the FIRST open, even if a workspace must be chosen first. Before any storage access, so it applies without
    // storage; known tabs only.
    const wantedTab = tabFromAddress(params);
    if (params.has(TAB_PARAMETER)) {
      tabWish.current = wantedTab;
      const u = new URL(window.location.href);
      u.searchParams.delete(TAB_PARAMETER);
      window.history.replaceState({}, "", u.toString());
    }
    const wanted = params.get("ws");
    let remembered: string | null = null;
    try { remembered = localStorage.getItem("cbase-ws"); } catch { /* without storage: no remembered workspace */ }
    const target = wanted || remembered;
    // ?chat=… (jump from the runs overview into another workspace) opens ChatPane itself; here only the remembered tab must yield to the chat.
    const wantedChat = params.get("chat");
    // ?<subitem>=<projectId>[&…] (lib/project-jump.ts projectAddress, e.g. `?instances=<p>[&instance=…][&create=…]` from the pill,
    // `?git=<p>[&repo=…]`, from another page or another workspace): remember the wish, switch the tab as soon as the overview stands;
    // the parameters leave the address again, otherwise every ⌘R would jump again.
    const wantedProject = projectFromAddress(params);
    if (wantedProject && target) {
      const { subitem, projectId, target: targetItem } = wantedProject;
      rememberProjectTarget(subitem, projectId, targetItem);
      setProjectJump({ workspaceId: target, projectId, subitem });
      const u = new URL(window.location.href);
      for (const k of JUMP_PARAMETER) u.searchParams.delete(k);
      window.history.replaceState({}, "", u.toString());
    }
    if (target) {
      open(target)
        .then(() => { if (wantedChat) setTab("chats"); })
        .catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Remember state for restoration (localStorage survives an app restart): last workspace globally, tab + open project view per
  // workspace. Workspace AND entered project go to the header's active scope in ONE step: `rememberWorkspace` forgets the project when
  // the workspace changes, so two separate effects would depend on their order in the source. "As soon as it is settled": `open()` sets
  // `activeId` at once, even for an unknown id from `?ws=`; it is reported only when the loaded list contains it (an effect of its own
  // here, because workspace and project must go in ONE step). Before that the scope is left untouched instead of briefly reporting the
  // old workspace with the new one's project.
  const scopeProject = enteredProject?.id ?? null;
  useEffect(() => {
    if (activeId && !list.some((w) => w.id === activeId)) return;
    if (activeId) rememberWorkspace(activeId);
    setScopeProject(activeId ? scopeProject : null);
  }, [activeId, scopeProject, list]);
  // When the page is left, the whole workspace applies again; otherwise the header on the other pages would keep filtering on a project
  // nobody sees there.
  useEffect(() => () => setScopeProject(null), []);
  useEffect(() => {
    if (!activeId) return;
    try { localStorage.setItem(codingTabKey(activeId), tab); } catch { /* without storage: not remembered */ }
  }, [tab, activeId]);
  // The kind in the "workflows" tab per workspace; a blocked storage is no statement about the page.
  useEffect(() => {
    if (!activeId) return;
    try { localStorage.setItem(`cbase-wf-kind:${activeId}`, wfKind); } catch {}
  }, [wfKind, activeId]);
  // Likewise the kind in the "agents" tab.
  useEffect(() => {
    if (!activeId) return;
    try { localStorage.setItem(`cbase-agents-kind:${activeId}`, agentKind); } catch {}
  }, [agentKind, activeId]);
  useEffect(() => {
    if (activeId) localStorage.setItem(`cbase-open-project:${activeId}`, JSON.stringify(openProject));
  }, [openProject, activeId]);
  useEffect(() => {
    if (!activeId) return;
    try { localStorage.setItem(`cbase-project-tab:${activeId}`, projectTab); } catch {}
  }, [projectTab, activeId]);
  useEffect(() => {
    if (activeId) localStorage.setItem(`cbase-entered-project:${activeId}`, JSON.stringify(enteredProject));
  }, [enteredProject, activeId]);
  // Close the open or entered project view when the project no longer exists (deleted externally, or a stale localStorage restore);
  // otherwise a ghost view stays.
  useEffect(() => {
    if (openProject && overview && overview.id === activeId && !overview.projects.some((p) => p.id === openProject.id)) {
      setOpenProject(null);
    }
  }, [overview, openProject, activeId]);
  useEffect(() => {
    if (enteredProject && overview && overview.id === activeId && !overview.projects.some((p) => p.id === enteredProject.id)) {
      setEnteredProject(null);
    }
  }, [overview, enteredProject, activeId]);
  // An externally requested chat open (runs overview in the header, bell, run history) must also switch the TAB: ChatPane would
  // otherwise open the chat invisibly behind the currently open tab. Likewise the draft from "Start chat" on an instance
  // (lib/chat-draft.ts).
  useEffect(() => {
    const toChats = () => setTab("chats");
    window.addEventListener("cbase-open-chat", toChats);
    window.addEventListener(NEW_CHAT_EVENT, toChats);
    return () => {
      window.removeEventListener("cbase-open-chat", toChats);
      window.removeEventListener(NEW_CHAT_EVENT, toChats);
    };
  }, []);
  // The jump to a sub-item of a project (lib/project-jump.ts showProject, `showInstances`, `showProjectGit`): the event creates it …
  useEffect(() => {
    const jump = (e: Event) => {
      const d = (e as CustomEvent<{ workspaceId?: unknown; projectId?: unknown; subitem?: unknown }>).detail;
      if (typeof d?.workspaceId === "string" && typeof d?.projectId === "string" && d.projectId && isProjectSubitem(d.subitem)) {
        setProjectJump({ workspaceId: d.workspaceId, projectId: d.projectId, subitem: d.subitem });
      }
    };
    window.addEventListener(PROJECT_JUMP_EVENT, jump);
    return () => window.removeEventListener(PROJECT_JUMP_EVENT, jump);
  }, []);
  // … and as soon as the overview of THIS workspace stands, it leads there: without an entered project "Projects" with the project on the
  // sub-item, in the entered project "Project" (another project is entered for this; "Projects" does not exist on this level). A foreign
  // workspace (the pill switches it via the address) or a project that no longer exists discards the jump along with the wish. Whether
  // the project has the sub-item is told by the project view (ProjectsPane: otherwise "Services").
  useEffect(() => {
    if (!projectJump || !activeId || !overview || overview.id !== activeId) return;
    const { workspaceId, projectId, subitem } = projectJump;
    setProjectJump(null);
    const p = workspaceId === activeId ? overview.projects.find((x) => x.id === projectId) : undefined;
    if (!p) { takeProjectTarget(subitem, projectId); return; }
    if (enteredProject) {
      if (enteredProject.id !== p.id) enterProject(p);
      setProjectTab(subitem);
      setTab("project");
    } else {
      setOpenProject({ id: p.id, name: p.name, view: subitem });
      setTab("projects");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectJump, activeId, overview, enteredProject]);

  // "Projects" is workspace level, "Project" the level of the entered project: when the level changes, the tab leads to its counterpart
  // (lib/coding-tabs.ts tabOnLevel), or without one to "Chats". (Skills, agents, MCP, credentials stay reachable: there one manages
  // the project-specific items and shows or hides workspace items.)
  useEffect(() => {
    const here = tabOnLevel(tab, !!enteredProject);
    if (here !== tab) setTab(here ?? "chats");
  }, [enteredProject, tab]);

  // Keep port conflicts fresh as soon as the Projects tab becomes visible.
  useEffect(() => {
    if (tab === "projects" && !openProject) {
      api<Record<string, { items: { port: number; name: string; owner: string }[] }>>(
        "/api/ports/conflicts",
      )
        .then(setPortConflicts)
        .catch(console.error);
    }
  }, [tab, openProject, activeId]);

  // Keep chat counters fresh: on tab/workspace change and on window focus; chats can also appear/disappear from outside (HTTP API, MCP).
  useEffect(() => {
    reloadChats().catch(console.error);
  }, [tab, reloadChats]);
  useEffect(() => {
    const onFocus = () => reloadChats().catch(console.error);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadChats]);

  const loadOverview = useCallback(async (id: string) => {
    setOverview(await api<Overview>(`/api/workspaces/${id}/overview`));
  }, []);

  const loadContext = useCallback(
    async (id: string, category: string | null, q: string) => {
      const params = new URLSearchParams();
      if (category) params.set("category", category);
      // As with project knowledge: meaning search, not substring filter (retrieval.js).
      if (q.trim()) { params.set("search", q.trim()); params.set("limit", "100"); }
      setCtxItems(await api<ContextItem[]>(`/api/workspaces/${id}/context?${params}`));
    },
    [],
  );

  async function open(id: string) {
    setActiveId(id);
    setCtxCategory(null);
    setCtxSearch("");
    setCtxOpen(null);
    // Restore the last active tab + open/entered project view of THIS workspace.
    let savedProject: OpenProject | null = null;
    try {
      const op = JSON.parse(localStorage.getItem(`cbase-open-project:${id}`) || "null");
      // A remembered "context" (a former page of the projects) opens the services: context stands in the entered project. The tabs
      // are known to ProjectView.tsx (`asProjectTab`, "git" too).
      const view = op?.view === "context" ? "services" : asProjectTab(op?.view);
      if (op?.id && op?.name && view) savedProject = { id: op.id, name: op.name, view };
    } catch {}
    setOpenProject(savedProject);
    let savedProjectTab: string | null = null;
    try { savedProjectTab = localStorage.getItem(`cbase-project-tab:${id}`); } catch {}
    setProjectTab(asProjectTab(savedProjectTab) ?? "services");
    let savedEntered: { id: string; name: string } | null = null;
    try {
      const ep = JSON.parse(localStorage.getItem(`cbase-entered-project:${id}`) || "null");
      if (ep?.id && ep?.name) savedEntered = ep;
    } catch {}
    setEnteredProject(savedEntered);
    setProjSwitchOpen(false);
    let savedTab: string | null = null;
    try { savedTab = localStorage.getItem(codingTabKey(id)); } catch { /* without storage: no remembered tab */ }
    // The whitelist derives from lib/coding-tabs.ts: "Projects" only without an entered project. A wish from the address (`?tab=`) takes
    // precedence over the remembered tab ONCE, placed on the level like it.
    const wish = tabWish.current;
    tabWish.current = null;
    setTab(wish ? (tabOnLevel(wish, !!savedEntered) ?? "chats") : savedTabOf(savedTab, !!savedEntered));
    // In the same step as the tab (before the first await): otherwise the effect above would write the kind of the OLD workspace under
    // the new id. An old tab "dynworkflows" leads to "workflows" + "dynamic" (lib/coding-tabs.ts).
    let savedKind: string | null = null;
    try { savedKind = localStorage.getItem(`cbase-wf-kind:${id}`); } catch {}
    setWfKind(savedWorkflowKind(savedKind, savedTab));
    let savedAgentsKind: string | null = null;
    try { savedAgentsKind = localStorage.getItem(`cbase-agents-kind:${id}`); } catch {}
    setAgentsKind(savedAgentKind(savedAgentsKind));
    await loadOverview(id);
    await loadContext(id, null, "");
    setChats(await api<Chat[]>(`/api/chats?workspaceId=${encodeURIComponent(id)}`));
  }

  async function refreshDetail() {
    if (!activeId) return;
    await loadOverview(activeId);
    await loadContext(activeId, ctxCategory, ctxSearch);
    setChats(await api<Chat[]>(`/api/chats?workspaceId=${encodeURIComponent(activeId)}`));
  }

  function onSearchInput(v: string) {
    setCtxSearch(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (activeId) loadContext(activeId, ctxCategory, v).catch(console.error);
    }, 250);
  }

  function pickCategory(cat: string | null) {
    setCtxCategory(cat);
    if (activeId) loadContext(activeId, cat, ctxSearch).catch(console.error);
  }

  // ── Workspace actions ──
  async function createWorkspace(path: string, name: string) {
    const finalName = name.trim() || path.split("/").filter(Boolean).pop() || path;
    const ws = await api<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ path, name: finalName }) });
    setWorkspaceDialog(false);
    await load();
    open(ws.id);
    // There is no "detect" any more (taking folders of the first level as projects): a project is created by the human via "+ Project".
  }

  // ── Projects ──
  // Go one level deeper: "enter" a project and straight into its (focused) chat.
  function enterProject(p: { id: string; name: string }) {
    setEnteredProject({ id: p.id, name: p.name });
    setProjSwitchOpen(false);
    setOpenProject(null);
    setTab("chats");
  }

  // ── Dumpster ──
  async function dump(e: React.FormEvent) {
    e.preventDefault();
    const text = dumpText.trim();
    if (!text || !activeId) return;
    setDumpBusy(true);
    setDumpStatus({ cls: "text-warn", text: dumpTarget === "auto" ? t("LLM is detecting the project…") : t("LLM is filing it…") });
    try {
      const body: Record<string, unknown> = { text, source: dumpSource.trim() };
      if (dumpTarget === "workspace") body.route = "workspace";
      else if (dumpTarget !== "auto") body.projectId = dumpTarget;
      // An unclear assignment lands in the workspace dumpster (the context agent with a question is gone).
      const r = await api<{
        target?: string; status?: string; projectName?: string;
        item?: { category?: string; title?: string };
      }>(`/api/workspaces/${activeId}/context`, { method: "POST", body: JSON.stringify(body) });

      if (r.target === "project") {
        setDumpText("");
        setDumpSource("");
        setDumpStatus({
          cls: "text-accent",
          text: t("Project \"{name}\": {status} — \"{title}\".", {
            name: r.projectName ?? "",
            status: r.status === "updated" ? t("merged into an existing entry") : t("filed as new"),
            title: r.item?.title ?? "",
          }),
        });
      } else {
        setDumpText("");
        setDumpSource("");
        setDumpStatus({ cls: "text-accent", text: t("Workspace context: \"{category}\" — {title}", { category: r.item?.category ?? "", title: r.item?.title ?? "" }) });
      }
      await refreshDetail();
    } catch (err) {
      setDumpStatus({ cls: "text-danger", text: t("Error: {msg}", { msg: (err as Error).message }) });
    } finally {
      setDumpBusy(false);
    }
  }

  // File import: a coding chat instead of an ingest agent: the server creates the chat (in the chosen project, otherwise in the workspace)
  // and returns the job (server projects/coding-jobs.js: target rule and hint live there, ONCE for web and iOS). Then upload the files
  // to the chat, send the job with the attachments and open the chat in Coding.
  async function ingestFiles() {
    if (!activeId || !dumpFiles.length) return;
    setDumpBusy(true);
    setDumpStatus({ cls: "text-warn", text: t("Uploading {n} file(s)…", { n: dumpFiles.length }) });
    try {
      const { chatId, job } = await api<{ chatId: string; job: string }>(`/api/workspaces/${activeId}/context/ingest`, {
        method: "POST",
        body: JSON.stringify({ target: dumpTarget, text: dumpText.trim() }),
      });
      const attachments: { name: string; file: string }[] = [];
      for (const f of dumpFiles) {
        const resp = await fetch(`/api/chats/${chatId}/attachments?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        if (!resp.ok) throw new Error(t("Upload failed: {name}", { name: f.name }));
        const a = await resp.json();
        attachments.push({ name: a.name, file: a.file });
      }
      await api(`/api/chats/${chatId}/message`, {
        method: "POST",
        body: JSON.stringify({ text: job, attachments }),
      });
      setDumpFiles([]);
      setDumpText("");
      setDumpStatus({ cls: "text-accent", text: t("A coding chat is reading & filing {n} file(s).", { n: attachments.length }) });
      openCodingChat(chatId, activeId);
    } catch (err) {
      setDumpStatus({ cls: "text-danger", text: t("Error: {msg}", { msg: (err as Error).message }) });
    } finally {
      setDumpBusy(false);
    }
  }

  function onDumpDrop(e: React.DragEvent) {
    e.preventDefault();
    setDumpDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) setDumpFiles((prev) => [...prev, ...files]);
  }

  async function delContext(id: number) {
    await api(`/api/workspaces/${activeId}/context/${id}`, { method: "DELETE" });
    await refreshDetail();
  }

  const o = overview;

  // Level 1 of the navigation: the ICON RAIL on the left (`SymbolRail`): one icon per tab, the name in the tooltip and in the
  // `aria-label`, `title` as a half sentence below it. The separator before "Files" stays the list's statement, as a short hairline in
  // the rail: the workspace's administration above, the tools below.
  //
  // WITHOUT NUMBERS: no counters on chats, agents, workflows, projects, MCP, context and credentials: no dot, no dimmed number, no
  // capsule. They counted STOCKS, and a stock stands on its target page anyway; in the navigation it was only noise that twitched
  // on every load. Bound by web/test/coding-tab.test.mjs.
  const tabItems: Tab[] = o ? [
    { key: "chats", label: "Chats", icon: <TabIcon kind="chats" /> },
    // Scheduled jobs: on both levels; in the entered project the project's jobs.
    { key: "scheduled", label: t("Scheduled"), icon: <TabIcon kind="scheduled" /> },
    // Agents exist on both levels (workspace items or project items + takeover).
    { key: "agents", label: t("Agents"), icon: <TabIcon kind="agents" /> },
    // Workflows exist on both levels (workspace workflows or project workflows + takeover). With two kinds (graph · dynamic): the library
    // of dynamic workflows is no tab of its own any more but the second kind, a segment bar in components/workflow/WorkflowsTab.tsx.
    { key: "workflows", label: t("Workflows"), icon: <TabIcon kind="workflows" /> },
    // "Projects" is workspace level, hidden in the entered project.
    ...(!enteredProject ? [{ key: "projects", label: t("Projects"), icon: <TabIcon kind="projects" /> }] : []),
    // In the same place in the entered project: "Project", directly the view of THIS project (services · layout · instances), the same
    // component without list, way back and "Enter".
    ...(enteredProject ? [{ key: "project", label: t("Project"), title: t("Services, outline and instances of this project"), icon: <TabIcon kind="project" /> }] : []),
    // MCP exists on both levels: workspace servers or their activation in the project.
    { key: "mcp", label: "MCP", icon: <TabIcon kind="mcp" /> },
    { key: "context", label: "Context", icon: <TabIcon kind="context" /> },
    { key: "vars", label: "Credentials", icon: <TabIcon kind="vars" /> },
    // Skills right after credentials and on the same principle: workspace level the workspace coding skills, in the entered project its own
    // plus those of the workspace with a switch. The top-level page /skills forwards here.
    {
      key: "skills",
      label: t("Skills"),
      title: enteredProject ? t("Instructions of this project — and which of the workspace apply here") : t("Instructions for the coding agents' recurring tasks"),
      icon: <TabIcon kind="skills" />,
    },
    // Code & terminal exist on BOTH levels (workspace root or project folder).
    {
      key: "code",
      // Called "Files"; the key stays "code" (⌘R restoration, lib/coding-tabs.ts).
      label: t("Files"),
      separatorBeforehand: true,
      // The half sentences stand WITHOUT the name in front ("Files — …"): the rail's tooltip shows the name in its first line already.
      title: enteredProject ? t("View and edit the files of the entered project") : t("View and edit the files in the workspace folder"),
      icon: <TabIcon kind="code" />,
    },
    {
      key: "terminal",
      label: "Terminal",
      title: t("Multiple sessions; running commands stay active in the background when switching tabs"),
      icon: <TabIcon kind="terminal" />,
    },
    {
      key: "browser",
      label: "Browser",
      title: t("Runs on the server/locally in the same network as the hosted apps (localhost reachable)"),
      icon: <TabIcon kind="browser" />,
    },
  ] : [];

  // Padding of the document and tool pages. The conversation brings its own and gets none here. Code, terminal and browser get none
  // either: they go borderless to the edges of the content card (`data-content-card`, app/layout.tsx; its edge and rounding already
  // frame them), without a surface of their own; where two areas meet in them, a hairline separates (CodePane, TerminalsPane, BrowserPane).
  const pagePadding = "px-4 pb-4 pt-3.5 sm:px-5";

  return (
    // The rail of the other pages (`WorkspaceRail`): the workspace is the FRAME around Coding, not a view beside it.
    <WorkspaceRail
      list={list}
      loaded={loaded}
      activeId={activeId}
      onPick={(id) => { open(id).catch(console.error); }}
      onNew={() => setWorkspaceDialog(true)}
      showPath={!gw}
      storageKey="cbase-coding-rail"
    >
      {!o && (
        <div className="m-auto max-w-[420px] p-8 text-center">
          <div className="text-[14px] font-semibold">{t("No workspace yet")}</div>
          <p className="mt-1 text-[12.5px] text-dim">{t("Create a workspace or select one on the left.")}</p>
        </div>
      )}
      {o && (
        <>
          {/* Workspace › Project in the MIDDLE of the header (`HeadersMiddle`). Back and project menu are buttons: `no-drag` is carried by the
              content of `HeadersMiddle` itself, always (the header is a drag region, and the menu would inherit it otherwise).
              `data-kit-pop` is the anchor of the click catcher above (`closest`). */}
          <HeadersMiddle data={{ "data-kit-pop": "" }}>
            <span className="shrink-0 text-dim"><WorkspaceIcon /></span>
            {/* A name that should shrink needs a minimum width BELOW its content width (otherwise truncate does not apply). In the entered
                project the workspace name yields first (`shrink-[4]`, but never below 3rem, else it would vanish): the free band of the
                header is narrow on a narrow window, and then the project is the more important half. The minimum widths (icon, 3rem,
                caret) are also the limit at which the header puts the indicator in a line of its own instead of laying it over the usage
                rings (TopNav.tsx, `overflows` — in client operation with rings at 1024–1150 px). `min-w-0` therefore stands only in the
                branch without a project: next to `min-w-[3rem]` the order in the stylesheet used to decide. */}
            <button
              onClick={() => enteredProject && setEnteredProject(null)}
              disabled={!enteredProject}
              title={enteredProject ? `${o.name} — ${t("Back to the whole workspace")}` : (!gw ? o.path : undefined)}
              className={`block max-w-[190px] truncate ${enteredProject ? "min-w-[3rem] shrink-[4] text-dim hover:text-fg" : "min-w-0 cursor-default"}`}
            >
              {o.name}
            </button>
            {enteredProject && <span className="shrink-0 text-dim"><CrumbChevron /></span>}
            {(enteredProject || o.projects.length > 0) && (
              <button
                onClick={() => setProjSwitchOpen((v) => !v)}
                title={enteredProject ? `${enteredProject.name} — ${t("Switch project")}` : t("Enter a project")}
                aria-haspopup="menu"
                aria-expanded={projSwitchOpen}
                className={`flex min-w-0 items-center gap-1 rounded-full transition-colors hover:bg-hover ${
                  enteredProject
                    ? "max-w-[190px] px-1.5 py-0.5 text-fg"
                    : "px-1.5 py-1 text-dim hover:text-fg"
                }`}
              >
                {enteredProject && <span className="truncate">{enteredProject.name}</span>}
                <span className="shrink-0"><CaretMini /></span>
              </button>
            )}
            {!o.exists && <span className="shrink-0 pl-1 text-[11px] font-medium text-warn">{t("Path not found")}</span>}
            {projSwitchOpen && (
              <div ref={projSwitchRef} role="menu" className={`${popClassHeader} absolute left-0 top-full mt-2 max-h-[50vh] w-[min(248px,calc(100vw-2rem))] origin-top-left overflow-y-auto text-[13px] font-normal tracking-normal`} onKeyDown={menuKeys}>
                <div className={menuHeader}>
                  {t("Enter project")}
                </div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!enteredProject}
                  onClick={() => { setEnteredProject(null); setProjSwitchOpen(false); }}
                  className={`${menuRow} ${enteredProject ? "" : "font-medium"}`}
                >
                  {t("Entire workspace")}
                  {!enteredProject && <span className="ml-auto text-dim"><CheckMark /></span>}
                </button>
                {o.projects.length > 0 && <MenuSeparator />}
                {o.projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={enteredProject?.id === p.id}
                    onClick={() => enterProject({ id: p.id, name: p.name })}
                    className={`${menuRow} ${enteredProject?.id === p.id ? "font-medium" : ""}`}
                  >
                    <span className="truncate">{p.name}</span>
                    {enteredProject?.id === p.id && <span className="ml-auto shrink-0 text-dim"><CheckMark /></span>}
                  </button>
                ))}
                {o.projects.length === 0 && (
                  <div className="px-2.5 py-2 text-[12px] text-dim">{t("No projects yet.")}</div>
                )}
              </div>
            )}
          </HeadersMiddle>
          {/* The tabs as an icon rail on the left: the same list, the same choice as before in the tab row: the choice goes through only if it is a
              coding tab. Without numbers (see above); `data-tab` holds the identifier for the probes. */}
          <SymbolRail
            label={t("Sections")}
            entries={tabItems.map((r) => ({
              key: r.key, label: r.label, icon: r.icon, hint: r.title, separatorBeforehand: r.separatorBeforehand,
              data: { "data-tab": r.key },
            }))}
            active={tab}
            onSelect={(k) => { if (isCodingTab(k)) setTab(k); }}
          />
          {/* The stage: `cb-kit` colours the colour roles cool in the light design (see globals.css), `cb-kit-stage bg-panel` marks
              the opaque stage surface (the class carries no rule of its own any more; the app is flat).
              `@container/kit` is the reference for every two-column rule of the pages below. */}
          {/* In the chats tab without a surface of its own: list, conversation and right rail are three cards on the frame there
              (`data-three-cards` below, globals.css); the surface behind stays transparent. */}
          <div className={`@container/kit cb-kit flex min-h-0 min-w-0 flex-1 flex-col ${tab === "chats" ? "" : "cb-kit-stage bg-panel"}`}>
            {/* Content area: on a tab change it fades in over 150 ms, opacity only (`TabFade`). Chats stays in the DOM (only hidden); wrapping
                mounts nothing anew, streams stay. The panels below carry NO fade of their own any more: a second, longer one (`cb-fade-in`,
                300 ms on the code) would have covered the fade above and made the change into that tab slow again. */}
            <TabFade token={tab} className="flex min-h-0 flex-1 flex-col">
            {/* Chats tab: full height, desktop layout (list + chat window). Stays MOUNTED on tab change (only hidden) so the open chat with
                its running stream is kept when one comes back. */}
            {activeWs && (
              <div className={tab === "chats" ? "flex min-h-0 flex-1" : "hidden"} data-three-cards={tab === "chats" ? "" : undefined}>
                {/* key: a change of the focus project cleanly remounts the chat area (own scope). `data-three-cards` only in the VISIBLE tab: the pane stays mounted hidden, and `:has()` would otherwise see it then too. */}
                <ChatPane
                  key={enteredProject?.id ?? "__ws__"}
                  workspace={activeWs}
                  focusProjectId={enteredProject?.id ?? null}
                  onChanged={reloadChats}
                />
              </div>
            )}

            {/* Terminal on BOTH levels (workspace root or project folder). Stays MOUNTED on tab change (only hidden) so running commands
                keep running in the background. Key = scope: re-materialised on scope change and re-attached to the still running PTYs (the
                server replays the buffer). */}
            {activeWs && (
              <div className={tab === "terminal" ? "flex min-h-0 flex-1" : "hidden"}>
                <TerminalsPane
                  key={enteredProject ? `proj:${enteredProject.id}` : `ws:${activeId}`}
                  apiBase={enteredProject ? `/api/projects/${enteredProject.id}` : `/api/workspaces/${activeId}`}
                  scopeKey={enteredProject ? `proj:${enteredProject.id}` : `ws:${activeId}`}
                />
              </div>
            )}

            {/* Browser on BOTH levels (own profile per scope). Stays MOUNTED on tab change (only hidden); the stream then pauses
                (active=false), the browser itself keeps running server-side (idle timeout secures the open tabs). */}
            {activeWs && (
              <div className={tab === "browser" ? "flex min-h-0 flex-1" : "hidden"}>
                <BrowserPane
                  key={enteredProject ? `proj:${enteredProject.id}` : `ws:${activeId}`}
                  apiBase={enteredProject ? `/api/projects/${enteredProject.id}` : `/api/workspaces/${activeId}`}
                  active={tab === "browser"}
                />
              </div>
            )}

            {/* Code editor on BOTH levels (workspace root or project folder), full height; git sidebar to its right (hides itself when there
                is no git repo). On project level with the instance choice main | copy (CodeArea.tsx). After the first open it stays MOUNTED on
                tab change (only hidden, like chats and terminal): the open tabs with unsaved changes and a held copy live only in the tab's
                state and would otherwise be lost silently. Hidden, its ticks pause (`active`). */}
            {codeVisited && activeWs && (
              <div className={tab === "code" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
                <CodeArea workspaceId={activeWs.id} workspaceName={o.name} project={enteredProject} active={tab === "code"} />
              </div>
            )}

            {tab !== "chats" && tab !== "code" && tab !== "terminal" && tab !== "browser" && (
            /* Two kinds of tab: most are documents (they may grow and this frame scrolls), some are FULL-SURFACE tools with their own inner
               scrolling; they need a FIXED height. Without it the frame is content-driven and grows with the largest child: the workflow
               editor got a scrollbar around the whole area as soon as its library got longer. */
            <div className={`flex-1 ${pagePadding} ${
              fullHeightPane ? "flex min-h-0 flex-col overflow-hidden" : "cb-scroll overflow-y-auto"
            }`}>
            <div className={`flex flex-col ${fullHeightPane ? "min-h-0 flex-1" : "min-h-full"}`}>
            {/* The names for the origin headers (Origin.tsx): ONCE here, no tab threads them through. */}
            <OriginNames.Provider value={{ project: enteredProject?.name, workspace: activeWs?.name }}>
            {/* Credentials & variables: in the entered project only the project credentials. */}
            {tab === "vars" && enteredProject && (
              <VarsPane
                key={`proj:${enteredProject.id}`}
                basePath={`/api/projects/${enteredProject.id}`}
                scope="project"
                /* No `onChanged`: the page keeps its own list up to date, and the tab counter that was counted from outside is gone. */
              />
            )}
            {tab === "vars" && !enteredProject && activeId && (
              <VarsPane key={`ws:${activeId}`} basePath={`/api/workspaces/${activeId}`} scope="workspace" onChanged={refreshDetail} />
            )}
            {/* MCP servers: workspace level = create/activate; in the project = project-related activation. */}
            {tab === "mcp" && activeId && (
              <McpServersPane
                key={enteredProject ? `mcp:${activeId}:${enteredProject.id}` : `mcp:${activeId}`}
                workspaceId={activeId}
                projectId={enteredProject?.id ?? null}
                onChanged={refreshDetail}
              />
            )}
            {/* Skills: workspace level the workspace coding skills (read-only "Hidden in …"); in the entered project its own and
                those of the workspace with a switch (opt-out). */}
            {tab === "skills" && activeId && (
              <SkillsPane
                key={enteredProject ? `sk:${enteredProject.id}` : `sk:${activeId}`}
                workspaceId={activeId}
                projectId={enteredProject?.id ?? null}
              />
            )}
            {/* Scheduled: the scheduled jobs: list on the left, on the right header and the job's chat (ChatPane `onlyChat`). */}
            {tab === "scheduled" && activeWs && (
              <ScheduledTab
                key={enteredProject ? `gp:${enteredProject.id}` : `gp:${activeWs.id}`}
                workspace={activeWs}
                projectId={enteredProject?.id ?? null}
              />
            )}
            {/* Workflows: workspace level, or in the project project workflows + takeover; two kinds: graph and dynamic (the
                workspace library, in the project a takeover per row) */}
            {tab === "workflows" && activeId && (
              <WorkflowsTab
                key={enteredProject ? `wf:${enteredProject.id}` : `wf:${activeId}`}
                workspaceId={activeId}
                projectId={enteredProject?.id ?? null}
                kind={wfKind}
                onKindChange={setWfKind}
              />
            )}

            {/* Agents: two kinds: subagents (workspace level CRUD, or in the project project agents + switchable workspace agents) and
                outer loop (background agents with the summariser) */}
            {tab === "agents" && activeId && (
              <AgentsTab
                key={enteredProject ? `ag:${enteredProject.id}` : `ag:${activeId}`}
                workspaceId={activeId}
                projectId={enteredProject?.id ?? null}
                projects={overview?.projects}
                kind={agentKind}
                onKindChange={setAgentsKind}
              />
            )}

            {/* Projects */}
            {tab === "projects" && activeId && (
              <ProjectsPane
                workspaceId={activeId}
                projects={o.projects}
                portConflicts={portConflicts}
                gw={!!gw}
                openProject={openProject}
                setOpenProject={setOpenProject}
                onEnter={enterProject}
                onCode={(p) => { enterProject(p); setTab("code"); }}
                onChanged={async () => { await refreshDetail(); await load(); }}
              />
            )}

            {/* Project: the view of the entered project: the same component as under "Projects", entered without a list */}
            {tab === "project" && activeId && enteredProject && (
              <ProjectsPane
                key={`project:${enteredProject.id}`}
                workspaceId={activeId}
                projects={o.projects}
                portConflicts={portConflicts}
                gw={!!gw}
                openProject={{ id: enteredProject.id, name: enteredProject.name, view: projectTab }}
                setOpenProject={(p) => { if (p) setProjectTab(p.view); }}
                inProject
                onEnter={enterProject}
                onCode={() => setTab("code")}
                onChanged={async () => { await refreshDetail(); await load(); }}
              />
            )}

            {/* Context: in the entered project the whole project context */}
            {tab === "context" && enteredProject && (
              <ProjectContextPane
                key={`ctx:${enteredProject.id}`}
                projectId={enteredProject.id}
                projectName={enteredProject.name}
                /* `onChanged` no longer exists on this pane: it had exactly one passer, the context counter of the tab row. VarsPane
                   keeps the prop because workspace level still needs it. */
              />
            )}
            {/* Context, workspace level (only outside a project): memory and dumpster as two pages of a segment bar. The quiet
                page: shared column, quiet page header, the memory list without a surface between hairlines, category and "Outdated" as a
                dimmed word; the dumpster a quiet input in the tub of the kit fields (`bg-bg`, no glass, edge or shadow) with the details
                free beside it. The memory list has the form of the instances (kit) and under the title the summary ("8 entries · 3
                categories", the explanatory sentence as a tooltip on it, or while there is nothing). */}
            {tab === "context" && !enteredProject && (
            <section className={`${COLUMN} flex min-h-0 flex-1 flex-col overflow-hidden`}>
              <PagesHeader
                title={t("Context")}
                under={wsCtxSub === "memory"
                  ? (o.contextCount > 0
                    ? (
                      <span className="tabular-nums" title={t("Informal knowledge at workspace level — not tied to a single project.")} data-context-summary>
                        {[
                          o.contextCount === 1 ? t("1 entry") : t("{n} entries", { n: o.contextCount }),
                          o.categories.length === 1 ? t("1 category") : t("{n} categories", { n: o.categories.length }),
                        ].join(" · ")}
                      </span>
                    )
                    : t("Informal knowledge at workspace level — not tied to a single project."))
                  : t("Drop in text or files — an LLM recognises the context and creates an entry or extends a matching one.")}
              >
                <Segments
                  label={t("Context")}
                  items={[
                    { key: "memory", label: "Memory", n: o.contextCount || null },
                    { key: "dumpster", label: "Dumpster" },
                  ]}
                  value={wsCtxSub}
                  onChange={(k) => setWsCtxSub(k as typeof wsCtxSub)}
                />
              </PagesHeader>

              <TabFade token={wsCtxSub} className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {wsCtxSub === "dumpster" && (
              <form
                onSubmit={(e) => { e.preventDefault(); if (dumpFiles.length) ingestFiles(); else dump(e); }}
                onDragOver={(e) => { e.preventDefault(); if (!dumpDragOver) setDumpDragOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDumpDragOver(false); }}
                onDrop={onDumpDrop}
                className="grid min-h-0 flex-1 gap-x-8 gap-y-6 pb-4 @4xl/kit:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)] @4xl/kit:[align-content:stretch] [align-content:start]"
              >
                {/* Left the field for dragging and pasting; it fills the grid row. An input, not a card: the tub of the kit fields without
                    edge and shadow. While dragging it tints, without frame, without ring. */}
                <div className={`flex min-h-[220px] flex-col overflow-hidden rounded-2xl transition-colors ${
                  dumpDragOver ? "bg-accent/10" : "bg-bg"
                }`}>
                  <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
                    <Overline>{t("New information")}</Overline>
                    <span className="mb-1.5 ml-auto text-[10.5px] tabular-nums text-dim">{dumpText.length.toLocaleString(dateLocale())} {t("characters")}</span>
                  </div>
                  <textarea
                    value={dumpText}
                    onChange={(e) => setDumpText(e.target.value)}
                    placeholder={t("Drop in text — or drag files here (code, docs, PDFs, images, …).")}
                    className="min-h-[150px] w-full flex-1 resize-none bg-transparent px-4 pb-3 text-[14px] leading-7 outline-none placeholder:text-dim/65"
                  />
                  {dumpDragOver && <div className="px-4 pb-2 text-[12px] font-medium text-accent">{t("Release to drop the files in…")}</div>}
                  {dumpFiles.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
                      {dumpFiles.map((f, i) => (
                        <span key={i} className="flex items-center gap-1.5 rounded-full bg-panel py-1 pl-2.5 pr-1 text-[11.5px]">
                          <PaperclipMini />
                          <span className="max-w-[200px] truncate">{f.name}</span>
                          <span className="text-dim">{(f.size / 1024).toFixed(0)} KB</span>
                          <RemoveButton label={t("Remove")} onClick={() => setDumpFiles((prev) => prev.filter((_, j) => j !== i))} />
                        </span>
                      ))}
                      <button type="button" onClick={() => setDumpFiles([])} className="rounded-full px-2 py-1 text-[11.5px] text-dim hover:text-danger">{t("remove all")}</button>
                    </div>
                  )}
                </div>
                {/* Right the details and the one exit: free on the stage, without a surface. */}
                <div className="flex flex-col gap-4">
                  <div>
                    <Overline>{t("Destination")}</Overline>
                    <select value={dumpTarget} onChange={(e) => setDumpTarget(e.target.value)} className={`${select} w-full`}>
                      <option value="auto">{t("Detect automatically")}</option>
                      <option value="workspace">{t("No project (workspace)")}</option>
                      {o.projects.length > 0 && <option disabled>──────────</option>}
                      {o.projects.map((p) => (
                        <option key={p.id} value={p.id}>{t("Project: {name}", { name: p.name })}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Overline>{t("Source")}</Overline>
                    <input
                      value={dumpSource}
                      onChange={(e) => setDumpSource(e.target.value)}
                      placeholder={t("Source (optional)")}
                      className={`${field} w-full`}
                    />
                  </div>
                  <div>
                    <Overline>{t("Files")}</Overline>
                    <label className={`${ghost} inline-flex cursor-pointer items-center gap-1.5`}>
                      <PaperclipMini />
                      <span>{t("Choose files")}</span>
                      <input type="file" multiple className="hidden" onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) setDumpFiles((prev) => [...prev, ...fs]); e.target.value = ""; }} />
                    </label>
                  </div>
                  <div className="mt-auto flex flex-col gap-2 pt-2">
                    <button
                      type="submit"
                      disabled={dumpBusy || (!dumpText.trim() && !dumpFiles.length)}
                      className={`${primary} flex items-center justify-center gap-2 disabled:opacity-40`}
                    >
                      {dumpBusy ? <DumpsterSpinner /> : <DumpsterSendIcon />}
                      {dumpBusy ? t("Sorting in…") : dumpFiles.length ? (dumpFiles.length === 1 ? t("Drop in 1 file") : t("Drop in {n} files", { n: dumpFiles.length })) : t("Into memory")}
                    </button>
                    {dumpStatus.text && (
                      <Hint tone={dumpStatus.cls === "text-danger" ? "danger" : dumpStatus.cls === "text-warn" ? "warn" : "ok"}>{dumpStatus.text}</Hint>
                    )}
                  </div>
                </div>
              </form>
              )}

              {wsCtxSub === "memory" && (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                {/* Search, below it the categories as a scrolling bar (`CategoryBar`): the same bar as in the project context; the
                    categories here are freely named and carry a neutral symbol. */}
                <div className="flex shrink-0 flex-col gap-2">
                  <Search
                    value={ctxSearch}
                    onChange={onSearchInput}
                    placeholder={t("Search knowledge — question or keyword…")}
                    className="w-[min(100%,420px)]"
                  />
                  <CategoryBar
                    label={t("Category")}
                    value={ctxCategory}
                    onChoice={pickCategory}
                    entries={[
                      { key: "", label: t("All"), n: o.contextCount },
                      ...o.categories.map((c: Category) => ({ key: c.category, label: c.category, n: c.n })),
                    ]}
                  />
                </div>
                {ctxItems.length === 0 ? (
                  <EmptySentence title={ctxSearch || ctxCategory ? t("No matching entries") : t("No context yet")}>
                    {t("Switch to the dumpster and drop in text or files — the AI files them automatically.")}
                  </EmptySentence>
                ) : (
                  /* The list scrolls in itself; every entry is a row that expands in place (`data-open`). The form of the instances
                     (kit): rounded rows, light under the pointer, in front the tile with the category's symbol (free names: the label) in
                     the colour of the state (dimmed outdated), source · date · tags as facts; expanded, the head carries the accent
                     hint, the text stands indented in the tub of the kit fields. */
                  <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
                    <AnimatedSwitch token={`${ctxCategory ?? "all"}:${ctxSearch}`} className="flex flex-col gap-0.5">
                    {ctxItems.map((it) => {
                      const isOpen = ctxOpen === it.id;
                      const stale = it.status === "deprecated" || it.status === "superseded";
                      return (
                      <article key={it.id} className="min-w-0" data-open={isOpen ? "1" : undefined}>
                        <div
                          onClick={() => setCtxOpen(isOpen ? null : it.id)}
                          className={`${LIST_ROW} cursor-pointer items-start ${isOpen ? SELECTED : "hover:bg-hover"}`}
                        >
                          <Tile color={stale ? "text-dim" : "text-fg/80"}><CategorySymbol slug={it.category} size={16} /></Tile>
                          <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center">
                            <div className="flex min-w-0 items-baseline gap-2">
                              <span className="min-w-0 truncate text-[14px] font-medium tracking-[-0.01em]">{it.title || t("(untitled)")}</span>
                              {stale && (
                                <span className="shrink-0 text-[12px] text-dim" title={t("Marked as outdated — agents no longer see this entry by default")}>
                                  {t("Deprecated")}
                                </span>
                              )}
                            </div>
                            {it.summary && <p className={`mt-0.5 max-w-[80ch] text-[12.5px] leading-relaxed text-dim ${isOpen ? "" : "line-clamp-2"}`}>{it.summary}</p>}
                            <div className={`mt-1 ${FACTS}`}>
                              <Fact symbol={<CategorySymbol slug={it.category} size={12} />} className="shrink-0">{it.category}</Fact>
                              {it.source && <span className="min-w-0 truncate">{it.source}</span>}
                              <Fact symbol={SYM.clock(12)} className="shrink-0 tabular-nums">{new Date(it.created_at < 1e12 ? it.created_at * 1000 : it.created_at).toLocaleDateString(dateLocale())}</Fact>
                              {it.tags && it.tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 4).map((tag) => <span key={tag} className="font-mono text-[11px] text-dim/80">#{tag}</span>)}
                            </div>
                          </div>
                          <span className="flex h-8 shrink-0 items-center text-dim transition-colors group-hover:text-fg"><Chevron open={isOpen} /></span>
                          <span className="flex h-8 shrink-0 items-center">
                            <Menu label={t("More")} silent width={180}>
                              <MenuEntry label={t("Delete")} danger onClick={() => delContext(it.id)} />
                            </Menu>
                          </span>
                        </div>
                        {isOpen && it.body && (
                          <div className="pb-4 pl-[54px] pr-2.5 pt-2">
                            {/* The text in the tub of the kit fields. */}
                            <div
                              onWheel={(e) => e.stopPropagation()}
                              className="max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-xl bg-bg px-2 py-1.5"
                            >
                              <MarkdownEditor value={it.body} onChange={() => undefined} reading lineNumbers fontSize={textPx(11)} height="auto" />
                            </div>
                          </div>
                        )}
                      </article>
                      );
                    })}
                    </AnimatedSwitch>
                  </div>
                )}
              </div>
              )}
              </TabFade>
            </section>
            )}
            </OriginNames.Provider>
            </div>
            </div>
            )}
            </TabFade>
          </div>
        </>
      )}

      {workspaceDialog && (
        <FolderDialog
          title={t("New workspace")}
          pickTitle={t("Choose workspace folder")}
          pathPlaceholder={t("/path/to/workspace")}
          submitLabel={t("Add")}
          onCreate={createWorkspace}
          onClose={() => setWorkspaceDialog(false)}
        />
      )}
    </WorkspaceRail>
  );
}

// Workspace icon of the header: stacked layers (a workspace holds several projects). Deliberately no folder (projects and chat folders
// carry that) and no hexagon (that is a chat's run state), so the row is not confused with either.
function WorkspaceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 3 7.5 12 12l9-4.5L12 3z" />
      <path d="M3 12.5 12 17l9-4.5" />
    </svg>
  );
}

// The icons of the coding tabs, for EVERY tab, because the tabs stand as an icon rail (`SymbolRail`, icons only). 20 px, stroke 1.8,
// round ends; the rail sets the size via CSS anyway. Deliberately distinguishable from the icons beside them: no hexagon (a chat's run
// state), no stacked layers (the workspace at the top of the header).
type TabKind = "chats" | "scheduled" | "agents" | "workflows" | "projects" | "project" | "mcp" | "context" | "vars" | "skills" | "code" | "terminal" | "browser";
function TabIcon({ kind }: { kind: TabKind }) {
  const p = (children: React.ReactNode) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
  );
  switch (kind) {
    // Speech bubble with a foot at the bottom left.
    case "chats": return p(<path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4.5 3.5v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" />);
    // A clock: the scheduled job (the same sign the row of a job chat carries in the chat list).
    case "scheduled": return p(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
    // An agent: head with an antenna and two eyes.
    case "agents": return p(<><rect x="4" y="8" width="16" height="12" rx="3.5" /><path d="M12 8V4.5" /><path d="M10.5 4.5h3" /><path d="M9.5 13.2v1.6" /><path d="M14.5 13.2v1.6" /></>);
    // Two nodes, connected: a graph.
    case "workflows": return p(<><rect x="3" y="3.5" width="7" height="7" rx="2" /><rect x="14" y="13.5" width="7" height="7" rx="2" /><path d="M10 7h3.5a2 2 0 0 1 2 2v4.5" /></>);
    // Folders.
    case "projects": return p(<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />);
    // An open folder with a box in it: THIS project from the inside, distinguishable from the closed "Projects".
    case "project": return p(<><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" /><rect x="9" y="11.5" width="6" height="5" rx="1" /></>);
    // Plug: a server one plugs in.
    case "mcp": return p(<><path d="M9 3v4.5" /><path d="M15 3v4.5" /><path d="M6 7.5h12V11a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>);
    // Open book: the workspace's knowledge.
    case "context": return p(<><path d="M12 6.5C10.4 5 8 4.5 4 4.5v13c4 0 6.4.5 8 2 1.6-1.5 4-2 8-2v-13c-4 0-6.4.5-8 2z" /><path d="M12 6.5v13" /></>);
    // Key.
    case "vars": return p(<><circle cx="7.5" cy="15.5" r="4" /><path d="M10.4 12.6 20 3" /><path d="M16.5 6.5 19 9" /><path d="M14 9l2 2" /></>);
    // A spark: the same as the tile of a skill row (CbKit `SYM.skill`).
    case "skills": return p(<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />);
    case "code": return p(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>);
    case "terminal": return p(<><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></>);
    case "browser": return p(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a13.5 13.5 0 0 1 0 18a13.5 13.5 0 0 1 0-18" /></>);
  }
}

function CrumbChevron() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function CaretMini() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function PaperclipMini() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
