"use client";

import { useEffect, useState } from "react";
import { api, type McpServer, type ProjectMcpServers } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Segments } from "@/components/CbKit";

// The coding MCP servers of an agent type (server toolchain/agent-mcp.js, computed in runs/agent-set.js codingSet): which servers
// a subagent of this type gets (even if "Subagents inherit" is off on the server) and, per server, all tools or a selection.
// Selectable are the servers the backend accepts: in a workspace those of the workspace, in a project those of the project too.
// The tools of a selection are those Coding → MCP releases for coding (the choice on the server cuts every agent anyway). A
// stored id that no server carries any more stays visible and can be unchecked, like an orphaned skill in the dialog.

/** Shape of the `mcp` field of a definition: serverId → null (all tools) | list (only these). */
export type AgentMcpChoice = Record<string, string[] | null>;

/** The selectable tools of a server: the cache minus what is deselected on the server. */
const toolsOf = (s: McpServer) => (s.tools || []).filter((w) => !Array.isArray(s.choice) || s.choice.includes(w.name));

export function AgentMcpChoiceList({ value, onChange, workspaceId, projectId }: {
  value: AgentMcpChoice;
  onChange: (w: AgentMcpChoice) => void;
  workspaceId: string;
  /** Set for a project type: the project's servers are added. */
  projectId: string | null;
}) {
  const t = useT();
  // `null` = not loaded yet (empty is not unknown: only after loading does the list say "no servers").
  const [server, setServer] = useState<McpServer[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = projectId
      ? api<ProjectMcpServers>(`/api/projects/${projectId}/mcp-servers`).then((r) => [...(r.projectServers || []), ...(r.workspaceServers || [])])
      : api<McpServer[]>(`/api/workspaces/${workspaceId}/mcp-servers`);
    load.then((l) => { if (!cancelled) setServer(l); }).catch((e) => { if (!cancelled) { setServer([]); setError(String((e as Error).message)); } });
    return () => { cancelled = true; };
  }, [workspaceId, projectId]);

  const set = (id: string, w: string[] | null | undefined) => {
    const fresh = { ...value };
    if (w === undefined) delete fresh[id];
    else fresh[id] = w;
    onChange(fresh);
  };
  const orphaned = server ? Object.keys(value).filter((id) => !server.some((s) => s.id === id)) : [];

  if (server === null) return <span className="rounded-xl bg-bg px-3 py-2 text-[12px] text-dim">{t("Loading MCP servers …")}</span>;
  if (!server.length && !orphaned.length) {
    return <span className="rounded-xl bg-bg px-3 py-2 text-[12px] text-dim">{error || t("No MCP servers here yet — create them under Coding → MCP.")}</span>;
  }
  return (
    <div className="flex flex-col rounded-xl bg-bg p-1" data-agent-mcp>
      {server.map((s) => {
        const on = Object.hasOwn(value, s.id);
        const selection = on ? value[s.id] : null;
        const tools = toolsOf(s);
        return (
          <div key={s.id} className={`rounded-lg px-2.5 py-1.5 transition-colors ${on ? "bg-accent/8" : "hover:bg-hover"}`} data-agent-mcp-server={s.name}>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" checked={on} onChange={(e) => set(s.id, e.target.checked ? null : undefined)} className="mt-0.5 accent-accent" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12.5px]">{s.name}{s.projectId ? <span className="ml-1.5 font-sans text-[11px] text-dim">· {t("Project")}</span> : null}</span>
                <span className="block truncate text-[11.5px] text-dim">
                  {!s.enabled || s.inWorkspaceActive === false
                    ? t("Switched off — a subagent only gets it once it is on again.")
                    : s.subagentsInherit
                      ? t("All subagents inherit it anyway — chosen here, the selection below applies to this type.")
                      : t("Main agent only — checked, every subagent of this type gets it.")}
                </span>
              </span>
            </label>
            {on && (
              <div className="mt-1.5 flex flex-col gap-1.5 pl-6">
                <Segments
                  items={[
                    { key: "all", label: t("All tools") },
                    { key: "selection", label: t("Selection"), n: Array.isArray(selection) ? selection.length : null },
                  ]}
                  value={selection === null ? "all" : "selection"}
                  onChange={(k) => set(s.id, k === "all" ? null : [])}
                  label={t("Tools of {name}", { name: s.name })}
                  className="w-fit"
                />
                {Array.isArray(selection) && (tools.length === 0 ? (
                  <span className="text-[11.5px] text-dim">{t("Tools not loaded yet — “Load tools” under Coding → MCP, then choose here.")}</span>
                ) : (
                  <div className="cb-scroll max-h-[200px] overflow-y-auto">
                    {tools.map((w) => {
                      const selected = selection.includes(w.name);
                      return (
                        <label key={w.name} className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-hover">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(e) => set(s.id, e.target.checked ? [...selection.filter((x) => x !== w.name), w.name] : selection.filter((x) => x !== w.name))}
                            className="mt-0.5 accent-accent"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[12px]">{w.name}</span>
                            {w.description && <span className="block truncate text-[11px] text-dim">{w.description}</span>}
                          </span>
                        </label>
                      );
                    })}
                    {selection.filter((n) => !tools.some((w) => w.name === n)).map((n) => (
                      <label key={n} className="flex cursor-pointer items-start gap-2.5 rounded-md bg-danger/8 px-1.5 py-1">
                        <input type="checkbox" checked onChange={() => set(s.id, selection.filter((x) => x !== n))} className="mt-0.5 accent-accent" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[12px]">{n}</span>
                          <span className="block text-[11px] text-danger">{t("The server does not offer this tool (any more).")}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
                {Array.isArray(selection) && selection.length === 0 && tools.length > 0 && (
                  <span className="text-[11.5px] text-dim">{t("Without a selected tool the type does not bring the server.")}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
      {orphaned.map((id) => (
        <label key={id} className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-danger/8 px-2.5 py-1.5">
          <input type="checkbox" checked onChange={() => set(id, undefined)} className="mt-0.5 accent-accent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[12.5px]">{id}</span>
            <span className="block text-[11.5px] text-danger">{t("This MCP server no longer exists here — uncheck it, otherwise saving is refused.")}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
