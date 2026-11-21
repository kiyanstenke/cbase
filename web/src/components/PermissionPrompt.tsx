"use client";

// Interactive tool approval: appears in the chat when the agent, in "ask"/"auto-edit" mode,
// wants to use a sensitive tool (Bash/Write/Edit/...). Shows WHAT is about to happen (command
// or diff) and lets the user choose Allow/Deny. Runs through the cbase MCP permission prompt.
//
// It can also do four things, as in Claude Code:
//  * change the command BEFORE allowing (the contract always knew updatedInput, nobody sent it),
//  * deny with a REASON; otherwise the model could not tell "denied" from "broken",
//  * remember "don't ask again" as a permanent rule,
//  * stay open indefinitely (no silent auto-deny after four minutes).
import { useState } from "react";
import { formatToolName, buildDiff, DiffView } from "@/components/AssistantBlocks";
import { Markdown } from "@/components/Markdown";
import { useT } from "@/lib/i18n";
import { ic } from "@/components/CbKit";
import { CARD, CARDS_HEADER, BUTTON_MAIN, BUTTON_BESIDE } from "@/components/chat/StatusLine";

export interface PermReq {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string | null;
  /** Server suggestion for "don't ask again", e.g. `Bash(git status:*)`. */
  suggestedRule?: string;
}

export interface PermExtras {
  updatedInput?: Record<string, unknown>;
  message?: string;
  remember?: string;
}

const ShieldQ = () => ic(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 2.5" /><path d="M12 17h.01" /></>, 14);

// Compact, honest display of what the tool would do. Shell commands are editable: exactly the
// case where an "almost right" call would otherwise have to be denied and guessed anew.
function InputPreview({
  toolName, input, command, onCommand,
}: {
  toolName: string; input: Record<string, unknown>;
  command: string | null; onCommand: (v: string) => void;
}) {
  const t = useT();
  const diff = buildDiff(toolName, input);
  if (diff) {
    const file = typeof input.file_path === "string" ? input.file_path : "";
    return (
      <div className="flex flex-col gap-1">
        {file && <div className="truncate font-mono text-[11.5px] text-dim">{file}</div>}
        <DiffView lines={diff} />
      </div>
    );
  }
  if (command !== null) {
    return (
      <div className="flex flex-col gap-1">
        <textarea
          value={command}
          onChange={(e) => onCommand(e.target.value)}
          rows={Math.min(8, command.split("\n").length + 1)}
          spellCheck={false}
          className="w-full resize-y overflow-x-auto rounded-xl bg-code px-2.5 py-1.5 font-mono text-[12px] leading-[1.5] text-fg outline-none transition-colors focus:ring-1 focus:ring-accent/50"
        />
        <span className="text-[11px] text-dim">{t("You can edit the command before allowing it.")}</span>
      </div>
    );
  }
  const keys = Object.keys(input || {});
  if (!keys.length) return null;
  let json = "";
  try { json = JSON.stringify(input, null, 2); } catch { json = String(input); }
  return (
    <div className="overflow-x-auto rounded-xl bg-code px-2.5 py-1.5">
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-fg/80">{json.slice(0, 1200)}</pre>
    </div>
  );
}

export function PermissionPrompt({ req, onDecide }: { req: PermReq; onDecide: (behavior: "allow" | "deny", extras?: PermExtras) => void }) {
  const t = useT();
  // Plan approval (ExitPlanMode): show the proposed plan as Markdown, with Implement/Keep planning.
  const isPlan = req.toolName === "ExitPlanMode";
  const plan = isPlan && typeof req.input.plan === "string" ? (req.input.plan as string) : "";
  const originalCommand = typeof req.input.command === "string" ? (req.input.command as string) : null;
  const [command, setCommand] = useState(originalCommand ?? "");
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const rule = String(req.suggestedRule || "").trim();

  const changedInput = originalCommand !== null && command !== originalCommand ? { command } : undefined;
  const allow = (remember?: string) => onDecide("allow", { updatedInput: changedInput, remember });
  const deny = () => onDecide("deny", { message: reason.trim() || undefined });

  return (
    // In the card form of the history (chat/StatusLine.tsx): no warning or accent surface, the main button in
    // text colour; the same card as the approval in the history (ApprovalCard), only transient above the input.
    <div className={CARD}>
      <div className={CARDS_HEADER}>
        {isPlan ? <PlanIcon /> : <ShieldQ />}
        <span className="font-medium text-fg">{isPlan ? t("Plan for approval") : t("Approval required")}</span>
        {!isPlan && <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-[11px]">{t(formatToolName(req.toolName))}</span>}
      </div>
      <div className="mb-2.5">
        {isPlan ? (
          <div className="cb-scroll max-h-[46vh] overflow-y-auto rounded-xl bg-bg px-3 py-2 text-[12.5px]">
            <Markdown src={plan || t("_(no plan content)_")} />
          </div>
        ) : (
          <InputPreview toolName={req.toolName} input={req.input} command={originalCommand === null ? null : command} onCommand={setCommand} />
        )}
      </div>

      {/* Denial with a reason: the text goes to the model as the tool result. */}
      {!isPlan && showReason && (
        <div className="mb-2.5">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") deny(); }}
            autoFocus
            placeholder={t("Why not? (sent to the model)")}
            className="w-full rounded-xl bg-bg px-2.5 py-1.5 text-[12.5px] outline-none transition-colors placeholder:text-dim focus:bg-panel focus:ring-1 focus:ring-fg/20"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!isPlan && !showReason && (
          <button
            type="button"
            onClick={() => setShowReason(true)}
            className="mr-auto rounded-full px-2.5 py-1.5 text-[12px] font-medium text-dim transition-colors hover:text-fg"
          >
            {t("Deny with a reason")}
          </button>
        )}
        <button
          type="button"
          onClick={deny}
          className={BUTTON_BESIDE}
        >
          {isPlan ? t("Keep planning") : t("Deny")}
        </button>
        {/* "Don't ask again" exists only without a changed input: a rule for a command that was just
            rewritten would be a rule for something the agent never requested. */}
        {!isPlan && rule && !changedInput && (
          <button
            type="button"
            onClick={() => allow(rule)}
            title={t("Rule: {rule}", { rule })}
            className={BUTTON_BESIDE}
          >
            {t("Always allow")}
          </button>
        )}
        <button
          type="button"
          onClick={() => allow()}
          className={BUTTON_MAIN}
        >
          {isPlan ? t("Implement") : t("Allow")}
        </button>
      </div>
    </div>
  );
}

const PlanIcon = () => ic(<><path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></>, 14);
