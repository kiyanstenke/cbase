import { Fragment, createContext, memo, useContext, useState, type ReactNode } from "react";

// Lightweight Markdown without innerHTML (React escapes by itself). Scope deliberately
// identical to the iOS app (`mobile/CbaseMobile/Kit/Markdown.swift`) so the same reply looks
// the same on the desktop and on the phone:
// headings (1-6), paragraphs, ```/~~~ code blocks, tables with alignment, quotes, nested
// lists, task lists, rules; inline bold/italic/code/strikethrough/links/images.

// ── Inline ──────────────────────────────────────────────────────────────────

// Underscores per CommonMark: "_", "__" and "___" NEVER open or close inside a word: before
// or after them there must be no letter, no combining mark (\p{M}: NFD text such as "Café"
// from macOS file names carries the accent as a separate character after the "e"), no digit
// and no further underscore (Unicode-aware, flag "u"; iOS does the same). Asterisks may still
// do it ("a*b*c" is italic). Reason: a reply full of tool names ("cbase_dynamic_workflow_stop",
// "mcp__cbase__cbase_dynamic_workflow") arrived as cbase<em>dynamic</em>workflow_stop. Inside
// the CONTENT of an underscore emphasis a run of underscores may sit MID-word, since it can
// neither open nor close ("_x_y_" -> <em>x_y</em>, "__dunder_name__" -> <strong>dunder_name</strong>,
// as in CommonMark). Guard: web/test/markdown.test.mjs, second test.
const WORD_CHARACTER = "[\\p{L}\\p{M}\\p{N}_]";
const U_BEFORE = `(?<!${WORD_CHARACTER})`;
const U_AFTER = `(?!${WORD_CHARACTER})`;
const U_CONTENT = "(?:[^_]|(?<=[\\p{L}\\p{M}\\p{N}])_+(?=[\\p{L}\\p{M}\\p{N}]))";

// Order matters: code first (nothing inside it is formatted further), then images/links,
// then the emphasis forms, bare URLs last.
const INLINE = new RegExp(
  [
    "(``.+?``|`[^`]+`)", // code: double backticks first and lazy, otherwise the single case breaks
    // ("``a ` b``" would be read as `a `).
    "(!?\\[[^\\]\\n]*\\]\\([^)\\s]+\\))", // image or link
    `(\\*\\*\\*[^*]+\\*\\*\\*|${U_BEFORE}___${U_CONTENT}+___${U_AFTER})`, // bold+italic
    `(\\*\\*[^*]+\\*\\*|${U_BEFORE}__${U_CONTENT}+__${U_AFTER})`, // bold
    "(~~[^~]+~~)", // strikethrough
    `(\\*[^*\\s][^*]*\\*|${U_BEFORE}_[^_\\s]${U_CONTENT}*_${U_AFTER})`, // italic
    "(https?://[^\\s<>()]+)", // bare URL
  ].join("|"),
  "gu",
);
// `split` with groups yields, per match, the text before it and ALL groups (non-participating
// ones as undefined): the entries at multiples of PARTS (group count + 1) are free text between
// the matches. Free text is never formatted, even if it begins and ends with "_"; otherwise
// "_x_" before a bare URL ("_x_https://...", which the expression rejects) would still turn
// italic through the prefix check below, and "_ x_" likewise.
const PARTS = new RegExp(`${INLINE.source}|`, "u").exec("")!.length;

const linkClass = "text-accent underline decoration-accent/45 underline-offset-2 hover:decoration-accent";

