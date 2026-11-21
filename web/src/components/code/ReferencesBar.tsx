"use client";

// The fourth mode of the left bar: "References" (editor navigation as in VS Code), next to explorer, search, outline, in
// Coding → Files as in the chat's code tabs (there the bar is a drawer in the narrow area, components/CodePane.tsx). Shows the
// result of the editor (components/code/navigation-connection.tsx):
//
// - Find All References/Implementations: hits grouped by file (lib/navigation.ts `groupedByFile`), expandable, with a line preview
//   (components/code/lsp-nav-core.ts `rowLoader`); a click opens the hit as a tab (history entry).
// - Call hierarchy: a tree from the symbol, incoming/outgoing switch; a node expands through `call_hierarchy` with its `item`
//   (`data` goes back unchanged), asked via the file in which the hierarchy began (it determines language and session).
//   A click opens, for incoming, the call site in the caller; for outgoing, the callee's definition.
import { useEffect, useRef, useState } from "react";
import { lspCalls, isNotSupported, symbolKind, type LspCall, type LspCallItem, type LspLocation } from "@/lib/api";
import { groupedByFile, pathParts, previewParts, rowOf, type FileGroup } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { Overline, Segments } from "@/components/CbKit";
import { rowLoader, type NavConnection, type ReferenceResult } from "@/components/code/lsp-nav-core";

type T = ReturnType<typeof useT>;
const ROW = "mx-1 flex w-[calc(100%-0.5rem)] min-w-0 items-center gap-1.5 rounded-lg py-[3px] pr-2 text-left text-[12px] transition-colors hover:bg-hover";

export function ReferencesBar({ result, connection, onClear }: { result: ReferenceResult | null; connection: NavConnection; onClear: () => void }) {
  const t = useT();
  if (!result) {
    return (
      <div className="cb-scroll min-h-0 flex-1 overflow-auto py-1" data-code-references="">
        <div className="px-3 pt-1"><Overline>{t("References")}</Overline></div>
        <div className="px-3 py-2 text-[12px] text-dim">{t("“Find All References” (⌥⇧F12) or “Show Call Hierarchy” (⌥⇧H) in the editor’s context menu fills this list.")}</div>
      </div>
    );
  }
  const title = result.kind === "references" ? t("References") : result.kind === "implementations" ? t("Implementations") : t("Call Hierarchy");
  return (
    <div className="cb-scroll min-h-0 flex-1 overflow-auto py-1" data-code-references={result.kind}>
      <div className="flex items-center gap-1 px-3 pt-1">
        <div className="min-w-0 flex-1"><Overline>{title}</Overline></div>
        <button type="button" onClick={onClear} title={t("Close result")} aria-label={t("Close result")} className="mb-1.5 grid h-5 w-5 place-items-center rounded text-dim hover:bg-hover hover:text-fg">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
        </button>
      </div>
      {result.kind === "calls"
        ? <CallTree key={result.seq} t={t} e={result} connection={connection} />
        : <HitsList key={result.seq} t={t} e={result} connection={connection} />}
    </div>
  );
}

