// No floating sheet in the drag region (reported: "when you open the settings in the client, the app freezes and
// nothing can be clicked or scrolled").
//
// The header is a drag region (`TopNav.tsx`, `<nav style={drag}>`), and a drag region swallows EVERY mouse event
// before the renderer sees it — click, double click, wheel. The SettingsModal hung as a DOM child in that nav
// (`{settingsOpen && <SettingsModal/>}`), its veil `fixed inset-0`. Up to Electron 37 that did no harm: `app-region`
// was not inherited, the veil carried `none`. Since Electron 44 (Chromium 152) it IS inherited — measured with the
// same page (nav with drag, inside it a `fixed inset-0` veil) in both binaries, computed style of veil and content:
// 44.4.4 ⇒ `drag`/`drag`, 37.10.3 ⇒ `none`/`none`; with `no-drag` on the veil ⇒ `no-drag`/`no-drag`; the same veil
// OUTSIDE the nav ⇒ `none`. The whole window was a drag region: nothing could be clicked or scrolled, keys (Esc, ⌘Q)
// still worked, and in an ordinary browser (no app-region) the modal opened normally.
//
// The rule this test holds: an element rendered inside a drag region that FLOATS (`fixed`, or an overlay marker:
// `cb-overlay*`, `cb-pop*`, `cb-sheet`, `role="dialog"`, `data-overlay`) needs a `no-drag` ancestor (itself
// included) — or it leaves via `createPortal(…, document.body)`. A portal into a slot INSIDE the nav does not
// count, it keeps inheriting there. Checked with the TypeScript parser: every drag root under web/src, its JSX
// subtree, and every component in it that is not already under `no-drag`, together with ITS body (down to depth 4,
// local or via `@/…`/relative imports; package components such as `next/link` count as external and are printed).
//
// Limit: a style that sets the region from a variable that is not an object literal with `WebkitAppRegion` is not
// recognised — the number of drag roots found therefore stands in every line, and zero roots is RED (otherwise the
// test would check nothing after a rename).
//
// Counter-test: SettingsModal.tsx without the portal turns "no floating surface in a drag region" red with
// `SettingsModal.tsx … fixed`. The built-in sabotage (self-test below) shows the same computation red on three
// artificial sources and green on three.
//
// Two more rules, both from measurements with Electron's drag-region debugger (`ELECTRON_DEBUG_DRAGGABLE_REGIONS=1`,
// 44.4.4): Blink collects the app-regions in DOM order, Electron unites `drag` and subtracts `no-drag`, rectangle by
// rectangle — the LATER rectangle wins, not the one painted on top.
//  (a) ORDER: a portal slot (JSX element with a literal `id` and no children — its content arrives via createPortal
//      and carries `no-drag` itself, e.g. `HeadersMiddle` in `cbase-topnav-center`) must not stand BEFORE a wide
//      element in its drag root that inherits `drag` (`flex-1`, `grow`, `cb-strip`): its rectangle overwrites the hole
//      of the content. The central slot used to stand before the tab strip, and "Workspace › Project" could not be
//      clicked in the client. Counter-test: an older TopNav.tsx ⇒ red with `Slot #cbase-topnav-center … before <span>
//      (cb-strip …)`.
//  (b) VEIL: `.cb-overlay` (globals.css) carries `no-drag`. A modal hangs on the body via portal, its veil
//      (`fixed inset-0`) otherwise carries `none` and subtracts nothing — where the sheet reached into the header, a
//      click dragged the window (closing the settings at 980 × 760). With `no-drag` it takes the whole region from
//      the header for the duration of the modal (it stands behind it in the DOM). Counter-test: a globals.css without
//      it ⇒ red with `.cb-overlay without -webkit-app-region: no-drag and app-region: no-drag`.
//
// Run:  node --test web/test/drag-region.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const ts = createRequire(path.join(webDir, "package.json"))("typescript");

