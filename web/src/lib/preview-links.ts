// Preview links: the UI's computations, without React.
//
// A leaf: it imports only TYPES from lib/api/preview.ts. web/test/preview-links.test.mjs compiles it with tsc and runs it under Node.
// The time is ALWAYS passed in (`now`), never read here (no timers in tests).
//
// Who uses what: `components/preview/usePreviewLinks.ts` (state: first fetch + SSE `preview/link`, no polling loop),
// `components/preview/PreviewShare.tsx` (menu and link row in the services pill), the "Instances" tab
// (`components/projects/InstancesPage.tsx`: `linkInTree`, where the tree is the source) and
// `components/settings/NgrokSettings.tsx` (the "ngrok" section under Settings → Integrations).
import type { PreviewLink, PreviewStatus } from "./api/preview.js";

/** The sentences the server stores as the error of a link (server/backend/electron/server/preview/links.js), English key → translated by the view. */
const LINK_ERRORS = [
  "The address is already taken by another ngrok tunnel (e.g. the one of the writing assistant).",
  "Project deleted — the link has ended.",
  "Service deleted — the link has ended.",
  "Instance removed — the link has ended.",
  "The project now runs in a project container — the link (on B) has ended.",
  "No ngrok authtoken stored.",
  "Creation aborted (server restart).",
  "Link without an address — its name is unknown.",
] as const;
/** The error of a link for display: a fixed sentence of the server is translated (the address sentence may carry ` (ERR_NGROK_334)` behind it), anything else stays as it is. */
export function linkErrorShown(error: string, t: (key: string) => string): string {
  const hit = LINK_ERRORS.find((s) => error === s || (s === LINK_ERRORS[0] && error.startsWith(`${s} (`)));
  if (!hit) return error;
  return t(hit) + error.slice(hit.length);
}

/** The type of the SSE event (`broadcast({ type: "preview/link", link })`). */
export const PREVIEW_EVENT = "preview/link";
/** A window event after settings changed the access; mode and limit do not come over SSE. */
export const NGROK_ACCESS_CHANGED = "cbase-ngrok-access";
/** The number of ended links the server delivers in the history; the same clamp when merging. */
export const HISTORY_CAP = 20;

/** "Active" as on the server: not ended. */
export function isActive(l: PreviewLink): boolean {
  return l.state !== "ended" && l.endedAt == null;
}

/**
 * Merge a link from the SSE stream into the state: an active one replaces its row in `active` (or is added), an ended one moves from
 * `active` to the top of the history. Before the first fetch (`status === null`) it stays `null`: "not loaded yet" is not "no links",
 * and a single event is not a complete list.
 */
export function withLink(status: PreviewStatus | null, link: PreviewLink): PreviewStatus | null {
  if (!status) return null;
  const active = status.active.filter((l) => l.id !== link.id);
  const history = status.history.filter((l) => l.id !== link.id);
  if (isActive(link)) {
    const i = status.active.findIndex((l) => l.id === link.id);
    if (i >= 0) active.splice(i, 0, link);
    else active.push(link);
    return { ...status, active, history };
  }
  return { ...status, active, history: [link, ...history].slice(0, HISTORY_CAP) };
}

/** What "Share link" can currently do on a service row. */
export type ShareSituation = "loading" | "without-sdk" | "without-access" | "limit" | "ready";
export function shareSituation(status: PreviewStatus | null): ShareSituation {
  if (!status) return "loading";
  if (!status.sdk) return "without-sdk";
  if (status.mode === "off" || status.limit <= 0) return "without-access";
  if (status.active.length >= status.limit) return "limit";
  return "ready";
}

/**
 * The instance a service row sends in the body. `identifier` is the row's chosen instance ("<projectId>/<instance>", from the exclusive
 * selection); without it the project's main instance from `instances` applies (project id → main identifier, only relocated
 * projects; `instancePerProject` in lib/services-status.ts).
 *   · `undefined` = not known yet (`/api/projects` has not answered): then nothing goes out; a guessed `null` would be a 400 for a
 *     relocated project and the wrong target for another.
 *   · `null` = not relocated (the target is B).
 *   · otherwise the name behind the LAST slash of the identifier ("main", "copy-k1"); the server reassembles the identifier from
 *     `projectId` and `instance`.
 */
export function serviceTargetInstance(instances: ReadonlyMap<string, string> | null, projectId: string, identifier?: string | null): string | null | undefined {
  const k = identifier ?? (instances ? instances.get(String(projectId)) ?? null : undefined);
  if (k === undefined) return undefined;
  if (k === null) return null;
  const front = `${projectId}/`;
  if (!k.startsWith(front) || k.length === front.length) return undefined;
  return k.slice(front.length);
}

