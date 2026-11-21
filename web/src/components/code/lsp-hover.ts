// Hover of the language service: type, signature and docs as Markdown over the symbol under the pointer — `hover { position }`.
// Shape like VS Code: sections with hairlines (lib/hover-sections.ts), code blocks in the editor's syntax colours (the language at the block,
// otherwise the file's — loaded before showing so the tooltip appears coloured at once). While ⌘ (otherwise Ctrl) is held, the hover
// belongs to the definition preview (cmd-hover.ts) — this one stays silent then.
import { hoverTooltip } from "@codemirror/view";
import { language } from "@codemirror/language";
import { isNotSupported, lspAreaOf, lspPosOf } from "@/lib/api";
import { hoverSections } from "@/lib/hover-sections";
import { questions, can, lspFileOf } from "@/components/code/lsp-core";
import { hoverNode } from "@/components/code/lsp-markdown";
import { colorize, languageForName } from "@/components/code/code-colorize";
import { cmdPressed } from "@/components/code/cmd-hover";
import { colorForPicker } from "@/components/code/color-picker";

export const lspHover = hoverTooltip(async (view, pos) => {
  const d = lspFileOf(view.state);
  if (!can(d, "hover") || cmdPressed(view)) return null;
  if (colorForPicker(view, pos)) return null; // over a colour VS Code shows only the colour picker (color-picker.ts)
  const doc = view.state.doc;
  let r;
  try { r = await questions(d, "hover", { position: lspPosOf(doc, pos) }); } catch { return null; }
  if (isNotSupported(r) || !r.contents || view.state.doc !== doc || cmdPressed(view)) return null;
  const sections = hoverSections(r.contents);
  if (!sections.length) return null;
  const own = view.state.facet(language);
  const names = [...new Set(sections.flat().flatMap((t) => (t.kind === "code" ? [t.language] : [])))];
  const languages = new Map(await Promise.all(names.map(async (n) => [n, await languageForName(n, own)] as const)));
  if (view.state.doc !== doc) return null;
  const b = r.range ? lspAreaOf(doc, r.range) : { from: pos, to: pos };
  return {
    pos: b.from, end: b.to, above: true,
    create: (v) => {
      const k = hoverNode(sections, (t) => colorize(v.state, t.text, languages.get(t.language) ?? null));
      k.dom.style.tabSize = String(v.state.tabSize);
      return k;
    },
  };
}, { hoverTime: 350 });
