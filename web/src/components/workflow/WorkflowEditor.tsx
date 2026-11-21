"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type TriggerTestResult, type Workflow, type WorkflowBranch, type WorkflowGraph, type WorkflowLock, type WorkflowNode, type WorkflowNodeType, type WorkflowRunSettings, type WorkflowTrigger } from "@/lib/api";
import { WorkflowNodeDialog } from "@/components/workflow/WorkflowNodeDialog";
import { WorkflowSettings, type WfeProvider } from "@/components/workflow/WorkflowSettings";
import { ADDABLE, BADGE_CARD, ENTRY, TYPE, WorkflowBadge, icon } from "@/components/workflow/WorkflowBadge";
import { Info } from "@/components/workflow/PlaceholderChips";
import { iconBtn } from "@/components/workflow/workflowForm";
import { BackButton, Hint, Search, pillSm } from "@/components/CbKit";
import { NODE_H, NODE_W, branchKey, cycleEdges, pathOf, pointAlong, route, routeToPoint, wire, type OutPort, type Pos, type Rect, type Side } from "@/lib/graph-geometry";
import { effectiveCaps, nodeModes, nodesOnCycle, checksEffective, type WfRule } from "@/lib/workflow-node-form";
import { useT } from "@/lib/i18n";

// Visual flow builder: nodes as DOM, edges as SVG, pan/zoom/drag by hand — no graph library is
// needed and the look matches the rest of the app.
//
// Layout: the canvas gets as much room as possible. Everything else sits beside or above it — the
// node library in a collapsible sidebar on the right, step settings and workflow settings in modals.
//
// Ports: free nodes carry one dock on the left and one on the right. Dragging an edge out of a dock
// makes it the output; dropping an edge on a dock makes it the input — the GESTURE decides, and the
// choice is stored on the edge (`fromSide`/`toSide`). Fixed nodes (FIXED: condition, loop, review)
// stay rigid: input left, labelled outputs right. Entries (trigger, start) accept no edge, `end`
// emits none. Edges are orthogonal. All geometry lives in src/lib/graph-geometry.ts (tested on its
// own in web/test/graph-geometry.test.mjs). Two rejected variants: "input left, output right,
// dynamic points" and "each edge takes the nearer end" — the latter put input and output on the same
// flank and the card became unreadable.
//
// Form: no outer card; header bar, canvas and library are three surfaces side by side, the modals
// are sheets on the body, fields are wells from the kit. Nodes stay opaque (`panel`): a translucent
// node over a surface with edges beneath it would be a sieve in the dark theme.
//
// Density: only the FRAME is tight (header bar, library, zoom capsule, the two sheets). The cards on
// the canvas (NODE_W/NODE_H, bound to iOS) are unchanged. The type table and badge live in
// `WorkflowBadge.tsx` because the library and the node dialog show the same badge.

const GRID = 8; // grid that nodes snap to
const PALETTE_KEY = "cbase-wf-palette"; // sidebar open/closed is remembered

// Nodes with fixed, labelled outputs stay rigid — input left, outputs right in branch order; all
// other nodes pick both ends by the position of their neighbours.
const FIXED = new Set<WorkflowNodeType>(["condition", "loop", "review"]);
// Edges on a cycle carry the loop colour: a halo (like a highlighter) under the line and a light tint
// of the line itself — readable in both themes without clashing with the type colours of the cards
// (the loop is the only kind that means "repetition").
const LOOP_HALO = `color-mix(in srgb, ${TYPE.loop.color} 22%, transparent)`;
const LOOP_STROKE = `color-mix(in srgb, ${TYPE.loop.color} 60%, var(--color-dim))`;

// Start and end carry neither type line nor text — a small pill or a flat rectangle says it all. The
// geometry works on rectangles, so this costs nothing extra.
const COMPACT_W = 160;
const COMPACT_H = 44;
const compact = (type: WorkflowNodeType) => type === "start" || type === "end";
const rectOf = (n: Pos & { type: WorkflowNodeType }): Rect =>
  ({ x: n.x, y: n.y, w: compact(n.type) ? COMPACT_W : NODE_W, h: compact(n.type) ? COMPACT_H : NODE_H });

// Outputs per kind: condition, loop and review have two labelled ones (FIXED — on the right, in this
// order, height from `wire`), `end` has none, all others exactly one nameless one — it leaves from
// the dock the drag started at.
function outPorts(type: WorkflowNodeType): { branch: WorkflowBranch; label: string }[] {
  if (type === "condition") {
    return [
      { branch: "true", label: "Yes" },
      { branch: "false", label: "No" },
    ];
  }
  if (type === "loop") {
    return [
      { branch: "each", label: "per item" },
      { branch: "done", label: "done" },
    ];
  }
  if (type === "review") {
    return [
      { branch: "ok", label: "Approve##noun" },
      { branch: "issues", label: "Findings" },
    ];
  }
  if (type === "end") return [];
  return [{ branch: null, label: "" }];
}
// Position of a fixed output while the wiring does not know it (only possible for a branch that
// `outPorts` does not list): right, centred, unoccupied.
const PORT_FALLBACK: OutPort = { side: "right", slot: 0.5, occupied: false };

// Fresh trigger: new merge requests across all own projects — the most common case; everything else
// (account, project, events) is in the modal right next to it.
const newTrigger = (): WorkflowTrigger => ({
  source: "gitlab", accountId: "", scope: "all",
  projectId: "", projectPath: "", groupId: "", groupPath: "",
  events: ["mr_opened"], labels: "", branch: "", skipMine: true, intervalSec: 60,
});
// One-liner on the node: "All my projects · 2 events".
function triggerSummary(tr: WorkflowTrigger | undefined, t: (k: string, p?: Record<string, string | number>) => string) {
  if (!tr) return t("(not configured)");
  const where = tr.scope === "project" ? tr.projectPath || t("project?") : tr.scope === "group" ? tr.groupPath || t("group?") : t("All my projects");
  const n = tr.events.length;
  return `${where} · ${n === 1 ? t("1 event") : t("{n} events", { n })}`;
}

