// The timeline per project: what REALLY happened in a project, entered solely by the timeline agent (outer loop), append-only on the
// server (`server/backend/electron/server/timeline/`). The UI reads, switches on/off per project and dismisses; the human cannot enter.
//
//   GET  /api/projects/:id/timeline?until=&untilId=&limit=&kind=&chat=&word=  → { active, events, further, continueId }   (`loadTimeline`)
//   PUT  /api/projects/:id/timeline { active }                                                    (`setTimelineActive`)
//   POST /api/projects/:id/timeline/:eid/dismiss { justification }                                (`dismissTimelineEvent`)
//   POST /api/projects/:id/timeline/:eid/revision { title?, text?, justification? }               (`reviseTimelineEvent`)
//   GET  /api/projects/:id/timeline/proofs?chat=  → { proofs, clipped }                           (`loadTimelineProofs`)
//   SSE  `timeline` { projectId } after every write; the view reloads (components/timeline/Timeline.tsx).
//
// Leaf module (README there): imports only from lib/api/, with a `.js` ending. Every answer goes through `normEvent` with a default per
// field; a missing field leaves the list readable. The kinds are bound to the server (store/timeline.js `TIMELINE_KINDS`).
import { api } from "./core.js";

export const TIMELINE_KINDS = ["code", "git", "test", "communication", "ops", "other"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** The citation: a tool call ("executed") or a message ("reported"). */
export interface TimelineCitation {
  kind: "tool" | "message";
  /** Message id (the row in the chat) as text. */
  ref: string;
  /** `""` = main chat, `subagent:<id>` = a subagent of the chat. */
  from: string;
  chatId: string | null;
  /** At read time; a deleted chat ⇒ null. */
  chatTitle: string | null;
  /** Name of the tool when `kind = tool`, otherwise null. */
  tool: string | null;
}

export interface TimelineAnchor {
  branch: string | null;
  sha: string | null;
  mrIid: number | null;
}

/** A chunk of a title/text: text, optionally with a link. The server recognizes the identifiers and builds the addresses
 *  (timeline/references.js); the client only draws. */
export interface TimelineChunk {
  t: string;
  url: string | null;
  kind: "mr" | "issue" | "pipeline" | "commit" | null;
}

/** The links of the git anchor; each null if not unambiguously resolvable. `gitView` = jump into cbase's git overview. */
export interface TimelineLinks {
  repo: { rel: string; name: string; provider: "gitlab" | "github" | null; web: string | null } | null;
  mr: string | null;
  commit: string | null;
  branch: string | null;
  gitView: { repo: string; branch: string } | null;
}

/** The agenda item the event refers to; `text` null = no longer in the chat's agenda. */
export interface TimelineAgendaPoint {
  id: string;
  chatId: string | null;
  text: string | null;
  status: string | null;
}

/** A revision of title and text; the first is the entry's own (always `agent`). */
export interface TimelineRevision {
  title: string;
  text: string;
  from: "agent" | "human";
  justification: string;
  at: number;
}

export interface TimelineDismissed {
  from: "agent" | "user";
  justification: string;
  at: number;
}

/** An event. Parts of a collective event carry `parts: []` themselves. */
export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  title: string;
  text: string;
  at: number;
  citation: TimelineCitation;
  anchor: TimelineAnchor | null;
  agendaItemId: string | null;
  tags: string[];
  dismissed: TimelineDismissed | null;
  parts: TimelineEvent[];
  /** All revisions, oldest first; `[]` = never revised. `title`/`text` above are the current one. */
  revisions: TimelineRevision[];
  links: TimelineLinks | null;
  /** Title or text in chunks if an identifier in it is linked, otherwise null (then `title`/`text` as plain text). */
  references: { title: TimelineChunk[] | null; text: TimelineChunk[] | null };
  agendaItem: TimelineAgendaPoint | null;
}

export interface TimelinePage {
  /** The project switch (opt-out). */
  active: boolean;
  /** The top-level events, newest first. */
  events: TimelineEvent[];
  /** The `until` of the next page; null if nothing more comes. */
  further: number | null;
  /** The `untilId` of the next page (id of the last event): with `further` the cursor that does not lose an equal `at` at the page
   *  boundary. null on an older server; then `further` alone pages as before. */
  continueId: string | null;
}

