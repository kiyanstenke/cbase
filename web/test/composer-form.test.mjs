// The FORM of the input field — a guard at the source, no browser.
//
// The shared composer (`chat/ChatComposer.tsx`) is ONE large, round, opaque surface with the button row inside it. It used to
// carry the glass of the coding page (`cb-kit-pane cb-kit-pane-strong cb-kit-blur`, shadow, blur), a paperclip and a dark
// polygon as the send button. What this test holds (through the TypeScript parser, not text positions, where nesting matters):
//   1. The <form> carries `cb-composer` and a radius >= 20 px — no glass, no shadow, no ring, no accent edge, no focus glow
//      on the element; the `.cb-composer` rule in globals.css is opaque, without shadow and blur, its colors come from the
//      color roles (`var(--color-…)`, no base-16 value), and the accent color appears ONLY in the drag state (`[data-drag="1"]`).
//   2. The button row (`data-composer-row`) sits INSIDE the <form>, BEHIND the text field; on the left the bare plus (a
//      <label data-composer-attachment> with the file input INSIDE it and the plus icon, no paperclip) and the permission
//      mode (the todo toggle and the workflow button are gone and must not return); on the right model + level as ONE trigger
//      (the two `data-pop` directly next to each other in `data-composer-model-level`, no gap) and LAST the round send button
//      (`<CbSendButton round`).
//   3. CbSendButton: the round form is a filled circle in the accent color, muted when disabled (not hidden).
//   4. Text field and highlight layer carry the same box (`fieldBox`) and otherwise no size, padding or line height —
//      otherwise the glyphs do not line up.
//   5. No identifier was lost: every `data-pop` exactly once, the aria labels and titles of the buttons are there.
// The rendered DOM (menus above the glass via elementFromPoint, real mouse, images) is measured by hand in a real browser.
//
// COUNTER-TEST: ChatComposer.tsx, CbSendButton.tsx and globals.css in their old glass form => every check except "identifiers"
// is red (glass, no row, no round form, paperclip).
//
// Run:  node --test web/test/composer-form.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
const ts = createRequire(path.join(webDir, "package.json"))("typescript");

const SOURCE = read("src/components/chat/ChatComposer.tsx");
const SEND = read("src/components/CbSendButton.tsx");
const CSS = read("src/app/globals.css");
const sf = ts.createSourceFile("ChatComposer.tsx", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// ── JSX helpers ──────────────────────────────────────────────────────────────────────────────────────
const isElement = (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);
const opener = (n) => (ts.isJsxElement(n) ? n.openingElement : n);
const tag = (n) => opener(n).tagName.getText(sf);
const attr = (n, name) => opener(n).attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === name);
const hasAttr = (n, name) => Boolean(attr(n, name));
const attrText = (n, name) => {
  const a = attr(n, name);
  if (!a) return null;
  if (!a.initializer) return "";
  if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
  // `{expression}`: the expression itself (a template literal with backticks, an identifier bare).
  return ts.isJsxExpression(a.initializer) && a.initializer.expression ? a.initializer.expression.getText(sf) : a.initializer.getText(sf);
};
function all(root, matches) {
  const out = [];
  const visits = (n) => { if (isElement(n) && matches(n)) out.push(n); ts.forEachChild(n, visits); };
  visits(root);
  return out;
}
const one = (root, matches, what) => {
  const l = all(root, matches);
  assert.equal(l.length, 1, `exactly one ${what} (found: ${l.length})`);
  return l[0];
};
const contains = (outside, inside) => inside.getStart(sf) >= outside.getStart(sf) && inside.getEnd() <= outside.getEnd();
const popWith = (value) => (n) => attrText(n, "data-pop") === value;

const form = one(sf, (n) => tag(n) === "form", "<form>");
const textarea = one(form, (n) => tag(n) === "textarea", "<textarea> in the <form>");
// Searched only INSIDE the test: in the old state the row is missing, and a throw at module level would turn the whole file into ONE red.
const rowSearch = () => one(sf, (n) => hasAttr(n, "data-composer-row"), "element with data-composer-row");
// The direct element children of a JSX element (expressions `{a && (<x/>)}` resolved, comments skipped).
function children(n) {
  const out = [];
  const take = (k) => {
    if (isElement(k)) out.push(k);
    else if (ts.isJsxExpression(k) && k.expression) {
      let e = k.expression;
      while (ts.isBinaryExpression(e)) e = e.right;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (isElement(e)) out.push(e);
    }
  };
  if (ts.isJsxElement(n)) n.children.forEach(take);
  return out;
}

