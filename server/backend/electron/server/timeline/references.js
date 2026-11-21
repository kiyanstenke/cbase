// The links of a timeline event: MR, issue, pipeline, commit and branch as links — built ONCE here, web and iOS only draw
// (event shape `links` and `references`, read.js).
//
// WHERE the address comes from: the remote of every code repo of the project, read through the FILE SYSTEM (`.git/config`
// through git.js readGitFile — without git, without waking the project container; the repos from gitView/repos.js
// reposInContainer like the git overview). Remote = `origin`, otherwise the first. git.js remoteLocation turns it into host
// and path — the URL itself (it may carry a token) never leaves this file. There is no second place in cbase that knows a
// GitLab's web address.
//
// Provider: host contains "github" ⇒ GitHub paths, otherwise GitLab paths (`/-/merge_requests/<iid>` …) — the timeline
// speaks in GitLab identifiers (`!31`), and a self-hosted GitLab is rarely called "gitlab". A host without a dot (an SSH
// alias from `~/.ssh/config`, e.g. `gitlab-work`) has no web address ⇒ the repo gets no links.
//
// WHICH repo an event means (`anchorRepo`): (1) an identifier with a prefix in title/text whose number is the anchor's MR
// IID ("frontend!171" with mrIid 171); (2) the only repo of the project, if it has a web address (not "the only one WITH a
// web address"); (3) the only repo that knows the anchor's branch (`refs/heads/<b>`, `refs/remotes/origin/<b>` or
// `packed-refs`). Otherwise none — then no outside links for the anchor (a SHA alone in a project with several repos stays
// unlinked).
//
// IDENTIFIERS IN THE TEXT (`segments`): `<prefix>!<n>` / `!<n>` (MR), `<prefix>#<n>` / `#<n>` (issue), "Pipeline #<n>",
// `<prefix>@<sha>` / `<sha>` (7–40 hex with a digit AND a letter). A prefix counts only if it matches EXACTLY ONE repo
// (folder name, last part or whole path of the remote, case-insensitive); without a prefix the anchor's repo or the only
// one. What cannot be resolved unambiguously (short prefixes like "o", "ip", "sc" …) stays text — never a link to a guessed repo.
import path from "node:path";
import { readGitFile, remoteLocation } from "../git.js";
import { reposInContainer } from "../gitView/repos.js";
import { runInstance } from "../projectbox/run-instance.js";

/** How long a project's remotes stay valid (ms). Reading costs one `open` per repo — the list asks on every reload. */
export const REFERENCES_MS = 30_000;

// ── Remotes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The remotes from the text of a git config: `[{ name, url }]` in file order (pure). */
export function remotesFromConfig(text) {
  const out = [];
  let name = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const z = raw.trim();
    if (!z || z[0] === "#" || z[0] === ";") continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*\]/.exec(z);
    if (header) { name = header[1].toLowerCase() === "remote" && header[2] ? header[2] : null; continue; }
    if (name === null) continue;
    const m = /^url\s*=\s*(.*)$/i.exec(z);
    if (!m) continue;
    const url = m[1].replace(/\s[#;].*$/, "").replace(/^"(.*)"$/, "$1").trim();
    if (url && !out.some((r) => r.name === name)) out.push({ name, url });
  }
  return out;
}

/** Host + path → `{ provider, web }` or null (no web host). */
export function webFrom(location) {
  if (!location || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(location.host)) return null;
  const filePath = location.path.split("/").map(encodeURIComponent).join("/");
  return { provider: /github/i.test(location.host) ? "github" : "gitlab", web: `https://${location.host.toLowerCase()}/${filePath}` };
}

const between = new Map(); // projectId → { at, path, repos }
/** Drop the cache of one project (or of all) — tests, and whoever changes a remote. */
export function forgetReferences(projectId = null) { if (projectId === null) between.clear(); else between.delete(String(projectId)); }

/**
 * The project's code repos with their web address: `[{ rel, name, root, remotePath, provider, web }]` (`web` null without a
 * readable remote). Never throws: an unreadable project has no repos.
 */
