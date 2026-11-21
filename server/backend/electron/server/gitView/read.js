// The reading of ONE repo in ONE instance. One `sh -c` in the project container via runtime/git-run.js commandRun (like
// the instances tree, projectbox/instances-tree.js), the computation in the backend.
//
// STRATEGY: git 2.39 in the image has no `%(ahead-behind:…)`. A loop with `rev-list --left-right --count` and
// `merge-base` per ref costs several processes per ref and missed the goal (< 1 s with 200 branches) eightfold even
// locally; so the script reads with a FIXED number of calls, and the backend computes the numbers from the graph:
//   1. `for-each-ref` over refs/heads and refs/remotes — oid, upstream, `%(upstream:track)` (git computes the numbers
//      against the upstream itself), last commit (time, author, subject);
//   2. `worktree list --porcelain` and per worktree `status --porcelain` (counted → `notBackedUp`), plus the commits of
//      the detached HEADs (`log --no-walk`);
//   3. S = `rev-list --parents --timestamp --boundary --branches --remotes <detached> <snapshot> --not <main>`: every
//      commit that is not in the main branch, including the boundary (the commits of the main branch that were branched
//      from);
//   4. M = `merge-base --octopus` over all tips WITH common history (refs, detached HEADs, snapshot, main) — a common
//      ancestor of everything; G = `rev-list --parents --timestamp <main> ^M`: the main line down to there.
//   Because M is an ancestor of each of these tips, everything below M is common to all, and every difference (ahead,
//   behind, since creation, not fetched) can be counted exactly IN S ∪ G: ahead = |anc(b) ∩ S|, behind = |G \ anc(b)|. The
//   branch point is the youngest of the maximal boundary commits b reaches (or b itself if b is in the main branch).
//   WITHOUT COMMON HISTORY: a tip that never reaches the main branch (`checkout --orphan`, e.g. gh-pages, or a foreign
//   remote) has no merge base with it — with it `--octopus` would be empty, and G would become the WHOLE main line down to
//   the depth cap. The script detects such tips without another git call from S (WITHOUT_AWK: no commit of their closure
//   has a parent outside S), names them in the section "without" and leaves them out of M and the counting loops. In the
//   reading they carry `toMain`, `branchPoint`, `points`, `count`, `notFetched` and `sinceCreation` = null and do not count
//   for `pushed` — they cost nothing beyond their lines in S. What remains (deliberately): a very old remote branch WITH
//   common history still pulls M deep; the depth cap holds above that.
//   DEPTH (a cap that says it is one): G is read for at most DEPTH_MAX commits (tunable CBASE_GIT_VIEW_DEPTH). If the main
//   line reaches deeper (a branch that branched off very long ago), the script counts `behind` per tip itself
//   (`rev-list --count <main> ^<b>`, one process per tip — slow but exact; ≈ 5 s with 200 branches locally), likewise
//   `sinceCreation` per moved snapshot ref, and `deep: true` is set on the reading. The branch point then computes over
//   the piece read (the youngest entrance it does not recognize as an ancestor of another). The not-fetched list is held
//   against git's number (`%(upstream:track)`) on BOTH paths: if the list differs it is `null`, never shorter than the
//   number next to it.
//   Without a main branch (mainBranch.js) the script does not read S and G: `toMain`, `branchPoint`, the points and the
//   not-fetched list are `null` then (the numbers against the upstream stay, they come from for-each-ref).
//
// COPY: its comparison state is the refs from the snapshot file (stacks/code-snapshot.js, read in the backend via
// readSnapshot — `copyComparison` takes those of the repo from it). They go into the script via stdin as "<oid> <ref>"
// (it keeps those whose commit is in the copy, `cat-file --batch-check`) so S and M carry them: `sinceCreation` computes
// IN the copy, whose objects have the snapshot commits. Which refs are new or moved is decided by the backend
// (`inSnapshot` per ref), which rows come of it by groups.js.
//
// TIMES in milliseconds since 1970 (like `Date.now()`), everywhere: `last.t`, `branchPoint`, points, `remoteState.at`.
//
// readInstance(inst, { path, snapshot, deadline, depth, run })  → reading | { read: false, reason, error }
//   inst      the instance row for commandRun (only `ready` — asking another one wakes it; the caller checks that)
//   path      the repo folder as the container sees it (mounted at the original path, as in the backend)
//   snapshot  null in main; in a copy the refs of its snapshot for this repo (`copyComparison`)
//   run       seam for the guard (default commandRun)
//   Reasons (contract.js REASONS): deadline ⇒ "time", container stopped ⇒ "stopped", paused ⇒ "frozen", else "error".
//
// parseReading(stdout, { marker, snapshot, depth })  → reading (pure; throws on incomplete output)
//   { read: true, deep, mainBranch: { name, source, ref, oid } | null, remoteState: { at, source },
//     tips: [tip], worktrees: [{ path, main, branch, oid, detached, notBackedUp }], line: { commits: [t…], count } }
//   tip = { ref | null, name, kind: "local" | "remote" | "detached", oid, upstream | null, toUpstream | null, last,
//           toMain: { ahead, back, merged } | null, branchPoint: t | null,
//           points: [{ t, pushed }] | null     (the youngest up to POINTS_MAX+1, ascending — groups.js clips),
//           notFetched: [t…] | null           (only with an upstream and at most POINTS_MAX+1 missing commits),
//           inSnapshot: oid | null | undefined (undefined in main), sinceCreation: { ahead, back } | null }
//   `pushed` = the commit lies under some remote ref; `notBackedUp` = lines of `status --porcelain`, null if the worktree
//   cannot be read. A `prunable` worktree (folder gone) is missing from `worktrees`.
//
// copyComparison(snapshot, rel)  → [{ name, oid }] of the branches and remote refs of the repo `rel` ("" = project folder)
//   or null if the snapshot does not know the repo (a repo the copy created: everything about it is new).

