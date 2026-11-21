/**
 * Small computations of the skill pages: Coding → Skills (components/SkillsPane.tsx, workspace and project level).
 * The top-level `/skills` page is only a redirect to Coding → Skills.
 *
 * DELIBERATELY here and not in the components: the gate runs `web/test/*.mjs`, and web/test/skills.test.mjs compiles
 * this file with the local `tsc` and imports it. That would not work with JSX or imports.
 *
 * A leaf module without imports.
 */

/**
 * Sorted by name — the routes return creation order, which is the wrong order for finding a skill again.
 * Returns a NEW list (the page's state is not re-sorted).
 */
export function byName<T extends { name: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The names of workspace skills that a project skill of the SAME name covers inside a project (the project wins on equal
 * names). Their toggle still works there — it decides whether the workspace skill comes back once the project skill is
 * deleted — but this project's catalog lists only one of the two.
 */
export function covered(own: readonly { name: string }[], workspace: readonly { name: string }[]): Set<string> {
  const names = new Set(own.map((s) => s.name));
  return new Set(workspace.filter((s) => names.has(s.name)).map((s) => s.name));
}

/**
 * "Hidden in: A, B" — the names in the order the server delivers them (sorted by name). `null` (the server said
 * nothing) and an empty list both give `""`: the line then stays silent. What it does NOT do is claim "hidden in no
 * project" — that would turn `null` into knowledge nobody has.
 */
export function hiddenText(projects: readonly { name: string }[] | null): string {
  return projects && projects.length ? projects.map((p) => p.name).join(", ") : "";
}

/**
 * A token count at reading size. Below a thousand the number itself, above that "1,2k" — the message is the order of
 * magnitude (a few hundred or a few thousand tokens per request?), not the last digit.
 */
export function tokenShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n >= 999_950) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "").replace(".", ",")}M`; // otherwise "1000,0k"
  return `${(n / 1000).toFixed(1).replace(".", ",")}k`;
}
