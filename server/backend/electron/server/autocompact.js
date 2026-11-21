// Automatic compaction.
//
// The providers compact on their own (Claude Code and Codex at about 95% of their window, the
// loop engine at 78%, COMPACT_AT). That is late: answer quality drops earlier, and on a
// subscription every request with full context counts against the limit. cbase has its OWN
// compaction (`compactChatContext` in runs/post-run.js: summary, fresh session, the summary
// precedes the next turn), but it only ran on demand (/compact, button, provider switch,
// workflow node).
//
// This module holds the RULE, not the execution: from which share of the context window cbase
// compacts by itself after a run. It applies equally to all providers because it sits in the
// harness, not at the provider. Two levels: a global default (app_settings) and a THREE-VALUED
// value per chat (default, off, stage); "default" is the absence of a value (NULL), never a
// stored value.

// Shares in percent; 0 means "off". Fixed stages instead of free text: a number like 63 says
// nothing 60 does not, and the UI shows a segmented control, not a number input.
export const STAGES = [30, 40, 50, 60, 70, 80, 90];
export const OUT = 0;
export const SETTING_KEY = "autocompact.percent";
export const PRESET = OUT; // off: the house behaviour only changes once someone sets it

// The CAP in tokens, and why it is needed: a share alone depends on the model's context window,
// which is registered as 1,000,000 for all Claude models except Haiku. The smallest stage (30%)
// means 300,000 tokens there, the obvious one (60%) 600,000; three requests of a chat with
// 304,140 tokens of context consumed 32% of the 5-hour quota. A share that only bites at half a
// million is a promise without effect. The cap is the second, absolute limit: compaction
// happens at the EARLIER of the two points.
//
// Like the share it is THREE-VALUED per chat (default, off, stage): "what does a turn cost at
// most" is the same question for all chats only as a default, not for the single case (a long
// research turn may cost more than a scheduled wake-up). The menu on the context bar shows both
// controls side by side as selection lists.
// 50k steps up to one million: windows range from 200k to 1.31M, and between 300k and 500k a turn
// becomes noticeably expensive, so that is where fine choice is wanted.
export const MAX_STAGES = Array.from({ length: 20 }, (_, i) => (i + 1) * 50_000);
export const NO_CAP = 0;
export const MAX_KEY = "autocompact.maxTokens";
// OFF as the default, like the share. The cap is a trigger of its own (see `threshold`); with a
// number as default the rollout would silently have enabled autocompact on every installation.
export const MAX_DEFAULT = NO_CAP;

// A value from a form or request -> valid stage, 0 (off) or null (invalid).
export function stage(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n === OUT) return OUT;
  return STAGES.includes(n) ? n : null;
}

// The same for the cap: valid stage, 0 (no cap) or null (invalid).
export function maxStage(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n === NO_CAP) return NO_CAP;
  return MAX_STAGES.includes(n) ? n : null;
}

// Global default from the app settings; a broken value falls back to the preset.
export function globalValueOf(getSetting) {
  const s = stage(getSetting(SETTING_KEY, ""));
  return s === null ? PRESET : s;
}

export function globalerMax(getSetting) {
  const s = maxStage(getSetting(MAX_KEY, ""));
  return s === null ? MAX_DEFAULT : s;
}

// The value that applies to THIS chat: its own choice, else the global one.
export function effective(chatValue, globalValue) {
  const s = stage(chatValue);
  return s === null ? globalValue : s;
}

// The cap that applies to THIS chat: its own choice, else the global one. Same three-valuedness
// as the share: `null` is the absence of a choice, not zero.
export function maxEffective(chatValue, globalMax) {
  const s = maxStage(chatValue);
  return s === null ? (Number(globalMax) || 0) : s;
}

// Where THIS chat's threshold lies, in tokens. 0 means "never".
//
// TWO EQUAL TRIGGERS, compaction happens at the earlier one. If the share were the main switch
// and the cap only its tightening, "at the latest at 500k" with the share on "off" would never
// fire (a real case: chat at 652,705 tokens, no compaction). Two controls where one silently
// disables the other are a trap; "at the latest at 500,000 tokens" is a complete instruction.
// Off is the rule when BOTH are off.
//
// Without a known window the cap carries alone: it is a registered number, not a guess; a share
// without a window stays without effect.
export function threshold({ window, percent, absolute }) {
  const p = Number(percent) || 0;
  const f = Number(window) || 0;
  const a = Number(absolute) || 0;
  const fromShare = p > 0 && f > 0 ? (f * p) / 100 : 0;
  const fromCap = a > 0 ? a : 0;
  if (fromShare > 0 && fromCap > 0) return Math.min(fromShare, fromCap);
  return fromShare || fromCap;
}

// Compaction is due when the context has reached the threshold.
export function due({ tokens, window, percent, absolute }) {
  const s = threshold({ window, percent, absolute });
  const t = Number(tokens) || 0;
  return s > 0 && t > 0 && t >= s;
}

// For the loop engine: the same threshold as a fraction of ITS window (it computes in shares, not
// tokens). When compaction is "off" it keeps its own safety valve (fallback): "off" means "not
// earlier than necessary", not "fail at the window".
export function engineShare(percent, fallback, { window = 0, absolute = 0 } = {}) {
  const p = Number(percent) || 0;
  const f = Number(window) || 0;
  const a = Number(absolute) || 0;
  const fromShare = p > 0 ? p / 100 : 0;
  const fromCap = a > 0 && f > 0 ? a / f : 0;
  if (fromShare > 0 && fromCap > 0) return Math.min(fromShare, fromCap);
  return fromShare || fromCap || fallback;
}

// Compaction IN A WORKFLOW: while a run is open, the workflow's value applies if it is not
// "default"; else the chat's; else the global one. The workflow value is NEVER written to the
// chat; after the run the chat's choice applies again, unchanged. `0` on the workflow means
// "off" and overrides chat and global.
export function workflowShare(wfValue, chatValue, global) {
  const s = stage(wfValue);
  return s === null ? effective(chatValue, global) : s;
}
export function workflowCap(wfValue, chatValue, globalMax) {
  const s = maxStage(wfValue);
  return s === null ? maxEffective(chatValue, globalMax) : s;
}
