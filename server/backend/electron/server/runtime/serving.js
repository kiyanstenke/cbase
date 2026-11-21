// Serving foreign and agent-written files under the cbase origin — a leaf with no imports.
//
// What is served here is not written by cbase: an uploaded document, an artifact or a context file written by an agent — also
// an agent inside a project container (the fence allows `chat-artifacts-write`). The MIME type follows the foreign name
// (`.html`, `.svg`, `.xml`, `.js`). Served as `text/html` with `inline`, without CSP and nosniff, such a file shares the origin
// of `/api/*` and `/gw/*`: one click on "open original" would run its script with the user's session.
//
// The rule, ONE for all raw, attachment, document, artifact and context routes:
//   1. ALWAYS `X-Content-Type-Options: nosniff` — the browser takes the type at its word and does not sniff HTML from the bytes.
//   2. A type that is not on the PASSIVE list gets `Content-Security-Policy: sandbox …` WITHOUT allow-same-origin and without
//      allow-scripts: the document is displayed (an HTML log stays readable) but runs in an opaque origin, with no script, no
//      form, no popup, and loads nothing else (no tracking pixel on open).
// The list is an ALLOWLIST: an unknown type counts as active. The sandbox does not hurt a passive type — except PDF: Chromium
// refuses its PDF viewer in a sandboxed document. That is why PDF is on the list (the viewer runs in its own origin anyway).
// Images in an `<img>` and videos in a `<video>` are not affected by the header; an SVG in an `<img>` never runs a script, so
// the artifact preview stays as it is.
//
// Users: chats/routes.js (artifact and context download, chat attachment `GET /api/chats/:id/attachments/:file`) and
// channels/routes.js (channel file). Chat attachment and channel file get their type from `attachmentMime` (runtime/http.js),
// which knows `.svg` → `image/svg+xml`: an agent in the project container writes into the attachment folder (runtime folder,
// mounted rw), and sendToChannel copies from there.
// NOT the same class: runtime/http.js `serveDownload` and devtools/code-route.js type only via `imageMime` (files.js, no SVG),
// everything else as octet-stream, and set nosniff themselves. Whoever allows an active type there uses THIS leaf, not a
// second list.

const PASSIVE = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/json", "application/x-ndjson", "application/yaml", "text/yaml",
  "text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "text/typescript",
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
  "application/zip", "application/rtf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// No `allow-*`: no script, no same origin, no form, no popup. Subresources only from the file itself (data:) — inline styles
// so an HTML log stays readable.
export const SANDBOX_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:";

/** The bare type without parameters, lower-cased — empty means octet-stream (that is also how it is sent). */
export function reasonType(mime) {
  const t = String(mime || "").split(";")[0].trim().toLowerCase();
  return t || "application/octet-stream";
}

/** May the browser execute this type as a document under the cbase origin? Everything except the allowlist and audio/video. */
export function isActiveContent(mime) {
  const t = reasonType(mime);
  if (t.startsWith("video/") || t.startsWith("audio/")) return false;
  return !PASSIVE.has(t);
}

/** The headers EVERY delivery of a foreign file carries in addition to type, length, disposition and cache. */
export function servingHeader(mime) {
  return {
    "X-Content-Type-Options": "nosniff",
    ...(isActiveContent(mime) ? { "Content-Security-Policy": SANDBOX_CSP } : {}),
  };
}
