// Third-party notices. The promise: what cbase took over or reimplemented (the outlines of the Codicons under CC BY 4.0, code and a
// symbol from Code - OSS under MIT) is VISIBLE in the settings (name, originator, license with link, source as repo AT THE TAG (never the
// installed product), changes, per piece the path in the repo with its files) and as web/public/THIRD_PARTY_NOTICES.txt with the same
// content including the MIT text; and NO reimplementation is missing from it.
//
// (1) The computation lib/thirdParty.ts, EXECUTED, against ALL files under web/src and in the backend (plus the JSON tables under
//     web/test/fixtures: a table of adopted data carries its markers in the field `markers`; the German wordings are from
//     microsoft/vscode-loc, whose state is a commit, as the repo has carried no tags since 1.98):
//     - the file in public/ IS `hintText()` (character for character; whoever changes the list rewrites the file);
//     - MARKER <-> LIST in both directions: every file of a piece carries its marker (`markerOf`), and every marker of a file
//       (`markersIn`) belongs to a piece under which the file is listed: a reimplementation without an entry is red, an entry without a marker too;
//     - every file that names one of these licenses is in the list;
//     - FREE TEXT: every file under web/src that writes "modelled on VS Code" (or a variant) carries a marker or is listed in
//       EXCEPTIONS (named, with a reason: a behavior imitated, no code taken over), and every exception still applies;
//     - no origin names the installed product (bundle, app), every source is the repo at the tag.
// (2) The sources: the page shows every entry (originator, license as a link, source, changes and pieces via t(), files, link to
//     the file), the settings modal lists it as a row at the foot of the list, every text has its German entry.
//
// Every sabotage changes exactly ONE spot (otherwise it is stale) and must be caught.
//
// Run:  node --test --test-reporter=tap web/test/thirdParty.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

// How to recognize a file that names a third-party license, and which license an entry requires. A new entry in
// lib/thirdParty.ts needs its identifier here, otherwise the test is red.
const LICENSE_IN_HEADER = /CC BY 4\.0|creativecommons\.org\/licenses|MIT license|\(VS Code, MIT\)/;
const IDENTIFIER = { "Codicons": /CC BY 4\.0/, "Visual Studio Code (Code - OSS)": /\bMIT\b/, "VS Code Language Pack (German)": /\bMIT\b/ };
// The free text that gives away a reimplementation, and the files that write it without having taken over code (named, with a reason).
const FREE_TEXT = /modell?ed (on|after) VS Code|ported from VS Code|rebuilt from VS Code/;
const EXCEPTIONS = {
  "web/src/components/CodePane.tsx": "the \"…\" menu of a group: only entries and order (behavior), no code",
  "web/src/components/code/InputParts.tsx": "the same menu (MenuId.EditorTitle): entries and order, no code",
  "web/src/lib/search-rules.ts": "keys, history and seed of the search field: behavior, no code taken over",
};
// Whoever names the installed product as the origin (product license, not MIT).
const PRODUCT = /workbench\.desktop\.main|Visual Studio Code\.app|installed bundle|from the bundle|workbench bundle/i;
// The notices themselves name licenses and markers without being material.
const ITSELF = new Set(["web/src/lib/thirdParty.ts", "web/src/components/settings/ThirdPartyHints.tsx", "web/src/lib/i18n-de.ts"]);
const SEARCHED = ["web/src", "server/backend/electron/server", "server/backend/electron/mcp"];

