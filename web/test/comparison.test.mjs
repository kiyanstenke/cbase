// "Select for Compare" and diffs that follow along (explorer and editor like VS Code).
//
// (1) The computations, EXECUTED:
//     - lib/comparison.ts: the ONE selection computation for explorer and time axis (two separate choices like VS Code
//       `resourceSelectedForCompare` and `git.timeline.selectedForCompare`; the selected one on the left, the clicked one on the
//       right; "Compare Selected" only at exactly two, in selection order; the time axis compares only entries of the SAME file,
//       nothing else; its group "3_compare");
//     - lib/explorer-actions.ts `menuPlan`: the group "3_compare" on a file after "navigation", before "5_cutcopypaste" —
//       "Compare with Selected" (selected, not exactly two), "Select for Compare" (not exactly two), "Compare Selected" (exactly
//       two); nothing on folders and the root;
//     - lib/chat-tabs.ts: the sources `comparison` and `files` (foreign text checked, fixed form, own key), `current` on the
//       change, `renameSource` (every diff follows; a folder above the repo takes the repo along; out of the repo is a delete for
//       the repo) and `sourceFalls` (like VS Code `handleDeletedFile`: the unstaged change and the comparison of two files fall,
//       what is in Git stays), plus the tabs of the chat (`rename`, `removeFiles` — gone from outside every diff stays, deleted in
//       the explorer one with unsaved changes stays);
//     - lib/editor-inputs.ts: the same in the editor groups (`followRename`, `hitsDeleted` in the explorer, `hitsFile` from
//       outside), buffer, time axis, the titles like VS Code ("README.md (abc1234d) ↔ README.md (fedcba98)", "a.ts ↔ b.ts", hint
//       with both paths);
//     - lib/diff-tab.ts: what writes (right in the comparison of two files, `current` on the renamed change), what re-reads live,
//       no blocks on a renamed unstaged change (the staged one keeps "revert"), the announcement "Renamed", which side goes where
//       (`comparisonContent`/`filesContent`: selected on the left, clicked on the right, each the file IN the commit), the label
//       with eight characters like the title;
//     - lib/tab-bar.ts `filesAddition`: files of the same name from different folders show the folders (VS Code `forceDescription`).
// (2) The sources: time axis and explorer show the group and call the computation, the connection opens through the same path as
//     the time axis (explorer pinned, time axis as preview), CodePane wires both and renames via `followRename`, the diff
//     component loads both comparisons, the switch re-reads both sides live, the chat holds the buffer via `writeFile` and forgets
//     drafts of renamed tabs.
//
// The selection is window-wide like VS Code `globalResourceToCompare`: it carries its target, the comparison of two files carries
// a target per side (`leftTarget`/`rightTarget`), each side follows a rename or delete in ITS target (through the mapping of the
// window — here `MAP`, in miniature), an event from another area pulls along only the comparisons (`onlyCompare`), and with two
// targets title, addition and label name the root per side (VS Code, multi-root window: "{root} • {path}").
// A comparison in the form from before targets (without targets) migrates lossless on load — both sides into the target of its
// tab or groups; key, active, preview, trail and the chat's draft move along (`comparisonMigration`, `migrateDrafts`,
// `migrateComparison`). A diff that would fall on rename stays with unsaved changes (chat and groups, as on delete). A save
// anywhere in the window re-reads the LEFT side of a comparison (`leftSaved`, canonical). A change of workspace clears the choice
// (`toWorkspace`).
//
// COUNTER-TESTS: each sabotage is a copy of the source with ONE changed spot (the spot occurs exactly once, otherwise the
// sabotage is stale); the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/comparison.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

