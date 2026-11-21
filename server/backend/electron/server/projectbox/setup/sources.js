// The check of POST `/api/workspaces/:id/projects` in operations. PURE: the body is checked against the rules (./rules.js) BEFORE
// anything arises — an error is 400 with a `code`, and there is neither folder nor project nor row.
//
//   checkCreation(body) → { ok: true, name, sources: [{ seq, kind, target, name, bytes, mapping?, host?, cloneUrl?, cloneBranch? }], codeRepos }
//                       | { ok: false, code, error }
//
// Codes: NAME_MISSING; SOURCES_MISSING (a missing field is no statement; an old client sends only `{ name }` and gets "update the
// app"); PATH_IN_OPS (`path` set — the server assigns the folder); SOURCE_UNKNOWN (a kind this release does not create yet);
// TARGET_INVALID; TARGET_DUPLICATE; MAPPING (the mapping of a ZIP source is missing or unusable); CODE_REPO_LOCATION (the code-repo
// rules or the limits of the repo search); the codes of the clone check (./clone.js checkCloneDetail: ONLY_HTTPS, WITH_USER,
// WITH_QUERY, WITH_FRAGMENT, ZEICHEN, ZWEIG, HOST_UNCLEAR).
//
// ACCEPTED are `files`, `folder`, `zip` and `clone` — SOURCE_KINDS_NOW.
//
// CLONE: `{ kind: "clone", target?, clone: { url, branch? } }`. `clone` is REQUIRED (without it ⇒ ONLY_HTTPS from the check — an
// empty clone would be no statement). `target` = `<place>/<name>` (relative to the root, not empty — a clone is a code repo under its
// name, never the root); if missing (undefined/null), the default is the last part of the address without `.git` in the root (if it
// does not do as a name ⇒ TARGET_INVALID). The target counts like that of a folder source (TARGET_DUPLICATE), and because the clone
// is put in as a WHOLE (one rename, never mixed), no other non-empty target (folder, ZIP, files, another clone) and no `to` of a
// mapping may lie at it or BELOW it (TARGET_DUPLICATE). A clone UNDER a folder target stays allowed (a repo in the uploaded folder) —
// whether something already lies there is known only at placing (the clone comes last, TARGET_OCCUPIED, nothing moved). As a code
// repo the target counts against the code-repo rules and the limits of the repo search with the marks `codeRepos`
// (CODE_REPO_LOCATION). Per source `host` (hostname, lower case — the error line "create access"), `cloneUrl` (normalized, without
// user — the check rejects a user part) and `cloneBranch` go into the row; `bytes` is 0.
//
// ZIP: `{ kind: "zip", target, name, bytes, mapping: [{ from, to | null }] }` — `name` the file name of the archive, `bytes` its size,
// `target` the target path of its top node (may be empty; non-empty it counts like the target of a folder source for
// TARGET_DUPLICATE). `mapping` is REQUIRED (a missing field is no statement — without it the server would not know where the entries
// go), at most MAPPING_CAP entries: `from` an archive path (`/`-separated, without "\", NUL, leading/trailing slash and without an
// empty, "." or ".." part — the clients send the names cleaned, as the SETUP helper reads them; once per mapping, compared in NFC as
// in the SETUP helper) OR exactly `""`, the archive root (a ZIP WITHOUT a top folder sends `{ from: "", to: <target of the top node>
// | null }` plus the explicit entries for moved, renamed and left-out nodes below it — the longest prefix applies; otherwise every
// first path part needed an entry, and a flat archive with more than MAPPING_CAP files could not be created); `to` a path under the
// root per rules.js uploadPath (`.git` and `.cbase-*` only as an inner part — a ZIP without a top folder that is itself a repo maps
// `.git` to `<zipname>/.git`, with `from: ""` by itself) or `null` (leave out); two equal `to` ⇒ TARGET_DUPLICATE. Whether every
// `from` occurs in the archive is checked only by the SETUP helper after the upload (`PLAN_MATCHES_NOT`, ./procedure.js) — the client
// reader is no anchor of trust, and before the upload there is no archive.
import { T } from "../../i18n.js";
import { checkCloneDetail } from "./clone.js";
import { codeRepoError, nameError, relPath, under, uploadPath } from "./rules.js";

