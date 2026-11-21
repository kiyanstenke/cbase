"use client";

import { useState } from "react";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { Modal, Segments, field, ghost, primary } from "@/components/CbKit";
import { useT } from "@/lib/i18n";

export interface SkillDraft {
  editing: string | null; // skill id when editing, null for new
  name: string;
  description: string;
  body: string;
}

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";

// Sheet like the subagent dialog: fixed header (title, location, name, tabs as a segment bar), scrolling middle part (editor),
// fixed footer.
//
// Only description · content: a skill belongs to exactly one area, and there is no per-project adoption tab; a workspace skill
// is hidden only in the project view. Where a skill belongs is decided by the LOCATION where it is created; the dialog only
// names it (`location`), it does not choose it. A skill is never moved.
export function SkillDialog({
  draft,
  location,
  top,
  history,
  onSave,
  onClose,
}: {
  draft: SkillDraft;
  /** Where the skill lives or is created ("Coding · Workspace skill", "Coding · Project skill"), translated by the
   *  calling page, SkillsPane.tsx; display only. */
  location?: string;
  /** Above the tabs, e.g. the card of an open deletion request. */
  top?: React.ReactNode;
  /** The content of the "History" tab (SkillHistory.tsx); without it there is no tab (new skill). */
  history?: React.ReactNode;
  onSave: (d: SkillDraft) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [d, setD] = useState(draft);
  const [tab, setTab] = useState<"description" | "content" | "history">("content");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setErr("");
    try { await onSave(d); }
    catch (e) { setErr(t("Error: ") + (e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={720} className="h-[min(720px,100%)] p-0" label={d.editing ? t("Edit skill") : t("New skill")}>
      {/* Fixed header: title + location + name + tabs */}
      <div className="shrink-0 px-6 pt-6">
        <h2 className="text-[15px] font-semibold tracking-tight">
          {d.editing ? t("Edit skill") : t("New skill")}
        </h2>
        {location && <div className="mt-0.5 text-[12px] text-dim" data-skill-location>{location}</div>}
        <label className="mt-4 flex flex-col gap-1">
          <span className={lab}>{t("Name (lower-kebab-case)")}</span>
          <input
            value={d.name}
            disabled={Boolean(d.editing)}
            onChange={(e) => setD({ ...d, name: e.target.value })}
            placeholder={t("e.g. deploy-checklist")}
            autoFocus={!d.editing}
            className={`${field} w-full font-mono disabled:opacity-60`}
          />
        </label>
        {top && <div className="mt-4">{top}</div>}
        <div className="mt-4 flex items-center gap-2">
          <Segments
            items={[
              { key: "description", label: t("Description") },
              { key: "content", label: t("Content") },
              ...(history ? [{ key: "history", label: t("History") }] : []),
            ]}
            value={tab}
            onChange={(k) => setTab(k as typeof tab)}
          />
        </div>
      </div>

      {/* Middle part: fills the space; scrolling happens INSIDE the box, not here */}
      <div className="flex min-h-0 flex-1 flex-col px-6 pb-4 pt-3">
        <AnimatedSwitch token={tab} className="flex min-h-0 flex-1 flex-col">
          {tab === "description" && (
            <label className="flex min-h-0 flex-1 flex-col gap-1">
              <span className={lab}>{t("When should the agent use this skill?")}</span>
              <textarea
                value={d.description}
                onChange={(e) => setD({ ...d, description: e.target.value })}
                placeholder={t("Short and concrete: in which situations should the agent load this skill?")}
                className={`${field} min-h-0 w-full flex-1 resize-none leading-relaxed`}
              />
            </label>
          )}
          {tab === "history" && history && (
            <div className="cb-scroll min-h-0 flex-1 overflow-y-auto" data-skill-dialog-history>{history}</div>
          )}
          {tab === "content" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-bg">
              {/* `h-full` on the container of the React wrapper: `height="100%"` alone resolves against an
                  auto height, the editor grows to the full document height and its `.cm-scroller`
                  (overscroll-behavior: contain) swallows every wheel event without being able to scroll
                  itself. With `h-full` the editor scrolls by itself, as in the artifact modal.
                  The padding sits INSIDE the editor (`padding`), not on the trough, so its scroll area
                  fills the round trough instead of standing in it as an indented box. */}
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

      {/* Footer (fixed, does not scroll along) */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-edge px-6 py-4">
        {err && <span className="min-w-0 flex-1 truncate text-[12px] text-danger" title={err}>{err}</span>}
        <button type="button" onClick={onClose} className={ghost}>{t("Cancel")}</button>
        <button
          type="button"
          onClick={() => { save().catch(() => {}); }}
          disabled={busy || !d.name.trim()}
          className={`${primary} disabled:opacity-35`}
        >
          {t("Save")}
        </button>
      </div>
    </Modal>
  );
}
