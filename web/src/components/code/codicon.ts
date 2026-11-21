// A VS Code codicon as an SVG node — for the parts of the editor that CodeMirror builds as DOM (suggestion list, parameter hints). The
// symbol glyphs come from lib/codicon-symbols.ts (the same as in the outline, from VS Code's codicon.ttf), what is missing there from
// lib/codicons.ts — every glyph lives in exactly one of the two places (web/test/suggestion-list.test.mjs). Colour via `currentColor`.
import { CODICONS, type CodiconName, type GlyphName } from "@/lib/codicons";
import { codiconPath } from "@/lib/codicon-symbols";

export function codiconNode(name: GlyphName, kind = "cm-codicon"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", kind);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "currentColor");
  const path = (d: string, evenodd = false) => {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    if (evenodd) { p.setAttribute("fill-rule", "evenodd"); p.setAttribute("clip-rule", "evenodd"); }
    svg.appendChild(p);
  };
  const symbol = codiconPath(name);
  const c = name in CODICONS ? CODICONS[name as CodiconName] : null;
  if (symbol) {
    svg.setAttribute("viewBox", "0 0 16 16");
    path(symbol);
  } else if (c) {
    svg.setAttribute("viewBox", c.box);
    for (const p of c.paths) path(p.d, "evenodd" in p && p.evenodd === true);
  }
  return svg;
}
