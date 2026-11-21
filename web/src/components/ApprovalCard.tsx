"use client";
// Approval card for a marked tool. An agent called a tool that carries a mark on the MCP page; the run waits until it is
// decided here. Three ways: approve, change the parameters and approve, reject (with an optional reason that goes to the
// model as error text — the turn continues afterwards).
//
// Unlike the Coding card (PermissionPrompt) it has no "Always allow": the mark is removed on the MCP page, not ad hoc on the
// card. And it stays in the history — request and decision are rows of the chat, the card survives reload and device switch.
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { ic } from "@/components/CbKit";
import { CARD, CARDS_HEADER, BUTTON_MAIN, BUTTON_BESIDE } from "@/components/chat/StatusLine";

export interface ApprovalRuling {
  behavior: "allow" | "deny";
  reason: string;
  /** user · stop (run aborted) · running (run ended without anyone deciding) */
  origin: string;
  updatedInput: Record<string, unknown> | null;
  at: number;
  /** Coding card: the standing rule remembered on approval ("do not ask again"). */
  remember?: string;
}
export interface ApprovalCardData {
  requestId: string;
  toolName: string;
  server: string;
  tool: string;
  description: string;
  writing: boolean | null;
  input: Record<string, unknown>;
  at: number;
  ruling?: ApprovalRuling | null;
  /** The run still waits on this card. */
  open: boolean;
  /** Coding card: tool approval of a Coding chat, persisted. */
  coding?: boolean;
}
export interface ApprovalExtras { updatedInput?: Record<string, unknown>; message?: string }

// ── The form is built from the VALUE types of the input ──
// string → text field (multiline if long), number → number field, boolean → checkbox, anything else (object, list) → JSON.
// The card does not always have a schema — the input it always has.
type Field = { key: string; kind: "text" | "count" | "bool" | "json"; value: string; bool: boolean };
function fieldsOf(input: Record<string, unknown>): Field[] {
  return Object.entries(input || {}).map(([key, v]) => {
    if (typeof v === "boolean") return { key, kind: "bool" as const, value: "", bool: v };
    if (typeof v === "number") return { key, kind: "count" as const, value: String(v), bool: false };
    if (typeof v === "string") return { key, kind: "text" as const, value: v, bool: false };
    let json = "";
    try { json = JSON.stringify(v, null, 2); } catch { json = String(v); }
    return { key, kind: "json" as const, value: json, bool: false };
  });
}
// Back into the input; `null` if a JSON field does not parse (then "Approve" stays disabled).
function inputOf(fields: Field[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === "bool") out[f.key] = f.bool;
    else if (f.kind === "count") { const n = Number(f.value); if (!Number.isFinite(n)) return null; out[f.key] = n; }
    else if (f.kind === "text") out[f.key] = f.value;
    else { try { out[f.key] = JSON.parse(f.value); } catch { return null; } }
  }
  return out;
}
const equal = (a: unknown, b: unknown) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
const multiline = (s: string) => s.includes("\n") || s.length > 60;

const ShieldIcon = () => ic(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></>, 14);

