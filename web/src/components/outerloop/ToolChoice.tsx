"use client";

import type { ManagerMcpServer, ToolArea, ToolGroup } from "@/lib/api";
import { ghostSm, Hint, Empty, Segments } from "@/components/CbKit";
import { useT } from "@/lib/i18n";

// The tool choice — ONE component for the tool selection (groups, read level, external MCP servers), so that no second, half form of the
// same question can appear elsewhere. Its only user is the outer-loop editor; the catalog comes from the server, not from a second list here.

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";
const pane = "cb-kit-pane flex min-w-0 flex-col gap-2 rounded-2xl p-3.5";
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

// A small mark in a row (approval · writes · unclear).
function Marker({ children, tone = "dim" }: { children: React.ReactNode; tone?: "dim" | "accent" | "warn" | "ok" | "danger" }) {
  const color = { dim: "bg-edge text-dim", accent: "bg-accent/12 text-accent", warn: "bg-warn/15 text-warn", ok: "bg-ok/15 text-ok", danger: "bg-danger/12 text-danger" }[tone];
  return <span className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10px] font-semibold ${color}`}>{children}</span>;
}

/** The MCP choice in a fixed form (keys and lists sorted, empty lists dropped). */
export const normMcp = (m: Record<string, string[]>) => {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(m).sort()) if (m[k]?.length) out[k] = [...m[k]].sort();
  return out;
};
export const mcpCount = (m: Record<string, string[]>) => Object.values(m).reduce((n, l) => n + l.length, 0);

/** The built-in tools by areas and groups — with a read level where it separates something. */
export function ToolCatalogChoice({ areas, catalog, cbaseApproval, fenceDropped, tools, onTools }: {
  areas: ToolArea[];
  catalog: ToolGroup[];
  /** Approval marks of the cbase tools — only SHOWN here, they are set in `ApprovalMarksSection`. */
  cbaseApproval?: string[];
  /** Outer loop: groups whose tools ALL drop at the fence in project chats — only a mark, they stay selectable (they work in
   *  workspace chats). */
  fenceDropped?: string[];
  tools: string[];
  onTools: (tools: string[]) => void;
}) {
  const t = useT();
  return (
    <>
      <div className={pane}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={lab}>{t("Tools")}</span>
          <span className="text-[11.5px] text-dim">{t("{n} selected", { n: tools.length })}</span>
        </div>
        {areas.map((b) => (
          <div key={b.key} className="flex flex-col gap-1">
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[11px] font-semibold text-fg">{b.label}</span>
              <span className="text-[11px] text-dim">{b.description}</span>
            </div>
            <div className="grid gap-1.5 @2xl/detail:grid-cols-2">
              {catalog.filter((g) => g.area === b.key).map((g: ToolGroup) => {
                const read = g.read && g.read.length > 0 && g.read.length < g.tools.length ? g.read : null;
                const maintain = read ? g.tools.filter((x) => !read.includes(x)) : [];
                const set = (which: string[]) => onTools([...tools.filter((x) => !g.tools.includes(x)), ...which]);
                const on = g.tools.every((x) => tools.includes(x));
                const partial = !on && g.tools.some((x) => tools.includes(x));
                // Approval marks: not switchable here — the mark is set in `ApprovalMarksSection` and applies to every agent that has the
                // tool. This only shows THAT it applies.
                const marked = g.tools.filter((x) => (cbaseApproval ?? []).includes(x));
                const text = (
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">{g.label}{marked.length > 0 && <Marker tone="warn">{t("Approve##noun")}</Marker>}{(fenceDropped ?? []).includes(g.key) && <span title={t("In the project container the fence blocks these tools — they only work in chats without a project.")}><Marker>{t("dropped in project chats")}</Marker></span>}</span>
                    <span className="block text-[11px] leading-relaxed text-dim">{g.description}</span>
                    <span className="block truncate font-mono text-[10px] text-dim/80">
                      {read ? `${t("read")}: ${read.join(" · ")} — ${t("maintain")}: ${maintain.join(" · ")}` : g.tools.join(" · ")}
                    </span>
                    {marked.length > 0 && <span className="block truncate font-mono text-[10px] text-warn">{t("Approve##noun")}: {marked.join(" · ")}</span>}
                  </span>
                );
                if (read) {
                  // Three levels: Off · Read · Maintain — Maintain includes Read. One maintaining tool is enough for "Maintain"; otherwise
                  // it counts whether a reading one is there.
                  const stage = maintain.some((x) => tools.includes(x)) ? "maintain" : read.some((x) => tools.includes(x)) ? "read" : "off";
                  return (
                    <div key={g.key} data-tool-group={g.key} className={`flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors ${stage !== "off" ? "bg-accent/8" : ""}`}>
                      {text}
                      <Segments
                        label={g.label}
                        className="mt-0.5"
                        items={[
                          { key: "off", label: t("Off") },
                          { key: "read", label: t("Read"), title: read.join(", ") },
                          { key: "maintain", label: t("Maintain"), title: g.tools.join(", ") },
                        ]}
                        value={stage}
                        onChange={(k) => set(k === "maintain" ? g.tools : k === "read" ? read : [])}
                      />
                    </div>
                  );
                }
                return (
                  <label key={g.key} data-tool-group={g.key} className={`flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors ${on ? "bg-accent/8" : "hover:bg-hover"}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      ref={(el) => { if (el) el.indeterminate = partial; }}
                      onChange={(e) => set(e.target.checked ? g.tools : [])}
                      className="mt-0.5 accent-accent"
                    />
                    {text}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** The external MCP servers and their tools — the inventory lives on the "MCP" page. */