/** The active link of ONE service row (project, instance, service); at most one is shown, the newest. */
export function linkOfTheRow(active: readonly PreviewLink[] | null | undefined, projectId: string, instance: string | null | undefined, serviceId: number): PreviewLink | null {
  if (!active || instance === undefined) return null;
  let hits: PreviewLink | null = null;
  for (const l of active) {
    if (l.projectId !== String(projectId) || l.serviceId !== serviceId || (l.instance ?? null) !== instance) continue;
    if (!hits || (l.createdAt ?? 0) > (hits.createdAt ?? 0)) hits = l;
  }
  return hits;
}

/** The link of a service row as the instances tree carries it (`d.link`, projectbox/instances-tree.js; lib/instances-tree.ts). */
export type TreeLinkField = { id: string; url: string; procedure: number | null; state: string };

/**
 * The link of a service row in the "Instances" tab. The SOURCE is the tree: it refreshes on a beat and carries `link` per (instance,
 * service); the state of `usePreviewLinks` is ONE fetch without retry, and a failed first fetch there meant "no link" forever (and
 * `withLink` writes nothing into a missing state). The state only adds:
 *   · if it knows the tree's link as active, its version applies (error text, state fresh via SSE); if it knows it as ended (history),
 *     it is ended: an ended link never becomes active again, the tree is then merely older;
 *   · without a link in the tree it shows its own only if that was created AFTER the tree (`createdAt` > `treeStatus`, both the server's
 *     clock); one just created appears at once, an older one is one the tree already no longer saw.
 * Without a state the tree's link is completed to the full form (project/service from the row); copying and revoking need only id and
 * address.
 */
export function linkInTree(
  tree: TreeLinkField | null,
  treeStatus: number,
  status: PreviewStatus | null,
  row: { projectId: string; instance: string; serviceId: number; serviceName: string; port: number | null },
): PreviewLink | null {
  if (tree) {
    const active = status?.active.find((l) => l.id === tree.id);
    if (active) return active;
    if (status?.history.some((l) => l.id === tree.id)) return null;
    return {
      id: tree.id, projectId: String(row.projectId), projectName: "", instance: row.instance, serviceId: row.serviceId,
      serviceName: row.serviceName, port: row.port, mode: status?.mode === "names" ? "names" : "dev", url: tree.url,
      state: tree.state === "online" || tree.state === "error" ? tree.state : "start", error: "",
      createdAt: null, runningSinceAt: tree.procedure, endedAt: null, endedReason: null,
    };
  }
  const fresh = linkOfTheRow(status?.active, row.projectId, row.instance, row.serviceId);
  return fresh && (fresh.createdAt ?? 0) > treeStatus ? fresh : null;
}

/** Remaining time of a link. `expired` shows until the server's expiry beat (every minute) ends it. */
export type RemainingTime =
  | { kind: "unlimited" }
  | { kind: "expired" }
  | { kind: "minutes"; n: number }
  | { kind: "hours"; n: number }
  | { kind: "days"; n: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Rounded down, as a clock counts: "6 d left" one minute after creating a 7-day link. From two days on in days, below that in hours, under
 * an hour in minutes (at least 1: "0 min left" would be a claim the server does not yet share).
 */
export function remainingTime(runningSinceAt: number | null, now: number): RemainingTime {
  if (runningSinceAt == null) return { kind: "unlimited" };
  const rest = runningSinceAt - now;
  if (rest <= 0) return { kind: "expired" };
  if (rest >= 2 * DAY) return { kind: "days", n: Math.floor(rest / DAY) };
  if (rest >= HOUR) return { kind: "hours", n: Math.floor(rest / HOUR) };
  return { kind: "minutes", n: Math.max(1, Math.floor(rest / MINUTE)) };
}

type Translator = (key: string, params?: Record<string, string | number>) => string;

export function remainingTimeText(r: RemainingTime, t: Translator): string {
  switch (r.kind) {
    case "unlimited": return t("unlimited");
    case "expired": return t("expired");
    case "minutes": return t("{n} min left", { n: r.n });
    case "hours": return t("{n} h left", { n: r.n });
    case "days": return t("{n} d left", { n: r.n });
  }
}

/** The label of a duration in the menu. */
export function validityText(days: 1 | 7 | 30 | null, t: Translator): string {
  if (days == null) return t("unlimited");
  return days === 1 ? t("1 day") : t("{n} days", { n: days });
}

/** The address without `https://`, as it appears in the narrow row; the full one is always what gets copied. */
export function shortAddress(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
