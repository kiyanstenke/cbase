/**
 * The logic behind the slash picker in the composer — detection and filtering.
 *
 * DELIBERATELY here and not in `components/SlashPalette.tsx`: the gate runs `web/test/*.mjs`, and a test there
 * transpiles a `.ts` with the local `tsc` and imports it (model: `web/test/appearance.test.mjs`). That would not work
 * with JSX in the file — the view would only be checkable in a real browser, which is NOT part of the gate. So
 * what lives here is the part of the picker that is really measured before every deploy.
 */

/**
 * Three kinds: commands, skills, workflows. "workflow" means the chat's graph workflows as `workflow:<shortName>`
 * (not the saved DYNAMIC workflows).
 */
export type PaletteGroup = "command" | "skill" | "workflow";

export type PaletteEntry = {
  /** Without the slash — the picker prepends it when inserting. */
  name: string;
  /** The argument form of a command ("<text>"), display only. */
  arg?: string;
  description: string;
  group: PaletteGroup;
  /** Project a skill comes from (set only in the workspace view); for a workflow its real name plus project. */
  origin?: string;
};

/**
 * The "/word" right at the start of the input — and ONLY there. A slash in the middle of the text belongs to a path
 * ("see src/lib/api.ts") or a date, and a picker that pops up there covers the history while someone writes an
 * ordinary sentence. It does not open either once a space has been typed: from then on one types the ARGUMENT of a
 * command, not its name any more.
 *
 * It is measured against the CARET, not the whole text: with something behind "/mod" and a click back, the user
 * keeps typing the name.
 *
 * @returns the query without the slash, or null if the picker should stay closed.
 */
export function slashQuery(value: string, caret: number): string | null {
  const m = /^\/([a-zA-Z0-9:_-]*)$/.exec(value.slice(0, caret));
  return m ? m[1] : null;
}

/**
 * How many characters at the start of the input are highlighted as a command, skill or workflow (including the "/"),
 * else 0 — the marker in the composer (ChatComposer, overlay behind the textarea). The leading "/word" is highlighted
 * when it is EXACTLY an entry of the picker; while the name is still being typed (`typing` — the picker is open), as
 * soon as an entry starts that way. Case does not matter, as in `filterPalette`.
 *
 * @param names the names of the picker's stock (without "/"): commands, the chat's skills, `workflow:<shortName>`.
 */
export function slashMarkerLength(text: string, names: readonly string[], typing: boolean): number {
  const m = /^\/([a-zA-Z0-9:_-]+)/.exec(text);
  if (!m) return 0;
  const word = m[1].toLowerCase();
  const matches = names.some((n) => {
    const k = n.toLowerCase();
    return k === word || (typing && k.startsWith(word));
  });
  return matches ? m[0].length : 0;
}

/**
 * Filter and order. A match at the START of the name comes before a match in the middle: typing "co" means
 * "compact" or "cost", not "docs-connector". Within a tier the given order stays — commands before skills, skills as
 * delivered by the server.
 */
export function filterPalette(entries: PaletteEntry[], q: string): PaletteEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  const front: PaletteEntry[] = [];
  const inside: PaletteEntry[] = [];
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (n.startsWith(needle)) front.push(e);
    else if (n.includes(needle)) inside.push(e);
  }
  return [...front, ...inside];
}

/**
 * The text that stands in the field after the choice, and where the caret belongs.
 *
 * What stood behind the query stays — completing "/mod" to "/model" does not lose an argument already typed. The
 * space behind it is the room for exactly that argument and at the same time turns "/model" into a text that
 * `slashQuery` no longer opens: the panel closes by itself.
 */
export function placeSlash(input: string, query: string | null, name: string): { text: string; caret: number } {
  const rest = input.slice(query === null ? input.length : 1 + query.length);
  return { text: `/${name} ${rest.replace(/^\s+/, "")}`, caret: name.length + 2 };
}

export type SlashAction = "place" | "send" | "close" | "up" | "down";

