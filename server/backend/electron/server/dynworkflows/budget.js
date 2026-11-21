// The budget of a turn: "+500k". When the human writes "+500k" in their message, the turn gets a HARD upper bound for
// output tokens — shared by the main run and all dynamic workflows this turn starts: `budget.spent()` sums the output of the main
// run and of every workflow agent of the turn — one pool, not one per workflow. The script
// sees it as `budget.total`; once reached, every further `agent()` throws, and the slots in `parallel`/`pipeline` that
// still wanted an agent afterwards are dropped with a note (sandbox.js, 1:1 like the baseline). Running agents run to
// their end — an agent is counted when it ends.
//
// DETECTION: only the ONE reading of the turn's human input (runs/human-input.js) — across bundles and injection;
// channel, schedule, event and completion notice never set a budget (a workflow result containing "+500k" does not open
// a new one for the next turn). Two spellings: "+500k" as a word of its own (digits with optional decimals, unit k/m/b
// in any case, preceded by start or whitespace, followed by no word character) and the baseline's "use 2M tokens"/
// "spend 500k tokens". Several statements: the LAST one wins (the newest input, in it the last position).
// The baseline binary carried the second regex only up to 2.1.294; the guide of its workflow tool still names `budget`
// and "+500k". cbase recognises both spellings unchanged — the second is a cbase trait since then, no longer a mirror.
//
// COUNTING: the pot of a turn (`potFor`) = output of the main run in this turn (runs/turn-output.js) + output of the
// workflow agents of all runs of this turn (`book` at the agent's end) + what a resumed run had already consumed
// (`prior`, from the run's row — a restart after deploy/crash keeps its upper bound). With Codex and the loop engine
// the consumption an agent reports is a lower bound; it counts anyway. A budget in limit percent is out of scope.
import { humanInput, turnIdentifier } from "../runs/human-input.js";
import { mainOutput } from "../runs/turn-output.js";

const UNIT = { k: 1e3, m: 1e6, b: 1e9 };
const PLUS = /(?:^|\s)\+(\d+(?:\.\d+)?)\s?([kmb])(?![\p{L}\p{N}_])/giu;
// Baseline (Claude Code up to 2.1.294): /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i
const WORDS = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/gi;

/** The budget in this (human-typed) text — tokens as an integer, `null` = none stated. */
export function budgetFromText(text) {
  const t = typeof text === "string" ? text : "";
  let last = null;
  for (const re of [PLUS, WORDS]) {
    for (const m of t.matchAll(re)) {
      if (!last || m.index >= last.index) last = { index: m.index, count: Number(m[1]), unit: m[2].toLowerCase() };
    }
  }
  if (!last) return null;
  const n = Math.floor(last.count * UNIT[last.unit]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The budget of the running turn from the human input — `null` without a turn or without a statement. */
export function budgetInTurn(chatId) {
  const texts = humanInput(chatId);
  if (!Array.isArray(texts)) return null;
  for (let i = texts.length - 1; i >= 0; i--) {
    const n = budgetFromText(texts[i]);
    if (n !== null) return n;
  }
  return null;
}

/** What a start in the running turn takes along: the target and the turn's identifier (both may be missing). */
export const budgetOfTheTurn = (chatId) => ({ total: budgetInTurn(chatId), turnId: turnIdentifier(chatId) });

// Turn identifier → pot. All runs of the same turn share ONE pot. Capped like the main run's counters.
const POTS_MAX = 500;
const pots = new Map();

/**
 * The pot of a run. Empty `turnId` (restart, resume without a turn) ⇒ a pot of its own without a main-run share.
 * `prior`: what the run had already consumed before a restart (main run and agents together).
 * @returns {{ total: number|null, consumed: () => number, book: (n: number) => void }}
 */
export function potFor({ total = null, turnId = "", prior = 0 } = {}) {
  const target = Number.isSafeInteger(total) && total > 0 ? total : null;
  let t = turnId ? pots.get(turnId) : null;
  if (!t) {
    t = { agents: 0 };
    if (turnId) {
      pots.set(turnId, t);
      if (pots.size > POTS_MAX) pots.delete(pots.keys().next().value);
    }
  }
  const base = Number(prior) > 0 ? Number(prior) : 0;
  return {
    total: target,
    consumed: () => base + mainOutput(turnId) + t.agents,
    book: (n) => { if (Number(n) > 0) t.agents += Number(n); },
  };
}
