"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type McpCatalogEntry, type McpServer, type McpTransport, type ProjectMcpServers } from "@/lib/api";
import { McpIcon } from "@/components/McpIcon";
import { OriginSection, OriginMarker } from "@/components/Origin";
import { Toggle } from "@/components/CbKit";
import {
  Section, FACTS, Fact, Hint, Tile, LIST_ROW, EmptyRow, Menu, MenuEntry, Modal, ModalTitle, Point, COLUMN, SYM, PagesHeader,
  Segments, field, ghost, ghostSm, primary,
} from "@/components/CbKit";
import { useConfirm } from "@/components/Prompts";
import { McpToolsSheet } from "@/components/McpTools";
import { useT } from "@/lib/i18n";
import { counter } from "@/lib/mcp-tools";

// MCP servers. Workspace level: own servers (CRUD) + catalog. Project level: the project's OWN servers
// (isolated, CRUD + the same catalog) PLUS the workspace servers, which apply in every project and can be
// hidden there (opt-out like the credentials). Built-in servers (cbase/playwright) are always active.
//
// Form: the quiet page of the projects (blocks from the kit, CbKit.tsx). The page sits in the shared
// column (`COLUMN`) with the quiet page header; each group (Built-in, Your servers, Catalog, in a project the
// origin sections) is a `Section` with a small tile (built-in: lock, own servers: plug, catalog: boxes; in a
// project the origins as `OriginSection`). Rows are rounded and light up under the pointer. The brand logo
// stands in the row's tile (a disabled server steps back colourless, since a logo cannot be tinted by state),
// below it transport and command or URL as facts. A state word ("disabled", "off in project", "hidden",
// "off in workspace") only when it is not the normal case. Above the groups the summary ("3 servers · 2
// active"), the explanatory sentence without own servers or as a short note beside it. The editor is a `Modal`.
//
// Per server "Tools" (sheet McpTools.tsx: choice, cards, "Subagents inherit"; the counter is a fact in the
// row), read-only in a project for a workspace server; in the editor, for http/sse the headers: name and
// hidden value, after saving only "set". Per header only the change is sent (`{Name: "value"}` new or
// overwritten, `{Name: null}` removed); a value never comes back.
const BUILTINS = [
  { name: "cbase", label: "cbase", desc: "Projects, context, artifacts, ports & credentials — cbase's own tools." },
  { name: "playwright", label: "Playwright", desc: "Browser automation for debugging (official @playwright/mcp)." },
];

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";

type Draft = {
  id: string | null; // null = new server
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string; // one line per argument
  envText: string; // KEY=VALUE per line
  url: string;
  enabled: boolean;
  hint?: string; // catalog hint (e.g. "enter token")
  headerInventory: string[]; // stored headers (names only; values never come back)
  headerAway: string[]; // marked for removal
  headerNew: { name: string; value: string }[]; // new or overwritten
};

const WITHOUT_HEADER = { headerInventory: [], headerAway: [], headerNew: [] };
const emptyDraft = (): Draft => ({ id: null, name: "", transport: "stdio", command: "npx", argsText: "", envText: "", url: "", enabled: true, ...WITHOUT_HEADER });

const envToText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
};
const parseArgs = (text: string) => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
/** The draft's header change: new or overwritten with a value, removed with null; `undefined` if nothing changed. */
function headerChange(d: Draft): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  for (const n of d.headerAway) out[n] = null;
  for (const k of d.headerNew) if (k.name.trim()) out[k.name.trim()] = k.value;
  return Object.keys(out).length ? out : undefined;
}

function draftFromServer(s: McpServer): Draft {
  return { id: s.id, name: s.name, transport: s.transport, command: s.command || "npx", argsText: (s.args || []).join("\n"), envText: envToText(s.env || {}), url: s.url || "", enabled: s.enabled,
    ...WITHOUT_HEADER, headerInventory: (s.headers || []).map((k) => k.name) };
}
function draftFromCatalog(c: McpCatalogEntry): Draft {
  const remote = c.transport === "http" || c.transport === "sse";
  return { id: null, name: c.key, transport: c.transport, command: remote ? "" : (c.command || "npx"), argsText: (c.args || []).join("\n"), envText: envToText(c.env || {}), url: c.url || "", enabled: true, hint: c.needs || undefined, ...WITHOUT_HEADER };
}

/** A server's symbol in the row's tile: the brand logo or the plug; a disabled server steps back colourless,
 *  since a logo cannot be tinted by state. */
