// "Python: Select Interpreter": the project's candidates (`.venv`/`venv`, the Pythons of the project container, the chosen one) as a
// command-palette pick, plus "Automatic" (`set: null` — detection) and "Enter path …". It is stored per PROJECT on the server (holds for
// editor and agents, copies inherit) — therefore the choice always goes to the project level: on the workspace level to the project under
// whose folder the file lies (the same rule as the server, lib/commandPalette.ts `projectOfTheFile`); if it belongs to none, there is no
// choice (`interpreterPossible`, status line and command). Opened by the command table (palette-host.ts, command `python.setInterpreter`)
// and by the interpreter in the status line (LspStatusLine.tsx). Afterwards the status re-reads — the status line shows the new interpreter
// as soon as the server reports it.
import { api, isNotSupported, lspCalls, lspLanguageOf, type LspTarget, type Workspace } from "@/lib/api";
import { refreshLspStatus, lspStatusOf } from "@/lib/lsp-status";
import { projectOfTheFile } from "@/lib/commandPalette";
import { tr } from "@/lib/i18n";
import { openPalette } from "@/components/code/CommandPalette";
import type { PaletteSelection, PaletteRow } from "@/components/code/palette-modes";

const SOURCE_WORD: Readonly<Record<string, string>> = { venv: "project virtual environment", container: "in the project container", chosen: "chosen by hand" };

/** Is there a choice here? A Python file whose status does not say "no project". */
export function interpreterPossible(target: LspTarget, path: string | null | undefined): boolean {
  if (!path || lspLanguageOf(path)?.language !== "python") return false;
  return lspStatusOf(target, path).not?.reason !== "no_project";
}

/** The choice's project level: the project route itself, on the workspace level that of the file's project — null: none. */
export async function projectTargetFor(target: LspTarget, path: string | null): Promise<LspTarget | null> {
  if (/^\/api\/projects\/[^/]+$/.test(target.apiBase)) return target;
  const wid = /^\/api\/workspaces\/([^/]+)$/.exec(target.apiBase)?.[1];
  if (!wid || !path) return null;
  const ws = (await api<Workspace[]>("/api/workspaces")).find((w) => w.id === decodeURIComponent(wid));
  const p = ws ? projectOfTheFile(ws.path, ws.projects ?? [], path) : null;
  return p ? { apiBase: `/api/projects/${encodeURIComponent(p.id)}`, instance: null } : null;
}

/** Open the choice (command palette, "pick" mode). `target`/`path`: the file the choice is made from (its status re-reads afterwards). */
export function selectInterpreter(target: LspTarget, path: string | null): void {
  let project: LspTarget | null = null;
  const setValue = async (set: string | null) => {
    if (!project) throw new Error(tr("The file belongs to no project — an interpreter applies per project."));
    if (set !== null && !set.trim()) throw new Error(tr("Path to the interpreter, e.g. /usr/bin/python3"));
    const r = await lspCalls(project, "interpreter", { set });
    if (isNotSupported(r)) throw new Error(tr("No Python language service here ({reason}).", { reason: r.reason }));
    if (path) void refreshLspStatus(target, path);
  };
  const selection: PaletteSelection = {
    title: tr("Python: Select Interpreter"),
    load: async () => {
      project = await projectTargetFor(target, path);
      if (!project) throw new Error(tr("The file belongs to no project — an interpreter applies per project."));
      const r = await lspCalls(project, "interpreter", {});
      if (isNotSupported(r)) throw new Error(tr("No Python language service here ({reason}).", { reason: r.reason }));
      const rows: PaletteRow[] = [{
        key: "auto", label: tr("Automatic"), selected: r.selected === null, kind: "wait", data: { "data-palette-interpreter": "" },
        detail: r.selected === null && r.effective ? tr("detected: {p}", { p: r.effective }) : tr("the project's detection"),
        execute: () => setValue(null),
      }];
      for (const c of r.candidates ?? []) {
        rows.push({
          key: `k:${c.path}`, label: c.path, selected: r.selected === c.path, kind: "wait", data: { "data-palette-interpreter": c.path },
          detail: [c.version, SOURCE_WORD[c.source] ? tr(SOURCE_WORD[c.source]) : c.source].filter(Boolean).join(" · "),
          execute: () => setValue(c.path),
        });
      }
      return rows;
    },
    freeText: { label: tr("Enter path…"), placeholder: tr("Path to the interpreter, e.g. /usr/bin/python3"), take: (text) => setValue(text) },
  };
  openPalette({ selection, source: null });
}
