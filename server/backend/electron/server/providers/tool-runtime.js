// tool-runtime.js — built-in tools for the loop engine.
//
// Completion providers have NO built-in file/shell tools (Claude/Codex bring them along). This runtime rebuilds them —
// with the same NAMES and INPUT SHAPES as Claude, so that AssistantBlocks.tsx renders them identically (Write→diff,
// Edit→-old/+new, TodoWrite→list, Bash/Read/Grep/Glob→capped <pre>). Pure fs/shell — no LLM, no provider reference.
//
// The ONE start function: Bash starts in the project container of the instance (ctx.instance), without one locally.
import { opsMarker, inProject } from "../runtime/inProject.js";
// With an instance: file tools check the REAL place (symlinks resolved), WebFetch connects localhost to the instance.
// Without an instance in server operation likewise the real place of the roots (see areaOf), in the local server the literal check.
import { editInArea, realRoots, realPath, entriesInArea, inArea, readInArea, writeInArea, statInArea } from "../runtime/real-path.js";
import { requestInProject } from "../runtime/target.js";
// The trusted anchors of the instance (project folder, runtime folder): only their realpath counts, every root below
// applies relatively, a link in their place does not count.
import { areaInB, rootsOfTheInstance } from "../runs/runtime-limit.js";
// In a copy the project folder exists only IN the copy container (overlay view); the backend would see the main
// instance. A path below it therefore goes through the file access (runtime/fileAccess.js), never through the backend.
import { instanceIsCopy } from "../runs/instance.js";
import { withLfsEnvironment } from "../runs/lfs-environment.js";
import * as access from "../runtime/fileAccess.js";
import { globToRegExp } from "../runtime/fileAccess.js";
import crypto from "node:crypto";
// The ONE rule against detached shells — the same as the PreToolUse hook of the Claude CLI.
import { DETACH_RULE, detachReason } from "../../mcp/detach-rule.js";
// "Save computing power": the same rule as the hook of the Claude CLI (mcp/bash-guard.js --cpu-wait).
import { endText, withNice, waitForCpu, waitText } from "../../mcp/cpu-saver.js";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

import { pdfImages, pdfPageCount } from "../doctext.js";

const MAX_READ_BYTES = 400_000;
const MAX_IMAGE_BYTES = 3_500_000;   // above that the providers reject the image anyway
const MAX_PDF_BYTES = 8_000_000;     // a PDF costs text AND image per page
const MAX_PDF_PAGES = 30;           // a manual as a whole bursts every context window
const MAX_NOTEBOOK_OUTPUT = 2_000;   // cell output per cell
const MAX_OUTPUT = 60_000;
const MAX_GREP_MATCHES = 300;
const MAX_GLOB_HITS = 400;
const MAX_WALK_FILES = 20_000;     // files a tree walk (Glob, Grep) looks at at most (walkFiles)
const MAX_WEB_BYTES = 2_000_000;   // raw HTML cap before the text extraction
const MAX_WEB_TEXT = 80_000;       // extracted text the model gets
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", ".cache", "coverage", ".venv", "vendor"]);