export interface TimelineFilter {
  kind?: TimelineKind | null;
  chat?: string | null;
  word?: string | null;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const count = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const countOrNull = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** An unknown kind reads as "other"; the row stays visible instead of vanishing. */
export const asTimelineKind = (v: unknown): TimelineKind =>
  (TIMELINE_KINDS as readonly string[]).includes(String(v)) ? (v as TimelineKind) : "other";

const KIND_CHUNK = ["mr", "issue", "pipeline", "commit"] as const;
/** Only http(s) addresses; any other kind (javascript:, data:) never becomes a link. */
const address = (v: unknown): string | null => (typeof v === "string" && /^https?:\/\//i.test(v) ? v : null);
function normChunks(v: unknown): TimelineChunk[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  return v.map((x) => {
    const r = obj(x);
    const kind = KIND_CHUNK.find((a) => a === r.kind) ?? null;
    const url = address(r.url);
    return { t: str(r.t), url, kind: url ? kind : null };
  });
}
function normLinks(v: unknown): TimelineLinks | null {
  if (!v || typeof v !== "object") return null;
  const r = obj(v);
  const repo = r.repo && typeof r.repo === "object" ? obj(r.repo) : null;
  const ga = r.gitView && typeof r.gitView === "object" ? obj(r.gitView) : null;
  return {
    repo: repo ? { rel: str(repo.rel), name: str(repo.name), provider: repo.provider === "github" ? "github" : repo.provider === "gitlab" ? "gitlab" : null, web: address(repo.web) } : null,
    mr: address(r.mr),
    commit: address(r.commit),
    branch: address(r.branch),
    gitView: ga && str(ga.branch) ? { repo: str(ga.repo), branch: str(ga.branch) } : null,
  };
}

export function normEvent(raw: unknown, withParts = true): TimelineEvent | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return null;
  const f = obj(r.citation);
  const fa = str(f.kind);
  const a = r.anchor && typeof r.anchor === "object" ? obj(r.anchor) : null;
  const v = r.dismissed && typeof r.dismissed === "object" ? obj(r.dismissed) : null;
  return {
    id,
    kind: asTimelineKind(r.kind),
    title: str(r.title),
    text: str(r.text),
    at: count(r.at),
    citation: {
      kind: fa === "tool" ? "tool" : "message",
      ref: str(f.ref),
      from: str(f.from),
      chatId: strOrNull(f.chatId),
      chatTitle: strOrNull(f.chatTitle),
      tool: strOrNull(f.tool),
    },
    anchor: a ? { branch: strOrNull(a.branch), sha: strOrNull(a.sha), mrIid: countOrNull(a.mrIid) } : null,
    agendaItemId: strOrNull(r.agendaItemId),
    tags: Array.isArray(r.tags) ? r.tags.map(str).filter(Boolean) : [],
    dismissed: v ? { from: v.from === "agent" ? "agent" : "user", justification: str(v.justification), at: count(v.at) } : null,
    parts: withParts && Array.isArray(r.parts) ? r.parts.map((t) => normEvent(t, false)).filter((t): t is TimelineEvent => t !== null) : [],
    revisions: Array.isArray(r.revisions)
      ? r.revisions.map((x) => { const f = obj(x); return { title: str(f.title), text: str(f.text), from: f.from === "human" ? "human" as const : "agent" as const, justification: str(f.justification), at: count(f.at) }; })
      : [],
    links: normLinks(r.links),
    references: { title: normChunks(obj(r.references).title), text: normChunks(obj(r.references).text) },
    agendaItem: r.agendaItem && typeof r.agendaItem === "object" && str(obj(r.agendaItem).id)
      ? { id: str(obj(r.agendaItem).id), chatId: strOrNull(obj(r.agendaItem).chatId), text: typeof obj(r.agendaItem).text === "string" ? (obj(r.agendaItem).text as string) : null, status: strOrNull(obj(r.agendaItem).status) }
      : null,
  };
}

/**
 * A page of the timeline. `until`/`untilId` = `further`/`continueId` of the previous page (pages into the past), `limit` ≤ 200 (server cap).
 */
export async function loadTimeline(projectId: string, { until, untilId, limit, ...filter }: TimelineFilter & { until?: number | null; untilId?: string | null; limit?: number } = {}): Promise<TimelinePage> {
  const q = new URLSearchParams();
  if (until != null) q.set("until", String(until));
  if (until != null && untilId) q.set("untilId", untilId);
  if (limit != null) q.set("limit", String(Math.max(1, Math.min(200, Math.trunc(limit)))));
  if (filter.kind) q.set("kind", filter.kind);
  if (filter.chat) q.set("chat", filter.chat);
  if (filter.word) q.set("word", filter.word.trim().toLowerCase());
  const qs = q.toString();
  const r = obj(await api(`/api/projects/${encodeURIComponent(projectId)}/timeline${qs ? `?${qs}` : ""}`));
  return {
    active: r.active === true,
    events: Array.isArray(r.events) ? r.events.map((e) => normEvent(e)).filter((e): e is TimelineEvent => e !== null) : [],
    further: countOrNull(r.further),
    continueId: strOrNull(r.continueId),
  };
}

/** The project switch. The server demands the field as a boolean (400 otherwise) and answers with the state that was set. */
export async function setTimelineActive(projectId: string, active: boolean): Promise<boolean> {
  const r = obj(await api(`/api/projects/${encodeURIComponent(projectId)}/timeline`, { method: "PUT", body: JSON.stringify({ active }) }));
  return r.active === true;
}

/**
 * The human dismisses an event, with a mandatory justification. Server errors (code in the thrown error's `code` field, read by
 * `timelineError`): 400 JUSTIFICATION (empty), 404 UNKNOWN (not in this project), 409 ALREADY_DISMISSED, 400 BODY.
 */
export async function dismissTimelineEvent(projectId: string, eventId: string, justification: string): Promise<TimelineEvent | null> {
  const r = obj(await api(`/api/projects/${encodeURIComponent(projectId)}/timeline/${encodeURIComponent(eventId)}/dismiss`, {
    method: "POST",
    body: JSON.stringify({ justification }),
  }));
  return normEvent(r.event);
}

/**
 * The human rewords: a new revision of title and/or text; no new event, the old one stays. A field not sent stays. Errors: 400 BODY
 * (both missing, too long), 404 UNKNOWN, 409 DISMISSED, 409 UNCHANGED, 409 TOO_MANY.
 */
export async function reviseTimelineEvent(projectId: string, eventId: string, revision: { title?: string; text?: string; justification?: string }): Promise<TimelineEvent | null> {
  const r = obj(await api(`/api/projects/${encodeURIComponent(projectId)}/timeline/${encodeURIComponent(eventId)}/revision`, {
    method: "POST",
    body: JSON.stringify(revision),
  }));
  return normEvent(r.event);
}

/** The proofs of a chat's agenda: the events with an agenda item whose citation lies in this chat (parts too). */
export async function loadTimelineProofs(projectId: string, chatId: string): Promise<{ proofs: TimelineEvent[]; clipped: boolean }> {
  const r = obj(await api(`/api/projects/${encodeURIComponent(projectId)}/timeline/proofs?chat=${encodeURIComponent(chatId)}`));
  return {
    proofs: Array.isArray(r.proofs) ? r.proofs.map((e) => normEvent(e, false)).filter((e): e is TimelineEvent => e !== null) : [],
    clipped: r.clipped === true,
  };
}

/** The proofs per agenda item (id → events, newest first). */
export function proofsPerItem(proofs: readonly TimelineEvent[]): Map<string, TimelineEvent[]> {
  const out = new Map<string, TimelineEvent[]>();
  for (const e of proofs) {
    if (!e.agendaItemId) continue;
    const l = out.get(e.agendaItemId) ?? [];
    l.push(e);
    out.set(e.agendaItemId, l);
  }
  return out;
}

/** The error of a call as `{ code, text, status }`; `api()` attaches the answer's fields (`code`, `error`) and `httpStatus`. */
export function timelineError(e: unknown): { code: string | null; text: string; status: number | null } {
  const r = obj(e);
  return {
    code: strOrNull(r.code),
    text: e instanceof Error ? e.message : str(r.error) || String(e),
    status: countOrNull(r.httpStatus),
  };
}
