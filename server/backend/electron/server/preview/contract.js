// The contract of the preview links between backend, web and iOS, as ONE leaf without imports. The backend
// (preview/links.js, preview/routes.js, store/preview-links.js) computes with these lists, and the binding test
// web/test/preview-binding.test.mjs holds web (lib/api/preview.ts) and iOS (Models/ServiceModels.swift) to them —
// changing a line here turns the suite red until both clients have followed.

/** Required keys of POST /api/preview-links — each must be PRESENT in the body; `null` is a statement, a missing key is a 400. */
export const POST_FIELDS = Object.freeze(["projectId", "instance", "serviceId", "validDays"]);
/** Required keys of PUT /api/integrations/ngrok — a string sets, `null` leaves unchanged, `""` deletes. */
export const PUT_FIELDS = Object.freeze(["authtoken", "apiKey"]);
/** Allowed lifetimes in days; `null` (unlimited) is valid as well. */
export const VALID_DAYS = Object.freeze([1, 7, 30]);
export const VALID_DEFAULT = 7;
export const MODES = Object.freeze(["off", "dev", "names"]);
/** Concurrently active links per mode (ngrok plan: Free = one dev address, Hobbyist = 3 endpoints online). */
export const LIMIT = Object.freeze({ off: 0, dev: 1, names: 3 });
export const STATES = Object.freeze(["start", "online", "error", "ended"]);
export const ENDED_REASONS = Object.freeze(["revoke", "expired", "error"]);
/** The fields of a link in responses and in the SSE — exactly these, in this order. */
export const LINK_FIELDS = Object.freeze([
  "id", "projectId", "projectName", "instance", "serviceId", "serviceName", "port", "mode", "url",
  "state", "error", "createdAt", "runningSinceAt", "endedAt", "endedReason",
]);
/** GET /api/preview-links */
export const STATUS_FIELDS = Object.freeze(["active", "history", "mode", "limit", "sdk"]);
/** GET/PUT /api/integrations/ngrok — the access values themselves are NEVER in it, only whether they are stored. */
export const ACCESS_FIELDS = Object.freeze(["authtoken", "apiKey", "mode", "limit", "active", "checkedAt", "error", "sdk"]);
/** The SSE event per state change: `{ type, link }`. */
export const SSE_TYPE = "preview/link";
/** History: GET /api/preview-links returns this many ended links. */
export const HISTORY = 20;