const DEPTH = 4;
const FLOATS = /(^|[\s"'`:{])(fixed|cb-overlay(-in)?|cb-pop(-in)?|cb-sheet)(?=[\s"'`}]|$)/;

// A file system as a function: `read(path)` returns text or null. Real runs read web/src, the self-test passes a map.
function newCheck(read) {
  const cache = new Map();
  const source = (file) => {
    if (cache.has(file)) return cache.get(file);
    const text = read(file);
    const sf = text == null ? null : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    cache.set(file, sf);
    return sf;
  };
  const row = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // Constants of the form `const x = { WebkitAppRegion: "drag" } as …` per file.
  const regionConstants = (sf) => {
    const m = new Map();
    const visits = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const r = regionFromObject(n.initializer);
        if (r) m.set(n.name.text, r);
      }
      ts.forEachChild(n, visits);
    };
    visits(sf);
    return m;
  };
  const unpack = (e) => {
    while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression?.(e))) e = e.expression;
    return e;
  };
  function regionFromObject(e) {
    e = unpack(e);
    if (!e || !ts.isObjectLiteralExpression(e)) return null;
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "";
      if (name !== "WebkitAppRegion" && name !== "appRegion") continue;
      const v = unpack(p.initializer);
      if (v && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) return v.text;
    }
    return null;
  }
  const attribute = (n) => (ts.isJsxElement(n) ? n.openingElement.attributes : n.attributes);
  const tagName = (n) => (ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName);
  const attr = (n, name) => attribute(n).properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
  function regionOf(n, constant) {
    const a = attr(n, "style");
    if (!a || !a.initializer || !ts.isJsxExpression(a.initializer)) return null;
    const e = unpack(a.initializer.expression);
    if (!e) return null;
    if (ts.isIdentifier(e)) return constant.get(e.text) ?? null;
    return regionFromObject(e);
  }
  function floats(n, sf) {
    for (const name of ["className", "class"]) {
      const a = attr(n, name);
      if (a?.initializer && FLOATS.test(a.initializer.getText(sf))) return name + "=" + a.initializer.getText(sf).slice(0, 80);
    }
    const role = attr(n, "role");
    if (role?.initializer && /["'`]dialog["'`]/.test(role.initializer.getText(sf))) return 'role="dialog"';
    if (attr(n, "data-overlay")) return "data-overlay";
    return null;
  }
  const isPortalOutside = (n, sf) => {
    if (!ts.isCallExpression(n)) return null;
    const f = n.expression.getText(sf);
    if (f !== "createPortal" && !f.endsWith(".createPortal")) return null;
    const target = n.arguments[1]?.getText(sf).replace(/\s+/g, "") ?? "";
    return target === "document.body";
  };

  // Find a component's body: local (function X / const X = …) or via an import.
  function bodyOf(name, sf) {
    let local = null;
    for (const s of sf.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) local = s;
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) local = d.initializer;
    }
    if (local) return { sf, node: local };
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !s.importClause) continue;
      const spec = s.moduleSpecifier.text;
      const c = s.importClause;
      let foreign = null;
      if (c.name?.text === name) foreign = "default";
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
        for (const el of c.namedBindings.elements) if (el.name.text === name) foreign = (el.propertyName ?? el.name).text;
      }
      if (!foreign) continue;
      let base = null;
      if (spec.startsWith("@/")) base = path.join(src, spec.slice(2));
      else if (spec.startsWith(".")) base = path.resolve(path.dirname(sf.fileName), spec);
      if (!base) return { extern: spec };
      for (const cand of [base + ".tsx", base + ".ts", path.join(base, "index.tsx")]) {
        const target = source(cand);
        if (!target) continue;
        if (foreign === "default") {
          for (const s2 of target.statements) if (ts.isExportAssignment(s2)) return { sf: target, node: s2.expression };
          for (const s2 of target.statements) if (ts.isFunctionDeclaration(s2) && s2.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return { sf: target, node: s2 };
          return { extern: spec };
        }
        const r = bodyOf(foreign, target);
        return r ?? { extern: spec };
      }
      return { extern: spec };
    }
    return null;
  }

  const findings = [];
  const order = [];
  const slots = [];
  const checked = new Set();
  const extern = new Set();
  const seen = new Set();
  // Walks a subtree that lies IN a drag region. `chain` is the way there.
  function inDrag(node, sf, chain, depth) {
    const constant = regionConstants(sf);
    const visits = (n) => {
      if (isPortalOutside(n, sf) === true) return; // out to the body — inherits nothing
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const r = regionOf(n, constant);
        if (r === "no-drag") return; // the whole subtree is free
        const tag = tagName(n).getText(sf);
        const reason = floats(n, sf);
        if (reason) findings.push(`${path.relative(webDir, sf.fileName)}:${row(sf, n)} <${tag}> ${reason}  (Way: ${chain.join(" → ")})`);
        if (/^[A-Z]/.test(tag) && !tag.includes(".") && depth < DEPTH) {
          const r2 = bodyOf(tag, sf);
          if (r2?.extern) extern.add(`${tag} (${r2.extern})`);
          else if (r2?.node) {
            const key = r2.sf.fileName + "#" + r2.node.pos;
            checked.add(tag);
            if (!seen.has(key)) {
              seen.add(key);
              inDrag(r2.node, r2.sf, [...chain, tag], depth + 1);
            }
          }
        }
      }
      ts.forEachChild(n, visits);
    };
    visits(node);
  }

  // Rule (a): in DOM order (= source order of the opening tags in this file) no wide element that inherits `drag` may
  // stand behind a portal slot. A `no-drag` subtree and a portal to the body inherit nothing.
  const WIDE = /(^|[\s"'`{])(flex-1|grow|cb-strip)(?=[\s"'`}]|$)/;
  function slotOrder(root, sf, location) {
    const constant = regionConstants(sf);
    const followUp = [];
    const visits = (n) => {
      if (isPortalOutside(n, sf) === true) return;
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        if (regionOf(n, constant) === "no-drag") return;
        const idAttr = attr(n, "id");
        const withoutChildren = ts.isJsxSelfClosingElement(n) || n.children.every((k) => ts.isJsxText(k) && !k.text.trim());
        if (idAttr?.initializer && ts.isStringLiteral(idAttr.initializer) && withoutChildren) {
          followUp.push({ kind: "slot", id: idAttr.initializer.text, z: row(sf, n) });
        } else {
          const kl = attr(n, "className")?.initializer?.getText(sf) ?? "";
          const m = WIDE.exec(kl);
          if (m) followUp.push({ kind: "wide", tag: tagName(n).getText(sf), className: m[2], z: row(sf, n) });
        }
      }
      ts.forEachChild(n, visits);
    };
    if (ts.isJsxElement(root)) for (const k of root.children) visits(k);
    const file = path.relative(webDir, sf.fileName);
    followUp.forEach((e, i) => {
      if (e.kind !== "slot") return;
      slots.push(`#${e.id} (${file}:${e.z})`);
      for (const b of followUp.slice(i + 1)) {
        if (b.kind === "wide") order.push(`${file}:${e.z} Slot #${e.id} stands before <${b.tag}> (${b.className}, inherits drag) in line ${b.z}  (Root: ${location})`);
      }
    });
  }

  function roots(files) {
    const found = [];
    for (const file of files) {
      const sf = source(file);
      if (!sf) continue;
      const constant = regionConstants(sf);
      const visits = (n) => {
        if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && regionOf(n, constant) === "drag") {
          const location = `${path.relative(webDir, sf.fileName)}:${row(sf, n)} <${tagName(n).getText(sf)}>`;
          found.push(location);
          if (ts.isJsxElement(n)) for (const k of n.children) inDrag(k, sf, [location], 0);
          slotOrder(n, sf, location);
          return;
        }
        ts.forEachChild(n, visits);
      };
      visits(sf);
    }
    return found;
  }
  return { roots, findings, order, slots, checked, extern };
}

function tsxUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxUnder(p));
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const ofDisk = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

// Rule (b): the block `.cb-overlay { … }` in globals.css carries `no-drag` (with and without prefix).
function overlayNoDrag(css) {
  const m = /(^|\n)\.cb-overlay\s*\{([^}]*)\}/.exec(css);
  if (!m) return "no block `.cb-overlay { … }` in globals.css";
  const missing = [];
  if (!/-webkit-app-region:\s*no-drag\b/.test(m[2])) missing.push("-webkit-app-region: no-drag");
  if (!/(^|[\s;])app-region:\s*no-drag\b/.test(m[2])) missing.push("app-region: no-drag");
  return missing.length ? `.cb-overlay without ${missing.join(" and ")}` : null;
}

test("no floating surface in a drag region (app-region is inherited since Electron 44)", () => {
  const p = newCheck(ofDisk);
  const w = p.roots(tsxUnder(src));
  console.log(`# drag-region: ${w.length} drag root(s) [${w.join("; ")}], ${p.checked.size} components checked [${[...p.checked].sort().join(", ")}], external [${[...p.extern].sort().join(", ")}], ${p.slots.length} portal slot(s) in drag roots [${p.slots.join(", ")}]`);
  assert.ok(w.length > 0, "no drag root found — the test checked nothing (style constant renamed?)");
  assert.deepEqual(p.findings, [],
    "\n\nA surface floats in a drag region without a no-drag ancestor. Since Electron 44 it inherits `drag`, " +
    "and the window then swallows every click and every scroll there (\"the app freezes\"). Remedy: " +
    "createPortal(…, document.body) or style={noDrag} on it or an ancestor.\n");
  // (a) Without a slot the order check would check nothing — the central slot of the header is the reason for this rule.
  assert.ok(p.slots.some((x) => x.startsWith("#cbase-topnav-center ")), `the slot #cbase-topnav-center is in no drag root — renamed? found: [${p.slots.join(", ")}]`);
  assert.deepEqual(p.order, [],
    "\n\nA portal slot stands in its drag root BEFORE a wide element that inherits `drag`. Electron computes the " +
    "app-regions in DOM order — that element's rectangle overwrites the no-drag of the portal content, and nothing " +
    "there can be clicked in the client (in the browser it can). Remedy: put the slot BEHIND the wide element in the JSX (TopNav.tsx).\n");
  // (b)
  assert.equal(overlayNoDrag(fs.readFileSync(path.join(src, "app", "globals.css"), "utf8")), null,
    "the veil of the modals (`.cb-overlay`, on the body) must carry no-drag — otherwise the header's drag region " +
    "stays active under an open modal, and a click on a sheet that reaches into it drags the window");
});

