"use client";
// Adjust: rephrase selected text according to an instruction.
//
// Instead of one rule per tool there is ONE action on text: select → the floating "Adjust" pill → the "Instructions
// for adjusting" sheet (a new instruction or one of the remembered ones, each with a title, editable) → the "adjust"
// app agent rephrases → the result lands on the clipboard. What is sent stays up to the card.
//
// Three parts, one module: `AdjustSelection` (ONE document listener — it only reacts to a selection INSIDE a
// `[data-adjust-scope]` node, i.e. the approval card), the sheet, and `AdjustToast` (the floating display at the bottom
// centre: running · done · error). Both root components hang in `layout.tsx`; the card only carries the attribute.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { adjustText, deleteAdjustPrompt, getAdjustPrompts, updateAdjustPrompt, type AdjustPrompt } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { field, ghostSm, Hint, Modal, ModalTitle, primary, Spinner } from "@/components/CbKit";

// ── Display state: module-wide, so sheet and toast need not hang in the same place ──
export type AdjustState =
  | { kind: "running"; text: string }
  | { kind: "finished"; fresh: string; copied: boolean }
  | { kind: "error"; error: string; fresh?: string };

let state: AdjustState | null = null;
const listener = new Set<(z: AdjustState | null) => void>();
function setState(z: AdjustState | null) {
  state = z;
  for (const l of listener) l(z);
}

async function inClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* without focus or permission: the toast's button stays the way */ }
  return false;
}

/** Start the run: sheet closes, toast shows "running", then "done" (with clipboard) or the error. */
export async function adjustExecute(text: string, choice: { prompt?: string; promptId?: string; title?: string }) {
  setState({ kind: "running", text });
  try {
    const r = await adjustText({ text, ...choice });
    const copied = await inClipboard(r.fresh);
    setState({ kind: "finished", fresh: r.fresh, copied });
    return r;
  } catch (e) {
    setState({ kind: "error", error: String((e as Error)?.message || e) });
    return null;
  }
}

// ── The pill at the selection ─────────────────────────────────────────────────────────────
function selectionInScope(): { text: string; rect: DOMRect } | null {
  if (typeof window === "undefined") return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el?.closest("[data-adjust-scope]")) return null;
  // A selection inside an input field (editing a parameter) belongs to the field, not the pill.
  if (el.closest("textarea, input")) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { text, rect };
}

export function AdjustSelection() {
  const t = useT();
  const [selection, setSelection] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);

  useEffect(() => {
    let raf = 0;
    const read = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setSelection(selectionInScope()));
    };
    document.addEventListener("selectionchange", read);
    // The pill moves with the text: re-measure on scroll and resize.
    window.addEventListener("scroll", read, true);
    window.addEventListener("resize", read);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", read);
      window.removeEventListener("scroll", read, true);
      window.removeEventListener("resize", read);
    };
  }, []);

  const open = useCallback(() => {
    if (!selection) return;
    setSheet(selection.text);
    setSelection(null);
  }, [selection]);

  if (typeof document === "undefined") return null;
  return (
    <>
      {selection && !sheet && createPortal(
        <div
          data-adjust-pill
          className="cb-kit fixed z-[70] -translate-x-1/2 -translate-y-full"
          style={{ left: Math.min(Math.max(selection.rect.left + selection.rect.width / 2, 72), window.innerWidth - 72), top: Math.max(selection.rect.top - 8, 44) }}
          // The pointer press must not dissolve the selection — otherwise nothing would be selected at click time.
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={open}
            className="cb-pop cb-pop-in-fast flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-medium text-fg shadow-lg transition-colors hover:bg-hover"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 4V2m0 20v-2m5-15-1.5 1.5M5.5 18.5 4 20m16 0-1.5-1.5M5.5 5.5 4 4M20 12h2M2 12h2" /><path d="m9 15 6-6 3 3-6 6H9v-3z" />
            </svg>
            {t("Adjust")}
          </button>
        </div>,
        document.body,
      )}
      {sheet !== null && <AdjustSheet text={sheet} onClose={() => setSheet(null)} />}
    </>
  );
}