export function projectRemotes(proj, { now = Date.now() } = {}) {
  const pid = String(proj?.id ?? "");
  if (!pid || !proj.path) return [];
  const old = between.get(pid);
  if (old && old.path === proj.path && now - old.at < REFERENCES_MS) return old.repos;
  let repos = [];
  try {
    let inst = null;
    try { inst = runInstance(pid, "main"); } catch { inst = null; }
    repos = reposInContainer(proj, inst).map((r) => {
      const remotes = remotesFromConfig(readGitFile(r.root, "config", { anchor: proj.path }));
      const remote = remotes.find((x) => x.name === "origin") || remotes[0] || null;
      const location = remote ? remoteLocation(remote.url) : null;
      const w = webFrom(location);
      return { rel: r.rel, name: r.name, root: r.root, remotePath: location?.path ?? null, provider: w?.provider ?? null, web: w?.web ?? null };
    });
  } catch { repos = []; }
  between.set(pid, { at: now, path: proj.path, repos });
  return repos;
}

// ── Which repo ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The repos a prefix means (case-insensitive): folder (`rel`), its last part, name, whole path or last part of the remote. */
export function reposToPrefix(repos, prefix) {
  const p = String(prefix || "").toLowerCase();
  if (!p) return [];
  return repos.filter((r) => {
    const names = [r.rel, path.posix.basename(r.rel || ""), r.name, r.remotePath, r.remotePath ? r.remotePath.split("/").pop() : null];
    return names.some((n) => n && String(n).toLowerCase() === p);
  });
}

/** Does the repo know the branch (local or `origin/<b>`)? Through the file system (loose refs, then `packed-refs`). */
function knowsBranch(repo, branch, anchor) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (readGitFile(repo.root, ref, { anchor }) !== null) return true;
  }
  const packed = readGitFile(repo.root, "packed-refs", { anchor });
  if (!packed) return false;
  return packed.split("\n").some((z) => z.endsWith(` refs/heads/${branch}`) || z.endsWith(` refs/remotes/origin/${branch}`));
}

/** The repo of an event's git anchor (header: "WHICH repo") or null. */
export function anchorRepo(repos, { title, text, branch, mrIid }, { anchor = null } = {}) {
  const withWeb = repos.filter((r) => r.web);
  if (Number.isSafeInteger(mrIid)) {
    const hits = new Set();
    for (const k of identifiers(`${title || ""}\n${text || ""}`)) {
      if (k.kind === "mr" && k.number === mrIid && k.prefix) for (const r of reposToPrefix(repos, k.prefix)) hits.add(r);
    }
    if (hits.size === 1) return [...hits][0];
  }
  // Only the ONLY repo of the project is meant without a further hint — not the only one WITH a web address (otherwise an
  // identifier of a repo without a web address lands in the one repo that has one).
  if (repos.length === 1 && repos[0].web) return repos[0];
  if (branch) {
    const know = withWeb.filter((r) => knowsBranch(r, branch, anchor));
    if (know.length === 1) return know[0];
  }
  return null;
}

// ── Addresses ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const pathParts = (s) => String(s).split("/").map(encodeURIComponent).join("/");
/** The address of a thing in a repo with a web address — ONE table for GitLab and GitHub. */
export function address(repo, kind, value) {
  if (!repo?.web) return null;
  const gh = repo.provider === "github";
  const w = String(value);
  switch (kind) {
    case "mr": return `${repo.web}${gh ? "/pull/" : "/-/merge_requests/"}${encodeURIComponent(w)}`;
    case "issue": return `${repo.web}${gh ? "/issues/" : "/-/issues/"}${encodeURIComponent(w)}`;
    case "pipeline": return `${repo.web}${gh ? "/actions/runs/" : "/-/pipelines/"}${encodeURIComponent(w)}`;
    case "commit": return `${repo.web}${gh ? "/commit/" : "/-/commit/"}${encodeURIComponent(w)}`;
    case "branch": return `${repo.web}${gh ? "/tree/" : "/-/tree/"}${pathParts(w)}`;
    default: return null;
  }
}

// ── Identifiers in the text ───────────────────────────────────────────────────────────────────────────────────────────────────────

const PREFIX = "[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_.-]+)*";
const PATTERN = () => new RegExp(
  `(?<pipeline>\\b[Pp]ipeline\\s+#?(?<pnr>\\d{1,12})\\b)`
  + `|(?<![\\w/.@!#-])(?:(?<pre>${PREFIX}))?(?<character>[!#])(?<number>\\d{1,9})\\b`
  + `|(?<![\\w/.@-])(?:(?<cpre>${PREFIX})@)?(?<sha>[0-9a-f]{7,40})\\b`, "g");

