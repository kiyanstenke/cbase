// Summary of a tool row in the chat history — without React, so the gate (web/test/tool-summary.test.mjs) can compile and
// check it with tsc. The view (components/AssistantBlocks.tsx) imports from here; the diff building lives here too, because the
// line balance ("+35 −0") comes from it and it is no view itself.

export type DiffLine = { sign: "-" | "+" | " "; text: string };

// Diff from the tool input (Edit/MultiEdit/Write/apply_patch).
export function buildDiff(name: string, input?: Record<string, unknown>): DiffLine[] | null {
  if (!input) return null;
  const push = (arr: DiffLine[], sign: DiffLine["sign"], s: string) => {
    for (const line of String(s).split("\n")) arr.push({ sign, text: line });
  };
  const out: DiffLine[] = [];
  if (name === "Write" && typeof input.content === "string") {
    push(out, "+", input.content);
  } else if (name === "Edit" && typeof input.old_string === "string") {
    push(out, "-", input.old_string);
    if (typeof input.new_string === "string") push(out, "+", input.new_string);
  } else if (name === "MultiEdit" && Array.isArray(input.edits)) {
    for (const e of input.edits as Array<Record<string, unknown>>) {
      if (typeof e?.old_string === "string") push(out, "-", e.old_string);
      if (typeof e?.new_string === "string") push(out, "+", e.new_string);
    }
  } else if (name === "apply_patch" && Array.isArray(input.changes)) {
    // Codex reports file changes as a list {path, kind} — and, depending on the CLI version, the unified diff as well.
    // If present it is shown; otherwise at least WHAT changed.
    for (const c of input.changes as Array<Record<string, unknown>>) {
      const patch = typeof c?.diff === "string" ? c.diff : typeof c?.unified_diff === "string" ? c.unified_diff : "";
      const kind = String(c?.kind || "update");
      if (patch) {
        push(out, " ", `${kind} ${String(c?.path ?? "")}`);
        for (const line of patch.split("\n")) {
          out.push({ sign: line.startsWith("+") && !line.startsWith("+++") ? "+" : line.startsWith("-") && !line.startsWith("---") ? "-" : " ", text: line });
        }
      } else {
        push(out, kind === "delete" ? "-" : kind === "add" ? "+" : " ", `${kind} ${String(c?.path ?? "")}`);
      }
    }
  } else {
    return null;
  }
  return out.length ? out : null;
}

// The ONE file of a write tool with exactly one file (Edit, MultiEdit, Write): `file_path` as the tool reported it
// (absolute, rarely relative to the run's cwd) — otherwise null. The file-name button in the history hangs on it (code tabs in the chat,
// components/AssistantBlocks.tsx `FileButton`); relative to the chat's target is computed by lib/chat-tabs.ts `relativeToRoot`. apply_patch
// (Codex, several files) and NotebookEdit carry no button.
export const FILE_TOOLS: readonly string[] = ["Edit", "MultiEdit", "Write"];
export function toolFile(name: string, input?: Record<string, unknown>): string | null {
  if (!FILE_TOOLS.includes(name) || !input) return null;
  const p = input.file_path;
  return typeof p === "string" && p.trim() ? p : null;
}

// The least the summary must know about a tool block — the view's block (`Block` in AssistantBlocks.tsx) satisfies it
// structurally.
export type ToolSummaryBlock = {
  name: string;
  count?: number;
  input?: Record<string, unknown>;
  resultIsError?: boolean;
  done?: boolean;
};

export type Translator = (k: string, p?: Record<string, string | number>) => string;

// VERBATIM with the iOS app (`toolSummary` in ChatDetailSheet.swift): "Ran 15 commands, created one file  +35 −0". Every call is
// a command, files are counted as created/edited, the line balance comes from the write tools' inputs.
// From two commands on the number of failed ones follows in parentheses — for ONE command the row carries the word "Error"
// instead; a "(1 failed)" behind "Ran 1 command" would say the same twice.
//
// `text` is the whole sentence; beside it stand its three pieces so the view can color the counter red without altering the
// sentence: `base` ("Ran 5 commands"), `counter` ("(1 failed)" or empty) and `postscript` (", created one file" or empty). The
// counter stands in the MIDDLE, not at the end — that is how iOS builds the sentence, and the test rig reads the header text
// verbatim. From two calls on the red word "Error" is dropped; without color on the counter a failure in the collapsed row
// would be gray like everything else.
export type ToolSummary = {
  text: string; base: string; counter: string; postscript: string;
  added: number; removed: number; files: boolean; error: number;
};
export function toolSummary(blocks: ToolSummaryBlock[], t: Translator): ToolSummary {
  const n = blocks.reduce((s, b) => s + Math.max(1, b.count || 1), 0);
  const error = blocks.filter((b) => b.resultIsError).length;
  const base = n === 1 ? t("Ran 1 command") : t("Ran {n} commands", { n });
  const counter = n > 1 && error > 0 ? t("({k} failed)", { k: error }) : "";
  const parts: string[] = [];
  let created = 0, edited = 0, added = 0, removed = 0;
  for (const b of blocks) {
    if (b.name === "Write") created += 1;
    else if (["Edit", "MultiEdit", "NotebookEdit", "apply_patch"].includes(b.name)) edited += 1;
    for (const line of buildDiff(b.name, b.input) ?? []) {
      if (line.sign === "+") added += 1; else if (line.sign === "-") removed += 1;
    }
  }
  if (created === 1) parts.push(t("created one file"));
  else if (created > 1) parts.push(t("created {n} files", { n: created }));
  if (edited === 1) parts.push(t("edited one file"));
  else if (edited > 1) parts.push(t("Edited {n} files", { n: edited }));
  const postscript = parts.map((x) => `, ${x}`).join("");
  const text = `${base}${counter ? ` ${counter}` : ""}${postscript}`;
  return { text, base, counter, postscript, added, removed, files: created + edited > 0, error };
}