// Field/value pairs for reading — long values in a code area, short ones inline.
function Values({ input }: { input: Record<string, unknown> }) {
  const fields = fieldsOf(input);
  if (!fields.length) return <span className="text-[12px] text-dim">—</span>;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
      {fields.map((f) => (
        <div key={f.key} className="contents">
          <dt className="font-mono text-[11.5px] text-dim">{f.key}</dt>
          <dd className="min-w-0">
            {f.kind === "bool" ? <span className="font-mono text-[12px]">{f.bool ? "true" : "false"}</span>
              : f.kind === "json" || multiline(f.value)
                ? <pre className="cb-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-code px-2.5 py-1.5 font-[inherit] text-[12.5px] leading-relaxed text-fg/90">{f.value}</pre>
                : <span className="break-words">{f.value}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalCard({ card, onDecide }: {
  card: ApprovalCardData;
  onDecide: (behavior: "allow" | "deny", extras?: ApprovalExtras) => void;
}) {
  const t = useT();
  const [edit, setEdit] = useState(false);
  const [fields, setFields] = useState<Field[]>(() => fieldsOf(card.input));
  const [reason, setReason] = useState("");
  const [reject, setReject] = useState(false);
  const inputData = useMemo(() => inputOf(fields), [fields]);
  const changed = inputData !== null && !equal(inputData, card.input);
  const e = card.ruling;
  const set = (key: string, patch: Partial<Field>) => setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const approve = () => onDecide("allow", changed && inputData ? { updatedInput: inputData } : undefined);
  const no = () => onDecide("deny", { message: reason.trim() || undefined });

  // After the decision: what became of it — brief, but with origin. An aborted card must stay distinguishable from a user's
  // No — by the wording, not the color (card form in chat/StatusLine.tsx).
  const result = e
    ? e.behavior === "allow"
      ? e.remember ? t("Approved — rule remembered: {rule}", { rule: e.remember }) : e.updatedInput && !equal(e.updatedInput, card.input) ? t("Approved — with changed parameters") : t("Approved")
      : e.origin === "stop" ? t("Not executed — run aborted")
        : e.origin === "running" ? t("Not executed — the run ended first")
          : e.reason ? t("Rejected: {reason}", { reason: e.reason }) : t("Rejected")
    : null;

  return (
    <div data-approval={card.requestId} data-adjust-scope data-open={card.open && !e ? "1" : undefined} className={CARD}>
      <div className={CARDS_HEADER}>
        <ShieldIcon />
        <span className="font-medium text-fg">{card.open && !e ? t("Approval required") : t("Approve##noun")}</span>
        <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-[11px]">{[card.server, card.tool].filter(Boolean).join(" · ")}</span>
        {card.writing === true && <span className="rounded-full bg-bg px-2 py-0.5 text-[11px] text-fg/80">{t("writes")}</span>}
        {card.writing === null && <span className="rounded-full bg-bg px-2 py-0.5 text-[11px]">{t("unclear")}</span>}
        <span className="flex-1" />
        <span className="text-[11px] tabular-nums">{new Date(card.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      {card.description && <p className="mb-2 text-[12px] leading-relaxed text-dim">{card.description}</p>}

      {e || !edit ? (
        <Values input={e?.behavior === "allow" && e.updatedInput ? e.updatedInput : card.input} />
      ) : (
        <div className="flex flex-col gap-2">
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="font-mono text-[11.5px] text-dim">{f.key}{f.kind === "json" && <span className="ml-1.5 text-[10px]">JSON</span>}</span>
              {f.kind === "bool" ? (
                <input type="checkbox" checked={f.bool} onChange={(ev) => set(f.key, { bool: ev.target.checked })} className="h-4 w-4 accent-fg" />
              ) : f.kind === "count" ? (
                <input type="number" value={f.value} onChange={(ev) => set(f.key, { value: ev.target.value })} className="w-40 rounded-xl bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:ring-1 focus:ring-fg/20" />
              ) : f.kind === "json" || multiline(f.value) ? (
                <textarea
                  value={f.value}
                  onChange={(ev) => set(f.key, { value: ev.target.value })}
                  rows={Math.min(10, f.value.split("\n").length + 1)}
                  spellCheck={f.kind === "text"}
                  className={`cb-scroll w-full resize-y rounded-xl bg-bg px-2.5 py-1.5 text-[12.5px] leading-relaxed outline-none focus:ring-1 focus:ring-fg/20 ${f.kind === "json" ? "font-mono text-[12px]" : ""}`}
                />
              ) : (
                <input value={f.value} onChange={(ev) => set(f.key, { value: ev.target.value })} className="w-full rounded-xl bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:ring-1 focus:ring-fg/20" />
              )}
            </label>
          ))}
          {inputData === null && <span className="text-[11px] text-danger">{t("A JSON field is not valid.")}</span>}
          {!fields.length && <span className="text-[12px] text-dim">{t("This call has no parameters.")}</span>}
        </div>
      )}

      {result && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 text-[12px] text-dim">
          <span>{result}</span>
          <span className="tabular-nums text-dim">· {new Date(e!.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      )}

      {card.open && !e && (
        <>
          {reject && (
            <div className="mt-2.5">
              <input
                value={reason}
                onChange={(ev) => setReason(ev.target.value)}
                onKeyDown={(ev) => { if (ev.key === "Enter") no(); }}
                autoFocus
                placeholder={t("Why not? (optional — goes to the agent)")}
                className="w-full rounded-xl bg-bg px-2.5 py-1.5 text-[12.5px] outline-none transition-colors placeholder:text-dim focus:ring-1 focus:ring-fg/20"
              />
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
            {!reject && fields.length > 0 && (
              <button type="button" onClick={() => setEdit((b) => !b)} className="mr-auto rounded-full px-2.5 py-1.5 text-[12px] font-medium text-dim transition-colors hover:text-fg">
                {edit ? t("Keep parameters") : t("Change parameters")}
              </button>
            )}
            {reject ? (
              <>
                <button type="button" onClick={() => { setReject(false); setReason(""); }} className="rounded-full px-2.5 py-1.5 text-[12px] font-medium text-dim transition-colors hover:text-fg">{t("Never mind")}</button>
                <button type="button" onClick={no} className={BUTTON_MAIN}>{t("Deny")}</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setReject(true)} className={BUTTON_BESIDE}>{t("Deny")}</button>
                <button type="button" onClick={approve} disabled={inputData === null} className={BUTTON_MAIN}>
                  {changed ? t("Approve with changes") : t("Approve")}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