// Run settings of a fresh workflow — the server defaults (`normalizeRunSettings`): empty means
// "as usual", `autocompact`/`autocompactMax` null = default, "check all work steps" on, three
// check rounds, ask at both caps. The choices themselves (permissions, lock, effort) live in the
// modal, WorkflowSettings.tsx.
const EMPTY_RUN: WorkflowRunSettings = {
  provider: "", model: "", permissionMode: "", effort: "", ultracode: false, doneProvider: "", doneModel: "",
  autocompact: null, autocompactMax: null, doneAll: true, doneRounds: 3, doneCapAuto: false, loopCapAuto: false,
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const snap = (v: number) => Math.round(v / GRID) * GRID;
const uid = () => `n${Math.random().toString(36).slice(2, 9)}`;

// Dot grid of the canvas, two layers: the fine tile (24 world px) and, every five cells, a somewhat
// stronger dot — so some orientation remains at low zoom without turning into texture.
const DOT = GRID * 3;
const DOT_MAJOR = DOT * 5;
const dotBg = (alpha: number, radius: number) =>
  `radial-gradient(circle, color-mix(in srgb, var(--color-dim) ${alpha}%, transparent) ${radius}px, transparent ${radius + 0.5}px)`;

const GearIcon = ({ size = 15 }: { size?: number }) => icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.35.4.64.73.83.3.17.63.26.97.26H21a2 2 0 1 1 0 4h-.09c-.7 0-1.32.42-1.6 1.06Z" /></>, size);
const PlusIcon = () => icon(<><path d="M12 5v14M5 12h14" /></>);
const XIcon = ({ size = 15 }: { size?: number }) => icon(<><path d="M18 6 6 18M6 6l12 12" /></>);
const FitIcon = () => icon(<><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" /></>, 14);
const ChevronRight = () => icon(<><path d="m9 18 6-6-6-6" /></>, 14);
const BellIcon = ({ size = 12 }: { size?: number }) => icon(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>, size);

export function WorkflowEditor({ base, id, workspaceId, projectId, onClose, onSaved }: {
  base: string;              // e.g. /api/workspaces/<id>/workflows
  id: string;
  // For the skill pool of the command picker in the node dialog (effective skills per workspace/project).
  workspaceId: string;
  projectId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = useT();
  const [flow, setFlow] = useState<Workflow | null>(null);
  const [graph, setGraph] = useState<WorkflowGraph>({ nodes: [], edges: [] });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Concurrency: one run per lock key. Default "project" — two runs in the same repo would
  // otherwise overwrite each other's files and git index.
  const [lock, setLock] = useState<WorkflowLock>({ scope: "project", template: "" });
  // Run settings of this workflow (provider/model/permissions/effort/ultracode).
  const [run, setRun] = useState<WorkflowRunSettings>(EMPTY_RUN);
  // ALL providers, including unconnected ones — the modal does the `connected` filtering (provider/model
  // among the connected ones, effort levels from the whole list).
  const [providers, setProviders] = useState<WfeProvider[]>([]);
  // The globally active provider: "Default (global)" in the run is computed with it, not with "".
  const [activeProvider, setActiveProvider] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // node settings as a modal
  const [metaOpen, setMetaOpen] = useState(false);             // workflow settings as a modal
  const [palette, setPalette] = useState(true);
  const [search, setSearch] = useState("");
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const [cam, setCam] = useState({ x: 40, y: 40, scale: 1 });
  const camRef = useRef(cam);
  camRef.current = cam;
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Edge currently being dragged (preview up to the pointer). `fromSide` = the dock it was grabbed at
  // (always right on fixed nodes). `over` = card and dock the edge would land on right now
  // (highlight while dragging).
  const [linking, setLinking] = useState<{ from: string; branch: WorkflowBranch; fromSide: Side; x: number; y: number; over: { id: string; side: Side } | null } | null>(null);

  useEffect(() => {
    setPalette(localStorage.getItem(PALETTE_KEY) !== "0");
  }, []);
  const togglePalette = () => setPalette((v) => { localStorage.setItem(PALETTE_KEY, v ? "0" : "1"); return !v; });

  useEffect(() => {
    let alive = true;
    api<Workflow>(`${base}/${id}`).then((w) => {
      if (!alive) return;
      setFlow(w);
      setName(w.name);
      setDescription(w.description);
      setLock(w.lock ?? { scope: "project", template: "" });
      setRun({ ...EMPTY_RUN, ...(w.run || {}) });
      // Deliberately NO start node pre-seeded: the entry is either a trigger or a start, and both come
      // from the library. A fresh workflow is empty.
      // The graph is taken over unchanged: `fromSide`/`toSide` are the docks chosen while dragging;
      // if missing, right-out/left-in applies (`wire`).
      setGraph(w.graph);
      setDirty(false);
    }).catch((e) => setError(String(e)));
    return () => { alive = false; };
  }, [base, id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api<{ active?: string; providers: WfeProvider[] }>("/api/providers")
      .then((d) => { setProviders(d.providers || []); setActiveProvider(d.active || ""); })
      .catch(() => { /* choice stays empty = "as usual" */ });
  }, []);

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  // Ports of all edges in ONE pass (`wire`): both ends per edge (from the docks stored on the edge),
  // the position of the outputs per fixed node, the occupied docks per node. Plus the edges that lie
  // on a cycle (highlight).
  const wiring = useMemo(
    () => wire(
      graph.nodes.map((n) => ({ id: n.id, rect: rectOf(n), branches: outPorts(n.type).map((p) => p.branch), fixed: FIXED.has(n.type) })),
      graph.edges.map((e) => ({ from: e.from, to: e.to, branch: e.branch ?? null, fromSide: e.fromSide, toSide: e.toSide })),
    ),
    [graph.nodes, graph.edges],
  );
  const loops = useMemo(() => cycleEdges(graph.edges), [graph.edges]);
  const sel = editing ? nodeById.get(editing) ?? null : null;

  const mutate = useCallback((fn: (g: WorkflowGraph) => WorkflowGraph) => {
    setGraph((g) => fn(g));
    setDirty(true);
  }, []);

  // Screen → graph coordinates.
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    const c = camRef.current;
    return {
      x: ((clientX - (rect?.left ?? 0)) - c.x) / c.scale,
      y: ((clientY - (rect?.top ?? 0)) - c.y) / c.scale,
    };
  }, []);

  // Add a new node. Without a target point (click in the library) it lands in the centre of the
  // visible area, with a target point (drop by dragging) exactly there.
  function addNode(type: WorkflowNodeType, at?: { x: number; y: number }) {
    const rect = boxRef.current?.getBoundingClientRect();
    const spot = at ?? toCanvas((rect?.left ?? 0) + (rect?.width ?? 600) / 2, (rect?.top ?? 0) + (rect?.height ?? 400) / 2);
    // The target point is the CENTRE of the new card — and start/end are smaller than the rest.
    const size = rectOf({ x: 0, y: 0, type });
    const node: WorkflowNode = {
      id: uid(), type,
      title: t(TYPE[type].label),
      text: "",
      x: snap(spot.x - size.w / 2 + (at ? 0 : (graph.nodes.length % 4) * 12)),
      y: snap(spot.y - size.h / 2 + (at ? 0 : (graph.nodes.length % 4) * 12)),
      ...(type === "loop" ? { items: [], maxIterations: 20 } : {}),
      ...(type === "trigger" ? { trigger: newTrigger() } : {}),
      // A review WITHOUT a notification would be a trap: the run stands still until somebody happens
      // to look. The server does the same (normalizeGraph) so both show the same.
      notify: type === "review",
    };
    mutate((g) => ({ ...g, nodes: [...g.nodes, node] }));
    setSelected(node.id);
    // An empty step without text is useless — open its settings right away.
    if (type !== "end" && type !== "start") setEditing(node.id);
  }
  function updateNode(nodeId: string, patch: Partial<WorkflowNode>) {
    mutate((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }));
  }
  function removeNode(nodeId: string) {
    mutate((g) => ({
      nodes: g.nodes.filter((n) => n.id !== nodeId),
      edges: g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    }));
    setSelected(null);
    setEditing((e) => (e === nodeId ? null : e));
  }
  // `fromSide`/`toSide` = the docks from the GESTURE: grabbed at `fromSide`, released at `toSide`.
  // Fixed nodes store nothing (empty): they only have right-out / left-in, and a stored value would
  // be a claim that `wire` ignores anyway.
  function addEdge(from: string, to: string, branch: WorkflowBranch, fromSide: Side, toSide: Side) {
    if (from === to) return;
    mutate((g) => {
      // A source may have only ONE edge per branch (except for "parallel" — there several
      // branches are the point).
      const src = g.nodes.find((n) => n.id === from);
      const dst = g.nodes.find((n) => n.id === to);
      const keep = src?.type === "parallel"
        ? g.edges.filter((e) => !(e.from === from && e.to === to))
        : g.edges.filter((e) => !(e.from === from && (e.branch ?? null) === (branch ?? null)));
      return { ...g, edges: [...keep, {
        from, to, branch,
        fromSide: src && FIXED.has(src.type) ? "" as const : fromSide,
        toSide: dst && FIXED.has(dst.type) ? "" as const : toSide,
      }] };
    });
  }

  // ── Interaction: pan, zoom, drag node, drag edge ─────────────────────────────────────────────
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = boxRef.current?.getBoundingClientRect();
    const mx = e.clientX - (rect?.left ?? 0);
    const my = e.clientY - (rect?.top ?? 0);
    setCam((v) => {
      const ns = clamp(v.scale * (e.deltaY < 0 ? 1.12 : 0.89), 0.3, 2.2);
      return { scale: ns, x: mx - ((mx - v.x) / v.scale) * ns, y: my - ((my - v.y) / v.scale) * ns };
    });
  }
  // Zooming via the buttons: around the centre of the area so the view does not jump.
  function zoomBy(factor: number) {
    const rect = boxRef.current?.getBoundingClientRect();
    const mx = (rect?.width ?? 600) / 2;
    const my = (rect?.height ?? 400) / 2;
    setCam((v) => {
      const ns = clamp(v.scale * factor, 0.3, 2.2);
      return { scale: ns, x: mx - ((mx - v.x) / v.scale) * ns, y: my - ((my - v.y) / v.scale) * ns };
    });
  }
  // Fit all: compute the bounding rectangle of all nodes into the area.
  function fitView() {
    if (!graph.nodes.length) return setCam({ x: 40, y: 40, scale: 1 });
    const rect = boxRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 600, h = rect?.height ?? 400;
    const rects = graph.nodes.map(rectOf);
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const pad = 48;
    const scale = clamp(Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY)), 0.3, 1.4);
    setCam({ scale, x: (w - (maxX - minX) * scale) / 2 - minX * scale, y: (h - (maxY - minY) * scale) / 2 - minY * scale });
  }
  function onBgDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    setSelected(null);
    const startX = e.clientX, startY = e.clientY;
    const base0 = { ...camRef.current };
    const move = (ev: MouseEvent) => setCam((v) => ({ ...v, x: base0.x + (ev.clientX - startX), y: base0.y + (ev.clientY - startY) }));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  function onNodeDown(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const node = nodeById.get(nodeId);
    if (!node) return;
    const base0 = { x: node.x, y: node.y };
    const scale = camRef.current.scale;
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) <= 3) return;
      moved = true;
      const nx = snap(base0.x + (ev.clientX - startX) / scale);
      const ny = snap(base0.y + (ev.clientY - startY) / scale);
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, x: nx, y: ny } : n)) }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved) setDirty(true);
      setSelected(nodeId);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  // Target of a dragged edge: the whole card, not a point on it — WHICH dock is decided by the HALF of
  // the card the pointer is released over (left or right; always left on fixed nodes). Rectangle plus
  // tolerance, because a release 6 px outside the card must not fizzle silently. Entries are no
  // target: they accept no edge.
  const LINK_SNAP = 34;
  function linkTarget(q: Pos, from: string): { id: string; side: Side } | null {
    let best: { id: string; side: Side; d: number } | null = null;
    for (const n of graph.nodes) {
      if (n.id === from || ENTRY.has(n.type)) continue;
      const r = rectOf(n);
      const dx = Math.max(r.x - q.x, 0, q.x - (r.x + r.w));
      const dy = Math.max(r.y - q.y, 0, q.y - (r.y + r.h));
      const d = Math.hypot(dx, dy); // 0 = inside the rectangle
      const side: Side = !FIXED.has(n.type) && q.x > r.x + r.w / 2 ? "right" : "left";
      if (d <= LINK_SNAP && (!best || d < best.d)) best = { id: n.id, side, d };
    }
    return best ? { id: best.id, side: best.side } : null;
  }

  function onPortDown(e: React.MouseEvent, from: string, branch: WorkflowBranch, fromSide: Side) {
    e.stopPropagation();
    if (e.button !== 0) return;
    // Dead zone as when moving a node (3 px): only a real drag gesture starts an edge. Without it a
    // CLICK on the output would hit `linkTarget` (34 px tolerance around each card) and `addEdge`
    // would silently replace the branch's existing edge.
    const startX = e.clientX, startY = e.clientY;
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) <= 3) return;
      moved = true;
      const q = toCanvas(ev.clientX, ev.clientY);
      // The target is determined and highlighted continuously while dragging — otherwise you only
      // learn after releasing whether you hit (and on "nothing happens" not why).
      const over = linkTarget(q, from);
      setLinking({ from, branch, fromSide, x: q.x, y: q.y, over });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const hit = moved ? linkTarget(toCanvas(ev.clientX, ev.clientY), from) : null;
      // Both docks come from the GESTURE: grabbed at `fromSide`, released at `hit.side`.
      if (hit) addEdge(from, hit.id, branch, fromSide, hit.side);
      setLinking(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // Delete/Backspace removes the selected node — except while typing in a field or while a modal
  // is open (there the key belongs to the form).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (e.key === "Escape") { setEditing(null); setMetaOpen(false); setSelected(null); return; }
      if (editing || metaOpen) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); removeNode(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // deliberately without deps: always reads the current state

  // `active` is set with the same PUT: the server checks the trigger and sets the watermark to NOW.
  // Arming ALWAYS saves the current state first — otherwise a configuration would be armed that
  // still sits in the editor.
  async function save(active?: boolean) {
    setSaving(true);
    setError("");
    try {
      const saved = await api<Workflow>(`${base}/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name: name.trim(), description, graph, lock, run, ...(active === undefined ? {} : { active }) }),
      });
      setFlow(saved);
      setGraph(saved.graph);
      setDirty(false);
      onSaved?.();
      return saved;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      setError(msg);
      errorRef.current = msg;
      return null;
    } finally {
      setSaving(false);
    }
  }
  // Arming from the modal: the same PUT, but the error goes back to the modal — the hint under the
  // header bar sits behind the scrim.
  const errorRef = useRef("");
  async function arm(): Promise<string> {
    errorRef.current = "";
    const saved = await save(!flow?.active);
    return saved ? "" : errorRef.current || t("Saving failed");
  }

  const triggers = useMemo(() => graph.nodes.filter((n) => n.type === "trigger"), [graph.nodes]);
  const statusFor = (nodeId: string) => flow?.triggers?.find((tv) => tv.nodeId === nodeId) ?? null;
  // "Check now" asks the SERVER (it has the token) — so the state must be saved first.
  async function testTrigger(nodeId: string): Promise<TriggerTestResult> {
    if (dirty) await save();
    const r = await api<TriggerTestResult>(`${base}/${id}/trigger-test`, {
      method: "POST", body: JSON.stringify({ nodeId }),
    });
    // Status (last poll/error) changed → refresh header and modal.
    api<Workflow>(`${base}/${id}`).then((w) => setFlow(w)).catch(() => {});
    return r;
  }

  // Search in the library: name AND description, so "wait" finds the question. ONE flat list in
  // catalogue order (entries before steps); the library draws the boundary between them as a
  // hairline, not as a section header.
  const hits = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ADDABLE.filter((type) => !q || `${t(TYPE[type].label)} ${t(TYPE[type].hint)}`.toLowerCase().includes(q));
  }, [search, t]);
  const anyMatch = hits.length > 0;

  const problems = flow?.problems ?? [];
  const steps = useMemo(() => graph.nodes.filter((n) => ["instruction", "parallel", "ask", "review"].includes(n.type)).length, [graph.nodes]);
  // Limits come from the SERVER (they are defined and enforced there) — the label "0 = default
  // (5 rounds)" must not have two truths.
  const maxVisits = flow?.limits?.maxVisits ?? 5;
  const maxVisitsLimit = flow?.limits?.maxVisitsLimit ?? 99;
  const maxIterations = flow?.limits?.maxIterations ?? 50;
  // Check rounds of the completion gate: a per-workflow setting — read from the EDITING STATE
  // (`run.doneRounds`), not from `limits` (that holds the stored number, for old clients). The upper
  // bound comes from the server.
  const doneRounds = run.doneRounds;
  const doneRoundsMax = flow?.limits?.doneRoundsMax ?? 10;
  // The defaults a node inherits with "as workflow" — from the editing state, so cards and node
  // dialog immediately show what a flipped switch does.
  const wf = useMemo<WfRule>(() => ({ doneAll: run.doneAll, doneCapAuto: run.doneCapAuto, loopCapAuto: run.loopCapAuto }), [run.doneAll, run.doneCapAuto, run.loopCapAuto]);
  const cycle = useMemo(() => nodesOnCycle(graph), [graph]);
  const caps = useMemo(() => effectiveCaps(graph, maxVisits, wf), [graph, maxVisits, wf]);
  // "Save" as a small pill: the size of `pillSm`, the colour of `primary` (graphite).
  const primarySm = `${pillSm} bg-dark text-white hover:opacity-90`;
  // Fields, markers and icon buttons of the sheets come from `workflowForm.ts` — the same as in the
  // node dialog and the trigger component, so a measure lives in ONE place.
  // Dot grid of the canvas: the spacing moves with the camera and scales with the zoom, the dot
  // RADIUS stays in screen pixels (otherwise the dots become blobs when zooming in). Shifted by half
  // a tile so a dot sits exactly on world (0,0) — a CSS pattern is tile-centred.
  const dotPos = (step: number) => `${cam.x - (step * cam.scale) / 2}px ${cam.y - (step * cam.scale) / 2}px`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      {/* Slim header bar as a surface — everything else lives in the modals so the canvas stays
          large. */}
      <div className="cb-kit-pane flex shrink-0 flex-wrap items-center gap-2 rounded-2xl px-3 py-1.5">
        <BackButton label={t("Overview")} onClick={onClose} />
        <button
          onClick={() => setMetaOpen(true)}
          title={t("Workflow settings (name, description, hints)")}
          className="min-w-0 max-w-[40%] truncate rounded-xl px-2 py-1 text-[13px] font-semibold hover:bg-hover"
        >
          {name || t("Workflow name")}
        </button>
        <span className="shrink-0 text-[12px] text-dim">{t("{n} steps", { n: steps })}</span>
        {problems.length > 0 && (
          <button
            onClick={() => setMetaOpen(true)}
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${problems.some((p) => p.level === "error") ? "bg-danger/15 text-danger" : "bg-warn/15 text-warn"}`}
          >
            {problems.length === 1 ? t("1 hint") : t("{n} hints", { n: problems.length })}
          </button>
        )}
        {dirty && <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-semibold text-warn">{t("unsaved")}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {/* Active switch as in n8n — only useful when there is a trigger. */}
          {triggers.length > 0 && (
            <span className="mr-1 flex items-center gap-1.5">
              <span className={`text-[11.5px] font-semibold ${flow?.active ? "text-accent" : "text-dim"}`}>{flow?.active ? t("Active") : t("Inactive")}</span>
              {/* Capsule 20 px, knob 14 px, travel 16 px (36 − 14 − 2 × 3). Not the kit `Toggle`
                  (knob 16 px), but the same semantics: role=switch + aria-checked, otherwise
                  this switch would be a nameless button for a screen reader. */}
              <button
                role="switch"
                aria-checked={!!flow?.active}
                onClick={() => save(!flow?.active)}
                disabled={saving}
                title={flow?.active ? t("Turn the trigger off") : t("Arm the trigger (only events from now on count)")}
                aria-label={t("Arm the trigger")}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${flow?.active ? "bg-accent" : "bg-edge"} disabled:opacity-50`}
              >
                <span className={`absolute top-[3px] h-3.5 w-3.5 rounded-full bg-white shadow transition-all ${flow?.active ? "left-[19px]" : "left-[3px]"}`} />
              </button>
            </span>
          )}
          <button onClick={() => setMetaOpen(true)} title={t("Workflow settings")} aria-label={t("Workflow settings")} className={iconBtn}>
            <GearIcon />
          </button>
          {/* Saving concludes a thing — graphite. The accent belongs to the switch alone, while
              the trigger listens. */}
          <button
            onClick={() => save()}
            disabled={saving || !dirty}
            className={`${primarySm} disabled:opacity-40`}
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
        </div>
      </div>
      {error && <Hint tone="danger">{error}</Hint>}

      <div className="flex min-h-0 flex-1 gap-2.5">
        {/* Canvas — takes all remaining room. */}
        <div
          ref={boxRef}
          onWheel={onWheel}
          onMouseDown={onBgDown}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
          onDrop={(e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData("text/cbase-node") as WorkflowNodeType;
            if (ADDABLE.includes(type)) addNode(type, toCanvas(e.clientX, e.clientY));
          }}
          className="cb-kit-pane relative min-h-[320px] flex-1 overflow-hidden rounded-2xl"
        >
          {/* Ground: the cards should stand lighter than the surface — in both themes. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-bg/70" />
          {/* Fine grid. Fades out below 45 % zoom: the dots would sit so close that they turn
              into texture instead of a help. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              opacity: clamp((cam.scale - 0.45) / 0.3, 0, 1),
              backgroundImage: dotBg(28, 1),
              backgroundSize: `${DOT * cam.scale}px ${DOT * cam.scale}px`,
              backgroundPosition: dotPos(DOT),
            }}
          />
          {/* Coarse grid every five cells — stays visible at every zoom level. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: dotBg(46, 1.5),
              backgroundSize: `${DOT_MAJOR * cam.scale}px ${DOT_MAJOR * cam.scale}px`,
              backgroundPosition: dotPos(DOT_MAJOR),
            }}
          />
          {/* The world (cards, edges, branch words) has fixed geometry — 232 × 84 per card, bound to iOS
              (lib/graph-geometry.ts) — and therefore does NOT grow with the app text size (`cb-text-fixed`,
              globals.css; the root carries the inherited 15 px itself). Zoom capsule, header bar and
              library next to it do grow. */}
          <div className="cb-text-fixed absolute left-0 top-0 origin-top-left text-[15px]" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})` }}>
            <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
              <defs>
                {/* `userSpaceOnUse`: the tip stays 9 px even when the stroke thickens on hover.
                    `orient="auto"` aligns it with the last segment — horizontal onto the flank,
                    from left or right (see graph-geometry.ts). */}
                <marker id="wf-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--color-dim)" />
                </marker>
                <marker id="wf-arrow-hot" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--color-accent)" />
                </marker>
                <marker id="wf-arrow-loop" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" style={{ fill: LOOP_STROKE }} />
                </marker>
              </defs>
              {graph.edges.map((e, i) => {
                const s = nodeById.get(e.from);
                const d = nodeById.get(e.to);
                const ends = wiring.edges.get(i);
                if (!s || !d || !ends) return null;
                // Orthogonal polyline with sharp corners. `inset` = radius of the input point: the
                // tip ends ON the point instead of vanishing behind it (the cards lie over the edge
                // layer).
                const points = route(rectOf(s), ends.from, rectOf(d), ends.to, compact(d.type) ? 4 : 5);
                const path = pathOf(points);
                // The delete button belongs ON the line, at half the LENGTH: for a back edge both the
                // middle vertex and the middle of the chord would lie beside the path, partly closer
                // to a FOREIGN edge than to its own.
                const mid = pointAlong(points, 0.5);
                const hovered = hoverEdge === i;
                // Edges on a cycle: a soft halo in the loop colour UNDER the line, like a highlighter —
                // the line itself stays thin and lightly tinted so it does not shout next to the others.
                // On hover the accent still applies, the halo stays.
                const loop = loops.has(i);
                const stroke = hovered ? "var(--color-accent)" : loop ? LOOP_STROKE : "var(--color-dim)";
                return (
                  <g key={`${e.from}-${e.to}-${e.branch ?? ""}-${i}`} className="pointer-events-auto" data-loop={loop ? "1" : undefined}>
                    {loop && (
                      <path
                        d={path}
                        fill="none" stroke={LOOP_HALO} strokeWidth={9} strokeLinejoin="round" strokeLinecap="round"
                      />
                    )}
                    <path
                      d={path}
                      fill="none" stroke={stroke}
                      strokeWidth={hovered ? 2.5 : 1.75} strokeLinejoin="miter" strokeLinecap="butt"
                      markerEnd={hovered ? "url(#wf-arrow-hot)" : loop ? "url(#wf-arrow-loop)" : "url(#wf-arrow)"}
                    />
                    {/* Invisible, thick hit line: a 2px line is hard to hit otherwise. */}
                    <path
                      d={path}
                      fill="none" stroke="transparent" strokeWidth={16} style={{ cursor: "pointer" }}
                      onMouseEnter={() => setHoverEdge(i)}
                      onMouseLeave={() => setHoverEdge((h) => (h === i ? null : h))}
                    >
                      {loop && <title>{t("Part of a loop")}</title>}
                    </path>
                    {hovered && (
                      <g
                        style={{ cursor: "pointer" }}
                        onMouseEnter={() => setHoverEdge(i)}
                        onClick={() => { mutate((g) => ({ ...g, edges: g.edges.filter((_, j) => j !== i) })); setHoverEdge(null); }}
                      >
                        <circle cx={mid.x} cy={mid.y} r={10} fill="var(--color-panel)" stroke="var(--color-edge)" strokeWidth={1} />
                        <path d={`M${mid.x - 3.5},${mid.y - 3.5} L${mid.x + 3.5},${mid.y + 3.5} M${mid.x + 3.5},${mid.y - 3.5} L${mid.x - 3.5},${mid.y + 3.5}`} stroke="var(--color-danger)" strokeWidth={1.6} />
                      </g>
                    )}
                  </g>
                );
              })}
              {linking && (() => {
                const s = nodeById.get(linking.from);
                if (!s) return null;
                // The same staircase as a finished edge — otherwise the line would jump into a
                // different shape on release.
                return (
                  <path
                    d={pathOf(routeToPoint(
                      rectOf(s),
                      FIXED.has(s.type) ? wiring.ports.get(s.id)?.get(branchKey(linking.branch)) ?? PORT_FALLBACK : { side: linking.fromSide, slot: 0.5 },
                      { x: linking.x, y: linking.y },
                    ))}
                    fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="miter"
                  />
                );
              })()}
            </svg>

            {graph.nodes.map((n) => {
              const c = TYPE[n.type];
              const r = rectOf(n);
              const isSel = selected === n.id;
              const isTarget = linking?.over?.id === n.id;
              const small = compact(n.type);
              const ports = wiring.ports.get(n.id);
              const docks = wiring.docks.get(n.id) ?? { left: false, right: false };
              const fixed = FIXED.has(n.type);
              // You can drag out of a dock if you have an output (not `end`); you can drop on a dock
              // on everything except entries.
              const draggable = outPorts(n.type).length > 0;
              // Title and type line say the same as long as nobody renamed — a fresh step carries the
              // name of its kind (see addNode). Without this the card read "GitLab trigger" above
              // "GITLAB TRIGGER". The type line is omitted then; the title centres against the badge.
              const title = n.title.trim() || t(c.label);
              // The start command (/clear, /compact, free message) runs BEFORE the step — it belongs on
              // the card, not only in the dialog (as on the iPhone). With a command the text keeps one
              // line, the second belongs to the command.
              const command = (n.command ?? "").trim();
              const showsType = title !== t(c.label);
              // The corner radius tells the role: the trigger is half-round on the left (nothing
              // arrives there), start a pill, end a flat rectangle, every step 14 px.
              const radius = n.type === "trigger" ? "28px 14px 14px 28px" : n.type === "start" ? "22px" : n.type === "end" ? "12px" : "14px";
              return (
                <div
                  key={n.id}
                  onMouseDown={(e) => onNodeDown(e, n.id)}
                  onDoubleClick={(e) => { e.stopPropagation(); setEditing(n.id); }}
                  title={t("Double-click opens this step's settings")}
                  // Opaque on `panel`, edge from the flat surface. Selection and edge target are
                  // inline style because `.cb-kit-pane` is unlayered and would override `border-2` or
                  // `ring-2` on the element — inline wins against both. The ring is a box-shadow
                  // OUTSIDE so the 1 px edge stays and nothing jumps; flat cards carry no shadow of their own.
                  style={{
                    left: r.x, top: r.y, width: r.w, height: r.h,
                    borderRadius: radius,
                    background: "var(--color-panel)",
                    borderColor: isTarget ? "var(--color-accent)" : isSel ? c.color : undefined,
                    boxShadow: isTarget
                      ? "0 0 0 3px color-mix(in srgb, var(--color-accent) 35%, transparent)"
                      : isSel
                        ? `0 0 0 1px ${c.color}`
                        : undefined,
                  }}
                  className="cb-kit-pane cb-wf-node group absolute cursor-grab select-none active:cursor-grabbing"
                >
                  {small ? (
                    // Start and end: badge and title, nothing else — no text, no chips (start has no
                    // input, end no output, doneCheck exists only on instruction and parallel).
                    <div className="flex h-full items-center gap-2 overflow-hidden pl-2 pr-3" style={{ borderRadius: radius }}>
                      <WorkflowBadge type={n.type} size={BADGE_CARD} t={t} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold leading-4 text-fg">{title}</span>
                      {n.type === "end" && n.notify && (
                        <span className="shrink-0 text-dim" title={t("Notifies you when the run arrives here")}>
                          <BellIcon size={11} />
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="flex h-full flex-col overflow-hidden px-3 pb-2.5 pt-2.5" style={{ borderRadius: radius }}>
                      <div className="flex items-center gap-2.5">
                        <WorkflowBadge type={n.type} size={BADGE_CARD} t={t} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold leading-4 text-fg">{title}</span>
                            {/* Armed trigger: dot with a resting halo — the workflow is listening.
                                Deliberately WITHOUT animate-ping: "armed" is a permanent state that
                                can last days, and a permanent animation forces 60 frames/s in the
                                editor — per node. */}
                            {n.type === "trigger" && flow?.active && (
                              <span
                                title={t("Active — the server is polling GitLab")}
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ background: TYPE.trigger.color, boxShadow: `0 0 0 3px ${TYPE.trigger.color}40` }}
                              />
                            )}
                            {/* If the step lies on a cycle, the round count is the most important thing about it. */}
                            {cycle.has(n.id) && n.type !== "loop" && (() => {
                              // The chip shows the EFFECTIVE cap (inherited from the cycle, see effectiveCaps),
                              // not the node's raw number — otherwise "5×" would sit on a step that really
                              // stops only at 20.
                              const eff = caps.get(n.id) ?? { cap: n.maxVisits || maxVisits, auto: false, from: "" };
                              // Whether "without asking" comes from the node itself or is inherited (cycle or
                              // workflow): inherited, the arrow is dimmed.
                              const autoInherited = eff.auto && nodeModes(n).loopCapMode !== "continue";
                              const baseHint = eff.auto
                                ? t("At most {n} rounds per run — after that the run leaves the loop without asking.", { n: eff.cap })
                                : t("At most {n} rounds per run — after that the run asks.", { n: eff.cap });
                              return (
                                <span
                                  title={eff.from ? `${baseHint} ${t("Inherited from {from}.", { from: eff.from })}` : baseHint}
                                  className="shrink-0 rounded-full bg-bg px-1.5 text-[9.5px] font-semibold leading-4 tabular-nums text-dim"
                                >
                                  {t("{n}×", { n: eff.cap })}
                                  {eff.auto && <span className={autoInherited ? "opacity-50" : ""}>→</span>}
                                </span>
                              );
                            })()}
                            {/* Tick "notify": visible on the canvas, otherwise you would only learn by
                                opening every step which one reports. */}
                            {n.notify && (
                              <span title={t("Notifies you when the run arrives here")} className="shrink-0 text-dim">
                                <BellIcon size={11} />
                              </span>
                            )}
                            {/* Likewise the completion gate: that a step only moves on after a check
                                belongs on the canvas, not only in the dialog. */}
                            {/* From the EFFECTIVE value (node OR the workflow's "check all work steps");
                                inherited, the tick is dimmed — an explicit "on" at the node is the
                                exception you want to see. */}
                            {checksEffective(n, wf) && (() => {
                              const inherited = nodeModes(n).doneMode === "inherit";
                              return (
                                <span
                                  title={inherited ? t("Checked for completion after the turn (as set in the workflow)") : t("Checked for completion after the turn")}
                                  className={`shrink-0 text-dim ${inherited ? "opacity-45" : ""}`}
                                >
                                  {icon(<path d="M20 6 9 17l-5-5" />, 11)}
                                </span>
                              );
                            })()}
                          </div>
                          {/* No margin on top: 16 px title + 12 px type line make exactly the 28 px of
                              the badge — every extra pixel would push the second text line below the
                              card's bottom edge (the body is computed for 84 px). Without the type
                              line, `items-center` centres the title against the badge; the text lines
                              below stay where they are. */}
                          {showsType && (
                            <div className="truncate text-[9.5px] font-semibold uppercase leading-3 tracking-[0.06em] text-dim">{t(c.label)}</div>
                          )}
                        </div>
                      </div>
                      <div className={`mt-1.5 text-[11px] leading-[15px] text-dim ${command ? "line-clamp-1" : "line-clamp-2"}`}>
                        {n.type === "trigger"
                          ? triggerSummary(n.trigger, t)
                          : n.type === "loop" && n.items?.length
                            ? t("List: {items}", { items: n.items.slice(0, 3).join(", ") + (n.items.length > 3 ? " …" : "") })
                            // A review node needs no text — "(no text)" would read like a defect.
                            : n.type === "review" && !n.text.trim()
                              ? t("The agent writes the test instructions, you judge.")
                              : (n.text || t("(no text)")).slice(0, 110)}
                      </div>
                      {command && (
                        <div
                          title={t("Start command — runs before this step: {command}", { command })}
                          className="mt-0.5 flex items-center gap-1 truncate font-mono text-[9.5px] font-medium leading-[14px] text-accent"
                        >
                          <span className="shrink-0">{icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 2.5 2.5L7 14" /><path d="M12.5 14h4" /></>, 10)}</span>
                          <span className="truncate">{command}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Tools as ONE capsule above the card (appears on hover): two corner buttons no
                      longer fit now that pill, D-shape and rectangle stand side by side. The invisible
                      frame touches the top edge so the hover does not break on the way up. */}
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    className="absolute bottom-full right-2 hidden h-8 items-end pb-1.5 group-hover:flex"
                  >
                    <div className="cb-kit-pane flex gap-px rounded-full p-0.5" style={{ background: "var(--color-panel)" }}>
                      {n.type !== "start" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditing(n.id); }}
                          title={t("Settings of this step")}
                          aria-label={t("Settings of this step")}
                          className="grid h-5 w-5 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"
                        >
                          <GearIcon size={12} />
                        </button>
                      )}
                      {/* Deleting applies to EVERY node — start too: it is optional and comes
                          back from the library when needed. */}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeNode(n.id); }}
                        title={t("Delete step")}
                        aria-label={t("Delete step")}
                        className="grid h-5 w-5 place-items-center rounded-full text-dim transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        <XIcon size={12} />
                      </button>
                    </div>
                  </div>
                  {/* Free nodes: one dock left, one dock right. Each dock is output (drag) and input
                      (drop) at once — the gesture decides the role, and it is stored on the edge
                      afterwards. Filled once an edge hangs there, otherwise hollow with a frame in the
                      type colour: "drag from here / drop here". While an edge is dragged, the dock it
                      would land on grows. Hit area 24 px, dot 12 px; miss it and you would drag the
                      CARD, which looked as if nothing worked. `end` has no output: its docks only
                      accept. */}
                  {!fixed && (["left", "right"] as const).map((side) => {
                    const lands = isTarget && linking?.over?.side === side;
                    return (
                      <span
                        key={`dock-${side}`}
                        onMouseDown={draggable ? (e) => onPortDown(e, n.id, null, side) : undefined}
                        title={draggable
                          ? (ENTRY.has(n.type) ? t("Output — drag to connect") : t("Dock — drag for an output, drop an edge for an input"))
                          : t("Input — drop an edge here")}
                        style={{ left: side === "right" ? r.w : 0, top: r.h / 2 }}
                        className={`group/port absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center ${draggable ? "cursor-crosshair" : ""}`}
                      >
                        <span
                          style={{
                            background: docks[side] ? c.color : "var(--color-panel)",
                            borderColor: docks[side] ? "var(--color-panel)" : lands ? "var(--color-accent)" : c.color,
                          }}
                          className={`rounded-full border-2 transition-transform duration-150 ${small ? "h-2.5 w-2.5" : "h-3 w-3"} ${
                            lands ? "scale-[1.5]" : draggable ? "group-hover/port:scale-[1.35]" : ""
                          }`}
                        />
                      </span>
                    );
                  })}
                  {/* Fixed nodes: ONE input on the left (drop target only — a mousedown belongs to the
                      card, i.e. moving it) and one output per branch on the right, in branch order. */}
                  {fixed && (
                    <span
                      title={t("Input — drop an edge here")}
                      style={{ left: 0, top: r.h / 2 }}
                      className="absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center"
                    >
                      <span
                        style={{
                          background: docks.left ? c.color : "var(--color-panel)",
                          borderColor: docks.left ? "var(--color-panel)" : isTarget ? "var(--color-accent)" : c.color,
                        }}
                        className={`h-3 w-3 rounded-full border-2 transition-transform duration-150 ${isTarget ? "scale-[1.5]" : ""}`}
                      />
                    </span>
                  )}
                  {fixed && outPorts(n.type).map((p) => {
                    const { slot, occupied } = ports?.get(branchKey(p.branch)) ?? PORT_FALLBACK;
                    return (
                      <Fragment key={p.branch ?? "out"}>
                        <span
                          onMouseDown={(e) => onPortDown(e, n.id, p.branch, "right")}
                          title={t("Connect: {label}", { label: t(p.label) })}
                          style={{ left: r.w, top: slot * r.h }}
                          className="group/port absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-crosshair place-items-center"
                        >
                          <span
                            style={{ background: occupied ? c.color : "var(--color-panel)", borderColor: occupied ? "var(--color-panel)" : c.color }}
                            className="h-3 w-3 rounded-full border-2 transition-transform duration-150 group-hover/port:scale-[1.35]"
                          />
                        </span>
                        {/* The branch carries its word as a pill NEXT TO the dot, outside the card and
                            always visible — it belongs to the node, not the edge. It sits ABOVE the line
                            (as in n8n) instead of on it: centred and opaque it swallowed the whole edge
                            start with its first corner at usual distances. No mouse target — dragging
                            happens at the 24 px dot, the word just lies there. */}
                        <span
                          aria-hidden
                          style={{
                            left: r.w + 10, top: slot * r.h - 11,
                            background: `color-mix(in srgb, ${c.color} 14%, var(--color-panel))`,
                            borderColor: `color-mix(in srgb, ${c.color} 32%, transparent)`,
                          }}
                          className="pointer-events-none absolute -translate-y-1/2 select-none whitespace-nowrap rounded-full border px-1.5 text-[10px] font-semibold leading-4 text-fg"
                        >
                          {t(p.label)}
                        </span>
                      </Fragment>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Zoom controls bottom RIGHT: bottom left is where the app's orb sits and it covered them. */}
          {/* ONE glass capsule instead of three single circles: zoom level, −, +, fit. */}
          <div className="cb-kit-pane absolute bottom-3 right-3 flex items-center gap-0.5 rounded-full p-0.5">
            <span className="px-2 text-[10.5px] tabular-nums text-dim">{Math.round(cam.scale * 100)} %</span>
            <button onClick={() => zoomBy(0.85)} title={t("Zoom out")} aria-label={t("Zoom out")} className="grid h-6 w-6 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg">−</button>
            <button onClick={() => zoomBy(1.18)} title={t("Zoom in")} aria-label={t("Zoom in")} className="grid h-6 w-6 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg">+</button>
            <button onClick={fitView} title={t("Fit to view")} aria-label={t("Fit to view")} className="grid h-6 w-6 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"><FitIcon /></button>
          </div>

        </div>

        {/* Collapsible node library on the right. Closed = narrow strip with "+".
            `min-h-0` keeps the column shrinkable (scrolling happens INSIDE, in the list). That the
            editor does not outgrow the tab is decided by the tab frame, though: it needs a FIXED
            height (`fullHeightPane` in app/workspaces/page.tsx) — content-driven it grew with this
            library and the whole area got a scrollbar.
            Each row shows the card's badge (22 px) instead of a line icon: whoever should recognise
            the kind on the canvas must see it in the same shape here. The hint on the kind is in
            the row's tooltip, the usage in the (i) of the header. */}
        <div className={`cb-kit-pane relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl transition-[width] duration-200 ${palette ? "w-[232px]" : "w-[40px]"}`}>
          <div className={`flex h-8 shrink-0 items-center gap-1.5 border-b border-edge px-1.5 ${palette ? "pl-2.5" : "justify-center"}`}>
            {palette && (
              <span className="mr-auto flex items-center gap-1.5 text-[12.5px] font-semibold">
                {t("Steps")}
                <Info text={t("Drag = move · drag an output on the right = connect · double-click = settings")} />
              </span>
            )}
            <button
              onClick={togglePalette}
              title={palette ? t("Collapse library") : t("Add step")}
              aria-label={palette ? t("Collapse library") : t("Add step")}
              className={iconBtn}
            >
              {palette ? <ChevronRight /> : <PlusIcon />}
            </button>
          </div>
          {palette ? (
            <>
              {/* Search field above the list (as in the n8n node panel) — the capsule from the kit. */}
              <div className="border-b border-edge px-2 py-1.5">
                <Search value={search} onChange={setSearch} placeholder={t("Search steps…")} />
              </div>
              <div className="cb-scroll flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
                {hits.map((type, i) => (
                  <Fragment key={type}>
                    {/* The hairline without a word between entries and steps — only when both
                        sides have hits; a divider beside an empty side would be a line into nothing. */}
                    {i > 0 && ENTRY.has(hits[i - 1]) && !ENTRY.has(type) && (
                      <div aria-hidden className="mx-2.5 my-1 border-t border-edge/60" />
                    )}
                    <button
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData("text/cbase-node", type); e.dataTransfer.effectAllowed = "copy"; }}
                      onClick={() => addNode(type)}
                      title={`${t(TYPE[type].hint)} ${t("Drag or click to insert a step.")}`}
                      className="flex h-7 w-full shrink-0 cursor-grab items-center gap-2 px-2.5 text-left hover:bg-hover active:cursor-grabbing"
                    >
                      <WorkflowBadge type={type} size={22} t={t} title={null} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{t(TYPE[type].label)}</span>
                    </button>
                  </Fragment>
                ))}
                {!anyMatch && (
                  <p className="px-3 py-3 text-[12px] text-dim">{t("No matches.")}</p>
                )}
              </div>
            </>
          ) : (
            // Collapsed: the same badges stay visible as a shortcut (dragging works here too).
            <div className="cb-scroll flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto py-1">
              {ADDABLE.map((type) => (
                <button
                  key={type}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData("text/cbase-node", type); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => addNode(type)}
                  title={`${t(TYPE[type].label)} — ${t(TYPE[type].hint)}`}
                  aria-label={t(TYPE[type].label)}
                  className="grid h-8 w-8 shrink-0 cursor-grab place-items-center rounded-lg hover:bg-hover active:cursor-grabbing"
                >
                  <WorkflowBadge type={type} size={26} t={t} title={null} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Settings of a step — modal so the canvas does not have to give anything up. The content
          lives in WorkflowNodeDialog.tsx; here only the sheet and the wiring. */}
      {sel && (
        <Sheet onClose={() => setEditing(null)} width={560}>
          <WorkflowNodeDialog
            node={sel}
            graph={graph}
            trigger={sel.trigger ?? newTrigger()}
            typeLabel={t(TYPE[sel.type].label)}
            cycle={cycle}
            caps={caps}
            limits={{ maxVisits, maxVisitsLimit, maxIterations, doneRounds }}
            wf={wf}
            workspaceId={workspaceId}
            projectId={projectId}
            onChange={(patch) => updateNode(sel.id, patch)}
            onRemove={() => removeNode(sel.id)}
            onClose={() => setEditing(null)}
            triggerStatus={statusFor(sel.id)}
            onTestTrigger={() => testTrigger(sel.id)}
          />
        </Sheet>
      )}

      {/* Workflow settings — a modal with an icon rail. The content lives in WorkflowSettings.tsx;
          state and saving stay here. */}
      {metaOpen && (
        <Sheet onClose={() => setMetaOpen(false)} width={760} height={560} label={t("Workflow settings")}>
          <WorkflowSettings
            name={name}
            description={description}
            run={run}
            lock={lock}
            providers={providers}
            activeProvider={activeProvider}
            steps={steps}
            problems={problems}
            holding={flow?.holding ?? []}
            active={!!flow?.active}
            trigger={triggers.map((n) => ({ id: n.id, title: n.title || t("GitLab trigger"), summary: triggerSummary(n.trigger, t), status: statusFor(n.id) }))}
            doneRoundsMax={doneRoundsMax}
            dirty={dirty}
            saving={saving}
            onName={(v) => { setName(v); setDirty(true); }}
            onDescription={(v) => { setDescription(v); setDirty(true); }}
            onRun={(patch) => { setRun((r) => ({ ...r, ...patch })); setDirty(true); }}
            onLock={(l) => { setLock(l); setDirty(true); }}
            onArm={arm}
            onOpenStep={(nodeId) => { setMetaOpen(false); setEditing(nodeId); }}
            onClose={() => setMetaOpen(false)}
          />
        </Sheet>
      )}
    </div>
  );
}

/**
 * A sheet with header, scrolling body and footer — via portal on the body. The kit `Modal` closes on
 * a CLICK beside it, which does not work here: the editor's sheets consist of text fields, and a text
 * selection that starts in a field and ends over the scrim is a click on the scrim for the browser.
 * Hence `mousedown`.
 *
 * `cb-kit` on the overlay node is mandatory: the sheet hangs on the body, i.e. OUTSIDE the cool-tinted
 * view. And the portal is no decoration — the content area of the Coding page is an `@container`, and
 * layout containment makes it the reference frame for `position: fixed`; a sheet IN the tree would
 * cover only the content area.
 */
export function Sheet({ onClose, width, height, label, children, z = "z-[60]" }: {
  onClose: () => void;
  width: number;
  /** Fixed height (px, at most 86vh) — for a sheet that must not jump when switching tabs. */
  height?: number;
  label?: string;
  children: React.ReactNode;
  z?: string;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className={`cb-kit cb-overlay cb-overlay-in fixed inset-0 ${z} grid place-items-center p-3 sm:p-6`}
      onMouseDown={onClose}
    >
      <div
        className="cb-sheet cb-pop-in flex max-h-[86vh] max-w-[94vw] flex-col overflow-hidden rounded-3xl text-fg"
        style={{ width: `min(${width}px, calc(100vw - 2rem))`, ...(height ? { height: `min(${height}px, 86vh)` } : {}) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