// Which targets in a model's text become a clickable link. A foreign scheme (`smb://`, `file:`,
// `ssh://`, other programs' URI handlers) is a program launch: the browser asks which program,
// the desktop shell used to hand it to `shell.openExternal` unasked, so a click on
// `![Report](smb://host/x)` made Finder mount a foreign server. A link only becomes one with
// http(s), mailto, an anchor or a path of this site; an image (the link stands for the image,
// nothing is loaded) with http(s), a relative target or `data:image/...`.
// The image target is decided the way the browser resolves it, parsed against an http base: a
// relative target stays http, and a control character before the scheme (`\u0001smb://...`),
// which the parser drops, does not turn a foreign scheme into "relative".
// Guard: web/test/markdown.test.mjs (the test on foreign schemes).
const LINK_TARGET = /^(https?:|mailto:|#|\/)/;
const IMAGE_BASE = "http://cbase.invalid/";
function imageTarget(src: string): string {
  let u: URL;
  try {
    u = new URL(src, IMAGE_BASE);
  } catch {
    return "";
  }
  if (u.protocol === "http:" || u.protocol === "https:") return src;
  if (u.protocol === "data:" && /^data:image\//i.test(src)) return src;
  return "";
}

// The preview of a Markdown file (components/code/MarkdownPreview.tsx) resolves images and
// links RELATIVE TO THE FILE (lib/md-preview.ts): an image in the project shows as an image,
// a link to a file opens it, an anchor scrolls. What the context declines (null) takes the
// normal path above; without a context (chat, agenda, everything else) nothing changes.
export type MarkdownReferences = {
  image: (src: string) => string | null;
  /** Dimensions of an image (VS Code's size hint after `|`, hover only). */
  dimensions?: (src: string) => { width?: number; height?: number };
  link: (href: string) => { href: string; onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void } | null;
  /** Outputs visible: split free text and inline code into parts; a part with `open` becomes a
   *  button in cbase (a path into the chat's output location). `null` => the text stays as it was.
   *  No link to the outside: `href` stays `#`, LINK_TARGET is not touched. */
  path?: (text: string) => { text: string; open?: () => void; title?: string }[] | null;
};
export const MarkdownReferenceContext = createContext<MarkdownReferences | null>(null);
/** The marker of every heading in the preview (`preview`): the rendering draws headings as <div>, not h1-h6, so a `#anchor`
 *  searches by this marker (components/code/MarkdownPreview.tsx). Each top-level block also carries its source line
 *  (`data-line`, 0-based) to stay in step with the editor (VS Code `markdown.preview.scrollPreviewWithEditor`). */
export const HEADING_MARKER = "data-md-heading";
type BlockKind = { preview?: boolean; top?: boolean };

// A path into the output location (MarkdownReferences.path): a link button without an outside target; `href="#"`, the click opens in cbase.
function PathButton({ part, children }: { part: { open?: () => void; title?: string }; children: ReactNode }) {
  return (
    <a href="#" role="button" data-output-reference title={part.title} className={linkClass}
      onClick={(e) => { e.preventDefault(); part.open?.(); }}>{children}</a>
  );
}
function freeText(text: string, references: MarkdownReferences | null): ReactNode {
  const parts = references?.path?.(text);
  if (!parts?.some((t) => t.open)) return text;
  return parts.map((t, k) => (t.open ? <PathButton key={k} part={t}>{t.text}</PathButton> : <Fragment key={k}>{t.text}</Fragment>));
}

function Inline({ text }: { text: string }): ReactNode {
  const references = useContext(MarkdownReferenceContext);
  const parts = text.split(INLINE);
  return (
    <>
      {parts.map((part, i) => {
        if (part === undefined || part === "") return null;
        if (i % PARTS === 0) return <Fragment key={i}>{freeText(part, references)}</Fragment>; // free text
        // Code
        if (part.startsWith("``") && part.endsWith("``") && part.length > 4) {
          return <code key={i} className="rounded-md bg-code px-1.5 py-px font-mono text-[0.9em]">{part.slice(2, -2)}</code>;
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          const code = <code key={i} className="rounded-md bg-code px-1.5 py-px font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
          // A path into the output location as the WHOLE inline code: the code becomes the button.
          const target = references?.path?.(part.slice(1, -1));
          if (target?.length === 1 && target[0].open) return <PathButton key={i} part={target[0]}>{code}</PathButton>;
          return code;
        }
        // Image: as a link with a label so nothing foreign is loaded; with a foreign scheme only as text (imageTarget).
        const image = part.match(/^!\[([^\]\n]*)\]\(([^)\s]+)\)$/);
        if (image) {
          const own = references?.image(image[2]) ?? null;
          // No referrer: an image in the hover can come from a foreign host (lib/hover-sections.ts `hoverImageTarget`).
          const dimensions = own ? references?.dimensions?.(image[2]) : undefined;
          if (own) return <img key={i} src={own} alt={image[1]} width={dimensions?.width} height={dimensions?.height} referrerPolicy="no-referrer" className="inline-block max-w-full" data-md-image />;
          const href = imageTarget(image[2]);
          if (!href) return <Fragment key={i}>{image[1] || image[2]}</Fragment>;
          return (
            <a key={i} href={href} target="_blank" rel="noreferrer noopener" className={linkClass}>
              {image[1] || image[2]}
            </a>
          );
        }
        const link = part.match(/^\[([^\]\n]*)\]\(([^)\s]+)\)$/);
        if (link) {
          const own = references?.link(link[2]) ?? null;
          if (own) return <a key={i} href={own.href} onClick={own.onClick} target="_blank" rel="noreferrer noopener" className={linkClass} data-md-reference>{link[1] || link[2]}</a>;
          const href = LINK_TARGET.test(link[2]) ? link[2] : "";
          if (!href) return <Fragment key={i}>{link[1]}</Fragment>;
          return (
            <a key={i} href={href} target="_blank" rel="noreferrer noopener" className={linkClass}>
              {link[1] || href}
            </a>
          );
        }
        if ((part.startsWith("***") && part.endsWith("***")) || (part.startsWith("___") && part.endsWith("___"))) {
          return <strong key={i}><em><Inline text={part.slice(3, -3)} /></em></strong>;
        }
        if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
          return <strong key={i}><Inline text={part.slice(2, -2)} /></strong>;
        }
        if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4) {
          return <s key={i} className="opacity-70"><Inline text={part.slice(2, -2)} /></s>;
        }
        if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
          if (part.length > 2) return <em key={i}><Inline text={part.slice(1, -1)} /></em>;
        }
        if (/^https?:\/\//.test(part)) {
          return <a key={i} href={part} target="_blank" rel="noreferrer noopener" className={linkClass}>{part}</a>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

// ── Block detection ──────────────────────────────────────────────────────────

type Align = "left" | "center" | "right";

const indentOf = (l: string) => (l.match(/^ */)?.[0].length ?? 0);
const isBlank = (l: string) => !l.trim();
const isPipeRow = (l: string) => /^\s{0,3}\|.*\|\s*$/.test(l);
const headingOf = (l: string) => {
  const m = l.match(/^ {0,3}(#{1,6})(\s+(.*))?$/);
  return m ? { level: m[1].length, text: (m[3] ?? "").replace(/\s*#+\s*$/, "") } : null;
};
const isRule = (l: string) => /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const isQuote = (l: string) => /^ {0,3}>/.test(l);
const fenceOf = (l: string) => {
  const m = l.match(/^ {0,3}(`{3,}|~{3,})\s*([^`~\s]*)/);
  return m ? { char: m[1][0], language: m[2] || "" } : null;
};

function splitCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body
    .replace(/\\\|/g, "\u0001")
    .split("|")
    .map((c) => c.replace(/\u0001/g, "|").trim());
}

function alignmentsOf(line: string): Align[] | null {
  if (!line || !line.includes("-")) return null;
  const cells = splitCells(line);
  if (!cells.length) return null;
  const out: Align[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    out.push(cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left");
  }
  return out;
}

interface Marker { indent: number; ordered: boolean; number: number; contentIndent: number; content: string }

function markerOf(line: string): Marker | null {
  const bullet = line.match(/^( *)([-*+]) +(.*)$/);
  if (bullet && !isRule(line)) {
    return {
      indent: bullet[1].length,
      ordered: false,
      number: 0,
      contentIndent: line.length - bullet[3].length,
      content: bullet[3],
    };
  }
  const ordered = line.match(/^( *)(\d{1,9})[.)] +(.*)$/);
  if (ordered) {
    return {
      indent: ordered[1].length,
      ordered: true,
      number: Number(ordered[2]),
      contentIndent: line.length - ordered[3].length,
      content: ordered[3],
    };
  }
  return null;
}

const isBlockStart = (l: string) => !!fenceOf(l) || !!headingOf(l) || isRule(l) || isQuote(l) || isPipeRow(l);

// ── Blockrenderer ───────────────────────────────────────────────────────────

const HEADING_CLASS: Record<number, string> = {
  1: "mb-1.5 mt-3 text-[1.25em] font-bold tracking-tight first:mt-0",
  2: "mb-1 mt-3 text-[1.13em] font-bold tracking-tight first:mt-0",
  3: "mb-1 mt-2.5 text-[1.05em] font-semibold first:mt-0",
  4: "mb-1 mt-2.5 font-semibold first:mt-0",
  5: "mb-1 mt-2 font-semibold text-dim first:mt-0",
  6: "mb-1 mt-2 text-[0.95em] font-semibold uppercase tracking-wide text-dim first:mt-0",
};

const ALIGN_CLASS: Record<Align, string> = { left: "text-left", center: "text-center", right: "text-right" };

function Blocks({ text, tight = false, preview = false, top = false }: { text: string; tight?: boolean } & BlockKind) {
  const lines = text.split("\n");
  // Preview only: the source line per top-level block, the marker per heading (in the chat the HTML stays as it is).
  const rowOf = (z: number): Record<string, number> => (preview && top ? { "data-line": z } : {});
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const before = i;
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // Code block (``` or ~~~)
    const fence = fenceOf(line);
    if (fence) {
      const closing = fence.char.repeat(3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(closing)) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(<CodeBlock key={key++} language={fence.language} code={body.join("\n").replace(/\n+$/, "")} data={rowOf(before)} />);
      continue;
    }

    const heading = headingOf(line);
    if (heading) {
      out.push(
        <div key={key++} className={HEADING_CLASS[heading.level]} {...rowOf(before)} {...(preview ? { [HEADING_MARKER]: "" } : {})}>
          <Inline text={heading.text} />
        </div>,
      );
      i++;
      continue;
    }

    if (isRule(line)) {
      out.push(<hr key={key++} className="my-2.5 border-edge" {...rowOf(before)} />);
      i++;
      continue;
    }

    // Quote: collect its own lines, strip the prefix, render recursively.
    if (isQuote(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        if (isQuote(lines[i])) {
          inner.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
          continue;
        }
        if (!isBlank(lines[i]) && !isBlockStart(lines[i]) && !markerOf(lines[i]) && inner.length) {
          inner.push(lines[i].trim());
          i++;
          continue;
        }
        break;
      }
      out.push(
        <blockquote key={key++} className="my-2 border-l-[3px] border-accent/55 pl-3 text-dim" {...rowOf(before)}>
          <Blocks text={inner.join("\n")} tight preview={preview} />
        </blockquote>,
      );
      continue;
    }

    // Table
    if (line.includes("|")) {
      const alignments = alignmentsOf(lines[i + 1] ?? "");
      if (alignments) {
        const header = splitCells(line);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
          rows.push(splitCells(lines[i]));
          i++;
        }
        out.push(<Table key={key++} header={header} rows={rows} alignments={alignments} data={rowOf(before)} />);
        continue;
      }
      if (isPipeRow(line)) {
        const rows: string[][] = [];
        while (i < lines.length && isPipeRow(lines[i])) {
          rows.push(splitCells(lines[i]));
          i++;
        }
        out.push(<Table key={key++} header={null} rows={rows} alignments={[]} data={rowOf(before)} />);
        continue;
      }
    }

    // Lists (nested, with task checkboxes)
    const marker = markerOf(line);
    if (marker) {
      const [list, next] = takeList(lines, i);
      out.push(<List key={key++} {...list} preview={preview} data={rowOf(before)} />);
      i = next;
      continue;
    }

    // Paragraph: line breaks are kept (as in the iOS app).
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i]) && !markerOf(lines[i]) && !alignmentsOf(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++} className={`${tight ? "my-1" : "my-1.5"} whitespace-pre-wrap break-words leading-relaxed first:mt-0 last:mb-0`} {...rowOf(before)}>
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && "\n"}
            <Inline text={l} />
          </Fragment>
        ))}
      </p>,
    );

    if (i === before) i++; // safety net against endless loops
  }

  return <>{out}</>;
}

