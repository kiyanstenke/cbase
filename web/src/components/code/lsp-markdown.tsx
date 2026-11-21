// Markdown of the language service (hover, completion docs, signature help) in a node CodeMirror mounts as a tooltip: the same rendering as in
// the chat (components/Markdown.tsx, without innerHTML), through its own React root. `destroy` unmounts it — after the running tick, never
// in the middle of a render.
//
// The HOVER has VS Code's shape: sections separated by hairlines (lib/hover-sections.ts), code blocks in the editor's syntax colouring instead
// of a chat box, at most 500 px wide, scrolls within itself (shape: lsp-theme.ts).
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { Markdown, MarkdownReferenceContext, type MarkdownReferences } from "@/components/Markdown";
import { hoverImageDimensions, hoverImageTarget, lspMarkdownText, type HoverPart } from "@/lib/hover-sections";
import type { CodeChunk } from "@/components/code/code-colorize";

/** Images embedded (`data:image/…`) and via https as in VS Code's hover (lib/hover-sections.ts `hoverImageTarget`);
 *  links take the chat's route. */
const HOVER_REFERENCES: MarkdownReferences = { image: hoverImageTarget, dimensions: hoverImageDimensions, link: () => null };

function draw(dom: HTMLElement, raw: ReactNode): { dom: HTMLElement; destroy: () => void } {
  const content = <MarkdownReferenceContext.Provider value={HOVER_REFERENCES}>{raw}</MarkdownReferenceContext.Provider>;
  const root = createRoot(dom);
  // Drawn synchronously: CodeMirror measures the tooltip right after mounting.
  try { flushSync(() => root.render(content)); } catch { root.render(content); }
  return { dom, destroy: () => { setTimeout(() => root.unmount(), 0); } };
}

export function markdownNode(src: string, kind = "cm-lsp-md"): { dom: HTMLElement; destroy: () => void } {
  const dom = document.createElement("div");
  dom.className = kind;
  return draw(dom, <Markdown src={lspMarkdownText(src)} />);
}

/** A code block in the editor's colours. */
export function CodeBlock({ chunks }: { chunks: readonly CodeChunk[] }) {
  return (
    <pre className="cm-hover-code"><code>{chunks.map((s, i) => (s.kind ? <span key={i} className={s.kind}>{s.text}</span> : s.text))}</code></pre>
  );
}

/** The hover: one block per section (hairline between), code coloured via `colorize`, text as Markdown. */
export function hoverNode(sections: readonly HoverPart[][], colorize: (t: Extract<HoverPart, { kind: "code" }>) => readonly CodeChunk[]): { dom: HTMLElement; destroy: () => void } {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover";
  return draw(dom, (
    <>
      {sections.map((a, i) => (
        <div key={i} className="cm-hover-section">
          {a.map((t, j) => (t.kind === "code" ? <CodeBlock key={j} chunks={colorize(t)} /> : <div key={j} className="cm-hover-text"><Markdown src={t.text} /></div>))}
        </div>
      ))}
    </>
  ));
}