export const SOURCE_KINDS_NOW = Object.freeze(["files", "folder", "zip", "clone"]);
export const SOURCES_CAP = 50; // sources per creation — a cap with a message, no content rule
export const MAPPING_CAP = 50_000; // entries of the mapping of ONE ZIP source — a cap with a message

const no = (code, error) => ({ ok: false, code, error });

// An archive path as `from` (header, "ZIP") — the reason why it does not do, or null. checkMapping checks the archive root `""`
// beforehand; here "empty" stays an error, likewise a "." part (the clients send cleaned names).
function ofError(from) {
  if (typeof from !== "string" || !from) return "empty";
  if (from.includes("\0")) return T("contains NUL");
  if (from.includes("\\")) return T("contains a backslash");
  if (from.startsWith("/") || from.endsWith("/")) return T("begins or ends with “/”");
  if (from.split("/").some((t) => t === "" || t === "." || t === "..")) return T("contains an empty, “.” or “..” part");
  return null;
}

// The mapping of a ZIP source (header, "ZIP") → { mapping } | { code, error }.
function checkMapping(seq, mappingRaw) {
  const failed = (code, text) => ({ code, error: T`Source ${seq}: ${text}` });
  if (!Array.isArray(mappingRaw) || !mappingRaw.length) return failed("MAPPING", T("“mapping” is required for a ZIP (a list with at least one entry)."));
  if (mappingRaw.length > MAPPING_CAP) return failed("MAPPING", T`at most ${MAPPING_CAP} entries in the mapping (${mappingRaw.length}).`);
  const mapping = [];
  const ofPresent = new Set();
  const seenTargets = new Set();
  for (const e of mappingRaw) {
    if (!e || typeof e !== "object" || e instanceof Array) return failed("MAPPING", T("an entry of the mapping is not an object."));
    const { from, to } = e;
    const vf = from === "" ? null : ofError(from);
    if (vf) return failed("MAPPING", T`“from” “${String(from ?? "").slice(0, 120)}”: ${vf}.`);
    const key = from.normalize("NFC");
    if (ofPresent.has(key)) return failed("MAPPING", T`“from” “${from.slice(0, 120)}” appears twice in the mapping.`);
    ofPresent.add(key);
    if (to !== null) {
      const r = uploadPath(typeof to === "string" ? to : null);
      if (r.error) return failed("MAPPING", T`“to” for “${from.slice(0, 120)}” is invalid (${r.error}).`);
      if (seenTargets.has(to)) return failed("TARGET_DUPLICATE", T`the target “${to.slice(0, 120)}” appears twice in the mapping.`);
      seenTargets.add(to);
    }
    mapping.push({ from, to });
  }
  return { mapping };
}