// ── The sabotages ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SABOTAGES = {
  // lib/comparison.ts — a change of workspace clears the choice (VS Code reloads the window then).
  "workspace change keeps the choice": { file: "comparison.ts", old: "return { state: w.workspace === null ? w.state : NO_CHOICE, workspace: id };", fresh: "return { state: w.stand, workspace: id };", catches: "choice" },
  "first workspace clears the choice": { file: "comparison.ts", old: "return { state: w.workspace === null ? w.state : NO_CHOICE, workspace: id };", fresh: "return { stand: NO_CHOICE, workspace: id };", catches: "choice" },
  "unknown workspace clears the choice": { file: "comparison.ts", old: "if (id === null || id === w.workspace) return w;", fresh: "if (id === w.workspace) return w;", catches: "choice" },
  "same workspace yields a new state": { file: "comparison.ts", old: "if (id === null || id === w.workspace) return w;", fresh: "if (id === null) return w;", catches: "choice" },
  "explorer: sides swapped": { file: "comparison.ts", old: "left: s.file.path, right: path", fresh: "left: path, right: s.file.path", catches: "choice" },
  "explorer: left side in the target of the click": { file: "comparison.ts", old: "leftTarget: s.file.target, rightTarget: here", fresh: "leftTarget: here, rightTarget: here", catches: "choice" },
  "explorer: choice only in its own area": { file: "comparison.ts", old: "return s.file === null ? null :", fresh: "return s.file === null || !targetEqual(s.file.target, here) ? null :", catches: "choice" },
  "explorer: choice without its target": { file: "comparison.ts", old: "({ ...s, file: { target: here, path } })", fresh: "({ ...s, file: { target: { apiBase: \"\", instance: null }, path } })", catches: "choice" },
  "explorer: selection reversed": { file: "comparison.ts", old: "left: paths[0], right: paths[1]", fresh: "left: paths[1], right: paths[0]", catches: "choice" },
  "explorer: compare three selected": { file: "comparison.ts", old: "paths.length === 2 ?", fresh: "paths.length >= 2 ?", catches: "choice" },
  "time axis: another file compares": { file: "comparison.ts", old: "if (!g || !equal({ target: g.target, path: inRepo(g.repo, g.file) }, { target: here, path: inRepo(w.repo, w.file) })) return null;", fresh: "if (!g) return null;", catches: "choice" },
  "time axis: target of the choice forgotten": { file: "comparison.ts", old: "equal({ target: g.target, path:", fresh: "equal({ target: here, path:", catches: "choice" },
  "time axis: across areas without mapping": { file: "comparison.ts", old: "a.path === b.path && targetEqual(a.target, b.target)", fresh: "a.path === b.path", catches: "choice" },
  "time axis: sides swapped": { file: "comparison.ts", old: "left: { hash: g.hash, file: g.backThen }, right: { hash: w.hash, file: w.backThen }", fresh: "left: { hash: w.hash, file: w.backThen }, right: { hash: g.hash, file: g.backThen }", catches: "choice" },
  "time axis: today's name instead of then": { file: "comparison.ts", old: "left: { hash: g.hash, file: g.backThen }", fresh: "left: { hash: g.hash, file: g.file }", catches: "choice" },
  "time axis overwrites the explorer choice": { file: "comparison.ts", old: "({ ...s, timeAxis: { ...w, target: here } })", fresh: "({ file: null, timeAxis: { ...w, target: here } })", catches: "choice" },
  "current always": { file: "comparison.ts", old: "...(w.file !== w.backThen ? { current: w.file } : {}),", fresh: "current: w.file,", catches: "choice" },
  "time axis: order": { file: "comparison.ts", old: "[\"with-selection\", \"for-comparison\"]", fresh: "[\"for-comparison\", \"with-selection\"]", catches: "choice" },
  "time axis: compare without a choice": { file: "comparison.ts", old: "s.timeAxis ? [\"with-selection\", \"for-comparison\"] : [\"for-comparison\"]", fresh: "[\"with-selection\", \"for-comparison\"]", catches: "choice" },
  // lib/explorer-actions.ts
  "menu: comparison on folders": { file: "explorer-actions.ts", old: "if (k.comparison && k.target !== null && k.kind === \"file\") {", fresh: "if (k.comparison && k.target !== null) {", catches: "menu" },
  "menu: with selection at two": { file: "explorer-actions.ts", old: "if (k.comparison.selected && !double)", fresh: "if (k.comparison.selected)", catches: "menu" },
  "menu: select at two": { file: "explorer-actions.ts", old: "disabled.push({ action: double ? \"selection-compare\" : \"for-comparison\" }, \"separator\");", fresh: "disabled.push({ action: \"for-comparison\" }, \"separator\");", catches: "menu" },
  "menu: double means several": { file: "explorer-actions.ts", old: "const double = k.comparison.count === 2;", fresh: "const double = k.comparison.count > 1;", catches: "menu" },
  "menu: group behind cut": { file: "explorer-actions.ts", old: "  disabled.push(\"separator\");\n  // VS Code \"3_compare\"", fresh: "  disabled.push(\"separator\");\n  if (k.target !== null && k.comparison) out.push({ action: \"cut\" }, { action: \"copy\" }, \"separator\");\n  // VS Code \"3_compare\"", catches: "menu" },
  // lib/chat-tabs.ts — sources
  "source: hash unchecked": { file: "chat-tabs.ts", old: "if (!isObj(x) || typeof x.hash !== \"string\" || !/^[0-9a-f]{7,64}$/.test(x.hash)) return null;", fresh: "if (!isObj(x) || typeof x.hash !== \"string\") return null;", catches: "source" },
  "source: files with repo": { file: "chat-tabs.ts", old: "return repo === \"\" && pathValid(x.left)", fresh: "return pathValid(x.left)", catches: "source" },
  "source: files path unchecked": { file: "chat-tabs.ts", old: "pathValid(x.left) && pathValid(x.right) && leftTarget", fresh: "typeof x.left === \"string\" && typeof x.right === \"string\" && leftTarget", catches: "source" },
  "source: target unchecked": { file: "chat-tabs.ts", old: "const leftTarget = prior ?? checkTarget(x.leftTarget),", fresh: "const leftTarget = prior ?? (x.leftTarget ?? null) as TabTarget | null,", catches: "source" },
  "source: old form without target of the tab stays": { file: "chat-tabs.ts", old: "const leftTarget = prior ?? checkTarget(x.leftTarget), rightTarget = prior ?? checkTarget(x.rightTarget);", fresh: "const leftTarget = prior ?? checkTarget(x.leftTarget) ?? { apiBase: \"/api/workspaces/w1\", instance: null }, rightTarget = prior ?? checkTarget(x.rightTarget) ?? { apiBase: \"/api/workspaces/w1\", instance: null };", catches: "source" },
  // A comparison from before targets migrates lossless (target of the tab, key, active/preview/trail, draft).
  "migration: old form dropped": { file: "chat-tabs.ts", old: "const prior = x.leftTarget === undefined && x.rightTarget === undefined && beforeW ? checkTarget(beforeW) : null;", fresh: "const prior = null as TabTarget | null;", catches: "source" },
  "migration: half form migrates": { file: "chat-tabs.ts", old: "x.leftTarget === undefined && x.rightTarget === undefined && beforeW", fresh: "x.rightTarget === undefined && beforeW", catches: "source" },
  "migration: the tab does not pass its target on": { file: "chat-tabs.ts", old: "checkSource(x.source, target)", fresh: "checkSource(x.source)", catches: "source" },
  "migration: active stays on the old key": { file: "chat-tabs.ts", old: "active: today(o.active), ", fresh: "active: o.active, ", catches: "source" },
  "migration: preview stays on the old key": { file: "chat-tabs.ts", old: "preview: today(o.preview), ", fresh: "preview: o.preview, ", catches: "source" },
  "migration: trail stays on the old key": { file: "chat-tabs.ts", old: "...(Array.isArray(o.last) ? { last: o.last.map(today) } : {})", fresh: "", catches: "source" },
  "migration: old key computed wrong": { file: "chat-tabs.ts", old: "\"files\", t.source.left, t.source.right]", fresh: "\"files\", t.source.right, t.source.left]", catches: "source" },
  "migration: draft overwrites a new one": { file: "chat-tabs.ts", old: " || sp.read(draftKey(chatKey, fresh)) !== null", fresh: "", catches: "source" },
  "migration: draft stays twice": { file: "chat-tabs.ts", old: "{ sp.write(draftKey(chatKey, old), null); n++; }", fresh: "{ n++; }", catches: "source" },
  "migration: draft gone despite full storage": { file: "chat-tabs.ts", old: "if (sp.write(draftKey(chatKey, fresh), e)) {", fresh: "sp.write(draftKey(chatKey, fresh), e); {", catches: "source" },
  "source: current without path check": { file: "chat-tabs.ts", old: "!pathValid(x.current) ? false :", fresh: "typeof x.current !== \"string\" ? false :", catches: "source" },
  "source: current equal stays": { file: "chat-tabs.ts", old: "x.current === equal ? null : x.current", fresh: "x.current", catches: "source" },
  "key: comparison without left": { file: "chat-tabs.ts", old: "case \"comparison\": return [q.kind, q.repo, q.left.hash, q.left.file, q.right.hash", fresh: "case \"comparison\": return [q.kind, q.repo, q.right.hash", catches: "source" },
  "key: files undirected": { file: "chat-tabs.ts", old: "case \"files\": return [q.kind, q.left, q.right, ", fresh: "case \"files\": return [q.kind, ...[q.left, q.right].sort(), ", catches: "source" },
  "key: files without targets": { file: "chat-tabs.ts", old: "q.right, q.leftTarget.apiBase, q.leftTarget.instance ?? \"\", q.rightTarget.apiBase, q.rightTarget.instance ?? \"\"]", fresh: "q.right]", catches: "source" },
  "key: targets interchangeable": { file: "chat-tabs.ts", old: "q.leftTarget.apiBase, q.leftTarget.instance ?? \"\", q.rightTarget.apiBase, q.rightTarget.instance ?? \"\"]", fresh: "...[q.leftTarget.apiBase + (q.leftTarget.instance ?? \"\"), q.rightTarget.apiBase + (q.rightTarget.instance ?? \"\")].sort()]", catches: "source" },
  "key: change without current": { file: "chat-tabs.ts", old: "q.staged ? 1 : 0, ...(q.current ? [q.current] : [])]", fresh: "q.staged ? 1 : 0]", catches: "source" },
  "path: comparison to right then": { file: "chat-tabs.ts", old: "case \"comparison\": return q.current ?? q.right.file;", fresh: "case \"comparison\": return q.right.file;", catches: "source" },
  // lib/chat-tabs.ts — rename and delete
  "diff does not follow in the chat": { file: "chat-tabs.ts", old: "        else if (q !== t.source) n = { ...t, source: q };", fresh: "", catches: "rename" },
  "comparison does not follow in the chat": { file: "chat-tabs.ts", old: "\n      else if (q !== t.source) n = { ...t, source: q };", fresh: "", catches: "rename" },
  "chat: comparison only in the target of its tab": { file: "chat-tabs.ts", old: "    if (t.kind === \"diff\" && t.source.kind === \"files\") {", fresh: "    if (t.kind === \"diff\" && t.source.kind === \"files\" && targetEqual(t.target, target)) {", catches: "rename" },
  "chat: foreign rename pulls everything": { file: "chat-tabs.ts", old: "} else if (!o.onlyCompare && targetEqual(t.target, target)) {", fresh: "} else if (targetEqual(t.target, target)) {", catches: "rename" },
  "chat: unchanged yields a new state": { file: "chat-tabs.ts", old: "  if (!changed && !fallen.length) return state;\n", fresh: "", catches: "rename" },
  "falling diff stays in the chat": { file: "chat-tabs.ts", old: "  for (const k of fallen) s = close(s, k);\n", fresh: "", catches: "rename" },
  "repo does not move": { file: "chat-tabs.ts", old: "if (repo !== q.repo) return checkSource({ ...q, repo }) ?? q;", fresh: "if (repo !== q.repo) return q;", catches: "rename" },
  "out of the repo everything stays": { file: "chat-tabs.ts", old: "if (rel === null) return sourceFalls(q, (p) => p === full, location) ? null : q;", fresh: "if (rel === null) return q;", catches: "rename" },
  "repo prefix without slash": { file: "chat-tabs.ts", old: "fresh.startsWith(`${repo}/`) ? fresh.slice(repo.length + 1)", fresh: "fresh.startsWith(repo) ? fresh.slice(repo.length + 1)", catches: "rename" },
  "comparison of two files: left only": { file: "chat-tabs.ts", old: "const left = page(q.leftTarget, q.left), right = page(q.rightTarget, q.right);", fresh: "const left = page(q.leftTarget, q.left), right = undefined as string | null | undefined;", catches: "rename" },
  "comparison: side not mapped back into its target": { file: "chat-tabs.ts", old: "return n === here ? undefined : mapPath(location.target, n, z);", fresh: "return n === here ? undefined : n;", catches: "rename" },
  "comparison: foreign side without mapping": { file: "chat-tabs.ts", old: "      const here = mapPath(z, p, location.target);\n      if (here === null) return undefined;", fresh: "      const here = p;", catches: "rename" },
  "comparison: side leaves its target and stays": { file: "chat-tabs.ts", old: "    if (left === null || right === null) return null;\n", fresh: "", catches: "rename" },
  "rename does not know current": { file: "chat-tabs.ts", old: "case \"change\": case \"commit\": return q.current ?? q.file;", fresh: "case \"change\": case \"commit\": return q.file;", catches: "rename" },
  "delete hits the index": { file: "chat-tabs.ts", old: "return q.kind === \"change\" && !q.staged && hits(", fresh: "return q.kind === \"change\" && hits(", catches: "rename" },
  "delete of the comparison on the right only": { file: "chat-tabs.ts", old: "return hitsPage(q.leftTarget, q.left) || hitsPage(q.rightTarget, q.right);", fresh: "return hitsPage(q.rightTarget, q.right);", catches: "rename" },
  "delete hits the side of another target": { file: "chat-tabs.ts", old: "const here = mapPath(z, p, location.target); return here !== null && hits(here);", fresh: "return hits(p);", catches: "rename" },
  "delete ignores current": { file: "chat-tabs.ts", old: "hits(inRepo(q.repo, q.current ?? q.file))", fresh: "hits(inRepo(q.repo, q.file))", catches: "rename" },
  "delete in the chat without diffs": { file: "chat-tabs.ts", old: "t.kind === \"diff\" ? sourceFalls(t.source, (p) => under(p, path), location) && diffFalls(key(t)) : ", fresh: "t.kind === \"diff\" ? false : ", catches: "rename" },
  "chat delete: comparison only in the target of its tab": { file: "chat-tabs.ts", old: "const comparison = t.kind === \"diff\" && t.source.kind === \"files\";", fresh: "const comparison = false;", catches: "rename" },
  "chat delete: foreign delete hits everything": { file: "chat-tabs.ts", old: "if (!comparison && (o.onlyCompare || !targetEqual(t.target, target))) continue;", fresh: "if (!comparison && !targetEqual(t.target, target)) continue;", catches: "rename" },
  "delete in the chat does not ask the caller": { file: "chat-tabs.ts", old: " && diffFalls(key(t))", fresh: "", catches: "rename" },
  // A diff that would fall on rename stays with unsaved changes.
  "chat: comparison falls on rename despite unsaved changes": { file: "chat-tabs.ts", old: "      if (q === null) { if (!o.unsaved?.(prior)) fallen.push(prior); }\n      else if (q !== t.source) n = { ...t, source: q };\n    } else if (!o.onlyCompare", fresh: "      if (q === null) fallen.push(prior);\n      else if (q !== t.source) n = { ...t, source: q };\n    } else if (!o.onlyCompare", catches: "rename" },
  "chat: diff falls on rename despite unsaved changes": { file: "chat-tabs.ts", old: "        if (q === null) { if (!o.unsaved?.(prior)) fallen.push(prior); }\n        else", fresh: "        if (q === null) fallen.push(prior);\n        else", catches: "rename" },
  // lib/editor-inputs.ts
  "groups: falling diff stays": { file: "editor-inputs.ts", old: "return G.formPaths(G.remove(s, falls), ", fresh: "return G.formPaths(s, ", catches: "inputs" },
  "groups: diff does not follow": { file: "editor-inputs.ts", old: "return q === null || q === e.source ? k : diffKey(q, e.title);", fresh: "return k;", catches: "inputs" },
  "groups: foreign rename pulls everything": { file: "editor-inputs.ts", old: "if (!e || (onlyCompare && !isComparison(e))) return k;", fresh: "if (!e) return k;", catches: "inputs" },
  "groups: foreign rename closes diffs": { file: "editor-inputs.ts", old: "(!onlyCompare || isComparison(e)) && renameSource", fresh: "renameSource", catches: "inputs" },
  "groups: foreign delete hits everything": { file: "editor-inputs.ts", old: "if (e === null || (onlyCompare && !isComparison(e))) return false;", fresh: "if (e === null) return false;", catches: "inputs" },
  "groups: rename without location": { file: "editor-inputs.ts", old: "formKey(form, location, onlyCompare));", fresh: "formKey(form, { target: location.target }, onlyCompare));", catches: "inputs" },
  "groups: delete without comparison": { file: "editor-inputs.ts", old: "e.kind === \"diff\" ? sourceFalls(e.source, hits, location) && !unsaved(k) : hits(e.path)", fresh: "e.kind === \"diff\" ? false : hits(e.path)", catches: "inputs" },
  "groups: delete closes unsaved changes": { file: "editor-inputs.ts", old: " && !unsaved(k) : hits(e.path)", fresh: " : hits(e.path)", catches: "inputs" },
  "groups: rename closes unsaved changes": { file: "editor-inputs.ts", old: "renameSource(e.source, form, location) === null && !unsaved(k); };", fresh: "renameSource(e.source, form, location) === null; };", catches: "inputs" },
  // A remembered comparison from before targets migrates into the target of the groups.
  "groups: old form does not migrate": { file: "editor-inputs.ts", old: "return q?.kind === \"files\" ? diffKey(q) : k;", fresh: "return k;", catches: "inputs" },
  "groups: migration without target of the groups": { file: "editor-inputs.ts", old: "const q = checkSource(o?.q, target);", fresh: "const q = checkSource(o?.q);", catches: "inputs" },
  "groups: migration only in the key, not in the group": { file: "editor-inputs.ts", old: "G.formPaths(s, (k) => migrateComparison(k, target))", fresh: "s", catches: "inputs" },
  "groups: gone from outside closes diffs": { file: "editor-inputs.ts", old: "return e !== null && e.kind !== \"diff\" && hits(e.path);", fresh: "return e !== null && (e.kind === \"diff\" ? sourceFalls(e.source, hits, { target: { apiBase: \"\", instance: null } }) : hits(e.path));", catches: "inputs" },
  "title: comparison without left ref": { file: "editor-inputs.ts", old: "`${n} (${shortRef(q.left.hash)}) ↔ ${n} (${shortRef(q.right.hash)})`", fresh: "`${n} ↔ ${n} (${shortRef(q.right.hash)})`", catches: "inputs" },
  "title: comparison by the old name": { file: "editor-inputs.ts", old: "const n = baseName(q.current ?? q.right.file);", fresh: "const n = baseName(q.right.file);", catches: "inputs" },
  "title: files with path": { file: "editor-inputs.ts", old: "`${baseName(q.left)} ↔ ${baseName(q.right)}`", fresh: "`${q.left} ↔ ${q.right}`", catches: "inputs" },
  "hint: files without both paths": { file: "editor-inputs.ts", old: "hint: `${page(q.leftTarget, q.left)} ↔ ${page(q.rightTarget, q.right)}`", fresh: "hint: page(q.rightTarget, q.right)", catches: "inputs" },
  "hint: two targets without root": { file: "editor-inputs.ts", old: "(two ? withRoot(root(z), p) : p)", fresh: "(two ? p : p)", catches: "inputs" },
  "hint: root also in one target": { file: "editor-inputs.ts", old: "const q = e.source, two = twoRoots(q);", fresh: "const q = e.source, two = true;", catches: "inputs" },
  "title: renamed change keeps the old name": { file: "editor-inputs.ts", old: "const name = baseName(q.current ?? q.file);", fresh: "const name = baseName(q.file);", catches: "inputs" },
  "buffer: comparison without buffer": { file: "editor-inputs.ts", old: "  return writeFile(e.source);\n}", fresh: "  return e.source.kind === \"change\" && !e.source.staged ? diffFile(e.source) : null;\n}", catches: "inputs" },
  // lib/diff-tab.ts
  "diff: comparison of two files read-only": { file: "diff-tab.ts", old: "return (q.kind === \"change\" && !q.staged) || q.kind === \"files\";", fresh: "return q.kind === \"change\" && !q.staged;", catches: "diffTab" },
  "diff: writes to the old name": { file: "diff-tab.ts", old: "targetPath(q.repo, q.current ?? q.file) : null;", fresh: "targetPath(q.repo, q.file) : null;", catches: "diffTab" },
  "diff: writes left": { file: "diff-tab.ts", old: "if (q.kind === \"files\") return q.right;", fresh: "if (q.kind === \"files\") return q.left;", catches: "diffTab" },
  "diff: blocks on the renamed one": { file: "diff-tab.ts", old: "if (q.kind !== \"change\" || (q.current && !q.staged)) return [];", fresh: "if (q.kind !== \"change\") return [];", catches: "diffTab" },
  "diff: staged renamed one without revert": { file: "diff-tab.ts", old: "(q.current && !q.staged)", fresh: "q.current", catches: "diffTab" },
  "diff: comparison shows the parent state": { file: "diff-tab.ts", old: "prior: l.after, after: r.after", fresh: "prior: l.prior, after: r.after", catches: "diffTab" },
  "diff: comparison right is the parent state": { file: "diff-tab.ts", old: "after: r.after };", fresh: "after: r.prior };", catches: "diffTab" },
  "diff: comparison swapped": { file: "diff-tab.ts", old: "const [l, r] = await Promise.all([read(left), read(right)]);\n  if (!l || !r) return null;", fresh: "const [r, l] = await Promise.all([read(left), read(right)]);\n  if (!l || !r) return null;", catches: "diffTab" },
  "diff: files swapped": { file: "diff-tab.ts", old: "const [l, r] = await Promise.all([read(left), read(right)]);\n  const prior", fresh: "const [r, l] = await Promise.all([read(left), read(right)]);\n  const prior", catches: "diffTab" },
  "diff: unknown side as empty": { file: "diff-tab.ts", old: "  if (!l || !r) return null;\n  return { diff: \"\", clipped: false, prior: l.after", fresh: "  if (!l && !r) return null;\n  return { diff: \"\", clipped: false, prior: l?.after ?? { kind: \"missing\" }", catches: "diffTab" },
  "diff: follows right only": { file: "diff-tab.ts", old: "return q.left === q.right ? [q.left] : [q.left, q.right];", fresh: "return [q.right];", catches: "diffTab" },
  "diff: locations in the target of the tab": { file: "diff-tab.ts", old: "const l = { target: q.leftTarget, path: q.left }", fresh: "const l = { target, path: q.left }", catches: "diffTab" },
  "diff: same paths of two targets merged": { file: "diff-tab.ts", old: "targetEqual(l.target, r.target) && l.path === r.path ? [r] : [l, r]", fresh: "l.path === r.path ? [r] : [l, r]", catches: "diffTab" },
  "diff: label without root": { file: "diff-tab.ts", old: "file: twoRoots(q) ? withRoot(root(q.leftTarget), q.left) : q.left", fresh: "file: q.left", catches: "diffTab" },
  "diff: follows the old file": { file: "diff-tab.ts", old: "return q.kind === \"change\" ? [targetPath(q.repo, q.current ?? q.file)] : [];", fresh: "return q.kind === \"change\" ? [targetPath(q.repo, q.file)] : [];", catches: "diffTab" },
  "diff: renamed without announcement": { file: "diff-tab.ts", old: "  else if (e.source.kind === \"change\" && e.source.current) announcements.push(", fresh: "  else if (false) announcements.push(", catches: "diffTab" },
  "diff: label of the comparison without left": { file: "diff-tab.ts", old: "values: { left: q.left.hash.slice(0, 8), right: q.right.hash.slice(0, 8) }", fresh: "values: { left: \"\", right: q.right.hash.slice(0, 8) }", catches: "diffTab" },
  "diff: label shorter than the title": { file: "diff-tab.ts", old: "left: q.left.hash.slice(0, 8)", fresh: "left: q.left.hash.slice(0, 7)", catches: "diffTab" },
  // A save in the window re-reads the LEFT side of a comparison — canonical, not by target.
  "diff: save hits right instead of left": { file: "diff-tab.ts", old: "equal({ target: q.leftTarget, path: q.left }, saved)", fresh: "equal({ target: q.rightTarget, path: q.right }, saved)", catches: "diffTab" },
  "diff: save only in the same target": { file: "diff-tab.ts", old: "equal({ target: q.leftTarget, path: q.left }, saved)", fresh: "targetEqual(q.leftTarget, saved.target) && q.left === saved.path", catches: "diffTab" },
  "diff: save hits every source": { file: "diff-tab.ts", old: "return q.kind === \"files\" && equal(", fresh: "return equal(", catches: "diffTab" },
  // lib/tab-bar.ts (files of the same name from different folders)
  "addition for different names": { file: "tab-bar.ts", old: " || l[l.length - 1] !== r[r.length - 1]) return undefined;", fresh: ") return undefined;", catches: "addition" },
  "addition without shortening": { file: "tab-bar.ts", old: "const [keysA, keysB] = truncate([a, b]);", fresh: "const [keysA, keysB] = [a, b];", catches: "addition" },
  "addition at the root": { file: "tab-bar.ts", old: "if (!a || !b || a === b) return undefined;", fresh: "if (a === b) return undefined;", catches: "addition" },
  "addition on the right only": { file: "tab-bar.ts", old: "return keysA === keysB ? keysA : `${keysA} - ${keysB}`;", fresh: "return keysB;", catches: "addition" },
  "addition of two targets without root": { file: "tab-bar.ts", old: "  const two = twoRoots(q);\n", fresh: "  const two = false;\n", catches: "addition" },
  "addition: right root taken from left": { file: "tab-bar.ts", old: "withRoot(root(q.rightTarget), r.slice(0, -1).join(\"/\"))", fresh: "withRoot(root(q.leftTarget), r.slice(0, -1).join(\"/\"))", catches: "addition" },
};

