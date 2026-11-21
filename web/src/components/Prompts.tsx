"use client";

// Replacement for window.prompt() and window.confirm().
//
// prompt(): Electron does not support it; usePrompt() returns
// ask(label, initial?) => Promise<string | null>.
//
// confirm(): the native window is a foreign body of the operating system in front of a page
// of flat surfaces, and it can be neither labelled nor coloured ("Delete" and "Restore" looked
// the same in it). useConfirm() returns
// question(text, { ok, danger, title }) => Promise<boolean>; the sheet is the same as in every
// other modal of the app (`cb-sheet`), and a destructive path carries its colour.
// A question can carry a checkbox ("Don't ask again" as in VS Code `explorer.confirmDragAndDrop`):
// `checkMark.onConfirm(checked)` runs only after "yes"; whoever cancels has changed nothing.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { FlatContext } from "@/components/CbKit";

type Ask = (label: string, initial?: string) => Promise<string | null>;
type QuestionOpts = { ok?: string; danger?: boolean; title?: string; checkMark?: { text: string; onConfirm: (checked: boolean) => void } };
type Question = (text: string, opts?: QuestionOpts) => Promise<boolean>;
// The sheets stand here at the root of the app, not where the question is asked; whether they carry the flat form
// of the Coding chat (CbKit `FlatContext`) only the caller knows. The hook reads the context at the
// call site and passes it through as the third value.
type AskIntern = (label: string, initial?: string, flat?: boolean) => Promise<string | null>;
type QuestionIntern = (text: string, opts?: QuestionOpts, flat?: boolean) => Promise<boolean>;

const PromptCtx = createContext<AskIntern>(() => Promise.resolve(null));
// Without a provider (tests, isolated embedding) the question falls back to the native window;
// a question that silently says "yes" would be the costlier error.
const ConfirmCtx = createContext<QuestionIntern>((text) => Promise.resolve(typeof window !== "undefined" ? window.confirm(text) : false));

export const usePrompt = (): Ask => {
  const ask = useContext(PromptCtx);
  const flat = useContext(FlatContext);
  return useCallback<Ask>((label, initial) => ask(label, initial, flat), [ask, flat]);
};
export const useConfirm = (): Question => {
  const questions = useContext(ConfirmCtx);
  const flat = useContext(FlatContext);
  return useCallback<Question>((text, opts) => questions(text, opts, flat), [questions, flat]);
};

interface Req {
  label: string;
  flat?: boolean;
  resolve: (v: string | null) => void;
}
interface QuestionReq {
  text: string;
  title?: string;
  ok?: string;
  danger?: boolean;
  checkMark?: QuestionOpts["checkMark"];
  flat?: boolean;
  resolve: (v: boolean) => void;
}

const buttonEl = "rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors";

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [req, setReq] = useState<Req | null>(null);
  const [question, setQuestion] = useState<QuestionReq | null>(null);
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  const ask = useCallback<AskIntern>((label, initial = "", flat) => {
    return new Promise((resolve) => {
      setValue(initial);
      setReq({ label, flat, resolve });
      setTimeout(() => inputRef.current?.focus(), 0);
    });
  }, []);

  const questions = useCallback<QuestionIntern>((text, opts = {}, flat) => {
    return new Promise((resolve) => {
      setChecked(false);
      setQuestion({ text, resolve, flat, ...opts });
      setTimeout(() => okRef.current?.focus(), 0);
    });
  }, []);

  function close(result: string | null) {
    req?.resolve(result);
    setReq(null);
  }
  function respond(result: boolean) {
    if (result) question?.checkMark?.onConfirm(checked);
    question?.resolve(result);
    setQuestion(null);
  }

  // Escape means "no" or "cancel", in both sheets.
  useEffect(() => {
    if (!req && !question) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (question) respond(false);
      else close(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, question]);

  return (
    <PromptCtx.Provider value={ask}>
    <ConfirmCtx.Provider value={questions}>
      {children}
      {req && (
        <div className={`cb-overlay cb-overlay-in fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-6${req.flat ? " cb-flat" : ""}`} onClick={() => close(null)}>
          <div
            className="cb-sheet cb-pop-in w-[min(480px,92vw)] rounded-3xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-[15px] font-semibold tracking-tight">{req.label}</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                close(value);
              }}
            >
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-xl bg-bg px-3.5 py-2 text-[13px] text-fg outline-none transition-colors focus:bg-panel focus:ring-1 focus:ring-accent/50"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => close(null)}
                  className={`${buttonEl} border border-edge text-dim hover:bg-hover hover:text-fg`}
                >
                  {t("Cancel")}
                </button>
                <button type="submit" className={`${buttonEl} bg-dark text-white hover:opacity-90`}>
                  OK
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {question && (
        <div
          role="alertdialog"
          aria-modal="true"
          className={`cb-overlay cb-overlay-in fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-6${question.flat ? " cb-flat" : ""}`}
          onClick={() => respond(false)}
        >
          <div
            className="cb-sheet cb-pop-in w-[min(440px,92vw)] rounded-3xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {question.title && <div className="mb-1.5 text-[15px] font-semibold tracking-tight">{question.title}</div>}
            <p className="text-[13px] leading-relaxed text-fg">{question.text}</p>
            {question.checkMark && (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px] text-dim" data-question-check-mark>
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                {question.checkMark.text}
              </label>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => respond(false)}
                className={`${buttonEl} border border-edge text-dim hover:bg-hover hover:text-fg`}
              >
                {t("Cancel")}
              </button>
              <button
                ref={okRef}
                type="button"
                onClick={() => respond(true)}
                className={`${buttonEl} ${question.danger ? "bg-danger text-white hover:opacity-90" : "bg-dark text-white hover:opacity-90"}`}
              >
                {question.ok || "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
    </PromptCtx.Provider>
  );
}