import crypto from "node:crypto";
import { CONTAINER_PAUSED, CONTAINER_STANDS, READ_SH, commandRun } from "../runtime/git-run.js";
import { MAIN_SH, selectMainBranch } from "./mainBranch.js";
import { POINTS_MAX } from "./contract.js";

/** Deadline of the one `sh -c` (tunable CBASE_GIT_VIEW_READ_MS). ESTIMATED: locally ≈ 0.1 s with 200 branches. */
export const READ_CAP_MS = 20_000;
/** Commits of the main line the script reads at most (header, "DEPTH"; tunable CBASE_GIT_VIEW_DEPTH). */
export const DEPTH_MAX = 20_000;
/** Output of the `sh -c` (measured: 1.8 MiB with 1,000 branches). */
export const OUTPUT_CAP = 32 * 1024 * 1024;

const slider = (name, preset) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : preset;
};

// The tips without common history with the main branch (header, "WITHOUT COMMON HISTORY") from S, without git: stdin = S
// (the output of `rev-list --topo-order --parents --timestamp --boundary`, children before parents), then a line `--`,
// then the tips (one oid per line). Walking S backwards (parents before children) a commit reaches the main branch if a
// parent lies outside S (a boundary commit or deeper in the main branch) or reaches it itself. Printed: every tip IN S
// that does not reach it. Without single quotes (it stands between such in the script); POSIX awk (mawk in the image,
// BSD awk on the Mac).
export const WITHOUT_AWK = [
  "$0 == \"--\" { t = 1; next }",
  "!t {",
  "  if (NF < 2 || substr($2, 1, 1) == \"-\") next",
  "  n++; id[n] = $2; e = \"\"",
  "  for (i = 3; i <= NF; i++) e = e \" \" $i",
  "  p[$2] = e; next",
  "}",
  "{ tip[$1] = 1 }",
  "END {",
  "  for (j = n; j >= 1; j--) {",
  "    c = id[j]; ok = 0; k = split(p[c], q, \" \")",
  "    for (i = 1; i <= k; i++) if (!(q[i] in p) || r[q[i]]) { ok = 1; break }",
  "    r[c] = ok",
  "  }",
  "  for (x in tip) if ((x in p) && !r[x]) print x",
  "}",
].join("\n");

