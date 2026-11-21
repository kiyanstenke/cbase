// Pager logic of the question card (AskCard): one question per page, "Previous"/"Next", send only once all questions are answered.
// No React: the contract between page index, answer state and send lock is where the card can go wrong without a type error reporting
// it (an index from user data, a counter that takes whitespace as an answer). Hence it lives here and is checked in the gate
// (web/test/ask-pager.test.mjs).

// Clamp the page index to 0…m-1. An index from state is an index from user data: with m = 0 or a non-number, 0 comes out, never NaN
// and never an access outside the list.
export function clampIndex(i: number, m: number): number {
  if (!Number.isFinite(m) || m <= 0) return 0;
  const n = Number.isFinite(i) ? Math.trunc(i) : 0;
  if (n < 0) return 0;
  return n > m - 1 ? m - 1 : n;
}

// A question is answered if an option is chosen OR own text is present. Whitespace alone is no text; otherwise a space in the field
// would unlock sending.
export function isAnswered(selection: readonly string[] | undefined, text: string | undefined): boolean {
  return (selection?.length ?? 0) > 0 || (text ?? "").trim().length > 0;
}

// How many of the m questions are still open. The arrays are kept per question; a question without an entry (yet) counts as open:
// empty is not answered.
export function openQuestions(
  picked: readonly (readonly string[])[],
  free: readonly string[],
  m: number = picked.length,
): number {
  let open = 0;
  for (let i = 0; i < m; i++) if (!isAnswered(picked[i], free[i])) open++;
  return open;
}

export function isComplete(
  picked: readonly (readonly string[])[],
  free: readonly string[],
  m: number = picked.length,
): boolean {
  return m > 0 && openQuestions(picked, free, m) === 0;
}

// The pager appears ONLY live (answerable and not yet answered) and ONLY with more than one question. A single question stays
// character-identical; an answered or skipped card shows all questions stacked: the history should be readable without clicking.
export function showPager(questions: { length: number }, live: boolean): boolean {
  return live && questions.length > 1;
}
