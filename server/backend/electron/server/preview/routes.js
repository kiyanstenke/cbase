// Routes: preview links and the ngrok access — the contract for web and iOS. One route function `previewRoutes(ctx)`
// following the route contract (tools/check/lib/tree-rules.mjs), registered in ROUTES in server.js before
// projectListRoutes.
//
//   GET    /api/preview-links             → { active, history, mode, limit, sdk }
//   POST   /api/preview-links             { projectId, instance, serviceId, validDays } — all four required → 201 link
//   DELETE /api/preview-links/:id         → 200 link (ended; also the second time), 404 unknown
//   GET    /api/integrations/ngrok        → { authtoken: bool, apiKey: bool, mode, limit, active, checkedAt, error, sdk }
//   PUT    /api/integrations/ngrok        { authtoken: string|null, apiKey: string|null } — both required → 200 like GET
//   DELETE /api/integrations/ngrok        → 200 { ok: true } or 409
//
// Every response carries `Cache-Control: no-store`; error shape `{ error, code? }`. A MISSING field is no statement
// (400) — `instance: null` and `validDays: null` must be stated explicitly too. Links are created only by the user in the
// UI: no MCP tool calls these routes (guard in server/backend/test/preview-links.test.js), and the API fence has no row
// for them — from a project network they are 403.
import { T } from "../i18n.js";
import { NEXT, readBody } from "../runtime/http.js";
import { PreviewError, createOne, list, redact, revoke, readAccess, deleteAccess, setAccess } from "./links.js";
// Required keys and lifetimes are stated ONCE in the contract (contract.js) — no second list here.
import { VALID_DAYS, POST_FIELDS, PUT_FIELDS } from "./contract.js";

function respond(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const isObject = (b) => b != null && typeof b === "object" && !Array.isArray(b);

function missingField(b, fields) {
  const missing = fields.find((k) => !Object.hasOwn(b, k));
  return missing ? T`Field “${missing}” is missing — ${fields.map((k) => `“${k}”`).join(", ")} are required (state null explicitly).` : "";
}

/** The shape of a create body — `""` or the sentence why not. */
function linkBodyError(b) {
  if (!isObject(b)) return T("The body must be a JSON object.");
  const missing = missingField(b, POST_FIELDS);
  if (missing) return missing;
  if (typeof b.projectId !== "string" || !b.projectId) return T("“projectId” must be a non-empty string.");
  if (b.instance !== null && (typeof b.instance !== "string" || !b.instance)) return T("“instance” must be a non-empty string or null.");
  if (!Number.isInteger(b.serviceId) || b.serviceId <= 0) return T("“serviceId” must be a positive integer.");
  if (b.validDays !== null && !VALID_DAYS.includes(b.validDays)) return T`“validDays” must be ${VALID_DAYS.join(", ")} or null (unlimited).`;
  return "";
}

function accessBodyError(b) {
  if (!isObject(b)) return T("The body must be a JSON object.");
  const missing = missingField(b, PUT_FIELDS);
  if (missing) return missing;
  for (const k of PUT_FIELDS) if (b[k] !== null && typeof b[k] !== "string") return T`“${k}” must be a string or null.`;
  return "";
}

export async function previewRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
  const linkId = /^\/api\/preview-links\/([^/]+)$/.exec(p)?.[1];
  const responsible = p === "/api/preview-links" || linkId || p === "/api/integrations/ngrok";
  if (responsible) {
    try {
      if (p === "/api/preview-links" && m === "GET") return respond(res, 200, list());
      if (p === "/api/preview-links" && m === "POST") {
        const b = await readBody(req);
        const form = linkBodyError(b);
        if (form) return respond(res, 400, { error: form, code: "FORM" });
        return respond(res, 201, await createOne({ projectId: b.projectId, instance: b.instance, serviceId: b.serviceId, validDays: b.validDays }));
      }
      if (linkId && m === "DELETE") {
        const l = await revoke(decodeURIComponent(linkId));
        return l ? respond(res, 200, l) : respond(res, 404, { error: T("Unknown link."), code: "LINK" });
      }
      if (p === "/api/integrations/ngrok" && m === "GET") return respond(res, 200, readAccess());
      if (p === "/api/integrations/ngrok" && m === "PUT") {
        const b = await readBody(req);
        const form = accessBodyError(b);
        if (form) return respond(res, 400, { error: form, code: "FORM" });
        return respond(res, 200, await setAccess({ authtoken: b.authtoken, apiKey: b.apiKey }));
      }
      if (p === "/api/integrations/ngrok" && m === "DELETE") return respond(res, 200, await deleteAccess());
    } catch (e) {
      if (e instanceof PreviewError) return respond(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}), ...e.extra });
      // Body errors from readBody (400/413/415) with their status, everything else 500 — both with no-store (EVERY
      // response) and redacted: an unexpected error from the SDK can name the authtoken (ngrok does, ERR_NGROK_105/107).
      const status = Number(e?.status) >= 400 && Number(e?.status) < 600 ? Number(e.status) : 500;
      const text = redact(e?.message || e);
      if (status === 500) console.error(`[preview] ${m} ${p}: ${text}`);
      return respond(res, status, { error: text });
    }
  }
  return NEXT;
}
