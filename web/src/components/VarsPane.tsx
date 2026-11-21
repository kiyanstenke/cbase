"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type WorkspaceVar } from "@/lib/api";
import { useConfirm } from "@/components/Prompts";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { OriginSection, OriginMarker } from "@/components/Origin";
import { Toggle } from "@/components/CbKit";
import {
  SELECTED, Hint, Tile, LIST_ROW, EmptySentence, EmptyRow, Menu, MenuEntry, Modal, ModalTitle, COLUMN, SYM, PagesHeader, Segments,
  field, ghost, primary,
} from "@/components/CbKit";
import { useT } from "@/lib/i18n";

// Credentials & variables: secrets (masked), variables, links and FREE TEXT. Serves workspace (/api/workspaces/:id) or
// project credentials (/api/projects/:id), depending on `basePath`.
// Every entry has an MCP toggle — Claude can read only shared values via cbase_vars_get; the list (without values) it
// always sees (discovery).
//
// "Free text" is the block for everything that does not fit ONE value: a whole database or server access as it stands
// somewhere — name, host, port, user, password, URL, notes. Deliberately WITHOUT a field schema: only whoever enters an
// access knows which fields it has, and a six-field form already fails for the second access. It is hidden like a
// secret and expands in place (`data-open`, the same idiom as facts and tasks).
//
// Shape (the form of the instances, kit): no hairlines, rounded rows, light under the pointer; the kind sits in a tile,
// its colour is the state — green for shared with the agent (in a project for workspace entries: available), dimmed for
// blocked or hidden; "blocked for the agent" as a word only if it is so. An expanded free text carries the accent
// tint on its header (`SELECTED`, plus `data-open`), the block sits in the kit fields' tub below. Above the list the
// summary ("6 entries · 4 shared with the agent"), the explanatory sentence with cbase_vars_list/_get on an empty list
// or as a tooltip on it; in a project the origins as `OriginSection`.
export function VarsPane({
  basePath,
  scope = "workspace",
  onChanged,
}: {
  basePath: string;
  scope?: "workspace" | "project";
  onChanged?: () => void;
}) {
  const t = useT();
  const question = useConfirm();
  const [vars, setVars] = useState<WorkspaceVar[]>([]);
  const [wsVars, setWsVars] = useState<WorkspaceVar[]>([]); // project mode: adoptable workspace credentials
  const [filter, setFilter] = useState<"all" | "secret" | "variable" | "link" | "freeText">("all");
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<{
    editing: number | null;
    key: string;
    kind: WorkspaceVar["kind"];
    value: string;
    description: string;
    mcpAccess: boolean;
  } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setVars(await api<WorkspaceVar[]>(`${basePath}/vars`));
    if (scope === "project") {
      setWsVars(await api<WorkspaceVar[]>(`${basePath}/workspace-vars`).catch(() => []));
    }
  }, [basePath, scope]);

  useEffect(() => {
    setRevealed(new Set());
    load().catch(console.error);
  }, [load]);

  async function toggleAdopt(v: WorkspaceVar) {
    setWsVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await api(`${basePath}/workspace-vars/${v.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: !v.enabled }) });
      onChanged?.();
    } catch {
      load().catch(() => {});
    }
  }

  const shown = filter === "all" ? vars : vars.filter((v) => v.kind === filter);
  const count = (k: WorkspaceVar["kind"]) => vars.filter((v) => v.kind === k).length;

  async function save() {
    if (!draft) return;
    setError("");
    const body = {
      key: draft.key.trim(),
      kind: draft.kind,
      value: draft.value,
      description: draft.description.trim(),
      mcpAccess: draft.mcpAccess,
    };
    try {
      if (draft.editing === null) {
        await api(`${basePath}/vars`, { method: "POST", body: JSON.stringify(body) });
      } else {
        await api(`${basePath}/vars/${draft.editing}`, { method: "PUT", body: JSON.stringify(body) });
      }
      setDraft(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  async function toggleMcp(v: WorkspaceVar) {
    await api(`${basePath}/vars/${v.id}`, { method: "PUT", body: JSON.stringify({ mcpAccess: !v.mcpAccess }) });
    await load();
  }

  async function remove(v: WorkspaceVar) {
    if (!(await question(t("Delete \"{key}\"?", { key: v.key }), { ok: t("Delete"), danger: true }))) return;
    await api(`${basePath}/vars/${v.id}`, { method: "DELETE" });
    await load();
    onChanged?.();
  }

  async function copy(v: WorkspaceVar) {
    await navigator.clipboard.writeText(v.value);
    setCopied(v.id);
    setTimeout(() => setCopied((c) => (c === v.id ? null : c)), 1200);
  }

  function toggleReveal(id: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // The kind as a symbol in the tile: the shape distinguishes secret, free text, link and variable, the colour the
  // state — green for shared with the agent (in a project for workspace entries: available), dimmed for blocked or hidden.
  const kindSymbol = (v: WorkspaceVar, enabled: boolean) => (
    <Tile color={enabled ? "text-ok" : "text-dim"} title={t(KIND_LABEL[v.kind])} data={{ "data-var-tile": v.kind }}>
      {v.kind === "secret" ? SYM.key(16) : v.kind === "freeText" ? SYM.block(16) : v.kind === "link" ? SYM.link(16) : SYM.brackets(16)}
    </Tile>
  );

  // Above the list the summary once there is something to count; otherwise (and as a tooltip on it) the explanatory sentence.
  const locationSet = scope === "project"
    ? t("Values for this project: tokens, URLs, config values (other projects don't see them; workspace chats do). A chat in project focus sees these plus every workspace credential that is not hidden below.")
    : t("Workspace-wide values for the agent and you: tokens, URLs, config values.");
  const explanationText = `${locationSet} ${t("Via")} cbase_vars_list ${t("the agent always sees")} ${t("what")} ${t("exists — it only gets values via")} cbase_vars_get ${t("when the MCP switch is on.")}`;
  const summary = scope === "project"
    ? [
        t("{n} own", { n: vars.length }),
        t("{n} of {m} from the workspace available", { n: wsVars.filter((v) => v.enabled).length, m: wsVars.length }),
      ].join(" · ")
    : [
        vars.length === 1 ? t("1 entry") : t("{n} entries", { n: vars.length }),
        t("{n} shared with the agent", { n: vars.filter((v) => v.mcpAccess).length }),
      ].join(" · ");

  // The own entries (workspace level or the project's): rounded rows without hairlines, the kind tile in front.
  // Empty: on the workspace level the empty-page sentence, in the project section a quiet row.
  const emptyText = vars.length === 0 ? t("No entries yet.") : t("Nothing in this filter.");
  const own = shown.length === 0 ? (
    scope === "project" ? (
      <EmptyRow>{emptyText}{vars.length === 0 ? ` ${t("Create the first one — a GitLab token, for example.")}` : ""}</EmptyRow>
    ) : (
      <EmptySentence title={emptyText}>
        {vars.length === 0 ? t("Create the first one — a GitLab token, for example.") : undefined}
      </EmptySentence>
    )
  ) : (
    <AnimatedSwitch token={filter} className="flex shrink-0 flex-col gap-0.5">
      {shown.map((v) => {
        const block = v.kind === "freeText";
        const on = open === v.id;
        const show = revealed.has(v.id);
        const rows = block ? v.value.split("\n").length : 0;
        return (
          // Expanded (`data-open`) the header carries the accent tint of the selected row, the block sits indented below.
          <div key={v.id} className="min-w-0" data-open={on ? "1" : undefined}>
            <div className={`group flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors ${on ? SELECTED : "hover:bg-hover"}`}>
              {kindSymbol(v, v.mcpAccess)}
              <div className="w-[220px] min-w-0 shrink-0">
                <div className="truncate font-mono text-[13.5px] font-medium">{v.key}</div>
                {(v.description || !v.mcpAccess) && (
                  <div className="mt-0.5 flex min-w-0 items-center gap-x-2 text-[12px] text-dim">
                    {!v.mcpAccess && <span className="shrink-0">{t("blocked for the agent")}</span>}
                    {v.description && <span className="min-w-0 truncate">{v.description}</span>}
                  </div>
                )}
              </div>
              {/* A free text is a block, not a value: the row only says how large it is and opens it. Squeezed into
                  one row it would be unreadable — and showing the first line of an access would mean mistaking it for the content. */}
              {block ? (
                <button
                  type="button"
                  onClick={() => setOpen(on ? null : v.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={on ? t("Collapse") : t("Expand")}
                >
                  <ChevronIcon open={on} />
                  <span className="shrink-0 text-[12px] text-dim">
                    {t("{n} lines", { n: String(rows) })}
                  </span>
                  <span className="select-none font-mono text-[12px] tracking-widest text-dim">••••••••••••</span>
                </button>
              ) : (
                <div className="min-w-0 flex-1">
                  {v.kind === "secret" && !show ? (
                    <span className="select-none font-mono text-[12px] tracking-widest text-dim">••••••••••••</span>
                  ) : v.kind === "link" ? (
                    <a href={v.value} target="_blank" rel="noreferrer" className="block truncate font-mono text-[12px] underline decoration-edge underline-offset-2 transition-colors hover:decoration-fg">
                      {v.value}
                    </a>
                  ) : (
                    <span className="block truncate font-mono text-[12px]">{v.value}</span>
                  )}
                </div>
              )}
              <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                {(v.kind === "secret" || block) && (
                  <IconBtn
                    title={show ? t("Hide") : t("Show")}
                    onClick={() => { toggleReveal(v.id); if (block && !show) setOpen(v.id); }}
                  >
                    {show ? <EyeOffIcon /> : <EyeIcon />}
                  </IconBtn>
                )}
                <IconBtn title={copied === v.id ? t("Copied") : t("Copy value")} onClick={() => copy(v)}>
                  {copied === v.id ? <CheckIcon /> : <CopyIcon />}
                </IconBtn>
                <IconBtn
                  title={v.mcpAccess ? t("Shared with the agent — click to block") : t("Blocked for the agent — click to share")}
                  onClick={() => toggleMcp(v)}
                  className={v.mcpAccess ? "text-accent" : "text-dim"}
                >
                  {v.mcpAccess ? <PlugIcon /> : <PlugOffIcon />}
                </IconBtn>
              </div>
              <Menu label={t("More")} silent>
                <MenuEntry
                  label={t("Edit")}
                  onClick={() =>
                    setDraft({ editing: v.id, key: v.key, kind: v.kind, value: v.value, description: v.description, mcpAccess: v.mcpAccess })
                  }
                />
                <MenuEntry label={t("Delete")} onClick={() => remove(v)} danger />
              </Menu>
            </div>

            {/* The expanded block in the kit fields' tub, indented to below the key. */}
            {block && on && (
              <div className="mb-2 ml-[54px] mr-2.5 mt-1 rounded-xl bg-bg px-3 py-2.5">
                {show ? (
                  // `pre` so line breaks and indentation of the access are kept — but long lines WRAP: with
                  // `whitespace-pre` the block scrolled horizontally on a 300-character JDBC URL, across the whole
                  // row — it read like a window scrolling sideways.
                  <pre className="max-h-[320px] overflow-y-auto overflow-x-hidden whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[12px] leading-relaxed cb-scroll">{v.value}</pre>
                ) : (
                  <button type="button" onClick={() => toggleReveal(v.id)} className="flex items-center gap-2 py-1 text-[12px] text-dim hover:text-fg">
                    <EyeIcon /> {t("Hidden — show")}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </AnimatedSwitch>
  );

  return (
    <div className={`${COLUMN} flex min-h-0 flex-col pb-8`}>
      <PagesHeader
        title={scope === "project" ? t("Project credentials") : t("Credentials & variables")}
        under={vars.length + wsVars.length > 0 ? (
          <span className="tabular-nums" title={explanationText} data-vars-summary>{summary}</span>
        ) : (
          <>
            {locationSet}{" "}
            {t("Via")} <code className="rounded bg-bg px-1 font-mono text-[11px]">cbase_vars_list</code> {t("the agent always sees")}{" "}
            <em>{t("what")}</em> {t("exists — it only gets values via")}{" "}
            <code className="rounded bg-bg px-1 font-mono text-[11px]">cbase_vars_get</code> {t("when the MCP switch is on.")}
          </>
        )}
      >
        <Segments
          items={[
            { key: "all", label: t("All"), n: vars.length },
            { key: "secret", label: "Secrets", n: count("secret") },
            { key: "variable", label: t("Variables"), n: count("variable") },
            { key: "link", label: "Links", n: count("link") },
            { key: "freeText", label: t("Free text"), n: count("freeText") },
          ]}
          value={filter}
          onChange={(k) => setFilter(k as typeof filter)}
        />
        <button
          type="button"
          onClick={() => setDraft({ editing: null, key: "", kind: "secret", value: "", description: "", mcpAccess: true })}
          className={`${primary} flex items-center gap-1.5`}
        >
          <PlusIcon /> {t("New")}
        </button>
      </PagesHeader>

      <div className="flex flex-col gap-8">
      {/* In a project: the origin section above the own entries (Origin.tsx) — own first, the workspace credentials
          below as their own section. On the workspace level the list stands without a section under the header. */}
      {scope === "project" ? <OriginSection kind="project">{own}</OriginSection> : own}

      {/* Project: workspace credentials are available everywhere; here a project hides specific ones (opt-out). Its own
          origin section, the rows with the workspace marker and one step quieter. */}
      {scope === "project" && (
        <OriginSection
          kind="workspace"
          hint={t("Available everywhere by default — including a newly created workspace entry. Hide entries for this project here. In project focus the agent sees the available ones in addition to its own (on key collision the project wins).")}
        >
          <div className="flex shrink-0 flex-col gap-0.5">
          {wsVars.length === 0 ? (
            <EmptyRow>{t("No workspace credentials available.")}</EmptyRow>
          ) : (
            wsVars.map((v) => (
              <div key={v.id} className={`${LIST_ROW} items-center hover:bg-hover`}>
                {kindSymbol(v, !!v.enabled)}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`min-w-0 truncate font-mono text-[13px] font-medium ${v.enabled ? "text-fg/90" : "text-dim"}`}>{v.key}</span>
                    <OriginMarker kind="workspace" />
                  </div>
                  {v.description && <div className="mt-0.5 truncate text-[12px] text-dim">{v.description}</div>}
                </div>
                <Toggle
                  on={!!v.enabled}
                  onClick={() => toggleAdopt(v)}
                  title={v.enabled ? t("Available — click to hide") : t("Hidden — click to show")}
                />
              </div>
            ))
          )}
          </div>
        </OriginSection>
      )}
      </div>

      {/* Create/edit — glass sheet */}
      {draft && (
        <Modal onClose={() => setDraft(null)} width={520} label={draft.editing === null ? t("New entry") : t("Edit entry")}>
          <ModalTitle>{draft.editing === null ? t("New entry") : t("Edit entry")}</ModalTitle>
          <div className="grid gap-3">
            <label className="flex flex-col gap-1">
              <span className={lab}>Key</span>
              <input
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                placeholder={t("e.g. GITLAB_TOKEN")}
                autoFocus
                className={`${field} w-full font-mono`}
              />
            </label>
            <div className="flex flex-col gap-1">
              <span className={lab}>{t("Type")}</span>
              <Segments
                items={(["secret", "variable", "link", "freeText"] as const).map((k) => ({ key: k, label: t(KIND_LABEL[k]) }))}
                value={draft.kind}
                onChange={(k) => setDraft({ ...draft, kind: k as typeof draft.kind })}
              />
            </div>
            {/* Free text gets a LARGE field with fixed height: an access is a block that is pasted in one piece and
                seen as a whole. The other kinds carry one value and grow with it (`field-sizing-content`). */}
            <label className="flex flex-col gap-1">
              <span className={lab}>
                {draft.kind === "freeText" ? t("Access details") : t("Value")}{" "}
                {draft.kind === "freeText" && (
                  <span className="font-normal normal-case tracking-normal">{t("(paste it as it stands — line breaks are kept)")}</span>
                )}
              </span>
              <textarea
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                placeholder={
                  draft.kind === "link"
                    ? "https://…"
                    : draft.kind === "freeText"
                      ? "Host: 203.0.113.45\nPort: 1433\nUser: lurch\nPassword: …"
                      : t("Value")
                }
                spellCheck={false}
                className={`${field} w-full resize-none font-mono ${draft.kind === "freeText" ? "min-h-[220px] whitespace-pre-wrap [overflow-wrap:anywhere]" : "min-h-[38px] field-sizing-content"}`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={lab}>{t("Description")} <span className="font-normal normal-case tracking-normal">{t("(helps the agent choose)")}</span></span>
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder={t("e.g. PAT for gitlab.example.com (scopes: api, write_repository)")}
                className={`${field} w-full`}
              />
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
              <Toggle on={draft.mcpAccess} onClick={() => setDraft({ ...draft, mcpAccess: !draft.mcpAccess })} />
              <span>
                {t("Share with the agent")} <span className="text-dim">{t("(value retrievable via MCP; blocked entries are visible to it as names only)")}</span>
              </span>
            </label>
            {error && <Hint tone="danger">{error}</Hint>}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setDraft(null)} className={ghost}>{t("Cancel")}</button>
            <button
              type="button"
              onClick={save}
              disabled={!draft.key.trim() || !draft.value.trim()}
              className={`${primary} disabled:opacity-35`}
            >
              {t("Save")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";
const KIND_LABEL: Record<WorkspaceVar["kind"], string> = { secret: "Secret", variable: "Variable", link: "Link", freeText: "Free text" };

function IconBtn({
  title,
  onClick,
  className = "",
  children,
}: {
  title: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg ${className}`}
    >
      {children}
    </button>
  );
}

// ── Icons (inline SVG, no emoji) ───────────────────────────────────────────
const svg = (children: React.ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const EyeIcon = () => svg(<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>);
const EyeOffIcon = () => svg(<><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><path d="M1 1l22 22" /></>);
const CopyIcon = () => svg(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
const CheckIcon = () => svg(<path d="M20 6L9 17l-5-5" />);
const PlusIcon = () => svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}>
    <path d="M9 18l6-6-6-6" />
  </svg>
);
const PlugIcon = () => svg(<><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M6 8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" /></>);
const PlugOffIcon = () => svg(<><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V4" /><path d="M18 8h-8" /><path d="M6 8v5a4 4 0 0 0 4 4h4a4 4 0 0 0 3.5-2" /><path d="M2 2l20 20" /></>);
