"use client";

import { COLUMN, Segments } from "@/components/CbKit";
import { AgentsPane } from "@/components/AgentsPane";
import { OuterLoopPane } from "@/components/outerloop/OuterLoopPane";
import { AgentInstructions } from "@/components/AgentInstructions";
import { AGENT_KINDS, type AgentKind } from "@/lib/coding-tabs";
import type { Project } from "@/lib/api";
import { useT } from "@/lib/i18n";

// The "Agents" tab has KINDS in one kit `Segments` — the same form as the kinds of the "Workflows" tab (workflow/WorkflowsTab.tsx):
//  · "Subagents" — the agent types the agent starts as subagents in the chat (AgentsPane);
//  · "Outer loop" — the user-managed background agents per workspace, project and chat, including the fixed ones (summarizer, agenda
//    keeper; OuterLoopPane);
//  · "Instructions" — the sections per workspace and project that every agent gets in its system prompt according to its scope
//    (AgentInstructions).
// The page holds the kind (remembered per workspace, `cbase-agents-kind:<ws>`, computation `savedAgentKind` in lib/coding-tabs.ts).
// ONE row, ONE navigation level; no count on the bar (Coding tabs without counts).
//
// The row sits in the shared column of the quiet page (`COLUMN`, CbKit.tsx) — flush above the page header of both kinds, with air down
// to the title.
export function AgentsTab({ workspaceId, projectId, projects, kind, onKindChange }: {
  workspaceId: string;
  projectId: string | null;
  /** The projects of the workspace (takeover per project in the editor) — `undefined` while the overview is missing. */
  projects?: Project[];
  kind: AgentKind;
  onKindChange: (kind: AgentKind) => void;
}) {
  const t = useT();
  const kindName = (a: AgentKind) => (a === "subagents" ? t("Subagents") : a === "outerloop" ? t("Outer loop") : t("Instructions"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`${COLUMN} mb-6 flex shrink-0 flex-wrap items-center gap-2`}>
        <Segments
          label={t("Kind of agents")}
          items={AGENT_KINDS.map((a) => ({ key: a, label: kindName(a), data: { "data-agents-kind": a } }))}
          value={kind}
          onChange={(k) => onKindChange(k as AgentKind)}
        />
      </div>
      {kind === "outerloop"
        ? <OuterLoopPane workspaceId={workspaceId} projectId={projectId} projects={projects} />
        : kind === "instructions"
          ? <AgentInstructions workspaceId={workspaceId} projectId={projectId} />
          : <AgentsPane workspaceId={workspaceId} projectId={projectId} />}
    </div>
  );
}
