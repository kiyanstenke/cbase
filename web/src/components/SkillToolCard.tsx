"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  loadSkillHistory, takeSkillChangeBack, skillWriteError, type SkillWriteError, type SkillHistoryEntry,
} from "@/lib/api";
import { SkillRequestCard, SkillErrorDisplay, useSkillsEvent } from "@/components/SkillHistory";
import { ghostSm } from "@/components/CbKit";
import type { SkillWriteResult } from "@/lib/skill-change";
import { useT } from "@/lib/i18n";

// Tool block of `cbase_skill_write` in the chat: under the call line "Skill <name> created/changed" with an "Undo" button;
// for a delete request, the request card (SkillHistory.tsx). Whether undo is possible is NOT in the result (that is a
// snapshot from then) but read fresh from the skill's history (`skill-history?skillId=`, entry `historyId`) — which needs
// the workspace. The block does not know it; the coding chat stage (chat/ChatStage.tsx) provides it via
// `SkillToolWorkspace`. Without it (agent dock) only the line is shown, without a button.

/** Workspace of the stage the block sits in (`null` = unknown). */
export const SkillToolWorkspace = createContext<string | null>(null);

export function SkillToolCard({ result }: { result: SkillWriteResult }) {
  if (result.kind === "requested") {
    return (
      <div className="mt-1.5" data-skill-tool="requested">
        <SkillRequestCard requestId={result.requestId} />
      </div>
    );
  }
  return <SkillWritten result={result} />;
}

function SkillWritten({ result }: { result: Extract<SkillWriteResult, { kind: "written" }> }) {
  const t = useT();
  const workspaceId = useContext(SkillToolWorkspace);
  const { skill, historyId, unchanged, action } = result;
  const [entry, setEntry] = useState<SkillHistoryEntry | null | undefined>(undefined); // undefined = loading/unknown, null = not in history
  const [error, setError] = useState<SkillWriteError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!workspaceId || !historyId || unchanged) return;
    loadSkillHistory(workspaceId, { skillId: skill.id }).then(
      (l) => setEntry(l.find((e) => e.id === historyId) ?? null),
      () => setEntry(undefined),
    );
  }, [workspaceId, historyId, unchanged, skill.id]);
  useEffect(load, [load]);
  useSkillsEvent(workspaceId, (e) => { if (!e.skillId || e.skillId === skill.id) load(); });

  async function back() {
    if (!historyId) return;
    setBusy(true);
    setError(null);
    try { await takeSkillChangeBack(historyId); load(); }
    catch (err) { setError(skillWriteError(err)); load(); }
    finally { setBusy(false); }
  }

  const kind = entry?.kind ?? action;
  const set = unchanged
    ? t("Skill {name} unchanged", { name: skill.name })
    : kind === "create" ? t("Skill {name} created", { name: skill.name })
    : kind === "change" ? t("Skill {name} changed", { name: skill.name })
    : t("Skill {name} written", { name: skill.name });
  const level = skill.level === "project" ? (skill.projectName ? t("Project {name}", { name: skill.projectName }) : t("Project")) : skill.level === "workspace" ? t("Workspace") : null;

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1.5" data-skill-tool="written" data-skill-id={skill.id}>
      <div className="flex min-w-0 items-center gap-2 text-tool text-dim">
        <span className="min-w-0 truncate">
          <span className="text-fg/90">{set}</span>
          {level && <span> · {level}</span>}
        </span>
        {entry?.revertedAt != null && <span className="shrink-0" data-skill-reverted>{t("undone")}</span>}
        {entry && entry.revertedAt == null && !entry.revertible && (
          <span className="shrink-0" title={t("The skill has changed since — undo only works while it is unchanged.")}>
            {t("changed since")}
          </span>
        )}
        {entry?.revertible && (
          <button type="button" onClick={() => { back().catch(() => {}); }} disabled={busy} className={`${ghostSm} shrink-0 disabled:opacity-50`} data-skill-revert={entry.id}>
            {t("Undo")}
          </button>
        )}
      </div>
      {error && <SkillErrorDisplay f={error} onClose={() => setError(null)} />}
    </div>
  );
}
