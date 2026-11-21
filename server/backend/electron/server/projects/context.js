// Project context (knowledge per project): categories and slugs, OKF status/confidence, validateOkf, resolveContextLinks,
// FILE_CATEGORY_MAP, firstHeading, lastContextWrite/markContextWrite, curateAfterRun (curator after the run), dumpIntoProject.

import { classifyProjectDump, curateContext, mergeProjectContext } from "../claude.js";
import { DUP_BLOCK, findSimilarContext } from "../dedup.js";
import { missingCodePaths } from "../okf.js";
import * as store from "../store.js";
import { CURATOR_ENABLED, agentRunFor } from "../settings/agent-models.js";
import { sse } from "../runtime/sse.js";
import { withFormHints, checkContextForm } from "./context-form.js";

// Fixed category set for the project context. The labels are English; the clients translate them (their tables are keyed by
// exactly these texts).
const PROJECT_CATEGORIES = [
  { slug: "overview", label: "Overview" },
  { slug: "domain", label: "Domain" },
  { slug: "architecture", label: "Architecture" },
  { slug: "repositories", label: "Repositories" },
  { slug: "setup", label: "Setup & operations" },
  { slug: "decisions", label: "Decisions" },
  { slug: "pitfalls", label: "Pitfalls" },
  { slug: "open-points", label: "Open items" },
  { slug: "deliverables", label: "Deliverables" },
  { slug: "references", label: "References" },
];
const PROJECT_CATEGORY_SLUGS = new Set(PROJECT_CATEGORIES.map((c) => c.slug));

// ── OKF validator (deterministic, no LLM) ────────────────────────────────
// Checks only fields that were SENT — old entries without OKF fields stay updatable. The error texts are deliberately
// instructive: they reach the agent exactly at the moment of writing.
const OKF_STATUS = new Set(["active", "deprecated", "superseded"]);
const OKF_CONFIDENCE = new Set(["high", "medium", "low"]);
function validateOkf(b, { slugs, projPath = null, selfSlug = "" }) {
  const problems = [];
  if (b.status !== undefined && b.status !== null && !OKF_STATUS.has(String(b.status))) {
    problems.push(`status must be active|deprecated|superseded (not "${b.status}"). Outdated entries become deprecated, never deleted.`);
  }
  if (b.confidence !== undefined && b.confidence !== null && b.confidence !== "" && !OKF_CONFIDENCE.has(String(b.confidence))) {
    problems.push(`confidence must be high|medium|low (not "${b.confidence}").`);
  }
  if (b.supersededBy) {
    if (!slugs.has(String(b.supersededBy))) problems.push(`supersededBy "${b.supersededBy}" does not exist — give the slug of the superseding entry (cbase_context_list shows the slugs).`);
    else if (String(b.supersededBy) === (selfSlug || String(b.slug || ""))) problems.push("An entry cannot supersede itself — supersededBy must point to ANOTHER entry.");
  }
  if (b.links !== undefined && b.links !== null) {
    if (typeof b.links !== "object" || Array.isArray(b.links)) {
      problems.push(`links must be an object {related|depends_on|supersedes|conflicts_with: [slug,…]}.`);
    } else {
      for (const kind of Object.keys(b.links)) {
        if (!store.LINK_KINDS.includes(kind)) problems.push(`Unknown link type "${kind}" — allowed: ${store.LINK_KINDS.join(", ")}.`);
      }
      const targets = Object.values(b.links).flat().filter(Boolean).map(String);
      const dangling = targets.filter((t) => !slugs.has(t) && t !== selfSlug);
      if (dangling.length) problems.push(`Link targets do not exist: ${dangling.join(", ")} — link existing slugs (cbase_context_list) or create the entries first.`);
      if (selfSlug && targets.includes(selfSlug)) problems.push(`An entry must not link to itself (${selfSlug}).`);
    }
  }
  if (b.codePaths !== undefined && b.codePaths !== null) {
    if (!Array.isArray(b.codePaths)) {
      problems.push("codePaths must be an array of project-relative paths (file or folder).");
    } else if (projPath) {
      const missing = missingCodePaths(projPath, b.codePaths);
      if (missing.length) problems.push(`code_paths do not exist in the project folder: ${missing.join(", ")} — give paths relative to the project folder.`);
    }
  }
  return problems;
}

// Resolve linked entries as metadata (traversal without full text); mark dead links.
function resolveContextLinks(pid, it) {
  if (!it.links) return undefined;
  const slugs = store.projectContextSlugs(pid);
  const out = {};
  for (const [kind, targets] of Object.entries(it.links)) {
    out[kind] = targets.map((slug) => {
      const t = slugs.get(slug);
      return t ? { slug, id: t.id, title: t.title, status: t.status } : { slug, dangling: true };
    });
  }
  return out;
}
// Old file name (without .md, lowercase) → category slug, for the folder migration.
const FILE_CATEGORY_MAP = {
  readme: "overview", domain: "domain", architecture: "architecture",
  repos: "repositories", repositories: "repositories", setup: "setup",
  gotchas: "pitfalls", pitfalls: "pitfalls", todos: "open-points", deliverables: "deliverables",
  references: "references",
};

