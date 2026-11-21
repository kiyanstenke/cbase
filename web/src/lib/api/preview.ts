// Preview links for project containers. A link makes ONE service of an instance publicly reachable through the user's ngrok account;
// only the human creates it (no MCP tool).
//
// Leaf module (README there): imports only from lib/api/, with a `.js` ending. Every answer goes through a `norm*` function with a
// default per field: a missing field should leave the view readable, not tear it down. The bodies are typed objects without
// conditional spreads (seams-fields.test.mjs reads their fields through the type checker), and EVERY key is in them, even with
// `null`: the server reads a missing field as 400 ("a missing field is no statement"), `JSON.stringify` keeps `null` but drops
// `undefined`; hence no optional field here.
//
// Access values (auth token, API key) only go OUT (`setNgrokAccess`); only booleans come back.
import { api } from "./core.js";

// The lists of the seam are constants here and bound to the server's leaf (`server/backend/electron/server/preview/contract.js`, guard
// web/test/preview-binding.test.mjs): validities, modes, states, reasons and the keys of the bodies and answers. The types below are
// derived from them or bound to them via `SameKeys`: a field in the type but not in the list (or vice versa) is a type error.

/** `off` = no auth token, `dev` = auth token only (free plan: one fixed dev address), `names` = auth token + API key (hobbyist). */
export const PREVIEW_MODES = ["off", "dev", "names"] as const;
export type PreviewMode = (typeof PREVIEW_MODES)[number];
export const PREVIEW_STATES = ["start", "online", "error", "ended"] as const;
export type PreviewLinkState = (typeof PREVIEW_STATES)[number];
export const PREVIEW_ENDED_REASONS = ["revoke", "expired", "error"] as const;
export type PreviewEndedReason = (typeof PREVIEW_ENDED_REASONS)[number];
/** The selectable validities in days; `null` = unlimited. */
export type PreviewValidity = 1 | 7 | 30 | null;
export const PREVIEW_VALIDITIES: readonly PreviewValidity[] = [1, 7, 30, null];
/** Preselected in the menu. */
export const PREVIEW_VALIDITY_DEFAULT: PreviewValidity = 7;
/** The mandatory keys of POST /api/preview-links and PUT /api/integrations/ngrok. */
export const PREVIEW_POST_FIELDS = ["projectId", "instance", "serviceId", "validDays"] as const;
export const NGROK_PUT_FIELDS = ["authtoken", "apiKey"] as const;
/** The fields of the answers; `norm*` returns exactly these, in this order. */
export const PREVIEW_LINK_FIELDS = [
  "id", "projectId", "projectName", "instance", "serviceId", "serviceName", "port", "mode", "url",
  "state", "error", "createdAt", "runningSinceAt", "endedAt", "endedReason",
] as const;
export const PREVIEW_STATUS_FIELDS = ["active", "history", "mode", "limit", "sdk"] as const;
export const NGROK_ACCESS_FIELDS = ["authtoken", "apiKey", "mode", "limit", "active", "checkedAt", "error", "sdk"] as const;

export type PreviewLink = {
  id: string;
  projectId: string;
  projectName: string;
  /** Name of the instance ("main", "copy-k1"); `null` = not converted (the target is the backend itself). */
  instance: string | null;
  serviceId: number;
  serviceName: string;
  port: number | null;
  mode: Exclude<PreviewMode, "off">;
  /** `https://…`, empty until `online`. */
  url: string;
  state: PreviewLinkState;
  error: string;
  createdAt: number | null;
  /** `null` = unlimited. */
  runningSinceAt: number | null;
  endedAt: number | null;
  endedReason: PreviewEndedReason | null;
};

export type PreviewStatus = {
  active: PreviewLink[];
  /** The last 20 ended ones, newest first. */
  history: PreviewLink[];
  mode: PreviewMode;
  /** How many links can run at once (0 without access, 1 on the free plan, 3 with names). */
  limit: number;
  /** Is the ngrok SDK loaded in the backend? Without it, creating answers 501. */
  sdk: boolean;
};

export type NgrokAccess = {
  authtoken: boolean;
  apiKey: boolean;
  mode: PreviewMode;
  limit: number;
  active: number;
  checkedAt: number | null;
  error: string;
  sdk: boolean;
};

/** POST /api/preview-links: all four keys mandatory. */
export type PreviewBody = { projectId: string; instance: string | null; serviceId: number; validDays: PreviewValidity };
/** PUT /api/integrations/ngrok: both keys mandatory: a string sets, `null` leaves unchanged, `""` deletes. */
export type NgrokBody = { authtoken: string | null; apiKey: string | null };