export function McpToolChoice({ server, mcp, onMcp, hint }: {
  server: ManagerMcpServer[];
  mcp: Record<string, string[]>;
  onMcp: (mcp: Record<string, string[]>) => void;
  /** The sentence under the heading (the outer-loop editor names Coding → MCP). */
  hint: string;
}) {
  const t = useT();
  const setMcp = (serverId: string, tools: string[]) => {
    const fresh = { ...mcp };
    if (tools.length) fresh[serverId] = tools; else delete fresh[serverId];
    onMcp(fresh);
  };
  return (
      <div data-mcp-choice-surface className={pane}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={lab}>{t("External MCP servers")}</span>
          <span className="text-[11.5px] text-dim">{t("{n} selected", { n: mcpCount(mcp) })}</span>
        </div>
        <p className="text-[11.5px] leading-relaxed text-dim">
          {hint}
        </p>
        {server.length === 0 && (
          <Empty title={t("No external MCP server yet")}>{t("On the “MCP” page you enter address and token; cbase then reads the tool list itself.")}</Empty>
        )}
        {server.map((srv) => {
          const choice = mcp[srv.id] || [];
          const unknown = choice.filter((n) => !srv.tools.some((w) => w.name === n));
          const all = srv.tools.map((w) => w.name);
          // Only what the server reports POSITIVELY as reading — anything unclear stays out.
          const reading = srv.tools.filter((w) => w.writing === false).map((w) => w.name);
          return (
            <div key={srv.id} className="flex flex-col gap-1.5 rounded-xl border border-edge/60 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-medium">{srv.name}</span>
                <span className="font-mono text-[10px] text-dim/80">mcp__{srv.key}__…</span>
                <span className="truncate text-[11px] text-dim">{hostOf(srv.url)}</span>
                <span className="text-[11px] text-dim">· {t("{n} of {m}", { n: choice.length, m: srv.tools.length })}</span>
                <span className="flex-1" />
                <button type="button" onClick={() => setMcp(srv.id, all)} disabled={!all.length} className={ghostSm}>{t("All")}</button>
                <button type="button" onClick={() => setMcp(srv.id, reading)} disabled={!reading.length} title={t("Only tools the server reports as read-only — unclear ones are left out")} className={ghostSm}>{t("Read-only")}</button>
                <button type="button" onClick={() => setMcp(srv.id, [])} disabled={!choice.length} className={ghostSm}>{t("None")}</button>
              </div>
              {srv.error && <Hint tone="warn">{srv.error}</Hint>}
              {!srv.tools.length && !srv.error && <span className="text-[11.5px] text-dim">{t("No tool list yet — reload on the “MCP” page.")}</span>}
              {(srv.tools.length > 0 || unknown.length > 0) && (
                <div className="grid gap-1 @2xl/detail:grid-cols-2">
                  {srv.tools.map((w) => {
                    const on = choice.includes(w.name);
                    return (
                      <label key={w.name} data-mcp-choice={`${srv.key}__${w.name}`} className={`flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-1.5 transition-colors ${on ? "bg-accent/8" : "hover:bg-hover"}`}>
                        <input type="checkbox" checked={on} onChange={(e) => setMcp(srv.id, e.target.checked ? [...choice, w.name] : choice.filter((x) => x !== w.name))} className="mt-0.5 accent-accent" />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5 font-mono text-[11.5px]">{w.name}{w.writing === true && <Marker tone="warn">{t("writes")}</Marker>}{w.writing === null && <Marker>{t("unclear")}</Marker>}{(srv.approval ?? []).includes(w.name) && <Marker tone="warn">{t("Approve##noun")}</Marker>}</span>
                          {w.description && <span className="block text-[11px] leading-relaxed text-dim">{w.description}</span>}
                        </span>
                      </label>
                    );
                  })}
                  {unknown.map((n) => (
                    <label key={n} className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-accent/8 px-2.5 py-1.5">
                      <input type="checkbox" checked onChange={() => setMcp(srv.id, choice.filter((x) => x !== n))} className="mt-0.5 accent-accent" />
                      <span className="flex flex-wrap items-center gap-1.5 font-mono text-[11.5px]">{n}<Marker>{t("not in the list")}</Marker></span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>  );
}
