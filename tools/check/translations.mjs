// Completeness of the German translation: English is the source, German must carry every key.
//
//   web     t("…") / tr("…")           → web/src/lib/i18n-de.ts
//   server  T("…") / T`… ${x}`         → server/backend/electron/server/i18n-de.js   (a template's key has "{}" per value)
//   iOS     L("…")                     → mobile/CbaseMobile/Kit/LocDE*.swift
//
// Only calls with a literal first argument can be read from the source. Calls with a computed argument are counted
// (`dynamic`) so that their number is visible; their keys are checked where the table they come from is literal.
//   node tools/check/translations.mjs   prints the missing keys, exit 1 when there are any
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(REPO, "web/package.json"))("typescript");
const K = ts.SyntaxKind;

function files(root, dir, re) {
  const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", dir], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  let list = r.status === 0 ? r.stdout.split("\0").filter(Boolean) : null;
  if (!list) { list = []; const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); } else list.push(p); } }; walk(dir); }
  return list.filter((p) => re.test(p) && fs.existsSync(path.join(root, p)));
}

/** Keys of an object literal `export const DE = { "key": "value", … }` (JS/TS), read with the compiler — no evaluation. */
function objectKeys(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const keys = new Set();
  const visit = (n) => { if (n.kind === K.PropertyAssignment && (n.name.kind === K.StringLiteral || n.name.kind === K.NoSubstitutionTemplateLiteral)) keys.add(n.name.text); else ts.forEachChild(n, visit); };
  ts.forEachChild(sf, visit);
  return keys;
}

/** Calls of the given function names with a literal (or template) first argument. */
function callsJs(root, list, names, scriptKind) {
  const used = []; let dynamic = 0;
  for (const p of list) {
    const sf = ts.createSourceFile(p, fs.readFileSync(path.join(root, p), "utf8"), ts.ScriptTarget.Latest, true, scriptKind(p));
    const at = (n) => `${p}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const visit = (n) => {
      if (n.kind === K.CallExpression && n.expression.kind === K.Identifier && names.has(n.expression.text) && n.arguments.length) {
        const a = n.arguments[0];
        if (a.kind === K.StringLiteral || a.kind === K.NoSubstitutionTemplateLiteral) used.push([a.text, at(n)]);
        else if (a.kind === K.SpreadElement || a.kind !== K.TemplateExpression) dynamic++;
        else dynamic++;
      }
      if (n.kind === K.TaggedTemplateExpression && n.tag.kind === K.Identifier && names.has(n.tag.text)) {
        const t = n.template;
        used.push([t.kind === K.NoSubstitutionTemplateLiteral ? t.text : [t.head.text, ...t.templateSpans.map((s) => s.literal.text)].join("{}"), at(n)]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { used, dynamic };
}

export function web(root = REPO) {
  const de = objectKeys(path.join(root, "web/src/lib/i18n-de.ts"));
  const list = files(root, "web/src", /\.(ts|tsx)$/).filter((p) => !/i18n-de\.ts$/.test(p));
  const { used, dynamic } = callsJs(root, list, new Set(["t", "tr"]), (p) => (p.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return { keys: de.size, used: used.length, dynamic, missing: used.filter(([k]) => /\p{L}/u.test(k) && !de.has(k)) };
}
export function server(root = REPO) {
  const de = objectKeys(path.join(root, "server/backend/electron/server/i18n-de.js"));
  const list = files(root, "server/backend/electron", /\.(js|mjs)$/).filter((p) => !/i18n(-de)?\.js$/.test(p));
  const { used, dynamic } = callsJs(root, list, new Set(["T"]), () => ts.ScriptKind.JS);
  return { keys: de.size, used: used.length, dynamic, missing: used.filter(([k]) => /\p{L}/u.test(k) && !de.has(k)) };
}
export function ios(root = REPO) {
  const de = new Set();
  for (const p of files(root, "mobile/CbaseMobile/Kit", /\/LocDE[A-Za-z]*\.swift$/))
    for (const m of fs.readFileSync(path.join(root, p), "utf8").matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:\s*"/gm)) de.add(JSON.parse(m[1].replace(/\\\(/g, "\\\\(")));
  const used = []; let dynamic = 0;
  for (const p of files(root, "mobile/CbaseMobile", /\.swift$/).filter((p) => !/\/LocDE[A-Za-z]*\.swift$|\/Localization\.swift$/.test(p))) {
    const text = fs.readFileSync(path.join(root, p), "utf8");
    for (const m of text.matchAll(/(?<![A-Za-z0-9_.])L\(\s*("(?:[^"\\]|\\.)*")?/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      if (!m[1]) { dynamic++; continue; }
      if (/\\\(/.test(m[1])) { dynamic++; continue; }   // interpolated: not a key
      used.push([JSON.parse(m[1]), `${p}:${line}`]);
    }
  }
  return { keys: de.size, used: used.length, dynamic, missing: used.filter(([k]) => /\p{L}/u.test(k) && !de.has(k)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let n = 0;
  for (const [name, f] of [["web", web], ["server", server], ["ios", ios]]) {
    const r = f(); n += r.missing.length;
    console.log(`${name}: ${r.keys} German entries, ${r.used} literal calls, ${r.dynamic} computed, ${r.missing.length} missing`);
    for (const [k, at] of r.missing) console.log(`  ${at}\t${JSON.stringify(k).slice(0, 140)}`);
  }
  process.exit(n ? 1 : 0);
}
