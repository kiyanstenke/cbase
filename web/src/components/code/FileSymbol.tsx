// The file icon as in VS Code's default icon theme (Seti), drawn from the ONE table lib/file-symbols.ts for explorer, tabs, search,
// breadcrumbs and file search. 16 × 16, colour from the table; folders have no icon (only the arrow in the tree).
import { fileSymbolKind, type FileSymbolKind } from "@/lib/file-symbols";

function Glyph({ a }: { a: FileSymbolKind }) {
  const f = a.color;
  switch (a.form) {
    case "text": {
      const t = a.text ?? "";
      const large = t.length <= 1 ? 11 : t.length === 2 ? 8.5 : 6.5;
      return <text x="8" y="11.6" textAnchor="middle" fontSize={large} fontWeight={700} fontFamily="-apple-system, system-ui, sans-serif" fill={f}>{t}</text>;
    }
    case "react":
      return (
        <g fill="none" stroke={f} strokeWidth="1">
          <ellipse cx="8" cy="8" rx="6.6" ry="2.6" />
          <ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(60 8 8)" />
          <ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(120 8 8)" />
          <circle cx="8" cy="8" r="1.3" fill={f} stroke="none" />
        </g>
      );
    case "brackets":
      return <text x="8" y="11.4" textAnchor="middle" fontSize="9.5" fontWeight={700} fontFamily="ui-monospace, Menlo, monospace" fill={f}>{"{}"}</text>;
    case "angle":
      return <text x="8" y="11.4" textAnchor="middle" fontSize="9.5" fontWeight={700} fontFamily="ui-monospace, Menlo, monospace" fill={f}>{"<>"}</text>;
    case "markdown":
      return (
        <g fill="none" stroke={f} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 11V5l2.5 3L7 5v6" />
          <path d="M11.5 5v6M9.5 9l2 2 2-2" />
        </g>
      );
    case "shell":
      return (
        <g fill="none" stroke={f} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5l3 3-3 3" />
          <path d="M8 11.5h5" />
        </g>
      );
    case "image":
      return (
        <g fill="none" stroke={f} strokeWidth="1.2">
          <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
          <circle cx="6" cy="6.6" r="1.1" fill={f} stroke="none" />
          <path d="M3 11.5l3.2-3 2.3 2 2-1.6 2.5 2.6" strokeLinejoin="round" />
        </g>
      );
    case "gear":
      return (
        <g fill={f}>
          <path d="M8 2.2l1.1.2.3 1.4.9.4 1.2-.8 1.6 1.6-.8 1.2.4.9 1.4.3.2 1.1-.2 1.1-1.4.3-.4.9.8 1.2-1.6 1.6-1.2-.8-.9.4-.3 1.4-1.1.2-1.1-.2-.3-1.4-.9-.4-1.2.8-1.6-1.6.8-1.2-.4-.9-1.4-.3L2.2 8l.2-1.1 1.4-.3.4-.9-.8-1.2 1.6-1.6 1.2.8.9-.4.3-1.4z" />
          <circle cx="8" cy="8" r="2" fill="var(--color-panel, #181818)" />
        </g>
      );
    case "padlock":
      return (
        <g fill="none" stroke={f} strokeWidth="1.3">
          <rect x="3.5" y="7" width="9" height="6.5" rx="1" fill={f} stroke="none" />
          <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
        </g>
      );
    case "git":
      return (
        <g fill={f}>
          <path d="M8 1.6l6.4 6.4L8 14.4 1.6 8z" />
          <circle cx="8" cy="5.4" r="1.1" fill="var(--color-panel, #181818)" />
          <circle cx="8" cy="10.6" r="1.1" fill="var(--color-panel, #181818)" />
          <path d="M7.5 5.4h1v5.2h-1z" fill="var(--color-panel, #181818)" />
        </g>
      );
    case "info":
      return (
        <g>
          <circle cx="8" cy="8" r="6" fill="none" stroke={f} strokeWidth="1.4" />
          <path d="M8 7v4.2" stroke={f} strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.9" r="0.95" fill={f} />
        </g>
      );
    case "docker":
      return (
        <g fill={f}>
          <path d="M1.5 8.2h11.3c.9-.8 1.6-.8 2-.6-.2.9-.8 1.5-1.4 1.7C12.4 12 10 13.5 6.6 13.5 3.6 13.5 1.9 11.3 1.5 8.2z" />
          <rect x="3" y="6" width="1.8" height="1.6" /><rect x="5.2" y="6" width="1.8" height="1.6" /><rect x="7.4" y="6" width="1.8" height="1.6" />
          <rect x="5.2" y="3.9" width="1.8" height="1.6" /><rect x="7.4" y="3.9" width="1.8" height="1.6" />
        </g>
      );
    case "npm":
      return (
        <g>
          <rect x="1.5" y="5" width="13" height="6" fill={f} />
          <path d="M3 6.4h3v3.2H5V7.4h-.9v2.2H3zM7 6.4h3v2.4H8.4v.8H7zm1.4 1v.8H9v-.8zM10.6 6.4H14v3.2h-1V7.4h-.4v2.2h-.9V7.4h-.4v2.2h-.7z" fill="var(--color-panel, #181818)" />
        </g>
      );
    case "license":
      return (
        <g fill="none" stroke={f} strokeWidth="1.3">
          <circle cx="8" cy="6.5" r="3.6" />
          <path d="M6 9.6L5 14l3-1.6 3 1.6-1-4.4" strokeLinejoin="round" />
        </g>
      );
    case "database":
      return (
        <g fill="none" stroke={f} strokeWidth="1.2">
          <ellipse cx="8" cy="4.2" rx="5" ry="1.8" />
          <path d="M3 4.2v7.6c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4.2M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
        </g>
      );
    case "table":
      return (
        <g fill="none" stroke={f} strokeWidth="1.2">
          <rect x="2.5" y="3" width="11" height="10" rx="1" />
          <path d="M2.5 6.4h11M2.5 9.7h11M6.4 3v10" />
        </g>
      );
    case "pdf":
      return <text x="8" y="11" textAnchor="middle" fontSize="6.5" fontWeight={700} fontFamily="-apple-system, system-ui, sans-serif" fill={f}>PDF</text>;
    case "archive":
      return (
        <g fill="none" stroke={f} strokeWidth="1.2">
          <rect x="3" y="2.5" width="10" height="11" rx="1" />
          <path d="M8 2.5v1.4M8 5v1.4M8 7.5v1.4" strokeWidth="1.6" />
          <rect x="6.8" y="9.4" width="2.4" height="2.4" />
        </g>
      );
    default:
      return (
        <g stroke={f} strokeWidth="1.4" strokeLinecap="round">
          <path d="M3.5 4.5h9M3.5 7.2h9M3.5 9.9h9M3.5 12.6h5.5" />
        </g>
      );
  }
}

/** The icon of a file (16 × 16). `path` may be a whole path; only the last part counts. */
export function FileSymbol({ path, className = "" }: { path: string; className?: string }) {
  const a = fileSymbolKind(path);
  return (
    <span className={`inline-grid h-4 w-4 shrink-0 place-items-center ${className}`} aria-hidden data-file-symbol={a.form}>
      <svg width="16" height="16" viewBox="0 0 16 16"><Glyph a={a} /></svg>
    </span>
  );
}
