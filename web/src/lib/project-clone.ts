// Check the address of a clone before the dialog accepts it. PURE. The server stays the boundary (`projectbox/setup/clone.js`
// `checkCloneDetail`, 400 with `code`); this exists so the error appears at the field instead of after creation. iOS computes the same in
// `Code/ProjectCloneCheck.swift` (`ProjectClone.check`).
//
// ONE RULE, THREE PLACES: the address itself is read, not via `new URL` or `URLComponents`, because the two read it differently (WHATWG turns
// `0x7f.1` into `127.0.0.1`, resolves dot segments, drops an empty `user@`; Foundation decodes an IDN host into Unicode, accepts port
// 99999). Bound through the fixture set `server/backend/test/fixtures/clone-check/` (web `web/test/project-clone-check.test.mjs`, iOS
// `web/test/clone-ios-binding.test.mjs`, server `server/backend/test/clone-check.test.js`). The order of the reasons is part of the rule:
//   empty · SSH form · characters (RFC 3986, `%` only with two hex digits) · form `<scheme>://<authority><path>` · https only ·
//   `@` in the authority · `?` · `#` · host (no `%`, `hostname[:port]` lower case from letters, digits, "." and "-", port 0–65535,
//   a number as the last label only as IPv4 in dotted form) · branch · name (last path part after resolving "."/"..", without
//   `.git`, decoded, NFC; not empty, not "."/"..", without "/" and "\").
// The credentials are looked up by host name (lower case, without port), which is how `PUT …/git/creds` stores them.

export type CloneError =
  | "EMPTY" | "ONLY_HTTPS" | "WITH_USER" | "WITH_QUERY" | "WITH_FRAGMENT" | "CHARACTER" | "HOST_UNCLEAR" | "BRANCH" | "INVALID";

export interface CloneDetail {
  url: string;
  branch: string;
  /** The host name, lower case, without port; the key of the stored credentials. */
  host: string;
  /** Default name in the project: the last path part without `.git` (changeable in the project layout). */
  name: string;
}

// RFC 3986: unreserved and reserved characters plus `%` (percent encoding).
const URL_CHARACTER = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const PERCENT_BROKEN = /%(?![0-9A-Fa-f]{2})/;
const SCP_FORM = /^[^/@\s]+@[^/:\s]+:/;
const FORM = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/;
const SCHEME_WITHOUT_SLASHES = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/** A host whose last label is a number is an IPv4 address for WHATWG; valid only in dotted form of four numbers. */
function ipv4Qualifies(host: string): boolean {
  const segments = host.split(".");
  const last = segments[segments.length - 1];
  if (!/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last)) return true; // not an IPv4 case
  return segments.length === 4 && segments.every((g) => /^(?:0|[1-9][0-9]{0,2})$/.test(g) && Number(g) <= 255);
}

/** The parts of a path per RFC 3986 "remove_dot_segments" ("."/"..", also as `%2e`). */
function pathParts(path: string): string[] {
  const out: string[] = [];
  for (const t of path.split("/")) {
    const k = t.toLowerCase();
    if (k === "" || k === "." || k === "%2e") continue;
    if (k === ".." || k === ".%2e" || k === "%2e." || k === "%2e%2e") { out.pop(); continue; }
    out.push(t);
  }
  return out;
}

export function checkClone(urlText: string, branchText: string): { ok: true; detail: CloneDetail } | { ok: false; code: CloneError } {
  const raw = urlText.trim();
  const branch = branchText.trim();
  if (!raw) return { ok: false, code: "EMPTY" };
  // `git@host:path` (scp form) and `ssh://`: the most common mix-up, hence before the character check.
  if (SCP_FORM.test(raw) || /^ssh:\/\//i.test(raw)) return { ok: false, code: "ONLY_HTTPS" };
  if (!URL_CHARACTER.test(raw) || PERCENT_BROKEN.test(raw)) return { ok: false, code: "CHARACTER" };
  const m = FORM.exec(raw);
  if (!m) return { ok: false, code: SCHEME_WITHOUT_SLASHES.test(raw) && !/^https:/i.test(raw) ? "ONLY_HTTPS" : "INVALID" };
  const [, schema, authority, rest] = m;
  if (schema.toLowerCase() !== "https") return { ok: false, code: "ONLY_HTTPS" };
  // Also an empty `@` (which WHATWG silently drops); the server rejects it the same way.
  if (authority.includes("@")) return { ok: false, code: "WITH_USER" };
  if (raw.includes("?")) return { ok: false, code: "WITH_QUERY" };
  if (raw.includes("#")) return { ok: false, code: "WITH_FRAGMENT" };
  const hp = /^([^:]*)(?::([0-9]*))?$/.exec(authority);
  if (authority.includes("%") || !hp) return { ok: false, code: "HOST_UNCLEAR" };
  const host = hp[1].toLowerCase();
  const port = hp[2];
  if (!HOSTNAME.test(host) || !ipv4Qualifies(host)) return { ok: false, code: "HOST_UNCLEAR" };
  if (port !== undefined && (port === "" || port.length > 5 || Number(port) > 65535)) return { ok: false, code: "HOST_UNCLEAR" };
  if (branch && (!BRANCH.test(branch) || branch.startsWith("-"))) return { ok: false, code: "BRANCH" };
  const name = defaultName(rest);
  // Without a path (`https://host/`), or with a name that cannot be a folder name: no repository.
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) return { ok: false, code: "INVALID" };
  return { ok: true, detail: { url: raw, branch, host, name } };
}

/** The last path part (after resolving "."/"..") without `.git`, decoded, NFC; empty if the address has no path. */
export function defaultName(path: string): string {
  const parts = pathParts(path);
  let n = parts.length ? parts[parts.length - 1] : "";
  if (n.toLowerCase().endsWith(".git")) n = n.slice(0, -4);
  try { n = decodeURIComponent(n); } catch { return ""; }
  return n.normalize("NFC");
}