/**
 * What a key does while the picker is OPEN ("Tab inserts, Enter sends directly"). One function for the composers.
 *
 *   Tab            → "place": "/name " into the field, caret behind it, panel closed — do NOT send.
 *   Enter          → "send": insert the highlighted hit AND send at once. One Enter is enough, even with an
 *                    incompletely typed name ("/rel" ⇒ "/release-notes"), whatever the kind: a command runs, a
 *                    skill goes out as a message.
 *   Shift+Enter    → null: line break as without a picker.
 *   Escape         → "close", even without hits.
 *   Arrows         → "up"/"down".
 *
 * Without hits only Escape is bound; Enter then returns null and falls through to ordinary sending at the caller — an
 * unknown "/xyz" or a path like "/Users/…" stays sendable. There is no "complete name only" exception: it would make
 * the behaviour depend on how far the user has typed.
 *
 * @param hits number of filtered entries in the panel.
 */
export function slashKey(e: { key: string; shiftKey: boolean; hits: number }): SlashAction | null {
  if (e.key === "Escape") return "close";
  if (e.hits <= 0) return null;
  if (e.key === "ArrowDown") return "down";
  if (e.key === "ArrowUp") return "up";
  if (e.key === "Tab") return "place";
  if (e.key === "Enter" && !e.shiftKey) return "send";
  return null;
}

/**
 * Attachments the composer made from a LARGE paste (from 1,200 characters or 25 lines the pasted text becomes the
 * file `pasted-text-….txt` instead of flooding the input). The name is the only feature that travels with the
 * attachment through server, database and both clients — iOS checks the same spelling (`PastedText.matches` in
 * Models.swift).
 */
export const INSERTION_RE = /^pasted-text(?:-[a-z0-9]+)?\.txt$/i;
export const isInsertion = (a: { name: string }) => INSERTION_RE.test(a.name);

/** Longest goal the server stores (`TARGET_MAX` in server.js) — the same number here. */
export const TARGET_MAX = 4000;

/**
 * The goal text of a "/goal <text>" when pastes are involved: what was typed, followed by the content of each pasted
 * text file, capped to what the server keeps.
 *
 * Why: a `/goal fix the 5 things:` with the list as a paste — and the list WAS the goal. Turning the paste into a file
 * is a convenience of the composer and must not change the meaning of the command: whatever stood behind "/goal" in the
 * field is the goal, typed or pasted. Without the list the judge would have to hold "fix the 5 things:" against an
 * answer without ever learning which five.
 *
 * An uploaded FILE (image, PDF, source) is not folded in — it is material for the agent, not goal text; it travels as
 * an attachment with the task.
 */
export function targetText(arg: string, insertions: string[]): string {
  const parts = [arg.trim(), ...insertions.map((t) => t.trim())].filter(Boolean);
  return parts.join("\n\n").slice(0, TARGET_MAX);
}

/**
 * The workflow group of the slash picker: one entry `workflow:<shortName>` per graph workflow of the chat. The SERVER
 * computes the short name over the effective set (`workflows/shortName.js`) — here it is only read, never built; an
 * entry without `shortName` (a list that does not carry it) is therefore not in the group at all, instead of offering
 * `workflow:undefined`, a name the server rejects. The row shows short name and origin (real name, with the project
 * for a project workflow); what gets inserted is `/workflow:<shortName> ` (`placeSlash`); sent, it is an ordinary
 * message — the switch knows no `workflow` command, the server reads the mention and the model starts the workflow.
 *
 * @param withoutDescription the (translated) sentence for a workflow without a description — an empty area would
 *   look like a load error.
 */
export function graphEntries(
  list: readonly { name: string; description: string; shortName?: string; originProject?: string }[],
  withoutDescription: string,
): PaletteEntry[] {
  return list.filter((w) => w.shortName).map((w) => ({
    name: "workflow:" + w.shortName,
    description: w.description || withoutDescription,
    group: "workflow" as const,
    origin: w.originProject ? `${w.name} · ${w.originProject}` : w.name,
  }));
}
