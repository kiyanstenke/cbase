// Basic HTTP tooling with no domain knowledge: sending responses (send), reading the body (readBody/readBodyOrEmpty/readRawBody,
// BODY_MAX), downloads and range requests (serveDownload, serveRanged, supplyFile), static files (serveStatic, MIME, safeFileName).

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import { openDownload, downloadTarget, imageMime } from "../files.js";
import { zipDirectory } from "../zip.js";
import { T } from "../i18n.js";


// ── Serving from a file ──────────────────────────────────────────────────────────────────────────────────────────────────
// Never `fs.createReadStream(path).pipe(res)` — two defects, one pattern ("a stream without a listener"):
//   - The open would run ASYNCHRONOUSLY after the headers — an EACCES (mode 000), ENOENT (deleted) or EISDIR would arrive as
//     'error' on a stream without a listener: process end (B with its project containers). So the file is opened BEFORE the
//     headers, and an error is a response with a status (404 missing, 403 no read permission, 400 not a regular file).
//   - `pipe` does not destroy the source when the target dies: an aborted download (seeking in the web video) would leave stream
//     and descriptor open. `pipeline` destroys both sides, `autoClose` closes the descriptor.
// Opened with O_NONBLOCK: a FIFO does not stall B (no effect on a regular file; the same choice as files.js openDownload) —
// and a FIFO is not a regular file, so 400.
const READ = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
const READ_STATUS = { ENOENT: 404, ENOTDIR: 404, EACCES: 403, EPERM: 403 };
function readError(e) {
  const status = READ_STATUS[e?.code] || 500;
  const text = status === 404 ? T("Not found") : status === 403 ? T("No read permission") : String(e?.message || e);
  return Object.assign(new Error(text), { status, code: e?.code });
}
function close(fd) { try { fs.closeSync(fd); } catch { /* already closed */ } }
// → `{ fd, st }` of a regular file; throws with `status`.
function openToRead(file) {
  let fd;
  try { fd = fs.openSync(file, READ); } catch (e) { throw readError(e); }
  let st;
  try { st = fs.fstatSync(fd); } catch (e) { close(fd); throw readError(e); }
  if (!st.isFile()) { close(fd); throw Object.assign(new Error(T("Not a regular file")), { status: 400 }); }
  return { fd, st };
}
// An already opened descriptor (the caller opened it checked, e.g. without a symlink in the runtime folder) → `{ fd, st }` of
// the same shape; a regular file only, otherwise it is closed and this throws with `status` (like openToRead).
function takeDescriptor(fd) {
  let st;
  try { st = fs.fstatSync(fd); } catch (e) { close(fd); throw readError(e); }
  if (!st.isFile()) { close(fd); throw Object.assign(new Error(T("Not a regular file")), { status: 400 }); }
  return { fd, st };
}
// The source into the response — with listeners on both sides. A client abort is not a server error.
function serve(source, res) {
  pipeline(source, res, (err) => {
    if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") console.warn(`[download] aborted: ${err.message || err}`);
  });
}

// A file as a WHOLE response (200) — the path of every route that serves a file: open BEFORE the headers (`{ path }`) or take
// a descriptor that was opened checked (`{ fd }` — it is closed on every exit), `Content-Length` from fstat (a length from
// metadata lies if the file has changed in the meantime), deliver via `pipeline`. `header`: the remaining headers, WITHOUT
// Content-Length. An error on open is a response (404 missing, 403 no read permission, 400 not a regular file).
// Callers: chats/routes.js (folder context, attachment, artifact), channels/routes.js (channel file).
// Guard: server/backend/test/file-download.test.js.
function supplyFile(res, source, header = {}) {
  let o;
  try { o = source?.fd != null ? takeDescriptor(source.fd) : openToRead(source?.path); }
  catch (e) { return send(res, e.status || 500, { error: e.message }); }
  res.writeHead(200, { ...header, "Content-Length": o.st.size });
  return serve(fs.createReadStream(null, { fd: o.fd, start: 0, autoClose: true }), res);
}

