"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadApprovalMarks, setApprovalMarks, type ApprovalMarks, type ToolGroup } from "@/lib/api";
import { Section, ghost, ghostSm, Hint, Loading, Modal, ModalTitle, Toggle, SYM } from "@/components/CbKit";
import { useT } from "@/lib/i18n";

// The approval marks of the built-in cbase tools per workspace: marked ⇒ an agent that chose the tool runs it only after the human's
// approval; an outer-loop run leaves it out. This is the only place to change them. Route GET/PUT /api/workspaces/:id/approval-marks
// (server toolchain/approval-marks.js).
//
// Saved at once per switch: the list goes out as a whole (the server replaces the marks of its slice), and an error rolls the switch
// back. Grouped by the catalog of the outer-loop editor (`groups`); what is not there is collected under "More cbase tools" — every
// cbase tool of Coding can be marked.

export function ApprovalMarksSection({ workspaceId, groups, onChanged }: {
  workspaceId: string;
  /** The catalog groups of the outer loop (current state) — only for the order and the headings. */
  groups: ToolGroup[];
  /** After every saved change: the editor reads the marks from the current state. */
  onChanged?: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<ApprovalMarks | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await loadApprovalMarks(workspaceId)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  }, [workspaceId]);
  useEffect(() => { setStatus(null); void load(); }, [load]);

  // The groups in catalog order, each only with markable tools; the rest behind them.
  const ordering = useMemo(() => {
    if (!status) return [];
    const markable = new Set(status.markable);
    const seen = new Set<string>();
    const out: { key: string; label: string; tools: string[] }[] = [];
    for (const g of groups) {
      const tools = g.tools.filter((x) => markable.has(x) && !seen.has(x));
      tools.forEach((x) => seen.add(x));
      if (tools.length) out.push({ key: g.key, label: g.label, tools });
    }
    const rest = status.markable.filter((x) => !seen.has(x));
    if (rest.length) out.push({ key: "additional", label: t("More cbase tools"), tools: rest });
    return out;
  }, [status, groups, t]);

  async function toggle(name: string) {
    if (!status) return;
    const prior = status;
    const tools = status.tools.includes(name) ? status.tools.filter((x) => x !== name) : [...status.tools, name];
    setStatus({ ...status, tools }); setBusy(name); setErr("");
    try { setStatus(await setApprovalMarks(workspaceId, tools)); onChanged?.(); }
    catch (e) { setErr((e as Error).message); setStatus(prior); }
    finally { setBusy(null); }
  }

  const count = status ? t("{n} of {m} tools with approval", { n: status.tools.length, m: status.markable.length }) : "";

  return (
    <Section
      symbol={SYM.padlock(15)}
      title={t("Approval marks")}
      data={{ "data-approval-markers": "" }}
      under={t("An agent runs a marked cbase tool only once you approve, change the parameters or reject in the chat — this applies to every agent of this workspace that selected it. An outer loop run leaves it out.")}
    >
      {err && !open && <div className="pb-2"><Hint tone="danger">{err}</Hint></div>}
      <div className="flex min-h-[44px] items-center gap-3 px-2.5 py-1.5 text-[13px]">
        <span className="min-w-0 flex-1 tabular-nums text-dim">{status ? count : !err && t("Loading…")}</span>
        <button type="button" onClick={() => { setOpen(true); void load(); }} disabled={!status} className={ghostSm} data-approval-markers-open="">{t("Edit")}</button>
      </div>
      {open && (
        <Modal onClose={() => setOpen(false)} width={620} label={t("Approval marks")}>
          <ModalTitle hint={status ? count : undefined}>{t("Approval marks")}</ModalTitle>
          {err && <div className="pb-3"><Hint tone="danger">{err}</Hint></div>}
          {!status && !err && <Loading />}
          {status && (
            <div className="flex flex-col gap-4" data-approval-markers-sheet="">
              {ordering.map((g) => (
                <div key={g.key} className="flex flex-col gap-0.5">
                  <span className="px-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-dim">{g.label}</span>
                  {g.tools.map((name) => {
                    const on = status.tools.includes(name);
                    return (
                      <div key={name} className={`flex items-center gap-3 rounded-xl px-2.5 py-1.5 ${on ? "bg-accent/8" : ""}`} data-approval-mark={name}>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{name}</span>
                        {on && <span className="shrink-0 text-[11px] text-accent">{t("with approval")}</span>}
                        <Toggle on={on} disabled={busy !== null} onClick={() => { void toggle(name); }}
                          title={on ? t("With approval — click to remove the mark") : t("Without approval — click to mark")} />
                      </div>
                    );
                  })}
                </div>
              ))}
              {ordering.length === 0 && <p className="text-[12.5px] text-dim">{t("No tool can be marked.")}</p>}
            </div>
          )}
          <div className="mt-5 flex justify-end">
            <button type="button" onClick={() => setOpen(false)} className={ghost}>{t("Close")}</button>
          </div>
        </Modal>
      )}
    </Section>
  );
}