// The `.cb-composer…` rules from globals.css (selector -> body).
// Comments go first — they name the class and must become neither selector nor body.
const CSS_WITHOUT = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
const composerRules = [...CSS_WITHOUT.matchAll(/(?<=^|\})\s*([^{}]*\.cb-composer[^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

test("1. The field is ONE round, opaque surface — no glass, no shadow, no ring, no accent edge", () => {
  const kind = attrText(form, "className");
  assert.ok(kind && /(^|\s)cb-composer(\s|$)/.test(kind), `the <form> carries cb-composer: ${kind}`);
  const radius = /rounded-\[(\d+)px\]/.exec(kind);
  assert.ok(radius && Number(radius[1]) >= 20, `radius >= 20 px (reference ≈ 24–26): ${kind}`);
  for (const forbidden of ["cb-kit-pane", "cb-kit-blur", "backdrop-blur", "shadow", "ring-", "border-accent", "focus-within:", "focus:"]) {
    assert.ok(!kind.includes(forbidden), `the <form> carries "${forbidden}" — the surface has no glass, no shadow and no glow`);
  }
  // The drag state is a marker, not a class with accent color on the element.
  assert.equal(attrText(form, "data-drag"), 'dragOver ? "1" : undefined', "the drag state goes through data-drag");
  // The rule itself.
  const base = composerRules.find((r) => r.selector === ".cb-composer");
  assert.ok(base, `globals.css carries .cb-composer (found: ${composerRules.map((r) => r.selector).join(" | ")})`);
  assert.match(base.body, /background:\s*color-mix\(in srgb, var\(--color-[a-z]+\) \d+%, var\(--color-[a-z]+\)\);/, "the surface comes from the color roles");
  assert.match(base.body, /border:\s*1px solid color-mix\(/, "a fine 1-px edge, also from the color roles");
  assert.match(base.body, /box-shadow:\s*none;/, "no shadow");
  for (const r of composerRules) {
    assert.ok(!/backdrop-filter|blur\(/.test(r.body), `${r.selector}: no blur`);
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(r.body), `${r.selector}: no fixed color — the roles carry light AND dark`);
    assert.ok(!/box-shadow:(?!\s*none\b)/.test(r.body), `${r.selector}: no shadow`);
    const drag = r.selector.includes('[data-drag="1"]');
    assert.equal(r.body.includes("--color-accent"), drag, `${r.selector}: the accent color appears ONLY in the drag state`);
  }
  assert.ok(composerRules.some((r) => r.selector.includes(':root:not([data-theme="dark"])')), "the light theme has its own step (the lightest, not gray)");
  assert.ok(composerRules.some((r) => r.selector.includes('[data-drag="1"]')), "the drag state is a rule in globals.css");
});

test("2. The button row sits INSIDE the field, behind the text field — plus, permissions on the left; model + level, send on the right", () => {
  const row = rowSearch();
  assert.ok(contains(form, row), "data-composer-row is inside the <form>");
  assert.ok(row.getStart(sf) > textarea.getEnd(), "the button row sits BEHIND the text field (placeholder on top, buttons below)");
  assert.equal(attrText(row, "ref"), "barRef", "the row is the measured one (staggered release of the label)");
  const [left, right, ...rest] = children(row);
  assert.ok(left && right && rest.length === 0, `the row has exactly two groups (found: ${children(row).length})`);
  // Left: the bare plus as a <label> with the file input INSIDE (no button with input.click()).
  const attachment = one(left, (n) => tag(n) === "label" && hasAttr(n, "data-composer-attachment"), "<label data-composer-attachment> on the left");
  one(attachment, (n) => tag(n) === "input" && attrText(n, "type") === "file", "file input in the label");
  one(attachment, (n) => tag(n) === "PlusIcon", "plus icon in the label");
  assert.ok(!SOURCE.includes("PaperclipIcon"), "no paperclip any more");
  const attachmentClass = attrText(attachment, "className");
  assert.ok(!/(^|[\s"`])(border|bg-(?!hover))/.test(attachmentClass.replace(/hover:bg-hover/g, "")), `the plus is bare — no border, no surface (except on hover): ${attachmentClass}`);
  // The "create todo" toggle is gone — it must not return.
  assert.ok(!SOURCE.includes('t("ToDo erstellen")') && !/\btodoMode\b/.test(SOURCE), "the todo toggle is back in the composer");
  // The workflow button is gone — a graph workflow starts via `/workflow:<shortname>` from the slash picker. It must not return.
  assert.equal(all(sf, popWith("workflow")).length, 0, "the workflow button is back in the composer");
  const permissions = one(left, popWith("permissions"), "permission mode on the left (ghost button with shield + word)");
  const permissionsButton = children(permissions)[0];
  assert.ok(permissionsButton && tag(permissionsButton) === "button", "the permission mode is a button");
  assert.ok(permissionsButton.getText(sf).includes("<ShieldIcon />") && permissionsButton.getText(sf).includes("{barPerm && t(currentPermLabel)}"), "shield + muted word, released staggered (barPerm)");
  // Right: model + level as ONE trigger and send LAST (there is no browser choice any more — always headless).
  const rk = children(right);
  const pair = rk[0];
  assert.ok(pair && hasAttr(pair, "data-composer-model-level"), "on the right first the pair model + level");
  const [model, effort, ...pairRest] = children(pair);
  assert.ok(model && attrText(model, "data-pop") === "model", "in the pair first the model");
  assert.ok(effort && attrText(effort, "data-pop") === "effort" && pairRest.length === 0, "directly behind it the level — nothing between, nothing after");
  assert.ok(!/\bgap-/.test(attrText(pair, "className")), "no gap between model and level: they look like ONE trigger");
  // The level button is always there (the ultracode switch lives in its sheet) — it carries the ONE chevron.
  const modelButton = SOURCE.slice(SOURCE.indexOf('data-pop="model"'), SOURCE.indexOf('data-pop="effort"'));
  const levelButton = SOURCE.slice(SOURCE.indexOf('data-pop="effort"'), SOURCE.indexOf("{effortPickerOpen && ("));
  assert.ok(!modelButton.includes("<CaretDown />") && levelButton.includes("<CaretDown />"), "the level carries the one chevron, the model none");
  assert.ok(!rk.some((k) => attrText(k, "data-pop") === "browser"), "the browser choice is back in the composer (the browser always runs headless)");
  const last = rk[rk.length - 1];
  assert.ok(tag(last) === "CbSendButton" && hasAttr(last, "round"), "the round send button at the far right (<CbSendButton round>)");
  assert.equal(all(sf, (n) => tag(n) === "CbSendButton").length, 1, "exactly one send button");
});

test("3. Send is a filled circle in the accent color — muted when disabled, never gone; the same form while running", () => {
  assert.match(SEND, /round \? "rounded-full bg-accent disabled:opacity-40"/, "round: circle, accent surface, muted to 40 % when disabled");
  assert.match(SEND, /\{!round && \(\n\s*<svg\n\s*ref=\{shapeRef\}/, "the polygon (and its rotation) exists only in the old form");
  assert.ok(!/round \?[^:]*hidden/.test(SEND), "nothing is hidden when disabled");
  // Stop: the same button (no second component), the square lies on it as an icon.
  const button = one(sf, (n) => tag(n) === "CbSendButton", "CbSendButton");
  assert.ok(hasAttr(button, "stop") && hasAttr(button, "onStop"), "while running the same button is the stop");
  const kind = attrText(button, "className");
  assert.match(kind, /\bh-9 w-9\b/, `36 px (reference ≈ 36–40): ${kind}`);
});

test("4. Text field and highlight layer carry the SAME box — the glyphs line up exactly", () => {
  const level = one(form, (n) => attrText(n, "ref") === "highlightRef", "highlight layer (highlightRef)");
  const field = /const fieldBox = `([^`]*)`;/.exec(SOURCE);
  assert.ok(field, "fieldBox is ONE value in the composer");
  // No factor of its own: the plugin web/postcss-text-scale.cjs applies the text size to EVERY size.
  assert.match(field[1], /text-\[15\.5px\]/, "the same font as the history (15.5 px like .cb-chat-text)");
  for (const [who, n] of [["text field", textarea], ["highlight layer", level]]) {
    const k = attrText(n, "className");
    assert.ok(k.includes("${fieldBox}"), `${who} takes fieldBox`);
    const without = k.replace("${fieldBox}", "");
    for (const pattern of [/\bp[xytblr]?-/, /\btext-\[/, /\bleading-/, /\bmin-h-/, /\bmax-h-/, /\bfont-(?!medium)/]) {
      assert.ok(!pattern.test(without), `${who} sets ${pattern} besides fieldBox — then the text no longer lies on its layer: ${k}`);
    }
  }
  assert.ok(attrText(textarea, "className").includes("field-sizing-content"), "the field grows with the text (textSize.mjs finds it by this)");
});

test("5. No identifier was lost: every data-pop exactly once, labels and titles are there", () => {
  for (const name of ["permissions", "model", "effort"]) {
    assert.equal(all(sf, popWith(name)).length, 1, `data-pop="${name}" exactly once`);
  }
  for (const s of ['t("Attach files (all types: images, PDFs, code, …)")',
    't("Permission mode for this chat")', 'aria-label={t(currentPermLabel)}', 't("Model for this chat")',
    'aria-label={effortOk ?', 't("Stop generation")', 't("Send (Enter)")',
    't("Queue message (Enter)")', 't("How can I help you today?")', 't("Message…")',
    'identifier="chat"']) {
    assert.ok(SOURCE.includes(s), `missing in the composer: ${s}`);
  }
  // The permission picker always shows (data-pop="permissions" above, exactly once); that no switch returns is held by
  // composer-contract.test.mjs ("ONE user").
  // No microphone: the web has no dictation, and the wish was to use only the existing buttons.
  assert.ok(!/MicIcon|SpeechRecognition|getUserMedia/.test(SOURCE), "no button invented");
});
