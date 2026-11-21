// Links, colors and the language of the messages: lsp/actions.js `link`/`colors`, lsp/sessions.js (capabilities, `locale`,
// environment, restart on language switch), lsp/table.js (bundles, defaults).
//   (1) `link` over a real session (fake server): file with `#L<line>,<col>`, web address (http/https/mailto), folder inside via
//       `command:revealInExplorer` (outside nothing), `command:vscodeMarkdownLanguageservice.open` with `selection`, a foreign
//       scheme nothing, a file outside with a token, no position => null; the capabilities `document_link`/`document_color` from the
//       capabilities
//   (2) `colors`: intact entries, channels 0…1, capped at COLORS_CAP (VS Code `editor.colorDecoratorsLimit` 500)
//   (3) the language: initialize carries `locale` (UI language), the environment of the entry reaches the process, a language switch
//       restarts the session at next use (then without bundle); TS gets `initializationOptions.locale`
//   (4) the bundles: CSS/JSON/Markdown find their German bundle in the source tree, in the container only next to the packages
//       (`CBASE_LSP_PACKAGES/cbase-lsp-l10n`), English none; the files are verbatim those from microsoft/vscode-loc (sha256) and
//       carry the servers' texts
//   (5) Markdown: link validation off as in VS Code (`markdown.validate.enabled` false)
//
// Run (from server/backend/): CBASE_EMBED_OFFLINE=1 node --test test/lsp-vu.test.js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { endAllSessions, setStatusReporter } from "../electron/server/lsp/sessions.js";
import { lspEditorResponse } from "../electron/server/lsp/routes.js";
import { COLORS_CAP, colorsOf } from "../electron/server/lsp/actions.js";
import { L10N_EXTENSION, L10N_FOLDER, SERVER_SCRIPT, entryFor, l10nBundle, setLspTable } from "../electron/server/lsp/table.js";
import { EDITOR_ACTIONS, CAPABILITIES } from "../electron/server/lsp/contract.js";
import { getUiLang, setUiLang } from "../electron/server/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-vu-")));
const project = path.join(root, "proj");
const outside = path.join(root, "outside");
for (const d of [project, outside, path.join(project, "docs")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, "a.css"), "a { color: red; }\n");
fs.writeFileSync(path.join(project, "docs", "b.md"), "# B\n");
fs.writeFileSync(path.join(outside, "secret.md"), "x\n");
const uri = (p) => pathToFileURL(p).href;
const uriJson = (p) => ({ $mid: 1, scheme: "file", path: p });
const command = (name, ...args) => `command:${name}?${encodeURIComponent(JSON.stringify(args))}`;
const priorLanguage = getUiLang();

// The fake server: links per line (line 2 only via resolve), colors (with broken entries), and in the hover what it saw at start.
const WRONG = path.join(root, "fake.mjs");
fs.writeFileSync(WRONG, `
let start = null, buffer = Buffer.alloc(0);
const write = (x) => { const t = JSON.stringify(x); process.stdout.write("Content-Length: " + Buffer.byteLength(t) + "\\r\\n\\r\\n" + t); };
const R = (z) => ({ start: { line: z, character: 0 }, end: { line: z, character: 10 } });
const LINKS = ${JSON.stringify([
  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, target: uri(path.join(project, "docs", "b.md")) + "#L3,2" },
  { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } }, target: "https://example.com/page?a=1" },
  { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 10 } }, data: { folder: true } },
  { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } }, target: command("revealInExplorer", uriJson(outside)) },
  { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } }, target: "smb://host/share" },
  { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } }, target: command("vscodeMarkdownLanguageservice.open", uriJson(path.join(project, "docs", "b.md")), { selection: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } } }) },
  { range: { start: { line: 6, character: 0 }, end: { line: 6, character: 10 } }, target: "mailto:a@b.example" },
  { range: { start: { line: 7, character: 0 }, end: { line: 7, character: 10 } }, target: uri(path.join(outside, "secret.md")) },
])};
const FOLDER = ${JSON.stringify(command("revealInExplorer", uriJson(path.join(project, "docs"))))};
function edit(m) {
  const response = (result) => write({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      start = { locale: m.params.locale ?? null, init: m.params.initializationOptions ?? null, env: process.env.VSCODE_L10N_BUNDLE_LOCATION ?? null };
      return response({ capabilities: { hoverProvider: true, documentLinkProvider: { resolveProvider: true }, colorProvider: true } });
    case "textDocument/hover": return response({ contents: { kind: "plaintext", value: JSON.stringify(start) } });
    case "textDocument/documentLink": return response(LINKS);
    case "documentLink/resolve": return response({ ...m.params, target: m.params.data?.folder ? FOLDER : undefined });
    case "textDocument/documentColor": return response([
      { range: R(0), color: { red: 1, green: 0, blue: 0, alpha: 1 } },
      { range: R(1), color: { red: 2, green: 0, blue: 0, alpha: 1 } },
      { range: R(2), color: { red: 0, green: 0.5, blue: 1 } },
      { color: { red: 0, green: 0, blue: 0, alpha: 1 } },
      { range: R(3), color: { red: 0.2, green: 0.4, blue: 0.6, alpha: 0.5 } },
    ]);
    default: if (m.id !== undefined) response(null);
  }
}
process.stdin.on("data", (c) => {
  buffer = Buffer.concat([buffer, c]);
  for (;;) { const i = buffer.indexOf("\\r\\n\\r\\n"); if (i < 0) return; const l = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, i).toString())[1]);
    if (buffer.length < i + 4 + l) return; const m = JSON.parse(buffer.subarray(i + 4, i + 4 + l).toString()); buffer = buffer.subarray(i + 4 + l); edit(m); }
});
`);
const TARGET = { projectId: "pvu", instance: null, root: project, base: project };
const ed = (action, body = {}) => lspEditorResponse(action, body, (f) => (f ? { ...TARGET, abs: path.join(project, f) } : { ...TARGET }));
const TEXT = "a { color: red; }\n".repeat(9);
const q = (line, extra = {}) => ({ file: "a.css", buffer: "p1", version: 1, text: TEXT, position: { line, character: 3 }, ...extra });