// The script. $1 marker, $2 repo folder, $3 depth, $4 "1" = stdin carries the snapshot refs ("<oid> <ref>" per line).
// Sections begin with a line "<marker> <name>[ <arg>…]"; fields are separated by \037, records from for-each-ref/log end
// in \036 (a subject can carry a \037/\036 in neither form unless the author put it there on purpose — then the rest
// lands in the subject, see fieldSet).
export const READ_SCRIPT = [
  READ_SH, // git without programs from the repo (fsmonitor, hooks, gpg) — runtime/git-run.js
  "m=$1; t=$3",
  `WITHOUT_AWK='${WITHOUT_AWK}'`,
  "cd \"$2\" 2>/dev/null || { echo \"repo folder $2 is missing\" >&2; exit 3; }",
  "git rev-parse --git-dir >/dev/null 2>&1 || { echo \"$2 is not a git repo\" >&2; exit 4; }",
  "U=$(printf '\\037')",
  // stdin of the copy: "<oid> <ref>" per line; the pairs whose commit is in the copy stay (a foreign oid would break rev-list).
  "pairs=''; snap=''",
  "if [ \"$4\" = 1 ]; then pairs=$(git cat-file --batch-check='%(objectname) %(objecttype) %(rest)' 2>/dev/null | sed -n 's/^\\([0-9a-f]*\\) commit \\(.\\)/\\1 \\2/p'); snap=$(printf '%s\\n' \"$pairs\" | sed -n 's/ .*//p'); fi",
  MAIN_SH,
  "fh=''; gd=$(git rev-parse --git-common-dir 2>/dev/null) && [ -f \"$gd/FETCH_HEAD\" ] && fh=$(date -r \"$gd/FETCH_HEAD\" +%s 2>/dev/null)",
  "printf '%s header\\n' \"$m\"",
  "printf 'main%s%s%s%s\\n' \"$U\" \"$h\" \"$U\" \"$hq\"",
  "printf 'originHead%s%s\\n' \"$U\" \"$oh\"",
  "printf 'fetchHead%s%s\\n' \"$U\" \"$fh\"",
  "printf '%s refs\\n' \"$m\"",
  "git for-each-ref --format='%(refname)%1f%(objectname)%1f%(symref)%1f%(upstream)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(authorname)%1f%(subject)%1e' refs/heads refs/remotes || exit 5",
  "wt=$(git worktree list --porcelain) || exit 6",
  "printf '%s wt\\n' \"$m\"",
  "printf '%s\\n' \"$wt\"",
  // One pass over the worktrees without a subprocess (here-doc instead of a pipe: dash runs a pipe loop in a subshell).
  "detached=''; paths=''; o=''",
  "while IFS= read -r z; do",
  "  case \"$z\" in",
  "    'worktree '*) p=${z#worktree }; [ -d \"$p\" ] && paths=\"$paths$p$U\";;",
  "    'HEAD '*) o=${z#HEAD };;",
  "    detached) detached=\"$detached $o\";;",
  "  esac",
  "done <<CBASE_WT",
  "$wt",
  "CBASE_WT",
  "printf '%s status\\n' \"$m\"",
  "IFS0=$IFS; IFS=$U",
  "for p in $paths; do",
  "  if s=$(git -C \"$p\" status --porcelain 2>/dev/null); then if [ -z \"$s\" ]; then n=0; else n=$(printf '%s\\n' \"$s\" | wc -l | tr -d ' '); fi; else n=''; fi",
  "  printf '%s\\037%s\\036\\n' \"$p\" \"$n\"",
  "done",
  "IFS=$IFS0",
  "printf '%s loose\\n' \"$m\"",
  "if [ -n \"$detached\" ]; then git log --no-walk=unsorted --format='%H%x1f%ct%x1f%an%x1f%s%x1e' $detached || exit 7; fi",
  "if [ -n \"$h\" ]; then",
  "  printf '%s graph\\n' \"$m\"",
  "  s=$(git rev-list --topo-order --parents --timestamp --boundary --branches --remotes $detached $snap --not \"$h\") || exit 8",
  "  [ -n \"$s\" ] && printf '%s\\n' \"$s\"",
  "  tips=$( { git for-each-ref --format='%(objectname)' refs/heads refs/remotes; for x in $detached $snap; do echo \"$x\"; done; } | sort -u)",
  // Tips without common history with the main branch (orphan, header "WITHOUT COMMON HISTORY"): in S their closure reaches
  // no commit outside S. One pass over S (topological, parents before children), no git call.
  "  without=$( { printf '%s\\n' \"$s\"; echo '--'; printf '%s\\n' \"$tips\"; } | awk \"$WITHOUT_AWK\")",
  "  printf '%s without\\n' \"$m\"",
  "  [ -n \"$without\" ] && printf '%s\\n' \"$without\"",
  "  without=$(printf ' %s' $without)",
  "  all_tips=$(git rev-parse \"$h\")",
  "  for x in $tips; do case \"$without \" in *\" $x \"*) ;; *) all_tips=\"$all_tips $x\";; esac; done",
  "  mb=$(git merge-base --octopus $all_tips 2>/dev/null) || mb=''",
  "  mbt=''; [ -n \"$mb\" ] && mbt=$(git log -1 --format=%ct \"$mb\")",
  "  if [ -n \"$mb\" ]; then gm=$(git rev-list --parents --timestamp -n \"$((t+1))\" \"$h\" \"^$mb\") || exit 9",
  "  else gm=$(git rev-list --parents --timestamp -n \"$((t+1))\" \"$h\") || exit 9; fi",
  "  printf '%s main %s %s\\n' \"$m\" \"$mb\" \"$mbt\"",
  "  [ -n \"$gm\" ] && printf '%s\\n' \"$gm\"",
  "  n=0; [ -n \"$gm\" ] && n=$(printf '%s\\n' \"$gm\" | wc -l | tr -d ' ')",
  "  if [ \"$n\" -gt \"$t\" ]; then",
  "    printf '%s back\\n' \"$m\"",
  "    for x in $(git for-each-ref --format='%(objectname):%(refname)' refs/heads refs/remotes) $detached; do",
  "      o=${x%%:*}; x=${x#*:}",
  "      case \"$without \" in *\" $o \"*) continue;; esac",
  "      printf '%s\\037%s\\n' \"$x\" \"$(git rev-list --count \"$h\" \"^$x\")\"",
  "    done",
  // since creation likewise per moved snapshot ref (left = only today = ahead, right = only back then = behind)
  "    printf '%s creation\\n' \"$m\"",
  "    printf '%s\\n' \"$pairs\" | while read -r o r; do",
  "      [ -n \"$r\" ] || continue",
  "      c=$(git rev-parse -q --verify \"$r^{commit}\" 2>/dev/null) || continue",
  "      [ \"$c\" = \"$o\" ] && continue",
  "      case \"$without \" in *\" $c \"*|*\" $o \"*) continue;; esac",
  "      printf '%s\\037%s\\n' \"$r\" \"$(git rev-list --left-right --count \"$c...$o\")\"",
  "    done",
  "  fi",
  "fi",
  "printf '%s end\\n' \"$m\"",
].join("\n");

