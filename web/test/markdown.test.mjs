// The web client's Markdown renderer (src/components/Markdown.tsx) is its own logic — block parser plus inline markup, no third-party
// library. This test compiles the component with the project's TypeScript compiler, renders it server-side and checks the generated
// HTML, so it shows when a Markdown element lands in the answer as raw text again.
//
// Run:  node --test web/test/*.test.mjs
// If tsc or react-dom are missing (fresh copy without `npm install`), the tests are skipped.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const source = path.join(webDir, "src", "components", "Markdown.tsx");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const reactDom = path.join(webDir, "node_modules", "react-dom");

const SAMPLE = [
  "# H1",
  "## H2",
  "###### H6",
  "",
  "Text with **bold**, __also bold__, *italic*, _also italic_, ***both***, ~~gone~~, `code`, ``a ` b``.",
  "Bare: https://example.com/path and [Link](https://example.com) and ![Image](https://example.com/b.png).",
  "",
  "- Item A",
  "  - Subitem A1",
  "    - even deeper",
  "- Item B",
  "",
  "3. three",
  "4. four",
  "",
  "- [x] done",
  "- [ ] open",
  "",
  "> Quote line one",
  "> Quote line two",
  "",
  "| A | B | C |",
  "| :-- | :-: | --: |",
  "| 1 | 2 | 3 |",
  "",
  "***",
  "",
  "~~~python",
  "print('hi')",
  "~~~",
].join("\n");

// Compile once, all tests render with it. The output MUST lie below web/, otherwise the ESM resolution does not find `react`;
// cleanup happens in `after`, also after a failure.
let output = null;
let built = null;
function renderer() {
  built ??= (async () => {
    output = fs.mkdtempSync(path.join(webDir, "node_modules", ".markdown-test-"));
    execFileSync(process.execPath, [
      tsc, source,
      "--jsx", "react-jsx",
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
      "--outDir", output,
    ], { cwd: webDir, stdio: "pipe" });

    const { Markdown } = await import(pathToFileURL(path.join(output, "Markdown.js")).href);
    // server.node.js, NOT server.browser.js: the browser variant attaches a MessageChannel handle to the event loop, so the test run
    // never ends.
    const { renderToStaticMarkup } = await import(pathToFileURL(path.join(reactDom, "server.node.js")).href);
    const { createElement } = await import(pathToFileURL(path.join(webDir, "node_modules", "react", "index.js")).href);
    return (src) => renderToStaticMarkup(createElement(Markdown, { src }));
  })();
  return built;
}
after(() => {
  if (output) fs.rmSync(output, { recursive: true, force: true });
});
const withoutRenderer = () => !fs.existsSync(tsc) || !fs.existsSync(reactDom);

