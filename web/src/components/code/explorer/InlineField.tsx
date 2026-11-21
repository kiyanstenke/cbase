"use client";
// The field IN the row instead of `prompt()`: Rename (↵, F2, menu) with the name without extension preselected, New File/New Folder empty
// at the spot in the target folder. ↵ accepts, Esc cancels; focus lost without input (or with an invalid name) cancels, with a valid one
// accepts (as in VS Code). The message stands BELOW the field as in VS Code — red for an error (the field stays), yellow for a warning. The
// check is computed by lib/explorer-names.ts `checkName`; only the wordings live here (through `t()`).
// "a/b.ts" is allowed (only a leading slash is not, VS Code `validateFileName`); the file icon before the field follows the typed
// extension (`symbol`); after ↵ (accepted) and Esc the field calls `onFinished` — the tree takes focus back. A cancel through focus
// (click elsewhere) does NOT call it: focus belongs there then.
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { nameSelection, type NameCheck } from "@/lib/explorer-names";
import type { EditingError } from "@/components/code/explorer/useExplorer";

export function InlineField({ beginning, isFolder, symbol, check, error, onConfirm, onAbort, onFinished }: {
  beginning: string;
  isFolder: boolean;
  /** The icon before the field for the typed name (files; a folder has none). */
  symbol?: (name: string) => React.ReactNode;
  /** After ↵ (accepted) and Esc — not after a cancel through focus. */
  onFinished?: () => void;
  check: (name: string) => NameCheck;
  /** The error after a ↵ (check or server) — until the next input. */
  error: EditingError | null;
  onConfirm: (name: string) => Promise<boolean>;
  onAbort: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(beginning);
  const [typed, setTyped] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    const [a, b] = nameSelection(beginning, isFolder);
    el.setSelectionRange(a, b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const live = check(value);
  const notice = (() => {
    if (error && !typed) {
      if ("server" in error) return { kind: "error" as const, text: error.server };
      return { kind: "error" as const, text: wording(error.code) };
    }
    if (live.error && (typed || value !== beginning) && value !== "") return { kind: "error" as const, text: wording(live.error) };
    if (live.warning) return { kind: "warning" as const, text: t("Leading or trailing whitespace detected in file or folder name.") };
    return null;
  })();
  function wording(code: NonNullable<NameCheck["error"]>) {
    if (code === "empty") return t("A file or folder name must be provided.");
    if (code === "slash") return t("A file or folder name cannot start with a slash.");
    if (code === "invalid") return t("The name “{name}” is not valid as a file or folder name. Please choose a different name.", { name: value });
    return t("A file or folder “{name}” already exists at this location. Please choose a different name.", { name: value });
  }
  const takeOver = async () => {
    if (done.current) return;
    done.current = true;
    const ok = await onConfirm(value);
    done.current = ok;
    setTyped(false);
    if (!ok) field.current?.focus();
    return ok;
  };
  return (
    <span className="relative flex min-w-0 flex-1 items-center" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {symbol?.(value)}
      <input
        ref={field}
        value={value}
        spellCheck={false}
        aria-label={isFolder ? t("Folder name") : t("File name")}
        aria-invalid={notice?.kind === "error"}
        data-tree-field
        onChange={(e) => { setValue(e.target.value); setTyped(true); }}
        onKeyDown={(e) => {
          e.stopPropagation(); // the tree's keys (↑ ↓, typing, ⌘C) do not apply in the field
          if (e.key === "Enter") { e.preventDefault(); void takeOver().then((ok) => { if (ok) onFinished?.(); }); }
          else if (e.key === "Escape") { e.preventDefault(); done.current = true; onAbort(); onFinished?.(); }
        }}
        onBlur={() => {
          if (done.current) return;
          // Focus lost: cancel without input or with an invalid name, otherwise accept (VS Code).
          if (value === beginning || !value.trim() || check(value).error) { done.current = true; onAbort(); return; }
          void takeOver();
        }}
        className="cb-tree-field min-w-0 flex-1"
      />
      {notice && (
        <span role={notice.kind === "error" ? "alert" : "status"} data-tree-notice={notice.kind} className="cb-tree-notice">
          {notice.text}
        </span>
      )}
    </span>
  );
}