export function checkCreation(body) {
  // The fields are read once and under their name at the parameter — so the seam guard (web/test/seams-fields.test.mjs) sees that the
  // server reads what the client sends.
  // `instanceof` instead of `Array.isArray(body)`: passing it on to a foreign function would leave the place open for the guard.
  if (!body || typeof body !== "object" || body instanceof Array) return checkCreation({});
  const { path: pathDetail, name: nameRaw, sources: sourcesRaw, codeRepos: codeReposRaw } = body;
  if (pathDetail !== undefined && String(pathDetail).trim() !== "") {
    return no("PATH_IN_OPS", T("In server mode the server assigns the project folder — send without “path”."));
  }
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name) return no("NAME_MISSING", T("Name required"));
  if (/[\u0000-\u001f\u007f]/.test(name)) return no("NAME_MISSING", T("The name contains a control character."));
  if (!Array.isArray(sourcesRaw)) {
    return no("SOURCES_MISSING", T("This app version still creates projects without a container — please update the app."));
  }
  if (sourcesRaw.length > SOURCES_CAP) return no("SOURCE_UNKNOWN", T`At most ${SOURCES_CAP} sources per project.`);
  const sources = [];
  const wholeTargets = new Map(); // target of a folder source → seq
  const cloneTargets = []; // [target, seq] — header, "CLONE"
  const otherTargets = []; // [target, seq] — every other non-empty target (folder, ZIP, files, `to` of a mapping)
  for (const [i, q] of sourcesRaw.entries()) {
    const seq = i + 1;
    if (!q || typeof q !== "object" || !SOURCE_KINDS_NOW.includes(q.kind)) {
      return no("SOURCE_UNKNOWN", T`Source ${seq}: unknown kind “${q?.kind ?? ""}” (this version knows ${SOURCE_KINDS_NOW.join(", ")}).`);
    }
    if (q.kind === "clone") {
      const detail = q.clone && typeof q.clone === "object" && !(q.clone instanceof Array) ? q.clone : {};
      const k = checkCloneDetail({ url: detail.url, branch: detail.branch });
      if (!k.ok) return no(k.code, `${T`Source ${seq}`}: ${k.error}`);
      const ktarget = q.target === undefined || q.target === null ? k.name : q.target;
      if (ktarget === null) {
        return no("TARGET_INVALID", T`Source ${seq}: the address yields no name — please give a target.`);
      }
      const kr = relPath(ktarget, { emptyAllowed: false });
      if (kr.error) return no("TARGET_INVALID", T`Source ${seq}: invalid target (${kr.error}).`);
      if (wholeTargets.has(ktarget)) return no("TARGET_DUPLICATE", T`Source ${seq}: target “${ktarget}” is already used by source ${wholeTargets.get(ktarget)}.`);
      wholeTargets.set(ktarget, seq);
      cloneTargets.push([ktarget, seq]);
      const kname = typeof q.name === "string" && q.name ? q.name : (k.name || "");
      if (kname && nameError(kname)) return no("TARGET_INVALID", T`Source ${seq}: invalid name (${nameError(kname)}).`);
      sources.push({ seq, kind: "clone", target: ktarget, name: kname, bytes: 0, host: k.host, cloneUrl: k.url, cloneBranch: k.branch || "" });
      continue;
    }
    const target = q.target === undefined || q.target === null ? "" : q.target;
    const r = relPath(target, { emptyAllowed: q.kind !== "folder" });
    if (r.error) return no("TARGET_INVALID", T`Source ${seq}: invalid target (${r.error}).`);
    if (q.kind === "folder" || (q.kind === "zip" && target !== "")) {
      if (wholeTargets.has(target)) return no("TARGET_DUPLICATE", T`Source ${seq}: target “${target}” is already used by source ${wholeTargets.get(target)}.`);
      wholeTargets.set(target, seq);
    }
    const bytes = q.bytes === undefined || q.bytes === null ? 0 : Number(q.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return no("TARGET_INVALID", T`Source ${seq}: “bytes” is not an integer ≥ 0.`);
    const qname = typeof q.name === "string" ? q.name : "";
    if (qname && nameError(qname)) return no("TARGET_INVALID", T`Source ${seq}: invalid name (${nameError(qname)}).`);
    if (target !== "") otherTargets.push([target, seq]);
    if (q.kind === "zip") {
      const a = checkMapping(seq, q.mapping);
      if (a.code) return no(a.code, a.error);
      for (const e of a.mapping) if (e.to) otherTargets.push([e.to, seq]);
      sources.push({ seq, kind: q.kind, target, name: qname, bytes, mapping: a.mapping });
      continue;
    }
    sources.push({ seq, kind: q.kind, target, name: qname, bytes });
  }
  // Nothing else at the target of a clone or below it, no clone inside another — it is put in as a WHOLE (header, "CLONE").
  for (const [kz, knr] of cloneTargets) {
    const other = [...otherTargets, ...cloneTargets.filter(([, n]) => n !== knr)].find(([z]) => under(z, kz));
    if (other) {
      return no("TARGET_DUPLICATE", T`Source ${other[1]}: “${other[0]}” lies inside the target of the clone “${kz}” (source ${knr}) — a clone is only placed as a whole.`);
    }
  }
  const codeRepos = codeReposRaw === undefined ? [] : codeReposRaw;
  // A clone is a code repo under its name: its location counts against the code-repo rules and the limits of the repo search with the marks.
  const error = codeRepoError(Array.isArray(codeRepos) ? [...codeRepos, ...cloneTargets.map(([z]) => z).filter((z) => !codeRepos.includes(z))] : codeRepos);
  if (error.length) return no("CODE_REPO_LOCATION", error.slice(0, 5).join("; "));
  return { ok: true, name, sources, codeRepos: [...codeRepos] };
}