const firstHeading = (md) => {
  const m = String(md).match(/^#+\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 200) : "";
};

// Remembers when the project context was last written DIRECTLY (via the API, e.g. by the main LLM through a skill). The basis
// for the curator running only as a backup when the main LLM did not maintain anything itself.
const lastContextWrite = new Map(); // projectId -> timestamp
const markContextWrite = (projectId) => { if (projectId) lastContextWrite.set(projectId, Date.now()); };

// Runs after a successful project chat run: a small LLM distills project knowledge from the exchange and stores SUGGESTIONS
// (the user confirms them). Without `cwd`: the curator runs sandboxed (../claude.js curateContext).
async function curateAfterRun(chat, userText, assistantText, runStart, { approval = false } = {}) {
  try {
    if (!CURATOR_ENABLED) return; // curator disabled (the server's dedup check prevents duplicates instead)
    if (!chat.projectId || !assistantText) return;
    // Backup role: if the main LLM maintained context itself during the run, no curation is needed — the primary (better
    // informed) path took effect.
    const lw = lastContextWrite.get(chat.projectId);
    if (lw && runStart && lw >= runStart) return;
    const proj = store.getProject(chat.projectId);
    if (!proj) return;
    const existing = store.listProjectContext(chat.projectId, { withBody: false })
      .map((e) => ({ id: e.id, category: e.category, title: e.title, summary: e.summary }));
    const suggestions = await curateContext({
      userText, assistantText, existing, categories: PROJECT_CATEGORIES, ...agentRunFor("curator"), chatId: chat.id, approval,
    });
    for (const s of suggestions) {
      store.insertSuggestion(chat.projectId, chat.id, {
        op: s.op, targetId: s.targetId ?? null, category: s.category || "", title: s.title || "",
        body: s.body || "", summary: s.summary || "", tags: s.tags || "", validAsOf: s.validAsOf || "", reason: s.reason || "",
      });
    }
    if (suggestions.length) sse(chat.id, { type: "harness", subtype: "curator_suggestions", count: suggestions.length, projectId: chat.projectId });
  } catch {
    // Curation is best effort — errors must never affect the chat.
  }
}
// Hook afterRun/"curate" (registered in server.js): the turn has ended cleanly, after `run_done` — the curator runs WITH
// this turn's approval (`approval` comes from the payload) and without await. It does not read the payload's `cwd` (the
// curator runs sandboxed).
function curateHook({ chat, text, resultText, runStart, approval }) {
  return curateAfterRun(chat, text, resultText, runStart, { approval });
}

// Fully autonomous project dump: classifies the text and creates it as a new entry OR merges it into an existing one
// (semantic dedup, conservative threshold). Returns {status:"created"|"updated", item, mergedInto?, mergedTitle?}. Used by
// the project dump route AND by workspace routing (explicit/detected project). Without `cwd`: classification and merging
// run sandboxed (../claude.js).
async function dumpIntoProject(pid, text, source = "dumpster") {
  const cls = await classifyProjectDump({ text, categories: PROJECT_CATEGORIES, ...agentRunFor("curator") });
  let target = null;
  try {
    const existing = store.listProjectContext(pid, { withBody: true });
    // This merges into an existing entry WITHOUT asking — so the strict blocking threshold applies, not the hint threshold.
    // A miss would write foreign knowledge into an unrelated entry, and nobody would see it.
    const candidates = findSimilarContext(existing, { title: cls.title, summary: cls.summary, body: cls.body, category: cls.category, tags: cls.tags }, { threshold: DUP_BLOCK, limit: 1 });
    if (candidates[0]?.blocking) target = existing.find((e) => e.id === candidates[0].id) || null;
  } catch {}
  markContextWrite(pid);
  if (target) {
    try {
      const merged = await mergeProjectContext({ existing: target, incomingText: text, categories: PROJECT_CATEGORIES, ...agentRunFor("curator") });
      const item = store.updateProjectContext(pid, target.id, { ...merged, source: target.source || source });
      // The FORM of the merged entry (context-form.js) — hints only: a model sorted the text, not the caller.
      const { formHints } = checkContextForm({ ...merged, category: merged.category ?? target.category });
      return withFormHints({ status: "updated", item, mergedInto: target.id, mergedTitle: target.title }, formHints);
    } catch {
      // Merge failed → create as a new entry so that the drop is not lost.
    }
  }
  const item = store.createProjectContext(pid, {
    category: cls.category, title: cls.title, body: cls.body, summary: cls.summary,
    tags: cls.tags, source, validAsOf: "", pinned: false,
  });
  const { formHints } = checkContextForm({ title: cls.title, summary: cls.summary, body: cls.body, category: cls.category });
  return withFormHints({ status: "created", item }, formHints);
}

export { FILE_CATEGORY_MAP, PROJECT_CATEGORIES, PROJECT_CATEGORY_SLUGS, curateAfterRun, dumpIntoProject, curateHook, firstHeading, markContextWrite, resolveContextLinks, validateOkf };