test.before(() => {
  setStatusReporter(() => {});
  setUiLang("de");
  setLspTable({ css: { command: [process.execPath, WRONG], environment: (ctx) => (ctx.locale === "de" ? { VSCODE_L10N_BUNDLE_LOCATION: `file:///bundle-${ctx.locale}.json` } : {}) } });
});
test.after(() => {
  endAllSessions("test");
  setLspTable(null);
  setStatusReporter(null);
  setUiLang(priorLanguage);
  fs.rmSync(root, { recursive: true, force: true });
});

test("(1) link: file with position, web, folder inside, open with selection; folder outside, foreign scheme and no position nothing", async () => {
  assert.ok(EDITOR_ACTIONS.includes("link") && EDITOR_ACTIONS.includes("colors"));
  assert.ok(CAPABILITIES.includes("document_link") && CAPABILITIES.includes("document_color"));
  const st = await ed("status", { file: "a.css" });
  assert.equal(st.status, 200);
  const l = async (z) => (await ed("link", q(z))).body.link;
  const r0 = await l(0);
  assert.deepEqual(r0, { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, target: { kind: "file", location: { file: "docs/b.md", range: { start: { line: 2, character: 1 }, end: { line: 2, character: 1 } } } } });
  const st2 = await ed("status", { file: "a.css" });
  const css = st2.body.languages.find((x) => x.language === "css");
  assert.ok(css.features.includes("document_link") && css.features.includes("document_color"), JSON.stringify(css.features));
  assert.deepEqual((await l(1)).target, { kind: "web", url: "https://example.com/page?a=1" });
  assert.deepEqual((await l(2)).target, { kind: "folder", file: "docs" }, "folder via resolve");
  assert.equal(await l(3), null, "a folder outside is in no tree");
  assert.equal(await l(4), null, "smb: opens nothing");
  assert.deepEqual((await l(5)).target, { kind: "file", location: { file: "docs/b.md", range: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } } } });
  assert.deepEqual((await l(6)).target, { kind: "web", url: "mailto:a@b.example" });
  const r7 = (await l(7)).target;
  assert.equal(r7.kind, "file");
  assert.equal(r7.location.file, path.join(outside, "secret.md"));
  assert.ok(typeof r7.location.external?.token === "string", "outside only with a token");
  assert.equal(await l(8), null, "no position");
});

test("(2) colors: intact entries, channels 0…1, capped", async () => {
  const r = await ed("colors", q(0));
  assert.deepEqual(r.body.colors, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
    { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } }, color: { red: 0.2, green: 0.4, blue: 0.6, alpha: 0.5 } },
  ]);
  const many = Array.from({ length: COLORS_CAP + 20 }, (_, i) => ({ range: { start: { line: i, character: 0 }, end: { line: i, character: 3 } }, color: { red: 0, green: 0, blue: 0, alpha: 1 } }));
  assert.equal(COLORS_CAP, 500, "VS Code editor.colorDecoratorsLimit");
  assert.equal(colorsOf(many).length, COLORS_CAP);
  assert.deepEqual(colorsOf(null), []);
});