// ── Compile (like web/test/editor-inputs.test.mjs: the real neighbors, one copy per sabotage, ONE tsc run) ──
const LIB = ["comparison.ts", "explorer-actions.ts", "explorer-tree.ts", "editor-inputs.ts", "chat-tabs.ts", "editor-groups.ts", "md-preview.ts", "timeAxis.ts", "diff-tab.ts", "tab-bar.ts", "explorer-decoration.ts", "commandPalette.ts", "editor-raster.ts"];
const SOURCES = Object.fromEntries(LIB.map((d) => [d, read("src", "lib", d)]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-comparison-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
for (const d of LIB) fs.writeFileSync(path.join(src, d), SOURCES[d]);
fs.writeFileSync(path.join(src, "api", "lsp.ts"), read("src", "lib", "api", "lsp.ts"));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in the test: ${p}`); }\n");
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `${s.file.replace(/\.ts$/, "")}-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCES[s.file].replace(s.old, s.fresh));
  copies.push({ name, file, source: s.file, catches: s.catches, places: SOURCES[s.file].split(s.old).length - 1 });
}
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...files(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "comparison.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = {
  V: await load("comparison.ts"), X: await load("explorer-actions.ts"), E: await load("editor-inputs.ts"), C: await load("chat-tabs.ts"), G: await load("editor-groups.ts"),
  D: await load("diff-tab.ts"), T: await load("tab-bar.ts"), Zt: await load("timeAxis.ts"),
};
const ROLE = { "comparison.ts": "V", "explorer-actions.ts": "X", "editor-inputs.ts": "E", "chat-tabs.ts": "C", "diff-tab.ts": "D", "tab-bar.ts": "T" };
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, m: { ...real, [ROLE[k.source]]: await load(k.file) } })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// ── The checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const t = (k, w) => (w ? k.replace(/\{(\w+)\}/g, (_, x) => String(w[x])) : k);
const H = "abc1234def5678abc1234def5678abc1234def56", H2 = "fedcba9876543210fedcba9876543210fedcba98";
const Z = { apiBase: "/api/workspaces/w1", instance: null }, Z2 = { apiBase: "/api/projects/p1", instance: null };
const L = (id, paths, active = paths[0] ?? null) => ({ id, paths, active, preview: null });
const S = (groups, active = groups[0].id) => ({ groups, active, ratio: 0.5 });
const AE = (file, staged = false, repo = "web", current) => ({ kind: "change", repo, file, staged, ...(current ? { current } : {}) });
const VG = (o = {}) => ({ kind: "comparison", repo: "web", left: { hash: H2, file: "README.md" }, right: { hash: H, file: "README.md" }, ...o });
const FILES = (left, right, leftTarget = Z, rightTarget = Z) => ({ kind: "files", repo: "", left, right, leftTarget, rightTarget });
// Z2 (project p1) lies in workspace Z under "proj/" — the mapping of the window (components/code/comparison-connection.ts
// `mapInWindow`, via lib/buffer-coordinates.ts) in miniature; a path outside "proj/" is not in the project.
const groupRows = (a, b) => a.apiBase === b.apiBase && a.instance === b.instance;
const MAP = (from, p, next) => (groupRows(from, next) ? p : groupRows(from, Z2) && groupRows(next, Z) ? `proj/${p}` : groupRows(from, Z) && groupRows(next, Z2) && p.startsWith("proj/") ? p.slice(5) : null);
const NAME = (z) => (groupRows(z, Z2) ? "ORBIT" : groupRows(z, Z) ? "Lawfirm" : "?");
const renaming = (old, fresh) => (p) => (p === old ? fresh : p.startsWith(`${old}/`) ? fresh + p.slice(old.length) : p);
const planOf = (X, k) => X.menuPlan({ target: "src/a.ts", kind: "file", several: false, clipboard: false, terminal: false, ...k }).map((p) => (p === "separator" ? "|" : p.action));
const REST = ["cut", "copy", "|", "path", "relative", "|", "rename", "erase", "|", "download"];