// Serve a file with HTTP Range — videos need it (Safari/AVPlayer always load mp4 in byte ranges; without 206 the player stays
// black).
// `fd`: an already opened descriptor (captures.js — opened without a symlink in a project's runtime folder); THIS one is
// served, never the path, and it is closed on every exit. Without `fd`, serveRanged opens the path itself (before the headers,
// see above) — both ways then deliver through a descriptor.
function serveRanged(req, res, filePath, mime, { fd = null } = {}) {
  let st;
  try { ({ fd, st } = fd === null ? openToRead(filePath) : takeDescriptor(fd)); }
  catch (e) { return send(res, e.status || 500, { error: e.message }); }
  const size = st.size;
  // `private` is mandatory: without it a CDN caches the file PUBLICLY at the edge (cache HIT without a session cookie) — the
  // gateway auth would be bypassed. The browser may cache for long: the content behind a capture id is immutable.
  const headers = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000" };
  const mm = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!mm || (!mm[1] && !mm[2])) {
    res.writeHead(200, { ...headers, "Content-Length": size });
    return serve(fs.createReadStream(null, { fd, start: 0, autoClose: true }), res);
  }
  const start = mm[1] ? Number(mm[1]) : Math.max(0, size - Number(mm[2]));
  const end = mm[1] && mm[2] ? Math.min(Number(mm[2]), size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    close(fd);
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  return serve(fs.createReadStream(null, { fd, start, end, autoClose: true }), res);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
// JSON responses from COMPRESS_FROM_CHARACTERS on are compressed (the full history of a large chat can be tens of MB): Brotli,
// otherwise gzip, depending on the request's `Accept-Encoding` (`res.req`, Node ≥ 15.7); without a matching value (curl,
// http.get, an old client) unchanged. Compression runs ASYNCHRONOUSLY in the thread pool — the event loop stays free —, and an
// error there sends the response uncompressed. ONLY here: streams (SSE `text/event-stream`, downloads, files) write their own
// headers and stay uncompressed — a buffered SSE stream would never arrive. The gateway passes header and body through raw
// (server/gateway/proxy.js). Guard: server/backend/test/log-window.test.js.
export const COMPRESS_FROM_CHARACTERS = 16 * 1024;
const BROTLI_QUALITY = 5; // 11 (the default) costs seconds at 37 MB; 5 is close to gzip -9 at a fraction of the time
const GZIP_STAGE = 6;
const JSON_RESPONSE_TYPE = "application/json; charset=utf-8";
/** The encoding for an `Accept-Encoding` line: "br", "gzip" or null (q=0 excludes). */
export function encodingFor(accept) {
  const offerings = new Map();
  for (const part of String(accept || "").toLowerCase().split(",")) {
    const [name, ...rest] = part.trim().split(";");
    if (!name) continue;
    const q = rest.map((x) => /^\s*q=([\d.]+)/.exec(x)?.[1]).find(Boolean);
    offerings.set(name.trim(), q === undefined ? 1 : Number(q));
  }
  if ((offerings.get("br") ?? 0) > 0) return "br";
  if ((offerings.get("gzip") ?? 0) > 0) return "gzip";
  return null;
}
const send = (res, code, obj) => {
  const text = JSON.stringify(obj);
  const kod = typeof text === "string" && text.length >= COMPRESS_FROM_CHARACTERS ? encodingFor(res.req?.headers?.["accept-encoding"]) : null;
  if (!kod) { res.writeHead(code, { "Content-Type": JSON_RESPONSE_TYPE }); res.end(text); return; }
  const raw = Buffer.from(text);
  const finished = (err, z) => {
    if (res.headersSent || res.destroyed) return;
    if (err) { res.writeHead(code, { "Content-Type": JSON_RESPONSE_TYPE }); res.end(raw); return; }
    res.writeHead(code, { "Content-Type": JSON_RESPONSE_TYPE, "Content-Encoding": kod, Vary: "Accept-Encoding", "Content-Length": z.length });
    res.end(z);
  };
  if (kod === "br") {
    zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, finished);
  } else zlib.gzip(raw, { level: GZIP_STAGE }, finished);
};
const BODY_MAX = 5_000_000;

