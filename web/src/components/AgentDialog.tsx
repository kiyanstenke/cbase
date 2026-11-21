"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { Modal, Segments, field, ghost, primary } from "@/components/CbKit";
import { ModelChoice } from "@/components/ModelChoice";
import { AgentMcpChoiceList, type AgentMcpChoice } from "@/components/AgentMcpChoice";

export interface AgentDraft {
  editing: string | null; // agent id when editing, null when new
  scope: "ws" | "proj"; // workspace agent or project-bound agent
  name: string;
  description: string;
  tools: string; // comma list (empty = inherits all tools of the parent agent)
  // Model reference: "" = inherits; a bare tier (opus|sonnet|haiku|fable) means the chat's provider;
  // "provider::model" starts the subagent at exactly that provider.
  model: string;
  body: string; // system prompt of the subagent
  // Skills loaded IN FULL into its system prompt at start (names from the workspace or project catalog), so the subagent
  // need not fetch them.
  skills: string[];
  // Coding MCP servers a subagent of this type gets (even without "Subagents inherit"): serverId → null (all tools) |
  // list (only these). Empty = none. Component AgentMcpChoice.tsx.
  mcp: AgentMcpChoice;
}

/** A selectable skill: name and purpose, all the checkbox list needs. */
export interface SkillChoice {
  name: string;
  description: string;
  /** Origin, when the skill belongs to a project (visible in the workspace dialog). */
  originProject?: string;
}

interface ProviderInfo {
  id: string;
  label: string;
  connected: boolean;
  models: { id: string; label: string }[];
  caps?: { ownsAgentLoop?: boolean };
}

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";