const CHECKS = {
  choice: ({ V }) => {
    const empty = V.NO_CHOICE;
    assert.deepEqual(empty, { file: null, timeAxis: null });
    assert.equal(V.withSelectedFile(empty, Z, "b.ts"), null, "without a choice no comparison");
    const a = V.fileForComparison(empty, Z, "src/a.ts");
    assert.deepEqual(a.file, { target: Z, path: "src/a.ts" }, "the choice carries its target");
    assert.deepEqual(V.withSelectedFile(a, Z, "lib/b.ts"), FILES("src/a.ts", "lib/b.ts"), "selected on the left, clicked on the right (VS Code compareFiles)");
    assert.deepEqual(V.withSelectedFile(a, Z, "src/a.ts"), FILES("src/a.ts", "src/a.ts"), "VS Code also compares the file with itself");
    // Window-wide like VS Code `globalResourceToCompare` — selected in one area, compared in another: each side in ITS target.
    assert.deepEqual(V.withSelectedFile(a, Z2, "lib/b.ts"), FILES("src/a.ts", "lib/b.ts", Z, Z2), "across areas: left from the target of the choice, right from the click's");
    assert.deepEqual(V.selectedCompare(Z2, ["x.ts", "a.ts"]), FILES("x.ts", "a.ts", Z2, Z2), "in selection order (VS Code compareSelected), in the target of the area");
    assert.equal(V.selectedCompare(Z, ["a.ts"]), null); assert.equal(V.selectedCompare(Z, ["a.ts", "b.ts", "c.ts"]), null, "exactly two only");
    // Time axis: a choice of its own (two context keys).
    const w1 = { repo: "web", file: "docs/fresh.md", hash: H2, backThen: "old.md" }, w2 = { repo: "web", file: "docs/fresh.md", hash: H, backThen: "docs/fresh.md" };
    const z = V.entryForComparison(a, Z, w1);
    assert.deepEqual(z.file, { target: Z, path: "src/a.ts" }, "the time axis choice leaves the explorer's alone");
    assert.deepEqual(z.timeAxis, { ...w1, target: Z }, "the entry carries its target");
    assert.deepEqual(V.fileForComparison(z, Z, "b.ts").timeAxis, { ...w1, target: Z }, "… and vice versa");
    assert.equal(V.withSelectedEntry(a, Z, w2), null, "without a time axis choice no comparison");
    assert.deepEqual(V.withSelectedEntry(z, Z, w2), { kind: "comparison", repo: "web", left: { hash: H2, file: "old.md" }, right: { hash: H, file: "docs/fresh.md" } },
      "left the selected entry with its name back then, right the clicked one; if it is called today like the right one: without `current`");
    const w3 = { ...w1, hash: H }, z2 = V.entryForComparison(empty, Z, { ...w2, hash: H2 });
    assert.deepEqual(V.withSelectedEntry(z2, Z, w3), { kind: "comparison", repo: "web", left: { hash: H2, file: "docs/fresh.md" }, right: { hash: H, file: "old.md" }, current: "docs/fresh.md" }, "right under the old name: `current` is the file today");
    assert.equal(V.withSelectedEntry(z, Z, { ...w2, file: "different.md" }), null, "an entry of ANOTHER file: nothing (VS Code compares the Uri)");
    assert.equal(V.withSelectedEntry(z, Z, { ...w2, repo: "app" }), null, "… also in another repo");
    // The same file from another area — without mapping the same path in another target is another file; with the window's
    // mapping the file in the project and on the workspace level is ONE.
    assert.equal(V.withSelectedEntry(z, Z2, w2), null, "without mapping: another target is another file");
    const zP = V.entryForComparison(empty, Z2, { ...w1, repo: "" }), inWs = { ...w2, repo: "proj" };
    const equal = (x, y) => MAP(x.target, x.path, y.target) === y.path;
    assert.deepEqual(V.withSelectedEntry(zP, Z, inWs, equal), { kind: "comparison", repo: "proj", left: { hash: H2, file: "old.md" }, right: { hash: H, file: "docs/fresh.md" } },
      "selected in the project, compared on the workspace level: the same file");
    const asked = [];
    V.withSelectedEntry(zP, Z, inWs, (x, y) => { asked.push(x, y); return false; });
    assert.deepEqual(asked, [{ target: Z2, path: "docs/fresh.md" }, { target: Z, path: "proj/docs/fresh.md" }], "asked with target and path relative to the root — the choice first");
    assert.deepEqual(V.timeAxisPlan(empty), ["for-comparison"], "without a choice only \"Select for Compare\"");
    assert.deepEqual(V.timeAxisPlan(a), ["for-comparison"], "the explorer's choice does not count in the time axis");
    assert.deepEqual(V.timeAxisPlan(z), ["with-selection", "for-comparison"], "VS Code: compareWithSelected @1, selectForCompare @2");
    // The choice belongs to the workspace the window shows — VS Code reloads the window on a change, the choice is gone. Before
    // reading, the workspace is merely unknown (empty is not unknown): the first known one keeps what was already chosen.
    const wv = V.toWorkspace({ state: a, workspace: null }, "w1");
    assert.deepEqual(wv, { state: a, workspace: "w1" }, "the first known workspace keeps the choice");
    assert.equal(V.toWorkspace(wv, "w1"), wv, "same workspace: same state");
    assert.equal(V.toWorkspace(wv, null), wv, "unknown (the page is still reading): nothing changes");
    assert.deepEqual(V.toWorkspace(wv, "w2"), { state: empty, workspace: "w2" }, "another workspace clears the choice");
  },
  menu: ({ X }) => {
    assert.deepEqual(planOf(X, {}), REST, "without a comparison no group");
    assert.deepEqual(planOf(X, { comparison: { selected: false, count: 1 } }), ["for-comparison", "|", ...REST], "\"3_compare\" before \"5_cutcopypaste\"");
    assert.deepEqual(planOf(X, { comparison: { selected: true, count: 1 } }), ["comparison-with-selection", "for-comparison", "|", ...REST], "compareFiles @20 before selectForCompare @30");
    assert.deepEqual(planOf(X, { several: true, comparison: { selected: true, count: 2 } }).slice(0, 2), ["selection-compare", "|"], "exactly two: only \"Compare Selected\"");
    assert.deepEqual(planOf(X, { several: true, comparison: { selected: true, count: 3 } }).slice(0, 3), ["comparison-with-selection", "for-comparison", "|"], "three: like one (listDoubleSelection is EXACTLY two)");
    assert.deepEqual(planOf(X, { beside: true, comparison: { selected: false, count: 1 } }).slice(0, 4), ["to-page", "|", "for-comparison", "|"], "after \"navigation\"");
    const folder = X.menuPlan({ target: "src", kind: "dir", several: false, clipboard: false, terminal: false, comparison: { selected: true, count: 1 } }).map((p) => (p === "separator" ? "|" : p.action));
    assert.ok(!folder.some((p) => /compar/.test(p)), "no comparison on a folder (`!explorerResourceIsFolder`)");
    const root = X.menuPlan({ target: null, kind: "dir", several: false, clipboard: false, terminal: false, comparison: { selected: true, count: 0 } }).map((p) => (p === "separator" ? "|" : p.action));
    assert.ok(!root.some((p) => /compar/.test(p)), "no comparison on the empty area");
  },
  source: ({ C }) => {
    const v = VG({ current: "docs/README.md" });
    assert.deepEqual(C.checkSource({ current: "docs/README.md", right: { file: "README.md", hash: H }, left: { file: "README.md", hash: H2 }, repo: "web", kind: "comparison" }), v, "foreign text in a fixed form");
    assert.deepEqual(Object.keys(C.checkSource(v)), ["kind", "repo", "left", "right", "current"], "fixed order");
    assert.deepEqual(C.checkSource(VG({ current: "README.md" })), VG(), "if it is called today like the right one: without `current`");
    for (const broken of [VG({ left: { hash: "HEAD", file: "a" } }), VG({ right: { hash: H } }), VG({ current: "../x" }), VG({ left: null })]) assert.equal(C.checkSource(broken), null, JSON.stringify(broken));
    assert.deepEqual(C.checkSource({ rightTarget: Z, right: "b.ts", leftTarget: Z2, left: "src/a.ts", repo: "", kind: "files" }), FILES("src/a.ts", "b.ts", Z2, Z), "each side its target");
    assert.deepEqual(Object.keys(C.checkSource(FILES("a.ts", "b.ts"))), ["kind", "repo", "left", "right", "leftTarget", "rightTarget"], "fixed order");
    // A remembered comparison in the form before targets (without targets) migrates — back then both sides lay in the target of its tab.
    const oldQ = { kind: "files", repo: "", left: "a.ts", right: "b.ts" };
    assert.equal(C.checkSource(oldQ), null, "without the target of the tab the old form cannot be read");
    assert.deepEqual(C.checkSource(oldQ, Z2), FILES("a.ts", "b.ts", Z2, Z2), "with the target of the tab: both sides there");
    assert.equal(C.checkSource({ ...oldQ, leftTarget: Z }, Z2), null, "half (one side with a target) is broken, not old — empty is not unknown");
    assert.equal(C.checkSource({ ...oldQ, rightTarget: Z }, Z2), null, "… also on the right");
    assert.deepEqual(C.checkSource(FILES("a.ts", "b.ts", Z, Z), Z2), FILES("a.ts", "b.ts"), "today's form keeps its targets");
    assert.equal(C.checkSource(oldQ, { apiBase: "/x", instance: null }), null, "a foreign route does not migrate");
    // … together with key, active, preview and trail (`readStatus` via `comparisonMigration`) and the draft (`migrateDrafts`).
    const oldK = (l, r) => `diff:${JSON.stringify([Z2.apiBase, "", "files", l, r])}`, newK = (l, r) => C.key({ kind: "diff", target: Z2, source: FILES(l, r, Z2, Z2) });
    const raw = JSON.stringify({ v: 1, tabs: [{ kind: "diff", target: Z2, source: oldQ }, { kind: "diff", target: Z2, source: { ...oldQ, left: "c.ts", right: "d.ts" } }, { kind: "file", target: Z2, path: "x.ts" }],
      active: oldK("a.ts", "b.ts"), preview: oldK("c.ts", "d.ts"), views: [], last: [oldK("c.ts", "d.ts"), oldK("a.ts", "b.ts")] });
    const read = C.readStatus(raw);
    assert.deepEqual(read.tabs.map((x) => C.key(x)), [newK("a.ts", "b.ts"), newK("c.ts", "d.ts"), C.fileKey(Z2, "x.ts")], "the old comparisons are there with their targets");
    assert.equal(read.active, newK("a.ts", "b.ts"), "front stays front");
    assert.equal(read.preview, newK("c.ts", "d.ts"), "the preview stays the preview");
    assert.deepEqual(read.last, [newK("c.ts", "d.ts"), newK("a.ts", "b.ts")], "the trail keeps them");
    assert.deepEqual([...C.comparisonMigration(raw)], [[oldK("a.ts", "b.ts"), newK("a.ts", "b.ts")], [oldK("c.ts", "d.ts"), newK("c.ts", "d.ts")]], "old → new, only the old form");
    assert.equal(C.comparisonMigration(C.writeStatus(read)).size, 0, "today's form does not migrate");
    assert.equal(C.comparisonMigration("{broken").size, 0); assert.equal(C.comparisonMigration(null).size, 0);
    const ek = (k) => C.draftKey("c1", k);
    const sp = new Map([[ek(oldK("a.ts", "b.ts")), "E1"], [ek(oldK("c.ts", "d.ts")), "E2"], [ek(newK("c.ts", "d.ts")), "already there"]]);
    const access = (m, full = false) => ({ read: (k) => m.get(k) ?? null, write: (k, v) => { if (v === null) { m.delete(k); return true; } if (full) return false; m.set(k, v); return true; } });
    assert.equal(C.migrateDrafts("c1", raw, access(sp)), 1, "one draft migrates");
    assert.equal(sp.get(ek(newK("a.ts", "b.ts"))), "E1", "… under the new key");
    assert.equal(sp.has(ek(oldK("a.ts", "b.ts"))), false, "… and does not lie twice");
    assert.equal(sp.get(ek(newK("c.ts", "d.ts"))), "already there", "a new one is not overwritten");
    assert.equal(sp.get(ek(oldK("c.ts", "d.ts"))), "E2", "… the old one then stays where it is");
    const full = new Map([[ek(oldK("a.ts", "b.ts")), "E1"]]);
    assert.equal(C.migrateDrafts("c1", raw, access(full, true)), 0, "full storage: nothing migrates");
    assert.equal(full.get(ek(oldK("a.ts", "b.ts"))), "E1", "… and the old draft stays");
    for (const broken of [{ ...FILES("a.ts", "b.ts"), repo: "web" }, FILES("../a.ts", "b.ts"), FILES("a.ts", "/b.ts"), { kind: "files", repo: "", left: "a.ts", leftTarget: Z, rightTarget: Z },
      FILES("a.ts", "b.ts", { apiBase: "/x", instance: null }), FILES("a.ts", "b.ts", Z, { apiBase: "/api/projects/p1" })]) assert.equal(C.checkSource(broken), null, JSON.stringify(broken));
    assert.deepEqual(C.checkSource(AE("a.ts", false, "web", "b.ts")), AE("a.ts", false, "web", "b.ts"), "the renamed change carries `current`");
    assert.deepEqual(C.checkSource(AE("a.ts", false, "web", "a.ts")), AE("a.ts"), "… unless it is the same");
    assert.equal(C.checkSource(AE("a.ts", false, "web", "../b.ts")), null);
    assert.deepEqual(C.sourceParts(AE("a.ts")), ["change", "web", "a.ts", 0], "a change from before keeps its key");
    const k = (q) => C.key({ kind: "diff", target: Z, source: q });
    assert.notEqual(k(AE("a.ts")), k(AE("a.ts", false, "web", "b.ts")), "renamed is another tab");
    assert.notEqual(k(FILES("a.ts", "b.ts")), k(FILES("b.ts", "a.ts")), "a ↔ b is not b ↔ a");
    assert.notEqual(k(FILES("a.ts", "b.ts", Z2, Z)), k(FILES("a.ts", "b.ts")), "the targets belong to the key");
    assert.notEqual(k(FILES("a.ts", "b.ts", Z2, Z)), k(FILES("a.ts", "b.ts", Z, Z2)), "… per side");
    assert.notEqual(k(VG()), k(VG({ left: { hash: H, file: "README.md" } })), "the left commit belongs to the source");
    assert.notEqual(k(VG()), k(VG({ current: "docs/README.md" })));
    assert.equal(C.diffPath(VG()), "README.md"); assert.equal(C.diffPath(v), "docs/README.md", "the comparison names the file today");
    assert.equal(C.diffPath(FILES("a.ts", "lib/b.ts")), "lib/b.ts", "the comparison of two files: right (VS Code modified)");
    assert.equal(C.diffPath(AE("a.ts", false, "web", "b.ts")), "b.ts");
  },
  rename: ({ C }) => {
    // O: the target of the area in which it was renamed/deleted
    const b = renaming("web/a.ts", "web/b.ts"), O = { target: Z };
    assert.deepEqual(C.renameSource(AE("a.ts"), b, O), AE("a.ts", false, "web", "b.ts"), "the working tree follows, the index of a.ts stays on the left");
    assert.deepEqual(C.renameSource(AE("a.ts", true), b, O), AE("a.ts", true, "web", "b.ts"), "the index too");
    assert.deepEqual(C.renameSource(AE("a.ts", false, "web", "b.ts"), renaming("web/b.ts", "web/a.ts"), O), AE("a.ts"), "renamed back: without `current`");
    assert.deepEqual(C.renameSource({ kind: "commit", repo: "web", hash: H, file: "a.ts" }, b, O), { kind: "commit", repo: "web", hash: H, file: "a.ts", current: "b.ts" });
    assert.deepEqual(C.renameSource(VG({ right: { hash: H, file: "a.ts" }, left: { hash: H2, file: "a.ts" } }), b, O).current, "b.ts", "the time axis comparison");
    assert.deepEqual(C.renameSource(FILES("web/a.ts", "web/a.ts"), b, O), FILES("web/b.ts", "web/b.ts"), "the comparison of two files: both sides");
    assert.deepEqual(C.renameSource(FILES("x.ts", "web/a.ts"), b, O), FILES("x.ts", "web/b.ts"));
    assert.deepEqual(C.renameSource(AE("src/x.ts"), renaming("web/src", "web/lib"), O), AE("src/x.ts", false, "web", "lib/x.ts"), "a folder in the repo");
    assert.deepEqual(C.renameSource(AE("src/x.ts"), renaming("web", "app"), O), { ...AE("src/x.ts"), repo: "app" }, "a folder above the repo takes it along");
    assert.deepEqual(C.renameSource({ kind: "commit-whole", repo: "web", hash: H }, renaming("web", "app"), O), { kind: "commit-whole", repo: "app", hash: H });
    const outValue = renaming("web/a.ts", "webx/a.ts");
    assert.equal(C.renameSource(AE("a.ts"), outValue, O), null, "out of the repo: a delete for the repo — the working tree falls");
    const st = AE("a.ts", true);
    assert.equal(C.renameSource(st, outValue, O), st, "… the index stays as it is");
    const foreign = AE("c.ts");
    assert.equal(C.renameSource(foreign, b, O), foreign, "not affected: the same source");
    // The comparison of two files, each side in ITS target.
    assert.deepEqual(C.renameSource(FILES("web/a.ts", "web/a.ts", Z2, Z), b, O), FILES("web/a.ts", "web/b.ts", Z2, Z), "only the side in the target of the rename — the same path in another target is another file");
    const OA = { target: Z, map: MAP }, cross = FILES("src/a.ts", "x.ts", Z2, Z);
    assert.deepEqual(C.renameSource(cross, renaming("proj/src", "proj/lib"), OA), FILES("lib/a.ts", "x.ts", Z2, Z), "across the levels: renamed in the workspace, the side in the project follows in ITS paths");
    assert.equal(C.renameSource(cross, renaming("proj/src/a.ts", "out.ts"), OA), null, "out of the project: a delete for the side — the comparison falls");
    assert.equal(C.renameSource(cross, renaming("other", "fresh"), OA), cross, "not affected: the same source");
    // Delete like VS Code handleDeletedFile.
    const way = (p) => p === "web/a.ts";
    assert.equal(C.sourceFalls(AE("a.ts"), way, O), true, "the working tree falls");
    assert.equal(C.sourceFalls(AE("a.ts", true), way, O), false, "the index stays");
    assert.equal(C.sourceFalls({ kind: "commit", repo: "web", hash: H, file: "a.ts" }, way, O), false, "a commit stays");
    assert.equal(C.sourceFalls(VG({ right: { hash: H, file: "a.ts" } }), way, O), false, "the time axis comparison stays");
    assert.equal(C.sourceFalls(FILES("web/a.ts", "x.ts"), way, O), true, "the comparison of two files falls with the left one …");
    assert.equal(C.sourceFalls(FILES("x.ts", "web/a.ts"), way, O), true, "… and the right one");
    assert.equal(C.sourceFalls(AE("z.ts", false, "web", "a.ts"), way, O), true, "a renamed change falls with its file today");
    assert.equal(C.sourceFalls(FILES("web/a.ts", "x.ts", Z2, Z), way, O), false, "the side of another target is not hit by the delete");
    assert.equal(C.sourceFalls(cross, (p) => p === "proj/src" || p.startsWith("proj/src/"), OA), true, "across the levels: the folder deleted in the workspace, the side in the project falls");
    // The tabs of the chat.
    const diff = { kind: "diff", target: Z, source: AE("a.ts") };
    const index = { kind: "diff", target: Z, source: AE("a.ts", true) };
    const other = { kind: "diff", target: Z2, source: AE("a.ts") };
    let s0 = C.open(C.open(C.open(C.emptyState(), index, { fixed: true }), other, { fixed: true }), diff, { fixed: true });
    const s1 = C.rename(s0, Z, "web/a.ts", "web/b.ts");
    assert.deepEqual(s1.tabs.map((x) => x.source.current ?? null), ["b.ts", null, "b.ts"], "the diffs of THIS target follow, the other target does not");
    assert.equal(s1.active, C.key({ ...diff, source: AE("a.ts", false, "web", "b.ts") }), "the active tab follows");
    const s2 = C.rename(s0, Z, "web/a.ts", "webx/a.ts");
    assert.deepEqual(s2.tabs.map((x) => C.key(x)), [C.key(index), C.key(other)], "out of the repo: the working tree closes");
    const s3 = C.removeFiles(s0, Z, "web", () => true);
    assert.deepEqual(s3.tabs.map((x) => C.key(x)), [C.key(index), C.key(other)], "delete: the working tree falls, the index stays, the other target too");
    // Like VS Code — gone from outside (closeOnFileDelete off) every diff stays, deleted in the explorer one with unsaved changes stays.
    assert.deepEqual(C.removeFiles(s0, Z, "web", () => false).tabs.length, 3, "deleted from outside: no diff falls");
    assert.deepEqual(C.removeFiles(s0, Z, "web", (k) => k !== C.key(diff)).tabs.map((x) => C.key(x)), [C.key(index), C.key(other), C.key(diff)], "the diff with unsaved changes stays");
    const vg = { kind: "diff", target: Z, source: FILES("x.ts", "web/a.ts") };
    assert.deepEqual(C.removeFiles(C.open(C.emptyState(), vg, { fixed: true }), Z, "web/a.ts", () => true).tabs, [], "the comparison of two files closes");
    // A comparison in the tab of ANOTHER target follows its side from this target (the choice was window-wide).
    const vgForeign = { kind: "diff", target: Z2, source: FILES("web/a.ts", "x.ts", Z, Z2) };
    const sf = C.open(C.emptyState(), vgForeign, { fixed: true });
    assert.deepEqual(C.rename(sf, Z, "web/a.ts", "web/b.ts").tabs[0].source, FILES("web/b.ts", "x.ts", Z, Z2), "renamed in the other target: the side there follows");
    assert.deepEqual(C.removeFiles(sf, Z, "web", () => true).tabs, [], "… and falls with it");
    // `onlyCompare`: the event of another area (components/code/comparison-connection.ts) — only comparisons, everything else has its area.
    assert.equal(C.rename(s0, Z, "web/a.ts", "web/b.ts", { onlyCompare: true }), s0, "only comparisons: without one the same state stays");
    assert.equal(C.removeFiles(s0, Z, "web", () => true, { onlyCompare: true }).tabs.length, 3, "… also on delete");
    assert.deepEqual(C.rename(sf, Z, "web/a.ts", "web/b.ts", { onlyCompare: true }).tabs[0].source, FILES("web/b.ts", "x.ts", Z, Z2), "the comparison follows then too");
    // A diff that would fall on rename stays as it is with unsaved changes — as on delete (VS Code getAllNonDirtyEditors).
    const s2u = C.rename(s0, Z, "web/a.ts", "webx/a.ts", { unsaved: (k) => k === C.key(diff) });
    assert.deepEqual(s2u.tabs.map((x) => C.key(x)), [C.key(index), C.key(other), C.key(diff)], "out of the repo: the working tree with unsaved changes stays");
    const kt = { kind: "diff", target: Z, source: cross }, sk = C.open(C.emptyState(), kt, { fixed: true });
    assert.deepEqual(C.rename(sk, Z, "proj/src/a.ts", "out.ts", { map: MAP }).tabs, [], "a side leaves its target: the comparison falls");
    assert.equal(C.rename(sk, Z, "proj/src/a.ts", "out.ts", { map: MAP, unsaved: (k) => k === C.key(kt) }), sk, "… with unsaved changes it stays as it is");
  },
  inputs: ({ E, G }) => {
    const un = E.diffKey(AE("a.ts")), ix = E.diffKey(AE("a.ts", true)), outValue = renaming("web/a.ts", "webx/a.ts"), O = { target: Z };
    const s0 = S([L("g1", ["web/a.ts", un, ix], un)]);
    const s1 = E.followRename(s0, renaming("web/a.ts", "web/b.ts"), O);
    assert.deepEqual(s1.groups[0].paths, ["web/b.ts", E.diffKey(AE("a.ts", false, "web", "b.ts")), E.diffKey(AE("a.ts", true, "web", "b.ts"))], "file AND diffs follow, in their place");
    assert.equal(s1.groups[0].active, E.diffKey(AE("a.ts", false, "web", "b.ts")), "the active diff stays active");
    assert.deepEqual(E.followRename(s0, outValue, O).groups[0].paths, ["webx/a.ts", ix], "out of the repo: the working tree falls, the index stays");
    const present = E.diffKey(FILES("src/a.ts", "lib/b.ts"));
    // Deleted in the explorer the comparison falls (except with unsaved changes), gone from outside only the file and preview fall.
    const way = (p) => p === "src/a.ts" || p === "web/a.ts";
    assert.equal(E.hitsDeleted(way, () => false, O)(present), true, "delete in the explorer: the comparison of two files falls");
    assert.equal(E.hitsDeleted(way, () => false, O)(un), true, "… the unstaged change too");
    assert.equal(E.hitsDeleted(way, (k) => k === present, O)(present), false, "… unless it carries unsaved changes (VS Code getAllNonDirtyEditors)");
    assert.equal(E.hitsDeleted(way, () => false, O)(E.diffKey(VG())), false, "the time axis comparison stays");
    assert.equal(E.hitsDeleted(way, () => true, O)("src/a.ts"), true, "the file itself falls");
    assert.equal(E.hitsFile(way)(present), false, "gone from outside: the comparison stays (VS Code closeOnFileDelete off)");
    assert.equal(E.hitsFile(way)(un), false, "gone from outside: the change stays");
    assert.equal(E.hitsFile(way)("src/a.ts"), true, "gone from outside: the file tab falls");
    // A comparison with a side from another target. An event from ANOTHER area (`onlyCompare`) pulls along only the comparisons —
    // the file tabs and diffs of this area belong to its target.
    const cross = E.diffKey(FILES("src/a.ts", "lib/b.ts", Z2, Z)), crossNew = E.diffKey(FILES("src/c.ts", "lib/b.ts", Z2, Z));
    const s5 = S([L("g1", ["src/a.ts", un, cross], cross)]);
    const s6 = E.followRename(s5, renaming("src/a.ts", "src/c.ts"), { target: Z2 }, true);
    assert.deepEqual(s6.groups[0].paths, ["src/a.ts", un, crossNew], "renamed in another area: only the comparison follows");
    assert.equal(s6.groups[0].active, crossNew, "… and stays active");
    assert.deepEqual(E.followRename(s5, outValue, O, true).groups[0].paths, s5.groups[0].paths, "… and what is not a comparison does not fall");
    const s7 = E.followRename(S([L("g1", [cross])]), renaming("proj/src", "proj/lib"), { target: Z, map: MAP }, true);
    assert.deepEqual(s7.groups[0].paths, [E.diffKey(FILES("lib/a.ts", "lib/b.ts", Z2, Z))], "across the levels: the side in the project follows in ITS paths");
    const wayP = (p) => p === "src/a.ts";
    assert.equal(E.hitsDeleted(wayP, () => false, { target: Z2 }, true)("src/a.ts"), false, "deleted in another area: the file tab of this area stays");
    assert.equal(E.hitsDeleted(wayP, () => false, { target: Z2 }, true)(cross), true, "… the comparison with the side there falls");
    assert.equal(E.hitsDeleted(wayP, () => false, O, true)(cross), false, "the same path in its own target is not its left side");
    // On rename a falling diff with unsaved changes stays as it is — in its own area and from another.
    assert.deepEqual(E.followRename(s0, outValue, O, false, (k) => k === un).groups[0].paths, ["webx/a.ts", un, ix], "the working tree with unsaved changes stays");
    const OK = { target: Z, map: MAP }, outK = renaming("proj/src/a.ts", "out.ts");
    assert.equal(G.allOpen(E.followRename(S([L("g1", ["x.ts", cross], cross)]), outK, OK, true)).includes(cross), false, "a side leaves its target: the comparison falls");
    assert.deepEqual(E.followRename(S([L("g1", ["x.ts", cross], cross)]), outK, OK, true, (k) => k === cross).groups[0].paths, ["x.ts", cross], "… with unsaved changes it stays");
    // A remembered comparison in the form before targets (without targets) is not an input — without migration it would fall like
    // any key that names nothing valid.
    const oldForm = `\u0001diff\u0001${JSON.stringify({ q: { kind: "files", repo: "", left: "a.ts", right: "b.ts" } })}`;
    assert.equal(E.inputOf(oldForm), null, "the old form is not an input");
    assert.deepEqual(E.tidy(S([L("g1", ["a.ts", oldForm], oldForm)])).groups[0].paths, ["a.ts"], "… and would fall out of the group, the rest stays");
    // So it migrates BEFORE `tidy` into the target of the groups (components/code/editor-groups-connection.ts `targetTheGroups`).
    const migrated = E.diffKey(FILES("a.ts", "b.ts", Z2, Z2));
    assert.equal(E.migrateComparison(oldForm, Z2), migrated, "the old form: both sides in the target of the groups");
    assert.equal(E.migrateComparison(present, Z2), present, "a current input stays");
    assert.equal(E.migrateComparison("src/a.ts", Z2), "src/a.ts"); assert.equal(E.migrateComparison(E.diffKey(AE("a.ts")), Z2), E.diffKey(AE("a.ts")));
    assert.equal(E.migrateComparison(oldForm, { apiBase: "/x", instance: null }), oldForm, "a foreign route does not migrate");
    const sw = E.tidy(E.migrateCompare(S([L("g1", ["a.ts", oldForm], oldForm)]), Z2));
    assert.deepEqual(sw.groups[0].paths, ["a.ts", migrated], "in the group in its place");
    assert.equal(sw.groups[0].active, migrated, "… and active stays active");
    assert.equal(E.bufferFile(present), "lib/b.ts", "right is the buffer of the file (editable as in VS Code)");
    assert.equal(E.bufferFile(E.diffKey(AE("a.ts", false, "web", "b.ts"))), "web/b.ts", "the renamed change holds the buffer of the file today");
    assert.equal(E.bufferFile(E.diffKey(VG())), null, "the time axis comparison is history");
    assert.equal(E.timeAxisFile(E.diffKey(VG({ current: "docs/README.md" }))), "web/docs/README.md", "the time axis stays with the file today");
    assert.equal(E.timeAxisFile(present), "lib/b.ts", "in the comparison of two files: right (VS Code PRIMARY)");
    assert.deepEqual(E.inputOf(E.diffKey(VG())), { kind: "diff", source: VG() }, "a comparison reads back");
    // Titles like VS Code.
    assert.equal(E.diffName(VG(), t), "README.md (fedcba98) ↔ README.md (abc1234d)", "\"{0} ({1}) ↔ {0} ({2})\" — the selected entry on the left");
    assert.equal(E.diffName(VG({ right: { hash: H, file: "old.md" }, current: "docs/fresh.md" }), t), "fresh.md (fedcba98) ↔ fresh.md (abc1234d)", "the name today");
    assert.equal(E.diffName(FILES("src/a.ts", "lib/b.ts"), t), "a.ts ↔ b.ts", "DiffEditorInput: the two names");
    assert.equal(E.diffName(AE("a.ts", false, "web", "fresh.ts"), t), "fresh.ts (Working Tree)", "the renamed change is named after the file today");
    assert.deepEqual(E.tabTitle(present, t), { name: "a.ts ↔ b.ts", hint: "src/a.ts ↔ lib/b.ts" }, "the hint names both paths (VS Code: the long title)");
    assert.equal(E.tabTitle(E.diffKey(VG()), t).hint, "web/README.md · Compare fedcba98 ↔ abc1234d");
    // From two targets each side names its root (VS Code, multi-root window: labelService "{root} • {path}").
    assert.deepEqual(E.tabTitle(cross, t, NAME), { name: "a.ts ↔ b.ts", hint: "ORBIT • src/a.ts ↔ Lawfirm • lib/b.ts" }, "two targets: the root per side");
    assert.equal(E.tabTitle(cross, t).hint, "p1 • src/a.ts ↔ w1 • lib/b.ts", "without names: the identifier of the route");
    assert.deepEqual(E.tabTitle(present, t, NAME), { name: "a.ts ↔ b.ts", hint: "src/a.ts ↔ lib/b.ts" }, "one target: without root, as before");
  },
  // Two files of the same name from different folders — VS Code DiffEditorInput.computeLabels (`forceDescription`).
  addition: ({ T }) => {
    assert.equal(T.filesAddition(FILES("src/a/index.ts", "src/b/index.ts")), "…/a - …/b", "same names, different folders: both folders shortened (labels.ts shorten), \" - \"");
    assert.equal(T.filesAddition(FILES("a/x/y.ts", "b/x/y.ts")), "a/… - b/…");
    assert.equal(T.filesAddition(FILES("src/a.ts", "lib/b.ts")), undefined, "different names: no addition");
    assert.equal(T.filesAddition(FILES("a.ts", "lib/a.ts")), undefined, "one folder empty (the root): no addition (VS Code `!!p && !!h`)");
    assert.equal(T.filesAddition(FILES("lib/a.ts", "lib/a.ts")), undefined, "same folder: no addition");
    assert.equal(T.filesAddition(VG()), undefined, "the time axis comparison carries the refs in the name");
    assert.equal(T.filesAddition(AE("a.ts")), undefined);
    // From two targets each side carries its root (VS Code, multiple roots: the medium description "{root} • {folder}", at the root
    // the name alone) — files of the same name in equally named folders of two projects differ at the root.
    assert.equal(T.filesAddition(FILES("src/index.ts", "src/index.ts", Z2, Z), NAME), "ORBIT • src - Lawfirm • src", "two targets, same folder: the roots");
    assert.equal(T.filesAddition(FILES("a.ts", "a.ts", Z2, Z), NAME), "ORBIT - Lawfirm", "at the root: the name of the root (then no description is empty)");
    assert.equal(T.filesAddition(FILES("a.ts", "lib/a.ts", Z2, Z), NAME), "ORBIT - Lawfirm • lib");
    assert.equal(T.filesAddition(FILES("a.ts", "b.ts", Z2, Z), NAME), undefined, "different names: no addition, also from two targets");
    assert.equal(T.filesAddition(FILES("a.ts", "a.ts", Z2, Z)), "p1 - w1", "without names: the identifier");
  },
  diffTab: async ({ D, Zt }) => {
    // Which side goes where, EXECUTED — per side the file IN the commit (`after`), the selected entry on the left (VS Code
    // `vscode.diff(selected, clicked)`); an unknown side makes the comparison unknown, never empty.
    const page = (hash, parent, inside) => ({ diff: "x", clipped: false, prior: { kind: "text", text: parent }, after: { kind: "text", text: inside } });
    const pages = { [H2]: page(H2, "parent-left\n", "left\n"), [H]: page(H, "parent-right\n", "right\n") };
    assert.deepEqual(await D.comparisonContent(VG().left, VG().right, async (x) => pages[x.hash]),
      { diff: "", clipped: false, prior: { kind: "text", text: "left\n" }, after: { kind: "text", text: "right\n" } }, "selected on the left, clicked on the right — each the file IN the commit");
    assert.equal(await D.comparisonContent(VG().left, VG().right, async (x) => (x.hash === H ? null : pages[x.hash])), null, "right unknown => unknown");
    assert.equal(await D.comparisonContent(VG().left, VG().right, async (x) => (x.hash === H2 ? null : pages[x.hash])), null, "left unknown => unknown");
    // Per side its target — what `read` receives is read (DiffTab.tsx: the target of the tab via the chat, another via its route).
    const di = await D.filesContent({ target: Z2, path: "src/a.ts" }, { target: Z, path: "lib/b.ts" }, async (x) => ({ content: groupRows(x.target, Z2) && x.path === "src/a.ts" ? "A\n" : "B\n", sha: `${x.target.apiBase}:${x.path}` }));
    assert.deepEqual(di.content, { diff: "", clipped: false, prior: { kind: "text", text: "A\n" }, after: { kind: "workingTree" } }, "left the selected file from ITS target, right the working tree");
    assert.equal(di.right.sha, "/api/workspaces/w1:lib/b.ts", "right the clicked one (its text with checksum for the buffer)");
    assert.deepEqual((await D.filesContent("x", "y", async (p) => (p === "x" ? { tooLarge: true } : { content: "" }))).content.prior, { kind: "large" });
    assert.deepEqual((await D.filesContent("x", "y", async () => ({ content: null }))).content.prior, { kind: "missing" });
    assert.equal(D.writeFile(AE("a.ts")), "web/a.ts"); assert.equal(D.writeFile(AE("a.ts", false, "web", "b.ts")), "web/b.ts", "the renamed one writes to the file today");
    assert.equal(D.writeFile(AE("a.ts", true)), null); assert.equal(D.writeFile(VG()), null);
    assert.equal(D.writeFile(FILES("a.ts", "b.ts")), "b.ts", "the comparison of two files writes right");
    assert.equal(D.sourceWritable(FILES("a.ts", "b.ts")), true); assert.equal(D.sourceWritable(VG()), false);
    assert.deepEqual(D.followUpFiles(FILES("a.ts", "b.ts")), ["a.ts", "b.ts"], "both sides re-read live");
    assert.deepEqual(D.followUpFiles(AE("a.ts", true, "web", "b.ts")), ["web/b.ts"]); assert.deepEqual(D.followUpFiles(VG()), []);
    assert.deepEqual(D.followUpLocations(FILES("a.ts", "b.ts", Z2, Z), Z), [{ target: Z2, path: "a.ts" }, { target: Z, path: "b.ts" }], "each side re-reads in ITS target");
    assert.equal(D.followUpLocations(FILES("a.ts", "a.ts", Z2, Z), Z).length, 2, "the same path in two targets: two files");
    assert.deepEqual(D.followUpLocations(FILES("a.ts", "a.ts"), Z), [{ target: Z, path: "a.ts" }], "in one target: one");
    assert.deepEqual(D.followUpLocations(AE("a.ts", true, "web", "b.ts"), Z2), [{ target: Z2, path: "web/b.ts" }], "otherwise the target of the tab");
    // A save anywhere in the window re-reads the LEFT side of a comparison — canonical (the same file in the project and on the
    // workspace level is ONE); the right one holds the buffer.
    const equalK = (x, y) => MAP(x.target, x.path, y.target) === y.path;
    assert.equal(D.leftSaved(FILES("a.ts", "b.ts", Z2, Z), { target: Z2, path: "a.ts" }, equalK), true, "saved on the left");
    assert.equal(D.leftSaved(FILES("a.ts", "b.ts", Z2, Z), { target: Z, path: "proj/a.ts" }, equalK), true, "… on the workspace level: the same file");
    assert.equal(D.leftSaved(FILES("a.ts", "b.ts", Z2, Z), { target: Z, path: "b.ts" }, equalK), false, "the right holds the buffer");
    assert.equal(D.leftSaved(FILES("a.ts", "b.ts", Z2, Z), { target: Z, path: "a.ts" }, equalK), false, "the same path in another target is another file");
    assert.equal(D.leftSaved(AE("a.ts"), { target: Z, path: "web/a.ts" }, () => true), false, "only the comparison of two files");
    assert.equal(D.leftSaved(VG(), { target: Z, path: "web/README.md" }, () => true), false);
    assert.deepEqual(D.blockActions(AE("a.ts")), ["stage", "dismiss"]); assert.deepEqual(D.blockActions(AE("a.ts", false, "web", "b.ts")), [], "a renamed unstaged change has no blocks");
    assert.deepEqual(D.blockActions(AE("a.ts", true, "web", "b.ts")), ["revert"], "the staged renamed one keeps \"revert block\"");
    assert.deepEqual(D.blockActions(FILES("a.ts", "b.ts")), []); assert.equal(D.isMultiFile(VG()), false); assert.equal(D.isMultiFile(FILES("a", "b")), false);
    assert.deepEqual(D.sourceLabel(VG()), { key: "Compare {left} ↔ {right}", values: { left: "fedcba98", right: "abc1234d" } });
    assert.deepEqual(D.sourceLabel(VG()).values, { left: Zt.shortRef(H2), right: Zt.shortRef(H) }, "the label shortens like the title (timeAxis.ts shortRef, VS Code substr(0, 8))");
    assert.deepEqual(D.sourceLabel(FILES("src/a.ts", "b.ts")), { key: "Compare with {file}", values: { file: "src/a.ts" } });
    assert.deepEqual(D.sourceLabel(FILES("src/a.ts", "b.ts", Z2, Z), undefined, NAME), { key: "Compare with {file}", values: { file: "ORBIT • src/a.ts" } }, "the left side from another target names its root");
    const deleted = "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
    const d1 = D.display({ source: AE("a.ts", false, "web", "b.ts"), content: { diff: deleted, clipped: false, prior: { kind: "text", text: "x\n" }, after: { kind: "workingTree" } }, patch: null, workingTree: { text: "x\ny\n" } });
    assert.equal(d1.kind, "merge"); assert.equal(d1.fresh, "x\ny\n"); assert.equal(d1.writable, true); assert.deepEqual(d1.blocks, []);
    assert.ok(d1.announcements.some((a) => a.key === "Renamed: {from} → {to}" && a.values.from === "web/a.ts" && a.values.to === "web/b.ts"), "the announcement \"Renamed\"");
    const d2 = D.display({ source: FILES("a.ts", "b.ts"), content: { diff: "", clipped: false, prior: { kind: "text", text: "a\n" }, after: { kind: "workingTree" } }, patch: null, workingTree: { text: "b\n" } });
    assert.equal(d2.kind, "merge"); assert.equal(d2.old, "a\n"); assert.equal(d2.writable, true, "editable on the right");
    const d3 = D.display({ source: VG(), content: { diff: "", clipped: false, prior: { kind: "text", text: "a\n" }, after: { kind: "text", text: "b\n" } }, patch: null });
    assert.equal(d3.kind, "merge"); assert.equal(d3.writable, false, "the time axis comparison is read-only");
  },
};