function HitsList({ t, e, connection }: { t: T; e: Extract<ReferenceResult, { locations: LspLocation[] }>; connection: NavConnection }) {
  const [groups] = useState<FileGroup[]>(() => groupedByFile(e.locations));
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Record<string, string[] | null>>({});
  useEffect(() => {
    let alive = true;
    const read = rowLoader(e.target, e.source); // canonical: the locations are relative to the target of the asking buffer
    for (const g of groups) void read(g.file, g.extern).then((z) => { if (alive) setRows((v) => ({ ...v, [g.file]: z })); });
    return () => { alive = false; };
  }, [groups, e.target, e.source]);
  const count = groups.reduce((n, g) => n + g.locations.length, 0);
  return (
    <>
      <div className="px-3 pb-1 text-[12px] text-dim">
        {e.symbol ? <span className="font-mono text-fg">{e.symbol}</span> : null}{e.symbol ? " · " : ""}{t("{count} matches in {files} files", { count: count, files: groups.length })}
      </div>
      <div role="tree">
        {groups.map((g) => {
          const open = !closed.has(g.file);
          const { name, folder } = pathParts(g.file);
          return (
            <div key={g.file} role="treeitem" aria-expanded={open}>
              <button type="button" onClick={() => setClosed((v) => { const n = new Set(v); if (n.has(g.file)) n.delete(g.file); else n.add(g.file); return n; })} title={g.file} className={`${ROW} pl-2`}>
                <Arrow open={open} />
                <span className="shrink-0 font-medium">{name}</span>
                <span className="min-w-0 flex-1 truncate text-dim">{g.extern ? t("outside the project") : folder}</span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-dim">{g.locations.length}</span>
              </button>
              {open && g.locations.map((o, i) => (
                <HitsRow key={i} location={o} row={rows[g.file]?.[o.range.start.line]} onClick={() => void connection.open(e.target, o)} />
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

function HitsRow({ location, row, onClick }: { location: LspLocation; row: string | undefined; onClick: () => void }) {
  const parts = row === undefined ? null
    : previewParts(row, location.range.start.character, location.range.end.line === location.range.start.line ? location.range.end.character : row.length);
  return (
    <button type="button" onClick={onClick} className={`${ROW} pl-7`} data-code-hits="">
      <span className="w-8 shrink-0 text-right tabular-nums text-dim">{rowOf(location.range)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
        {parts ? <>{parts.before}<mark className="rounded-[2px] bg-accent/20 text-inherit">{parts.hits}</mark>{parts.after}</> : null}
      </span>
    </button>
  );
}

type Node = { status: "loading" | "loaded" | "error"; calls: LspCall[]; error?: string };
function CallTree({ t, e, connection }: { t: T; e: Extract<ReferenceResult, { kind: "calls" }>; connection: NavConnection }) {
  const [direction, setDirection] = useState(e.direction);
  // Per node (path of indices, "" = the root) its calls; expanded = listed in `open`.
  const [node, setNode] = useState<Record<string, Node>>({ "": { status: "loaded", calls: e.calls } });
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  // One run per direction: a late answer of the old direction would otherwise land under the same node id in the new tree.
  const run = useRef(0);
  const load = (id: string, item: LspCallItem, r: "incoming" | "outgoing") => {
    const seq = run.current;
    const set = (k: Node) => { if (seq === run.current) setNode((v) => ({ ...v, [id]: k })); };
    set({ status: "loading", calls: [] });
    lspCalls(e.target, "call_hierarchy", { file: e.source, item, direction: r })
      .then((a) => set(isNotSupported(a) ? { status: "error", calls: [], error: t("The language service is not available for this file right now.") } : { status: "loaded", calls: a.calls ?? [] }))
      .catch((f: unknown) => set({ status: "error", calls: [], error: String((f as Error)?.message ?? f) }));
  };
  const changeOver = (r: string) => {
    const fresh = r === "outgoing" ? "outgoing" : "incoming";
    if (fresh === direction) return;
    run.current += 1;
    setDirection(fresh);
    setNode({});
    setOpen(new Set([""]));
    load("", e.root, fresh);
  };
  const toggle = (id: string, item: LspCallItem) => {
    const on = !open.has(id);
    setOpen((v) => { const n = new Set(v); if (on) n.add(id); else n.delete(id); return n; });
    if (on && !node[id]) load(id, item, direction);
  };
  // Incoming: the call site in the caller; outgoing: the callee's definition (the sites lie in the caller there).
  const target = (c: LspCall): LspLocation => ({
    file: c.item.file, range: direction === "incoming" && c.ranges[0] ? c.ranges[0] : c.item.selectionRange, ...(c.item.external ? { external: c.item.external } : {}),
  });
  const show = (id: string, depth: number): React.ReactNode => {
    const k = node[id];
    if (!k) return null;
    if (k.status === "loading") return <div className="py-[3px] text-[12px] text-dim" style={{ paddingLeft: 26 + depth * 12 }}>{t("Loading…##inline")}</div>;
    if (k.status === "error") return <div className="py-[3px] pr-2 text-[12px] text-danger" style={{ paddingLeft: 26 + depth * 12 }}>{k.error}</div>;
    if (!k.calls.length) return <div className="py-[3px] text-[12px] text-dim" style={{ paddingLeft: 26 + depth * 12 }}>{t("No calls.")}</div>;
    return k.calls.map((c, i) => {
      const kid = id ? `${id}/${i}` : String(i);
      const on = open.has(kid);
      const { name } = pathParts(c.item.file);
      return (
        <div key={kid} role="treeitem" aria-expanded={on}>
          <div className="mx-1 flex w-[calc(100%-0.5rem)] min-w-0 items-center rounded-lg transition-colors hover:bg-hover" style={{ paddingLeft: 4 + depth * 12 }}>
            <button type="button" onClick={() => toggle(kid, c.item)} aria-label={on ? t("Collapse") : t("Expand")} className="grid h-5 w-5 shrink-0 place-items-center text-dim hover:text-fg"><Arrow open={on} /></button>
            <button type="button" onClick={() => void connection.open(e.target, target(c))} title={`${c.item.file}:${rowOf(c.item.selectionRange)}`} className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] pr-2 text-left text-[12px]">
              <span className="shrink-0 font-mono text-[11.5px]">{c.item.name}</span>
              <span className="min-w-0 flex-1 truncate text-dim">{c.item.detail || `${name}:${rowOf(c.item.selectionRange)}`}</span>
              {c.ranges.length > 1 && <span className="shrink-0 text-[10.5px] tabular-nums text-dim">{c.ranges.length}</span>}
            </button>
          </div>
          {on && show(kid, depth + 1)}
        </div>
      );
    });
  };
  const w = e.root;
  return (
    <>
      <div className="px-3 pb-1.5">
        <Segments
          label={t("Direction")}
          value={direction}
          onChange={changeOver}
          items={[{ key: "incoming", label: t("Incoming"), title: t("Incoming Calls") }, { key: "outgoing", label: t("Outgoing"), title: t("Outgoing Calls") }]}
        />
      </div>
      <div role="tree">
        <div role="treeitem" aria-expanded>
          <button type="button" onClick={() => void connection.open(e.target, { file: w.file, range: w.selectionRange, ...(w.external ? { external: w.external } : {}) })} title={w.file} className={`${ROW} pl-2`}>
            <Arrow open />
            <span className="shrink-0 font-mono text-[11.5px] font-medium">{w.name}</span>
            <span className="min-w-0 flex-1 truncate text-dim">{symbolKind(w.kind)}{w.detail ? ` · ${w.detail}` : ""}</span>
          </button>
          {show("", 1)}
        </div>
      </div>
    </>
  );
}

function Arrow({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
      className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}><path d="M9 18l6-6-6-6" /></svg>
  );
}

/** The mode's icon in the bar (two arrows to a point: "who points here"). */
export function ReferencesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="17" cy="12" r="3" /><path d="M3 6h7l3 4" /><path d="M3 18h7l3-4" />
    </svg>
  );
}