// ── Reading the body ─────────────────────────────────────────────────────────────────────────────────────────────────────
// ONE reader for readBody and readRawBody:
//   - BYTES are collected, decoding happens ONCE at the end. With `d += c` per chunk a multi-byte character on a chunk
//     boundary becomes two U+FFFD, JSON.parse does not throw, and the response is 200 — non-ASCII text silently replaced.
//     Invalid UTF-8 is a 400, not a silent replacement.
//   - At the cap a 413 WITH a response, for both variants: do NOT destroy — a `req.destroy()` yields an abort without a status
//     (a 502 at the gateway). `resume()` instead of `pause()`: the rest of the body is read and DISCARDED so that the request
//     ends cleanly and the response actually goes out; a `pause()` would block the sender until someone closes the socket.
//     The cap counts bytes, not characters.
//   - readBody reads a body only under a JSON type (`application/json`, `application/<x>+json`): a body with `text/plain` (or
//     without a type) is what a foreign web page can send WITHOUT a preflight — parsing it as JSON would be CSRF against the
//     local server (see runtime/origin.js). So 415. An EMPTY body stays `{}`, whatever the type. Every own caller sets the
//     type (web/src/lib/api/core.ts, mobile APIClient, mcp/lib.js, server/backend/cbase-project, the test harnesses).
//     Node's fetch sets `text/plain;charset=UTF-8` for a string body BY ITSELF — a new caller without the header therefore
//     gets a loud 415, never a silent yes.
function readBodyValue(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let length = 0;
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      length += b.length;
      if (length > max) {
        tooBig = true;
        parts.length = 0;
        req.resume();
        reject(Object.assign(new Error(T`Body too large (more than ${max >= 1e6 ? `${Math.round(max / 1e6)} MB` : `${max} Bytes`})`), { status: 413 }));
        return;
      }
      parts.push(b);
    });
    req.on("error", (e) => reject(e));
    req.on("end", () => { if (!tooBig) resolve(Buffer.concat(parts, length)); });
  });
}

const JSON_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i;
const mediaType = (header) => String(header?.["content-type"] ?? "").split(";")[0].trim();
const UTF8 = new TextDecoder("utf-8", { fatal: true });

async function readBody(req) {
  const raw = await readBodyValue(req, BODY_MAX);
  if (!raw.length) return {};
  const type = mediaType(req.headers);
  if (!JSON_TYPE.test(type)) {
    throw Object.assign(new Error(`The body must be JSON (Content-Type: application/json) — sent: ${type ? type.slice(0, 80) : "no Content-Type"}`), { status: 415 });
  }
  let text;
  try { text = UTF8.decode(raw); } catch { throw Object.assign(new Error("The body is not valid UTF-8"), { status: 400 }); }
  try { return JSON.parse(text); } catch (e) { throw Object.assign(e, { status: 400 }); }
}

// A body that MAY be missing: empty, broken JSON (400) or a torn stream yield `{}` — but a 415 (no JSON type) and a 413 (too
// large) go out. With `readBody(req).catch(() => ({}))` the loud 415 from above would become a silent yes WITHOUT fields, and
// the route would run anyway. Guard: server/backend/test/dispatcher.test.js (also: no `.catch(() => ({}))` on readBody in the
// server tree).
async function readBodyOrEmpty(req) {
  try { return await readBody(req); }
  catch (e) {
    if (e?.status === 415 || e?.status === 413) throw e;
    return {};
  }
}

// Raw binary body (file uploads) — deliberately generous limit. At the cap 413 like readBody (see above).
function readRawBody(req, maxBytes = 200_000_000) {
  return readBodyValue(req, maxBytes);
}