test("(3) language: locale in initialize, environment at the process, switch => restart; TS gets initializationOptions.locale", async () => {
  const sah = async () => JSON.parse((await ed("hover", q(0))).body.contents);
  assert.deepEqual(await sah(), { locale: "de", init: {}, env: "file:///bundle-de.json" });
  setUiLang("en");
  assert.deepEqual(await sah(), { locale: "en", init: {}, env: null }, "restarted after the switch, without bundle");
  setUiLang("de");
  assert.equal((await sah()).locale, "de");
  setLspTable(null);
  try {
    assert.equal(entryFor("ts").init({ locale: "de" }).locale, "de");
    assert.equal("locale" in entryFor("ts").init({}), false);
  } finally {
    setLspTable({ css: { command: [process.execPath, WRONG] } });
  }
});

// Verbatim from microsoft/vscode-loc — the sha256 values are in ONE place, lsp/l10n/provenance.json (also the mark for web/test/thirdParty.test.mjs).
const ORIGIN = JSON.parse(fs.readFileSync(path.resolve(here, "..", "electron", "server", "lsp", "l10n", "provenance.json"), "utf8")).files;
// One text per server, as it reports it with l10n.t (vscode-css-languageservice, vscode-json-languageservice, vscode-markdown-languageservice).
const TEXTS = { css: "Unknown property: '{0}'", json: 'Missing property "{0}".', markdown: "No link definition found: '{0}'" };

test("(4) bundles: source tree, in the container only next to the packages, English none; verbatim from vscode-loc, with the servers' texts", () => {
  const source = path.resolve(here, "..", "electron", "server", "lsp", "l10n", "de");
  assert.deepEqual(Object.keys(L10N_EXTENSION).sort(), ["css", "json", "markdown"]);
  for (const [sp, erw] of Object.entries(L10N_EXTENSION)) {
    const file = path.join(source, `vscode.${erw}.i18n.json`);
    assert.equal(l10nBundle(sp, "de"), uri(file), sp);
    assert.equal(l10nBundle(sp, "en"), null);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), ORIGIN[`de/vscode.${erw}.i18n.json`]?.sha256, `${erw} is no longer verbatim`);
    const b = JSON.parse(fs.readFileSync(file, "utf8")).contents.bundle;
    assert.ok(typeof b[TEXTS[sp]] === "string" && b[TEXTS[sp]] !== TEXTS[sp], `${sp}: ${TEXTS[sp]} is missing in the bundle`);
  }
  // The entry point VS Code starts: it reads VSCODE_L10N_BUNDLE_LOCATION (the package's bin/ scripts bypass it).
  assert.deepEqual([SERVER_SCRIPT.css, SERVER_SCRIPT.json, SERVER_SCRIPT.markdown], [
    "lib/css-language-server/node/cssServerNodeMain.js", "lib/json-language-server/node/jsonServerNodeMain.js", "lib/markdown-language-server/node/workerMain.js",
  ], "without the l10n entry point the messages stay English");
  assert.equal(l10nBundle("ts", "de"), null, "TS translates tsserver itself");
  assert.equal(l10nBundle("css", "../de"), null);
  const prior = process.env.CBASE_LSP_PACKAGES;
  const packages = path.join(root, "packages");
  try {
    process.env.CBASE_LSP_PACKAGES = packages;
    assert.equal(l10nBundle("css", "de", { inContainer: true }), null, "in the container the server does not see B's source tree");
    const inImage = path.join(packages, L10N_FOLDER, "de", "vscode.css-language-features.i18n.json");
    fs.mkdirSync(path.dirname(inImage), { recursive: true });
    fs.writeFileSync(inImage, "{}");
    assert.equal(l10nBundle("css", "de", { inContainer: true }), uri(inImage));
    assert.equal(l10nBundle("css", "de"), uri(inImage), "the location next to the packages takes precedence");
    setLspTable(null);
    assert.deepEqual(entryFor("css").environment({ locale: "de", inContainer: true }), { VSCODE_L10N_BUNDLE_LOCATION: uri(inImage) });
    assert.deepEqual(entryFor("markdown").environment({ locale: "en" }), {});
    assert.deepEqual(entryFor("yaml").environment({ locale: "de" }), {}, "yaml brings its own bundle (locale in initialize)");
  } finally {
    if (prior === undefined) delete process.env.CBASE_LSP_PACKAGES; else process.env.CBASE_LSP_PACKAGES = prior;
    setLspTable({ css: { command: [process.execPath, WRONG] } });
  }
});

test("(5) markdown: link validation off as in VS Code (markdown.validate.enabled false)", () => {
  setLspTable(null);
  try {
    assert.equal(entryFor("markdown").response("markdown.validate.enabled", {}), false);
  } finally {
    setLspTable({ css: { command: [process.execPath, WRONG] } });
  }
});
