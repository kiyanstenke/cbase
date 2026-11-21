/**
 * Small computations around skill changes: read the result of the `cbase_skill_write` tool in the chat and say, per
 * history entry, which fields changed. The UI lives in components/SkillHistory.tsx (skill page) and
 * components/SkillToolCard.tsx (chat).
 *
 * A leaf module without imports (the status type is mirrored here, structurally equal to `SkillStatusImage` in
 * lib/api/skill-history.ts) — web/test/skill-change.test.mjs compiles it with tsc alone.
 */

/** The canonical tool name (providers/contract.js: `mcp__<server>__<tool>`). */
export const SKILL_WRITE_TOOL = "mcp__cbase__cbase_skill_write";

/** Is this tool block a call of `cbase_skill_write`? Also without the prefix (a provider that does not carry the server
 *  part in front) — the tool name itself is unambiguous. */
export function isSkillWrite(name: string): boolean {
  return name === SKILL_WRITE_TOOL || /(^|__)cbase_skill_write$/.test(name);
}

export type SkillWriteAction = "create" | "change" | "erase";

export type SkillWriteResult =
  | {
      kind: "written";
      /** Taken from the CALL (`input.action`); the result does not carry it; `null` = unreadable. */
      action: "create" | "change" | null;
      skill: { id: string; name: string; level: string | null; projectName: string | null };
      historyId: string | null;
      unchanged: boolean;
    }
  | { kind: "requested"; requestId: string; merged: boolean };

/** The JSON in the result text. The MCP server writes the route's answer as JSON (cbase-mcp.js); a fence sentence may
 *  follow it — then the part from the first opening to the last closing brace counts. */
function jsonFrom(text: string): Record<string, unknown> | null {
  const attempt = (s: string) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch { return null; }
  };
  const t = text.trim();
  if (!t) return null;
  const whole = attempt(t);
  if (whole) return whole;
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? attempt(t.slice(a, b + 1)) : null;
}

/** Read the result of a call — `null` if it is neither of the two forms (error, old server, truncated). */
export function readSkillWriteResult(text: string, input?: Record<string, unknown> | null): SkillWriteResult | null {
  const r = jsonFrom(text);
  if (!r || r.ok !== true) return null;
  if (r.requested === true) {
    return typeof r.requestId === "string" && r.requestId
      ? { kind: "requested", requestId: r.requestId, merged: r.merged === true }
      : null;
  }
  const s = r.skill && typeof r.skill === "object" ? (r.skill as Record<string, unknown>) : null;
  if (!s || typeof s.id !== "string" || !s.id || typeof s.name !== "string") return null;
  const action = input?.action === "create" || input?.action === "change" ? input.action : null;
  return {
    kind: "written",
    action,
    skill: {
      id: s.id,
      name: s.name,
      level: typeof s.level === "string" ? s.level : null,
      projectName: typeof s.projectName === "string" && s.projectName ? s.projectName : null,
    },
    historyId: typeof r.historyId === "string" && r.historyId ? r.historyId : null,
    unchanged: r.unchanged === true,
  };
}

export type SkillField = "name" | "description" | "body";
export const SKILL_FIELDS: readonly SkillField[] = ["name", "description", "body"];

/** A state as it appears in the history (subset of `SkillStatusImage`). */
export interface StatusFields { name: string | null; description: string | null; body: string | null }

/**
 * Which fields an entry changed, each with both states. Creating (`prior` missing) and deleting (`after` missing) name
 * every field that is non-empty on the present side; a field one side does not name (`null`) is NOT a change —
 * "not said" never becomes a statement.
 */
export function fieldChanges(prior: StatusFields | null, after: StatusFields | null): { field: SkillField; prior: string | null; after: string | null }[] {
  const out: { field: SkillField; prior: string | null; after: string | null }[] = [];
  for (const field of SKILL_FIELDS) {
    const v = prior ? prior[field] : null;
    const n = after ? after[field] : null;
    if (prior && after) {
      if (v !== null && n !== null && v !== n) out.push({ field, prior: v, after: n });
    } else if ((prior ? v : n)) {
      out.push({ field, prior: v, after: n });
    }
  }
  return out;
}

/** One-line preview of a long text (instructions): the first non-empty line, truncated. */
export function shortText(s: string | null, max = 120): string {
  if (!s) return "";
  const row = s.split("\n").map((z) => z.trim()).find((z) => z) ?? "";
  return row.length > max ? `${row.slice(0, max - 1)}…` : row;
}
