// Following a link as in VS Code: what ⌘-click does with the target of a link (lsp/actions.js `link`). VS Code opens a file at the
// location, reveals a folder in the explorer (`revealInExplorer`) and hands a web address to the opener (browser). Here the same three
// ways — a web address only with http, https or mailto (like the chat, components/Markdown.tsx `LINK_TARGET`: a foreign scheme would be
// a program launch), a folder only relative (a place outside the instance stands in no tree). A leaf module without imports (the
// guard web/test/link-colors.test.mjs runs it).

/** The shapes from lib/api/lsp.ts (`LspLinkTarget`) — here only what the calculation reads. */
type Location = { file: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; external?: { token: string } };
export type LinkTarget = { kind: "file"; location: Location } | { kind: "folder"; file: string } | { kind: "web"; url: string };

export type LinkWay = { kind: "file"; location: Location } | { kind: "folder"; path: string } | { kind: "web"; url: string };

const WEB = /^(https?:|mailto:)/i;

/** The way to a target — null: cbase does not follow it. */
export function linkWay(z: LinkTarget | null | undefined): LinkWay | null {
  if (!z || typeof z !== "object") return null;
  if (z.kind === "file") return z.location && typeof z.location.file === "string" && z.location.file ? { kind: "file", location: z.location } : null;
  if (z.kind === "folder") {
    const p = typeof z.file === "string" ? z.file : "";
    if (!p || p.startsWith("/") || p.split("/").includes("..")) return null;
    return { kind: "folder", path: p };
  }
  if (z.kind === "web") {
    if (typeof z.url !== "string" || !WEB.test(z.url)) return null;
    try { return { kind: "web", url: new URL(z.url).href }; } catch { return null; }
  }
  return null;
}