interface ListData { ordered: boolean; start: number; items: { checked: boolean | null; body: string }[] }

/// Reads a list starting at `from` and returns it with the next line. The content of an item
/// stays raw text and is rendered recursively, so items can carry nested lists, code blocks
/// and several paragraphs.
function takeList(lines: string[], from: number): [ListData, number] {
  const first = markerOf(lines[from])!;
  const ordered = first.ordered;
  const baseIndent = first.indent;
  const items: ListData["items"] = [];
  let i = from;

  while (i < lines.length) {
    if (isBlank(lines[i])) {
      let look = i + 1;
      while (look < lines.length && isBlank(lines[look])) look++;
      const next = look < lines.length ? lines[look] : null;
      if (!next) break;
      const continues = (markerOf(next)?.indent ?? Infinity) <= baseIndent + 1 || indentOf(next) > baseIndent;
      if (!continues) break;
      i = look;
      continue;
    }
    const marker = markerOf(lines[i]);
    if (!marker || marker.indent > baseIndent + 1 || marker.ordered !== ordered) break;

    const body: string[] = [marker.content];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (isBlank(next)) {
        let look = i + 1;
        while (look < lines.length && isBlank(lines[look])) look++;
        if (look >= lines.length || indentOf(lines[look]) < marker.contentIndent) break;
        body.push("");
        i = look;
        continue;
      }
      const following = markerOf(next);
      if (following && following.indent <= baseIndent + 1) break;
      if (indentOf(next) >= marker.contentIndent || following) {
        body.push(next.slice(Math.min(marker.contentIndent, indentOf(next))));
        i++;
        continue;
      }
      if (!isBlockStart(next)) {
        body.push(next.trim());
        i++;
        continue;
      }
      break;
    }

    const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
    let checked: boolean | null = null;
    if (task) {
      checked = task[1] !== " ";
      body[0] = task[2];
    }
    items.push({ checked, body: body.join("\n").replace(/\n+$/, "") });
  }

  return [{ ordered, start: ordered ? Math.max(1, first.number) : 1, items }, i];
}

