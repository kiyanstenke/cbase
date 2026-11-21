// Links in every file like VS Code 1.143:
// (1) lib/link-detection.ts, EXECUTED: the automaton of linkComputer.ts (http/https/file case-insensitive, separators,
//     brackets only if opened inside the link, trailing `.,;:` dropped, the bracket before the link) — cases from linkComputer.test.ts (1.143.1).
// (2) lib/hover-sections.ts `hoverImageTarget`, EXECUTED: an image in the hover loads `data:image/…` (CSS "Baseline") and, like VS Code
//     1.143, `https:` (renderer `allowedMediaProtocols`, CSP `img-src … https:`; never http, file, protocol-relative, credentials, whitespace;
//     the size spec after `|` is dropped); the `<img>` sends no referrer.
// (3) The wiring (read): editor-links.ts hangs on EVERY file with a buffer, the hint "Follow link (CMD + click)" from the
//     language pack, ⌘ underlines the whole link, ⌘-click opens only http/https; cmd-hover steps back over an address and, without a
//     word, takes the character (`/`, `.`) as a link; the markdown hover takes the image switch.
// Each counter-test changes ONE place and must turn red.
//
// Run:  node --test --test-reporter=tap web/test/link-detection.test.mjs
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
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");

const SHEETS = { link: read("src", "lib", "link-detection.ts"), image: read("src", "lib", "hover-sections.ts") };
const SAB_COMPUTATION = {
  "lowercase only": ["link", "[Z.Start, 104, Z.H], [Z.Start, 72, Z.H],", "[Z.Start, 104, Z.H],"],
  "no file": ["link", "[Z.Start, 102, Z.F], [Z.Start, 70, Z.F],", ""],
  "ends with dot": ["link", "    if (kind(row.charCodeAt(last)) !== K.CannotEndIn) break;", "    break;"],
  "bracket before the link stays": ["link", "(before === 40 && after === 41) || ", ""],
  "bracket never closes": ["link", "case 41: k = round ? K.None : K.ForceTermination; break;", "case 41: k = K.None; break;"],
  "bracket always closes": ["link", "case 41: k = round ? K.None : K.ForceTermination; break;", "case 41: k = K.ForceTermination; break;"],
  "pipe does not separate": ["link", "～…|\";", "～…\";"],
  "quote does not separate": ["link", " \\t<>'\\\"、", " \\t<>、"],
  "last link missing": ["link", "  if (z === Z.Accept) out.push(link(row, start, n));", ""],
  "place inclusive": ["link", "l.from <= offset && offset < l.to", "l.from <= offset && offset <= l.to"],
  "image from anywhere": ["image", "return u.protocol === \"https:\" && !u.username && !u.password ? u.href : null;", "return u.href;"],
  "image also over http": ["image", "u.protocol === \"https:\" &&", "/^https?:$/.test(u.protocol) &&"],
  "image with credentials": ["image", " && !u.username && !u.password ? u.href", " ? u.href"],
  "image with whitespace": ["image", "  if (/\\s/.test(s)) return null;\n", ""],
  "image never over https": ["image", "return u.protocol === \"https:\" && !u.username && !u.password ? u.href : null;", "return null;"],
  "dimensions: width only": ["image", "...(h ? { height: Number(h[1]) } : {})", ""],
  "dimensions without separator": ["image", "const p = String(src ?? \"\").split(\"|\").map((t) => t.trim())[1];", "const p = String(src ?? \"\");"],
  "size spec stays": ["image", "String(src ?? \"\").split(\"|\")[0];", "String(src ?? \"\");"],
  "image also text": ["image", "/^data:image\\/(png|gif|jpe?g|webp|svg\\+xml)", "/^data:(image|text)\\/(png|gif|jpe?g|webp|svg\\+xml|html)"],
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-link-detection-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "link.ts"), SHEETS.link);
fs.writeFileSync(path.join(src, "image.ts"), SHEETS.image);
const copies = Object.entries(SAB_COMPUTATION).map(([name, [sheet, old, fresh]], i) => {
  const places = SHEETS[sheet].split(old).length - 1;
  fs.writeFileSync(path.join(src, `s${i}.ts`), SHEETS[sheet].replace(old, fresh));
  return { name, sheet, places, file: `s${i}.ts` };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck", "--lib", "es2022,dom", "--isolatedModules", "false"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  if (text.split("\n").some((z) => /error TS\d+/.test(z) && /(link|image)\.ts\(/.test(z)) || !fs.existsSync(path.join(out, "link.js")) || !fs.existsSync(path.join(out, "image.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (d) => import(pathToFileURL(path.join(out, d.replace(/\.ts$/, ".js"))).href);
const real = { link: await load("link.ts"), image: await load("image.ts") };
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, M: { ...real, [k.sheet]: await load(k.file) } })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* irrelevant */ }