/** A text's identifiers (pure): `[{ from, until, kind: mr|issue|pipeline|commit, number?, sha?, prefix }]` (UTF-16 positions). */
export function identifiers(text) {
  const s = String(text || "");
  const out = [];
  for (const m of s.matchAll(PATTERN())) {
    const g = m.groups;
    const from = m.index;
    const until = from + m[0].length;
    if (g.pipeline) out.push({ from, until, kind: "pipeline", number: Number(g.pnr), prefix: null });
    else if (g.character) out.push({ from, until, kind: g.character === "!" ? "mr" : "issue", number: Number(g.number), prefix: g.pre || null });
    else if (g.sha && /\d/.test(g.sha) && /[a-f]/.test(g.sha)) out.push({ from, until, kind: "commit", sha: g.sha, prefix: g.cpre || null });
  }
  return out;
}

/** Is the identifier `k` the anchor itself (`{ sha, mrIid }`)? A SHA counts if one of the two is the beginning of the other. */
function anchorSelf(k, { sha = null, mrIid = null } = {}) {
  if (k.kind === "commit" && sha) {
    const x = String(k.sha).toLowerCase(), y = String(sha).toLowerCase();
    return x.startsWith(y) || y.startsWith(x);
  }
  if (k.kind === "mr" && Number.isSafeInteger(mrIid)) return k.number === mrIid;
  return false;
}

/**
 * A text as a sequence of chunks `[{ t, url?, kind? }]` — only if at least one identifier can be resolved unambiguously;
 * otherwise null (the client shows the text as is). `standard` = the repo for identifiers without a prefix (anchor repo or
 * the only one) or null.
 */
export function segments(text, repos, standard, { onlyAnchor = null } = {}) {
  const s = String(text || "");
  if (!s) return null;
  const chunks = [];
  let pos = 0;
  let linked = 0;
  for (const k of identifiers(s)) {
    let repo = standard;
    // Several repos: an identifier WITHOUT a prefix belongs to the anchor's repo only if it is the anchor itself (its commit,
    // its MR) — a text often names several repos ("ip!20 on 317f114 … Closes #19" next to another repo's branch).
    if (!k.prefix && onlyAnchor && !anchorSelf(k, onlyAnchor)) repo = null;
    if (k.prefix) {
      const r = reposToPrefix(repos, k.prefix);
      repo = r.length === 1 ? r[0] : null;
    }
    const url = repo ? address(repo, k.kind, k.kind === "commit" ? k.sha : k.number) : null;
    if (!url) continue;
    if (k.from > pos) chunks.push({ t: s.slice(pos, k.from) });
    chunks.push({ t: s.slice(k.from, k.until), url, kind: k.kind });
    pos = k.until;
    linked += 1;
  }
  if (!linked) return null;
  if (pos < s.length) chunks.push({ t: s.slice(pos) });
  return chunks;
}

/**
 * The links of ONE event (event shape): `links` = `{ repo, mr, commit, branch, gitView }` (each null if not resolvable;
 * `repo` = `{ rel, name, provider, web }`, `gitView` = `{ repo, branch }` — the jump into cbase's git overview, only with a
 * branch), `references` = `{ title, text }` (each chunks or null). `repos` = projectRemotes of the project.
 */
export function referencesOf(e, repos, { anchor = null } = {}) {
  const a = e.anchor || {};
  const ar = anchorRepo(repos, { title: e.title, text: e.text, branch: a.branch, mrIid: a.mrIid }, { anchor });
  const standard = ar || (repos.length === 1 && repos[0].web ? repos[0] : null);
  const links = {
    repo: ar ? { rel: ar.rel, name: ar.name, provider: ar.provider, web: ar.web } : null,
    mr: ar && Number.isSafeInteger(a.mrIid) ? address(ar, "mr", a.mrIid) : null,
    commit: ar && a.sha ? address(ar, "commit", a.sha) : null,
    branch: ar && a.branch ? address(ar, "branch", a.branch) : null,
    // The git overview knows repos without a remote too: with a single repo or the anchor's repo; the branch is searched for.
    gitView: a.branch && (ar || repos.length === 1) ? { repo: (ar || repos[0]).rel, branch: a.branch } : null,
  };
  // With exactly one repo every identifier without a prefix is unambiguous; with several only the anchor's own (anchorSelf).
  const onlyAnchor = repos.length === 1 ? null : { sha: a.sha || null, mrIid: Number.isSafeInteger(a.mrIid) ? a.mrIid : null };
  return { links, references: { title: segments(e.title, repos, standard, { onlyAnchor }), text: segments(e.text, repos, standard, { onlyAnchor }) } };
}