test("self-test: the same computation on artificial sources — red where it must be red", () => {
  const header = `const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;\nconst noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;\n`;
  const modal = (body) => `import { createPortal } from "react-dom";\nexport function Sheet() {\n  ${body}\n}\n`;
  const nav = (inside) => `${header}import { Sheet } from "@/components/Sheet";\nexport function Header() { return (<nav style={drag}>${inside}</nav>); }\n`;
  const cases = [
    { name: "modal in place", sheet: `return <div className="fixed inset-0 z-[60]"><div role="dialog" /></div>;`, header: "<Sheet />", red: true },
    { name: "modal ported into a slot of the nav", sheet: `return createPortal(<div className="cb-overlay-in fixed inset-0" />, document.getElementById("slot")!);`, header: "<Sheet />", red: true },
    { name: "veil directly in the nav", sheet: `return null;`, header: `<div className="cb-overlay-in fixed inset-0" />`, red: true },
    { name: "modal ported to the body", sheet: `if (typeof document === "undefined") return null;\n  return createPortal(<div className="fixed inset-0" />, document.body);`, header: "<Sheet />", red: false },
    { name: "modal under no-drag", sheet: `return <div className="fixed inset-0" />;`, header: "<span style={noDrag}><Sheet /></span>", red: false },
    { name: "veil with its own no-drag", sheet: `return null;`, header: `<div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} className="fixed inset-0" />`, red: false },
    // Rule (a): portal slot before or behind a wide element that inherits drag.
    { name: "slot before the flex-1 strip", sheet: `return null;`, header: `<div id="slot" className="absolute inset-y-0" /><span className="cb-strip flex flex-1"><a style={noDrag}>Tab</a></span>`, red: true },
    { name: "slot before a grow element", sheet: `return null;`, header: `<div id="slot"></div><div className={\`grow \${x}\`} />`, red: true },
    { name: "slot behind the flex-1 strip", sheet: `return null;`, header: `<span className="cb-strip flex flex-1"><span id="start" className="contents" /><a style={noDrag}>Tab</a></span><div id="slot" className="absolute inset-y-0" /><span className="flex shrink-0" />`, red: false },
    { name: "slot before a flex-1 element under no-drag", sheet: `return null;`, header: `<div id="slot" /><span style={noDrag}><span className="flex-1" /></span>`, red: false },
  ];
  for (const f of cases) {
    const files = new Map([
      [path.join(src, "components", "Header.tsx"), nav(f.header)],
      [path.join(src, "components", "Sheet.tsx"), modal(f.sheet)],
    ]);
    const p = newCheck((d) => files.get(d) ?? null);
    const w = p.roots([path.join(src, "components", "Header.tsx")]);
    assert.equal(w.length, 1, `${f.name}: drag root not found`);
    const all = [...p.findings, ...p.order];
    assert.equal(all.length > 0, f.red, `${f.name}: expected ${f.red ? "red" : "green"}, findings ${JSON.stringify(all)}`);
  }
  // Rule (b) on artificial CSS.
  assert.equal(overlayNoDrag(".cb-overlay {\n  background: red;\n  -webkit-app-region: no-drag;\n  app-region: no-drag;\n}\n"), null, "veil with no-drag: expected green");
  assert.notEqual(overlayNoDrag(".cb-overlay {\n  background: red;\n}\n"), null, "veil without no-drag: expected red");
  assert.notEqual(overlayNoDrag(".cb-overlay {\n  -webkit-app-region: no-drag;\n}\n"), null, "veil with prefix only: expected red");
});