// Content-Disposition with non-ASCII names: old clients read `filename`, modern ones `filename*`.
function dispositionHeader(name, inline) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// File/folder download from a project or workspace folder. A file goes out raw, a folder as a streamed ZIP (zip.js) — both
// without an intermediate buffer, so large trees pass too. `inline` delivers the same bytes for display instead of saving; the
// code viewer's image preview depends on exactly that.
// `limit` (files.js): for a path of a converted project ONE checked descriptor (files.js openDownload) — a file goes out
// through it (Content-Length from fstat), a folder as a ZIP from the area without symlinks (zip.js `area`), everything else
// is 400 "not a regular file". Without a limit (or for a path it gives no area to) the plain path.
async function serveDownload(root, rel, res, { inline = false, limit = null } = {}) {
  if (typeof limit === "function") {
    let z;
    try { z = openDownload(root, rel, { limit }); }
    catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    if (z) return serveDownloadInArea(z, res, { inline });
  }
  let target;
  try { target = downloadTarget(root, rel); }
  catch (e) { return send(res, 400, { error: String(e.message || e) }); }

  if (!target.dir) {
    const mime = imageMime(target.name) || "application/octet-stream";
    // Open before the headers (see "Serving from a file" above); the length comes from the opened descriptor.
    let o;
    try { o = openToRead(target.abs); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": o.st.size,
      "Content-Disposition": dispositionHeader(target.name, inline),
      // Inline images may be cached in the renderer, otherwise the preview flickers on every tab switch. But the path alone
      // is no version key: after saving, an old image would be visible — hence only briefly and with revalidation.
      "Cache-Control": inline ? "private, max-age=0, must-revalidate" : "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return serve(fs.createReadStream(null, { fd: o.fd, start: 0, autoClose: true }), res);
  }

  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": dispositionHeader(`${target.name}.zip`, false),
    "Cache-Control": "no-store",
  });
  try {
    await zipDirectory(target.abs, target.name, res, {
      note: { header: T("Skipped while packing:") },
    });
    res.end();
  } catch (e) {
    // The headers are long gone — ending half an archive as "done" would be the worse lie. Let the connection break; the
    // client reports the abort.
    console.error("[download] ZIP aborted:", e.message || e);
    try { res.destroy(); } catch {}
  }
}

// The same with a limit (see serveDownload): `z` from files.js openDownload.
async function serveDownloadInArea(z, res, { inline }) {
  if (z.fd !== null) {
    res.writeHead(200, {
      "Content-Type": imageMime(z.name) || "application/octet-stream",
      "Content-Length": z.st.size,
      "Content-Disposition": dispositionHeader(z.name, inline),
      "Cache-Control": inline ? "private, max-age=0, must-revalidate" : "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return serve(fs.createReadStream(null, { fd: z.fd, autoClose: true }), res);
  }
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": dispositionHeader(`${z.name}.zip`, false),
    "Cache-Control": "no-store",
  });
  try {
    await zipDirectory(z.abs, z.name, res, {
      note: { header: T("Skipped while packing:") },
      area: z.area,
    });
    res.end();
  } catch (e) {
    console.error("[download] ZIP aborted:", e.message || e);
    try { res.destroy(); } catch {}
  }
}

const ATTACH_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".pdf": "application/pdf",
};
const attachmentMime = (name) => ATTACH_MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
// Defuse a file name for storage (no paths/special characters); the original name stays in the metadata.
const safeFileName = (name) => (String(name || "file").split(/[\\/]/).pop() || "file").replace(/[^\w.\- ()À-ſ]/g, "_").slice(0, 120);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveStatic(res, webDir, pathname) {
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(webDir, clean);
  if (!path.resolve(file).startsWith(path.resolve(webDir))) return send(res, 403, { error: "forbidden" });
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) {
    const asHtml = path.join(webDir, clean, "index.html");
    if (fs.existsSync(asHtml)) file = asHtml;
    else file = path.join(webDir, "index.html"); // fall back to the UI
  }
  // If even the fallback index.html is missing (incompletely copied bundle), do NOT write the headers first and then fail on
  // reading: the outer error path would then try to send 500, which throws ERR_HTTP_HEADERS_SENT.
  if (!fs.existsSync(file)) return send(res, 404, { error: "not found" });
  const type = MIME[path.extname(file)] || "application/octet-stream";
  // NEVER cache index.html: it references the (content-hashed) chunks. A cached old index.html would keep loading old code
  // after a deploy. Hashed assets may be cached.
  const headers = { "Content-Type": type };
  if (type.startsWith("text/html")) headers["Cache-Control"] = "no-store, must-revalidate";
  res.writeHead(200, headers);
  res.end(fs.readFileSync(file));
}

// The dispatcher's sentinel: a route function returns NEXT when it is not responsible. Any other return value — including
// undefined from `return send(res, …)` or a bare `return;` — means "answered", and the dispatcher in server.js returns. A
// symbol, so no return value of the routes can ever be confused with it.
export const NEXT = Symbol("route: not responsible");

export { BODY_MAX, attachmentMime, dispositionHeader, supplyFile, readBody, readBodyOrEmpty, readRawBody, safeFileName, send, serveDownload, serveRanged, serveStatic };