function allFiles(rel) {
  const full = path.join(repo, rel);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const r = `${rel}/${e.name}`;
    return e.isDirectory() ? allFiles(r) : /\.(ts|tsx|js|mjs|cjs|css)$/.test(e.name) ? [r] : [];
  });
}
// A JSON table has no comments: its "header" is the lines of its field `markers`.
const TABLES = "web/test/fixtures";
const headerTheTable = (text) => { try { const m = JSON.parse(text).markers; return Array.isArray(m) ? m.join("\n") : ""; } catch { return ""; } };
// The packages of the backend whose license is checked: version and license as in the lockfile, and every package that markdown-it
// pulls in (the wrapper in the lockfile) is in the list; only licenses that allow redistribution with a notice.
const LOCK = JSON.parse(fs.readFileSync(path.join(repo, "server", "backend", "package-lock.json"), "utf8")).packages;
const ALLOWED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "Python-2.0"]);
function wrapper(name, lock) {
  const output = new Set();
  const stack = [name];
  while (stack.length) {
    const n = stack.pop();
    if (output.has(n)) continue;
    const e = lock[`node_modules/${n}`];
    if (!e) throw new Error(`${n} is missing in the lockfile`);
    output.add(n);
    stack.push(...Object.keys(e.dependencies || {}));
  }
  return output;
}
const tables = fs.readdirSync(path.join(repo, TABLES)).filter((d) => d.endsWith(".json")).map((d) => [`${TABLES}/${d}`, headerTheTable(fs.readFileSync(path.join(repo, TABLES, d), "utf8"))]);
// Files adopted VERBATIM (the German bundles of the language servers) carry no header of their own: their header is the
// `markers` of their entry in the neighboring `provenance.json`, and it only applies as long as the content matches the sha256 there (otherwise
// the file is no longer verbatim and its "header" is empty => entry without marker => red). Every JSON file in the folder needs an entry.
const WORD_IDENTICAL = "server/backend/electron/server/lsp/l10n";
function wordIdentical() {
  const origin = JSON.parse(fs.readFileSync(path.join(repo, WORD_IDENTICAL, "provenance.json"), "utf8")).files || {};
  const output = [];
  const go = (rel) => {
    for (const e of fs.readdirSync(path.join(repo, WORD_IDENTICAL, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { go(r); continue; }
      if (r === "provenance.json" || !r.endsWith(".json")) continue;
      const h = origin[r];
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, WORD_IDENTICAL, r))).digest("hex");
      output.push([`${WORD_IDENTICAL}/${r}`, h && h.sha256 === sha && Array.isArray(h.markers) ? h.markers.join("\n") : ""]);
    }
  };
  go("");
  return output;
}
const FILES = Object.fromEntries([...SEARCHED.flatMap(allFiles).filter((d) => !ITSELF.has(d)).map((d) => [d, fs.readFileSync(path.join(repo, d), "utf8")]), ...tables, ...wordIdentical()].sort(([a], [b]) => (a < b ? -1 : 1)));

