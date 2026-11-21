// Reads single files from an app.asar, without dependencies, purely from the format.
//
// Why: "the app starts" is NO proof that the new code is installed (a new binary, new inode and a held port can still
// answer with the old route set). The hash of the file INSIDE the bundle holds the shipped state exactly against the working
// tree instead of trusting timestamps. It reads only the client shell; tree hash and routes below concern the server tree
// (working tree, current/, image, container).
//
// Format: 4 B pickle size (always 4) | 4 B header pickle size | 4 B header string size
//         | 4 B JSON length | JSON | payload from 8 + header pickle size.
import fs from "node:fs";
import crypto from "node:crypto";

export function readAsar(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.readUInt32LE(0) !== 4) throw new Error("not an asar archive (pickle size != 4)");
    const headerPickleSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    return { header: JSON.parse(json.toString("utf8")), baseOffset: 8 + headerPickleSize, file };
  } finally {
    fs.closeSync(fd);
  }
}

function entryOf(header, relPath) {
  let node = header;
  for (const part of relPath.split("/")) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node.size === undefined ? null : node;
}

export function asarRead(archiveOrFile, relPath) {
  const arc = typeof archiveOrFile === "string" ? readAsar(archiveOrFile) : archiveOrFile;
  const entry = entryOf(arc.header, relPath);
  if (!entry) return null;
  if (entry.unpacked) {
    // asarUnpack files lie next to it in app.asar.unpacked/
    const p = `${arc.file}.unpacked/${relPath}`;
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  const buf = Buffer.alloc(entry.size);
  const fd = fs.openSync(arc.file, "r");
  try {
    fs.readSync(fd, buf, 0, entry.size, arc.baseOffset + Number(entry.offset));
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function fileSha(path) {
  return fs.existsSync(path) ? sha256(fs.readFileSync(path)) : null;
}

// Hash of a file INSIDE the bundle, or null if bundle/file is missing.
export function bundleSha(appPath, relPath) {
  const asar = `${appPath}/Contents/Resources/app.asar`;
  if (!fs.existsSync(asar)) return null;
  try {
    const buf = asarRead(asar, relPath);
    return buf ? sha256(buf) : null;
  } catch {
    return null;
  }
}

// ── Tree hash ────────────────────────────────────────────────────────────────────────────────
//
// "server.js" is no longer the server: the code lives in folders under electron/server/. A hash over ONE file would see only
// the facade and report "== Arbeitsbaum" while a feature folder runs something else. So the whole tree is measured: all *.js
// under electron/server recursively, relative paths sorted bytewise (`LC_ALL=C sort`), sha256 over the lines
// `<relpath>\n<sha256(content)>\n`.
//
// The recipe stands EXACTLY ONCE here; the shell version for container, image and current/ is generated from it
// (treeShaShell). Two versions that drift apart would be worse than none: "WEICHT AB" on equal code, or "==" on different.
export const TREE_GLOB = "*.js";

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// All files of the tree as [{ rel, buf }], sorted bytewise by rel.
export function treeFiles(dir) {
  if (!fs.existsSync(dir)) return null;
  const suffix = TREE_GLOB.replace(/^\*/, "");
  const rels = fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((rel) => rel.endsWith(suffix) && fs.statSync(`${dir}/${rel}`).isFile())
    .sort(byteOrder);
  return rels.map((rel) => ({ rel, buf: fs.readFileSync(`${dir}/${rel}`) }));
}

export function treeShaOf(entries) {
  const h = crypto.createHash("sha256");
  for (const e of [...entries].sort((a, b) => byteOrder(a.rel, b.rel))) h.update(`${e.rel}\n${sha256(e.buf)}\n`);
  return h.digest("hex");
}

export function treeSha(dir) {
  const files = treeFiles(dir);
  return files ? treeShaOf(files) : null;
}

// The same computation as a shell line (Linux: sha256sum). Output: the 64 characters of the digest.
export function treeShaShell(dir) {
  return (
    `cd ${dir} && find . -name '${TREE_GLOB}' -type f | LC_ALL=C sort | ` +
    `while read f; do printf '%s\\n%s\\n' "\${f#./}" "$(sha256sum "$f" | cut -c1-64)"; done | sha256sum | cut -c1-64`
  );
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────────
//
// Literal GET routes: `p === "/api/…" && m === "GET"`.
// After a bundle swap this lets us probe a route that did NOT exist before: exactly the case where a seemingly new process
// still runs the old code. GET, because this router checks method and path together and reading routes have no side effects.
//
// The router checks `p` literally only for the top level. Everything below `/api/workspaces/<id>` goes through
// `sub === "/…"`, which is where the server keeps growing. So `sub` routes are collected too and carry the placeholder
// `{ws}`; whoever probes them inserts a real workspace id. Routes with their own parameter (`sub.startsWith(…)`) stay out:
// there is no guessable id, and a 404 could not be told from "route missing".
//
// TWO FORMS, recognised by content:
//  · Monolith: the set contains a server.js with the marker `const wm = p.match(/^\/api\/workspaces\//`.
//    `sub` there is also the variable of the chat and project families, so only the section of the workspace family is
//    searched: from its `p.match` to the next one on the SAME indentation level. If the section is not found, sub routes
//    are left out.
//  · Tree: `p ===` routes from ALL files; `sub ===` routes only from functions
//    `export async function <name>WorkspaceRoutes(` (up to the next `export async function` or end of file). The naming
//    convention is part of the contract: a workspace sub-slice named differently loses its routes for the probe.
// The detection must stand because the OLD bundle can still be a monolith at the swap while the new tree is already split:
// a parser knowing one form only would be blind for the "new route" probe. Self-test in routes.test.mjs.
// The marker is bound to the line start (m flag): a comment quoting the old router ("// the old router was: const wm =
// p.match(…") must not flip the form, else the probe would silently lose all tree routes.
const WS_FAMILY = /^\s*const \w+ = p\.match\(\/\^\\\/api\\\/workspaces\\\//m;
const NEXT_FAMILY = /\n {6}const \w+ = p\.match\(/g;
const P_GET = /p === "(\/api\/[a-z0-9\-/_.]+)"\s*&&\s*m === "GET"/gi;
const SUB_GET = /sub === "(\/[a-z0-9\-/_.]+)"\s*&&\s*m === "GET"/gi;
const WS_FN = /^export async function \w+WorkspaceRoutes\(/gm;
const NEXT_FN = /^export async function /gm;

function toFileSet(source) {
  if (Array.isArray(source)) return source.map((f) => ({ path: String(f.path ?? f.rel ?? ""), text: String(f.text ?? f.buf ?? "") }));
  return [{ path: "server.js", text: typeof source === "string" ? source : String(source) }];
}

export function routesForm(source) {
  const files = toFileSet(source);
  return files.some((f) => /(^|\/)server\.js$/.test(f.path) && WS_FAMILY.test(f.text)) ? "monolith" : "tree";
}

export function getRoutes(source) {
  const files = toFileSet(source);
  const out = new Set();
  if (routesForm(files) === "monolith") {
    const text = files.find((f) => /(^|\/)server\.js$/.test(f.path) && WS_FAMILY.test(f.text)).text;
    for (const m of text.matchAll(P_GET)) out.add(m[1]);
    const start = text.search(WS_FAMILY);
    if (start >= 0) {
      NEXT_FAMILY.lastIndex = start + 1;
      const next = NEXT_FAMILY.exec(text);
      const block = text.slice(start, next ? next.index : text.length);
      for (const m of block.matchAll(SUB_GET)) out.add(`/api/workspaces/{ws}${m[1]}`);
    }
    return out;
  }
  for (const f of files) {
    for (const m of f.text.matchAll(P_GET)) out.add(m[1]);
    for (const fn of f.text.matchAll(WS_FN)) {
      NEXT_FN.lastIndex = fn.index + 1;
      const next = NEXT_FN.exec(f.text);
      const block = f.text.slice(fn.index, next ? next.index : f.text.length);
      for (const m of block.matchAll(SUB_GET)) out.add(`/api/workspaces/{ws}${m[1]}`);
    }
  }
  return out;
}

// The working tree as a file set for getRoutes.
export function treeRoutesInput(dir) {
  return (treeFiles(dir) || []).map((f) => ({ path: f.rel, text: f.buf.toString("utf8") }));
}