// ── Sandbox: the path must lie in cwd or an addDir ──────────────────────────────
function sandboxRoots(ctx) {
  const roots = [ctx.cwd, ...(ctx.addDirs || [])].filter(Boolean).map((r) => path.resolve(r));
  return roots.length ? roots : [path.resolve(ctx.cwd || ".")];
}
// With an instance: the tools run in the backend, the agent's Bash in the project container — a symlink it creates
// there would point, in the backend, to a file outside the project. So the real place is checked (runtime/real-path.js:
// realpath of the deepest existing ancestor) against the real place of the roots.
//
// WITHOUT an instance IN SERVER OPERATION likewise: a chat without a project works in the backend above the folders of
// relocated projects, which a project container writes freely — a link created there would lead outside. There the
// real place of the roots applies (without anchors: cwd and addDirs are trusted in the backend, their realpath
// counts), files are opened with O_NONBLOCK, and only a regular file is read (a FIFO would stall the event loop).
// WITHOUT the operation marker (the local server, a backend without project containers) the literal check stays —
// there the agent's Bash runs unlocked on the machine anyway. The marker is the same as projectbox/ops.js
// (runtime/inProject.js `opsMarker`).
//
// The roots themselves: output location, attachment folder and worktree are ordinary subfolders of the runtime
// folder — the project container can replace them by a link. Their place is therefore determined through the trusted
// anchors (runtime/real-path.js), never by realpath of the root.
//
// Through the descriptor: the check at the path (resolveInSandbox) rejects what lies outside by its real place,
// without opening it (no information whether something is there); reading and writing then go through a descriptor
// whose place is checked once more AFTER opening (readInArea/writeInArea/editInArea) — a path part that becomes a link
// in between leads nowhere. The literal branches (`area` null) are the local server and a call that explicitly passes
// no area.
//
// In a COPY: a path that literally does not lie below its project folder goes through the backend (overCopy false) —
// a link in the runtime folder to `<P>/file`, `/proc/self/root<P>/file`. The area is then STRICT and LOCKED
// (runs/runtime-limit.js areaInB): the project folder does not count as a root in the backend (it would see the main
// instance there), and no real place below it lies in the area. What belongs to the copy below its project folder goes
// literally through its container (below), never through the backend.
function areaOf(ctx) {
  if (ctx.instance) return areaInB(ctx.instance, sandboxRoots(ctx));
  return opsMarker() ? realRoots(sandboxRoots(ctx)) : null;
}
// Does `abs` lie in the copy (the chat runs in a copy AND the path lies below or above its project folder)? Then the
// file access reads and writes in the container; the runtime folder (outputs, attachments, worktrees) stays in the
// backend. Without a copy instance always `false`. If the copy's project folder cannot be determined, it THROWS: no
// silent "then in the backend".
function overCopy(abs, ctx) {
  if (!instanceIsCopy(ctx?.instance)) return false;
  const roots = rootsOfTheInstance(ctx.instance);
  if (!roots.project) {
    throw new Error(`The project folder of the copy ${ctx.instance.identifier || ctx.instance.projectId} cannot be determined — nothing read or written, not in main either.`);
  }
  return access.fileWay(ctx.instance, abs, roots) === "copy";
}
function resolveInSandbox(filePath, ctx, area = areaOf(ctx)) {
  if (!filePath || typeof filePath !== "string") throw new Error("file_path is missing");
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(ctx.cwd, filePath);
  const roots = sandboxRoots(ctx);
  if (overCopy(abs, ctx)) {
    // In the copy the literal path counts: the backend does not know the place (realpath there would be the main
    // instance's). A link the agent creates in the copy leads, in the container, only where its Bash leads too — the
    // container is the boundary.
    if (!roots.some((r) => abs === r || abs.startsWith(r + path.sep))) throw new Error(`Path outside the allowed area: ${abs}`);
    return abs;
  }
  if (area) {
    let real = null;
    try { real = realPath(abs); } catch { /* no place (loop) — lies in nothing */ }
    const inside = inArea(real, area);
    if (!inside) {
      // "Symlink" only if the path LITERALLY lies inside — a path that already lies outside as written is simply
      // outside (on macOS every /var/… would otherwise lead to a symlink message via /var → /private/var).
      const verbatimInside = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
      throw new Error(real && real !== abs && verbatimInside
        ? `Path leads out of the allowed area: ${abs} → ${real} (symlink)`
        : `Path outside the allowed area: ${abs}`);
    }
    return abs;
  }
  const ok = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!ok) throw new Error(`Path outside the allowed area: ${abs}`);
  return abs;
}
const clip = (s, n = MAX_OUTPUT) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} characters truncated]` : s);

// ── glob → RegExp (supports **, *, ?, character classes): ONE version with the program in the copy container
// (runtime/fileAccess.js globToRegExp), so that the backend and the copy read the same patterns the same way ──────
// `area` (with an instance): every folder is listed through a checked descriptor — a folder that became a link to the
// outside after its parent was listed silently drops out.
function walkFiles(root, { onFile, maxFiles = MAX_WALK_FILES, area = null } = {}) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = area ? entriesInArea(dir, area) : fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(p); }
      else if (e.isFile()) { if (++count > maxFiles) return; onFile(p); }
    }
  }
}

// ── Tool definitions (schemas as with Claude) ───────────────────────────────────
const S = {
  Read: {
    description: "Reads a file from the local file system (with line numbers). file_path must be absolute or relative to the working directory. Images (PNG/JPEG/GIF/WebP) are returned as an image, PDFs as extracted text, Jupyter notebooks as cells including outputs.",
    inputSchema: { type: "object", properties: {
      file_path: { type: "string", description: "path of the file" },
      offset: { type: "integer", description: "start line (1-based)" },
      limit: { type: "integer", description: "number of lines" },
    }, required: ["file_path"] },
  },
  Write: {
    description: "Writes a file (overwrites an existing one). Folders are created.",
    inputSchema: { type: "object", properties: {
      file_path: { type: "string" }, content: { type: "string" },
    }, required: ["file_path", "content"] },
  },
  Edit: {
    description: "Replaces exactly one text section in a file. old_string must be unique (otherwise replace_all).",
    inputSchema: { type: "object", properties: {
      file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" },
      replace_all: { type: "boolean" },
    }, required: ["file_path", "old_string", "new_string"] },
  },
  MultiEdit: {
    description: "Apply several Edit operations to one file in sequence.",
    inputSchema: { type: "object", properties: {
      file_path: { type: "string" },
      edits: { type: "array", items: { type: "object", properties: {
        old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" },
      }, required: ["old_string", "new_string"] } },
    }, required: ["file_path", "edits"] },
  },
  Glob: {
    description: "Finds files by glob pattern (e.g. **/*.ts). Searches from path (default: working directory).",
    inputSchema: { type: "object", properties: {
      pattern: { type: "string" }, path: { type: "string" },
    }, required: ["pattern"] },
  },
  Grep: {
    description: "Searches file contents by RegExp (ripgrep-like). output_mode picks the output form: content (default, matching lines), files_with_matches (file names only), count (matches per file). after_context/before_context/context deliver context lines, multiline searches across line boundaries.",
    inputSchema: { type: "object", properties: {
      pattern: { type: "string", description: "RegExp" },
      path: { type: "string", description: "start folder or a single file (default: working directory)" },
      glob: { type: "string", description: "file filter, e.g. **/*.ts" },
      type: { type: "string", description: "file type instead of glob, e.g. js, ts, py, go, rs, md" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "output form (default content)" },
      // Field names only from [A-Za-z_][A-Za-z0-9_]*: strict endpoints (Gemini-like function declarations) reject "-i",
      // "-n", "-A", "-B", "-C" as property names — and with them the WHOLE request. The execution (grepTool) keeps
      // reading the old names: a model that knows Claude Code's Grep writes them anyway, and an older history carries them.
      case_insensitive: { type: "boolean", description: "ignore case" },
      line_numbers: { type: "boolean", description: "show line numbers (default true for content)" },
      after_context: { type: "integer", description: "lines AFTER the match" },
      before_context: { type: "integer", description: "lines BEFORE the match" },
      context: { type: "integer", description: "lines before and after the match" },
      multiline: { type: "boolean", description: "pattern may span line boundaries (. also matches \\n)" },
      head_limit: { type: "integer", description: "only the first N output lines" },
    }, required: ["pattern"] },
  },
  Bash: {
    description: `Executes a shell command in the working directory and returns the output. ${DETACH_RULE}`,
    inputSchema: { type: "object", properties: {
      command: { type: "string" }, description: { type: "string" }, timeout: { type: "integer", description: "ms" },
      // No `run_in_background` in the schema: it is rejected at the call (detachReason, see bashTool) — offering a field
      // whose only value is a refusal would only invite the attempt. The refusal itself stays.
    }, required: ["command"] },
  },
  TodoWrite: {
    description: "Updates the task list. todos = array of {content, status(pending|in_progress|completed), activeForm}.",
    inputSchema: { type: "object", properties: {
      todos: { type: "array", items: { type: "object", properties: {
        content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" },
      }, required: ["content", "status"] } },
    }, required: ["todos"] },
  },
  WebFetch: {
    description: "Loads a URL and returns the readable text content of the page (HTML→text). Use prompt to name what you want to find out — you evaluate the returned text yourself.",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "complete URL (https preferred)" },
      prompt: { type: "string", description: "what you are looking for in the page (optional)" },
    }, required: ["url"] },
  },
  WebSearch: {
    description: "Searches the web and returns result titles, URLs and short texts. Afterwards, if useful, go deeper into the most promising page with WebFetch.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "search query" },
    }, required: ["query"] },
  },
  BashOutput: {
    description: "Reads the output of a shell command running in the background (from Bash with run_in_background) that has accrued since the last retrieval. Also shows the status (running/ended).",
    inputSchema: { type: "object", properties: {
      bash_id: { type: "string", description: "id from the Bash call with run_in_background" },
      filter: { type: "string", description: "RegExp — only matching lines (optional)" },
    }, required: ["bash_id"] },
  },
  KillShell: {
    description: "Ends a shell command running in the background (from Bash with run_in_background).",
    inputSchema: { type: "object", properties: {
      shell_id: { type: "string", description: "id of the background shell" },
    }, required: ["shell_id"] },
  },
  NotebookEdit: {
    description: "Edits a Jupyter notebook cell (.ipynb). edit_mode: replace (default), insert (new cell after cell_number), delete. Cells are addressed by 0-based cell_number.",
    inputSchema: { type: "object", properties: {
      notebook_path: { type: "string", description: "path to the .ipynb file" },
      cell_number: { type: "integer", description: "0-based index of the cell" },
      new_source: { type: "string", description: "new cell content" },
      cell_type: { type: "string", description: "code | markdown (needed for insert)" },
      edit_mode: { type: "string", description: "replace | insert | delete" },
    }, required: ["notebook_path", "new_source"] },
  },
};

export const BUILTIN_TOOL_NAMES = Object.keys(S);
export const isBuiltinTool = (name) => Object.prototype.hasOwnProperty.call(S, name);

// Tool definitions (for the tool schema passed to the model).
export function builtinToolDefs() {
  return BUILTIN_TOOL_NAMES.map((name) => ({ name, description: S[name].description, inputSchema: S[name].inputSchema }));
}

// ── Execution ───────────────────────────────────────────────────────────────────
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

// PDF text without a third-party library: unpack FlateDecode streams and collect the text operators (Tj/TJ).
// Deliberately best effort — for scanned (pure image) PDFs it stays empty, and the caller says so. Enough for manuals,
// contracts, exports; layout is lost.
function pdfToText(buf) {
  const out = [];
  const unescape = (s) => s
    .replace(/\\([nrtbf])/g, (m, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[c]))
    .replace(/\\([0-7]{1,3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, "$1");
  const harvest = (chunk) => {
    // (…) Tj  |  [ (…) -250 (…) ] TJ
    for (const m of chunk.matchAll(/\((?:\\.|[^\\()])*\)/g)) out.push(unescape(m[0].slice(1, -1)));
  };
  let i = 0;
  for (;;) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    let dataStart = s + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const e = buf.indexOf("endstream", dataStart);
    if (e < 0) break;
    const raw = buf.slice(dataStart, e);
    let text = "";
    try { text = zlib.inflateSync(raw).toString("latin1"); }
    catch { text = raw.toString("latin1"); } // uncompressed or another filter
    if (/\bTJ\b|\bTj\b/.test(text)) harvest(text);
    i = e + 9;
  }
  return out.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

// Make .ipynb readable: cells with index, type, source and (capped) output.
function notebookToText(json) {
  const nb = JSON.parse(json);
  if (!Array.isArray(nb.cells)) throw new Error("Not a valid .ipynb (cells is missing)");
  const src = (s) => (Array.isArray(s) ? s.join("") : String(s ?? ""));
  const lines = [];
  nb.cells.forEach((cell, idx) => {
    lines.push(`# ── Cell ${idx} (${cell.cell_type || "code"}) ──`);
    lines.push(src(cell.source));
    for (const o of cell.outputs || []) {
      const text = o.text ? src(o.text)
        : o.data?.["text/plain"] ? src(o.data["text/plain"])
        : o.ename ? `${o.ename}: ${o.evalue}`
        : o.data?.["image/png"] ? "[image output]" : "";
      if (text) lines.push(`# Output:\n${String(text).slice(0, MAX_NOTEBOOK_OUTPUT)}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

// → string OR block array. Images come back as an image block; the engine folds them to text if the provider cannot
// take images (caps.vision) — Claude Code's `Read` behaves the same.
async function readFileTool(a, ctx) {
  const area = areaOf(ctx);
  const abs = resolveInSandbox(a.file_path, ctx, area);
  const copy = overCopy(abs, ctx);
  // → { raw, size }. In the copy the container reads and sends at most `maxBytes` bytes over the line: above that
  // `raw` is null and `size` the true size — the message "too large" reads there as in the backend.
  // With an area and an explicit cap (image, text, PDF) the backend checks the size at the descriptor BEFORE reading —
  // otherwise it would read a sparse file of gigabytes in full only to report "too large" afterwards. The message is
  // the same (`size` the true size).
  const read = async (maxBytes) => {
    if (!copy) {
      if (area && maxBytes !== undefined) {
        try { const raw = readInArea(abs, area, undefined, { maxBytes }); return { raw, size: raw.length }; } catch (e) {
          if (e?.code === "ETOOLARGE") return { raw: null, size: e.size };
          // A folder reports as in the copy (below) and as readFileSync does — a FIFO or a device as "not a regular file".
          if (e?.code === "ENOFILE" && targetInArea(abs, area)?.isDirectory()) throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" });
          throw e;
        }
      }
      const raw = area ? readInArea(abs, area) : fs.readFileSync(abs); return { raw, size: raw.length };
    }
    const r = await access.read(ctx.instance, abs, { maxBytes: maxBytes ?? access.READ_MAX });
    if (r.kind === "folder") throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" });
    if (r.kind !== "file") throw new Error(`Not a regular file: ${abs}`);
    return { raw: r.tooBig ? null : r.data, size: r.size };
  };
  const ext = path.extname(abs).toLowerCase();

  if (IMAGE_MIME[ext]) {
    const { raw, size } = await read(MAX_IMAGE_BYTES);
    if (size > MAX_IMAGE_BYTES) return `Image too large (${size} bytes, limit ${MAX_IMAGE_BYTES}). Shrink it first.`;
    return [
      { type: "text", text: `Image: ${abs} (${IMAGE_MIME[ext]}, ${raw.length} bytes)` },
      { type: "image", source: { type: "base64", media_type: IMAGE_MIME[ext], data: raw.toString("base64") } },
    ];
  }

  // PDF: text extract AND the file itself as a document block.
  //
  // With the extract alone a diagram, a table grid or a scan would be invisible to every provider except the Claude
  // CLI. The extract stays: it is cheap, searchable and carries the tool's line-number expectation. The block
  // SUPPLEMENTS it.
  //
  // What the provider can take of it is decided not here but by `resultContentFor` in engine.js — the same division
  // of labour as for the image from a screenshot: the tool delivers richly, the engine folds to what the connector can.
  if (ext === ".pdf") {
    const { raw, size } = await read(access.READ_MAX);
    if (!raw) throw new Error(`File too large (${size} bytes)`); // above READ_MAX (in the copy the line, in the backend the descriptor)
    const text = pdfToText(raw.toString("latin1"));
    const header = text ? clip(`PDF: ${abs}\n\n${text}`) : `PDF without extractable text: ${abs} (presumably scanned or pure image pages).`;
    const pages = pdfPageCount(raw);
    // Cap as in the extraction: per page a PDF costs text AND image. `0` means UNKNOWN (object streams hide the page
    // tree), then the size alone decides.
    if (raw.length > MAX_PDF_BYTES || pages > MAX_PDF_PAGES) {
      return typeof header === "string"
        ? `${header}\n\n[The pages themselves are not sent along: ${pages > MAX_PDF_PAGES ? `${pages} pages` : "too large"}. So you do NOT see figures and diagrams.]`
        : header;
    }
    return [
      { type: "text", text: typeof header === "string" ? header : String(header) },
      { type: "document", name: path.basename(abs), source: { type: "base64", media_type: "application/pdf", data: raw.toString("base64") } },
    ];
  }

  const { raw, size } = await read(MAX_READ_BYTES);
  if (size > MAX_READ_BYTES) throw new Error(`File too large (${size} bytes)`);
  const text = ext === ".ipynb" ? notebookToText(raw.toString("utf8")) : raw.toString("utf8");
  const lines = text.split("\n");
  // A trailing line break ends the last line, it does not begin a new one: "line one\n" would read as two lines, the
  // second empty — a phantom line a model takes for content (and repeats in Edit).
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(1, a.offset || 1);
  const end = a.limit ? Math.min(lines.length, start - 1 + a.limit) : lines.length;
  const out = [];
  for (let i = start; i <= end; i++) out.push(`${String(i).padStart(6)}\t${lines[i - 1] ?? ""}`);
  return clip(out.join("\n"));
}
async function writeFileTool(a, ctx) {
  const area = areaOf(ctx);
  const abs = resolveInSandbox(a.file_path, ctx, area);
  if (overCopy(abs, ctx)) await access.write(ctx.instance, abs, Buffer.from(String(a.content ?? ""))); // in the copy's container
  else if (area) writeInArea(abs, String(a.content ?? ""), area);
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(a.content ?? ""));
  }
  return `File written: ${abs} (${Buffer.byteLength(String(a.content ?? ""))} bytes)`;
}
function applyEdit(text, { old_string, new_string, replace_all }) {
  if (old_string === "") throw new Error("old_string must not be empty");
  if (replace_all) {
    if (!text.includes(old_string)) throw new Error("old_string not found");
    return text.split(old_string).join(new_string);
  }
  const first = text.indexOf(old_string);
  if (first < 0) throw new Error("old_string not found");
  if (text.indexOf(old_string, first + old_string.length) >= 0) throw new Error("old_string is not unique — use replace_all or give more context");
  return text.slice(0, first) + new_string + text.slice(first + old_string.length);
}
async function editTool(a, ctx) {
  const area = areaOf(ctx);
  const abs = resolveInSandbox(a.file_path, ctx, area);
  // In the copy: read, change and write back with a comparison (conflict instead of silent overwriting).
  if (overCopy(abs, ctx)) { await access.edit(ctx.instance, abs, (text) => applyEdit(text, a)); return `File edited: ${abs}`; }
  if (area) { editInArea(abs, area, (text) => applyEdit(text, a)); return `File edited: ${abs}`; }
  const text = fs.readFileSync(abs, "utf8");
  const next = applyEdit(text, a);
  fs.writeFileSync(abs, next);
  return `File edited: ${abs}`;
}
async function multiEditTool(a, ctx) {
  const area = areaOf(ctx);
  const abs = resolveInSandbox(a.file_path, ctx, area);
  const all = (text) => { for (const e of a.edits || []) text = applyEdit(text, e); return text; };
  if (overCopy(abs, ctx)) await access.edit(ctx.instance, abs, all);
  else if (area) editInArea(abs, area, all);
  else fs.writeFileSync(abs, all(fs.readFileSync(abs, "utf8")));
  return `File edited (${(a.edits || []).length} changes): ${abs}`;
}
// The stat of the target opened checked (Glob, Grep) — `null` if it is not there ("No matches."); a place outside
// throws.
function targetInArea(p, area) {
  try { return statInArea(p, area); } catch (e) { if (e?.code === "EOUTSIDE") throw e; return null; }
}
// The output of Glob: the paths (already capped to MAX_GLOB_HITS), `total` = all hits.
function globOutput(list, total) {
  if (!list.length) return "No matches.";
  return clip(list.join("\n") + (total > MAX_GLOB_HITS ? `\n… (${total - MAX_GLOB_HITS} more)` : ""));
}
async function globTool(a, ctx) {
  const area = areaOf(ctx);
  const root = a.path ? resolveInSandbox(a.path, ctx, area) : path.resolve(ctx.cwd);
  if (overCopy(root, ctx)) { // the tree walk in the copy's container — only the hits come back
    const r = await access.glob(ctx.instance, root, { pattern: a.pattern, skip: [...SKIP_DIRS], maxFiles: MAX_WALK_FILES, maxHits: MAX_GLOB_HITS });
    return globOutput(r.hits.map((h) => h.p), r.total);
  }
  // With an area the start folder is opened checked — also the cwd (a root that became a link does not count).
  if (area && !targetInArea(root, area)?.isDirectory()) return "No matches.";
  const re = globToRegExp(a.pattern);
  const hits = [];
  walkFiles(root, { area, onFile: (p) => {
    const rel = path.relative(root, p);
    if (re.test(rel) || re.test(p) || re.test(path.basename(p))) {
      try { hits.push({ p, m: (area ? fs.lstatSync(p) : fs.statSync(p)).mtimeMs }); } catch { hits.push({ p, m: 0 }); }
    }
  } });
  hits.sort((x, y) => y.m - x.m);
  return globOutput(hits.slice(0, MAX_GLOB_HITS).map((h) => h.p), hits.length);
}
// ── Regular expressions of the model ─────────────────────────────────────────────────────────────────────────────────────
// Grep and the BashOutput filter execute a RegExp the MODEL writes — synchronously in the backend. A pattern with
// catastrophic backtracking (`(a+)+$` against a long line) would hold the backend's event loop until the gateway
// replaces the container. So the matching runs in a vm context with a deadline (V8 also interrupts a running RegExp),
// spread over all files; when it is over, the call fails with a wording that says it was a deadline. Only the time IN
// the context counts — not reading the files in between: an ordinary pattern over a large tree is slow because the
// tree is large, not because the pattern is. The cost: one entry into the context per file, not per line.
//
// The deadline applies per TOOL ROUND, not per call: the calls of a round run in the backend one after another without
// returning to the event loop (only microtasks), and N Grep calls with a backtracking pattern would hold it for
// N × deadline in a row. So the engine creates ONE budget per round (`newRegexDeadline`, in the call's context as
// `regexDeadline`) that Grep and the BashOutput filter share; when it is used up, every further call of the round
// fails WITHOUT entering the context. Without a budget in the context (a call outside the engine) every call has its own.
const regexDeadline = () => Number(process.env.CBASE_REGEX_DEADLINE_MS) || 5_000;
const regexContext = vm.createContext({ input: null });
const REGEX_ROWS = new vm.Script(`(() => {
  const e = input;
  const hits = [];
  if (e.multiline) {
    const re = e.re;
    const content = e.content;
    re.lastIndex = 0;
    for (let m; (m = re.exec(content)) !== null;) {
      const startLine = content.slice(0, m.index).split("\\n").length;
      const endLine = startLine + (m[0].split("\\n").length - 1);
      for (let l = startLine; l <= endLine; l++) hits.push(l);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  } else {
    const rows = e.rows;
    for (let i = 0; i < rows.length; i++) { e.re.lastIndex = 0; if (e.re.test(rows[i])) hits.push(i + 1); }
  }
  return hits;
})()`, { filename: "cbase-regex-deadline" });
const regexToExpensive = (ms) => new Error(`The regular expression exceeded the deadline of ${ms} ms (endless backtracking?) — aborted. Use a simpler pattern or narrow the search area.`);
// The round's budget was already used up before this call (an earlier expression of the same round): this one did not run.
const regexDeadlinePast = (ms) => new Error(`The deadline of ${ms} ms for regular expressions of this tool round is already exceeded — this expression did not run. Use a simpler pattern or narrow the search area.`);
/** A budget for one tool round (or, without the engine, one call): `ms` of time in the context, across all files and calls together. */
export const newRegexDeadline = () => ({ ms: regexDeadline(), consumed: 0, past: false });
/** → the line numbers (1-based) with a match — `multiline` over the whole content, otherwise per line. Throws after the deadline. */
function regexRows({ re, content = "", rows = [], multiline = false }, deadline) {
  const rest = deadline.ms - deadline.consumed;
  if (deadline.past || rest <= 0) { deadline.past = true; throw regexDeadlinePast(deadline.ms); }
  regexContext.input = { re, content, rows, multiline };
  const start = performance.now();
  try { return [...REGEX_ROWS.runInContext(regexContext, { timeout: Math.max(1, Math.ceil(rest)) })]; }
  catch (e) {
    // Aborted means the budget is used up — even if the clock measures a few fractions below.
    if (e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") { deadline.past = true; throw regexToExpensive(deadline.ms); }
    throw e;
  }
  finally {
    deadline.consumed += performance.now() - start;
    regexContext.input = null;
  }
}

// File types as with ripgrep --type (the most common ones; everything else goes via glob).
const GREP_TYPES = {
  js: ["js", "jsx", "mjs", "cjs"], ts: ["ts", "tsx", "mts", "cts"], py: ["py", "pyi"],
  go: ["go"], rs: ["rs"], java: ["java"], c: ["c", "h"], cpp: ["cpp", "cc", "hpp", "hh", "cxx"],
  cs: ["cs"], rb: ["rb"], php: ["php"], swift: ["swift"], kt: ["kt", "kts"], sh: ["sh", "bash", "zsh"],
  md: ["md", "markdown"], json: ["json"], yaml: ["yaml", "yml"], toml: ["toml"], sql: ["sql"],
  html: ["html", "htm"], css: ["css", "scss", "less"], xml: ["xml"], vue: ["vue"], svelte: ["svelte"],
};

async function grepTool(a, ctx) {
  const area = areaOf(ctx);
  const target = a.path ? resolveInSandbox(a.path, ctx, area) : path.resolve(ctx.cwd);
  const copy = overCopy(target, ctx); // then the tree walk goes through the copy's container (below), the backend touches nothing
  // With an area: the target opened checked (a place outside throws), every file read through a checked descriptor.
  const singleFile = copy ? false : area ? Boolean(targetInArea(target, area)?.isFile()) : (() => { try { return fs.statSync(target).isFile(); } catch { return false; } })();
  // With an area at most READ_MAX per file: a larger one is skipped (ETOOLARGE) — and the output says how many;
  // without an area unlimited.
  const read = area ? (p) => readInArea(p, area, undefined, { maxBytes: access.READ_MAX }) : (p) => fs.readFileSync(p);
  let tooBig = 0;
  const root = singleFile ? path.dirname(target) : target;
  const ci = a.case_insensitive || a["-i"]; // "-i" etc.: the names of Claude Code's Grep, see schema
  const multiline = Boolean(a.multiline);
  let re;
  // Multiline: `s` lets `.` also match line breaks, `m` anchors ^/$ per line — together exactly the behaviour of
  // `rg -U --multiline-dotall`.
  try { re = new RegExp(a.pattern, `${ci ? "i" : ""}${multiline ? "sm" : ""}g`); }
  catch (e) { throw new Error(`Invalid RegExp: ${e.message}`); }
  const includeRe = a.glob ? globToRegExp(a.glob) : null;
  const typeExts = a.type ? GREP_TYPES[String(a.type).toLowerCase()] : null;
  const mode = ["content", "files_with_matches", "count"].includes(a.output_mode) ? a.output_mode : "content";
  const showLineNo = (a.line_numbers ?? a["-n"]) !== false;
  const ctxAfter = Math.max(0, Number(a.after_context ?? a["-A"] ?? a.context ?? a["-C"]) || 0);
  const ctxBefore = Math.max(0, Number(a.before_context ?? a["-B"] ?? a.context ?? a["-C"]) || 0);

  const perFile = [];      // { file, count, lines: [] }
  let total = 0;
  let truncated = false;
  const deadline = ctx.regexDeadline || newRegexDeadline(); // ONE budget for all files — and all calls of the tool round

  const scan = (p) => {
    if (truncated) return;
    const rel = path.relative(root, p);
    if (typeExts && !typeExts.includes(path.extname(p).slice(1).toLowerCase())) return;
    if (includeRe && !(includeRe.test(rel) || includeRe.test(path.basename(p)))) return;
    let content;
    try { const raw = read(p); if (raw.includes(0)) return; content = raw.toString("utf8"); } catch (e) { if (e?.code === "ETOOLARGE") tooBig++; return; }
    const lines = content.split("\n");
    // Multiline: the line number from the character offset, ALL spanned lines marked, empty matches not repeated
    // endlessly; otherwise per line — both in the context with a deadline (see regexRows).
    const hitLines = new Set(regexRows({ re, content, rows: lines, multiline }, deadline));
    if (!hitLines.size) return;
    const entry = { file: p, count: hitLines.size, lines: [] };
    if (mode === "content") {
      const show = new Set();
      for (const l of hitLines) for (let k = l - ctxBefore; k <= l + ctxAfter; k++) if (k >= 1 && k <= lines.length) show.add(k);
      let prev = 0;
      for (const l of [...show].sort((x, y) => x - y)) {
        if (prev && l > prev + 1) entry.lines.push("--");
        const sep = hitLines.has(l) ? ":" : "-";
        entry.lines.push(showLineNo ? `${p}${sep}${l}${sep}${lines[l - 1].slice(0, 300)}` : `${p}${sep}${lines[l - 1].slice(0, 300)}`);
        prev = l;
      }
    }
    perFile.push(entry);
    total += hitLines.size;
    if (total >= MAX_GREP_MATCHES) truncated = true;
  };

  if (copy) {
    // The same rules in the container (runtime/fileAccess.js); the hits come back with finished lines.
    const r = await access.grep(ctx.instance, target, {
      pattern: a.pattern, ci: Boolean(ci), multiline, glob: a.glob || null, exts: typeExts || null, mode, numbers: showLineNo,
      prior: ctxBefore, after: ctxAfter, maxHits: MAX_GREP_MATCHES, skip: [...SKIP_DIRS], maxFiles: MAX_WALK_FILES,
    });
    if (r.error) throw new Error(r.error);
    perFile.push(...r.proFile);
    truncated = r.cutOff;
  } else if (singleFile) scan(target);
  else walkFiles(root, { onFile: scan, area });

  // The cap says that it is one: skipped files are in the output (only possible with an area).
  const skipped = tooBig ? `\n… (${tooBig} ${tooBig === 1 ? "file" : "files"} over ${access.READ_MAX} bytes not searched)` : "";
  if (!perFile.length) return `No matches.${skipped}`;
  let out;
  if (mode === "files_with_matches") out = perFile.map((f) => f.file);
  else if (mode === "count") out = perFile.map((f) => `${f.file}:${f.count}`);
  else out = perFile.flatMap((f) => f.lines);
  if (a.head_limit > 0) out = out.slice(0, a.head_limit);
  return clip(out.join("\n") + (truncated ? `\n… (cut off at ${MAX_GREP_MATCHES} matches)` : "") + skipped);
}
const shellBin = () => (process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/bash");

// ── Process groups ────────────────────────────────────────────────────────────────────────────────────────────────────────
// If deadline, abort, KillShell and the clean-up at the run end hit only the SHELL, a grandchild (`npm run dev &`,
// `sleep 99 &`, a test run with children of its own) lives on: as an orphan, and — if it holds stdout — with a `close`
// that never comes. So every shell runs in a process group OF ITS OWN (`detached`), the group is ended, and a deadline
// resolves AT ONCE — waiting for `close` would mean waiting for a pipe a grandchild outside the group can keep open.
// The same pattern as monitor-runtime.js killProcessTree. In the project container the `kill` of the child from
// inProject ends the group in the container itself — `-pid` would only hit the docker child in the backend there.
const OWN_GROUP = process.platform !== "win32";
export function endGroup(child, signal = "SIGKILL") {
  if (!child) return;
  if (child.inProject) { try { child.kill(signal); } catch { /* already gone */ } return; }
  if (OWN_GROUP && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* group already gone — then the child alone */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

// Registry of the shells running in the background (survives single runs in the same process, like Claude Code's
// background Bash beyond a turn). id → { child, buf, readOffset, ... }.
const bgShells = new Map();

function bashTool(a, ctx) {
  // Detaching is rejected at the call (mcp/detach-rule.js) — the branch `run_in_background` below is thus no longer
  // reachable from a model call. `ctx.detachAllowed` is the test seam of this branch (tool-runtime.test.js) — the
  // engine never sets it.
  const refusal = ctx.detachAllowed === true ? null : detachReason(a);
  if (refusal) return Promise.resolve({ content: refusal.text, isError: true });
  const command = String(a.command || "");
  const shell = shellBin();
  if (a.run_in_background) {
    const id = "bash_" + crypto.randomUUID().slice(0, 8);
    // The agent's shell carries the LFS environment (runs/lfs-environment.js) — foreground and background.
    const child = inProject(ctx.instance || null, shell, ["-c", command], withLfsEnvironment(ctx.instance || null, { cwd: ctx.cwd, env: ctx.env || process.env, detached: OWN_GROUP }));
    const rec = { child, buf: "", readOffset: 0, done: false, exitCode: null, command, startedAt: Date.now(), runId: ctx.runId ?? null };
    const append = (d) => { rec.buf += d; if (rec.buf.length > MAX_OUTPUT * 4) { const drop = rec.buf.length - MAX_OUTPUT * 4; rec.buf = rec.buf.slice(drop); rec.readOffset = Math.max(0, rec.readOffset - drop); } };
    // Report the lifecycle. Without these notices only the Claude CLI would know that something runs in the
    // background: an engine run would end as soon as the model has nothing more to say — in the middle of a command
    // still running whose output nobody reads any more.
    const notify = typeof ctx.onBackgroundShell === "function" ? ctx.onBackgroundShell : null;
    child.stdout.on("data", (d) => append(d.toString()));
    child.stderr.on("data", (d) => append(d.toString()));
    child.on("error", (e) => { append(`\n[Shell error: ${e.message}]`); rec.done = true; notify?.({ event: "exited", id, exitCode: 1, command }); });
    child.on("close", (code) => {
      rec.done = true; rec.exitCode = code;
      notify?.({ event: "exited", id, exitCode: code, command, tail: rec.buf.slice(-4000) });
    });
    bgShells.set(id, rec);
    notify?.({ event: "started", id, command, toolUseId: ctx.toolUseId || null });
    return Promise.resolve({ content: `Started in the background (bash_id: ${id}). Retrieve output with BashOutput(bash_id: "${id}"), end with KillShell. You are notified automatically at the end — do not poll and do not sleep.`, isError: false });
  }
  // "Save computing power": only the engine of a background agent with the switch on carries `ctx.saver`. Then the
  // command waits before the start while the CPU is overloaded (at most 120 s, mcp/cpu-saver.js), reports that via
  // `ctx.onCpuWait` (the engine turns it into the same event as the CLI's hook) and runs under `nice -n 10`. Without
  // the mark it is exactly the plain start.
  const saver = ctx.saver === true;
  const foreground = () => new Promise((resolve) => {
    const timeoutMs = Math.min(Math.max(a.timeout || 120_000, 1000), 600_000);
    const [program, argv] = withNice(shell, ["-c", command], saver);
    const child = inProject(ctx.instance || null, program, argv, withLfsEnvironment(ctx.instance || null, { cwd: ctx.cwd, env: ctx.env || process.env, detached: OWN_GROUP }));
    let out = "";
    let settled = false;
    const signal = ctx.signal;
    const finish = (r) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    // A run abort (controller.abort) also ends the running foreground process at once — including its group.
    const onAbort = () => { endGroup(child); finish({ content: "Aborted.", isError: true }); };
    // The deadline: end the group and resolve AT ONCE, with what came until then — do not wait for `close`.
    const timer = setTimeout(() => {
      endGroup(child);
      const text = clip(out.trim() || "(no Output)");
      finish({ content: `${text}\n[Deadline of ${timeoutMs} ms expired — command ended including its process group]`, isError: true });
    }, timeoutMs);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort); }
    child.stdout.on("data", (d) => { out += d; if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT * 2); });
    child.stderr.on("data", (d) => { out += d; if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT * 2); });
    child.on("error", (e) => { finish({ content: `Shell error: ${e.message}`, isError: true }); });
    child.on("close", (code) => {
      const text = clip(out.trim() || "(no Output)");
      finish({ content: code === 0 ? text : `${text}\n[Exit code ${code}]`, isError: code !== 0 });
    });
  });
  if (!saver) return foreground();
  const report = (enabled, text) => { try { ctx.onCpuWait?.({ enabled, text }); } catch { /* the display must never topple the command */ } };
  return waitForCpu({ signal: ctx.signal, atBegin: (state) => report(true, waitText(state)) }).then((r) => {
    if (r.waitedMs) report(false, endText(r));
    if (r.reason === "aborted") return { content: "Aborted.", isError: true };
    return foreground();
  });
}
function bashOutputTool(a, ctx) {
  const rec = bgShells.get(a.bash_id);
  if (!rec) return { content: `Unknown bash_id: ${a.bash_id}`, isError: true };
  let chunk = rec.buf.slice(rec.readOffset);
  if (a.filter) {
    let re;
    try { re = new RegExp(a.filter); } catch (e) { return { content: `Invalid filter RegExp: ${e.message}`, isError: true }; }
    // With a deadline (see regexRows) — the tool round's budget if the engine passes one; if the filter fails, the
    // output stays unread — the next retrieval gets it.
    const rows = chunk.split("\n");
    try { chunk = regexRows({ re, rows }, ctx?.regexDeadline || newRegexDeadline()).map((n) => rows[n - 1]).join("\n"); }
    catch (e) { return { content: `filter: ${e.message}`, isError: true }; }
  }
  rec.readOffset = rec.buf.length;
  const status = rec.done ? `ended (exit code ${rec.exitCode})` : "running";
  const body = chunk.trim() || "(no fresh Output)";
  return { content: `[Status: ${status}]\n${clip(body)}`, isError: false };
}
function killShellTool(a) {
  const rec = bgShells.get(a.shell_id);
  if (!rec) return { content: `Unknown shell_id: ${a.shell_id}`, isError: true };
  if (rec.done) return { content: `Shell ${a.shell_id} had already ended.`, isError: false };
  endGroup(rec.child); // including grandchildren
  rec.done = true;
  return { content: `Shell ${a.shell_id} ended.`, isError: false };
}
// Callable by the engine at the run end: end orphaned background shells (leak nothing).
// runId != null → ONLY the shells of this run (bgShells is shared process-wide; other concurrent runs must not be
// hit). Without runId → all (e.g. process shutdown).
export function killBackgroundShells(runId) {
  for (const [id, rec] of [...bgShells]) {
    if (runId != null && rec.runId !== runId) continue;
    if (!rec.done) endGroup(rec.child); // including grandchildren
    bgShells.delete(id);
  }
}
export function killAllBackgroundShells() { killBackgroundShells(); }

// ── Network tools (WebFetch/WebSearch) ──────────────────────────────────────────
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
    if (named[e] != null) return named[e];
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return named[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  body = decodeEntities(body).replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  return { title: decodeEntities(title).trim(), body };
}
// Read the body of a response, at most `max` bytes: after that the stream is cancelled, not read to the end.
async function bodyUntilCap(res, max) {
  if (!res.body || typeof res.body.getReader !== "function") return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      n += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(parts).subarray(0, max);
}
// `instance`: a fetch FOR an instance goes through runtime/target.js — localhost lands in its container, every
// redirect is mapped anew. Without one a plain fetch.
async function fetchText(url, { timeoutMs = 30_000, headers = {}, signal, instance = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener("abort", onAbort); }
  try {
    // Browser-like user agent: many pages (among them the search endpoints) serve bots an empty/different page.
    const init = { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8", ...headers } };
    const res = await (instance ? requestInProject(url, { ...init, maxBytes: MAX_WEB_BYTES }, instance) : fetch(url, init));
    // Without an instance the backend reads the body only up to the cap as well (`arrayBuffer()` would fetch the WHOLE
    // response into memory only to keep 2 MB afterwards). With an instance requestInProject already caps.
    const buf = instance ? Buffer.from(await res.arrayBuffer()) : await bodyUntilCap(res, MAX_WEB_BYTES);
    const raw = buf.slice(0, MAX_WEB_BYTES).toString("utf8");
    return { ok: res.ok, status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") || "", raw };
  } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); }
}
// 15-minute cache as in Claude Code: the same agent often fetches the same page several times in one research
// (intermediate steps, questions). Process-wide, capped small.
const WEB_CACHE_TTL = 15 * 60_000;
const WEB_CACHE_MAX = 40;
const webCache = new Map(); // url → { at, content }

async function webFetchTool(a, ctx) {
  let url = String(a.url || "").trim();
  if (!url) return { content: "url is missing", isError: true };
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  // With an instance "localhost" is ITS container: the cache separates by instance, otherwise a project would get the
  // page of another (or the backend's) from memory. Without an instance the key is the URL.
  const instance = ctx?.instance || null;
  const key = instance ? `${instance.identifier || instance.projectId}\n${url}` : url;
  const hit = webCache.get(key);
  if (hit && Date.now() - hit.at < WEB_CACHE_TTL) {
    const age = Math.round((Date.now() - hit.at) / 1000);
    return { content: `${hit.content}\n\n[from the cache, ${age} s old]`, isError: false };
  }
  let r;
  try { r = await fetchText(url, { signal: ctx?.signal, instance }); }
  catch (e) { return { content: `Fetch failed: ${e?.message || e}`, isError: true }; }
  if (!r.ok) return { content: `HTTP ${r.status} at ${r.finalUrl || url}`, isError: true };
  const isHtml = /html/i.test(r.contentType) || /^\s*</.test(r.raw);
  const { title, body } = isHtml ? htmlToText(r.raw) : { title: "", body: r.raw };
  const head = [`URL: ${r.finalUrl || url}`, title && `Title: ${title}`, a.prompt && `Looking for: ${a.prompt}`].filter(Boolean).join("\n");
  const text = body.slice(0, MAX_WEB_TEXT) + (body.length > MAX_WEB_TEXT ? `\n… [${body.length - MAX_WEB_TEXT} characters truncated]` : "");
  const content = `${head}\n\n${text}`;
  webCache.set(key, { at: Date.now(), content });
  if (webCache.size > WEB_CACHE_MAX) webCache.delete(webCache.keys().next().value);
  return { content, isError: false };
}

// ── Web search ──────────────────────────────────────────────────────────────────
// DuckDuckGo HTML scraping stays the keyless fallback — but it breaks as soon as DuckDuckGo changes its markup. If a
// real search API is configured in the settings (Brave, Tavily or an own SearxNG instance), that one is used.
// runs/do-run.js passes the configuration via ctx (runs/permissions.js:loadWebSearchConfig).
async function searchBrave(q, cfg, signal) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10`, {
    headers: { Accept: "application/json", "X-Subscription-Token": cfg.apiKey }, signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.web?.results || []).slice(0, 10).map((x) => ({ title: x.title, href: x.url, snippet: htmlToText(String(x.description || "")).body }));
}
async function searchTavily(q, cfg, signal) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ api_key: cfg.apiKey, query: q, max_results: 10 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || []).slice(0, 10).map((x) => ({ title: x.title, href: x.url, snippet: String(x.content || "").slice(0, 300) }));
}
async function searchSearxng(q, cfg, signal) {
  const base = String(cfg.baseUrl || "").replace(/\/$/, "");
  const res = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json`, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || []).slice(0, 10).map((x) => ({ title: x.title, href: x.url, snippet: String(x.content || "").slice(0, 300) }));
}
async function searchDuckDuckGo(q, signal) {
  const r = await fetchText("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), { timeoutMs: 20_000, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(r.raw)) && results.length < 10) {
    let href = decodeEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/); if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
    const title = htmlToText(m[2]).body;
    if (title && /^https?:/i.test(href)) results.push({ title, href, snippet: "" });
  }
  return results;
}

async function webSearchTool(a, ctx) {
  const q = String(a.query || "").trim();
  if (!q) return { content: "query is missing", isError: true };
  const cfg = ctx?.webSearch || {};
  const signal = ctx?.signal;
  const named = cfg.provider && cfg.provider !== "duckduckgo"
    && (cfg.provider === "searxng" ? cfg.baseUrl : cfg.apiKey);
  let results = [];
  let source = "DuckDuckGo";
  try {
    if (named && cfg.provider === "brave") { results = await searchBrave(q, cfg, signal); source = "Brave"; }
    else if (named && cfg.provider === "tavily") { results = await searchTavily(q, cfg, signal); source = "Tavily"; }
    else if (named && cfg.provider === "searxng") { results = await searchSearxng(q, cfg, signal); source = "SearxNG"; }
    else results = await searchDuckDuckGo(q, signal);
  } catch (e) {
    // A failed API must not end the research — the keyless way stays.
    if (named) {
      try { results = await searchDuckDuckGo(q, signal); source = "DuckDuckGo (fallback)"; }
      catch (e2) { return { content: `Search failed (${cfg.provider}: ${e?.message || e}; fallback: ${e2?.message || e2}).`, isError: true }; }
    } else return { content: `Search failed: ${e?.message || e}`, isError: true };
  }
  if (!results.length) return { content: `No search results for "${q}" (source: ${source}).`, isError: false };
  const body = results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.href}${x.snippet ? `\n   ${x.snippet}` : ""}`).join("\n");
  return { content: `Source: ${source}\n${body}`, isError: false };
}
function todoWriteTool(a) {
  const todos = Array.isArray(a.todos) ? a.todos : [];
  return `${todos.length} tasks updated.`;
}
async function notebookEditTool(a, ctx) {
  const area = areaOf(ctx);
  const abs = resolveInSandbox(a.notebook_path, ctx, area);
  if (overCopy(abs, ctx)) { // in the copy's container, with a comparison
    let idx = 0; let mode = "";
    await access.edit(ctx.instance, abs, (text) => { const r = notebookChange(JSON.parse(text), a); idx = r.idx; mode = r.mode; return JSON.stringify(r.nb, null, 1); });
    return `Notebook edited (${mode}, cell ${idx}): ${abs}`;
  }
  if (area) {
    let idx = 0; let mode = "";
    editInArea(abs, area, (text) => { const r = notebookChange(JSON.parse(text), a); idx = r.idx; mode = r.mode; return JSON.stringify(r.nb, null, 1); });
    return `Notebook edited (${mode}, cell ${idx}): ${abs}`;
  }
  const { nb, idx, mode } = notebookChange(JSON.parse(fs.readFileSync(abs, "utf8")), a);
  fs.writeFileSync(abs, JSON.stringify(nb, null, 1));
  return `Notebook edited (${mode}, cell ${idx}): ${abs}`;
}
function notebookChange(nb, a) {
  if (!Array.isArray(nb.cells)) throw new Error("Not a valid .ipynb (cells is missing)");
  const mode = a.edit_mode || "replace";
  const src = String(a.new_source ?? "").split(/(?<=\n)/); // keep lines with \n (nbformat convention)
  const idx = Number.isInteger(a.cell_number) ? a.cell_number : (mode === "insert" ? nb.cells.length - 1 : 0);
  if (mode === "delete") {
    if (idx < 0 || idx >= nb.cells.length) throw new Error(`cell_number ${idx} out of range`);
    nb.cells.splice(idx, 1);
  } else if (mode === "insert") {
    const cell = { cell_type: a.cell_type || "code", metadata: {}, source: src };
    if (cell.cell_type === "code") { cell.outputs = []; cell.execution_count = null; }
    nb.cells.splice(idx + 1, 0, cell);
  } else { // replace
    if (idx < 0 || idx >= nb.cells.length) throw new Error(`cell_number ${idx} out of range`);
    nb.cells[idx].source = src;
    if (a.cell_type) nb.cells[idx].cell_type = a.cell_type;
    if (nb.cells[idx].cell_type === "code") nb.cells[idx].outputs = [];
  }
  return { nb, idx, mode };
}