const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ms = (s) => (s === "" || s == null || !Number.isFinite(Number(s)) ? null : Number(s) * 1000);

/** The refs of a repo from the snapshot of a copy (see header). */
export function copyComparison(snapshot, rel) {
  const target = rel === "" || rel == null ? "." : String(rel);
  const repo = (snapshot?.repos || []).find((r) => !r.projectRepo && String(r.rel) === target);
  if (!repo) return null;
  return (repo.refs || [])
    .filter((r) => r && !r.symref && HEX.test(String(r.oid || "")) && /^refs\/(heads|remotes)\//.test(String(r.name || "")))
    .map((r) => ({ name: String(r.name), oid: String(r.oid) }));
}

// ── Splitting the output ──────────────────────────────────────────────────────────────────────────────────────────────────

function sections(stdout, marker) {
  const re = new RegExp(`(?<=^|\\n)${marker} ([a-z]+)((?: [^\\n]*)?)\\n`, "g");
  const hits = [...String(stdout || "").matchAll(re)];
  const out = new Map();
  hits.forEach((t, i) => {
    const mark = t.index + t[0].length;
    const until = i + 1 < hits.length ? hits[i + 1].index : String(stdout).length;
    out.set(t[1], { args: t[2].trim() ? t[2].trim().split(" ") : [], text: String(stdout).slice(mark, until) });
  });
  return out;
}

// A record of \037 fields; whatever goes beyond `n` fields belongs to the last one (the subject).
const fieldSet = (s, n) => { const f = s.split("\x1f"); return f.length > n ? [...f.slice(0, n - 1), f.slice(n - 1).join("\x1f")] : f; };
const sets = (text) => String(text || "").split("\x1e\n").map((s) => s.replace(/^\n+/, "")).filter((s) => s !== "");

function track(s) {
  const t = String(s || "").trim();
  if (t === "gone") return { gone: true };
  const ahead = Number(/ahead (\d+)/.exec(t)?.[1] || 0);
  const back = Number(/behind (\d+)/.exec(t)?.[1] || 0);
  return { ahead, back };
}

function graphRows(text) {
  const node = new Map(); const margin = new Map();
  for (const z of String(text || "").split("\n")) {
    if (!z) continue;
    const [ts, id, ...parent] = z.split(" ");
    if (id.startsWith("-")) margin.set(id.slice(1), ms(ts));
    else node.set(id, { t: ms(ts), parent });
  }
  return { node, margin };
}

function worktreeBlocks(text) {
  const out = [];
  let w = null;
  for (const z of String(text || "").split("\n")) {
    if (z.startsWith("worktree ")) { w = { path: z.slice(9), branch: null, oid: null, detached: false, prunable: false, bare: false }; out.push(w); continue; }
    if (!w) continue;
    if (z.startsWith("HEAD ")) w.oid = z.slice(5);
    else if (z.startsWith("branch ")) w.branch = z.slice(7);
    else if (z === "detached") w.detached = true;
    else if (z === "bare") w.bare = true;
    else if (z === "prunable" || z.startsWith("prunable ")) w.prunable = true;
  }
  return out.filter((x) => !x.bare);
}

// ── The computation in the graph ─────────────────────────────────────────────────────────────────────────────────────────

function calculator({ S, margin, G, mb, mbT }) {
  const inS = (x) => S.has(x);
  const ancSMemo = new Map();
  // anc(x) ∩ S and the entrances into the main branch (parents outside S; x itself if x is not in S).
  function ancS(x) {
    if (ancSMemo.has(x)) return ancSMemo.get(x);
    const set = new Set(); const entrances = new Set();
    if (!inS(x)) { entrances.add(x); } else {
      const stack = [x];
      while (stack.length) {
        const c = stack.pop();
        if (set.has(c)) continue;
        set.add(c);
        for (const e of S.get(c).parent) (inS(e) ? stack.push(e) : entrances.add(e));
      }
    }
    const r = { set, entrances: [...entrances] };
    ancSMemo.set(x, r);
    return r;
  }
  // anc(entrances) ∩ G, memoized per set of entrances.
  const ancGMemo = new Map();
  function ancG(entrances) {
    const k = [...entrances].sort().join(",");
    if (ancGMemo.has(k)) return ancGMemo.get(k);
    const set = new Set(); const stack = entrances.filter((e) => G.has(e));
    while (stack.length) {
      const c = stack.pop();
      if (set.has(c)) continue;
      set.add(c);
      for (const e of G.get(c).parent) if (G.has(e)) stack.push(e);
    }
    ancGMemo.set(k, set);
    return set;
  }
  const timeOf = (x) => G.get(x)?.t ?? S.get(x)?.t ?? margin.get(x) ?? (x === mb ? mbT : null);
  // The branch point: the maximal entrances (none is an ancestor of another, measured in G), of those the youngest.
  function branchPoint(entrances) {
    if (!entrances.length) return null;
    const under = new Set(); const stack = [];
    for (const e of entrances) for (const p of G.get(e)?.parent || []) if (G.has(p)) stack.push(p);
    while (stack.length) {
      const c = stack.pop();
      if (under.has(c)) continue;
      under.add(c);
      for (const p of G.get(c).parent) if (G.has(p)) stack.push(p);
    }
    // An entrance outside G is M or lies below it: maximal only if no entrance lies in G.
    const inG = entrances.filter((e) => G.has(e) && !under.has(e));
    const candidates = inG.length ? inG : entrances;
    const times = candidates.map(timeOf).filter((t) => t != null);
    return times.length ? Math.max(...times) : null;
  }
  // anc(x) ∩ (S ∪ G) — for the rare differences of two tips (since creation, not fetched).
  function ancFull(x) {
    const a = ancS(x);
    return { s: a.set, g: ancG(a.entrances) };
  }
  const countWithout = (x, y) => { // |anc(x) \ anc(y)| in S ∪ G
    const ax = ancFull(x); const ay = ancFull(y);
    let n = 0;
    for (const c of ax.s) if (!ay.s.has(c)) n++;
    for (const c of ax.g) if (!ay.g.has(c)) n++;
    return n;
  };
  const timesWithout = (x, y) => {
    const ax = ancFull(x); const ay = ancFull(y);
    const t = [];
    for (const c of ax.s) if (!ay.s.has(c)) t.push(S.get(c).t);
    for (const c of ax.g) if (!ay.g.has(c)) t.push(G.get(c).t);
    return t.sort((a, b) => a - b);
  };
  return { ancS, ancG, branchPoint, countWithout, timesWithout };
}

/** The output of the script as a reading (see header). Pure. */
export function parseReading(stdout, { marker, snapshot = null, depth = DEPTH_MAX } = {}) {
  const parts = sections(stdout, marker);
  for (const n of ["header", "refs", "wt", "status", "loose", "end"]) {
    if (!parts.has(n)) throw new Error(`reading incomplete: section "${n}" is missing`);
  }
  const header = new Map(parts.get("header").text.split("\n").filter(Boolean).map((z) => { const f = z.split("\x1f"); return [f[0], f.slice(1)]; }));
  const [hRef = "", hSource = ""] = header.get("main") || [];
  const originHead = (header.get("originHead") || [""])[0] || null;
  const fetchHead = ms((header.get("fetchHead") || [""])[0]);

  const refs = sets(parts.get("refs").text).map((s) => {
    const [ref, oid, symref, upstream, tr, ct, author, subject] = fieldSet(s, 8);
    return { ref, oid, symref: symref || null, upstream: upstream || null, track: tr || "", last: { t: ms(ct), author: author || "", subject: subject || "" } };
  });
  const names = new Set(refs.filter((r) => !r.symref).map((r) => r.ref));
  const hb = selectMainBranch({ originHead, refs: names });
  // The script chooses with the same piece (mainBranch.js MAIN_SH); if it differs, the reading is unusable.
  if ((hb?.ref || "") !== hRef || (hb?.source || "") !== hSource) {
    throw new Error(`reading contradictory: the script chose "${hRef || "—"}" (${hSource || "—"}), the computation "${hb?.ref || "—"}"`);
  }
  const mainOid = hb ? refs.find((r) => r.ref === hb.ref)?.oid || null : null;

  const status = new Map(sets(parts.get("status").text).map((s) => { const [p, n] = fieldSet(s, 2); return [p, n === "" || n == null ? null : Number(String(n).trim())]; }));
  const wtList = worktreeBlocks(parts.get("wt").text).filter((w) => !w.prunable);
  const worktrees = wtList.map((w, i) => ({
    path: w.path, main: i === 0, branch: w.branch, oid: w.oid, detached: w.detached,
    notBackedUp: status.has(w.path) && Number.isFinite(status.get(w.path)) ? status.get(w.path) : null,
  }));
  const looseInfo = new Map(sets(parts.get("loose").text).map((s) => {
    const [oid, ct, author, subject] = fieldSet(s, 4);
    return [oid, { t: ms(ct), author: author || "", subject: subject || "" }];
  }));

  // Graph and main line (only with a main branch).
  const graph = parts.has("graph") ? graphRows(parts.get("graph").text) : { node: new Map(), margin: new Map() };
  const mainPart = parts.get("main");
  const G = mainPart ? graphRows(mainPart.text).node : new Map();
  const deep = Boolean(hb) && G.size > depth;
  const backCount = new Map((parts.get("back")?.text || "").split("\n").filter(Boolean).map((z) => { const [x, n] = z.split("\x1f"); return [x, Number(n)]; }));
  const creationCount = new Map((parts.get("creation")?.text || "").split("\n").filter(Boolean).map((z) => {
    const [x, n] = z.split("\x1f");
    const [ahead, back] = String(n).trim().split(/\s+/).map(Number);
    return [x, { ahead, back }];
  }));
  const mb = mainPart?.args[0] || null;
  const mbT = ms(mainPart?.args[1]);
  const r = calculator({ S: graph.node, margin: graph.margin, G, mb, mbT });
  // Tips without common history with the main branch (header, "WITHOUT COMMON HISTORY").
  const without = new Set((parts.get("without")?.text || "").split("\n").map((z) => z.trim()).filter((z) => HEX.test(z)));

  // Whatever lies under some remote ref is pushed (a remote ref without common history does not count — it costs nothing).
  const pushed = new Set();
  for (const x of refs) if (x.ref.startsWith("refs/remotes/") && !without.has(x.oid)) for (const c of r.ancS(x.oid).set) pushed.add(c);

  const snap = snapshot ? new Map(snapshot.map((s) => [s.name, s.oid])) : null;
  const existing = new Set([...graph.node.keys(), ...G.keys()]);
  const oidExists = (x) => existing.has(x) || graph.margin.has(x) || x === mb || refs.some((y) => y.oid === x);

  function metric(oid, refName) {
    if (!hb || without.has(oid)) return { toMain: null, branchPoint: null, points: null, count: null };
    const a = r.ancS(oid);
    const ahead = a.set.size;
    const back = deep
      ? (backCount.has(refName || oid) ? backCount.get(refName || oid) : null)
      : G.size - r.ancG(a.entrances).size;
    const points = [...a.set].map((c) => ({ t: graph.node.get(c).t, pushed: pushed.has(c) }))
      .sort((x, y) => y.t - x.t).slice(0, POINTS_MAX + 1).reverse();
    return { toMain: { ahead, back, merged: ahead === 0 }, branchPoint: r.branchPoint(a.entrances), points, count: ahead };
  }

  const tips = [];
  for (const x of refs) {
    if (x.symref) continue;
    const kind = x.ref.startsWith("refs/heads/") ? "local" : "remote";
    const name = kind === "local" ? x.ref.slice("refs/heads/".length) : x.ref.slice("refs/remotes/".length);
    const tr = track(x.track);
    // An upstream counts only if it exists (`[gone]` = configured but gone).
    const upstream = kind === "local" && x.upstream && !tr.gone && names.has(x.upstream) ? x.upstream : null;
    const toUpstream = upstream ? { ahead: tr.ahead, back: tr.back } : null;
    const m = metric(x.oid, x.ref);
    let notFetched = null;
    const uOid = upstream ? refs.find((y) => y.ref === upstream).oid : null;
    if (hb && upstream && toUpstream.back <= POINTS_MAX && !without.has(x.oid) && !without.has(uOid)) {
      notFetched = r.timesWithout(uOid, x.oid);
      // Against git's own number (`%(upstream:track)`): if it does not match (DEPTH: the missing part lies below the piece
      // of the main line that was read), the list is unknown — never a shorter one than the number next to it.
      if (notFetched.length !== toUpstream.back) notFetched = null;
    }
    const old = snap ? (snap.has(x.ref) ? snap.get(x.ref) : null) : undefined;
    let sinceCreation = null;
    if (hb && old && old !== x.oid && !without.has(x.oid) && !without.has(old)) {
      if (deep) sinceCreation = creationCount.get(x.ref) || null; // DEPTH: counted by the script
      else if (oidExists(old)) sinceCreation = { ahead: r.countWithout(x.oid, old), back: r.countWithout(old, x.oid) };
    }
    tips.push({ ref: x.ref, name, kind, oid: x.oid, upstream, toUpstream, last: x.last, ...m, notFetched, inSnapshot: old, sinceCreation });
  }
  // Detached HEADs (once per oid).
  for (const oid of new Set(worktrees.filter((w) => w.detached && w.oid).map((w) => w.oid))) {
    const m = metric(oid, null);
    tips.push({
      ref: null, name: oid, kind: "detached", oid, upstream: null, toUpstream: null,
      last: looseInfo.get(oid) || { t: null, author: "", subject: "" }, ...m, notFetched: null,
      inSnapshot: snap ? null : undefined, sinceCreation: null,
    });
  }

  // The main line: first parents from the tip of the main branch, as far as read (ascending).
  const line = { commits: [], count: 0 };
  if (hb && mainOid) {
    let c = mainOid; const t = [];
    while (c && G.has(c)) { t.push(G.get(c).t); c = G.get(c).parent[0]; }
    if (!t.length) t.push(refs.find((y) => y.ref === hb.ref)?.last.t);
    line.commits = t.filter((x) => x != null).reverse();
    line.count = line.commits.length;
  }

  return {
    read: true, deep,
    mainBranch: hb ? { ...hb, oid: mainOid } : null,
    remoteState: fetchHead ? { at: fetchHead, source: "fetch-head" } : { at: null, source: "unknown" },
    tips, worktrees, line,
  };
}

// ── The call ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const short = (s) => String(s || "").trim().split("\n").slice(-3).join(" ").slice(0, 400);

/** The snapshot refs as stdin of the script: "<oid> <ref>" per line, only checked shapes (oid hexadecimal, ref without whitespace). */
export const snapshotStdin = (list) => (list || [])
  .filter((s) => HEX.test(String(s?.oid || "")) && /^refs\/\S+$/.test(String(s?.name || "")))
  .map((s) => `${s.oid} ${s.name}\n`).join("");

/** One instance, one repo, one `sh -c` (see header). */
export async function readInstance(inst, { path, snapshot = null, deadline, depth, run = commandRun } = {}) {
  const marker = `cbase-${crypto.randomBytes(8).toString("hex")}`;
  const t = Number(depth) > 0 ? Number(depth) : slider("CBASE_GIT_VIEW_DEPTH", DEPTH_MAX);
  const stdin = snapshot ? snapshotStdin(snapshot) : null;
  let r;
  try {
    r = await run(inst, "/", "sh", ["-c", READ_SCRIPT, "sh", marker, String(path), String(t), snapshot ? "1" : "0"], {
      env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      envAlways: ["GIT_OPTIONAL_LOCKS"], // like the instances tree: reading in foreign repos takes no index.lock
      timeout: Number(deadline) > 0 ? Number(deadline) : slider("CBASE_GIT_VIEW_READ_MS", READ_CAP_MS),
      maxBuffer: OUTPUT_CAP,
      ...(stdin != null ? { stdin } : {}),
    });
  } catch (e) {
    return { read: false, reason: "error", error: String(e?.message || e) };
  }
  const text = short(r.stderr);
  if (r.cap === "deadline") return { read: false, reason: "time", error: text };
  if (r.code !== 0 && CONTAINER_PAUSED.test(String(r.stderr || ""))) return { read: false, reason: "frozen", error: text };
  if (r.code !== 0 && CONTAINER_STANDS.test(String(r.stderr || ""))) return { read: false, reason: "stopped", error: text };
  if (r.code !== 0) return { read: false, reason: "error", error: text || `reading in the project container: exit ${r.code ?? "?"}` };
  try {
    return parseReading(r.stdout, { marker, snapshot, depth: t });
  } catch (e) {
    return { read: false, reason: "error", error: String(e?.message || e) };
  }
}