// ── The sabotages of the computation ────────────────────────────────────────────────────────────────────────────────────────────────────
const SOURCE = read("src", "lib", "thirdParty.ts");
const SABOTAGES = {
  "file without license link": { old: "`License: ${h.license} — ${h.licenseUrl}`", fresh: "`License: ${h.license}`" },
  "file without originator": { old: "      h.originator,\n", fresh: "" },
  "file without changes": { old: "      `Changes: ${h.changes.join(\"; \")}.`,\n", fresh: "" },
  "file without pieces": { old: "...h.chunks.flatMap((s) => [`  ${chunkRow(s)}`, ...s.files.map((d) => `    ${d}`)]),", fresh: "" },
  "file without MIT text": { old: "stroke, MIT_VSCODE);", fresh: "stroke);" },
  "outlines without notice": { old: "changes: [\"Outlines converted to a 16×16 grid and rounded\", ", fresh: "changes: [" },
  "backend file missing": { old: "files: [\"web/src/lib/fuzzy-scorer.ts\", \"server/backend/electron/server/runtime/fast-open.js\"] }", fresh: "files: [\"web/src/lib/fuzzy-scorer.ts\"] }" },
  "Codicons without list of the symbols": { old: ", \"web/src/lib/codicons.ts\"]", fresh: "]" },
  "sticky scroll missing": { old: "files: [\"web/src/lib/tree-sticky.ts\"]", fresh: "files: []" },
  "shorten missing": { old: "files: [\"web/src/lib/tab-bar.ts\"]", fresh: "files: [\"web/src/lib/explorer-names.ts\"]" },
  "quick diff missing": { old: "what: \"Quick Diff peek measurements reimplemented\", files: [\"web/src/lib/quick-diff.ts\"]", fresh: "what: \"Quick Diff peek measurements reimplemented\", files: []" },
  "path in the repo wrong": { old: "path: \"src/vs/base/common/labels.ts\"", fresh: "path: \"src/vs/base/common/label.ts\"" },
  "marker in another form": { old: "`// ${s.kind}: ${h.repo} ${s.path} (${h.licenseShort})`", fresh: "`// ${s.kind}: ${s.path} (${h.licenseShort})`" },
  "pattern finds no marker": { old: "const MARKER = /^\\/\\/ (?:Port of|Taken from): \\S+ \\S+", fresh: "const MARKER = /^\\/\\/ (?:Port of): \\S+ \\S+" },
  "source without tag": { old: "`https://github.com/${h.repo}/tree/${h.revision}`", fresh: "`https://github.com/${h.repo}`" },
  "Codicons without exact version": { old: "revision: \"v0.0.46-46\"", fresh: "revision: \"main\"" },
  "origin from the product": { old: "annotation: \"outlines from dist/codicon.ttf", fresh: "annotation: \"outlines from Visual Studio Code.app/Contents/Resources/app/out/media/codicon.ttf, dist/codicon.ttf" },
  "license link wrong": { old: "licenseUrl: \"https://creativecommons.org/licenses/by/4.0/\"", fresh: "licenseUrl: \"\"" },
  "originator empty": { old: "    revision: \"1.143.1\",\n    originator: \"© Microsoft Corporation\",", fresh: "    revision: \"1.143.1\",\n    originator: \"\"," },
  "entry without identifier": { old: "name: \"Visual Studio Code (Code - OSS)\"", fresh: "name: \"VS Code\"" },
  "package missing": { old: "  { name: \"argparse\", version: \"2.0.1\", license: \"Python-2.0\", repo: \"nodeca/argparse\" },\n", fresh: "" },
  "package with wrong version": { old: "name: \"markdown-it\", version: \"14.3.3\"", fresh: "name: \"markdown-it\", version: \"14.2.0\"" },
  "package with wrong license": { old: "name: \"entities\", version: \"4.5.0\", license: \"BSD-2-Clause\"", fresh: "name: \"entities\", version: \"4.5.0\", license: \"MIT\"" },
  "Seti colours without piece": { old: "      { kind: \"Taken from\", path: \"extensions/theme-seti/icons/vs-seti-icon-theme.json\", what: \"File icon colours of the Seti theme taken over\", files: [\"web/src/lib/file-symbols.ts\"] },\n", fresh: "" },
  "attributions not in the file": { old: "    ...ATTRIBUTIONS.flatMap((a) => [`  ${attributionRow(a)}`, `    ${a.what}`, ...a.files.map((d) => `    ${d}`)]),\n", fresh: "" },
  "Simple Icons without the logo table": { old: "    files: [\"web/src/components/brandLogos.ts\"],\n", fresh: "    files: [],\n" },
  "attribution without license link": { old: "    licenseUrl: \"https://creativecommons.org/publicdomain/zero/1.0/\",\n    source: \"https://github.com/simple-icons/simple-icons\",\n    what: \"Brand logos", fresh: "    licenseUrl: \"\",\n    source: \"https://github.com/simple-icons/simple-icons\",\n    what: \"Brand logos" },
  "packages not in the file": { old: "    ...PACKAGES.map((p) => `  ${packageRow(p)}`),\n", fresh: "" },
  // The German language pack.
  "language pack without table": { old: "what: \"German wording of Explorer and editor adopted\", files: [\"web/test/fixtures/vscode-de-wordings.json\"]", fresh: "what: \"German wording of Explorer and editor adopted\", files: []" },
  "language pack without license text": { old: "stroke, MIT_VSCODE_LOC);", fresh: "stroke);" },
  "language pack without fixed state": { old: "revision: \"62d5443b567022539ba6e8565b0f43f5f6b3682b\"", fresh: "revision: \"main\"" },
  "language pack without references view": { old: "path: \"i18n/vscode-language-pack-de/translations/extensions/vscode.references-view.i18n.json\"", fresh: "path: \"i18n/vscode-language-pack-de/translations/extensions/vscode.references.i18n.json\"" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-third-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "thirdParty.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `third-party-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, places: SOURCE.split(s.old).length - 1 };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck", "--lib", "es2022"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  if (text.split("\n").some((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z)) || !fs.existsSync(path.join(out, "thirdParty.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (d) => import(pathToFileURL(path.join(out, d.replace(/\.ts$/, ".js"))).href);
const real = await load("thirdParty.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, M: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const TXT = read("public", "THIRD_PARTY_NOTICES.txt");

function computation(M, { txt, files }) {
  assert.equal(txt, M.hintText(), "web/public/THIRD_PARTY_NOTICES.txt is not `hintText()`: rewrite it");
  assert.ok(txt.includes("Permission is hereby granted, free of charge") && txt.includes("Copyright (c) 2015 - present Microsoft Corporation"), "the MIT text is missing in the file");
  // The entries: complete, the source is the repo at the tag, never the installed product.
  for (const h of M.HINTS) {
    const identifier = IDENTIFIER[h.name];
    assert.ok(identifier, `entry "${h.name}" without identifier in the test (IDENTIFIER)`);
    assert.ok(h.originator.trim() && /Microsoft/.test(h.originator), `${h.name}: originator missing`);
    assert.match(h.licenseUrl, /^https:\/\/\S+$/, `${h.name}: license without link`);
    assert.match(h.license, identifier, `${h.name}: license does not match the identifier`);
    assert.match(h.repo, /^microsoft\/[\w-]+$/, `${h.name}: no repo`);
    assert.match(h.revision, /^(?:v?\d+\.\d+\.\d+(-\d+)?|[0-9a-f]{40})$/, `${h.name}: the state is neither a tag with an exact version nor a whole commit`);
    assert.equal(M.sourceOf(h), `https://github.com/${h.repo}/tree/${h.revision}`, `${h.name}: the source is not the repo at the tag`);
    assert.doesNotMatch(`${M.originOf(h)} ${JSON.stringify(h)}`, PRODUCT, `${h.name}: the origin names the installed product (product license, not MIT)`);
    assert.ok(h.changes.length > 0 && h.chunks.length > 0, `${h.name}: without changes or pieces`);
    for (const s of h.chunks) {
      assert.ok(["Port of", "Taken from"].includes(s.kind) && /^\S+$/.test(s.path) && s.what.trim() && s.files.length > 0, `${h.name}: piece ${s.path} incomplete`);
      for (const z of [`  ${M.chunkRow(s)}`, ...s.files.map((d) => `    ${d}`)]) assert.ok(txt.includes(z), `${h.name}: "${z}" is missing in the file`);
    }
    for (const z of [h.originator, `${h.license} — ${h.licenseUrl}`, M.sourceOf(h), M.originOf(h)]) assert.ok(txt.includes(z), `${h.name}: "${z}" is missing in the file`);
  }
  // Marker <-> list, both directions.
  const expected = new Map(); // file -> markers its pieces require
  for (const h of M.HINTS) for (const s of h.chunks) for (const d of s.files) expected.set(d, [...(expected.get(d) ?? []), M.markerOf(h, s)]);
  for (const [d, markers] of expected) {
    assert.ok(files[d] != null, `${d} is in the list but does not exist`);
    const present = M.markersIn(files[d]);
    for (const m of markers) assert.ok(present.includes(m), `${d}: marker "${m}" is missing in the header (entry without marker)`);
  }
  for (const [d, text] of Object.entries(files)) {
    for (const m of M.markersIn(text)) assert.ok((expected.get(d) ?? []).includes(m), `${d}: marker "${m}" without a piece in lib/thirdParty.ts (reimplementation without entry)`);
  }
  // Whoever names a third-party license is in the list.
  const withoutHint = Object.entries(files).filter(([d, text]) => LICENSE_IN_HEADER.test(text) && !expected.has(d)).map(([d]) => d);
  assert.deepEqual(withoutHint, [], "files name a third-party license but are in no notice (lib/thirdParty.ts)");
  // The free text "modelled on VS Code": marker or named exception; every exception still applies.
  const freeText = Object.entries(files).filter(([d, text]) => d.startsWith("web/src/") && FREE_TEXT.test(text));
  const unresolved = freeText.filter(([d, text]) => !M.markersIn(text).length && !(d in EXCEPTIONS)).map(([d]) => d);
  assert.deepEqual(unresolved, [], "\"modelled on VS Code\" without marker and without a named exception: a reimplementation needs marker and entry, a behavior an exception with a reason");
  for (const [d, reason] of Object.entries(EXCEPTIONS)) {
    assert.ok(reason.trim(), `exception ${d} without reason`);
    assert.ok(files[d] != null && FREE_TEXT.test(files[d]), `exception ${d} stale: the file no longer writes "modelled on VS Code"`);
    assert.equal(M.markersIn(files[d]).length, 0, `exception ${d} carries a marker, so it is no exception`);
  }
  // Whoever carries a marker does not name the installed product as the origin.
  for (const d of expected.keys()) assert.doesNotMatch(files[d], PRODUCT, `${d}: the header names the installed product as the origin`);
  const codicons = M.HINTS.find((h) => h.name === "Codicons");
  assert.ok(codicons?.changes.includes("Outlines converted to a 16×16 grid and rounded"), "Codicons: the notice about the conversion is missing (CC BY 4.0 requires a notice of changes)");
  for (const d of ["web/src/lib/codicon-symbols.ts", "web/src/lib/codicons.ts", "web/src/components/code/EditorTitleSymbols.tsx"]) assert.ok(M.filesOf(codicons).includes(d), `Codicons: ${d} is missing`);
  assert.equal(M.HINT_FILE, "/THIRD_PARTY_NOTICES.txt");
  // The German wordings: the entry, its table and the license text of the package.
  const loc = M.HINTS.find((h) => h.repo === "microsoft/vscode-loc");
  assert.ok(loc && M.filesOf(loc).includes("web/test/fixtures/vscode-de-wordings.json"), "language pack: without an entry or without the table of wordings");
  for (const p of ["main.i18n.json", "extensions/vscode.git.i18n.json", "extensions/vscode.references-view.i18n.json", "extensions/vscode.typescript-language-features.i18n.json", "extensions/vscode.markdown-language-features.i18n.json"]) {
    assert.ok(loc.chunks.some((x) => x.path === `i18n/vscode-language-pack-de/translations/${p}` && x.files.includes("web/test/fixtures/vscode-de-wordings.json")), `language pack: ${p} is missing`);
  }
  assert.ok(txt.includes("Visual Studio Code Localization Packs\nCopyright (c) Microsoft Corporation"), "language pack: the license text is missing in the file");
  // The courtesy attributions: complete, every row and file in the file, every file exists; the brand logos are named.
  for (const a of M.ATTRIBUTIONS) {
    assert.ok(a.name.trim() && a.originator.trim() && a.license.trim() && a.what.trim() && a.files.length > 0, `${a.name}: attribution incomplete`);
    assert.match(a.licenseUrl, /^https:\/\/\S+$/, `${a.name}: license without link`);
    assert.match(a.source, /^https:\/\/\S+$/, `${a.name}: no source`);
    for (const z of [`  ${M.attributionRow(a)}`, `    ${a.what}`, ...a.files.map((d) => `    ${d}`)]) assert.ok(txt.includes(z), `${a.name}: "${z}" is missing in the file`);
    for (const d of a.files) assert.ok(fs.existsSync(path.join(repo, d)), `${a.name}: ${d} does not exist`);
  }
  assert.ok(M.ATTRIBUTIONS.some((a) => /CC0/.test(a.license) && a.files.includes("web/src/components/brandLogos.ts")), "the simple-icons logos (CC0) are not attributed");
  // The packages of the backend: as in the lockfile, the whole wrapper of markdown-it, allowed licenses, every row in the file.
  const names = new Set(M.PACKAGES.map((p) => p.name));
  for (const n of wrapper("markdown-it", LOCK)) assert.ok(names.has(n), `package ${n} (pulled in by markdown-it) is missing in PACKAGES`);
  for (const p of M.PACKAGES) {
    const e = LOCK[`node_modules/${p.name}`];
    assert.ok(e && !e.dev, `${p.name}: not in the lockfile of the backend (or only for development)`);
    assert.equal(p.version, e.version, `${p.name}: version differs from the lockfile`);
    assert.equal(p.license, e.license, `${p.name}: license differs from the lockfile`);
    assert.ok(ALLOWED.has(p.license), `${p.name}: license ${p.license} not checked`);
    assert.match(p.repo, /^[\w.-]+\/[\w.-]+$/, `${p.name}: no repo`);
    assert.ok(txt.includes(`  ${M.packageRow(p)}`), `${p.name}: is missing in the file`);
  }
  return { markers: [...expected.values()].flat().length, freeText: freeText.length };
}

test("(1) Computation: file = hintText(), marker <-> list, free text with marker or exception, source = repo at the tag (with counter-probes)", () => {
  const z = computation(real, { txt: TXT, files: FILES });
  assert.ok(z.markers >= 14 && z.freeText >= 3, `too few markers (${z.markers}) or free texts (${z.freeText}): does the test search in the right place?`);
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}x)`);
  assert.deepEqual(stale, [], "stale sabotages");
  const not = sabotaged.filter((s) => { try { computation(s.M, { txt: TXT, files: FILES }); return true; } catch { return false; } }).map((s) => s.name);
  assert.deepEqual(not, [], "sabotages of the computation that no check catches");
  // The environment: new files and changed headers.
  const without = (d, f) => ({ ...FILES, [d]: f(FILES[d]) });
  const withoutMarkers = (text) => text.split("\n").filter((rowLine) => !/^\/\/ (Port of|Taken from): /.test(rowLine)).join("\n");
  const environment = [
    ["new file with license without notice", { ...FILES, "web/src/lib/fresh.ts": "// MIT license\n" }],
    ["reimplementation without entry (marker)", { ...FILES, "web/src/lib/fresh.ts": "// Port of: microsoft/vscode src/vs/base/common/arrays.ts (MIT)\nexport {};\n" }],
    ["reimplementation without marker (free text)", { ...FILES, "web/src/lib/fresh.ts": "// modelled on VS Code `binarySearch`\nexport {};\n" }],
    ["header without marker (backend)", without("server/backend/electron/server/runtime/fast-open.js", withoutMarkers)],
    ["header without marker (sticky)", without("web/src/lib/tree-sticky.ts", withoutMarkers)],
    ["marker with wrong license", without("web/src/lib/tab-bar.ts", (t) => t.replace("src/vs/base/common/labels.ts (MIT)", "src/vs/base/common/labels.ts (CC BY 4.0)"))],
    ["exception stale", without("web/src/lib/search-rules.ts", (t) => t.replaceAll("modelled on VS Code", "like VS Code"))],
    ["header names the product", without("web/src/lib/fuzzy-scorer.ts", (t) => `${t}\n// read in the installed bundle workbench.desktop.main.js\n`)],
    ["file changed by hand", null],
    ["table without marker", without("web/test/fixtures/vscode-de-wordings.json", () => "")],
    ["table with foreign marker", without("web/test/fixtures/vscode-de-wordings.json", (t) => `${t}\n// Taken from: microsoft/vscode-loc i18n/vscode-language-pack-fr/translations/main.i18n.json (MIT)`)],
  ];
  for (const [name, files] of environment) {
    const u = files ? { txt: TXT, files } : { txt: TXT.replace("CC BY 4.0", "CC BY-SA 4.0"), files: FILES };
    assert.throws(() => computation(real, u), undefined, `counter-probe "${name}" is not caught`);
  }
  console.log(`  [third-party] ${z.markers} markers, ${z.freeText} free texts (${Object.keys(EXCEPTIONS).length} named exceptions), ${sabotaged.length + environment.length} counter-probes caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const Q = {
  page: read("src", "components", "settings", "ThirdPartyHints.tsx"),
  modal: read("src", "components", "settings", "SettingsModal.tsx"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
function sources(q) {
  const s = withoutComments(q.page), m = withoutComments(q.modal);
  assert.ok(s.includes("import { ATTRIBUTIONS, HINTS, HINT_FILE, PACKAGES, originOf, sourceOf } from \"@/lib/thirdParty\";") && s.includes("{HINTS.map((h) => ("), "page: not from the ONE list");
  assert.ok(s.includes("<Group title={t(\"Further attributions\")}>") && s.includes("{ATTRIBUTIONS.map((a) => (") && s.includes("{t(a.what)}") && s.includes("href={a.licenseUrl}"), "page: the attributions are missing or do not go through t()");
  assert.ok(s.includes("<Group title={t(\"Backend packages\")}>") && s.includes("{PACKAGES.map((p) => (") && s.includes("data-third-party-package>{p.name} {p.version}</span>} hint={p.license}"), "page: the packages are missing");
  assert.ok(s.includes("<Row title={t(\"Author\")}><span className=\"text-[12.5px]\">{h.originator}</span></Row>"), "page: no originator");
  assert.ok(s.includes("href={h.licenseUrl}") && s.includes("data-third-party-license>{h.license}</a>"), "page: the license is not a link");
  assert.ok(s.includes("<Row title={t(\"Source\")} hint={originOf(h)} wide>") && s.includes("href={sourceOf(h)}"), "page: no source (repo at the tag)");
  assert.ok(s.includes("<Row title={t(\"Changes\")} hint={h.changes.map((a) => t(a)).join(\" · \")} />"), "page: the changes are missing or do not go through t()");
  assert.ok(s.includes("{h.chunks.map((s) => (") && s.includes("data-third-party-chunk>{s.path}</span>"), "page: no pieces (path in the repo)");
  assert.ok(s.includes("{t(s.kind === \"Port of\" ? \"Reimplementation\" : \"Taken over\")} · {t(s.what)} · <span className=\"font-mono\">{s.files.join(\", \")}</span>"), "page: kind, content or files of a piece are missing or do not go through t()");
  assert.ok(s.includes("href={HINT_FILE}") && s.includes("t(\"Full text including licenses\")"), "page: no link to the file");
  assert.ok(m.includes("import { ThirdPartyHints } from \"@/components/settings/ThirdPartyHints\";")
    && m.includes("const HINTS: Section = { key: \"hints\", label: \"Third-Party Notices\", icon: <HintsIcon />, render: () => <ThirdPartyHints /> };"), "modal: the page is not registered");
  assert.ok(m.includes("<div className=\"contents md:mt-auto md:block md:pt-4\" data-set-footer>{entry(HINTS)}</div>"), "modal: no row at the foot of the list");
  assert.ok(m.includes("const flat = useMemo(() => [...groups.flatMap((g) => g.entries), HINTS], [groups]);"), "modal: the page cannot be opened (not in `flat`)");
  const key = ["Backend packages", "Further attributions", ...real.ATTRIBUTIONS.map((a) => a.what), "Third-Party Notices", "Author", "License", "Source", "Changes", "Open", "Full text including licenses",
    ...real.HINTS.flatMap((h) => [...h.changes, ...h.chunks.flatMap((st) => [st.kind === "Port of" ? "Reimplementation" : "Taken over", st.what])])];
  for (const k of key) assert.ok(q.i18n.includes(`\n  ${JSON.stringify(k)}: `), `"${k}" without a German entry`);
}
const SOURCE_SABOTAGES = [
  ["page without originator", "page", "<Row title={t(\"Author\")}><span className=\"text-[12.5px]\">{h.originator}</span></Row>", ""],
  ["license without link", "page", "href={h.licenseUrl}", "href=\"#\""],
  ["source without tag", "page", "href={sourceOf(h)}", "href={`https://github.com/${h.repo}`}"],
  ["changes without t()", "page", "h.changes.map((a) => t(a)).join(\" · \")", "h.changes.join(\" · \")"],
  ["pieces missing", "page", "{h.chunks.map((s) => (", "{[].map((s: (typeof h.chunks)[number]) => ("],
  ["piece without t()", "page", "{t(s.kind === \"Port of\" ? \"Reimplementation\" : \"Taken over\")} · {t(s.what)} ·", "{s.kind} · {s.what} ·"],
  ["page without files", "page", "{s.files.join(\", \")}", "{s.files.length}"],
  ["page without file link", "page", "href={HINT_FILE}", "href=\"\""],
  ["page without attributions", "page", "{ATTRIBUTIONS.map((a) => (", "{[].map((a: (typeof ATTRIBUTIONS)[number]) => ("],
  ["attribution without t()", "page", "{t(a.what)}", "{a.what}"],
  ["page without packages", "page", "{PACKAGES.map((p) => (", "{[].map((p: (typeof PACKAGES)[number]) => ("],
  ["modal without row", "modal", "data-set-footer>{entry(HINTS)}</div>", "data-set-footer />"],
  ["modal does not open", "modal", "g.entries), HINTS], [groups]);", "g.entries)], [groups]);"],
  ["translation missing", "i18n", "  \"Outlines converted to a 16×16 grid and rounded\": \"Umrisse auf ein 16×16-Raster umgerechnet und gerundet\",\n", ""],
  ["translation of a piece missing", "i18n", "  \"Sticky folders in the tree reimplemented\": \"Haftende Ordner im Baum nachgebaut\",\n", ""],
];
test("(2) Sources: page in the settings, row at the foot of the list, German entries (with counter-probes)", (tt) => {
  sources(Q);
  for (const [name, k, old, fresh] of SOURCE_SABOTAGES) {
    const n = Q[k].split(old).length - 1;
    assert.equal(n, 1, `counter-probe "${name}" is stale: the spot occurs ${n}x in ${k}`);
    assert.throws(() => sources({ ...Q, [k]: Q[k].replace(old, fresh) }), undefined, `counter-probe "${name}" is not caught`);
  }
  tt.diagnostic(`${SOURCE_SABOTAGES.length} counter-probes caught`);
});