/**
 * Executes a built-in tool. → { content:string, isError:boolean }.
 * ctx: { cwd, addDirs, env, instance } — `instance`: Bash in the project container, paths by the real place, WebFetch
 *      on localhost into the instance; null/missing = no instance.
 */
export async function runBuiltinTool(name, args, ctx) {
  const a = args || {};
  // First yield to the event loop: the tools here run largely synchronously in the backend (tree walk, reading,
  // RegExp), and the calls of a round would follow one another as microtasks — gateway probes, SSE and other chats
  // would never get a turn between them. One tick per call (setImmediate, no timer) is the gap; the order of the calls stays.
  await new Promise((further) => setImmediate(further));
  try {
    switch (name) {
      case "Read": return { content: await readFileTool(a, ctx), isError: false };
      case "Write": return { content: await writeFileTool(a, ctx), isError: false };
      case "Edit": return { content: await editTool(a, ctx), isError: false };
      case "MultiEdit": return { content: await multiEditTool(a, ctx), isError: false };
      case "Glob": return { content: await globTool(a, ctx), isError: false };
      case "Grep": return { content: await grepTool(a, ctx), isError: false };
      case "Bash": return await bashTool(a, ctx);
      case "BashOutput": return bashOutputTool(a, ctx);
      case "KillShell": return killShellTool(a);
      case "WebFetch": return await webFetchTool(a, ctx);
      case "WebSearch": return await webSearchTool(a, ctx);
      case "NotebookEdit": return { content: await notebookEditTool(a, ctx), isError: false };
      case "TodoWrite": return { content: todoWriteTool(a), isError: false };
      default: return { content: `Unknown built-in tool: ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `Error (${name}): ${e.message || e}`, isError: true };
  }
}