/** `true` if type `A` carries exactly the keys of list `L`; otherwise `false`, and the assignment below is a type error. */
type SameKeys<A, L extends readonly string[]> = [Exclude<keyof A, L[number]>, Exclude<L[number], keyof A>] extends [never, never] ? true : false;
/** Binds the types to the lists (exported so no "unused" check removes it). */
export const PREVIEW_TYPES_BOUND: [
  SameKeys<PreviewLink, typeof PREVIEW_LINK_FIELDS>,
  SameKeys<PreviewStatus, typeof PREVIEW_STATUS_FIELDS>,
  SameKeys<NgrokAccess, typeof NGROK_ACCESS_FIELDS>,
  SameKeys<PreviewBody, typeof PREVIEW_POST_FIELDS>,
  SameKeys<NgrokBody, typeof NGROK_PUT_FIELDS>,
] = [true, true, true, true, true];

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const countOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const one = <T extends string>(list: readonly T[], x: unknown): T | null => (list.includes(x as T) ? (x as T) : null);
const modeOf = (x: unknown): PreviewMode => one(PREVIEW_MODES, x) ?? "off";

/** A link from the answer or the SSE event `preview/link`; `null` if it carries no id. */
export function normPreviewLink(raw: unknown): PreviewLink | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return null;
  const state = one(PREVIEW_STATES, r.state) ?? "error";
  return {
    id,
    projectId: str(r.projectId),
    projectName: str(r.projectName),
    instance: typeof r.instance === "string" && r.instance ? r.instance : null,
    serviceId: typeof r.serviceId === "number" ? r.serviceId : Number(r.serviceId) || 0,
    serviceName: str(r.serviceName),
    port: countOrNull(r.port),
    mode: r.mode === "names" ? "names" : "dev",
    url: str(r.url),
    state,
    error: str(r.error),
    createdAt: countOrNull(r.createdAt),
    runningSinceAt: countOrNull(r.runningSinceAt),
    endedAt: countOrNull(r.endedAt),
    endedReason: one(PREVIEW_ENDED_REASONS, r.endedReason),
  };
}

const links = (x: unknown): PreviewLink[] =>
  (Array.isArray(x) ? x : []).map(normPreviewLink).filter((l): l is PreviewLink => l !== null);

export function normPreviewStatus(raw: unknown): PreviewStatus {
  const r = obj(raw);
  return {
    active: links(r.active),
    history: links(r.history),
    mode: modeOf(r.mode),
    limit: countOrNull(r.limit) ?? 0,
    sdk: r.sdk === true,
  };
}

export function normNgrokAccess(raw: unknown): NgrokAccess {
  const r = obj(raw);
  return {
    authtoken: r.authtoken === true,
    apiKey: r.apiKey === true,
    mode: modeOf(r.mode),
    limit: countOrNull(r.limit) ?? 0,
    active: countOrNull(r.active) ?? 0,
    checkedAt: countOrNull(r.checkedAt),
    error: str(r.error),
    sdk: r.sdk === true,
  };
}

/** GET /api/preview-links: active links, history, mode, limit, SDK. */
export async function loadPreviewLinks(): Promise<PreviewStatus> {
  return normPreviewStatus(await api<unknown>("/api/preview-links", { cache: "no-store" }));
}

/**
 * POST /api/preview-links → 201 link. Errors come as `Error` with `code` (`LIMIT`, `WITHOUT_ACCESS`, `WITHOUT_SDK`, `NGROK`) and the
 * server's sentence as `message`; with `NGROK` the error additionally carries the ended `link`.
 */
export async function setUpPreviewLink(bodyText: PreviewBody): Promise<PreviewLink> {
  const body: PreviewBody = { projectId: bodyText.projectId, instance: bodyText.instance, serviceId: bodyText.serviceId, validDays: bodyText.validDays };
  const r = normPreviewLink(await api<unknown>("/api/preview-links", { method: "POST", body: JSON.stringify(body) }));
  if (!r) throw new Error("Response without a link");
  return r;
}

/** DELETE /api/preview-links/:id → 200 link (`ended`); a second revocation is 200 as well. */
export async function revokePreviewLink(id: string): Promise<PreviewLink | null> {
  return normPreviewLink(await api<unknown>(`/api/preview-links/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/** GET /api/integrations/ngrok: only WHETHER something is stored, never the value. */
export async function loadNgrokAccess(): Promise<NgrokAccess> {
  return normNgrokAccess(await api<unknown>("/api/integrations/ngrok", { cache: "no-store" }));
}

/** PUT /api/integrations/ngrok: both keys; `code: "CHECK"` means: nothing stored. */
export async function setNgrokAccess(bodyText: NgrokBody): Promise<NgrokAccess> {
  const body: NgrokBody = { authtoken: bodyText.authtoken, apiKey: bodyText.apiKey };
  return normNgrokAccess(await api<unknown>("/api/integrations/ngrok", { method: "PUT", body: JSON.stringify(body) }));
}

/** DELETE /api/integrations/ngrok: both gone; 409 while links are active. */
export async function deleteNgrokAccess(): Promise<void> {
  await api<unknown>("/api/integrations/ngrok", { method: "DELETE" });
}
