// The German wordings of Explorer and editor as in VS Code's German language pack.
//
// The table web/test/fixtures/vscode-de-wordings.json holds per row the cbase text (`fresh`), what stood there before (`prev`), the
// key in the pack (microsoft/vscode-loc, i18n/vscode-language-pack-de) and its value VERBATIM (`vscode`); this test fetches nothing
// from the network. The ENGLISH text is the key in the code; the German cbase text is the VALUE in lib/i18n-de.ts. Checked:
//   (a) every cbase text is a German value in lib/i18n-de.ts (exactly once, its key also exactly once), and its key is used in
//       web/src (as a string);
//   (b) no old text is left in web/src (neither itself nor via its key) or as a value in i18n-de.ts — except in the files the row
//       names explicitly (`staysIn`, with reason);
//   (c) "equal" means equal: the cbase text is the pack's value, except cbase's typography ("…" instead of "...", „“ instead of ""
//       or **…**) and the placeholders ({0} is named after its content in cbase); a palette command carries its category in front
//       ("Ansicht: …", field `category`), and every category is listed under `categories` with the pack's value and, where it
//       differs, the reason;
//   (d) "du" means: the same wording, only the form of address — after switching Sie → du the pack's value (named deviation:
//       cbase uses du);
//   (e) no cbase text of the table uses Sie;
//   (f) what deliberately stays (`stays`, an error in the pack or a key with another meaning) stands unchanged;
//   (g) if a row carries `en` (VS Code 1.143.1's English wording, read from the installed bundle `nls.messages.json` under the same
//       key; for "adjusted" the adjusted version), i18n-de.ts translates the text exactly so ("Maximize Panel" instead of the
//       older "Maximize Panel Size").
// Each counter-test changes ONE place (the table, a source or i18n-de.ts) and must turn red. The German wordings in the table and in
// the counter-tests are German on purpose.
//
// Run:  node --test --test-reporter=tap web/test/vscode-de-wordings.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const TABLE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "vscode-de-wordings.json"), "utf8"));
const allFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
const I18N_PATH = "src/lib/i18n-de.ts";
const SOURCES = Object.fromEntries(allFiles(path.join(webDir, "src")).filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => [path.relative(webDir, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")]));

const lit = (s) => JSON.stringify(s);
/** The rows of i18n-de.ts (one per line `  "English": "Deutsch",`): English key and German value. */
const rows = (i18n) => [...i18n.matchAll(/^ {2}("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$/gm)].map((m) => ({ key: JSON.parse(m[1]), de: JSON.parse(m[2]) }));
/** The English text of a key: without the context suffix `##word` (lib/i18n.ts `plain`). */
const plain = (k) => (k.indexOf("##") < 0 ? k : k.slice(0, k.indexOf("##")));
/** Factor out cbase's typography: "…" instead of "..." (no space before), quotation marks and **…** uniform, placeholders without
 *  names. */
const norm = (s) => s.replace(/\s*(\.\.\.|…)/g, "…").replace(/\*\*(.*?)\*\*/g, "\"$1\"").replace(/[„“”]/g, "\"").replace(/\{\w+\}/g, "{}");
/** Sie → du (the forms that occur in the pack). */
const informalAddress = (s) => s
  .replace(/\bSind Sie sicher, dass Sie\b/g, "Bist du sicher, dass du").replace(/\bverschieben möchten\b/g, "verschieben möchtest")
  .replace(/\bMöchten Sie\b/g, "Möchtest du").replace(/\bSie sind dabei\b/g, "Du bist dabei").replace(/\bSie löschen\b/g, "Du löschst")
  .replace(/\bWählen Sie\b/g, "Wähle").replace(/\bGehen Sie\b/g, "Gehe");

function check({ table, sources }) {
  const i18n = sources[I18N_PATH];
  const all = rows(i18n);
  /** The keys under which a German text stands in i18n-de.ts. */
  const keysOf = (de) => all.filter((z) => z.de === de).map((z) => z.key);
  const uses = (s, ks) => ks.some((k) => s.includes(lit(k)));
  const withoutI18n = Object.entries(sources).filter(([d]) => d !== I18N_PATH);
  const error = [];
  for (const k of table.categories) if (k.text !== k.vscode && !k.reason) error.push(`category "${k.text}" deviates from the pack without a reason`);
  for (const e of table.entries) {
    const location = `„${e.fresh}“`;
    const before = e.category ? `${e.category}: ` : "";
    if (e.category && !table.categories.some((k) => k.text === e.category)) error.push(`${location}: category "${e.category}" without an entry under categories`);
    // (a)
    const own = keysOf(e.fresh);
    if (own.length !== 1) error.push(`${location}: ${own.length}× as German text in i18n-de.ts`);
    for (const k of own) { const n = all.filter((z) => z.key === k).length; if (n !== 1) error.push(`${location}: its key "${k}" stands ${n}× in i18n-de.ts`); }
    if (!withoutI18n.some(([, s]) => uses(s, own))) error.push(`${location}: not used anywhere in web/src`);
    // (b)
    if (e.prev !== null) {
      const stays = new Set(e.staysIn ?? []);
      const old = keysOf(e.prev);
      const still = withoutI18n.filter(([d, s]) => !stays.has(d) && (s.includes(lit(e.prev)) || uses(s, old))).map(([d]) => d);
      if (still.length) error.push(`"${e.prev}" is still in ${still.join(", ")}`);
      if (old.length && !stays.size) error.push(`"${e.prev}" is still German text in i18n-de.ts`);
      for (const d of stays) if (!uses(sources[d] ?? "", old)) error.push(`"${e.prev}": ${d} no longer carries it — the exception is outdated`);
    }
    // (c), (d)
    if (e.kind === "equal" && norm(e.fresh) !== norm(before + e.vscode)) error.push(`${location} is not equal to the pack "${before}${e.vscode}"`);
    if (e.kind === "du" && norm(e.fresh) !== norm(before + informalAddress(e.vscode))) error.push(`${location} is not the pack in the du form ("${informalAddress(e.vscode)}")`);
    if (e.kind === "du" && informalAddress(e.vscode) === e.vscode) error.push(`${location}: "du" without a Sie form in the pack`);
    if (!["equal", "du", "term", "adjusted"].includes(e.kind)) error.push(`${location}: unknown kind ${e.kind}`);
    if (e.kind === "adjusted" && !e.annotation) error.push(`${location}: "adjusted" without a reason`);
    if (!e.file || !e.key || !e.vscode) error.push(`${location}: without a source in the pack`);
    // (e)
    if (/\b(Sie|Ihre?n?)\b/.test(e.fresh)) error.push(`${location} uses Sie`);
    // (g)
    if (e.en !== undefined && JSON.stringify(own.map(plain)) !== JSON.stringify([e.en])) error.push(`${location}: English ${JSON.stringify(own.map(plain))} instead of "${e.en}"`);
  }
  // (f)
  for (const b of table.stays) {
    if (!keysOf(b.text).length) error.push(`deliberately stayed, but gone: "${b.text}"`);
    if (!b.reason) error.push(`"${b.text}" stays without a reason`);
  }
  return error;
}

const REAL = { table: TABLE, sources: SOURCES };
const entry = (fresh) => TABLE.entries.find((e) => e.fresh === fresh);
const withEntry = (fresh, f) => ({ ...TABLE, entries: TABLE.entries.map((e) => (e === entry(fresh) ? f(e) : e)) });
const replaced = (file, prev, fresh) => {
  const s = SOURCES[file];
  assert.equal(s.split(prev).length - 1, 1, `counter-test outdated: ${prev.slice(0, 60)} is not exactly once in ${file}`);
  return { ...SOURCES, [file]: s.replace(prev, fresh) };
};

test("(1) the wordings of Explorer and editor stand as in VS Code's German language pack", (tt) => {
  const error = check(REAL);
  assert.deepEqual(error, []);
  const kinds = TABLE.entries.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
  tt.diagnostic(`${TABLE.entries.length} wordings (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(", ")}), ${TABLE.stays.length} deliberately stayed, ${TABLE.categories.length} categories`);
});

test("(2) counter-tests: every change to table, source or translation turns red", (tt) => {
  // The one key of a German text (read from i18n-de.ts, not copied) and the swap of its German value.
  const K = (de) => { const ks = rows(SOURCES[I18N_PATH]).filter((z) => z.de === de).map((z) => z.key); assert.equal(ks.length, 1, `counter-test outdated: "${de}" stands ${ks.length}× as German text in i18n-de.ts`); return ks[0]; };
  const german = (fresh, prev) => replaced(I18N_PATH, `\n  ${lit(K(fresh))}: ${lit(fresh)},`, `\n  ${lit(K(fresh))}: ${lit(prev)},`);
  const COUNTER_PROBES = [
    ["old text back in the Explorer", { sources: german("Mit Auswahl vergleichen", "Mit ausgewählter Datei vergleichen") }],
    ["old text back in the timeline", { sources: german("Commithash kopieren", "Commit-Hash kopieren") }],
    ["translation missing", { sources: replaced(I18N_PATH, `\n  ${lit(K("Auswahl vergleichen"))}: `, `\n  ${lit(`${K("Auswahl vergleichen")} (fort)`)}: `) }],
    ["translation duplicated", { sources: replaced(I18N_PATH, `\n  ${lit(K("Auswahl vergleichen"))}: `, `\n  ${lit(K("Auswahl vergleichen"))}: "x",\n  ${lit(K("Auswahl vergleichen"))}: `) }],
    ["old key stays in the translation", { sources: replaced(I18N_PATH, `\n  ${lit(K("Gehe zu Verweisen"))}: `, `\n  "Go to References##old": "Gehe zu Referenzen",\n  ${lit(K("Gehe zu Verweisen"))}: `) }],
    ["\"equal\" with a typo", { table: withEntry("Auswahl vergleichen", (e) => ({ ...e, fresh: "Auswahl vergleichen ", vscode: "Auswahl vergleichen" })) }],
    ["\"equal\", but deviating from the pack", { table: withEntry("Ersetzung umschalten", (e) => ({ ...e, vscode: "Ersetzen umschalten" })) }],
    ["\"du\" changes more than the form of address", { table: withEntry("Bist du sicher, dass du „{name}“ in „{target}“ verschieben möchtest?", (e) => ({ ...e, vscode: "Sind Sie sicher, dass Sie \"{0}\" nach \"{1}\" verschieben möchten?" })) }],
    ["cbase uses Sie", { table: withEntry("Möchtest du {n} Dateien wirklich in „{target}“ verschieben?", (e) => ({ ...e, fresh: "Möchten Sie {n} Dateien wirklich in „{ziel}“ verschieben?" })) }],
    ["\"adjusted\" without a reason", { table: withEntry("Möchtest du {n} Dateien wirklich in „{target}“ verschieben?", (e) => ({ ...e, annotation: "" })) }],
    ["exception outdated", { table: withEntry("Ersetzung umschalten", (e) => ({ ...e, staysIn: ["src/components/code/SearchView.tsx"] })) }],
    ["old text outside the exception", { sources: replaced("src/components/code/SearchView.tsx", `title={t(${lit(K("Ersetzung umschalten"))})}`, `title={t(${lit(K("Ersetzen umschalten"))})}`) }],
    ["text without a user", { sources: replaced("src/components/code/panel/ProblemsView.tsx", `t(${lit(K("Informationen anzeigen"))})`, "t(\"Infos\")") }],
    ["category forgotten", { table: withEntry("Ansicht: Editor beibehalten", (e) => ({ ...e, category: undefined })) }],
    ["category without an entry", { table: withEntry("Ansicht: Editor beibehalten", (e) => ({ ...e, category: "Anzeigen", fresh: "Anzeigen: Editor beibehalten" })) }],
    ["category deviates without a reason", { table: { ...TABLE, categories: TABLE.categories.map((k) => ({ ...k, reason: "" })) } }],
    ["placeholder in quotation marks, the pack without", { table: withEntry("Du bist dabei, {name} trotz nicht gespeicherter Änderungen zu löschen. Möchtest du fortfahren?", (e) => ({ ...e, fresh: "Du bist dabei, „{name}“ trotz nicht gespeicherter Änderungen zu löschen. Möchtest du fortfahren?" })) }],
    // The menus of editor and Explorer.
    ["old title of the editor context menu back", { sources: german("Editor-Kontextmenü anzeigen", "Kontextmenü zeigen") }],
    ["old text \"Dateien hochladen…\" back", { sources: german("Hochladen…", "Dateien hochladen…") }],
    ["download without the ellipsis in the Explorer", { sources: replaced("src/components/code/explorer/ExplorerTree.tsx", `: t(${lit(K("Herunterladen…"))})`, `: t(${lit(K("Herunterladen"))})`) }],
    ["Sie form in the menu", { table: withEntry("Gehe zu Quelldefinition", (e) => ({ ...e, fresh: "Gehen Sie zu Quelldefinition" })) }],
    ["deliberately kept text gone", { sources: german("Vorwärts navigieren", "Vorwärts") }],
    // The commands and the name of the editor groups.
    ["old title of a group command back", { sources: german("Ansicht: Fokus in erster Editor-Gruppe", "Ansicht: Erste Editorgruppe fokussieren") }],
    ["width with a category again", { table: withEntry("Editor vergrößern (Breite)", (e) => ({ ...e, category: "Ansicht" })) }],
    ["old name of the group back", { sources: german("Editor-Gruppe {n}", "Editorgruppe {n}") }],
    ["English: the older wording", { sources: replaced(I18N_PATH, "\n  \"Maximize Panel\": \"Bereich „Maximieren“\",", "\n  \"Maximize Panel Size\": \"Bereich „Maximieren“\",") }],
    ["\"equal\" on the term again", { table: withEntry("Bereich „Wiederherstellen“", (e) => ({ ...e, fresh: "Bereichsgröße wiederherstellen" })) }],
  ];
  const notCaught = COUNTER_PROBES.filter(([, z]) => check({ ...REAL, ...z }).length === 0).map(([n]) => n);
  assert.deepEqual(notCaught, [], "counter-tests that do not turn red");
  tt.diagnostic(`${COUNTER_PROBES.length} counter-tests caught`);
});
