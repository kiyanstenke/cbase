"use client";

// Choice card for the agent's questions (tool cbase_ask): the agent asks a question and attaches its recommendations as
// options — the user answers with ONE CLICK instead of typing. For a single single-choice question the click sends the
// answer immediately; with multiple choice or several questions the confirm button appears first. Several questions are
// paged (one question per page, "Previous"/"Next") — four stacked questions with six options each could not be taken in.
// Paging is free (skip, come back later); only sending requires all questions answered, and it says how many are missing.
// The answer format stays ONE onSubmit with all answers. Answered cards stay in the history without pager and show all
// questions with the chosen option.
import { useState } from "react";
import { Markdown } from "@/components/Markdown";
import { useT } from "@/lib/i18n";
import { isComplete, clampIndex, openQuestions, showPager } from "@/lib/askPager";
import { ic } from "@/components/CbKit";
import { CARD, CARDS_HEADER, BUTTON_MAIN, BUTTON_BESIDE } from "@/components/chat/StatusLine";

export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: AskOption[];
}
export interface AskAnswer {
  header?: string;
  question: string;
  selected: string[];
  text?: string;
}

const AskIcon = () => ic(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M9.2 8.6a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.3-2.7 2.3" /><path d="M12 15h.01" /></>, 14);
const CheckIcon = () => ic(<path d="M20 6L9 17l-5-5" />, 12);
const PenIcon = () => ic(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>, 12);

// The form of all cards in the history lives in chat/StatusLine.tsx — send is the main button in text color, paging its quiet
// neighbour with a border.
const SEND_CLASS = BUTTON_MAIN;
const PAGINATE_CLASS = BUTTON_BESIDE;

export function AskCard({
  questions,
  answers,
  answerable,
  onSubmit,
  answeredVia,
}: {
  questions: AskQuestion[];
  answers?: AskAnswer[] | null;
  answerable: boolean;
  onSubmit: (answers: AskAnswer[]) => void;
  // Who answered the card, if not the user — "via channel ‹name› from ‹sender›". Without the mark another agent's answer
  // would read like the user's own.
  answeredVia?: string | null;
}) {
  const t = useT();
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [free, setFree] = useState<string[]>(() => questions.map(() => ""));
  const [writing, setWriting] = useState<boolean[]>(() => questions.map(() => false));
  // Page of the pager. The questions hang on the requestId and do not change — it is clamped on every read anyway, an index
  // from state is an index from user data.
  const [index, setIndex] = useState(0);

  const done = Boolean(answers?.length);
  const live = answerable && !done;
  // Only one single-choice question: the click IS the answer (no confirm needed).
  const instant = questions.length === 1 && !questions[0]?.multiSelect;
  const pager = showPager(questions, live);
  const page = clampIndex(index, questions.length);
  const last = questions.length - 1;

  const build = (state: string[][], texts: string[]): AskAnswer[] =>
    questions.map((q, i) => ({
      header: q.header,
      question: q.question,
      selected: state[i] ?? [],
      text: (texts[i] ?? "").trim(),
    }));
  const complete = (state: string[][], texts: string[]) => isComplete(state, texts, questions.length);

  function toggle(qi: number, label: string) {
    if (!live) return;
    const q = questions[qi];
    if (instant) { onSubmit(build(questions.map((_, i) => (i === qi ? [label] : [])), free)); return; }
    setPicked((prev) => {
      const copy = prev.map((x) => [...x]);
      const cur = copy[qi] ?? [];
      copy[qi] = q.multiSelect
        ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
        : (cur[0] === label ? [] : [label]);
      return copy;
    });
  }

  // Free text ("own answer") — for a single single-choice question Enter sends it directly; otherwise it merges with the
  // options on submit (no button of its own needed).
  function sendFree(qi: number) {
    if (!instant || !live) return;
    if (!(free[qi] ?? "").trim()) return;
    onSubmit(build(questions.map(() => []), free));
  }

  const chosenOf = (qi: number): string[] => (done ? answers![qi]?.selected ?? [] : picked[qi] ?? []);
  const textOf = (qi: number): string => (done ? answers![qi]?.text ?? "" : free[qi] ?? "");

  // One question with header pill, options and own answer. The states live per question in the arrays above — a page change
  // of the pager therefore loses nothing.
  function renderQuestion(qi: number) {
    const q = questions[qi];
    if (!q) return null;
    const chosen = chosenOf(qi);
    const text = textOf(qi);
    return (
      <div key={qi} className="flex flex-col gap-1.5" data-ask-question={qi}>
        {/* The header pill (`q.header`) before the question is not shown any more. The header still travels with the answer
            (`build`); it is just not displayed. */}
        <div className="cb-chat-text min-w-0 text-[13px] font-medium text-fg">
          <Markdown src={q.question} />
        </div>
        <div className="flex flex-col gap-1">
          {q.options.map((o, oi) => {
            const on = chosen.includes(o.label);
            return (
              <button
                key={oi}
                type="button"
                disabled={!live}
                onClick={() => toggle(qi, o.label)}
                data-ask-option={o.label}
                className={`flex items-start gap-2.5 rounded-xl border px-2.5 py-1.5 text-left transition-colors ${
                  on ? "border-fg/25 bg-hover" : "border-transparent bg-bg"
                } ${live ? "hover:bg-hover" : "cursor-default"} ${!live && !on ? "opacity-70" : ""}`}
              >
                <span
                  className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center border ${
                    q.multiSelect ? "rounded-[4px]" : "rounded-full"
                  } ${on ? "border-fg bg-fg text-bg" : "border-dim/50"}`}
                >
                  {on ? <CheckIcon /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium text-fg">{o.label}</span>
                  {o.description && <span className="mt-0.5 block text-[11.5px] leading-snug text-dim">{o.description}</span>}
                </span>
              </button>
            );
          })}
        </div>

        {/* Own answer — always possible, even with options. */}
        {!live ? (
          text ? (
            <div className="flex items-start gap-1.5 pl-0.5 text-[11.5px] text-dim">
              <span className="mt-[3px] shrink-0"><PenIcon /></span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
            </div>
          ) : null
        ) : writing[qi] ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={free[qi] ?? ""}
              onChange={(e) => setFree((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendFree(qi); } }}
              placeholder={t("Own answer …")}
              className="min-w-0 flex-1 rounded-xl bg-bg px-2.5 py-1.5 text-[12.5px] text-fg outline-none transition-colors placeholder:text-dim focus:bg-panel focus:ring-1 focus:ring-fg/20"
            />
            {instant && (
              <button
                type="button"
                disabled={!(free[qi] ?? "").trim()}
                onClick={() => sendFree(qi)}
                className={`shrink-0 ${SEND_CLASS}`}
              >
                {t("Send")}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setWriting((prev) => prev.map((v, i) => (i === qi ? true : v)))}
            className="flex items-center gap-1.5 self-start rounded-full px-1 py-0.5 text-[11.5px] font-medium text-dim hover:text-fg"
          >
            <PenIcon />
            {t("Own answer")}
          </button>
        )}
      </div>
    );
  }

  // The lock on sending must say why it locks — counted over ALL pages, not only the visible one.
  const open = live ? openQuestions(picked, free, questions.length) : 0;
  const openHint = open === 1 ? t("1 question still open") : t("{k} questions still open", { k: open });

  return (
    <div className={CARD}>
      <div className={CARDS_HEADER}>
        <AskIcon />
        <span className="font-medium text-fg">{t("Question##ask")}</span>
        {done && (
          <span className="flex items-center gap-1">
            <CheckIcon />
            {t("answered")}
          </span>
        )}
        {done && answeredVia && <span>{answeredVia}</span>}
        {!done && !answerable && <span>{t("skipped")}</span>}
        {pager && (
          <span className="ml-auto shrink-0" data-ask-page={page + 1}>
            {t("Question {n} of {m}", { n: page + 1, m: questions.length })}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {pager ? renderQuestion(page) : questions.map((_, qi) => renderQuestion(qi))}
      </div>

      {live && !instant && (
        pager ? (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setIndex(clampIndex(page - 1, questions.length))}
              className={PAGINATE_CLASS}
              data-ask-prev
            >
              {t("Previous")}
            </button>
            <span className="min-w-0 flex-1" />
            {page < last ? (
              <button
                type="button"
                onClick={() => setIndex(clampIndex(page + 1, questions.length))}
                className={SEND_CLASS}
                data-ask-next
              >
                {t("Next")}
              </button>
            ) : (
              <>
                {open > 0 && <span className="text-[11.5px] text-dim" data-ask-open={open}>{openHint}</span>}
                <button
                  type="button"
                  disabled={open > 0}
                  onClick={() => onSubmit(build(picked, free))}
                  className={SEND_CLASS}
                  data-ask-send
                >
                  {t("Send answer")}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={!complete(picked, free)}
              onClick={() => onSubmit(build(picked, free))}
              className={SEND_CLASS}
              data-ask-send
            >
              {t("Send answer")}
            </button>
          </div>
        )
      )}
    </div>
  );
}