function ServerTile({ name, disabled: off = false, title }: { name: string; disabled?: boolean; title?: string }) {
  return (
    <Tile title={title} data={{ "data-mcp-tile": off ? "off" : "on" }}>
      <span className={`flex transition-[filter,opacity] ${off ? "opacity-45 grayscale" : ""}`}><McpIcon name={name} size={20} /></span>
    </Tile>
  );
}

/** One row of the list: rounded, light under the pointer, no hairline. */
const ROW = `${LIST_ROW} items-center hover:bg-hover`;
/** The name of a row: 14 px, medium weight. */
const NAME = "min-w-0 truncate text-[14px] font-medium tracking-[-0.01em]";
/** The rows of a group, stacked. */
const LIST = "flex shrink-0 flex-col gap-0.5";

export function McpServersPane({ workspaceId, projectId = null, onChanged }: { workspaceId: string; projectId?: string | null; onChanged?: () => void }) {
  const t = useT();
  const question = useConfirm();
  // `servers` = the servers in the current scope (workspace servers OR, in a project, the project's own
  // servers). `wsAdopt` = in a project: the workspace servers with their adoption status.
  const [servers, setServers] = useState<McpServer[]>([]);
  const [wsAdopt, setWsAdopt] = useState<McpServer[]>([]);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toolsOf, setToolsOf] = useState<{ server: McpServer; onlyRead: boolean } | null>(null);

  const isProj = !!projectId;

  const load = useCallback(async () => {
    if (projectId) {
      const [r, c] = await Promise.all([
        api<ProjectMcpServers>(`/api/projects/${projectId}/mcp-servers`),
        api<McpCatalogEntry[]>(`/api/mcp-catalog`).catch(() => [] as McpCatalogEntry[]),
      ]);
      setServers(r.projectServers || []);
      setWsAdopt(r.workspaceServers || []);
      setCatalog(c);
      return;
    }
    const [s, c] = await Promise.all([
      api<McpServer[]>(`/api/workspaces/${workspaceId}/mcp-servers`),
      api<McpCatalogEntry[]>(`/api/mcp-catalog`).catch(() => [] as McpCatalogEntry[]),
    ]);
    setServers(s);
    setWsAdopt([]);
    setCatalog(c);
  }, [workspaceId, projectId]);

  useEffect(() => {
    load().catch((e) => setError(String((e as Error).message)));
  }, [load]);

  // Enable/disable an own server (workspace-wide or, in a project, active for this project).
  async function toggleServer(s: McpServer) {
    setServers((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await api(`/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) });
      onChanged?.();
    } catch {
      load().catch(() => {});
    }
  }

  // Hide/unhide a workspace server in the project (opt-out).
  async function toggleAdopt(s: McpServer) {
    if (!projectId) return;
    setWsAdopt((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await api(`/api/projects/${projectId}/mcp-servers/${s.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) });
      onChanged?.();
    } catch {
      load().catch(() => {});
    }
  }

  async function removeServer(s: McpServer) {
    if (!(await question(t("Remove MCP server \"{name}\"?", { name: s.name }), { ok: t("Remove"), danger: true }))) return;
    await api(`/api/mcp-servers/${s.id}`, { method: "DELETE" });
    load().catch(() => {});
    onChanged?.();
  }

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    setError("");
    const body =
      draft.transport === "stdio"
        ? { name: draft.name, transport: "stdio", command: draft.command, args: parseArgs(draft.argsText), env: parseEnv(draft.envText), enabled: draft.enabled }
        : { name: draft.name, transport: draft.transport, url: draft.url, enabled: draft.enabled, ...(headerChange(draft) ? { headers: headerChange(draft) } : {}) };
    try {
      if (draft.id) await api(`/api/mcp-servers/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else if (projectId) await api(`/api/projects/${projectId}/mcp-servers`, { method: "POST", body: JSON.stringify(body) });
      else await api(`/api/workspaces/${workspaceId}/mcp-servers`, { method: "POST", body: JSON.stringify(body) });
      setDraft(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  }

  const summary = (s: McpServer) =>
    s.transport === "stdio" ? [s.command, ...(s.args || [])].join(" ") : s.url;

  const closeEditor = () => { setDraft(null); setError(""); };

  // Above the list the summary as soon as there are own or adoptable servers; otherwise (and as a short note
  // beside it) the explanatory sentence. The built-in ones do not count; they are always there.
  const explanation = isProj
    ? t("Your own MCP servers for this project (other projects don't see them; workspace chats do). The workspace servers below apply in every project and can be hidden here for this project. In this project's chats the agent has access to its own servers and the ones not hidden — effective from the next run.")
    : t("Like in Claude Desktop: add external MCP servers per workspace. Enabled servers are available to the agent in all chats of this workspace — effective from the next run.");
  const summaryText = isProj
    ? [
        t("{n} own", { n: servers.length }),
        t("{n} of {m} from the workspace active", { n: wsAdopt.filter((s) => s.enabled && s.inWorkspaceActive !== false).length, m: wsAdopt.length }),
      ].join(" · ")
    : [t("{n} servers", { n: servers.length }), t("{n} active", { n: servers.filter((s) => s.enabled).length })].join(" · ");

  // The servers in the current scope (workspace servers or own project servers); in a project under the origin section.
  const own = (
    <div className={LIST}>
      {servers.length === 0 && (
        <EmptyRow>
          {isProj ? t("No project servers yet. Add one or pick from the catalog below.") : t("No MCP servers yet. Add one or pick from the catalog below.")}
        </EmptyRow>
      )}
      {servers.map((s) => (
        <div key={s.id} className={ROW} data-mcp-server={s.name}>
          <ServerTile name={s.name} disabled={!s.enabled} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className={`${NAME} ${s.enabled ? "" : "text-dim"}`}>{s.name}</span>
              {!s.enabled && <span className="shrink-0 text-[12px] text-dim">{isProj ? t("off in project") : t("disabled")}</span>}
            </div>
            <span className={`mt-0.5 ${FACTS}`}>
              <Fact symbol={SYM.plug(12)} className="shrink-0"><span className="font-mono text-[11.5px]">{s.transport}</span></Fact>
              <ToolFact s={s} onClick={() => setToolsOf({ server: s, onlyRead: false })} />
              <span className="min-w-0 truncate font-mono text-[11.5px]" title={summary(s)}>{summary(s)}</span>
            </span>
          </div>
          <Toggle on={s.enabled} onClick={() => toggleServer(s)} title={isProj ? (s.enabled ? t("Active in project") : t("Inactive in project")) : s.enabled ? t("Enabled") : t("Disabled")} />
          <Menu label={t("More")} silent>
            <MenuEntry label={t("Tools")} onClick={() => setToolsOf({ server: s, onlyRead: false })} />
            <MenuEntry label={t("Edit")} onClick={() => { setError(""); setDraft(draftFromServer(s)); }} />
            <MenuEntry label={t("Remove")} onClick={() => removeServer(s)} danger />
          </Menu>
        </div>
      ))}
    </div>
  );

  return (
    <div className={`${COLUMN} flex min-h-0 flex-col pb-8`}>
      <PagesHeader
        title={isProj ? t("Project MCP servers") : t("MCP servers")}
        under={servers.length + wsAdopt.length > 0
          ? <span className="tabular-nums" title={explanation} data-mcp-summary>{summaryText}</span>
          : explanation}
      >
        <button type="button" onClick={() => { setError(""); setDraft(emptyDraft()); }} className={primary}>+ Server</button>
      </PagesHeader>
      {error && !draft && <div className="pb-5"><Hint tone="danger">{error}</Hint></div>}

      {toolsOf && (
        <McpToolsSheet
          server={toolsOf.server}
          onlyRead={toolsOf.onlyRead}
          onClose={() => { setToolsOf(null); load().catch(() => {}); }}
          onChanged={() => onChanged?.()}
        />
      )}

      {/* Editor: sheet on the body. */}
      {draft && (
        <Modal onClose={closeEditor} width={560} label={draft.id ? t("Edit server") : t("New MCP server")}>
          <ModalTitle>{draft.id ? t("Edit server") : isProj ? t("New project MCP server") : t("New MCP server")}</ModalTitle>
          {draft.hint && <div className="mb-3"><Hint tone="warn">{t(draft.hint)}</Hint></div>}
          <div className="grid gap-3">
            <label className="flex flex-col gap-1">
              <span className={lab}>Name</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("e.g. github")} className={`${field} w-full`} />
            </label>
            <div className="flex flex-col gap-1">
              <span className={lab}>{t("Type")}</span>
              <Segments
                items={(["stdio", "http", "sse"] as McpTransport[]).map((tp) => ({ key: tp, label: tp === "stdio" ? t("stdio (local)") : tp.toUpperCase() }))}
                value={draft.transport}
                onChange={(k) => setDraft({ ...draft, transport: k as McpTransport })}
              />
            </div>
            {draft.transport === "stdio" ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className={lab}>Command</span>
                  <input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" className={`${field} w-full font-mono`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={lab}>{t("Arguments")} <span className="font-normal normal-case tracking-normal">{t("(one line per argument)")}</span></span>
                  <textarea value={draft.argsText} onChange={(e) => setDraft({ ...draft, argsText: e.target.value })} rows={3} placeholder={"-y\n@modelcontextprotocol/server-github"} className={`${field} w-full resize-y font-mono`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={lab}>{t("Environment variables")} <span className="font-normal normal-case tracking-normal">{t("(KEY=VALUE per line)")}</span></span>
                  <textarea value={draft.envText} onChange={(e) => setDraft({ ...draft, envText: e.target.value })} rows={2} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=…" className={`${field} w-full resize-y font-mono`} />
                </label>
              </>
            ) : (
              <label className="flex flex-col gap-1">
                <span className={lab}>URL</span>
                <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…" className={`${field} w-full font-mono`} />
              </label>
            )}
            {draft.transport !== "stdio" && <HeadersField draft={draft} setDraft={setDraft} />}
            <label className="flex items-center gap-2.5 text-[13px]">
              <Toggle on={draft.enabled} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })} />
              {t("Enabled")}
            </label>
            {error && <Hint tone="danger">{error}</Hint>}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={closeEditor} className={ghost}>{t("Cancel")}</button>
            <button type="button" onClick={saveDraft} disabled={saving} className={`${primary} disabled:opacity-50`}>
              {saving ? t("Saving…") : t("Save")}
            </button>
          </div>
        </Modal>
      )}

      <div className="flex flex-col gap-8">
      {/* Built-in servers (always connected, not removable) */}
      <Section symbol={SYM.padlock(15)} title={t("Built-in")} data={{ "data-mcp-group": "builtin" }}>
        <div className={LIST}>
          {BUILTINS.map((b) => (
            <div key={b.name} className={ROW} title={t("Built-in — always active, not removable")}>
              <ServerTile name={b.name} />
              <div className="min-w-0 flex-1">
                <span className={`block ${NAME}`}>{b.label}</span>
                <span className={`mt-0.5 ${FACTS}`}>
                  <Fact className="shrink-0 text-ok"><Point color="bg-ok" />{isProj ? t("always active") : t("connected")}</Fact>
                  <span className="min-w-0 truncate">{t(b.desc)}</span>
                </span>
              </div>
              <span className="shrink-0 text-[12px] text-dim">{t("built-in")}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Servers in the current scope (workspace servers or own project servers). In a project this is the origin
          section (Origin.tsx): own first, the workspace set off below. */}
      {isProj
        ? <OriginSection kind="project">{own}</OriginSection>
        : <Section symbol={SYM.plug(15)} title={t("Your servers")} data={{ "data-mcp-group": "own" }}>{own}</Section>}

      {/* Catalog: rounded rows without hairlines (two columns from @3xl/kit), a click creates the draft. An entry that
          was already added is locked and does not light up on hover (no `group`/`hover:` and no pointer events). */}
      {catalog.length > 0 && (
        <Section symbol={SYM.catalog(15)} title={t("Catalog — 1 click to add")} data={{ "data-mcp-group": "catalog" }}>
          <div className="grid shrink-0 gap-0.5 @3xl/kit:grid-cols-2 @3xl/kit:gap-x-4">
            {catalog.map((c) => {
              const installed = servers.some((s) => s.name === c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  disabled={installed}
                  onClick={() => { setError(""); setDraft(draftFromCatalog(c)); }}
                  className={`${LIST_ROW} items-start ${installed ? "pointer-events-none cursor-default" : "hover:bg-hover"}`}
                >
                  <ServerTile name={c.key} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`text-[14px] font-medium tracking-[-0.01em] ${installed ? "text-dim" : ""}`}>{t(c.label)}</span>
                      {installed && <span className="shrink-0 text-[12px] text-ok">{t("added")}</span>}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-dim">{t(c.description)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {/* Project: the workspace servers (they apply in every project and can be hidden here) as an origin section of
          their own, rows with the workspace marker and one step quieter. One disabled workspace-wide is also missing here: the word "off in workspace". */}
      {isProj && (
        <OriginSection kind="workspace" hint={t("Applies in every project — can be hidden here for this project. (Create/edit at the workspace level.)")}>
          <div className={LIST}>
          {wsAdopt.length === 0 ? (
            <EmptyRow>{t("No workspace MCP servers available.")}</EmptyRow>
          ) : (
            wsAdopt.map((s) => (
              <div key={s.id} className={ROW}>
                <ServerTile name={s.name} disabled={!s.enabled || s.inWorkspaceActive === false} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`${NAME} ${s.enabled && s.inWorkspaceActive !== false ? "text-fg/90" : "text-dim"}`}>{s.name}</span>
                    <OriginMarker kind="workspace" />
                    {!s.enabled ? <span className="shrink-0 text-[12px] text-dim">{t("hidden")}</span>
                      : s.inWorkspaceActive === false && <span className="shrink-0 text-[12px] text-dim">{t("off in the workspace")}</span>}
                  </div>
                  <span className={`mt-0.5 ${FACTS}`}>
                    <Fact symbol={SYM.plug(12)} className="shrink-0"><span className="font-mono text-[11.5px]">{s.transport}</span></Fact>
                    <ToolFact s={s} onClick={() => setToolsOf({ server: s, onlyRead: true })} />
                    <span className="min-w-0 truncate font-mono text-[11.5px]" title={summary(s)}>{summary(s)}</span>
                  </span>
                </div>
                <Toggle on={!!s.enabled} onClick={() => toggleAdopt(s)} title={s.enabled ? t("Available — click to hide") : t("Hidden — click to show")} />
              </div>
            ))
          )}
          </div>
        </OriginSection>
      )}
      </div>
    </div>
  );
}

/** A row's tool state as a clickable fact: "7 of 36 tools" (with cards), "Load tools" or the error. */
function ToolFact({ s, onClick }: { s: McpServer; onClick: () => void }) {
  const t = useT();
  const w = s.tools || [];
  const z = counter(w, s.choice === undefined ? null : s.choice, s.markers || []);
  const text = w.length
    ? `${t("{n} of {m} tools", { n: z.free, m: z.total })}${z.card ? ` · ${t("{n} with a card", { n: z.card })}` : ""}`
    : s.toolsError ? t("Tools: error") : t("Tools");
  return (
    <button type="button" onClick={onClick} className={`shrink-0 tabular-nums hover:text-fg ${!w.length && s.toolsError ? "text-danger" : ""}`} data-mcp-tool-fact>
      {text}
    </button>
  );
}

/** The headers of an http/sse server in the editor: stored ones with name only ("set", remove), new ones with a hidden value. */
function HeadersField({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const t = useT();
  const inventory = draft.headerInventory.filter((n) => !draft.headerAway.includes(n));
  return (
    <div className="flex flex-col gap-1.5" data-mcp-headers>
      <span className={lab}>{t("Headers")} <span className="font-normal normal-case tracking-normal">{t("(e.g. Authorization — the value never leaves the server)")}</span></span>
      {inventory.map((n) => (
        <div key={n} className="flex items-center gap-2 text-[13px]" data-mcp-header={n}>
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{n}</span>
          <span className="text-[12px] text-dim">{t("set")}</span>
          <button type="button" className={ghostSm} onClick={() => setDraft({ ...draft, headerAway: [...draft.headerAway, n] })}>{t("Remove")}</button>
        </div>
      ))}
      {draft.headerNew.map((k, i) => (
        <div key={i} className="flex items-center gap-2">
          <input value={k.name} onChange={(e) => setDraft({ ...draft, headerNew: draft.headerNew.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Authorization" className={`${field} w-40 shrink-0 font-mono`} />
          <input type="password" autoComplete="off" value={k.value} onChange={(e) => setDraft({ ...draft, headerNew: draft.headerNew.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} placeholder={t("Value")} className={`${field} min-w-0 flex-1 font-mono`} />
          <button type="button" className={ghostSm} onClick={() => setDraft({ ...draft, headerNew: draft.headerNew.filter((_, j) => j !== i) })}>{t("Remove")}</button>
        </div>
      ))}
      <div>
        <button type="button" className={ghostSm} onClick={() => setDraft({ ...draft, headerNew: [...draft.headerNew, { name: "", value: "" }] })}>{t("+ Header")}</button>
      </div>
    </div>
  );
}