type Data = { data?: Record<string, number> };
function List({ ordered, start, items, preview = false, data }: ListData & { preview?: boolean } & Data) {
  const hasTasks = items.some((it) => it.checked !== null);
  if (hasTasks) {
    return (
      <ul className="my-1.5 space-y-1" {...data}>
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className={`mt-[0.3em] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border text-[9px] leading-none ${
                item.checked ? "border-accent bg-accent/85 text-white" : "border-dim/50"
              }`}
              aria-hidden
            >
              {item.checked ? "✓" : ""}
            </span>
            <div className="min-w-0 flex-1">
              <Blocks text={item.body} tight preview={preview} />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag
      className={`my-1.5 space-y-0.5 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}
      {...(ordered && start !== 1 ? { start } : {})}
      {...data}
    >
      {items.map((item, i) => (
        <li key={i}>
          <Blocks text={item.body} tight preview={preview} />
        </li>
      ))}
    </Tag>
  );
}

function Table({ header, rows, alignments, data }: { header: string[] | null; rows: string[][]; alignments: Align[] } & Data) {
  const align = (column: number) => ALIGN_CLASS[alignments[column] ?? "left"];
  return (
    <div className="my-2 overflow-x-auto" {...data}>
      <table className="w-full border-collapse text-[0.95em]">
        {header && (
          <thead>
            <tr>
              {header.map((cell, j) => (
                <th key={j} className={`border-b border-edge px-2.5 py-1.5 font-semibold ${align(j)}`}>
                  <Inline text={cell} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, j) => (
                <td key={j} className={`border-b border-edge px-2.5 py-1.5 align-top ${align(j)}`}>
                  <Inline text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// This file deliberately stays WITHOUT project imports (web/test/markdown.test.mjs compiles it
// alone with tsc, where an `@/lib/i18n` would not resolve). So icons are local here, and the translation is looked up
// through the hook lib/i18n.ts registers under TRANSLATOR (its `tr`, keys in i18n-de.ts like every other `t`/`tr` call).
// Without it (the test's lone compile) the English source stands.
const TRANSLATOR = Symbol.for("cbase.tr");
const tr = (key: string): string => {
  const f = (globalThis as Record<symbol, unknown>)[TRANSLATOR];
  return typeof f === "function" ? (f as (k: string) => string)(key) : key;
};

const cbIcon = (children: ReactNode, size: number) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

function CodeBlock({ language, code, data }: { language: string; code: string } & Data) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="group relative my-2 overflow-hidden rounded-xl border border-edge bg-code" {...data}>
      {language && (
        <div className="border-b border-edge/70 py-1 pl-3 pr-10 cb-cs-10 font-semibold uppercase tracking-wide text-dim">
          {language}
        </div>
      )}
      {/* The button sits on the OUTER box, not on the <pre>: that one scrolls horizontally, the
          button must stay put. mouseup is stopped so the auto-copy of the text selection in the
          history (ChatPane.onMessagesMouseUp) does not interfere. */}
      <button
        type="button"
        onClick={copy}
        onMouseUp={(e) => e.stopPropagation()}
        title={copied ? tr("Copied") : tr("Copy code")}
        aria-label={tr("Copy code")}
        className={`absolute right-1.5 top-1.5 z-10 grid h-6 w-6 place-items-center rounded-md bg-code text-dim transition-opacity hover:bg-hover hover:text-fg focus:opacity-100 group-hover:opacity-100 ${copied ? "opacity-100" : "opacity-0"}`}
      >
        {copied ? cbIcon(<path d="M20 6L9 17l-5-5" />, 14) : cbIcon(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>, 13)}
      </button>
      <pre className="cb-cs-13 overflow-x-auto p-3 font-mono">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Memoised: parsing is pure computation on `src` and nothing else. The chat history holds
// hundreds of Markdown blocks under ONE state; without this guard every SSE event (every
// token, every tool call) re-parsed the WHOLE history, which showed as visible flicker while
// the agent worked.
// `preview` (the editor's Markdown preview): headings carry HEADING_MARKER, top-level blocks their source line.
export const Markdown = memo(function Markdown({ src, preview = false }: { src: string; preview?: boolean }) {
  return <Blocks text={String(src).replace(/\r\n/g, "\n").replace(/\t/g, "    ")} preview={preview} top />;
});
