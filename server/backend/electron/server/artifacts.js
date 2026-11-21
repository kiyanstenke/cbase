import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { T } from "./i18n.js";

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_ARTIFACT_FILES = 1000;
export const DEFAULT_READ_BYTES = 256 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;

let artifactsRoot = "";

const MIME = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/typescript; charset=utf-8",
  ".tsx": "text/typescript; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export class ArtifactError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ArtifactError";
    this.status = status;
  }
}

export function initArtifacts(root) {
  artifactsRoot = path.resolve(root);
  fs.mkdirSync(artifactsRoot, { recursive: true });
}

function root() {
  if (!artifactsRoot) throw new Error("Artifact storage was not initialized");
  return artifactsRoot;
}

function chatRoot(chatId) {
  const id = String(chatId || "");
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new ArtifactError(T("Invalid chat ID"));
  return path.join(root(), id);
}

// ── Folder context ─────────────────────────────────────────────────────────────
// Context files belong to a CHAT FOLDER, not a chat: the human puts them there, and EVERY chat of the folder may read them.
// They live in the same storage and run through the same checked core as artifacts (path check, symlink ban, limits,
// SHA-256), but under the reserved directory `_ctx/<folder-id>`. The underscore can never be a chat ID (chatRoot allows only
// [A-Za-z0-9-]) — a collision is thereby ruled out.
const CONTEXT_DIR = "_ctx";

function folderContextRoot(folderId) {
  const id = String(folderId || "");
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new ArtifactError(T("Invalid folder ID"));
  return path.join(root(), CONTEXT_DIR, id);
}

function cleanRelativePath(input) {
  const value = String(input ?? "");
  if (!value || value.length > 512 || value.includes("\0") || value.includes("\\")) {
    throw new ArtifactError(T("Invalid artifact path"));
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new ArtifactError(T("Artifact path must be relative"));
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 180)) {
    throw new ArtifactError(T("Artifact path contains invalid segments"));
  }
  return parts.join("/");
}

function ensureNoSymlink(base, target, includeLeaf = true) {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (target !== base) throw new ArtifactError(T("Artifact path leaves the chat"));
    return;
  }
  const parts = relative.split(path.sep);
  let current = base;
  const count = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  for (let i = 0; i < count; i += 1) {
    current = path.join(current, parts[i]);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new ArtifactError(T("Symbolic links are not allowed in artifacts"));
  }
}

// Files uploaded by hand carry arbitrary names: Windows separators, control characters, segments of nothing but dots,
// overlong names. The human should not see an error for that — the name is trimmed to a valid artifact path. The arbiter
// remains cleanRelativePath: whatever is still invalid afterwards is rejected.
export function sanitizeArtifactPath(input) {
  const segments = String(input ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .filter((part) => part && !/^\.+$/.test(part))
    .map((part) => {
      if (part.length <= 180) return part;
      // Shorten without losing the extension — it decides MIME and preview.
      const ext = path.extname(part).slice(0, 32);
      return part.slice(0, 180 - ext.length) + ext;
    });
  if (!segments.length) segments.push("upload");
  return cleanRelativePath(segments.join("/"));
}

// ── Core: everything works on a BASE directory ──────────────────────────
// Chat artifacts and folder context differ only in this base path. So the logic lives here once, and the two public
// facades further down merely pass in the respective base path — so path check, symlink ban, limits and optimistic
// concurrency necessarily apply equally to both.
function resolveIn(base, artifactPath, includeLeaf = true) {
  const relative = cleanRelativePath(artifactPath);
  const target = path.resolve(base, ...relative.split("/"));
  if (!target.startsWith(base + path.sep)) throw new ArtifactError(T("Artifact path leaves the chat"));
  ensureNoSymlink(base, target, includeLeaf);
  return { base, relative, target };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function artifactMime(artifactPath) {
  return MIME[path.extname(String(artifactPath)).toLowerCase()] || "application/octet-stream";
}

function isTextMime(mime) {
  return mime.startsWith("text/") || /(?:json|yaml|xml|javascript|typescript)/.test(mime);
}

function artifactMeta(relative, target, buffer = null) {
  const stat = fs.statSync(target);
  const bytes = buffer || fs.readFileSync(target);
  return {
    path: relative.split(path.sep).join("/"),
    name: path.basename(relative),
    mime: artifactMime(relative),
    size: stat.size,
    createdAt: stat.birthtimeMs,
    modifiedAt: stat.mtimeMs,
    sha256: sha256(bytes),
  };
}

function walkFiles(base, current = base, out = []) {
  if (!fs.existsSync(current)) return out;
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new ArtifactError(T("Symbolic links are not allowed in artifacts"));
    if (entry.isDirectory()) walkFiles(base, full, out);
    else if (entry.isFile()) {
      out.push({ full, relative: path.relative(base, full) });
      if (out.length > MAX_ARTIFACT_FILES) throw new ArtifactError(T`A chat may contain at most ${MAX_ARTIFACT_FILES} artifacts`, 413);
    }
  }
  return out;
}

function listIn(base) {
  return walkFiles(base).map(({ full, relative }) => artifactMeta(relative, full));
}

function existsIn(base, artifactPath) {
  const { target } = resolveIn(base, artifactPath);
  return fs.existsSync(target) && fs.statSync(target).isFile();
}

// A free path near the desired one: "image.png" → "image-2.png" → "image-3.png". Needed for paths at whose end NO human
// can answer a conflict question — e.g. the artifact copy of a chat attachment: it must never overwrite an existing file,
// but must not fail on the name either.
function uniqueIn(base, artifactPath) {
  const relative = cleanRelativePath(artifactPath);
  if (!existsIn(base, relative)) return relative;
  const ext = path.extname(relative);
  const stem = relative.slice(0, relative.length - ext.length);
  for (let i = 2; i <= 200; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsIn(base, candidate)) return candidate;
  }
  throw new ArtifactError(T("No free artifact path found"), 409);
}