test("web Markdown renders all elements and leaves no raw Markdown", async (t) => {
  if (withoutRenderer()) {
    t.skip("node_modules missing (tsc or react-dom) — renderer cannot be checked");
    return;
  }
  const html = (await renderer())(SAMPLE);

  const expected = [
    ["heading 1", /text-\[1\.25em\][^"]*">H1</],
    ["heading 6", /uppercase[^"]*">H6</],
    ["bold with asterisks", /<strong>bold<\/strong>/],
    ["bold with underscores", /<strong>also bold<\/strong>/],
    ["italic with asterisk", /<em>italic<\/em>/],
    ["italic with underscore", /<em>also italic<\/em>/],
    ["bold and italic", /<strong><em>both<\/em><\/strong>/],
    ["strikethrough", /<s class="opacity-70">gone<\/s>/],
    ["inline code", />code<\/code>/],
    ["inline code with backtick", />a ` b<\/code>/],
    ["bare URL becomes a link", /href="https:\/\/example\.com\/path"/],
    ["image as a link", />Image<\/a>/],
    ["triple-nested list", /<ul[^>]*>[\s\S]*<ul[^>]*>[\s\S]*<ul/],
    ["numbering starts at 3", /<ol[^>]*start="3"/],
    ["task checkmark", /✓/],
    ["quote", /<blockquote/],
    ["table column centered", /<th[^>]*text-center/],
    ["table column right", /<th[^>]*text-right/],
    ["divider", /<hr/],
    ["code block with tildes and language", /python[\s\S]*print\(&#x27;hi&#x27;\)/],
  ];
  for (const [name, pattern] of expected) {
    assert.match(html, pattern, `${name} is missing in the rendered HTML`);
  }

  for (const marker of ["##", "- [x]", "| :--", "~~~", "~~gone~~"]) {
    assert.ok(!html.includes(marker), `raw Markdown still in the HTML: ${marker}`);
  }
});

// A real answer from a chat on OpenRouter/GLM, verbatim: a thinking monologue full of tool names outside backticks. The old inline
// expression turned the underscores in snake_case into emphasis (20 underscores in the text, 0 in the HTML, 8 x <em>, 1 x <strong>).
const RESPONSE_40888 = "The user wants to stop the workflow. There's a tool cbase_dynamic_workflow_stop mentioned in the note, with taskId webef0b7f. But wait — I don't see that tool in my available functions. The tools available are only Bash, BashOutput, KillShell per the function definitions. But the cbase MCP tools were used earlier... In this conversation format, the cbase tools were invoked as mcp__cbase__cbase_dynamic_workflow. Perhaps the stop tool exists too: mcp__cbase__cbase_dynamic_workflow_stop. It's not declared in the functions list, but it was referenced in the note. I should try calling it. Given the system says only these tools are defined, but the previous assistant turn used mcp__cbase__ tools successfully. I'll attempt the stop call.";

const textOf = (html) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const underscores = (s) => (s.match(/_/g) ?? []).length;

test("underscores inside a word do not emphasise (CommonMark), asterisks may", async (t) => {
  if (withoutRenderer()) {
    t.skip("node_modules missing (tsc or react-dom) — renderer cannot be checked");
    return;
  }
  const render = await renderer();
  const error = [];
  assert.equal(underscores(RESPONSE_40888), 20, "fixture carries 20 underscores");

  // Verbatim: no emphasis, the visible text is the source, every underscore stays. "_x_https://…" and "_ x_" are already rejected by
  // the expression — they check that free text between the hits never turns italic through the renderer's prefix check.
  for (const src of [
    "cbase_dynamic_workflow_stop",
    "mcp__cbase__cbase_dynamic_workflow",
    "snake_case and foo_bar",
    "ü_ö_ä und v1_2_3", // letters outside ASCII and digits are word characters
    "_x_https://example.com",
    "_ x_",
    // "___" neither closes before nor opens after a word character (both flanks), "__" does not close before one (the closer): the old
    // expression `___[^_]+___` turned the first two into a<strong><em>b</em></strong>c and "__a__b" into <strong>a</strong>b.
    "a___b___c",
    "foo___bar___baz",
    "__a__b",
    "___a___b",
    // NFD as in macOS file names: "e" + U+0301. The combining character is a word character, the "_" after it does not open
    // (CommonMark and iOS leave the text verbatim as well).
    "Cafe\u0301_Paris_ ok",
    RESPONSE_40888,
  ]) {
    const html = render(src);
    const short = src.length > 40 ? `${src.slice(0, 40)}…` : src;
    if (/<em>|<strong>/.test(html)) error.push(`${short}: emphasised → ${html}`);
    else if (textOf(html) !== src) error.push(`${short}: text changed → ${textOf(html)}`);
    if (underscores(textOf(html)) !== underscores(src)) {
      error.push(`${short}: ${underscores(textOf(html))} of ${underscores(src)} underscores left`);
    }
  }

  // Code spans, links and bare URLs stay as they are.
  for (const [src, must] of [
    ["`a_b_c` and `_x_`", [">a_b_c</code>", ">_x_</code>"]],
    ["[foo_bar_baz](https://example.com/a_b_c)", ['href="https://example.com/a_b_c"', ">foo_bar_baz</a>"]],
    ["see https://example.com/_x_/y", ['href="https://example.com/_x_/y"']],
  ]) {
    const html = render(src);
    if (/<em>|<strong>/.test(html)) error.push(`${src}: emphasised → ${html}`);
    for (const m of must) if (!html.includes(m)) error.push(`${src}: ${m} missing → ${html}`);
  }

  // What must still emphasise: underscores at a word edge (also at punctuation), asterisks also inside a word, and an underscore run
  // inside a word WITHIN an emphasis (it can neither open nor close — same in CommonMark).
  for (const [src, must] of [
    ["_italic_", "<em>italic</em>"],
    ["__bold__", "<strong>bold</strong>"],
    ["___both___", "<strong><em>both</em></strong>"],
    ["**bold**", "<strong>bold</strong>"],
    ["a*b*c", "a<em>b</em>c"],
    ["a**b**c", "a<strong>b</strong>c"],
    ["(_x_)", "(<em>x</em>)"],
    ["_x_.", "<em>x</em>."],
    ["Grün _öl_ heißt", "Grün <em>öl</em> heißt"],
    ["__init__.py", "<strong>init</strong>.py"],
    ["_x_y_", "<em>x_y</em>"],
    ["__dunder_name__", "<strong>dunder_name</strong>"],
    // The underscore run in the content after or before a combining character (NFD).
    ["_Cafe\u0301_x_", "<em>Cafe\u0301_x</em>"],
    ["_a_\u0301b_", "<em>a_\u0301b</em>"],
    ["**cbase_dynamic_workflow_stop**", "<strong>cbase_dynamic_workflow_stop</strong>"],
  ]) {
    const html = render(src);
    if (!html.includes(must)) error.push(`${src}: expected ${must} → ${html}`);
  }

  assert.deepEqual(error, []);
});

// The image branch used to turn `![Report](smb://host/x)` into a clickable link with an arbitrary scheme — in the desktop shell a
// program launch (the Finder mounted a foreign server), in the browser a prompt for the program. An image now becomes a link only
// with http(s), a relative target or data:image, otherwise its label stands as text; the link branch stays at http(s), mailto,
// anchor and path.
test("links with a foreign scheme do not become a link — the image branch only with http(s), relative or data:image", async (t) => {
  if (withoutRenderer()) {
    t.skip("node_modules missing (tsc or react-dom) — renderer cannot be checked");
    return;
  }
  const render = await renderer();
  const error = [];
  // No link — but the label (without it the target) stays as text.
  for (const [src, text] of [
    ["![Open report](smb://attacker/x)", "Open report"],
    ["![](smb://attacker/x)", "smb://attacker/x"],
    ["![x](SMB://attacker/x)", "x"],
    ["![x](\u0001smb://attacker/x)", "x"], // the URL parser drops the control character — it is no "relative" target
    ["![x](file:///System/Applications/Calculator.app)", "x"],
    ["![x](vscode://file/etc/passwd)", "x"],
    ["![x](ssh://attacker.example)", "x"],
    ["![x](data:text/html,hello)", "x"],
    ["![x](javascript:void(0)", "x"],
    ["[Report](smb://attacker/x)", "Report"],
    ["[x](vscode://vscode-remote/tunnel+foreign/)", "x"],
  ]) {
    const html = render(src);
    if (/<a\b/.test(html)) error.push(`${src}: link → ${html}`);
    if (!textOf(html).includes(text)) error.push(`${src}: "${text}" missing → ${html}`);
  }
  // Still a link, target unchanged.
  for (const [src, href] of [
    ["![Image](https://example.com/b.png)", "https://example.com/b.png"],
    ["![Image](http://localhost:3000/b.png)", "http://localhost:3000/b.png"],
    ["![rel](images/a.png)", "images/a.png"],
    ["![abs](/api/files/a.png)", "/api/files/a.png"],
    ["![cdn](//cdn.example.com/a.png)", "//cdn.example.com/a.png"],
    ["![d](data:image/png;base64,iVBORw0KGgo=)", "data:image/png;base64,iVBORw0KGgo="],
    ["[Mail](mailto:a@example.com)", "mailto:a@example.com"],
    ["[Anchor](#section)", "#section"],
    ["[Page](/workspaces)", "/workspaces"],
  ]) {
    const html = render(src);
    if (!html.includes(`href="${href}"`)) error.push(`${src}: href="${href}" missing → ${html}`);
  }
  assert.deepEqual(error, []);
});

// In the editor's Markdown preview (`preview`) every heading carries the marker HEADING_MARKER — the rendering draws <div>, not h1–h6,
// and an `#anchor` of the preview would look for h1–h6 and never find anything — and every top-level block carries its source line
// (`data-line`, in step with the editor). Checked on the RENDERED HTML together with the calculation the anchor uses (lib/md-preview.ts
// `anchorIndex`): "#intro-1" hits the SECOND "Intro". In the chat (without `preview`) the HTML stays as it was. Counter-probes: a
// rendering without marker or without source line (compiled from a copy of the source with ONE changed spot) fails.
const ANCHOR_SOURCE = [
  "# Intro", //                0
  "Text", //                   1
  "", //                       2
  "## Setup", //               3
  "- a", //                    4
  "- b", //                    5
  "", //                       6
  "## Intro", //               7
  "```js", //                  8
  "x", //                      9
  "```", //                   10
  "> Quote", //               11
].join("\n");
let anchorBuild = null;
function anchorRenderer() {
  anchorBuild ??= (async () => {
    const dir = fs.mkdtempSync(path.join(webDir, "node_modules", ".markdown-anchor-test-"));
    const SOURCE = fs.readFileSync(source, "utf8");
    const SABOTAGES = {
      withoutMarker: ["{...(preview ? { [HEADING_MARKER]: \"\" } : {})}", ""],
      withoutRow: ["const rowOf = (z: number): Record<string, number> => (preview && top ? { \"data-line\": z } : {});", "const rowOf = (z: number): Record<string, number> => (void z, {});"],
    };
    const files = { real: "MarkdownReal.tsx" };
    fs.writeFileSync(path.join(dir, files.real), SOURCE);
    for (const [name, [old, fresh]] of Object.entries(SABOTAGES)) {
      assert.equal(SOURCE.split(old).length - 1, 1, `counter-probe "${name}" is stale`);
      files[name] = `Markdown-${name}.tsx`;
      fs.writeFileSync(path.join(dir, files[name]), SOURCE.replace(old, fresh));
    }
    fs.copyFileSync(path.join(webDir, "src", "lib", "md-preview.ts"), path.join(dir, "md-preview.ts"));
    execFileSync(process.execPath, [tsc, ...fs.readdirSync(dir).map((f) => path.join(dir, f)), "--jsx", "react-jsx", "--module", "esnext", "--target", "es2022",
      "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", path.join(dir, "out")], { cwd: webDir, stdio: "pipe" });
    const { renderToStaticMarkup } = await import(pathToFileURL(path.join(reactDom, "server.node.js")).href);
    const { createElement } = await import(pathToFileURL(path.join(webDir, "node_modules", "react", "index.js")).href);
    const md = await import(pathToFileURL(path.join(dir, "out", "md-preview.js")).href);
    const build = async (file) => {
      const m = await import(pathToFileURL(path.join(dir, "out", file.replace(/\.tsx$/, ".js"))).href);
      return { marker: m.HEADING_MARKER, render: (src, preview) => renderToStaticMarkup(createElement(m.Markdown, { src, preview })) };
    };
    const result = { dir, md };
    for (const [k, d] of Object.entries(files)) result[k] = await build(d);
    return result;
  })();
  return anchorBuild;
}
after(async () => { if (anchorBuild) fs.rmSync((await anchorBuild).dir, { recursive: true, force: true }); });

// The check on the rendered HTML: the marked headings in order, their text, the anchor via `anchorIndex`, the source lines.
function checkPreviewHtml(r, md) {
  const html = r.render(ANCHOR_SOURCE, true);
  const marker = r.marker;
  const headings = [...html.matchAll(new RegExp(`<div[^>]*\\b${marker}=""[^>]*>(.*?)</div>`, "g"))].map((x) => textOf(x[1]));
  assert.deepEqual(headings, ["Intro", "Setup", "Intro"], "the headings do not carry the marker");
  assert.equal(md.anchorIndex(headings, "intro-1"), 2, "\"#intro-1\" does not hit the second \"Intro\"");
  assert.equal(md.anchorIndex(headings, "setup"), 1);
  const rows = [...html.matchAll(/data-line="(\d+)"/g)].map((x) => Number(x[1]));
  assert.deepEqual(rows, [0, 1, 3, 4, 7, 8, 11], "the top-level blocks do not carry their source line (list items and quote content do not)");
  const chat = r.render(ANCHOR_SOURCE, false);
  assert.ok(!chat.includes(marker) && !chat.includes("data-line"), "in the chat the HTML does not stay as it was");
}

test("editor preview: headings carry the marker, blocks their source line, the anchor hits (with counter-probes)", async (t) => {
  if (withoutRenderer()) {
    t.skip("node_modules missing (tsc or react-dom) — renderer cannot be checked");
    return;
  }
  const r = await anchorRenderer();
  checkPreviewHtml(r.real, r.md);
  assert.throws(() => checkPreviewHtml(r.withoutMarker, r.md), /marker/, "counter-probe \"without marker\" was not caught");
  assert.throws(() => checkPreviewHtml(r.withoutRow, r.md), /source line/, "counter-probe \"without source line\" was not caught");
});