test("(1) Computations: choice, menu, sources, rename/delete, editor groups, diff component, addition — like VS Code", async () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { await check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) Counter-tests: each sabotage occurs exactly once in its source and is caught by its check", async () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}x in ${k.source})`);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { await CHECKS[s.catches](s.m); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [comparison] ${sabotaged.length} sabotages on the computations, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  timeAxis: read("src", "components", "code", "explorer", "TimeAxis.tsx"),
  tree: read("src", "components", "code", "explorer", "ExplorerTree.tsx"),
  connection: read("src", "components", "code", "comparison-connection.ts"),
  pane: read("src", "components", "CodePane.tsx"),
  difftab: read("src", "components", "code", "DiffTab.tsx"),
  turnout: read("src", "components", "chat", "DiffTabSwitch.tsx"),
  chattabs: read("src", "components", "chat", "chatTabs.ts"),
  codeArea: read("src", "components", "chat", "ChatCodeArea.tsx"),
  inputParts: read("src", "components", "code", "InputParts.tsx"),
  tabBar: read("src", "components", "code", "TabBar.tsx"),
  chatTabBar: read("src", "components", "chat", "ChatTabBar.tsx"),
  i18n: read("src", "lib", "i18n-de.ts"),
  groupConnection: read("src", "components", "code", "editor-groups-connection.ts"),
};
function sources(q) {
  const z = withoutComments(q.timeAxis), b = withoutComments(q.tree), a = withoutComments(q.connection), c = withoutComments(q.pane);
  const d = withoutComments(q.difftab), w = withoutComments(q.turnout), ct = withoutComments(q.chattabs);
  // Time axis: the group "3_compare" BETWEEN openDiff/viewCommit and the copy items, from `timeAxisPlan`, the choice with the file today
  // and its name in the commit.
  const open = z.indexOf("{ id: \"timeline.viewCommit\""), comparison = z.indexOf("comparison ? timeAxisPlan(comparison.status).map((p) => p === \"with-selection\""), copy = z.indexOf("{ id: \"timeline.copyCommitId\"");
  assert.ok(open >= 0 && comparison > open && copy > comparison, "time axis: the group \"3_compare\" does not stand between \"open commit\" and \"copy commit hash\"");
  assert.ok(z.includes("{ id: \"timeline.compareWithSelected\", label: t(\"Compare with Selected\"), execute: () => comparison.withSelected(choice(e)) }")
    && z.includes("{ id: \"timeline.selectForCompare\", label: t(\"Select for Compare\"), execute: () => comparison.select(choice(e)) }"), "time axis: the items do not call the computation");
  assert.ok(z.includes("const choice = (e: TimeAxisEntry): TimeAxisChoice => ({ repo, file: target.file, hash: e.hash, backThen: e.file });"), "time axis: the choice does not name the file today and its name in the commit");
  // Explorer: the plan gets the choice and the count, the three items call the connection.
  assert.ok(b.includes("...(comparison ? { comparison: { selected: comparison.selected !== null, count: paths.length } } : {}) });"), "explorer: the plan does not know the choice");
  assert.ok(b.includes("case \"comparison-with-selection\": return { label: t(\"Compare with Selected\"), run: () => { if (target !== null) comparison?.withSelectedPath(target); } };")
    && b.includes("case \"for-comparison\": return { label: t(\"Select for Compare\"), run: () => { if (target !== null) comparison?.select(target); } };")
    && b.includes("case \"selection-compare\": return { label: t(\"Compare Selected\"), run: () => comparison?.compareSelected(paths) };"), "explorer: the items do not call the connection");
  assert.ok(/new Set\(\[[^\]]*"for-comparison"\]\)/.test(b), "explorer: after \"Select for Compare\" the focus does not stay in the tree");
  // The connection: explorer pinned, time axis as preview — via the path of the time axis.
  assert.ok(a.includes("withSelectedPath: (path) => on(V.withSelectedFile(read(), ref.current.target, path), true),") && a.includes("compareSelected: (paths) => on(V.selectedCompare(ref.current.target, paths), true),"), "connection: the explorer does not open pinned (VS Code pinned)");
  assert.ok(a.includes("withSelected: (w) => on(V.withSelectedEntry(read(), ref.current.target, w, sameFileInWindow), false),"), "connection: the time axis does not open as preview (VS Code vscode.diff)");
  // ONE choice in the window (VS Code `globalResourceToCompare`) — one state in the module, each area reads it and selects with its target.
  assert.ok(/^let choice: V\.WindowChoice = \{ state: V\.NO_CHOICE, workspace: null \};$/m.test(a) && a.includes("const s = useSyncExternalStore(subscribe, read, empty);")
    && a.includes("select: (path) => set((x) => V.fileForComparison(x, ref.current.target, path)),") && a.includes("select: (w) => set((x) => V.entryForComparison(x, ref.current.target, w)),"), "connection: the choice does not apply window-wide");
  // The sides follow across the areas — a follow-up from ANOTHER area pulls along only the comparisons in the groups; mapped
  // through the canonical identity.
  assert.ok(a.includes("useFileFollowUp((e) => { if (o.followUp && e.from !== o.area) o.followUp(e); });")
    && a.includes("return (s) => E.followRename(s, underForm(e.old, e.fresh), location, true, unsaved);") && a.includes("return (s) => G.remove(s, E.hitsDeleted((a) => a === p || a.startsWith(`${p}/`), unsaved, location, true));"), "connection: a follow-up from another area");
  assert.ok(a.includes("const o = coordinatesOf(from).toCanon(path);") && a.includes("return o ? coordinatesOf(to).ofCanon(o.target, o.path) : null;"), "connection: the mapping of the window does not go through the canonical identity");
  assert.ok(a.includes("ref.current.open(q, { title: diffName(q, ref.current.t), short: \"\", fixed });"), "connection: it is not opened via the path of the time axis");
  // CodePane: ONE choice per area, on explorer and time axis; rename via `followRename`.
  assert.ok(c.includes("const comparison = useComparison(target, openTimeAxis, t, { area, followUp: controlled ? undefined : (e) => applyGroups(compareInGroups(e, dirtyOf)) });") && c.includes("comparison={comparison.explorer}") && c.includes("comparison={comparison.timeAxis}"), "CodePane does not wire the comparison");
  assert.ok(c.includes("const followUpLocation = { target, map: mapInWindow };") && c.includes("applyGroups((s) => E.followRename(s, (a) => (a === path ? to : a.startsWith(`${path}/`) ? to + a.slice(path.length) : a), followUpLocation, false, dirtyOf));")
    && c.includes("applyGroups((s) => E.followRename(s, (p) => form(p) ?? p, followUpLocation, false, dirtyOf));"), "CodePane: the diffs do not follow on rename");
  assert.ok(c.includes("reportFileFollowUp({ kind: \"renamed\", from: area, target, old: path, fresh: to });") && c.includes("reportFileFollowUp({ kind: \"deleted\", from: area, target, path: path });"), "CodePane: the other areas learn nothing");
  // The diff component loads both comparisons via the executed computations (selected on the left, clicked on the right); the renamed
  // change reads the file today on the right.
  assert.ok(d.includes("const content = await comparisonContent(source.left, source.right, page);") && d.includes("hash: x.hash, file: d, content: true })"), "diff: the time axis comparison does not load its sides via `comparisonContent` (left, right)");
  assert.ok(d.includes("const { content, right: r } = await filesContent({ target: source.leftTarget, path: source.left }, { target: source.rightTarget, path: source.right }, read);")
    && d.includes("const pathIn = (z: TabTarget): Path => (targetEqual(z, bufferTarget ?? target) ? path : (rest) => instancePath(`${z.apiBase}${rest}`, z.instance));")
    && d.includes("api<FileContent>(pathIn(x.target)(`/files/read?path=${encodeURIComponent(x.path)}`))")
    && d.includes("return { e: { source, content, patch: null, workingTree }, reading: fromReading(r) };"), "diff: the comparison of two files does not load its sides each from ITS target via `filesContent` (or right without buffer)");
  assert.ok(d.includes("const label = sourceLabel(source, undefined, rootName);"), "diff: the label without the root names");
  // The comparison has its own message — no reference to "Show whole commit", which does not exist there.
  const vgBlock = d.slice(d.indexOf("if (source.kind === \"comparison\") {"), d.indexOf("if (source.kind === \"files\") {"));
  assert.ok(vgBlock.includes("throw new Error(t(\"The server does not know how to compare two revisions yet (after its next deploy).\"));") && !vgBlock.includes("Show whole commit"), "diff: the comparison reports a button that does not exist there");
  // Delete like VS Code — in the explorer a diff without unsaved changes falls, from outside (reload, "Reload") every diff stays.
  assert.ok(c.includes("applyGroups((s) => G.remove(s, E.hitsDeleted((a) => a === path || a.startsWith(path + \"/\"), dirtyOf, followUpLocation)));"), "CodePane: delete in the explorer closes diffs with unsaved changes");
  assert.ok(c.includes("if (r.kind === \"error\" && isMissingReading(r.error) && gr.restored.current.delete(path)) { applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path))); return; }"), "CodePane: after reloading more than file and preview falls");
  assert.ok(c.includes("stRef.current.deleted(path, true); }") && c.includes("else applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path)));") && c.includes("stRef.current?.deleted(path, false);"), "CodePane: \"Reload\" of a file deleted from outside closes diffs");
  assert.ok(ct.includes("const diffFalls = (s: TabState) => (k: string) => !fromOutside && !carriesUnsaved(s)(k);")
    && ct.includes("forgetGone(removeFiles(stateRef.current, target, path, diffFalls(stateRef.current), o));") && ct.includes("setStatus((s) => removeFiles(s, target, path, diffFalls(s), o));"), "chat: delete does not ask about outside/unsaved changes");
  assert.ok(withoutComments(q.codeArea).includes("deleted: (path, fromOutside) => tabsRef.current.deleted(z, path, fromOutside),"), "chat area: \"from outside\" does not arrive");
  // The tab of a comparison of same-named files shows the folders — in the editor groups and in the chat.
  assert.ok(withoutComments(q.inputParts).includes("explorer: Boolean(d), addition: filesAddition(e.source, rootName) };") && withoutComments(q.inputParts).includes("const tt = E.tabTitle(k, t, rootName)"), "groups: the comparison of same-named files without folders or without the root names");
  assert.ok(withoutComments(q.tabBar).includes("addition={a ? a.addition : additionOf.get(p)}"), "tab bar: the addition of a diff does not arrive");
  assert.ok(withoutComments(q.chatTabBar).includes("addition={(tab.kind === \"diff\" ? filesAddition(tab.source, rootName) : undefined) ?? additions[i]}") && withoutComments(q.chatTabBar).includes("const e = sourceLabel(q, short, rootName);"), "chat bar: the comparison of same-named files without folders or without the root names");
  assert.ok(d.includes("encodeURIComponent(targetPath(source.repo, source.current ?? source.file))") && d.includes("if (!source.current && diffKind(content.diff).deleted)"), "diff: the renamed change does not read the file today on the right");
  assert.ok(d.includes("const file = writeFile(source) ?? \"\";"), "diff: the buffer does not come from `writeFile`");
  // The switch: both sides live, Git only for changes; the chat: buffer via `writeFile`, drafts of renamed tabs forgotten.
  assert.ok(w.includes("const follows = useMemo(() => followUpLocations(source, tab.target), [source, tab.target]);") && w.includes("nudge.paths.some((p) => saved.some((o) => sameFileInWindow(o, { target: z, path: p })))")
    && w.includes("nudge.paths === null || nudge.paths.some((p) => follows.some((o) => pathMatches(o.path, p)))"), "switch: the comparison does not re-read per side in its target");
  assert.ok(ct.includes("const d = tab.kind === \"file\" ? tab.path : writeFile(tab.source);") && ct.includes("if (tab.kind === \"diff\" && writeFile(tab.source) !== null) {"), "chat: the buffer of a comparison is not held (or not discarded on close)");
  assert.ok(ct.includes("forgetGone(rename(stateRef.current, target, old, fresh, o(stateRef.current)));") && ct.includes("forgetGone(removeFiles(stateRef.current, target, path, diffFalls(stateRef.current), o));"), "chat: drafts of renamed/deleted tabs are left lying");
  // Per side via the mapping of the window; an event from another area pulls along the chat's comparisons.
  assert.ok(ct.includes("const o = { map: mapInWindow, onlyCompare };") && ct.includes("const o = (s: TabState) => ({ map: mapInWindow, onlyCompare, unsaved: carriesUnsaved(s) });")
    && ct.includes("useFileFollowUp((e) => (e.kind === \"renamed\" ? renamed(e.target, e.old, e.fresh, true) : deleted(e.target, e.path, false, true)));"), "chat: a follow-up from another area does not arrive");
  // Remembered comparisons from before targets migrate — in the groups BEFORE tidying into the target from their key, in the chat with the draft.
  const ga = withoutComments(q.groupConnection);
  assert.ok(ga.includes("const z = targetTheGroups(key);\n    if (s && z) s = migrateCompare(s, z);\n    if (s) s = tidy(s);")
    && ga.includes("return i > 0 ? { apiBase: k.slice(0, i), instance: k.slice(i + 1) || null } : null;"), "groups: an old comparison does not migrate before tidying");
  assert.ok(c.includes("useEditorGroups(controlled ? null : [apiBase, instance ?? \"\"].join(\"|\"))"), "CodePane: the key of the groups no longer names its target");
  assert.ok(ct.includes("migrateDrafts(chatKey, raw, { read, write });\n  return readStatus(raw);"), "chat: drafts of old comparisons do not migrate");
  // Rename asks about unsaved changes — CodePane (both paths above), connection (above), chat.
  assert.ok(ct.includes("setStatus((s) => rename(s, target, old, fresh, o(s)));"), "chat: rename does not ask about unsaved changes");
  // A save in the window re-reads the left side — groups and chat, canonical.
  assert.ok(a.includes("useEffect(() => atSave((p) => { if (leftSaved(ref.current.source, { target: p.target, path: p.path }, sameFileInWindow)) ref.current.fn(); }), []);"), "connection: a save in the window does not reach the left side");
  assert.ok(w.includes("useLeftSaved(source, () => setStatus((n) => n + 1));"), "switch: a save in the window does not re-read left");
  const et = withoutComments(q.inputParts);
  assert.ok(et.includes("useLeftSaved(source, () => setLeftSaves((n) => n + 1));") && et.includes("state={revision + leftSaves}"), "groups: a save in the window does not re-read left");
  // A change of workspace clears the choice — each area reports the known workspace.
  assert.ok(a.includes("const s = useSyncExternalStore(subscribe, read, empty);\n  useWorkspaceTheChoice();") && a.includes("const id = scope.loaded ? scope.workspaceId : null;")
    && a.includes("useEffect(() => { setChoice((w) => V.toWorkspace(w, id)); }, [id]);"), "connection: a workspace change does not clear the choice");
  for (const k of ["Select for Compare", "Compare with Selected", "Compare Selected", "Compare with Selected", "Compare {left} ↔ {right}", "Compare with {file}",
    "The server does not know how to compare two revisions yet (after its next deploy)."]) {
    assert.ok(q.i18n.includes(`\n  ${JSON.stringify(k)}: `), `"${k}" without German text`);
  }
  // The two labels in the dictionary in the same form ("Compare …").
  assert.ok(q.i18n.includes("\n  \"Compare {left} ↔ {right}\": \"Vergleich {left} ↔ {right}\",") && q.i18n.includes("\n  \"Compare with {file}\": \"Vergleich mit {file}\","), "German: the labels of the comparisons inconsistent");
}
const SOURCE_SABOTAGES = [
  ["time axis without group", "timeAxis", "comparison ? timeAxisPlan(comparison.status).map(", "false ? timeAxisPlan(choice!.stand).map("],
  ["time axis does not select", "timeAxis", "execute: () => comparison.select(choice(e)) }", "execute: () => undefined }"],
  ["time axis selects the old name as file", "timeAxis", "({ repo, file: target.file, hash: e.hash, backThen: e.file })", "({ repo, file0: e.file, hash: e.hash, backThenX: e.file })"],
  ["explorer without count", "tree", "count: paths.length } } : {}) });", "amount: 1 } } : {}) });"],
  ["explorer does not compare", "tree", "comparison?.withSelectedPath(target);", "void target0;"],
  ["explorer does not compare the selection", "tree", "run: () => comparison?.compareSelected(paths) };", "run: () => undefined };"],
  ["focus does not stay in the tree", "tree", "\"download\", \"for-comparison\"]", "\"download0\"]"],
  ["explorer opens as preview", "connection", "on(V.withSelectedFile(read(), ref.current.target, path), true),", "on(V.withSelectedFile(read(), ref.current.target, path0), false),"],
  ["time axis opens pinned", "connection", "on(V.withSelectedEntry(read(), ref.current.target, w, sameFileInWindow), false),", "on(V.withSelectedEntry(read(), ref.current.target, w, sameFileInWindow), true),"],
  ["choice per area instead of window-wide", "connection", "let choice: V.WindowChoice = { state: V.NO_CHOICE, workspace: null };\n", "const choice0: V.WindowChoice = { state: V.NO_CHOICE, workspace: null };\nlet choiceX = choice00;\n"],
  ["time axis without window mapping", "connection", "w, sameFileInWindow), false)", "w), false)"],
  ["foreign follow-up also from its own area", "connection", "if (o.followUp && e.from !== o.area) o.followUp(e);", "if (o.followUp) o.followUp(e);"],
  ["foreign rename pulls all tabs of the groups", "connection", "underForm(e.old, e.fresh), location, true, unsaved);", "underForm(e.old, e.fresh), location0, false, unsaved0);"],
  ["foreign rename closes unsaved changes", "connection", "underForm(e.old, e.fresh), location, true, unsaved);", "underForm(e.old, e.fresh), location0, true);"],
  ["foreign delete closes all tabs of the groups", "connection", "unsaved, location, true));", "unsaved0, location0));"],
  ["mapping by path instead of canonical", "connection", "return o ? coordinatesOf(to).ofCanon(o.target, o.path) : null;", "return o ? path0 : null;"],
  ["CodePane selects without target", "pane", "useComparison(target, openTimeAxis, t,", "useComparison({ apiBase: \"\", instance0: null }, openTimeAxis, t,"],
  ["CodePane reports no rename", "pane", "reportFileFollowUp({ kind: \"renamed\", from: area, target, old: path, fresh: to });", "void to;"],
  ["CodePane reports no delete", "pane", "reportFileFollowUp({ kind: \"deleted\", from: area, target, path: path });", "void path;"],
  ["CodePane: groups without mapping", "pane", "const followUpLocation = { target, map: mapInWindow };", "const followUpLocation = { target0 };"],
  ["diff reads the left side in the target of the tab", "difftab", "filesContent({ target: source.leftTarget, path: source.left }", "filesContent({ target0: source0.rightTarget, path0: source0.left }"],
  ["diff reads every side through the chat", "difftab", "(targetEqual(z, bufferTarget ?? target) ? path : (rest) => instancePath(`${z.apiBase}${rest}`, z.instance))", "path"],
  ["diff label without root names", "difftab", "sourceLabel(source, undefined, rootName)", "sourceLabel(source0)"],
  ["switch: a save counts in every target", "turnout", "saved.some((o) => sameFileInWindow(o, { target: z, path: p }))", "saved0.some((o) => pathMatches(o.path, p))"],
  ["switch: save in the same target instead of canonical", "turnout", "saved.some((o) => sameFileInWindow(o, { target: z, path: p }))", "saved0.some((o) => targetEqual(o.target, z) && o.path === p)"],
  ["switch does not listen to saves in the window", "turnout", "useLeftSaved(source, () => setStatus((n) => n + 1));", ""],
  ["groups do not listen to saves in the window", "inputParts", "useLeftSaved(source, () => setLeftSaves((n) => n + 1));", ""],
  ["groups do not count the save", "inputParts", "state={revision + leftSaves}", "state={revision}"],
  ["connection: save does not reach left", "connection", "if (leftSaved(ref.current.source, { target: p.target, path: p.path }, sameFileInWindow)) ref.current.fn();", "void p;"],
  ["connection: save by path instead of canonical", "connection", "{ target: p.target, path: p.path }, sameFileInWindow)", "{ target0: p.target, path0: p.path }, (x, y) => targetEqual(x.target, y.target) && x.path === y.path)"],
  ["choice stays on workspace change", "connection", "  useWorkspaceTheChoice();\n", "\n"],
  ["workspace before reading counts", "connection", "const id = scope.loaded ? scope.workspaceId : null;", "const id = scope.workspaceId;"],
  ["groups do not migrate", "groupConnection", "    if (s && z) s = migrateCompare(s, z);\n", ""],
  ["groups migrate after tidying", "groupConnection", "    if (s && z) s = migrateCompare(s, z);\n    if (s) s = tidy(s);", "    if (s) s = tidy(s);\n    if (s && z) s = migrateCompare(s, z);"],
  ["target of the groups without instance", "groupConnection", "instance: k.slice(i + 1) || null", "instance0: null"],
  ["chat: drafts do not migrate", "chattabs", "  migrateDrafts(chatKey, raw, { read, write });\n", ""],
  ["chat: rename closes unsaved changes", "chattabs", ", unsaved: carriesUnsaved(s) });", " });"],
  ["CodePane: rename closes unsaved changes", "pane", "to + a.slice(path.length) : a), followUpLocation, false, dirtyOf));", "to + a.slice(path.length) : a), followUpLocation));"],
  ["CodePane: outline change closes unsaved changes", "pane", "(p) => form(p) ?? p, followUpLocation, false, dirtyOf));", "(p) => form(p) ?? p, followUpLocation));"],
  ["switch: the sides in the target of the tab", "turnout", "followUpLocations(source, tab.target)", "followUpLocations({ ...source0, leftTarget: tab.target } as typeof source0, tab.target)"],
  ["chat does not listen to follow-ups", "chattabs", "useFileFollowUp((e) => (e.kind === \"renamed\" ? renamed(e.target, e.old, e.fresh, true) : deleted(e.target, e.path, false, true)));", ""],
  ["chat: foreign follow-up pulls all tabs", "chattabs", "renamed(e.target, e.old, e.fresh, true)", "renamed(e.target, e.old, e.fresh)"],
  ["chat: comparison without mapping", "chattabs", "const o = (s: TabState) => ({ map: mapInWindow, onlyCompare,", "const o = (s: TabState) => ({ onlyCompare,"],
  ["chat: delete without mapping", "chattabs", "    const o = { map: mapInWindow, onlyCompare };", "    const o = { onlyCompare };"],
  ["chat bar: label without root names", "chatTabBar", "sourceLabel(q, short, rootName)", "sourceLabel(q, short0)"],
  ["groups: title without root names", "inputParts", "E.tabTitle(k, t, rootName)", "E.tabTitle(k, t)"],
  ["connection without title", "connection", "title: diffName(q, ref.current.t)", "title: \"\""],
  ["CodePane without comparison", "pane", "comparison={comparison.explorer}", ""],
  ["time axis without comparison", "pane", "comparison={comparison.timeAxis}", ""],
  ["rename without diffs", "pane", "applyGroups((s) => E.followRename(s, (a) => (a === path", "applyGroups((s) => G.formPaths(s, (a) => (a === path"],
  ["outline change without diffs", "pane", "applyGroups((s) => E.followRename(s, (p) => form(p) ?? p, followUpLocation, false, dirtyOf));", "applyGroups((s) => G.formPaths(s, (p) => form(p) ?? p));"],
  ["comparison loads right only", "difftab", "comparisonContent(source.left, source.right, page)", "comparisonContent(source0.right, source0.right, page0)"],
  ["comparison swaps the sides", "difftab", "comparisonContent(source.left, source.right, page)", "comparisonContent(source0.right, source0.left, page0)"],
  ["files swaps the sides", "difftab", "filesContent({ target: source.leftTarget, path: source.left }, { target: source.rightTarget, path: source.right },", "filesContent({ target0: source0.rightTarget, path0: source0.right }, { target0: source0.leftTarget, path0: source0.left },"],
  ["files right without buffer", "difftab", "return { e: { source, content, patch: null, workingTree }, reading: fromReading(r) };", "return { e: { source0, content0, patch: null, workingTree0 }, reading0: null };"],
  ["comparison names \"Show whole commit\"", "difftab", "t(\"The server does not know how to compare two revisions yet (after its next deploy).\")", "t(\"The server does not know the diff of a single file yet (after its next deploy) — \\\"Show whole commit\\\" works.\")"],
  ["explorer delete closes unsaved changes", "pane", "E.hitsDeleted((a) => a === path || a.startsWith(path + \"/\"), dirtyOf, followUpLocation)", "E.hitsDeleted((a) => a === path || a.startsWith(path + \"/\"), () => false, followUpLocation)"],
  ["reload closes diffs", "pane", "gr.restored.current.delete(path)) { applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path))); return; }", "gr.restored.current.delete(path)) { applyGroups((s) => G.remove(s, E.hitsDeleted((x) => x === path, () => false, followUpLocation))); return; }"],
  ["\"Reload\" closes diffs in the chat", "pane", "stRef.current.deleted(path, true); }", "stRef.current.deleted(path, false); }"],
  ["\"Reload\" closes diffs in the groups", "pane", "else applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path)));", "else applyGroups((s) => G.remove(s, E.hitsDeleted((x) => x === path, () => false, followUpLocation)));"],
  ["chat: from outside as in the explorer", "chattabs", "!fromOutside && !carriesUnsaved(s)(k)", "!carriesUnsaved(s)(k)"],
  ["chat: unsaved changes fall", "chattabs", "!fromOutside && !carriesUnsaved(s)(k)", "!fromOutside"],
  ["chat area swallows \"from outside\"", "codeArea", "tabsRef.current.deleted(z, path, fromOutside)", "tabsRef.current.deleted(z, path0, false)"],
  ["groups: comparison without folders", "inputParts", "addition: filesAddition(e.source, rootName) };", "addition0: undefined };"],
  ["bar swallows the addition", "tabBar", "addition={a ? a.addition : additionOf.get(p)}", "addition0={a ? undefined : additionOf.get(p)}"],
  ["chat bar without folders", "chatTabBar", "addition={(tab.kind === \"diff\" ? filesAddition(tab.source, rootName) : undefined) ?? additions[i]}", "addition0={additions0[i]}"],
  ["German inconsistent", "i18n", "\"Compare with {file}\": \"Vergleich mit {file}\",", "\"Compared with {file}\": \"Vergleich mit {file}\","],
  ["renamed one reads the old name", "difftab", "encodeURIComponent(targetPath(source.repo, source.current ?? source.file))", "encodeURIComponent(targetPath(source0.repo, source0.file))"],
  ["renamed one counts as deleted", "difftab", "if (!source.current && diffKind(content.diff).deleted)", "if (diffKind(content0.diff).deleted)"],
  ["diff buffer past the rule", "difftab", "const file = writeFile(source) ?? \"\";", "const file = source0.kind === \"change0\" ? targetPath(source0.repo, source0.file) : \"\";"],
  ["switch follows one side only", "turnout", "follows.some((o) => pathMatches(o.path, p))", "pathMatches(follows0[0]?.path ?? \"\", p)"],
  ["chat buffer for changes only", "chattabs", "const d = tab.kind === \"file\" ? tab.path : writeFile(tab.source);", "const d = tab.kind === \"file0\" ? tab.path : tab.source.kind === \"change0\" ? writeFile(tab.source) : null;"],
  ["chat forgets nothing on rename", "chattabs", "forgetGone(rename(stateRef.current, target, old, fresh, o(stateRef.current)));", ""],
  ["translation missing", "i18n", "  \"Select for Compare\": \"Für Vergleich auswählen\",\n", ""],
];

test("(2) Sources: time axis, explorer, connection, CodePane, diff component, chat, German dictionary (including counter-tests)", (tt) => {
  sources(Q);
  for (const [name, k, old, fresh] of SOURCE_SABOTAGES) {
    const n = Q[k].split(old).length - 1;
    assert.equal(n, 1, `counter-test "${name}" is stale: the spot occurs ${n}x in ${k}`);
    assert.throws(() => sources({ ...Q, [k]: Q[k].replace(old, fresh) }), undefined, `counter-test "${name}" is not caught`);
  }
  tt.diagnostic(`${SOURCE_SABOTAGES.length} counter-tests caught`);
});