function readIn(base, artifactPath, { offset = 0, maxBytes = DEFAULT_READ_BYTES } = {}) {
  const { relative, target } = resolveIn(base, artifactPath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new ArtifactError(T("Artifact not found"), 404);
  const all = fs.readFileSync(target);
  const start = Math.min(all.length, Math.max(0, Number(offset) || 0));
  const limit = Math.min(MAX_READ_BYTES, Math.max(1, Number(maxBytes) || DEFAULT_READ_BYTES));
  const slice = all.subarray(start, Math.min(all.length, start + limit));
  const meta = artifactMeta(relative, target, all);
  const text = isTextMime(meta.mime);
  return {
    ...meta,
    offset: start,
    nextOffset: start + slice.length < all.length ? start + slice.length : null,
    truncated: start + slice.length < all.length,
    encoding: text ? "utf8" : "base64",
    content: slice.toString(text ? "utf8" : "base64"),
  };
}

function usageIn(base, excluding = "") {
  let bytes = 0;
  let files = 0;
  for (const entry of walkFiles(base)) {
    if (entry.full === excluding) continue;
    bytes += fs.statSync(entry.full).size;
    files += 1;
  }
  return { bytes, files };
}

// `overwrite` is meant exclusively for the upload BY HAND: there a human saw the existing file in the list and confirmed
// the replacement. Agents keep writing only with a read expectedSha256 — otherwise a run would blindly overwrite others' work.
function writeIn(base, artifactPath, content, { encoding = "utf8", expectedSha256 = "", overwrite = false } = {}) {
  const { relative, target } = resolveIn(base, artifactPath, false);
  let bytes;
  if (Buffer.isBuffer(content)) bytes = content;
  else {
    try { bytes = Buffer.from(String(content ?? ""), encoding === "base64" ? "base64" : "utf8"); }
    catch { throw new ArtifactError(T("Artifact content could not be decoded")); }
  }
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new ArtifactError(T`Artifact is larger than ${MAX_ARTIFACT_BYTES} bytes`, 413);

  const exists = fs.existsSync(target);
  if (exists) {
    ensureNoSymlink(base, target, true);
    if (!fs.statSync(target).isFile()) throw new ArtifactError(T("There is no file at the artifact path"), 409);
    const current = fs.readFileSync(target);
    const currentHash = sha256(current);
    if (current.equals(bytes)) return { ...artifactMeta(relative, target, current), unchanged: true };
    if (!overwrite) {
      if (!expectedSha256) throw new ArtifactError(T("Artifact already exists — to overwrite, read it first and send expectedSha256"), 409);
      if (expectedSha256 !== currentHash) throw new ArtifactError(T("Artifact was changed in the meantime"), 409);
    }
  } else if (expectedSha256) {
    throw new ArtifactError(T("Artifact no longer exists"), 409);
  }

  const usage = usageIn(base, exists ? target : "");
  if (!exists && usage.files >= MAX_ARTIFACT_FILES) throw new ArtifactError(T`A chat may contain at most ${MAX_ARTIFACT_FILES} artifacts`, 413);
  if (usage.bytes + bytes.length > MAX_CHAT_ARTIFACT_BYTES) throw new ArtifactError(T`Artifacts of this chat exceed ${MAX_CHAT_ARTIFACT_BYTES} bytes`, 413);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  ensureNoSymlink(base, target, false);
  const temporary = path.join(path.dirname(target), `.cbase-artifact-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return { ...artifactMeta(relative, target, bytes), unchanged: false };
}

function deleteIn(base, artifactPath, expectedSha256 = "") {
  const { relative, target } = resolveIn(base, artifactPath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new ArtifactError(T("Artifact not found"), 404);
  const current = fs.readFileSync(target);
  if (!expectedSha256 || sha256(current) !== expectedSha256) {
    throw new ArtifactError(T("To delete, read first and send the current expectedSha256"), 409);
  }
  fs.rmSync(target);
  let dir = path.dirname(target);
  while (dir !== base && dir.startsWith(base + path.sep)) {
    if (fs.readdirSync(dir).length) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
  return { path: relative, deleted: true };
}

function downloadIn(base, artifactPath) {
  const { relative, target } = resolveIn(base, artifactPath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new ArtifactError(T("Artifact not found"), 404);
  return { path: relative, fullPath: target, ...artifactMeta(relative, target) };
}

// ── Facade: artifacts of a chat ────────────────────────────────────────────
export const artifactExists = (chatId, artifactPath) => existsIn(chatRoot(chatId), artifactPath);
export const uniqueArtifactPath = (chatId, artifactPath) => uniqueIn(chatRoot(chatId), artifactPath);
export const listArtifacts = (chatId) => listIn(chatRoot(chatId));
export const readArtifact = (chatId, artifactPath, options) => readIn(chatRoot(chatId), artifactPath, options);
export const writeArtifact = (chatId, artifactPath, content, options) => writeIn(chatRoot(chatId), artifactPath, content, options);
export const deleteArtifact = (chatId, artifactPath, expectedSha256) => deleteIn(chatRoot(chatId), artifactPath, expectedSha256);
export const artifactDownload = (chatId, artifactPath) => downloadIn(chatRoot(chatId), artifactPath);

export function removeChatArtifacts(chatId) {
  fs.rmSync(chatRoot(chatId), { recursive: true, force: true });
}

export function copyChatArtifacts(sourceChatId, targetChatId) {
  const source = chatRoot(sourceChatId);
  const target = chatRoot(targetChatId);
  if (!fs.existsSync(source)) return 0;
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new ArtifactError(T("Target chat already has artifacts"), 409);
  const files = walkFiles(source);
  for (const { full, relative } of files) {
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(full, destination, fs.constants.COPYFILE_EXCL);
  }
  return files.length;
}

// ── Facade: context files of a chat folder ────────────────────────────────
export const contextFileExists = (folderId, filePath) => existsIn(folderContextRoot(folderId), filePath);
export const uniqueContextPath = (folderId, filePath) => uniqueIn(folderContextRoot(folderId), filePath);
export const listContextFiles = (folderId) => listIn(folderContextRoot(folderId));
export const readContextFile = (folderId, filePath, options) => readIn(folderContextRoot(folderId), filePath, options);
export const writeContextFile = (folderId, filePath, content, options) => writeIn(folderContextRoot(folderId), filePath, content, options);
export const deleteContextFile = (folderId, filePath, expectedSha256) => deleteIn(folderContextRoot(folderId), filePath, expectedSha256);
export const contextFileDownload = (folderId, filePath) => downloadIn(folderContextRoot(folderId), filePath);

export function removeFolderContext(folderId) {
  fs.rmSync(folderContextRoot(folderId), { recursive: true, force: true });
}