function computation(M) {
  const urls = (z) => M.link.linksOfTheRow(z).map((l) => l.url);
  // linkComputer.test.ts (1.143.1) — selection.
  assert.deepEqual(urls("x = http://foo.bar"), ["http://foo.bar"]);
  assert.deepEqual(urls("x = (see http://foo.bar)"), ["http://foo.bar"], "the bracket that closes the one before the link does not belong to it");
  assert.deepEqual(urls("x = [see http://foo.bar]"), ["http://foo.bar"]);
  assert.deepEqual(urls("x = {see http://foo.bar}"), ["http://foo.bar"]);
  assert.deepEqual(urls("(see http://foo.bar)"), ["http://foo.bar"]);
  assert.deepEqual(urls("x = 'http://foo.bar'"), ["http://foo.bar"]);
  assert.deepEqual(urls("x =  \"http://foo.bar\""), ["http://foo.bar"]);
  assert.deepEqual(urls("x = <http://foo.bar>"), ["http://foo.bar"]);
  assert.deepEqual(urls("x = http://foo.bar|z"), ["http://foo.bar"]);
  assert.deepEqual(urls("See https://example.com/wiki/Lisp_(programming_language)."), ["https://example.com/wiki/Lisp_(programming_language)"], "a bracket inside the link stays, the trailing dot does not");
  assert.deepEqual(urls("a https://example.com/a, b HTTPS://EXAMPLE.ORG/b; c file:///etc/x:"), ["https://example.com/a", "HTTPS://EXAMPLE.ORG/b", "file:///etc/x"], "case does not matter, trailing `.,;:` dropped");
  assert.deepEqual(urls("x https:// y"), [], "no remainder, no link");
  assert.deepEqual(urls("(https://a.b/(x))"), ["https://a.b/(x)"], "the last bracket closes the one before the link");
  assert.deepEqual(urls("x = https://'abc'"), [], "a quote directly after `//` ends the attempt");
  assert.deepEqual(urls("htt://foo ftp://foo"), []);
  // The place: a character inside the link (also `/` and `.`) — the end exclusive.
  const z = "see https://a.b/c.d here";
  const l = M.link.linkAtPlace(z, z.indexOf("/c"));
  assert.ok(l && l.url === "https://a.b/c.d" && l.from === 4 && l.to === 19, JSON.stringify(l));
  assert.ok(M.link.linkAtPlace(z, z.indexOf(".d")), "on the dot");
  assert.equal(M.link.linkAtPlace(z, 19), null, "the character behind the link");
  assert.equal(M.link.linkAtPlace(z, 3), null);
  // Images in the hover: data:image and https like VS Code.
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(M.image.hoverImageTarget(png), png);
  assert.equal(M.image.hoverImageTarget("data:image/svg+xml;charset=utf-8,%3Csvg%3E"), "data:image/svg+xml;charset=utf-8,%3Csvg%3E");
  const network = "https://example.com/assets/img/baseline-widely-icon.png";
  assert.equal(M.image.hoverImageTarget(network), network, "https loads (VS Code: editor hover without `remoteImageIsAllowed`)");
  assert.equal(M.image.hoverImageTarget("https://a.b/x.png|width=16,height=16"), "https://a.b/x.png", "the size spec after | is dropped");
  assert.deepEqual(M.image.hoverImageDimensions("https://a.b/x.png|width=16,height=24"), { width: 16, height: 24 }, "dimensions like VS Code `parseHrefAndDimensions`");
  assert.deepEqual(M.image.hoverImageDimensions("https://a.b/x.png| height=8"), { height: 8 });
  assert.deepEqual(M.image.hoverImageDimensions("https://a.b/width=16.png"), {}, "no dimensions without |");
  for (const foreign of ["//cdn.example/x.png", "http://x/y.svg", "file:///etc/x.png", "https://user:pw@a.b/x.png", "https://a.b/x y.png", "data:text/html,<script>", "data:image/png;base64, iVBOR", "javascript:alert(1)", "image.png", ""])
    assert.equal(M.image.hoverImageTarget(foreign), null, `loads ${foreign}`);
}