// ── The sheet: a new instruction or a remembered one ─────────────────────────────────────
export function AdjustSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const t = useT();
  const [instruction, setInstruction] = useState("");
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<AdjustPrompt[] | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<{ id: string; title: string; prompt: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const fieldName = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try { setItems((await getAdjustPrompts()).items); }
    catch (e) { setError(String((e as Error)?.message || e)); setItems([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { fieldName.current?.focus(); }, []);

  const run = (choice: { prompt?: string; promptId?: string; title?: string }) => {
    onClose();
    void adjustExecute(text, choice);
  };
  const startNew = () => {
    const p = instruction.trim();
    if (!p) return;
    run({ prompt: p, title: title.trim() || undefined });
  };
  const save = async () => {
    if (!edit) return;
    try {
      const r = await updateAdjustPrompt(edit.id, { title: edit.title, prompt: edit.prompt });
      setItems((xs) => (xs || []).map((x) => (x.id === r.id ? r : x)));
      setEdit(null);
    } catch (e) { setError(String((e as Error)?.message || e)); }
  };
  const remove = async (id: string) => {
    try { setItems((await deleteAdjustPrompt(id)).items); if (edit?.id === id) setEdit(null); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  };

  const short = text.length > 240 && !textOpen ? text.slice(0, 240).trimEnd() + "…" : text;
  return (
    <Modal onClose={onClose} width={640} label={t("Instructions for adjusting")} z="z-[75]">
      <div data-adjust-sheet>
        <ModalTitle hint={t("The selected text is rephrased according to your instruction; the result is then on the clipboard.")}>{t("Instructions for adjusting")}</ModalTitle>

        <div className="mb-3 rounded-xl bg-bg px-3 py-2">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-dim">{t("Selected text")}</div>
          <p data-adjust-text className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg/85">{short}</p>
          {text.length > 240 && (
            <button type="button" onClick={() => setTextOpen((v) => !v)} className="mt-1 text-[11.5px] text-dim underline-offset-2 hover:underline">{textOpen ? t("Less") : t("Show full text")}</button>
          )}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-dim">{t("New instruction")}</span>
          <textarea
            ref={fieldName}
            data-adjust-instruction
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startNew(); } }}
            rows={4}
            placeholder={t("How should the text sound? e.g. “Casual and short, the way I write in Teams — informal, no period at the end”")}
            className={`${field} cb-scroll w-full resize-y leading-relaxed`}
          />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            data-adjust-title
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("Title to recognize it later (optional)")}
            className={`${field} min-w-0 flex-1`}
          />
          <button type="button" data-adjust-go onClick={startNew} disabled={!instruction.trim()} className={`${primary} bg-accent disabled:opacity-50`}>
            {t("Adjust")}
          </button>
        </div>
        <div className="mt-1 text-[11px] text-dim">{t("⌘⏎ adjusts. The instruction is remembered and listed below next time.")}</div>

        {error && <div className="mt-3"><Hint tone="danger">{error}</Hint></div>}

        <div className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-dim">{t("Recently used")}</div>
        {items === null ? (
          <div className="mt-2 text-[12px] text-dim">{t("Loading …")}</div>
        ) : items.length === 0 ? (
          <div className="mt-2 rounded-xl border border-dashed border-edge px-3 py-3 text-[12px] text-dim">{t("No instruction remembered yet — the first one appears here after the first adjustment.")}</div>
        ) : (
          <ul data-adjust-list className="mt-2 flex flex-col divide-y divide-edge/70 rounded-xl bg-bg">
            {items.map((it) => (
              <li key={it.id} data-adjust-entry={it.id} className="px-3 py-2">
                {edit?.id === it.id ? (
                  <div className="flex flex-col gap-2">
                    <input data-adjust-edit-title value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder={t("Title")} className={`${field} w-full bg-panel`} />
                    <textarea data-adjust-edit-prompt value={edit.prompt} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} rows={4} className={`${field} cb-scroll w-full resize-y bg-panel leading-relaxed`} />
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" onClick={() => setEdit(null)} className={ghostSm}>{t("Cancel")}</button>
                      <button type="button" data-adjust-edit-save onClick={save} disabled={!edit.prompt.trim()} className={`${primary} disabled:opacity-50`}>{t("Save")}</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <button type="button" onClick={() => setOpen((o) => (o === it.id ? null : it.id))} className="min-w-0 flex-1 text-left" title={t("Show instruction")}>
                      <div className="truncate text-[12.5px] font-medium">{it.title}</div>
                      <div className={`text-[11.5px] text-dim ${open === it.id ? "whitespace-pre-wrap break-words" : "truncate"}`}>{it.prompt}</div>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" data-adjust-edit onClick={() => setEdit({ id: it.id, title: it.title, prompt: it.prompt })} className={ghostSm} title={t("Edit title and instruction")}>{t("Edit")}</button>
                      <button type="button" data-adjust-remove onClick={() => void remove(it.id)} className={`${ghostSm} hover:border-danger/40 hover:text-danger`} title={t("Remove from the list")}>×</button>
                      <button type="button" data-adjust-with-it onClick={() => run({ promptId: it.id })} className={`${primary} bg-accent`}>{t("Adjust with this")}</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ── The floating display at the bottom centre ─────────────────────────────────────────────
export function AdjustToast() {
  const t = useT();
  const [z, setZ] = useState<AdjustState | null>(state);
  const [showNew, setShowNew] = useState(false);
  useEffect(() => {
    listener.add(setZ);
    return () => { listener.delete(setZ); };
  }, []);
  // "Done" disappears by itself — but only if the clipboard has it. Whoever still has to copy the text here needs the display until they pressed.
  useEffect(() => {
    setShowNew(false);
    if (z?.kind === "finished" && z.copied) {
      const tm = setTimeout(() => setState(null), 6000);
      return () => clearTimeout(tm);
    }
    return undefined;
  }, [z]);
  if (!z || typeof document === "undefined") return null;

  const copy = async () => {
    if (z.kind !== "finished") return;
    const ok = await inClipboard(z.fresh);
    if (ok) setState({ kind: "finished", fresh: z.fresh, copied: true });
  };
  const preview = z.kind === "finished" ? (z.fresh.length > 160 ? z.fresh.slice(0, 160).trimEnd() + "…" : z.fresh) : "";
  return createPortal(
    <div
      data-adjust-toast
      data-state={z.kind}
      role="status"
      aria-live="polite"
      className="cb-kit pointer-events-none fixed bottom-6 left-1/2 z-[80] flex -translate-x-1/2 justify-center px-3"
    >
      <div className="cb-pop cb-pop-in pointer-events-auto flex max-w-[min(560px,92vw)] flex-col gap-1.5 rounded-2xl px-4 py-2.5 text-[12.5px] text-fg shadow-xl">
        <div className="flex items-center gap-2.5">
          {z.kind === "running" && <span className="text-accent"><Spinner /></span>}
          {z.kind === "finished" && (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 5 5L20 7" /></svg>
            </span>
          )}
          {z.kind === "error" && <span className="text-danger">!</span>}
          <span className={`font-medium ${z.kind === "finished" ? "text-ok" : z.kind === "error" ? "text-danger" : ""}`}>
            {z.kind === "running" ? t("Adjusting text …")
              : z.kind === "finished" ? (z.copied ? t("Adjusted — on the clipboard") : t("Adjusted — please copy here"))
                : t("Adjusting failed: {error}", { error: z.error })}
          </span>
          <span className="flex-1" />
          {z.kind === "finished" && (
            <button type="button" data-adjust-copy onClick={() => void copy()} className={ghostSm}>{showNew ? t("Copy") : z.copied ? t("Copy again") : t("Copy")}</button>
          )}
          <button type="button" onClick={() => setState(null)} className="rounded-full px-1.5 text-dim transition-colors hover:text-fg" title={t("Close")} aria-label={t("Close")}>×</button>
        </div>
        {z.kind === "finished" && (
          <button type="button" onClick={() => setShowNew((v) => !v)} className="text-left text-[12px] leading-relaxed text-fg/80" title={t("Show full text")}>
            <span data-adjust-new className={showNew ? "whitespace-pre-wrap break-words" : "line-clamp-2"}>{showNew ? z.fresh : preview}</span>
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