// The sheet is glass (`Modal` from the kit): header with name and tabs is fixed, the middle part scrolls on its own (editor),
// the footer is fixed. Tabs as a segment bar: ONE value from a fixed list, not a row of buttons.
export function AgentDialog({
  draft,
  skills,
  workspaceId,
  projectId,
  onSave,
  onClose,
}: {
  draft: AgentDraft;
  /** The place whose coding MCP servers are offered: the workspace, for a project type the project too. */
  workspaceId: string;
  projectId: string | null;
  /** The skills on offer: the catalog of the place the agent lives in. */
  skills: SkillChoice[];
  onSave: (d: AgentDraft) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [d, setD] = useState(draft);
  const [tab, setTab] = useState<"config" | "prompt">("config");
  const [err, setErr] = useState("");
  // A stored name the list no longer knows stays visible and can be unchecked; otherwise it would vanish silently on open and
  // starting the subagent would fail with "not found" without anyone seeing the reason in the dialog.
  const orphaned = d.skills.filter((n) => !skills.some((s) => s.name === n));
  const toggleSkill = (name: string, on: boolean) =>
    setD({ ...d, skills: on ? [...d.skills.filter((x) => x !== name), name] : d.skills.filter((x) => x !== name) });

  // Providers that can PROVIDE a subagent: every connected provider with models. cbase_agent starts Claude/Codex (own CLI,
  // runs/agents.js) like third-party providers (loop engine), so do not filter on `ownsAgentLoop`.
  const [hosts, setHosts] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    api<{ providers: ProviderInfo[] }>("/api/providers")
      .then((r) => setHosts((r.providers || []).filter((p) => p.connected && p.models.length)))
      .catch(() => setHosts([])); // the provider list is a convenience; without it the tiers stay selectable
  }, []);
  // A stored value that appears in no group (provider removed, model retired) must stay visible anyway; otherwise opening the
  // dialog silently resets the agent.
  const known = d.model === ""
    || hosts.some((p) => p.models.some((m) => `${p.id}::${m.id}` === d.model));

  return (
    <Modal onClose={onClose} width={720} className="h-[min(720px,100%)] p-0" label={d.editing ? t("Edit subagent") : t("New subagent")}>
      <div className="shrink-0 px-6 pt-6">
        <h2 className="text-[15px] font-semibold tracking-tight">
          {d.editing ? t("Edit subagent") : t("New subagent")}
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-dim">
          {t("A custom agent type the agent can call from the chat via cbase_agent (or its CLI's Agent tool) — own context, own tools, own skills.")}
        </p>
        <label className="mt-4 flex flex-col gap-1">
          <span className={lab}>{t("Name (lower-kebab-case)")}</span>
          <input
            value={d.name}
            disabled={Boolean(d.editing)}
            onChange={(e) => setD({ ...d, name: e.target.value })}
            placeholder={t("e.g. test-runner")}
            className={`${field} w-full font-mono disabled:opacity-60`}
          />
        </label>
        <div className="mt-4 flex items-center gap-2">
          <Segments
            items={[
              { key: "config", label: t("Configuration") },
              { key: "prompt", label: t("System prompt") },
            ]}
            value={tab}
            onChange={(k) => setTab(k as typeof tab)}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-6 pb-4 pt-3">
        <AnimatedSwitch token={tab} className="flex min-h-0 flex-1 flex-col">
          {tab === "config" && (
            <div className="cb-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              <label className="flex flex-col gap-1">
                <span className={lab}>{t("When should this subagent be used?")}</span>
                <textarea
                  value={d.description}
                  onChange={(e) => setD({ ...d, description: e.target.value })}
                  placeholder={t("Short and specific — this is how the main agent recognizes when to delegate to this subagent.")}
                  className={`${field} min-h-[90px] w-full resize-none leading-relaxed`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={lab}>{t("Tools (optional, comma-separated — empty = inherits all)")}</span>
                <input
                  value={d.tools}
                  onChange={(e) => setD({ ...d, tools: e.target.value })}
                  placeholder={t("e.g. Read, Grep, Bash")}
                  className={`${field} w-full font-mono`}
                />
                {/* The list means the same for every provider as in Claude Code, except Codex's built-ins. */}
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-dim">
                  {t("When set, ONLY what is listed applies: built-in tools and cbase tools (cbase_projects_list, all: mcp__cbase). MCP servers are not listed here — choose them below under “MCP servers”. Codex keeps its built-in tools (shell, patch, web search) — there the list only applies to cbase tools.")}
                </span>
              </label>
              <div className="flex flex-col gap-1">
                <span className={lab}>{t("MCP servers")}</span>
                <span className="text-[11.5px] leading-relaxed text-dim">
                  {t("Every subagent of this type gets the checked coding MCP servers — even if “Subagents inherit” is off on the server. Per server all tools or a selection. What the calling agent does not have itself, the subagent does not get either; approval cards apply as for the main agent.")}
                </span>
                <AgentMcpChoiceList
                  value={d.mcp}
                  onChange={(mcp) => setD({ ...d, mcp })}
                  workspaceId={workspaceId}
                  projectId={d.scope === "proj" ? projectId : null}
                />
              </div>
              <label className="flex flex-col gap-1">
                <span className={lab}>{t("Model")}</span>
                {/* Shared model choice with search (components/ModelChoice.tsx): OpenRouter carries the whole catalog. "Inherit from chat" on
                    top, then one group per provider; an unknown value stands on top, in warning colour. There is no group of bare
                    tiers; a stored tier value keeps working (the server translates it) but shows here as unknown. */}
                <ModelChoice
                  label={t("Model")}
                  value={d.model}
                  onChoice={(model) => setD({ ...d, model })}
                  top={[
                    { value: "", label: t("Inherit from chat") },
                    ...(!known ? [{ value: d.model, label: d.model, warn: true }] : []),
                  ]}
                  groups={[
                    ...hosts.map((p) => ({ key: p.id, label: p.label, options: p.models.filter((m) => m.id).map((m) => ({ value: `${p.id}::${m.id}`, label: m.label })) })),
                  ]}
                  warn={!known}
                  className="w-fit max-w-[320px]"
                  data={{ "data-agent-model": "" }}
                />
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-dim">
                  {t("A provider from the list starts the subagent there — even when the chat runs on another provider (via cbase_agent that works from any chat). Only the Claude CLI's built-in Agent tool cannot; there the subagent inherits the chat model.")}
                </span>
              </label>
              <div className="flex flex-col gap-1">
                <span className={lab}>{t("Skills (loaded in full at start)")}</span>
                <span className="text-[11.5px] leading-relaxed text-dim">
                  {t("Checked skills are placed in full into the subagent's system prompt — it does not need to fetch them with cbase_skill. Each one costs its full length on every start.")}
                </span>
                {skills.length === 0 && orphaned.length === 0 ? (
                  <span className="rounded-xl bg-bg px-3 py-2 text-[12px] text-dim">{t("No skills here yet — create them under Coding → Skills.")}</span>
                ) : (
                  <div className="cb-scroll max-h-[220px] overflow-y-auto rounded-xl bg-bg p-1" data-agent-skills>
                    {skills.map((s) => {
                      const on = d.skills.includes(s.name);
                      return (
                        <label key={s.name} className={`flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors ${on ? "bg-accent/8" : "hover:bg-hover"}`}>
                          <input type="checkbox" checked={on} onChange={(e) => toggleSkill(s.name, e.target.checked)} className="mt-0.5 accent-accent" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[12.5px]">{s.name}{s.originProject ? <span className="ml-1.5 font-sans text-[11px] text-dim">· {s.originProject}</span> : null}</span>
                            {s.description && <span className="block truncate text-[11.5px] text-dim">{s.description}</span>}
                          </span>
                        </label>
                      );
                    })}
                    {orphaned.map((n) => (
                      <label key={n} className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-danger/8 px-2.5 py-1.5">
                        <input type="checkbox" checked onChange={() => toggleSkill(n, false)} className="mt-0.5 accent-accent" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[12.5px]">{n}</span>
                          <span className="block text-[11.5px] text-danger">{t("This skill no longer exists here — starting the subagent will fail because of it.")}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {tab === "prompt" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-bg">
              {/* Padding sits in the editor, not on the tub, as in the skill dialog (the scroll area fills the tub). */}
              <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
                <MarkdownEditor
                  value={d.body}
                  onChange={(v) => setD({ ...d, body: v })}
                  height="100%"
                  padding="14px"
                  className="h-full"
                />
              </div>
            </div>
          )}
        </AnimatedSwitch>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-edge px-6 py-4">
        {err && <span className="min-w-0 flex-1 truncate text-[12px] text-danger">{err}</span>}
        <button type="button" onClick={onClose} className={ghost}>{t("Cancel")}</button>
        <button
          type="button"
          onClick={() => onSave(d).catch((e) => setErr(t("Error: {msg}", { msg: e.message })))}
          className={primary}
        >
          {t("Save")}
        </button>
      </div>
    </Modal>
  );
}