test("(1) computation: links of one row like linkComputer.ts, the place inside the link, images in the hover data: and https (including counter-tests)", () => {
  computation(real);
  assert.deepEqual(copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`), [], "stale sabotages");
  const not = sabotaged.filter((s) => { try { computation(s.M); return true; } catch { return false; } }).map((s) => s.name);
  assert.deepEqual(not, [], "sabotages of the computation that no check catches");
});

const Q = {
  links: read("src", "components", "code", "editor-links.ts"),
  cmd: read("src", "components", "code", "cmd-hover.ts"),
  extension: read("src", "components", "code", "lsp-extension.ts"),
  md: read("src", "components", "code", "lsp-markdown.tsx"),
  markdown: read("src", "components", "Markdown.tsx"),
  i18n: read("src", "lib", "i18n-de.ts"),
  wordings: read("test", "fixtures", "vscode-de-wordings.json"),
};
function sources(q) {
  const l = withoutComments(q.links), c = withoutComments(q.cmd), e = withoutComments(q.extension), m = withoutComments(q.md);
  assert.ok(l.includes("const l = linkAtPlace(z.text, pos - z.from);") && l.includes("if (!l || !linkWay({ kind: \"web\", url: l.url })) return null;"), "the address does not come from the detection or opens more than http/https");
  assert.ok(l.includes("const followUps = tr(\"Follow link\"), key = isMac() ? tr(\"cmd + click\") : tr(\"ctrl + click\");") && l.includes("a.append(l, ` (${key})`);"), "the hint does not say \"Follow link (CMD + click)\"");
  assert.ok(l.includes("if (a) return { pos: a.from, end: a.to, above: true, create: () => ({ dom: linkHintNode(a.url) }) };")
    && l.includes("r = await questions(d, \"link\", { position: lspPosOf(doc, p) });"), "the hint is missing over an address or a language-service link");
  assert.ok(l.includes("const p = this.mod && m && v.dom.isConnected ? characterUnderPointer(v, m.x, m.y) : null;") && l.includes("v.dispatch({ effects: set.of(a ? { from: a.from, to: a.to } : null) });"), "⌘ does not underline the whole link");
  assert.ok(l.includes("window.open(a.url, \"_blank\", \"noopener,noreferrer\");") && l.includes("if (e.button !== 0 || e.altKey || e.shiftKey || !(isMac() ? e.metaKey : e.ctrlKey)) return false;"), "⌘-click does not open (or opens on every click)");
  assert.ok(l.includes("return v && t.docChanged ? null : v;"), "the underline stays after a change");
  assert.ok(/const base: Extension = \[[^\]]*\beditorLinks\]/.test(e), "links do not hang on every file (only with a language)");
  assert.ok(c.includes("if (character != null && addressAt(view.state, character)) {"), "cmd-hover does not step back over an address (double underline)");
  assert.ok(c.includes("const w = word ?? (on && character != null && can(d, \"document_link\") ? { from: character, to: character + 1 } : null);")
    && c.includes("const locations = onlyLink ? [] : await this.definitions(d, w);"), "on `/` and `.` of a link ⌘ underlines nothing");
  assert.ok(c.includes("if (stands && !stands.tooltip && this.isLink && w.from >= stands.from && w.to <= stands.to) return;"), "a link flickers when moving over its characters");
  assert.ok(m.includes("const HOVER_REFERENCES: MarkdownReferences = { image: hoverImageTarget, dimensions: hoverImageDimensions, link: () => null };") && m.includes("<MarkdownReferenceContext.Provider value={HOVER_REFERENCES}>"), "the hover loads images from anywhere");
  assert.ok(q.markdown.includes("if (own) return <img key={i} src={own} alt={image[1]} width={dimensions?.width} height={dimensions?.height} referrerPolicy=\"no-referrer\""), "an image in the hover (without dimensions) sends the referrer (the cbase address) to foreign hosts");
  for (const [w, de] of [["Follow link", "Link folgen"], ["cmd + click", "BEFEHL + Klicken"], ["ctrl + click", "STRG + Klicken"]]) {
    assert.ok(q.i18n.includes(`\n  "${w}": "${de}",`), `"${w}" without German text "${de}"`);
    assert.ok(q.wordings.includes(`"vscode": "${de}"`), `"${w}" not backed by the language pack`);
  }
}
const SOURCE_SABOTAGES = [
  ["address without switch", "links", "if (!l || !linkWay({ kind: \"web\", url: l.url })) return null;", "if (!l) return null;"],
  ["hint without key", "links", "a.append(l, ` (${key})`);", "a.append(l);"],
  ["hint always Ctrl", "links", "key = isMac() ? tr(\"cmd + click\") : tr(\"ctrl + click\");", "key = tr(\"ctrl + click\");"],
  ["no hint over address", "links", "if (a) return { pos: a.from, end: a.to, above: true, create: () => ({ dom: linkHintNode(a.url) }) };", ""],
  ["hint without language-service link", "links", "r = await questions(d, \"link\", { position: lspPosOf(doc, p) });", "r = null as never;"],
  ["underline without ⌘", "links", "const p = this.mod && m && v.dom.isConnected ?", "const p = m && v.dom.isConnected ?"],
  ["click does not open", "links", "window.open(a.url, \"_blank\", \"noopener,noreferrer\");", ""],
  ["every click opens", "links", " || !(isMac() ? e.metaKey : e.ctrlKey)) return false;", ") return false;"],
  ["underline sticks", "links", "return v && t.docChanged ? null : v;", "return v;"],
  ["links only with language", "extension", "lspTheme, editorLinks]", "lspTheme]"],
  ["cmd-hover doubled", "cmd", "if (character != null && addressAt(view.state, character)) {", "if (false) {"],
  ["no character without word", "cmd", "const w = word ?? (on && character != null && can(d, \"document_link\") ? { from: character, to: character + 1 } : null);", "const w = word;"],
  ["link asks definition", "cmd", "const locations = onlyLink ? [] : await this.definitions(d, w);", "const locations = await this.definitions(d, w);"],
  ["link flickers", "cmd", "if (stands && !stands.tooltip && this.isLink && w.from >= stands.from && w.to <= stands.to) return;", ""],
  ["hover without image switch", "md", "<MarkdownReferenceContext.Provider value={HOVER_REFERENCES}>", "<MarkdownReferenceContext.Provider value={{}}>"],
  ["hover loads everything", "md", "{ image: hoverImageTarget, dimensions: hoverImageDimensions, link: () => null }", "{ image: (s) => s, dimensions: hoverImageDimensions, link: () => null }"],
  ["hover without dimensions", "md", "dimensions: hoverImageDimensions, ", ""],
  ["image without dimensions", "markdown", "width={dimensions?.width} height={dimensions?.height} ", ""],
  ["image with referrer", "markdown", "referrerPolicy=\"no-referrer\" ", ""],
  ["text without English", "i18n", "\n  \"cmd + click\": ", "\n  \"cmd+click\": "],
];
test("(2) sources: links in every file, hint from the language pack, whole underline, ⌘-click, cmd-hover steps back, images without referrer (with counter-tests)", () => {
  sources(Q);
  for (const [name, k, old, fresh] of SOURCE_SABOTAGES) {
    const n = Q[k].split(old).length - 1;
    assert.equal(n, 1, `counter-test "${name}" is stale: the place occurs ${n}× in ${k}`);
    assert.throws(() => sources({ ...Q, [k]: Q[k].replace(old, fresh) }), undefined, `counter-test "${name}" is not caught`);
  }
});
