"use client";

import { useState } from "react";
import { COLUMN, COLUMN_WIDTH, Segments } from "@/components/CbKit";
import { WorkflowsPane } from "@/components/workflow/WorkflowsPane";
import { WorkflowRunsPane } from "@/components/workflow/WorkflowRunsPane";
import { DynWorkflowsPane } from "@/components/workflow/DynWorkflowsPane";
import { WORKFLOW_KINDS, type WorkflowKind } from "@/lib/coding-tabs";
import { useT } from "@/lib/i18n";

// The Workflows tab has two KINDS: "Graph" — the graph workflows with their two views, the
// workflows themselves and their RUNS (history) — and "Dynamic" — the library of the saved dynamic
// workflow scripts (DynWorkflowsPane). The page holds the kind (remembered per workspace,
// `cbase-wf-kind:<ws>`, computed by `savedWorkflowKind` in lib/coding-tabs.ts).
//
// ONE row, ONE navigation level: the kind first, behind it ONLY for "Graph" the bar Workflows · Run
// history — the run history shows graph runs only. The row disappears once the graph editor is open —
// there every pixel belongs to the canvas (and the editor has its own "← Overview" way back); under
// "Dynamic" it always shows, so that a stuck `editing` never hides the way back.
//
// The bars are segment bars from the kit (`Segments`), ONE control per choice, the same form as the
// state filters of the other pages.
//
// The row sits in the shared column of the quiet page (`COLUMN`, CbKit.tsx): flush above the page
// header of the overview (WorkflowsPane) or of the library (DynWorkflowsPane), with air down to the
// title. The run history sits in the same column (otherwise it would start on a wide stage left of
// the bar); its form is not affected, nor is the editor.
export function WorkflowsTab({ workspaceId, projectId, kind, onKindChange }: {
  workspaceId: string;
  projectId: string | null;
  kind: WorkflowKind;
  onKindChange: (kind: WorkflowKind) => void;
}) {
  const t = useT();
  const [sub, setSub] = useState<"list" | "runs">("list");
  const [editing, setEditing] = useState(false);
  const kindName = (a: WorkflowKind) => (a === "graph" ? t("Graph") : t("Dynamic"));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(kind !== "graph" || !editing) && (
        <div className={`${COLUMN} mb-6 flex shrink-0 flex-wrap items-center gap-2`}>
          <Segments
            label={t("Workflow type")}
            items={WORKFLOW_KINDS.map((a) => ({ key: a, label: kindName(a), data: { "data-wf-kind": a } }))}
            value={kind}
            onChange={(k) => onKindChange(k as WorkflowKind)}
          />
          {kind === "graph" && (
            <>
              <span aria-hidden className="h-4 w-px bg-edge" />
              <Segments
                label={t("Workflows")}
                items={[
                  { key: "list", label: t("Workflows") },
                  { key: "runs", label: t("Run history") },
                ]}
                value={sub}
                onChange={(k) => setSub(k as "list" | "runs")}
              />
            </>
          )}
        </div>
      )}
      {kind === "dynamic"
        ? <DynWorkflowsPane workspaceId={workspaceId} projectId={projectId} />
        : sub === "list"
          ? <WorkflowsPane workspaceId={workspaceId} projectId={projectId} onEditingChange={setEditing} />
          : <div className={`${COLUMN_WIDTH} flex min-h-0 flex-1 flex-col`}><WorkflowRunsPane workspaceId={workspaceId} projectId={projectId} /></div>}
    </div>
  );
}
