// The status bar of the header — bindings by PATH, without a browser.
//
// The rebuild makes three promises, and each fails silently:
//  (1) The pills show on EVERY page because the TopNav renders them itself — not a page via portal. A page
//      import of a pill would be the way back: it would again stand on that page only (or twice), and nothing
//      would turn red.
//  (2) The header learns about the workspace switch. localStorage tells nobody in the same tab; a write site
//      past `rememberWorkspace` would leave the pill on the old workspace — with correct numbers for the wrong
//      place. And conversely: the scope belongs to the TAB and the page it shows — no `storage` listener
//      (another tab would push the pill onto its workspace), and a choice that does not mean the page only
//      remembers the start value (`rememberStartWorkspace`).
//  (3) "Two places for the same list: delete one" — the ports and resources pills were merged into the
//      services pills. If they reappear, the list exists twice again.
// Plus the identifiers that DOM probes in a real browser grab, and the translations.
//
// Layout: each section is its own `test(…)`; the web <-> iOS binding of the rules (thresholds, inputs of the
// stage, "measured", identifiers, dot, plus loaded flag, cost, machine source, counting rule and the resources
// section — against `mobile/CbaseMobile/Shell/ServicesStatus.swift` and `ServicesButton.swift`) is its own
// section (a)–(f6) at the END of this file.
//
// Counter-test map (each sabotage turns the named test red):
//  · `localStorage.setItem("cbase-ws", id)` back into a page, or via a constant (`setItem(WS_KEY, id)`) ⇒ (2);
//  · VsCodePill before ServicesPill in the TopNav ⇒ order; the pill group of the TopNav as `hidden … md:flex`
//    ⇒ order/md; an import of `@/components/pills/VsCodePill` in workspaces/page.tsx ⇒ (1); an empty
//    `PortsPill.tsx` ⇒ (3); a new `t("…")` in ServicesPill.tsx without a line in i18n-de.ts ⇒ translations;
//  · `setScopeProject(null)` on leaving removed, or `?project=` read under another name ⇒ scope;
//    `data-services-menu` removed, or AgentBrowsersPill without `useActiveScope()` ⇒ identifiers;
//  · the `storage` listener back into active-scope.ts, or a start-value choice via `rememberWorkspace(id)`,
//    or `rememberStartWorkspace` notifying ⇒ "scope per tab";
//  · the pill cutting itself (`all.filter((s) => s.running && s.workspaceId === ws …)`), the count as
//    `{n > 0 && …{n}…}` at the trigger, the number text via `sumText(sum)` in the pill, or `title={row1}`
//    instead of `title` ⇒ "scope, trigger, tooltip"; `d.running` removed in `runningInScope` ⇒ (c);
//  · `cleanAddress()` removed from the jump listener or from the build path of the apps page, `e.preventDefault()`
//    removed in the jump listener or in `toApps`, `cancelable: true` removed from the event ⇒ "scope".
//    The jump itself was MEASURED in a real Chrome against web/out: with only `replaceState` in the listener
//    `?project=p1` stayed (Next navigates AFTER the link's onClick) and ⌘R chose Alpha against the manual choice;
//    taking over the jump (`preventDefault` ⇒ the link does not navigate) fixes it;
//  · ports and performance are separate (two triggers `data-status-ports`/`data-status-performance`, two menus
//    from ONE state, the color on the performance symbol via `performanceTone`, the folder size only in the
//    performance menu): `bg-accent-soft` in a trigger ⇒ "separate" (3); two `useState(false)` instead of one
//    state ⇒ (2); the machine block in the ports menu, or "Running services" in the performance menu ⇒ (4);
//    `performanceTone` with the count again ⇒ (e); the click catcher always asking `[data-status-ports-pop]`
//    ⇒ "identifiers"; iOS `model.menu(open: true)` also on the ports popover ⇒ (f2); iOS `let cpu` without
//    `n > 0` ⇒ (f5). The rendered proof (both triggers without ground/edge/shadow like the rings, exactly one
//    menu per click, the switch in one go, machine block visible without roles) is the job of a scratch
//    measurement, not of this file.
//
// Run:  node --test web/test/statusBar.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const read = (rel) => fs.readFileSync(path.resolve(webDir, rel), "utf8");
const rel = (p) => path.relative(webDir, p).split(path.sep).join("/");

// All source files under web/src (without the dictionary — it only carries keys).
function sources(dir = src) {
  const out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) out.push(...sources(p));
    else if (/\.(tsx?|mjs|js)$/.test(n.name)) out.push(p);
  }
  return out;
}
const ALL = sources();
// Comments do not count for prohibitions: the sources NAME the forbidden thing to justify it ("not as fixed
// inset-0", "replaces the old ResourcesPill"). Rough, but on the safe side: a `//` inside a string
// (http://…) only shortens what is checked.
const withoutComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
// The same, but line-preserving: comments become spaces, the line breaks stay — for messages that name a line number.
const withoutCommentsLinePreserving = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:"'`])(\/\/.*)$/gm, (_, a, b) => a + " ".repeat(b.length));

// The trigger of an entry: from `<button` before its identifier to `</button>` after it — the identifier is
// searched as a whole attribute, not the longer `…-pop`/`…-menu` ones.
function triggerOf(source, identifier, location) {
  const m = new RegExp(String.raw`\s${identifier}\s`).exec(source);
  assert.ok(m, `${location}: the identifier ${identifier} is on no element — update the anchor`);
  const on = source.lastIndexOf("<button", m.index);
  const end = source.indexOf("</button>", m.index);
  assert.ok(on >= 0 && end > m.index && !/<(?!button\b)/.test(source.slice(on + 1, m.index)),
    `${location}: ${identifier} is not on a <button …> — update the anchor`);
  return source.slice(on, end);
}

// ── (2) The workspace switch goes through rememberWorkspace ───────────────────────────────────

test("write sites: only lib/active-scope.ts writes `cbase-ws` — not via a constant either", () => {
  const violations = [];
  let writesAllowed = 0;
  let caller = 0;
  for (const p of ALL) {
    const r = rel(p);
    if (r === "src/lib/i18n-de.ts") continue;
    const text = fs.readFileSync(p, "utf8");
    // Constants carrying the key (e.g. `const WS_KEY = "cbase-ws"`).
    const aliases = [...text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]cbase-ws["'`]/g)].map((m) => m[1]);
    const pattern = [
      /\bsetItem\(\s*["'`]cbase-ws["'`]/g,
      /localStorage\s*\[\s*["'`]cbase-ws["'`]\s*\]\s*=[^=]/g,
      ...aliases.map((a) => new RegExp(String.raw`\bsetItem\(\s*${a}\b`, "g")),
    ];
    const rows = text.split("\n");
    for (const m of pattern) {
      for (const f of text.matchAll(m)) {
        const seq = text.slice(0, f.index).split("\n").length;
        // Comments do not count (active-scope.ts names the forbidden form in its head).
        if (/^\s*(\/\/|\*|\/\*)/.test(rows[seq - 1])) continue;
        if (r === "src/lib/active-scope.ts") writesAllowed++;
        else violations.push(`${r}:${seq}: ${rows[seq - 1].trim().slice(0, 100)}`);
      }
    }
    if (r !== "src/lib/active-scope.ts" && /\brememberWorkspace\(/.test(text)) caller++;
  }
  // Anchor: the one allowed way MUST be in active-scope.ts — via the constant.
  const scope = read("src/lib/active-scope.ts");
  assert.ok(/export const WS_KEY = "cbase-ws";/.test(scope), "active-scope.ts no longer carries the key as WS_KEY — update the anchor, do not delete the test");
  assert.ok(writesAllowed >= 1, "active-scope.ts does not write `cbase-ws` — then nobody remembers the workspace");
  console.log(`  [Scope] ${ALL.length} files checked, ${caller} call rememberWorkspace, ${violations.length} write past it`);
  // The lower bound catches a search that finds nothing anymore, not a deleted page (the C4 planner page and the personas page are gone).
  assert.ok(caller >= 3, `only ${caller} files call rememberWorkspace — does the search still work?`);
  assert.deepEqual(violations, [], "write site past rememberWorkspace — the header would never learn of the switch in the same tab");
});

test("scope: the coding page publishes workspace and project — and the apps page reads ?project=", () => {
  const ws = read("src/app/workspaces/page.tsx");
  assert.ok(/import\s*\{[^}]*\brememberWorkspace\b[^}]*\bsetScopeProject\b[^}]*\}\s*from\s*"@\/lib\/active-scope"/.test(ws),
    "workspaces/page.tsx does not import rememberWorkspace/setScopeProject from @/lib/active-scope");
  assert.ok(/setScopeProject\(activeId \? scopeProject : null\)/.test(ws), "the coding page does not publish the entered project");
  assert.ok(/useEffect\(\(\) => \(\) => setScopeProject\(null\), \[\]\)/.test(ws),
    "on leaving the coding page the project is not withdrawn — other views would keep filtering by it");
  assert.ok(!/liveServices|shownServices|cbase-topnav-end/.test(ws), "the coding page queries the services itself again or fills the old slot");
  const apps = withoutComments(read("src/app/apps/page.tsx"));
  assert.ok(/searchParams\.get\("project"\)/.test(apps), "the apps page does not read ?project= — the jump from the pill would land without a selection");
  assert.ok(/addEventListener\(APPS_PROJECT_EVENT, atJump\)/.test(apps), "the apps page does not listen to the jump when it is already open");
  // BOTH ways clear `?project=` from the address — otherwise the parameter wins against the manual choice on the next ⌘R. One cleaner, two callers.
  const clean = inBracket(apps, /const cleanAddress = \(\) => \{/, "src/app/apps/page.tsx", "const cleanAddress");
  assert.ok(/searchParams\.delete\("project"\)/.test(clean) && /history\.replaceState\(/.test(clean),
    "cleanAddress does not remove ?project= from the address via replaceState");
  // …and via Next: Next only reconciles its router state for a history call WITHOUT a mark of its own.
  // `replaceState(window.history.state, …)` carries `__NA` and went through unseen — `canonicalUrl` kept `?project=`,
  // and the next router tick (`router.refresh()`) wrote it back into the address. Therefore EVERY history call of
  // the page passes `null` as state; Next copies its own in.
  const history = [...apps.matchAll(/\bhistory\.(?:replaceState|pushState)\(/g)].map((m) => parts(inBracket(apps.slice(m.index), /^history\.\w+\(/, "src/app/apps/page.tsx", "history.…State(")));
  assert.ok(history.length >= 1, "anchor: no history.replaceState(…) in the apps page — update");
  const past = history.filter((a) => a[0] !== "null").map((a) => `history.…State(${a.join(", ")})`);
  assert.deepEqual(past, [], "the apps page writes the address past the Next router (a state with __NA) — canonicalUrl would keep ?project=, and the next router tick would write it back");
  assert.ok(/if \(id\) \{\s*select\(id\);\s*cleanAddress\(\);\s*\}/.test(apps), "the build path (?project= on load) does not clean the address");
  const jump = inBracket(apps, /const atJump = \(e: Event\) => \{/, "src/app/apps/page.tsx", "const atJump");
  assert.ok(/\bcleanAddress\(\)/.test(jump), "the event path (apps already open) does not clean the address");
  // …and takes over the jump so that the pill's link no longer navigates: Next calls onClick first and pushes
  // `?project=` into the address AFTER it — cleaning in the listener alone did not hold (measured).
  assert.ok(/\be\.preventDefault\(\)/.test(jump), "the jump listener does not take over the jump (preventDefault) — the pill link would push ?project= into the address again after cleaning");
  const scope = withoutComments(read("src/lib/active-scope.ts"));
  const over = inBracket(scope, /export function handOverAppsJump\([^)]*\)[^{]*\{/, "src/lib/active-scope.ts", "function handOverAppsJump");
  assert.ok(/return !window\.dispatchEvent\(new CustomEvent\(APPS_PROJECT_EVENT, \{[^}]*\bcancelable: true\b[^}]*\}\)\)/.test(over),
    "handOverAppsJump does not report back whether the open page took over (cancelable + !dispatchEvent)");
  const pill = withoutComments(read("src/components/pills/ServicesPill.tsx"));
  assert.ok(/href=\{appsProjectHref\(d\.projectId\)\}[\s\S]{0,200}onClick=\{\(e\) => toApps\(e, d\.projectId\)\}/.test(pill),
    "the services row does not jump to Apps via appsProjectHref with toApps(e, …)");
  const closing = inBracket(pill, /const toApps = \(e: React\.MouseEvent, projectId: string\) => \{/, "src/components/pills/ServicesPill.tsx", "const toApps");
  assert.ok(/if \(handOverAppsJump\(projectId\)\) e\.preventDefault\(\);/.test(closing),
    "toApps does not stop the link when the open apps page took over the jump");
});

test("displayed workspace: every page that derives it from the remembered one reports the DISPLAYED one — also from deep link and fallback", () => {
  // Pages used to report the workspace only on a CHOICE in the rail. If it came about via a deep link, a board address
  // or the fallback to `list[0]`, the page showed one workspace and the services pill another. The hook reports
  // "as soon as it is settled": list loaded AND workspace in it.
  const scope = withoutComments(read("src/lib/active-scope.ts"));
  assert.ok(/export function useDisplayedWorkspace\([^)]*\)\s*\{\s*useEffect\(\(\) => \{\s*if \(id && list\?\.some\(\(w\) => w\.id === id\)\) rememberWorkspace\(id\);\s*\}, \[id, list\]\);\s*\}/.test(scope),
    "useDisplayedWorkspace does not report (only) a workspace the loaded list contains — an unknown id from the address bar would be remembered, or the effect does not depend on id and list");
  // Which pages: every file under src/app that reads the REMEMBERED workspace — it derives the displayed one from it.
  // Searched in the tree, not from a list here: a new page would otherwise slip through.
  const pages = ALL.filter((p) => rel(p).startsWith("src/app/") && /getItem\(\s*["'`]cbase-ws["'`]\s*\)/.test(fs.readFileSync(p, "utf8"))).map(rel).sort();
  const missing = [];
  for (const r of pages) {
    const text = withoutComments(read(r));
    if (r === "src/app/workspaces/page.tsx") {
      // Coding reports workspace and project in ONE step (rememberWorkspace forgets the project on switching) —
      // hence an effect of its own instead of the hook, with the same condition.
      if (!/useEffect\(\(\) => \{\s*if \(activeId && !list\.some\(\(w\) => w\.id === activeId\)\) return;\s*if \(activeId\) rememberWorkspace\(activeId\);\s*setScopeProject\(activeId \? scopeProject : null\);\s*\}, \[activeId, scopeProject, list\]\);/.test(text)) {
        missing.push(`${r}: the effect does not report activeId only once \`list\` contains it (or not in one step with the project)`);
      }
      continue;
    }
    const m = /\buseDisplayedWorkspace\(\s*(\w+)\s*,\s*(\w+)\s*\)/.exec(text);
    if (!m) { missing.push(`${r}: does not call useDisplayedWorkspace — a deep link or the fallback to the first workspace would never reach the header`); continue; }
    // …and with THE state the page renders from (otherwise it would report another than it shows).
    const [, state, list] = m;
    const renders = new RegExp(String.raw`\b${list}\.find\(\(w\) => w\.id === ${state}\)`).test(text)
      || new RegExp(String.raw`visibleWorkspaces\(\s*${list}\b[^,]*,\s*${state}\s*\)`).test(text);
    if (!renders) missing.push(`${r}: reports useDisplayedWorkspace(${state}, ${list}) but does not render from ${list}/${state}`);
    if (!/import\s*\{[^}]*\buseDisplayedWorkspace\b[^}]*\}\s*from\s*"@\/lib\/active-scope"/.test(text)) missing.push(`${r}: useDisplayedWorkspace does not come from @/lib/active-scope`);
  }
  console.log(`  [Displayed] ${pages.length} pages read the remembered workspace: ${pages.map((r) => r.replace(/^src\/app\//, "").replace(/\/page\.tsx$/, "")).join(", ")}`);
  // Anchor: the page that exists. A page that DISAPPEARED would be a rebuild someone names — here it would otherwise
  // slip through as "less to check". `/skills` and `/todos` no longer show a workspace (they only redirect into
  // Coding); the pages of the C4 planner and of the personas are deleted.
  for (const desired of ["workspaces"]) {
    assert.ok(pages.includes(`src/app/${desired}/page.tsx`), `src/app/${desired}/page.tsx no longer reads the remembered workspace — does the search still work? Update the anchor, do NOT delete it`);
  }
  assert.deepEqual(missing, [], "a page shows a workspace the header does not learn about");
});

test("scope per tab: no storage listener — the start value does not move the header", () => {
  // The header's scope belongs to the TAB and the page it shows. Two ways used to move it from outside without the
  // page following — correct numbers for the wrong place:
  //  · a `storage` listener: if tab B chose a workspace, the pill in tab A jumped along (with ping-pong as soon as A
  //    reloaded its list and wrote its own workspace back);
  //  · the workspace of the agent dock: it chooses what the PANEL shows, and called `rememberWorkspace`.
  const scope = withoutComments(read("src/lib/active-scope.ts"));
  assert.ok(!/addEventListener\(\s*["'`]storage["'`]/.test(scope) && !/\bStorageEvent\b/.test(scope) && !/\bonstorage\b/.test(scope),
    "active-scope.ts listens to storage events again — another tab would push the pill onto its workspace while the page here stays on the old one");
  // Elsewhere too, no storage listener moves the live scope (searched in the tree, not from a list).
  const listeners = [];
  const violations = [];
  for (const p of ALL) {
    const text = withoutComments(fs.readFileSync(p, "utf8"));
    if (!/addEventListener\(\s*["'`]storage["'`]|\bonstorage\b/.test(text)) continue;
    listeners.push(rel(p));
    if (/\b(?:rememberWorkspace|setScopeProject|useDisplayedWorkspace)\(/.test(text)) violations.push(rel(p));
  }
  console.log(`  [Scope per tab] storage listeners in web/src: ${listeners.length ? listeners.join(", ") : "none"}`);
  assert.deepEqual(violations, [], "a file listens to storage AND moves the header scope — it belongs to the tab");
  // The start value is NO live scope: rememberStartWorkspace only writes the storage.
  const start = inBracket(scope, /export function rememberStartWorkspace\([^)]*\)[^{]*\{/, "src/lib/active-scope.ts", "function rememberStartWorkspace");
  assert.ok(/\bsetItem\(\s*WS_KEY\b/.test(start), "rememberStartWorkspace does not write the start value (cbase-ws)");
  assert.ok(!/\bset\(|\bhoerer\b|\bstand\b|\brememberWorkspace\(/.test(start),
    "rememberStartWorkspace touches the live scope or notifies");
  // The other direction: whoever wants to know which workspace THIS tab shows asks the live scope — not the start
  // value. The runs pill compared `localStorage["cbase-ws"]` with the workspace of a run; other tabs write that value
  // too. Coding showed ws Y while ws X was remembered ⇒ a run from X opened by event IN the view of Y. Components
  // (not pages: those read their start value on build) therefore do not read `cbase-ws`.
  const reader = [];
  for (const p of ALL) {
    const r = rel(p);
    if (!r.startsWith("src/components/")) continue;
    const text = withoutComments(fs.readFileSync(p, "utf8"));
    const aliases = [...text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]cbase-ws["'`]/g)].map((m) => m[1]);
    const pattern = [/\bgetItem\(\s*["'`]cbase-ws["'`]/, /\bgetItem\(\s*WS_KEY\b/, /localStorage\s*\[\s*["'`]cbase-ws["'`]\s*\](?!\s*=[^=])/,
      ...aliases.map((a) => new RegExp(String.raw`\bgetItem\(\s*${a}\b`))];
    if (pattern.some((m) => m.test(text))) reader.push(r);
  }
  assert.deepEqual(reader, [], "a component reads the start value (localStorage cbase-ws) instead of the live scope of this tab (readActiveScope/useActiveScope)");
  const runs = withoutComments(read("src/components/pills/ActiveRunsPill.tsx"));
  const openRun = inBracket(runs, /function openRun\([^)]*\)\s*\{/, "src/components/pills/ActiveRunsPill.tsx", "function openRun");
  assert.ok(/import\s*\{[^}]*\breadActiveScope\b[^}]*\}\s*from\s*"@\/lib\/active-scope"/.test(runs)
    && /const (\w+) = readActiveScope\(\)\.workspaceId === run\.workspaceId;[\s\S]*?if \(here && \1\) \{\s*window\.dispatchEvent\(new CustomEvent\("cbase-open-chat"/.test(openRun),
    "the runs pill does not decide \"same workspace, only the event\" via readActiveScope().workspaceId — a run from another workspace would open in the view of the displayed one");
  // The same switch for every jump into a coding chat by id (lib/chat-jump.ts: dumpster, service chat, wait rows).
  const open = withoutComments(read("src/lib/chat-jump.ts"));
  assert.ok(/readActiveScope\(\)\.workspaceId === workspaceId\)\s*\{[\s\S]*?window\.dispatchEvent\(new CustomEvent\("cbase-open-chat"/.test(open),
    "openCodingChat does not decide \"same workspace, only the event\" via readActiveScope().workspaceId");
});

test("Ports · Performance: the services-status module computes scope, trigger and tooltips — the entries neither cut nor compare themselves", () => {
  const PATH = "src/components/pills/ServicesPill.tsx";
  const pill = withoutComments(read(PATH));
  const imp = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/services-status"/.exec(pill);
  assert.ok(imp, `${PATH} imports nothing from @/lib/services-status`);
  for (const f of ["runningInScope", "triggerContent", "tooltipRows"]) {
    assert.ok(new RegExp(String.raw`\b${f}\b`).test(imp[1]), `${PATH} does not take ${f} from the module — the promise would have no guard there`);
  }
  // Which services belong to the scope is cut by the module — with ws/pid from the active scope.
  assert.ok(/const ws = scope\.workspaceId;/.test(pill) && /const pid = scope\.projectId;/.test(pill), "anchor: ws/pid no longer come from useActiveScope() — update");
  assert.ok(/const services: RunningService\[\] = runningInScope\(all, ws, pid\)/.test(pill),
    "the services do not come from runningInScope(all, ws, pid) — in Coding an entered project keeps filtering, which would hang on a line without a guard");
  assert.ok(!/\ball\s*\??\./.test(pill), "the entries bypass runningInScope and access the raw service list (all.…)");
  const own = [];
  for (const m of pill.matchAll(/\.filter\(/g)) {
    const body = inBracket(pill.slice(m.index), /^\.filter\(/, PATH, ".filter(");
    if (/\b(?:workspaceId|projectId|ws|pid)\b/.test(body)) own.push(`.filter(${body.trim().slice(0, 80)})`);
  }
  if (/\.workspaceId\s*[!=]==?/.test(pill)) own.push("a comparison with .workspaceId");
  assert.deepEqual(own, [], "the entries cut by workspace/project themselves — runningInScope in the module does that");
  // The count (ports) and the CPU/RAM numbers (performance) come from triggerContent — from THE SAME count, no own
  // comparison with n at either of the two triggers.
  assert.ok(/const \{ count, counts, muted \} = triggerContent\(n, sum\);/.test(pill), "the trigger content does not come from triggerContent(n, sum)");
  assert.ok(!/\bsumText\b/.test(pill), "the file computes the number text itself (sumText) — past the count condition of the module");
  const ports = triggerOf(pill, "data-status-ports", PATH);
  const perf = triggerOf(pill, "data-status-performance", PATH);
  for (const [name, a] of [["Ports", ports], ["Performance", perf]]) {
    assert.ok(!/(?<![\w$.])n\s*(?:[<>]=?|[!=]==?)/.test(a), `the ${name} trigger compares with n itself — count, numbers and tone at the trigger are decided by triggerContent`);
    assert.ok(!/(?<!=)\{\s*n\s*\}/.test(a), `the ${name} trigger shows n directly — with 0 services it would say "0" (it must show no number)`);
  }
  assert.ok(/\{count != null && <span className="tabular-nums">\{count\}<\/span>\}/.test(ports), "the ports trigger does not show the number from triggerContent");
  assert.ok(/\{counts && <span className="hidden tabular-nums md:inline">\{counts\}<\/span>\}/.test(perf), "the performance trigger does not show the CPU/RAM counts from triggerContent");
  assert.ok(/\btriggerTone\(\s*portsOpen\s*,\s*muted\s*\)/.test(ports), "the muted tone of the ports trigger does not depend on triggerContent(…).muted");
  // The tooltips — per entry only what its menu shows; the module builds the rows.
  assert.ok(/const \{ row1, performanceRow, ports, performance \} = tooltipRows\(\{ count: n, scopeName, stage, forwarded: forwards\.length \}, t\);/.test(pill),
    "the tooltips do not come from tooltipRows({ count: n, scopeName, stage, forwarded }, t)");
  assert.ok(/\btitle=\{ports\}/.test(ports) && /\baria-label=\{row1\}/.test(ports), "the ports trigger does not carry title/aria-label from tooltipRows");
  assert.ok(/\btitle=\{performance\}/.test(perf) && /\baria-label=\{performanceRow\}/.test(perf), "the performance trigger does not carry title/aria-label from tooltipRows");
  assert.ok(!/\bt\("Machine: /.test(pill) && !/\.join\(\s*"\\n"\s*\)/.test(pill), "the file builds tooltip rows itself — the reason for the color would live in two places");
});

// ── (1) The TopNav renders the pills, no page ────────────────────────────────────────────────

test("TopNav: ring · services · browser · VS Code │ runs — in this order, and not hidden below md", () => {
  const nav = read("src/components/TopNav.tsx");
  const pos = (s) => {
    const i = nav.indexOf(s);
    assert.ok(i >= 0, `TopNav.tsx does not render ${s}`);
    assert.equal(nav.indexOf(s, i + 1), -1, `TopNav.tsx renders ${s} twice`);
    return i;
  };
  const rings = nav.lastIndexOf("<UsageRing");
  assert.ok(rings >= 0, "anchor: no <UsageRing in TopNav.tsx");
  const queue = [["rings", rings], ["Services", pos("<ServicesPill />")], ["Browser", pos("<AgentBrowsersPill />")],
    ["VS Code", pos("<VsCodePill />")], ["runs", pos("<ActiveRunsPill />")]];
  for (let i = 1; i < queue.length; i++) {
    assert.ok(queue[i - 1][1] < queue[i][1], `${queue[i - 1][0]} does not come before ${queue[i][0]}`);
  }
  assert.ok(!/id="cbase-topnav-end"/.test(nav), "the old slot cbase-topnav-end is back in the header");
  // The wrapper of the three pills: the line with the opening <span directly before <ServicesPill />.
  const before = nav.slice(0, queue[1][1]).split("\n").reverse().find((z) => /<span\b/.test(z)) || "";
  assert.ok(/style=\{noDrag\}/.test(before), "the pill group is not excluded from the window drag region");
  assert.ok(!/\bhidden\b/.test(before.replace(/empty:hidden/g, "")), `the pill group is hidden again: ${before.trim()}`);
  // Below md only the CPU/RAM numbers fall away.
  const pill = read("src/components/pills/ServicesPill.tsx");
  assert.ok(/counts && <span className="hidden tabular-nums md:inline">/.test(pill), "the CPU/RAM counts of the pill are not hidden below md");
});

test("No page code imports a pill — only the TopNav", () => {
  const pages = ALL.filter((p) => rel(p).startsWith("src/app/"));
  const violations = [];
  for (const p of pages) {
    const text = fs.readFileSync(p, "utf8");
    if (/from\s*["'](?:@\/components\/pills\/|(?:\.\.\/)+components\/pills\/)/.test(text)) violations.push(rel(p));
  }
  const user = ALL.filter((p) => /from\s*"@\/components\/pills\/(?:ServicesPill|AgentBrowsersPill|VsCodePill)"/.test(fs.readFileSync(p, "utf8"))).map(rel);
  console.log(`  [Pills] ${pages.length} page files checked; importers of the three state pills: ${user.join(", ")}`);
  assert.deepEqual(violations, [], "a page imports a pill — it would then stand only there (or twice)");
  assert.deepEqual(user, ["src/components/TopNav.tsx"], "the state pills are included outside the TopNav");
});

// ── (3) Two places for the same list: one is deleted ─────────────────────────────────────────

test("The ports and resources pills are gone — their list lives in the services pill", () => {
  for (const old of ["PortsPill.tsx", "ResourcesPill.tsx"]) {
    assert.ok(!fs.existsSync(path.join(src, "components", "pills", old)), `components/pills/${old} exists again`);
  }
  const mentioned = ALL.filter((p) => /\b(?:PortsPill|ResourcesPill)\b/.test(withoutComments(fs.readFileSync(p, "utf8")))).map(rel);
  assert.deepEqual(mentioned, [], "code still refers to PortsPill/ResourcesPill");
});

test("Ports · Performance: identifiers, rules from the module, click catcher without fixed inset-0", () => {
  const pill = read("src/components/pills/ServicesPill.tsx");
  for (const k of ["data-status-ports\n", "data-status-performance\n", "data-services-count={n}", "data-services-stage=", "data-status-ports-menu", "data-status-performance-menu",
    "data-status-ports-pop", "data-status-performance-pop", "data-services-measured=", 'data-ports-source="browser"']) {
    assert.ok(pill.includes(k), `ServicesPill.tsx does not carry the identifier ${k.trim()} (the test benches grab it)`);
  }
  assert.ok(/data-services-stage=\{stage \? stage\.stage : "no"\}/.test(pill), "data-services-stage does not know the state \"no\" (no machine value)");
  // The click catcher asks for the OPEN entry with its menu — both markers as a literal, checked via closest.
  assert.ok(/const pop = open === "ports" \? "\[data-status-ports-pop\]" : "\[data-status-performance-pop\]";/.test(pill)
    && /closest\?\.\(pop\)/.test(pill), "the click catcher does not ask closest(\"[data-status-ports-pop]\" or \"[data-status-performance-pop]\")");
  for (const d of ["src/components/pills/ServicesPill.tsx", "src/components/pills/AgentBrowsersPill.tsx"]) {
    assert.ok(!/fixed inset-0/.test(withoutComments(read(d))), `${d}: click catcher as fixed inset-0 (house rule: document mousedown)`);
  }
  assert.ok(/const MENU = "cb-pop /.test(pill) && (pill.match(/className=\{MENU\}/g) || []).length === 2, "the two menus are not the same cb-pop surface (MENU)");
  assert.ok(!/animate-pulse/.test(withoutComments(pill)), "the dot pulses — measured 27 % CPU for 8 px");
  const imp = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/services-status"/.exec(pill);
  assert.ok(imp, "ServicesPill.tsx does not import the rules from @/lib/services-status");
  for (const f of ["machineLevel", "servicesSum", "measured", "performanceTone", "measureRow"]) {
    assert.ok(new RegExp(String.raw`\b${f}\b`).test(imp[1]), `ServicesPill.tsx does not compute ${f} via the module — a copy here would bypass the iOS binding`);
  }
  // The resources section also stands WITHOUT a sum as soon as measureRow has something to say — it used to hang on the
  // sum alone, and without any measurement the menu stayed silent. measureRow is told "did the resources request answer?".
  const mz = /const (\w+) = measureRow\(\s*\w+\s*,\s*resources !== null\s*\)/.exec(pill);
  assert.ok(mz, "ServicesPill.tsx does not call measureRow(…, resources !== null) — \"measured: 0 of n\" has no way, or the row would stand before the first answer");
  // `resourcesSection` (module) decides — with the number of running services, the sum AND measureRow; what the
  // function makes of it is recomputed by (f5).
  assert.ok(/\bresourcesSection\b/.test(imp[1]), "ServicesPill.tsx does not take resourcesSection from the module");
  assert.ok(new RegExp(String.raw`\{resourcesSection\(n, sum, ${mz[1]}\) && \(`).test(pill), "the resources section does not depend on resourcesSection(n, sum, measureRow) — without the count it would stand between two ticks under \"No services running.\", without measureRow the menu would stay silent");
  const measuredRow = pill.indexOf('t("measured: {x} of {n} services"');
  assert.ok(measuredRow > 0 && new RegExp(String.raw`\{${mz[1]} && \(`).test(pill.slice(Math.max(0, measuredRow - 400), measuredRow)),
    "the row \"measured: x of n\" is not under the condition from measureRow");
  // The folder size (`du` over every project folder) only with the PERFORMANCE menu open: otherwise the header asks with
  // disk=0 — it is on EVERY page, `du` would run every minute otherwise.
  assert.ok(/\.\.\.\(perfOpen \? \{\} : \{ disk: "0" \}\)/.test(pill), "the header asks the resources WITH folder size (du) also while the performance menu is closed — disk=0 is missing");
  // `reload`: after an accepted cleanup the pill asks the resources again at once — another trigger.
  assert.ok(/\}, \[ws, pid, gateway, perfOpen, reload\]\);/.test(pill), "the resources request does not run again on opening the performance menu (or after a cleanup) — the project files would stay \"—\"");
  assert.ok(/useEffect\(\(\) => \{ setResources\(null\); \}, \[ws, pid\]\);/.test(pill), "clearing the resources does not depend (only) on the scope — on opening, the numbers at the trigger would vanish");
  const browser = read("src/components/pills/AgentBrowsersPill.tsx");
  assert.ok(/useActiveScope\(\)/.test(browser), "AgentBrowsersPill does not read the workspace from the active scope");
  assert.ok(!/\{\s*workspaceId\s*\}\s*:\s*\{\s*workspaceId:\s*string\s*\}/.test(browser), "AgentBrowsersPill takes the workspace as a prop again");
});

// ── Ports · Performance separated ───────────────────────────────────────────────────────────
//
// Requirement: no blue pill, and no scrolling down to see the performance metrics — click ports, see the
// applications/port; click performance, see the metrics; no longer 2 in 1. Four promises, each held where it would
// break silently:
//  (1) two triggers, one <button> each with its own identifier, in the order Ports · Performance — and the old pill
//      (`data-services-pill`) is gone;
//  (2) two menus, each exactly once and only under ITS open marker — and both markers from ONE state (`open`): with
//      two booleans two menus could stand on top of each other;
//  (3) no pill ground at the trigger: no accent (neither ground nor text nor edge), no edge, no ring, no shadow, no
//      surface except the quiet `bg-hover` (hover/open) — the form of the usage displays next to it;
//  (4) the performance part (machine, resources, bars, "measured") is not in the ports menu, and the ports part
//      (services, forwardings, apps jump) not in the performance menu.
// Counter-tests: see the head of this file.
test("Ports · Performance separated: two triggers, two menus from ONE state, no pill ground, no part in the wrong menu", () => {
  const PATH = "src/components/pills/ServicesPill.tsx";
  const pill = withoutComments(read(PATH));
  // (1)
  const identifiers = [...pill.matchAll(/\sdata-status-(ports|performance)\s/g)].map((m) => m[1]);
  assert.deepEqual(identifiers, ["ports", "performance"], `two triggers in the order Ports · Performance expected — found: ${identifiers.join(", ") || "none"}`);
  assert.ok(!/data-services-pill/.test(pill), "the old pill (data-services-pill) is back");
  const ports = triggerOf(pill, "data-status-ports", PATH);
  const perf = triggerOf(pill, "data-status-performance", PATH);
  // (2)
  const state = pill.match(/const \[(\w+), \w+\] = useState<"ports" \| "performance" \| null>\(null\);/);
  assert.ok(state, "the two menus do not hang on ONE state useState<\"ports\" | \"performance\" | null>(null)");
  const open = state[1];
  const attribute = (what) => (pill.match(new RegExp(String.raw`const (\w+) = ${open} === "${what}";`)) || [])[1];
  const attributes = { ports: attribute("ports"), performance: attribute("performance") };
  assert.ok(attributes.ports && attributes.performance, `the open markers do not come from ${open} === "ports" / "performance"`);
  for (const [what, m] of Object.entries(attributes)) {
    const hits = [...pill.matchAll(new RegExp(String.raw`\{\s*(\w+)\s*&&\s*\(\s*<div\b[^>]*?\bdata-status-${what}-menu\b`, "g"))];
    assert.equal(hits.length, 1, `the ${what} menu stands ${hits.length} times under a condition (exactly once expected)`);
    assert.equal(hits[0][1], m, `the ${what} menu stands under "${hits[0][1]}", not under its marker ${m}`);
  }
  const second = [...pill.matchAll(/const \[(\w+), \w+\] = useState(?:<boolean>)?\(\s*(?:false|true)\s*\)/g)].map((m) => m[1]).filter((n) => /open/i.test(n));
  assert.deepEqual(second, [], `a second open state next to ${open}: ${second.join(", ")} — both menus could then be open at once`);
  // (3)
  const form = (pill.match(/const TRIGGER = "([^"]*)";/) || [])[1];
  const tone = (pill.match(/const triggerTone = \([^)]*\) =>\s*([^;]*);/) || [])[1];
  assert.ok(form && tone, "anchor: `const TRIGGER = \"…\";` or `const triggerTone = (…) => …;` not found — update");
  for (const [name, a] of [["Ports", ports], ["Performance", perf]]) {
    assert.ok(/className=\{`\$\{TRIGGER\} \$\{triggerTone\(/.test(a), `the ${name} trigger does not take its form from TRIGGER/triggerTone`);
  }
  const forbidden = [...new Set([form, tone, ports, perf].join(" ")
    .match(/(?<![\w-])(?:[\w-]+:)*(?:bg-(?!hover\b)[\w/[\]-]+|border(?:-[\w/-]+)?|ring(?:-[\w/-]+)?|shadow(?:-[\w/-]+)?|[\w-]*accent[\w/-]*)/g) || [])];
  assert.deepEqual(forbidden, [], `a pill ground is back at the trigger (${forbidden.join(", ")}) — only the quiet surface bg-hover on hover/open is allowed`);
  // (4)
  const portsStart = pill.search(/\sdata-status-ports-menu\s/);
  const portsMenu = pill.slice(portsStart, pill.search(/\sdata-status-performance-pop\b/));
  const perfMenu = pill.slice(pill.search(/\sdata-status-performance-menu\s/));
  assert.ok(portsStart > 0 && portsMenu.length > 200 && perfMenu.length > 200,
    "anchor: the two menus cannot be found (the ports menu stands before the performance entry) — update");
  const PERF_PARTS = [/\bdata-host\b/, /\bramShare\(/, /\bloadShare\(/, /\bswapShare\(/, /\bdiskShare\(/, /<ProgressBar\b/, /\bt\("Resources"\)/,
    /\bresourcesSection\(/, /\bramCapacity\(/, /\bdiskBytes\b/, /\bdata-services-measured\b/, /\{counts\b/, /\bt\("This machine"\)/];
  const PORTS_PARTS = [/\bt\("Running services"\)/, /\bt\("Forwarded"\)/, /\bt\("Not registered"\)/, /\bdoForward\(/, /\bfwdRow\b/, /\bbridge\(\)/,
    /\bdata-ports-source\b/, /\bappsProjectHref\(/, /\bt\("All services → Apps"\)/, /\bservices\.map\(/];
  const inPorts = PERF_PARTS.filter((re) => re.test(portsMenu)).map(String);
  const inPerf = PORTS_PARTS.filter((re) => re.test(perfMenu)).map(String);
  console.log(`  [Ports · Performance] triggers ${identifiers.join(" · ")}; menus ${portsMenu.length} / ${perfMenu.length} characters; foreign parts: ${inPorts.length} in the ports, ${inPerf.length} in the performance menu`);
  assert.deepEqual(inPorts, [], "a part of the performance is in the ports menu — no longer 2 in 1");
  assert.deepEqual(inPerf, [], "a part of the ports is in the performance menu — no longer 2 in 1");
  // And each menu carries what it is for (otherwise (4) would also be green with two empty menus).
  for (const re of [/\bt\("Running services"\)/, /\bservices\.map\(/, /\bfwdRow\b/, /\bt\("Not registered"\)/]) assert.ok(re.test(portsMenu), `the ports menu does not carry ${re}`);
  for (const re of [/\bdata-host\b/, /\bramShare\(/, /\bt\("Resources"\)/, /\bdata-services-measured\b/]) assert.ok(re.test(perfMenu), `the performance menu does not carry ${re}`);
});

// ── Translations ─────────────────────────────────────────────────────────────────────────────

test("translations: every t(\"…\") of the new and changed files has exactly one line in i18n-de.ts", () => {
  const en = read("src/lib/i18n-de.ts");
  // services-status.ts: the tooltip rows live in the module.
  const files = ["src/components/pills/ServicesPill.tsx", "src/components/pills/AgentBrowsersPill.tsx", "src/lib/active-scope.ts", "src/lib/services-status.ts"];
  const missing = [];
  const notLiteral = [];
  let n = 0;
  for (const d of files) {
    const text = read(d);
    for (const m of text.matchAll(/\bt\(([^)]?)/g)) {
      if (m[1] !== '"') notLiteral.push(`${d}: t(${m[1]}…`);
    }
    for (const m of text.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) {
      n++;
      const k = m[1];
      const rows = en.split("\n").filter((z) => z.trimStart().startsWith(`"${k}":`));
      if (rows.length !== 1) missing.push(`${d}: "${k}" (${rows.length} lines)`);
    }
  }
  console.log(`  [i18n] ${n} t("…") calls in ${files.length} files`);
  assert.ok(n >= 20, `only ${n} t("…") found — does the regex still work?`);
  assert.deepEqual(notLiteral, [], "a t(…) with a non-literal key — nobody can hold that against i18n-de.ts");
  assert.deepEqual(missing, [], "keys without (or with a duplicate) German line — the German UI would show English, a duplicate breaks the build (TS1117)");
});

// ── Web <-> iOS: the same rules in two languages ─────────────────────────────────────────────
//
// The rules of the pill exist TWICE: `web/src/lib/services-status.ts` (recomputed in the gate with tsc,
// services-status.test.mjs) and `enum ServicesRules` in `mobile/CbaseMobile/Shell/ServicesStatus.swift` (executed
// NOWHERE in the gate — the XCUITest only runs on the Mac). Deleting one is impossible, a client cannot import the
// other; so they are bound. If they diverged, the same machine would show yellow in the browser and green on the
// iPhone — and neither client would have an error of its own.
//
// Bound by TEXT, without `xcrun swift`, so that the binding also runs on the Linux runner:
//  (a) thresholds: both numbers AND the comparison (strictly greater) on both sides — plus the bars of the web pill:
//      they color via `stageFrom` from the module and carry NO threshold of their own (no decimal literal, no
//      MACHINE_* in a comparison), the color classes bg-warn/bg-danger only in tables per stage, and ONE bar.
//  (b) inputs of the stage: per side the share formulas are taken from the source — both sides call a function per
//      input (`ramShare(host)` …) whose body is read —, local names are resolved and brought to one spelling; the test
//      then RECOMPUTES both formulas on 66 machines (available > total, load above the cores, free and full disk) and
//      compares the numbers. It switches the swap between empty and full: if a share changes, the swap came in (it
//      must not). Plus the order of the inputs (it decides ties) and the choice of the HIGHEST. And the machine block
//      in the menu of the web pill calls the SAME three functions and reads no raw machine value (`availableBytes`,
//      `freeBytes`, `load1` …) it could compute from itself.
//  (c) "measured": which resource row counts, what the sum runs over, what it is without a row, to how many places
//      the CPU is rounded, when a service counts as measured — and that the caller passes the RUNNING services
//      (otherwise "of n" would mean something else).
//  (d) the identifiers by which the test benches grab the pill — each WITH its reader — and that the old status row
//      of the iOS drawer (`ScopeStatusRow`) is gone.
//  (e) the color of the performance entry: warn/danger of the machine only, otherwise neutral, also with 0 services.
//  (f) six more tests:
//      (f1) "measured: x of n" only after the resources answered (empty is not unknown): `measureRow` is recomputed
//           on both sides on a grid (iOS: the Swift body, `guard` translated), and the loaded flag passed in is the
//           same on both sides — initially not loaded, true ONLY in the success branch of /api/project-resources
//           behind the guard against stale answers (web `if (!alive) return`, iOS `guard … == run`), reset on scope
//           switch; the row stands under measureRow, the section under resourcesSection, and nobody reads the raw
//           measurement past measureRow.
//      (f2) cost: the query of the resources request is EVALUATED per side for "menu closed" and "menu open" (web:
//           the URLSearchParams expression; iOS: the `if`s containing `disk`) — closed with disk=0, open without;
//           the flag is the visible menu (web: it renders `data-status-performance-menu`; iOS: `menu(open:)`,
//           reported by onAppear/onDisappear of the popover), and opening asks at once. Deliberately NOT bound: when
//           disk=0 is asked again after CLOSING (web at once, iOS on the next tick).
//      (f3) machine source in gateway operation: only /gw/host, a failure keeps the last value, the name is
//           "Server" — and the premise that iOS knows ONLY gateway operation (the only `APIClient(` is built in
//           SessionStore.connect, assigned behind `guard info.gateway`). If it fell, iOS would need the rule
//           WITHOUT gateway, and nobody binds that here.
//      (f4) the counting rule (`containers > 0`) exists on iOS only in ServicesRules — nothing in the model, in the
//           button only for the text — and both components list their resource rows from `sum.projects`.
//      (f5) two ticks in the menu: the resources section stands only with RUNNING services (`resourcesSection` /
//           `ServicesRules.resourcesSection`, recomputed on a grid of both sides), with the same count as the trigger.
//      (f6) the machine (`/gw/host`) waits for no other request — not in the round (web: own effect; iOS: own
//           function, started by `async let` BEFORE the resources) and not on return from the background.
// Every message says WHICH side HAS WHAT ("Web … · iOS …"), not just "unequal".
//
// The text anchors (declaration names, `candidates.push({ kind: …, share: … })`, `let inlets`, the `{ continue }`
// choice) are intentional. If one hits nothing, the test THROWS with "update the anchor" — an empty list would equal
// every other empty list and have measured nothing.
//
// Counter-test map (each sabotage on ONE side; the failing message names the deviating side):
//  (a) a changed iOS threshold, the web comparison `>=`, the web RAM bar at another literal, the old literal bar
//      with the RIGHT numbers back, a bar via `MACHINE_*` instead of `stageFrom` ⇒ (a);
//  (b) iOS load from `load5`, web RAM as FREE instead of used, iOS RAM with a swap share, web reading `host.swap`
//      outside the formulas, inputs in another order, the choice of the highest with `<`, BOTH sides from `load5`,
//      the machine block computing load itself, `machineLevel` computing RAM inline, a swap branch in `ramShare`
//      ⇒ (b);
//  (c) iOS without the container condition, web `containers >= 0`, iOS sum with zeros instead of `nil`, iOS passing
//      all instead of the running services ⇒ (c);
//  (d) a renamed iOS identifier, the reader query of coding-glass no longer grabbing the marker, a revived empty
//      `ScopeStatusRow.swift` ⇒ (d);
//  (e) iOS `case .warn: return n > 0 ? .orange : …` ⇒ (e);
//  (f1) iOS `measureRow` without the loaded flag (the old bug), the same on web, `loaded: true` in the model or in
//      the pill, the flag set BEFORE the request, moved before the run guard, web `if (!alive) return` removed, iOS
//      without reset on scope switch, web reset only on `[ws]`, the section hanging on the sum alone, the row from
//      the raw measurement ⇒ (f1);
//  (f2) iOS `disk=0` without `if`, web `disk: "0"` without ternary, no `.onDisappear`, `disk` on the loaded flag
//      instead of the menu, no tick in `menu(open:)`, `open` removed from the deps of the web effect ⇒ (f2);
//  (f3) iOS `calculator = answer.host` in the resources branch, `else { calculator = nil }`, a changed name, web
//      `!gateway &&` removed, `if (alive) setHost(h)`, `guard info.gateway` removed from SessionStore.connect
//      ⇒ (f3);
//  (f4) a `.filter { $0.containers > 0 }` over the rows, `row.containers != 0` in the button, a counter over
//      `.containers` in the model, web `.filter((r) => r.containers > 0)` before the `.map` ⇒ (f4);
//  (f5) the module without the count (`sum || measurement`), the same only in Swift, BOTH without, the pill or the
//      button hanging on `sum || measurement` again, the button counting stopped services too ⇒ (f5)/(f1);
//  scope per tab: the runs pill with `localStorage.getItem("cbase-ws")` again, `sameWs` fixed true ⇒ "scope per
//      tab"; scope (apps): `replaceState(window.history.state, …)` back ⇒ "writes the address past the Next router"
//      (measured in a real Chrome: with the old call `?project=` was back in the address after the router tick on
//      all three ways; with `null` it never was);
//  `useDisplayedWorkspace` removed from a page, wired with the wrong state, the hook without the list check, the
//      guard on Coding removed ⇒ "displayed workspace".

const repo = path.resolve(webDir, "..");
const RULES_WEB = "web/src/lib/services-status.ts";
const RULES_IOS = "mobile/CbaseMobile/Shell/ServicesStatus.swift";
const PILL_WEB = "web/src/components/pills/ServicesPill.tsx";
const BUTTON_IOS = "mobile/CbaseMobile/Shell/ServicesButton.swift";
const readRepo = (r) => fs.readFileSync(path.join(repo, r), "utf8");

// Text INSIDE the bracket the anchor ends with (the last opening bracket in the match). Brackets are counted, strings
// and comments skipped — the same mechanics as `bracketBlock` in list-binding.test.mjs (a test module imports no
// other, hence the copy).
function inBracket(source, anchor, location, what) {
  const m = source.match(anchor);
  assert.ok(m, `${what} not found in ${location} — renamed or reformatted? Update the anchor here, do NOT delete the test.`);
  const i = m.index + Math.max(m[0].lastIndexOf("{"), m[0].lastIndexOf("["), m[0].lastIndexOf("("));
  const on = source[i];
  const closer = { "{": "}", "[": "]", "(": ")" }[on];
  let depth = 0;
  let str = null;
  for (let j = i; j < source.length; j++) {
    const c = source[j];
    if (str) {
      if (c === "\\") j++;
      else if (c === str) str = null;
      continue;
    }
    if (c === "/" && source[j + 1] === "/") { j = source.indexOf("\n", j); if (j < 0) break; continue; }
    if (c === "/" && source[j + 1] === "*") { j = source.indexOf("*/", j) + 1; if (j < 1) break; continue; }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if (c === on) depth++;
    else if (c === closer && !--depth) return source.slice(i + 1, j);
  }
  assert.fail(`${what} in ${location}: the bracket does not close — check the anchor`);
}
// Body of a function. TS: the opening brace is the last one of the head line(s) — the return type may itself be
// `{ … }` (servicesSum, measured). Swift: `static func name(…) -> T {`.
const tsBody = (source, name, location) =>
  inBracket(source, new RegExp(String.raw`export function ${name}(?:<[^>(]*>)?\([\s\S]*?\{(?=[ \t]*\n)`), location, `function ${name}`);
const swiftBody = (source, name, location) =>
  inBracket(source, new RegExp(String.raw`static func ${name}\([^)]*\)[^{\n]*\{`), location, `static func ${name}`);

// An expression from position i to the next top-level separator (comma, semicolon or, in Swift, line end) or to the
// closing bracket it stands in.
function expressionFrom(text, i, separator) {
  let depth = 0;
  let str = null;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (str) { if (c === "\\") j++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (!depth) return text.slice(i, j).trim(); depth--; }
    else if (!depth && separator.includes(c)) return text.slice(i, j).trim();
  }
  return text.slice(i).trim();
}
// Split at top-level commas.
function parts(text) {
  const out = [];
  let depth = 0;
  let str = null;
  let start = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (str) { if (c === "\\") j++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && !depth) { out.push(text.slice(start, j).trim()); start = j + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}
const matchingBracket = (text, on) => {
  for (let j = on, depth = 0; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && !--depth) return j;
  }
  return -1;
};
const simple = (w) => /^[\w$.]+$/.test(w) || (/^[\w$.]+\(/.test(w) && matchingBracket(w, w.indexOf("(")) === w.length - 1);

// Replace local names by their value until nothing is left to replace. A compound value goes in parentheses
// (the precedence would otherwise be lost).
function resolve(expression, aliases) {
  let a = expression;
  for (let round = 0; round < 12; round++) {
    let fresh = a;
    for (const [name, value] of Object.entries(aliases)) {
      fresh = fresh.replace(new RegExp(String.raw`(?<![\w$.])${name}(?![\w$])`, "g"), () => (simple(value) ? value : `(${value})`));
    }
    if (fresh === a) return a;
    a = fresh;
  }
  assert.fail(`resolving the local names goes in circles: ${expression}`);
}
// One spelling for both languages: without whitespace, without `Math.`, without Swift conversions (`Double(x)` is
// the value itself in JS), without the `host.` in front.
function canonical(a) {
  let k = a.replace(/\s+/g, "").replace(/\bMath\./g, "");
  for (let i; (i = k.search(/\b(?:Double|Float|CGFloat)\(/)) >= 0; ) {
    const on = k.indexOf("(", i);
    const closer = matchingBracket(k, on);
    assert.ok(closer > on, `conversion without closing bracket: ${a}`);
    const inside = k.slice(on + 1, closer);
    k = k.slice(0, i) + (simple(inside) ? inside : `(${inside})`) + k.slice(closer + 1);
  }
  return k.replace(/(?<![\w$.])host\./g, "");
}

// The web side: `machineLevel` read top to bottom — `const x = …` remembers a name (the same name may be assigned
// again later), `candidates.push({ kind, share })` is an input, resolved with the names valid at THIS spot. If the
// resolved share is a call `name(host)` (`ramShare(host)` …), the body of THAT function is read, as on the iOS side:
// `const` remembers names, the one `return` other than `return null` is the formula.
function webFunction(source, name) {
  const f = tsBody(source, name, RULES_WEB);
  const back = [...f.matchAll(/\breturn\s+/g)].map((m) => expressionFrom(f, m.index + m[0].length, ";")).filter((r) => r !== "null");
  assert.equal(back.length, 1, `${RULES_WEB}: ${name} has ${back.length} returns other than \`return null\` — the formula is not unambiguous, update the anchor`);
  const names = {};
  for (const m of f.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) names[m[1]] = expressionFrom(f, m.index + m[0].length, ";");
  return { body: f, formula: back[0], names };
}
function webStage() {
  const source = withoutComments(readRepo(RULES_WEB));
  const body = tsBody(source, "machineLevel", RULES_WEB);
  const events = [];
  for (const m of body.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    events.push({ i: m.index, alias: m[1], value: expressionFrom(body, m.index + m[0].length, ";") });
  }
  for (const m of body.matchAll(/\bcandidates\.push\(\s*\{\s*kind:\s*"(\w+)"\s*,\s*share:\s*/g)) {
    events.push({ i: m.index, inlet: m[1], value: expressionFrom(body, m.index + m[0].length, ",;") });
  }
  events.sort((x, y) => x.i - y.i);
  const aliases = {};
  const kinds = [];
  const formulas = {};
  const calledBodies = [];
  for (const e of events) {
    if (e.alias) { aliases[e.alias] = e.value; continue; }
    kinds.push(e.inlet);
    const resolved = resolve(e.value, aliases);
    const fn = resolved.match(/^(\w+)\(\s*host\s*\)$/);
    if (fn) {
      const f = webFunction(source, fn[1]);
      calledBodies.push(f.body);
      formulas[e.inlet] = { raw: `${fn[1]}: ${f.formula}`, canon: canonical(resolve(f.formula, f.names)), call: fn[1] };
    } else {
      formulas[e.inlet] = { raw: e.value, canon: canonical(resolved), call: null };
    }
  }
  assert.ok(kinds.length, `${RULES_WEB}: machineLevel has not a single \`candidates.push({ kind: …, share: … })\` — update the anchor`);
  const choice = body.match(/if\s*\(\s*(\w+)\.share\s*(>=?|<=?)\s*(\w+)\.share\s*\)\s*\3\s*=\s*\1\b/);
  assert.ok(choice, `${RULES_WEB}: the choice of the highest in machineLevel (\`if (k.share > best.share) best = k\`) can no longer be found — update the anchor`);
  const declared = source.match(/export const STAGES_INLETS[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(declared, `${RULES_WEB}: STAGES_INLETS not found — update the anchor`);
  return {
    kinds,
    formulas,
    // "new displaces the best so far if new OP best so far".
    displaced: choice[2],
    verdictOver: /\bstage:\s*stageFrom\(/.test(body) ? "stageFrom" : "own computation",
    declared: [...declared[1].matchAll(/"(\w+)"/g)].map((m) => m[1]),
    // machineLevel AND the share functions it calls (swapShare stands next to them, only for the display).
    swapInBody: [body, ...calledBodies].some((r) => /\bswap\b/i.test(r)),
  };
}

// The iOS side: `let inlets = [(.kind, share, …), …]` in `machineLevel`; a share is one of the functions
// `ramShare(host)` … — its body is read (`let`/`guard let` remember names, the one `return` other than `return nil`
// is the formula). If the share stands inline, the names from machineLevel apply.
function swiftNames(body) {
  const aliases = {};
  for (const m of body.matchAll(/\blet\s+([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*/g)) {
    const value = expressionFrom(body, m.index + m[0].length, ",\n");
    if (!value.startsWith("[")) aliases[m[1]] = value;
  }
  return aliases;
}
function iosStage() {
  const source = withoutComments(readRepo(RULES_IOS));
  const rules = inBracket(source, /\benum ServicesRules\s*\{/, RULES_IOS, "enum ServicesRules");
  const body = swiftBody(rules, "machineLevel", RULES_IOS);
  const list = inBracket(body, /\blet inlets[^=]*=\s*\[/, RULES_IOS, "let inlets = [ … ] in machineLevel");
  const kinds = [];
  const formulas = {};
  for (const tuple of parts(list)) {
    assert.ok(tuple.startsWith("(") && tuple.endsWith(")"), `${RULES_IOS}: entry in inlets is not a tuple: ${tuple} — update the anchor`);
    const [kind, share] = parts(tuple.slice(1, -1));
    assert.ok(/^\.\w+$/.test(kind || "") && share, `${RULES_IOS}: entry in inlets does not have the form (.kind, share, …): ${tuple}`);
    const name = kind.slice(1);
    kinds.push(name);
    const fn = share.match(/^(\w+)\(\s*host\s*\)$/);
    if (fn) {
      const f = swiftBody(rules, fn[1], RULES_IOS);
      const back = [...f.matchAll(/\breturn\s+/g)].map((m) => expressionFrom(f, m.index + m[0].length, "\n")).filter((r) => r !== "nil");
      assert.equal(back.length, 1, `${RULES_IOS}: ${fn[1]} has ${back.length} returns other than \`return nil\` — the formula is not unambiguous, update the anchor`);
      formulas[name] = { raw: `${fn[1]}: ${back[0]}`, canon: canonical(resolve(back[0], swiftNames(f))) };
    } else {
      formulas[name] = { raw: share, canon: canonical(resolve(share, swiftNames(body))) };
    }
  }
  assert.ok(kinds.length, `${RULES_IOS}: inlets in machineLevel is empty — update the anchor`);
  // `if let best = bestSoFar, share <= best.share { continue }` means: displaces if NOT (new <= best so far).
  const choice = body.match(/,\s*(\w+)\s*(>=?|<=?)\s*(\w+)\.share\s*\{\s*continue\s*\}/);
  assert.ok(choice, `${RULES_IOS}: the choice of the highest in machineLevel (\`…, share <= best.share { continue }\`) can no longer be found — update the anchor`);
  return {
    kinds,
    formulas,
    displaced: { "<=": ">", "<": ">=", ">=": "<", ">": "<=" }[choice[2]],
    verdictOver: /MachineVerdict\(\s*stage:\s*stage\(/.test(body) ? "stage" : "own computation",
    cases: [...(inBracket(rules, /\benum Kind\b[^{]*\{/, RULES_IOS, "enum Kind").matchAll(/\bcase\s+([^\n]+)/g))].flatMap((m) => m[1].split(",").map((s) => s.trim())),
    swapInBody: /\bswap\b/i.test(rules),
  };
}

// Web against iOS, field by field — and the message says which side has which value.
function equal(what, web, ios, [webSource, iosSource] = [RULES_WEB, RULES_IOS]) {
  const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v));
  const deviations = Object.keys({ ...web, ...ios }).filter((k) => fmt(web[k]) !== fmt(ios[k]));
  assert.deepEqual(deviations, [], `${what}: Web (${webSource}) and iOS (${iosSource}) say different things —\n` +
    deviations.map((k) => `  ${k}: Web "${fmt(web[k])}" · iOS "${fmt(ios[k])}"`).join("\n"));
}

// 66 machines: 64 from a fixed pseudo-random sequence (the same on every run) and two edges.
function machineProbes() {
  let s = 20260922;
  const random = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const GB = 2 ** 30;
  const probes = [];
  for (let i = 0; i < 64; i++) {
    const total = (1 + random() * 63) * GB;
    const count = 1 + Math.floor(random() * 32);
    const disk = (10 + random() * 1990) * GB;
    probes.push({
      at: i,
      cpu: { count, load1: random() * 2.5 * count, load5: random() * count, load15: random() * count },
      mem: { totalBytes: total, availableBytes: random() * 1.2 * total }, // also available > total
      disk: { path: "/", totalBytes: disk, freeBytes: random() * 1.1 * disk }, // also free > total
    });
  }
  probes.push({ at: 64, cpu: { count: 4, load1: 0, load5: 0, load15: 0 }, mem: { totalBytes: 16 * GB, availableBytes: 16 * GB }, disk: { totalBytes: 100 * GB, freeBytes: 100 * GB } });
  probes.push({ at: 65, cpu: { count: 4, load1: 4, load5: 4, load15: 4 }, mem: { totalBytes: 16 * GB, availableBytes: 0 }, disk: { totalBytes: 100 * GB, freeBytes: 0 } });
  return probes;
}
const SWAP_EMPTY = { totalBytes: 8 * 2 ** 30, freeBytes: 8 * 2 ** 30 };
const SWAP_FULL = { totalBytes: 8 * 2 ** 30, freeBytes: 0 };
function asFunction(page, kind, canon) {
  try { return new Function("max", "min", "abs", "mem", "cpu", "disk", "swap", `"use strict"; return (${canon});`); }
  catch (e) { assert.fail(`${page}: the formula for "${kind}" is no expression after translation (${e.message}): ${canon} — extend the translation here`); }
}
const compute = (fn, h, swap) => {
  try { return fn(Math.max, Math.min, Math.abs, h.mem, h.cpu, h.disk, swap); }
  catch (e) { return `throws: ${e.message}`; }
};

// ── (a) Thresholds ────────────────────────────────────────────────────────────────────────────

test("Web ↔ iOS (a): the color thresholds are the same numbers with the same comparison — also in the bars", () => {
  const webQ = withoutComments(readRepo(RULES_WEB));
  const count = (name) => {
    const m = webQ.match(new RegExp(String.raw`export const ${name}\s*=\s*([\d.]+)\s*;`));
    assert.ok(m, `${RULES_WEB}: \`export const ${name} = …;\` not found — update the anchor`);
    return Number(m[1]);
  };
  const comparison = (body, name, location) => {
    const m = body.match(new RegExp(String.raw`\b\w+\s*(>=?|<=?)\s*${name}\b`));
    assert.ok(m, `${location}: no comparison of a share with ${name} — update the anchor`);
    return m[1];
  };
  const stageFrom = tsBody(webQ, "stageFrom", RULES_WEB);
  const web = {
    warn: count("MACHINE_WARN"), danger: count("MACHINE_DANGER"),
    comparisonWarn: comparison(stageFrom, "MACHINE_WARN", `${RULES_WEB} stageFrom`),
    comparisonDanger: comparison(stageFrom, "MACHINE_DANGER", `${RULES_WEB} stageFrom`),
  };
  const iosQ = withoutComments(readRepo(RULES_IOS));
  const rules = inBracket(iosQ, /\benum ServicesRules\s*\{/, RULES_IOS, "enum ServicesRules");
  const iosCount = (name) => {
    const m = rules.match(new RegExp(String.raw`static let ${name}\s*(?::\s*Double\s*)?=\s*([\d.]+)`));
    assert.ok(m, `${RULES_IOS}: \`static let ${name} = …\` not found in ServicesRules — update the anchor`);
    return Number(m[1]);
  };
  const stage = swiftBody(rules, "stage", RULES_IOS);
  const ios = {
    warn: iosCount("warn"), danger: iosCount("danger"),
    comparisonWarn: comparison(stage, "warn", `${RULES_IOS} ServicesRules.stage`),
    comparisonDanger: comparison(stage, "danger", `${RULES_IOS} ServicesRules.stage`),
  };
  console.log(`  [Web↔iOS thresholds] Web warn ${web.comparisonWarn} ${web.warn}, danger ${web.comparisonDanger} ${web.danger} · iOS warn ${ios.comparisonWarn} ${ios.warn}, danger ${ios.comparisonDanger} ${ios.danger}`);
  equal("color thresholds", web, ios);

  // The components color via the rule, not via numbers of their own. The web pill used to copy the thresholds into
  // two bars as literals (`share > 0.9 ? "bg-danger" : share > 0.7 ? …`); now its ONE bar calls `stageFrom` from the
  // module. This is held three ways so that no copy returns — not even one that happens to carry the right numbers
  // (it would drift apart silently on the next change of the rule):
  //  · no comparison with a decimal literal and none with MACHINE_WARN/MACHINE_DANGER in the pill;
  //  · the color classes "bg-warn"/"bg-danger" only as the value of a table per stage (`warn: "bg-warn"`);
  //  · ONE bar (the wrapper `h-1 overflow-hidden rounded-full bg-edge` exactly once), and it calls stageFrom.
  const pillZ = withoutCommentsLinePreserving(readRepo(PILL_WEB));
  const rowOf = (i) => pillZ.slice(0, i).split("\n").length;
  const own = [];
  for (const m of pillZ.matchAll(/([\w$.\])]+)\s*(>=?|<=?)\s*(\d*\.\d+|MACHINE_WARN|MACHINE_DANGER)\b/g)) {
    own.push(`${PILL_WEB}:${rowOf(m.index)}: \`${m[0]}\``);
  }
  assert.deepEqual(own, [],
    `the web pill carries thresholds of its own — it colors via stageFrom (${RULES_WEB}; rule ${web.comparisonWarn} ${web.warn} / ${web.comparisonDanger} ${web.danger}), not via literals`);
  const colors = [];
  for (const m of pillZ.matchAll(/"bg-(warn|danger)"/g)) {
    const key = /\b(\w+)\s*:\s*$/.exec(pillZ.slice(Math.max(0, m.index - 24), m.index));
    if (!key || key[1] !== m[1]) colors.push(`${PILL_WEB}:${rowOf(m.index)}: "bg-${m[1]}" ${key ? `under the key "${key[1]}"` : "outside a table per stage"}`);
  }
  assert.deepEqual(colors, [], "a color class of the stage stands outside a table `stage: \"bg-stage\"` — there a condition of its own decides the color");
  const wrappers = [...pillZ.matchAll(/\bh-1 overflow-hidden rounded-full bg-edge\b/g)].map((m) => rowOf(m.index));
  assert.equal(wrappers.length, 1, `${PILL_WEB}: ${wrappers.length} bar wrappers (lines ${wrappers.join(", ")}) — there is ONE bar, and all shares go through it`);
  const progressBar = inBracket(pillZ, /function ProgressBar\([^)]*\)[^{\n]*\{/, PILL_WEB, "function ProgressBar");
  assert.ok(/\bstageFrom\(\s*share\s*\)/.test(progressBar), `${PILL_WEB}: the bar does not color via stageFrom(share)`);
  assert.ok(/import\s*\{[^}]*\bstageFrom\b[^}]*\}\s*from\s*"@\/lib\/services-status"/.test(pillZ), `${PILL_WEB}: stageFrom does not come from @/lib/services-status`);

  const button = withoutComments(readRepo(BUTTON_IOS));
  for (const m of button.matchAll(/\b(\w+)\s*(>=?|<=?)\s*(\d*\.\d+)/g)) {
    assert.ok([ios.warn, ios.danger].includes(Number(m[3])),
      `${BUTTON_IOS}: a threshold of its own \`${m[0]}\` — the button colors via ServicesRules.stage, not via literals`);
  }
  console.log(`  [Web↔iOS thresholds] web pill: 0 own thresholds, ${[...pillZ.matchAll(/"bg-(warn|danger)"/g)].length} color classes only in tables per stage, 1 bar (line ${wrappers[0]}) via stageFrom`);
});

// ── (b) Inputs of the stage ───────────────────────────────────────────────────────────────────

test("Web ↔ iOS (b): the stage is the highest of RAM in use, load per core, disk in use — computed the same, without swap", () => {
  const web = webStage();
  const ios = iosStage();
  console.log(`  [Web↔iOS inputs] Web ${web.kinds.join(" · ")} · iOS ${ios.kinds.join(" · ")}`);
  for (const kind of web.kinds) console.log(`    ${kind}: Web ${web.formulas[kind]?.canon} · iOS ${ios.formulas[kind]?.canon ?? "—"}`);

  // Which inputs, in which order (on a tie the earlier one wins).
  assert.deepEqual(ios.kinds, web.kinds,
    `inputs of the stage: Web (${RULES_WEB} machineLevel) has ${web.kinds.join(" · ")}, iOS (${RULES_IOS} inlets) has ${ios.kinds.join(" · ")}`);
  assert.deepEqual(web.kinds, ["ram", "load", "disk"],
    `inputs of the stage: both sides have ${web.kinds.join(" · ")} — the rule is RAM · load · disk, without swap`);
  assert.deepEqual(web.declared, web.kinds,
    `${RULES_WEB}: STAGES_INLETS says ${web.declared.join(" · ")}, machineLevel computes ${web.kinds.join(" · ")} — the list tells something other than what is computed`);
  assert.deepEqual([...ios.cases].sort(), [...ios.kinds].sort(),
    `${RULES_IOS}: enum Kind knows ${ios.cases.join(", ")}, machineLevel computes ${ios.kinds.join(", ")}`);

  // Every formula recomputed on both sides — once against each other with an empty swap, then per side with a full
  // swap against itself: if a share changes, the swap came in.
  const probes = machineProbes();
  for (const kind of web.kinds) {
    const fw = asFunction(`Web (${RULES_WEB})`, kind, web.formulas[kind].canon);
    const fi = asFunction(`iOS (${RULES_IOS})`, kind, ios.formulas[kind].canon);
    for (const h of probes) {
      const w = compute(fw, h, SWAP_EMPTY);
      const i = compute(fi, h, SWAP_EMPTY);
      const same = typeof w === "number" && typeof i === "number" && Math.abs(w - i) <= 1e-9 * Math.max(1, Math.abs(w));
      assert.ok(same,
        `"${kind}" computes differently on the two sides —\n  Web (${RULES_WEB} machineLevel): ${web.formulas[kind].raw}  ⇒  ${web.formulas[kind].canon}\n` +
        `  iOS (${RULES_IOS}): ${ios.formulas[kind].raw}  ⇒  ${ios.formulas[kind].canon}\n` +
        `  machine ${JSON.stringify({ cpu: h.cpu, mem: h.mem, disk: h.disk })}: Web ${w} · iOS ${i}`);
      for (const [page, fn, f] of [["Web", fw, web.formulas[kind]], ["iOS", fi, ios.formulas[kind]]]) {
        const full = compute(fn, h, SWAP_FULL);
        assert.equal(full, compute(fn, h, SWAP_EMPTY),
          `swap: ${page} computes "${kind}" differently with empty and full swap (${f.canon}) — swap does not count`);
      }
    }
  }
  // What the formulas read — the rule in words: RAM in use, load per core, disk in use.
  const reads = { ram: ["mem.availableBytes", "mem.totalBytes"], load: ["cpu.count", "cpu.load1"], disk: ["disk.freeBytes", "disk.totalBytes"] };
  for (const [kind, fields] of Object.entries(reads)) {
    const read = [...new Set(web.formulas[kind].canon.match(/\b(?:mem|cpu|disk|swap)\.\w+/g) || [])].sort();
    assert.deepEqual(read, fields, `"${kind}" reads ${read.join(", ")} — the rule means ${fields.join(", ")}`);
  }
  // ONE computation per input: machineLevel calls the exported share function, and the machine block of the web pill
  // calls the same — the color of the dot and the number/bar next to it come from one source.
  const pillQ = withoutComments(readRepo(PILL_WEB));
  for (const kind of web.kinds) {
    const call = web.formulas[kind].call;
    assert.ok(call, `${RULES_WEB}: machineLevel computes "${kind}" inline (${web.formulas[kind].raw}) — the pill calls the share function of the module per input; two computations drift apart`);
    assert.ok(new RegExp(String.raw`import\s*\{[^}]*\b${call}\b[^}]*\}\s*from\s*"@/lib/services-status"`).test(pillQ) && new RegExp(String.raw`\b${call}\(\s*host\s*\)`).test(pillQ),
      `${PILL_WEB}: the machine block does not call ${call}(host) (from @/lib/services-status) — it computes "${kind}" itself or does not show it`);
  }
  const raw = [...new Set(pillQ.match(/\b(?:availableBytes|freeBytes|load1|load5|load15)\b/g) || [])];
  assert.deepEqual(raw, [], `${PILL_WEB} reads raw machine values (${raw.join(", ")}) — the module computes the shares (ramShare, loadShare, diskShare, swapShare), not the pill`);

  // And outside the formulas: no swap in the body of the rules (e.g. as a condition or a fifth way).
  assert.equal(web.swapInBody, false, `swap: Web (${RULES_WEB} machineLevel) reads the swap, iOS does not — swap does not count`);
  assert.equal(ios.swapInBody, false, `swap: iOS (${RULES_IOS} enum ServicesRules) reads the swap, Web does not — swap does not count`);

  // The verdict: the HIGHEST, and the stage from it with the same threshold function.
  equal("choice of the highest (new displaces the best so far if new … best so far)", { displaced: web.displaced }, { displaced: ios.displaced });
  assert.ok([">", ">="].includes(web.displaced), `both sides choose with "${web.displaced}" — that is not the highest (max of RAM, load, disk)`);
  assert.equal(web.verdictOver, "stageFrom", `${RULES_WEB}: machineLevel does not color via stageFrom — the thresholds from (a) would not apply there`);
  assert.equal(ios.verdictOver, "stage", `${RULES_IOS}: machineLevel does not color via ServicesRules.stage — the thresholds from (a) would not apply there`);
});

// ── (c) "measured" ───────────────────────────────────────────────────────────────────────────

test("Web ↔ iOS (c): 'measured' — a row counts with containers, a service with a container name AND a counting project", () => {
  const condition = (text) => {
    const m = text.match(/\.containers\s*(>=?|<=?|===?|!==?)\s*(\d+)/);
    return m ? `containers ${m[1]} ${m[2]}` : "no condition";
  };
  const places = (m) => (m && m[1] === m[2] ? `${m[1].length - 1} decimal place(s)` : "unknown — update the anchor");

  // Web
  const webQ = withoutComments(readRepo(RULES_WEB));
  const countsDef = webQ.match(/export const counts\s*=\s*\([^)]*\)[^=]*=>\s*([^;]+);/);
  assert.ok(countsDef, `${RULES_WEB}: \`export const counts = (r) => …;\` not found — update the anchor`);
  const counts = condition(countsDef[1]);
  const over = (text) => (/\.filter\(\s*counts\s*\)/.test(text) ? counts : condition(text));
  const sumW = tsBody(webQ, "servicesSum", RULES_WEB);
  const measuredW = tsBody(webQ, "measured", RULES_WEB);
  const setW = measuredW.match(/\bconst\s+(\w+)\s*=\s*new Set\(/);
  assert.ok(setW, `${RULES_WEB}: measured no longer builds a set of the measured projects (\`const x = new Set(…)\`) — update the anchor`);
  const setExprW = inBracket(measuredW, /\bnew Set\(/, RULES_WEB, "new Set( in measured");
  const predW = inBracket(measuredW, /\bservices\.filter\(/, RULES_WEB, "services.filter( in measured");
  const pill = withoutComments(readRepo(PILL_WEB));
  const argW = pill.match(/\bmeasured\(\s*(\w+)\s*,/);
  assert.ok(argW, `${PILL_WEB}: no call measured(…) — update the anchor`);
  const defW = pill.match(new RegExp(String.raw`const ${argW[1]}\b[^=]*=\s*([\s\S]*?);\n`));
  assert.ok(defW, `${PILL_WEB}: the list ${argW[1]} passed to measured cannot be found — update the anchor`);
  const web = {
    rowCounts: counts,
    sumOver: over(sumW),
    sumWithoutRow: /if\s*\(\s*!\s*\w+\.length\s*\)\s*return\s+null\s*;/.test(sumW) ? "null (no numbers)" : "unknown — update the anchor",
    cpuRounded: places(sumW.match(/\*\s*(10+)\s*\)\s*\/\s*(10+)/)),
    serviceContainer: !/\.container\b/.test(predW) ? "no condition"
      : /\.container\b[^&|]*\.trim\(\)/.test(predW) ? "container name, only whitespace counts as empty" : "container name not empty",
    serviceProject: new RegExp(String.raw`\b${setW[1]}\.has\(\s*\w+\.projectId\s*\)`).test(predW) && /\.projectId\b/.test(setExprW)
      ? `project with a counting row (${over(setExprW)})` : "no condition",
    link: /\|\|/.test(predW) ? "OR" : /&&/.test(predW) ? "AND" : "—",
    total: /\btotal:\s*services\.length\b/.test(measuredW) ? "all passed services" : "unknown — update the anchor",
    // The pill cuts via `runningInScope` from the module — then what counts is what ITS body filters (workspace/project
    // are bound by the test "Ports · Performance: the services-status module computes scope, trigger and tooltips").
    caller: /\.running\b/.test(/\brunningInScope\(/.test(defW[1]) ? tsBody(webQ, "runningInScope", RULES_WEB) : defW[1])
      ? "running services of the scope" : "not filtered to running ones",
  };

  // iOS
  const iosQ = withoutComments(readRepo(RULES_IOS));
  const rules = inBracket(iosQ, /\benum ServicesRules\s*\{/, RULES_IOS, "enum ServicesRules");
  const sumI = swiftBody(rules, "sum", RULES_IOS);
  const measuredI = swiftBody(rules, "measured", RULES_IOS);
  const setI = measuredI.match(/\blet\s+(\w+)\s*=\s*Set\(/);
  assert.ok(setI, `${RULES_IOS}: measured no longer builds a set of the measured projects (\`let x = Set(…)\`) — update the anchor`);
  const setExprI = inBracket(measuredI, /\bSet\(/, RULES_IOS, "Set( in measured");
  const predI = inBracket(measuredI, /\bservices\.filter\s*\{/, RULES_IOS, "services.filter { in measured");
  const argI = iosQ.match(/\bServicesRules\.measured\(\s*services:\s*(\w+)/);
  assert.ok(argI, `${RULES_IOS}: no call ServicesRules.measured(services: …) — update the anchor`);
  const defI = iosQ.match(new RegExp(String.raw`var ${argI[1]}\b[^{]*\{([^}]*)\}`));
  assert.ok(defI, `${RULES_IOS}: the list ${argI[1]} passed to measured cannot be found — update the anchor`);
  const ios = {
    rowCounts: condition(sumI) === condition(setExprI) ? condition(sumI) : `sum ${condition(sumI)}, measured ${condition(setExprI)}`,
    sumOver: condition(sumI),
    sumWithoutRow: /guard\s+!\w+\.isEmpty\s+else\s*\{\s*return\s+nil\s*\}/.test(sumI) ? "null (no numbers)" : "unknown — update the anchor",
    cpuRounded: places(sumI.match(/\*\s*(10+)\s*\)\.rounded\(\)\s*\/\s*(10+)/)),
    serviceContainer: !/\.container\b/.test(predI) ? "no condition"
      : /\.container\.contains\s*\{\s*!\s*\$0\.isWhitespace\s*\}/.test(predI) ? "container name, only whitespace counts as empty"
      : /!\s*\w+\.container\.isEmpty\b/.test(predI) ? "container name not empty" : "container name (form unknown — update the anchor)",
    serviceProject: new RegExp(String.raw`\b${setI[1]}\.contains\(\s*\w+\.projectId\s*\)`).test(predI) && /\.projectId\b/.test(setExprI)
      ? `project with a counting row (${condition(setExprI)})` : "no condition",
    link: /\|\|/.test(predI) ? "OR" : /&&/.test(predI) ? "AND" : "—",
    total: /\btotal:\s*services\.count\b/.test(measuredI) ? "all passed services" : "unknown — update the anchor",
    caller: /\.running\b/.test(defI[1]) ? "running services of the scope" : "not filtered to running ones",
  };
  console.log(`  [Web↔iOS measured] ${Object.entries(web).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
  equal("\"measured\" and the sum", web, ios, [`${RULES_WEB}, Aufruf in ${PILL_WEB}`, `${RULES_IOS}`]);
  // The rule in words — it holds both sides if they drift TOGETHER.
  assert.equal(web.rowCounts, "containers > 0", `both sides count a resource row at "${web.rowCounts}" — the rule is containers > 0`);
  assert.equal(web.sumWithoutRow, "null (no numbers)", "without a counting row the sum must be null — never \"0 % · 0 B\"");
  assert.equal(web.link, "AND", "a service counts as measured only with a container name AND a counting project");
  assert.notEqual(web.serviceContainer, "no condition", "a service without a container name (host port only) would count as measured");
});

// ── (d) Identifiers and their readers ─────────────────────────────────────────────────────────────

test("Web ↔ iOS (d): the identifiers of the two entries exist on both sides — with their reader — and the old drawer row is gone", () => {
  // The web reader is a DOM probe run by hand in a real browser (not part of this repository): the web rows keep the component
  // side of the pair, the iOS rows also check their reader.
  const COD = null;
  const XCUI = "mobile/CbaseMobileUITests/Tests/ShellUITests.swift";
  const pairs = [
    ["Web", PILL_WEB, /\sdata-status-ports\s/, "data-status-ports", COD, /["'`]header \[data-status-ports\]["'`]/],
    ["Web", PILL_WEB, /\sdata-status-performance\s/, "data-status-performance", COD, /["'`]header \[data-status-performance\]["'`]/],
    ["Web", PILL_WEB, /\sdata-services-count=\{/, "data-services-count", COD, /["']data-services-count["']/],
    ["Web", PILL_WEB, /\sdata-services-stage=\{/, "data-services-stage", COD, /["']data-services-stage["']/],
    ["iOS", BUTTON_IOS, /\.accessibilityIdentifier\("status-services"\)[\s\S]{0,240}\.accessibilityValue\(/, "status-services (with accessibilityValue = count)", XCUI, /\["status-services"\]/],
    ["iOS", BUTTON_IOS, /\.accessibilityIdentifier\("status-services-menu"\)/, "status-services-menu", XCUI, /\["status-services-menu"\]/],
    ["iOS", BUTTON_IOS, /\.accessibilityIdentifier\("status-services-row-\\\(/, "status-services-row-<id>", XCUI, /"status-services-row-\\\(/],
    ["iOS", BUTTON_IOS, /\.accessibilityIdentifier\("status-agent-browsers"\)/, "status-agent-browsers", XCUI, /\["status-agent-browsers"\]/],
    ["iOS", BUTTON_IOS, /\.accessibilityIdentifier\("status-performance"\)[\s\S]{0,240}\.accessibilityValue\(/, "status-performance (with accessibilityValue = CPU)", XCUI, /\["status-performance"\]/],
    ["iOS", BUTTON_IOS, /\.accessibilityIdentifier\("status-performance-menu"\)/, "status-performance-menu", XCUI, /\["status-performance-menu"\]/],
  ];
  for (const [page, source, carries, identifier, reader, reads] of pairs) {
    assert.ok(carries.test(withoutComments(readRepo(source))), `${page}: ${source} no longer carries the identifier ${identifier} — ${reader ?? "the browser probe"} grabs it and would run into nothing`);
    if (!reader) continue;
    assert.ok(reads.test(readRepo(reader)), `${page}: ${reader} no longer grabs ${identifier} — the identifier in ${source} would have no test bench`);
  }
  console.log(`  [Web↔iOS identifiers] ${pairs.length} pairs component ↔ test bench`);

  // iOS counterpart of "The ports and resources pills are gone": the status row of the right drawer (`ScopeStatusRow`,
  // identifiers `status-services`/`status-resources`) is gone — if it came back, the services would exist twice, and
  // the drawer exists only in Coding.
  const app = path.join(repo, "mobile", "CbaseMobile");
  assert.ok(!fs.existsSync(path.join(app, "Shell", "ScopeStatusRow.swift")), "mobile/CbaseMobile/Shell/ScopeStatusRow.swift exists again");
  const swift = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((n) =>
    n.isDirectory() ? swift(path.join(dir, n.name)) : n.name.endsWith(".swift") ? [path.join(dir, n.name)] : []);
  const old = swift(app)
    .filter((p) => /\bScopeStatusRow\b|"status-resources"/.test(withoutComments(fs.readFileSync(p, "utf8"))))
    .map((p) => path.relative(repo, p));
  assert.deepEqual(old, [], "Swift code still names ScopeStatusRow or the old identifiers status-services/status-resources");
});

// ── (e) The color of the performance entry ──────────────────────────────────────────────────
//
// The performance symbol carries the color, and ONLY the machine's: warn/danger, otherwise neutral, without the
// number of services (so "also with 0 services" holds by itself). Bound per side: a single parameter (the stage),
// which case colors and which does not.

test("Web ↔ iOS (e): the performance symbol colors only by the machine — warn/danger, otherwise neutral, without the number of services", () => {
  const webQ = withoutComments(readRepo(RULES_WEB));
  const headerW = webQ.match(/export function performanceTone\(([^)]*)\)/);
  assert.ok(headerW, `${RULES_WEB}: performanceTone not found — update the anchor`);
  const bodyW = tsBody(webQ, "performanceTone", RULES_WEB);
  const toneW = (tone) => (new RegExp(String.raw`if\s*\([^)]*\bstage\s*===\s*"${tone}"\s*\)\s*return\s*"${tone}"`).test(bodyW) ? "colors" : "does not color");
  const web = {
    parameter: parts(headerW[1]).length,
    danger: toneW("danger"),
    warn: toneW("warn"),
    otherwise: /return\s*"neutral"\s*;\s*$/.test(bodyW.trim()) && !/"accent"|"gray"/.test(bodyW) ? "neutral" : "unknown — update the anchor",
  };
  const button = withoutComments(readRepo(BUTTON_IOS));
  const headerI = button.match(/func performanceColor\(([^)]*)\)\s*->\s*Color\?/);
  assert.ok(headerI, `${BUTTON_IOS}: func performanceColor(…) -> Color? not found — update the anchor`);
  const bodyI = inBracket(button, /func performanceColor\([^)]*\)[^{\n]*\{/, BUTTON_IOS, "func performanceColor");
  const toneI = (fall) => {
    const m = bodyI.match(new RegExp(String.raw`case\s+\.${fall}\s*:\s*return\s+([^\n]*)`));
    return m && m[1].trim() !== "nil" ? "colors" : "does not color";
  };
  const elseI = bodyI.match(/case\s+\.ok\s*,\s*\.none\s*:\s*return\s+([^\n]*)/) || bodyI.match(/case\s+\.none\s*,\s*\.ok\s*:\s*return\s+([^\n]*)/);
  const ios = {
    parameter: parts(headerI[1]).length,
    danger: toneI("danger"),
    warn: toneI("warn"),
    otherwise: elseI && elseI[1].trim() === "nil" ? "neutral" : "unknown — update the anchor",
  };
  console.log(`  [Web↔iOS performance color] parameter ${web.parameter} · danger ${web.danger} · warn ${web.warn} · otherwise ${web.otherwise}`);
  equal("color of the performance entry", web, ios, [`${RULES_WEB} performanceTone`, `${BUTTON_IOS} performanceColor`]);
  assert.deepEqual(web, { parameter: 1, danger: "colors", warn: "colors", otherwise: "neutral" },
    "both sides color the performance symbol differently from the rule: only warn/danger of the machine, otherwise neutral, without the number of services");
  // And at the component: the color comes from the rule, not from a comparison of its own.
  const pill = withoutComments(readRepo(PILL_WEB));
  assert.ok(/const tone = performanceTone\(stage\);/.test(pill) && /\$\{TONE\[tone\]\}/.test(pill), `${PILL_WEB}: the performance symbol does not color via performanceTone(stage)`);
  assert.ok(/performanceColor\(stage:\s*verdict\?\.stage\)/.test(button), `${BUTTON_IOS}: the performance button does not color via performanceColor(stage: verdict?.stage)`);
});

// ── (f) Loaded flag, cost, machine source, counting rule ─────────────────────────────────────
//
// Four promises that on iOS were held only by the XCUITest (ShellUITests), which does not run in the gate. As in
// (a)–(e): per side what holds is derived from the source text, and `equal` compares the statements, not the
// characters. The anchors throw ("update the anchor") instead of silently comparing an empty statement.

// All hits of an anchor (global) with the area of the bracket it opens (the last opening bracket in the match).
// `inside` is the text between the brackets.
function bracketAreas(source, anchor, location) {
  return [...source.matchAll(anchor)].map((m) => {
    const on = m.index + Math.max(m[0].lastIndexOf("{"), m[0].lastIndexOf("["), m[0].lastIndexOf("("));
    const inside = inBracket(source.slice(on), /^[{[(]/, location, `the bracket after "${m[0].replace(/\s+/g, " ").slice(0, 60)}"`);
    return { hits: m, on, closed: on + 1 + inside.length, inside };
  });
}
// The innermost area containing position i (or undefined).
const innermost = (areas, i) => areas.filter((b) => b.on < i && i < b.closed).sort((x, y) => y.on - x.on)[0];
const rowIn = (text, i) => text.slice(0, i).split("\n").length;
const swiftFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((n) =>
  n.isDirectory() ? swiftFiles(path.join(dir, n.name)) : n.name.endsWith(".swift") ? [path.join(dir, n.name)] : []);
// Swift conditions `a, b` are an AND.
const swiftAnd = (bed) => parts(bed).map((b) => `(${b})`).join(" && ");

// A Swift body as a JS function — only as much Swift as a pure rule body needs: `guard a, b else { return nil }`,
// `if a, b {`, `return nil`, a comparison `x != nil` / `x == nil` (`!= null` in JS — the same question) and a body of
// ONE expression (Swift's implicit `return`). Anything beyond (`let`, `var`, `guard let` …) THROWS with "extend the
// translation" instead of silently computing something else.
function swiftAsFunction(body, params, location, what) {
  let js = body
    .replace(/\bguard\s+([^{]+?)\s+else\s*\{\s*return\s+nil\s*\}/g, (_, bed) => `if (!(${swiftAnd(bed)})) return null;`)
    .replace(/\bif\s+(?!\()([^{\n]+?)\s*\{/g, (_, bed) => `if (${swiftAnd(bed)}) {`)
    .replace(/\breturn\s+nil\b/g, "return null")
    .replace(/([!=]=)\s*nil\b/g, "$1 null");
  if (!/\breturn\b|[;{}]/.test(js) && js.trim()) js = `return (${js.trim()});`;
  assert.ok(!/\b(?:let|var|guard|nil)\b/.test(js), `${location}: ${what} contains Swift this guard does not translate: ${js.trim()} — extend the translation here`);
  try { return new Function(...params, `"use strict";\n${js}`); }
  catch (e) { assert.fail(`${location}: ${what} is no expression after translation (${e.message}): ${js.trim()} — extend the translation here`); }
}
// Parameter names: TS `name: Type`, Swift `[outer] inner: Type`.
const tsParameter = (list) => parts(list).map((p) => p.split(":")[0].trim());
const swiftParameter = (list) => parts(list).map((p) => p.split(":")[0].trim().split(/\s+/).pop());

// ── (f1) "measured: x of n" only after the resources answered ────────────────────────────

test("Web ↔ iOS (f1): 'measured: x of n' appears only after the resources answered — the same rule, the same loaded flag (empty is not unknown)", () => {
  const webQ = withoutComments(readRepo(RULES_WEB));
  const pill = withoutComments(readRepo(PILL_WEB));
  const iosQ = withoutComments(readRepo(RULES_IOS));
  const button = withoutComments(readRepo(BUTTON_IOS));
  const rules = inBracket(iosQ, /\benum ServicesRules\s*\{/, RULES_IOS, "enum ServicesRules");

  // 1. The rule, RECOMPUTED on a grid (measured 0…4, total 0…4, loaded yes/no). The web version is executed as JS, the
  //    iOS version translated (guard → if). iOS used not to ask for `loaded`: before the first answer and after every
  //    failed one it showed "measured: 0 of 3" while the web stayed silent.
  const webParam = tsParameter(inBracket(webQ, /export function measureRow\(/, RULES_WEB, "function measureRow("));
  const iosParam = swiftParameter(inBracket(rules, /static func measureRow\(/, RULES_IOS, "static func measureRow("));
  assert.equal(webParam.length, 2, `${RULES_WEB}: measureRow does not take (measured, loaded) — update the anchor`);
  assert.equal(iosParam.length, 2, `${RULES_IOS}: ServicesRules.measureRow does not take (_ measured:, loaded:) — update the anchor`);
  let webFn;
  try { webFn = new Function(...webParam, `"use strict";\n${tsBody(webQ, "measureRow", RULES_WEB)}`); }
  catch (e) { assert.fail(`${RULES_WEB}: the body of measureRow is no JS any more (${e.message}) — update the anchor`); }
  const iosFn = swiftAsFunction(swiftBody(rules, "measureRow", RULES_IOS), iosParam, RULES_IOS, "ServicesRules.measureRow");
  const raster = [];
  for (const loaded of [false, true]) for (let total = 0; total <= 4; total++) for (let x = 0; x <= 4; x++) raster.push({ measured: x, total, loaded });
  const shows = (fn, f) => {
    const mess = { measured: f.measured, total: f.total };
    let r;
    try { r = fn(mess, f.loaded); } catch (e) { return `throws: ${e.message}`; }
    return r == null ? "no row" : r === mess ? `${f.measured} of ${f.total}` : `other: ${JSON.stringify(r)}`;
  };
  const fall = (f) => `(measured ${f.measured}, total ${f.total}, loaded ${f.loaded})`;
  const deviations = raster.filter((f) => shows(webFn, f) !== shows(iosFn, f)).map((f) => `${fall(f)}: Web "${shows(webFn, f)}" · iOS "${shows(iosFn, f)}"`);
  assert.deepEqual(deviations, [], `measureRow computes differently on the two sides — Web (${RULES_WEB}) and iOS (${RULES_IOS} ServicesRules.measureRow):\n  ${deviations.slice(0, 8).join("\n  ")}`);
  const desired = (f) => (f.loaded && f.total > 0 && f.measured < f.total ? `${f.measured} of ${f.total}` : "no row");
  const offSpec = raster.filter((f) => shows(webFn, f) !== desired(f)).map((f) => `${fall(f)}: both "${shows(webFn, f)}", the rule "${desired(f)}"`);
  assert.deepEqual(offSpec, [], `both sides deviate together from the rule (only after the answer, only with running services, only if not all are measured — then also "0 of n"):\n  ${offSpec.slice(0, 8).join("\n  ")}`);

  // 2. The loaded flag passed in as `loaded` — derived per side from the source text.
  const wsName = (pill.match(/const (\w+) = scope\.workspaceId;/) || [])[1];
  const pidName = (pill.match(/const (\w+) = scope\.projectId;/) || [])[1];
  assert.ok(wsName && pidName, `${PILL_WEB}: ws/pid no longer come from scope.workspaceId/projectId — update the anchor`);
  const callW = pill.match(/\bconst\s+(\w+)\s*=\s*measureRow\(\s*(\w+)\s*,\s*([^;]*?)\s*\)\s*;/);
  assert.ok(callW, `${PILL_WEB}: no \`const x = measureRow(measured, loaded);\` — update the anchor`);
  const [, rowW, rawW, loadedW] = callW;
  const effects = bracketAreas(pill, /\buseEffect\(/g, PILL_WEB);
  const thens = bracketAreas(pill, /\.then\(/g, PILL_WEB);
  const request = (text) => { const l = [...text.matchAll(/(?:\bapi(?:<[^>]*>)?|\bfetch)\(\s*[`"']([^`"'?$]+)/g)]; return l.length ? l.at(-1)[1] : null; };
  const web = { loadedIs: `"${loadedW}" — not a state that only arises with an answer`, initial: "—", trueOnly: "—", stale: "—", scopeSwitch: "—" };
  const stateWValue = loadedW.match(/^(\w+)\s*!==?\s*null$/);
  const stateW = stateWValue && pill.match(new RegExp(String.raw`const\s*\[\s*${stateWValue[1]}\s*,\s*(\w+)\s*\]\s*=\s*useState(?:<[^>]*>)?\(\s*([^)]*?)\s*\)`));
  if (stateW) {
    const setter = stateW[1];
    web.loadedIs = "a state that only arises with an answer";
    web.initial = stateW[2] === "null" ? "not loaded" : `"${stateW[2]}"`;
    const truthy = [];
    const stale = [];
    const back = [];
    for (const m of pill.matchAll(new RegExp(String.raw`\b${setter}\(`, "g"))) {
      const arg = inBracket(pill.slice(m.index), new RegExp(String.raw`^${setter}\(`), PILL_WEB, `${setter}(…)`).trim();
      const eff = innermost(effects, m.index);
      if (arg === "null") {
        const deps = eff ? parts(eff.inside).at(-1).replace(/[[\]\s]/g, "").split(",").filter(Boolean) : [];
        back.push(deps.includes(wsName) && deps.includes(pidName) ? "resets" : `line ${rowIn(pill, m.index)}: not on the scope (${deps.join(", ") || "outside an effect"})`);
        continue;
      }
      const th = innermost(thens, m.index);
      const filePath = th && eff && request(pill.slice(eff.on, th.on));
      truthy.push(filePath ? `answer of ${filePath}` : `outside an answer (line ${rowIn(pill, m.index)})`);
      const watch = th && th.inside.slice(0, m.index - th.on).match(/if\s*\(\s*!\s*(\w+)\s*\)\s*return\b/);
      stale.push(watch && new RegExp(String.raw`\b${watch[1]}\s*=\s*false\b`).test(eff.inside) ? "dismissed" : `line ${rowIn(pill, m.index)}: not discarded`);
    }
    web.trueOnly = [...new Set(truthy)].sort().join(" · ") || "nowhere";
    web.stale = [...new Set(stale)].sort().join(" · ") || "—";
    web.scopeSwitch = back.includes("resets") ? "resets" : back.join(" · ") || "nowhere";
  }

  const mzI = iosQ.match(/var measureRow\s*:\s*ServicesRules\.Measurement\?\s*\{\s*ServicesRules\.measureRow\(\s*(\w+)\s*,\s*loaded:\s*([^)]*?)\s*\)\s*\}/);
  assert.ok(mzI, `${RULES_IOS}: \`var measureRow: ServicesRules.Measurement? { ServicesRules.measureRow(…, loaded: …) }\` not found in the model — update the anchor`);
  const [, rawI, loadedI] = mzI;
  const ios = { loadedIs: `"${loadedI}" — not a state that only arises with an answer`, initial: "—", trueOnly: "—", stale: "—", scopeSwitch: "—" };
  const declI = /^\w+$/.test(loadedI) && iosQ.match(new RegExp(String.raw`\bvar\s+${loadedI}\s*(?::\s*Bool\s*)?=\s*(\w+)`));
  if (declI) {
    ios.loadedIs = "a state that only arises with an answer";
    ios.initial = declI[1] === "false" ? "not loaded" : `"${declI[1]}"`;
    const branches = bracketAreas(iosQ, /\bif let\s+(\w+)\s*(?::\s*[\w.[\]?]+)?\s*=\s*try\?\s*await\s+client\.get\(\s*"([^"]+)"[^{]*\{/g, RULES_IOS);
    const start = bracketAreas(iosQ, /\bfunc start\(workspaceId:[^)]*\)\s*\{/g, RULES_IOS)[0];
    assert.ok(start, `${RULES_IOS}: func start(workspaceId:projectId:) not found — update the anchor`);
    const equalName = (start.inside.match(/let\s+(\w+)\s*=\s*workspaceId\s*==\s*self\.workspaceId\s*&&\s*projectId\s*==\s*self\.projectId/) || [])[1];
    assert.ok(equalName, `${RULES_IOS}: start() no longer compares the scope (\`let x = workspaceId == self.workspaceId && projectId == self.projectId\`) — update the anchor`);
    const newScope = bracketAreas(iosQ, new RegExp(String.raw`\bif\s+!\s*${equalName}\s*\{`, "g"), RULES_IOS).filter((b) => b.on > start.on && b.closed < start.closed);
    const truthy = [];
    const stale = [];
    const back = [];
    for (const m of iosQ.matchAll(new RegExp(String.raw`(?:\bself\.|(?<![.\w])(?<!\bvar\s{1,8}))${loadedI}\s*=(?!=)\s*(\w+)`, "g"))) {
      if (m[1] === "false") {
        if (innermost(newScope, m.index)) back.push("resets");
        continue;
      }
      const innerBranch = innermost(branches, m.index);
      truthy.push(m[1] !== "true" ? `"${m[1]}" (line ${rowIn(iosQ, m.index)})` : innerBranch ? `answer of ${innerBranch.hits[2]}` : `outside an answer (line ${rowIn(iosQ, m.index)})`);
      stale.push(innerBranch && /guard\s+\w+\s*==\s*run\s+else\s*\{\s*return\s*\}/.test(innerBranch.inside.slice(0, m.index - innerBranch.on)) ? "dismissed" : `line ${rowIn(iosQ, m.index)}: not discarded`);
    }
    ios.trueOnly = [...new Set(truthy)].sort().join(" · ") || "nowhere";
    ios.stale = [...new Set(stale)].sort().join(" · ") || "—";
    ios.scopeSwitch = back.length ? "resets" : "nowhere";
  }
  console.log(`  [Web↔iOS measured only after the answer] Web ${loadedW} · iOS ${loadedI} — ${Object.entries(web).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
  equal("loaded flag of measureRow", web, ios, [`${PILL_WEB} measureRow(…, ${loadedW})`, `${RULES_IOS} measureRow(…, loaded: ${loadedI})`]);
  assert.equal(web.trueOnly, "answer of /api/project-resources", `both sides say "loaded" as soon as ${web.trueOnly} — meant is the answer of the resources request`);
  assert.deepEqual([web.initial, web.stale, web.scopeSwitch], ["not loaded", "dismissed", "resets"],
    "the loaded flag does not start unloaded, accepts stale answers or survives the scope switch — then \"loaded\" would mean \"loaded for another place\"");

  // 3. Where the row stands: under measureRow, the section under resourcesSection — and nobody reads the raw
  //    measurement (without loaded flag) past measureRow.
  const sumW = (pill.match(/\bconst\s+(\w+)\s*=\s*servicesSum\(/) || [])[1];
  assert.ok(sumW, `${PILL_WEB}: no \`const x = servicesSum(…)\` — update the anchor`);
  const measuredIdxW = pill.indexOf('t("measured: {x} of {n} services"');
  const measuredIdxI = button.indexOf('L("measured: {x} of {n} services"');
  assert.ok(measuredIdxW > 0 && measuredIdxI > 0, "the row \"measured: {x} of {n} services\" cannot be found on one side — update the anchor");
  const jsxBed = bracketAreas(pill, /\{\s*([^{}]*?)\s*&&\s*\(/g, PILL_WEB);
  // The number of running services of the scope (the section depends on it too).
  const servicesW = (pill.match(/\bconst\s+(\w+)(?::[^=]*)?=\s*runningInScope\(/) || [])[1];
  const countW = servicesW && (pill.match(new RegExp(String.raw`\bconst\s+(\w+)\s*=\s*${servicesW}\.length\s*;`)) || [])[1];
  assert.ok(countW, `${PILL_WEB}: \`const n = <runningInScope(…)>.length;\` not found — update the anchor`);
  const nameW = (t) => (t === sumW ? "Sum" : t === rowW ? "measureRow" : t === countW ? "count" : `"${t}"`);
  // The section stands under `resourcesSection(…)` (module, (f5)) — its arguments are read.
  const bedW = (b) => {
    if (!b) return "no condition";
    const call = b.hits[1].trim().match(/^resourcesSection\(([^()]*)\)$/);
    if (call) return `resourcesSection(${parts(call[1]).map(nameW).join(", ")})`;
    return b.hits[1].replace(/[()\s]/g, "").split("||").map(nameW).sort().join(" OR ");
  };
  const sectionW = innermost(jsxBed, pill.indexOf('t("Resources")'));
  const iosIfs = bracketAreas(button, /\bif\s+(?!let\b)([^{\n]+?)\s*\{/g, BUTTON_IOS);
  const iosIfLets = bracketAreas(button, /\bif\s+let\s+\w+\s*=\s*([\w.]+)\s*\{/g, BUTTON_IOS);
  const nameI = (t) => ({ "model.sum!=nil": "Sum", "model.measureRow!=nil": "measureRow", "model.sum": "Sum", "model.measureRow": "measureRow", "model.running.count": "count" })[t] ?? `"${t}"`;
  const bedI = (b) => {
    if (!b) return "no condition";
    const call = b.hits[1].trim().match(/^ServicesRules\.resourcesSection\(([^()]*)\)$/);
    if (call) return `resourcesSection(${parts(call[1]).map((a) => nameI(a.replace(/^\w+\s*:\s*/, "").replace(/\s+/g, ""))).join(", ")})`;
    return b.hits[1].split("||").map((t) => nameI(t.replace(/\s+/g, ""))).sort().join(" OR ");
  };
  const sectionI = innermost(iosIfs, button.search(/\bresources\(\s*model\.sum\s*\)/));
  const rowUnderI = innermost(iosIfLets, measuredIdxI);
  const foreignW = [...pill.matchAll(new RegExp(String.raw`\b${rawW}\b`, "g"))].length - 2;
  const foreignI = [...iosQ.matchAll(new RegExp(String.raw`\b${rawI}\b`, "g"))].length - 2 + [...button.matchAll(new RegExp(String.raw`\bmodel\.${rawI}\b`, "g"))].length;
  const displayW = {
    rowUnder: nameW((innermost(jsxBed, measuredIdxW) || { hits: [, "no condition"] }).hits[1].trim()),
    sectionUnder: bedW(sectionW),
    rawMeasurement: foreignW === 0 ? "only via measureRow" : `${foreignW}× read past measureRow (${rawW})`,
  };
  const displayI = {
    rowUnder: rowUnderI ? ({ "model.measureRow": "measureRow", "model.sum": "Sum" })[rowUnderI.hits[1]] ?? `"${rowUnderI.hits[1]}"` : "no condition",
    sectionUnder: bedI(sectionI),
    rawMeasurement: foreignI === 0 ? "only via measureRow" : `${foreignI}× read past measureRow (${rawI})`,
  };
  equal("Where \"measured\" appears", displayW, displayI, [PILL_WEB, `${BUTTON_IOS} + ${RULES_IOS}`]);
  assert.deepEqual(displayW, { rowUnder: "measureRow", sectionUnder: "resourcesSection(count, Sum, measureRow)", rawMeasurement: "only via measureRow" },
    "both sides show \"measured\" past measureRow — before the first answer it would then say \"0 of n\" — or the section does not depend on resourcesSection(count of the running ones, sum, measureRow) ((f5))");
});

// ── (f2) Cost: the folder size only with the menu open ────────────────────────────────────────

test("Web ↔ iOS (f2): closed, the resources request asks with disk=0, open without — the flag is the visible menu, and opening asks at once", () => {
  const pill = withoutComments(readRepo(PILL_WEB));
  const iosQ = withoutComments(readRepo(RULES_IOS));
  const button = withoutComments(readRepo(BUTTON_IOS));
  const diskFrom = (qs) => { const v = new URLSearchParams(qs).get("disk"); return v === null ? "without disk" : `disk=${v}`; };

  // Web: the query from the ONE effect that asks /api/project-resources — the query expression is executed for menu
  // closed/open.
  const wsName = (pill.match(/const (\w+) = scope\.workspaceId;/) || [])[1];
  const pidName = (pill.match(/const (\w+) = scope\.projectId;/) || [])[1];
  // "The menu" is the PERFORMANCE menu — only there the project files are shown.
  const menuW = (pill.match(/\{\s*(\w+)\s*&&\s*\(\s*<div\b[^>]*?\bdata-status-performance-menu\b/) || [])[1];
  const portsW = (pill.match(/\{\s*(\w+)\s*&&\s*\(\s*<div\b[^>]*?\bdata-status-ports-menu\b/) || [])[1];
  assert.ok(wsName && pidName && menuW && portsW, `${PILL_WEB}: ws/pid from the scope or \`{x && (<div … data-status-performance-menu\` / \`… data-status-ports-menu\` not found — update the anchor`);
  const resEff = bracketAreas(pill, /\buseEffect\(/g, PILL_WEB).filter((b) => /["'`]\/api\/project-resources\b/.test(b.inside));
  assert.equal(resEff.length, 1, `${PILL_WEB}: ${resEff.length} effects ask /api/project-resources — exactly one expected (update the anchor, or a second request would run past the rule)`);
  const effParts = parts(resEff[0].inside);
  const effBody = effParts[0];
  const effDeps = effParts.at(-1).replace(/[[\]\s]/g, "").split(",").filter(Boolean);
  const object = inBracket(effBody, /new URLSearchParams\(/, PILL_WEB, "new URLSearchParams( in the resources request");
  let qsW;
  try { qsW = new Function(wsName, pidName, menuW, `"use strict"; return new URLSearchParams(${object}).toString();`); }
  catch (e) { assert.fail(`${PILL_WEB}: the query of the resources request is no expression (${e.message}) — update the anchor`); }
  const askW = (open) => { try { return diskFrom(qsW("w1", null, open)); } catch (e) { return `throws: ${e.message} (the query reads more than scope and menu)`; } };
  const loadName = (effBody.match(/const\s+(\w+)\s*=\s*\(\)\s*=>[\s\S]*?\/api\/project-resources/) || [])[1];
  const web = {
    closed: askW(false),
    open: askW(true),
    attribute: "the visible menu",
    onOpen: effDeps.includes(menuW) && loadName && new RegExp(String.raw`(?:^|[;{}]|\n)\s*${loadName}\(\);`).test(effBody)
      ? "asks again at once" : `does not ask at once (deps ${effDeps.join(", ")}; call ${loadName ?? "?"}() not at once)`,
    places: [...pill.matchAll(/["']?\bdisk["']?\s*:\s*["'`]/g)].length,
    // The ports menu shows no folder size: its open marker (and the shared state) appears neither in the query nor in
    // the deps of the resources request.
    portsMenu: [portsW, "open"].some((n) => effDeps.includes(n) || new RegExp(String.raw`\b${n}\b`).test(object)) ? "asks too" : "asks nothing",
  };

  // iOS: the request in refresh(run:) — the parameter disk and the `if`s containing it, evaluated for menu open/closed.
  const refreshI = bracketAreas(iosQ, /\bfunc refresh\(run\b[^)]*\)[^{]*\{/g, RULES_IOS)[0];
  assert.ok(refreshI, `${RULES_IOS}: func refresh(run:) not found — update the anchor`);
  const queryI = (refreshI.inside.match(/client\.get\(\s*"\/api\/project-resources"\s*,\s*query:\s*(\w+)\s*\)/) || [])[1];
  assert.ok(queryI, `${RULES_IOS}: the resources request is not made as client.get("/api/project-resources", query: …) — update the anchor`);
  const diskI = [...refreshI.inside.matchAll(/URLQueryItem\(\s*name:\s*"disk"\s*,\s*value:\s*"([^"]*)"\s*\)/g)];
  // The ports popover does not report to the model (`model.menu(` appears only at the performance popover).
  const portsPopover = bracketAreas(button, /\.popover\(isPresented:\s*bound\(\.ports\)\)\s*\{/g, BUTTON_IOS)[0];
  assert.ok(portsPopover, `${BUTTON_IOS}: \`.popover(isPresented: bound(.ports)) {\` not found — update the anchor`);
  const ios = { closed: "without disk", open: "without disk", attribute: "—", onOpen: "—", places: [...iosQ.matchAll(/name:\s*"disk"/g)].length,
    portsMenu: /\bmodel\.menu\(/.test(portsPopover.inside) ? "asks too" : "asks nothing" };
  const menuFn = bracketAreas(iosQ, /\bfunc menu\(\s*open:\s*Bool\s*\)\s*\{/g, RULES_IOS)[0];
  assert.ok(menuFn, `${RULES_IOS}: func menu(open: Bool) not found — update the anchor`);
  if (diskI.length === 1) {
    const pos = diskI[0].index;
    const bed = bracketAreas(refreshI.inside, /\bif\s+(?!let\b)([^{\n]+?)\s*\{/g, RULES_IOS).filter((b) => b.on < pos && pos < b.closed).map((b) => b.hits[1]);
    const names = [...new Set(bed.join(" ").match(/\b[A-Za-z_]\w*\b/g) || [])].filter((n) => !["true", "false"].includes(n));
    const inQuery = new RegExp(String.raw`\b${queryI}\.append\(\s*$`).test(refreshI.inside.slice(0, pos)) || new RegExp(String.raw`\bvar\s+${queryI}\s*=\s*\[[^\]]*$`).test(refreshI.inside.slice(0, pos));
    if (!inQuery) ios.closed = ios.open = `disk is not in ${queryI}`;
    else if (names.length > 1) ios.closed = ios.open = `depends on ${names.join(", ")} — not on the menu alone`;
    else {
      const v = names[0];
      const enabled = (open) => bed.every((b) => new Function(v ?? "_", `"use strict"; return (${swiftAnd(b)});`)(open));
      ios.closed = enabled(false) ? `disk=${diskI[0][1]}` : "without disk";
      ios.open = enabled(true) ? `disk=${diskI[0][1]}` : "without disk";
      // The flag is the visible menu: `menu(open:)` sets it, and the CONTENT of the performance popover (the menu with the
      // identifier status-performance-menu) reports appearing and disappearing — ONLY this one, the ports popover shows
      // no folder size.
      const popover = bracketAreas(button, /\.popover\(isPresented:\s*bound\(\.performance\)\)\s*\{/g, BUTTON_IOS)[0];
      const menuStruct = button.slice(button.search(/\bstruct PerformanceMenu\b/)).split(/\n(?:private\s+|fileprivate\s+)?struct\s/)[0];
      const missing = [];
      if (!v) missing.push("disk=0 depends on no condition — on no menu flag");
      else if (!new RegExp(String.raw`\b${v}\s*=\s*open\b`).test(menuFn.inside)) missing.push(`menu(open:) does not set ${v} — disk=0 depends on something other than the menu`);
      if (!popover || !/\.onAppear\s*\{\s*model\.menu\(open:\s*true\)\s*\}/.test(popover.inside)) missing.push("the popover content does not report its appearing (onAppear → menu(open: true))");
      if (!popover || !/\.onDisappear\s*\{\s*model\.menu\(open:\s*false\)\s*\}/.test(popover.inside)) missing.push("the popover content does not report its disappearing (onDisappear → menu(open: false))");
      if (!popover || !/\bPerformanceMenu\(/.test(popover.inside) || !/\.accessibilityIdentifier\("status-performance-menu"\)/.test(menuStruct)) missing.push("the popover content is not the menu status-performance-menu");
      ios.attribute = missing.length ? missing.join("; ") : "the visible menu";
    }
  } else if (diskI.length > 1) ios.closed = ios.open = `${diskI.length} disk parameters`;
  // At once on opening: `menu(open:)` restarts the tick on `open`, and the tick asks BEFORE sleeping.
  const restart = menuFn.inside.match(/\bif\s+([^{]+?)\s*\{\s*tick\(\)\s*\}/);
  const tickFn = bracketAreas(iosQ, /\bfunc tick\(\)\s*\{/g, RULES_IOS)[0];
  const asksFirst = tickFn && tickFn.inside.search(/\brefresh\(/) >= 0 && tickFn.inside.search(/\brefresh\(/) < tickFn.inside.search(/\bTask\.sleep\(/);
  ios.onOpen = restart && parts(restart[1]).map((s) => s.trim()).includes("open") && asksFirst
    ? "asks again at once" : `does not ask at once (${restart ? `restart under "${restart[1].trim()}"` : "no tick() in menu(open:)"}${asksFirst ? "" : ", tick() sleeps before the first request"})`;

  console.log(`  [Web↔iOS disk] closed: Web ${web.closed} · iOS ${ios.closed} — open: Web ${web.open} · iOS ${ios.open} — opening: Web ${web.onOpen} · iOS ${ios.onOpen}`);
  equal("cost of the resources request (folder size)", web, ios, [`${PILL_WEB} (menu: ${menuW})`, `${RULES_IOS} refresh(run:) + ${BUTTON_IOS}`]);
  assert.deepEqual([web.closed, web.open, web.places, web.portsMenu], ["disk=0", "without disk", 1, "asks nothing"],
    "both sides ask the folder size (du over every project folder) also while the performance menu is closed — or never, or already with the ports menu; the expected values apply to each side");
});

// ── (f3) Machine source ──────────────────────────────────────────────────────────────────────

test("Web ↔ iOS (f3): in gateway operation the machine comes only from /gw/host, a failure keeps the last value — and iOS knows only gateway operation", () => {
  const pill = withoutComments(readRepo(PILL_WEB));
  const iosQ = withoutComments(readRepo(RULES_IOS));
  const button = withoutComments(readRepo(BUTTON_IOS));

  // Web: every write site setHost(…) with its effect, its request and its gateway gate.
  const effects = bracketAreas(pill, /\buseEffect\(/g, PILL_WEB);
  const sources = { including: new Set(), without: new Set() };
  const clears = { including: [], without: [] };
  for (const m of pill.matchAll(/\bsetHost\(/g)) {
    const eff = innermost(effects, m.index);
    const row = rowIn(pill, m.index);
    if (!eff) { sources.including.add(`outside an effect (line ${row})`); sources.without.add(`outside an effect (line ${row})`); continue; }
    const body = parts(eff.inside)[0];
    const paths = [...body.matchAll(/(?:\bapi(?:<[^>]*>)?|\bfetch)\(\s*[`"']([^`"'?$]+)/g)].map((p) => p[1]);
    const filePath = paths.length === 1 ? paths[0] : `effect with ${paths.length} requests (line ${row})`;
    const gate = body.match(/^\s*\(\)\s*=>\s*\{\s*if\s*\(\s*(!?)\s*gateway\s*\)\s*return\s*;/);
    const prior = pill.slice(pill.lastIndexOf("\n", m.index) + 1, m.index).match(/\bif\s*\((.*)\)\s*$/);
    const and = prior ? prior[1].split("&&").map((s) => s.trim()) : [];
    const arg = inBracket(pill.slice(m.index), /^setHost\(/, PILL_WEB, "setHost(…)").trim();
    let including = true;
    let without = true;
    if (gate) { if (gate[1]) without = false; else including = false; }
    if (and.includes("!gateway")) including = false;
    if (and.includes("gateway")) without = false;
    const watched = and.some((k) => [arg, `!!${arg}`, `${arg} != null`, `${arg} !== null`].includes(k));
    for (const [kind, applies] of [["including", including], ["without", without]]) {
      if (!applies) continue;
      sources[kind].add(filePath);
      if (!watched) clears[kind].push(`${filePath}: setHost(${arg}) (line ${row})`);
    }
  }
  const nameW = pill.match(/\{\s*gateway\s*\?\s*t\("([^"]+)"\)\s*:\s*t\("([^"]+)"\)\s*\}/);
  assert.ok(nameW, `${PILL_WEB}: the name of the machine (\`{gateway ? t("…") : t("…")}\`) cannot be found — update the anchor`);
  const web = {
    sources: [...sources.including].sort().join(" · ") || "no",
    failure: clears.including.length ? `clears (${clears.including.join("; ")})` : "last value stays",
    name: nameW[1],
  };
  console.log(`  [Web↔iOS machine] Web with gateway: ${web.sources}, without gateway: ${[...sources.without].sort().join(" · ") || "no"} ("${nameW[2]}")`);

  // iOS: every assignment to `calculator` with the answer branch it stands in.
  const branches = bracketAreas(iosQ, /\bif let\s+(\w+)\s*(?::\s*[\w.[\]?]+)?\s*=\s*try\?\s*await\s+client\.get\(\s*"([^"]+)"[^{]*\{/g, RULES_IOS);
  const sourcesI = new Set();
  const clearsI = [];
  for (const m of iosQ.matchAll(/(?:\bself\.|(?<![.\w]))calculator\s*=(?!=)\s*([^\n};]+)/g)) {
    const innerBranch = innermost(branches, m.index);
    const value = m[1].trim();
    sourcesI.add(innerBranch ? innerBranch.hits[2] : `outside an answer (line ${rowIn(iosQ, m.index)})`);
    if (!innerBranch || value !== innerBranch.hits[1]) clearsI.push(`calculator = ${value} (Row ${rowIn(iosQ, m.index)})`);
  }
  const nameI = inBracket(button, /\bfunc servicesMachineName\([^)]*\)[^{]*\{/, BUTTON_IOS, "func servicesMachineName");
  const namesI = [...nameI.matchAll(/\bL\("([^"]+)"/g)].map((n) => n[1]);
  const ios = {
    sources: [...sourcesI].sort().join(" · ") || "no",
    failure: clearsI.length ? `clears (${clearsI.join("; ")})` : "last value stays",
    name: namesI.length === 1 ? namesI[0] : `${namesI.length} Namen: ${namesI.join(", ") || "—"}`,
  };
  equal("machine source in gateway operation", web, ios, [`${PILL_WEB} (gateway = true)`, `${RULES_IOS} + ${BUTTON_IOS}`]);
  assert.deepEqual(web, { sources: "/gw/host", failure: "last value stays", name: "Server" },
    "both sides take another source than /gw/host in gateway operation — in the user container the resources' `host` is only its own allotment (sysbox virtualises /proc/meminfo)");

  // The premise on iOS: there is ONLY gateway operation. The one APIClient is built by SessionStore.connect, and it is
  // assigned only behind `guard info.gateway`. If that fell, iOS would need the rule WITHOUT gateway (web: `host` of the
  // resources, "This machine") — and nobody binds that here.
  const SESSION = "mobile/CbaseMobile/Models/SessionStore.swift";
  const app = path.join(repo, "mobile", "CbaseMobile");
  const builder = swiftFiles(app).filter((p) => /\bAPIClient\(/.test(withoutComments(fs.readFileSync(p, "utf8")))).map((p) => path.relative(repo, p));
  const sess = withoutComments(readRepo(SESSION));
  const connect = inBracket(sess, /\bfunc connect\(\)\s*(?:async\s*)?(?:throws\s*)?\{/, SESSION, "func connect()");
  const build = connect.match(/\blet\s+(\w+)\s*=\s*APIClient\(/);
  const watchdog = connect.search(/\bguard\s+\w+\.gateway\s+else\s*\{\s*throw\b/);
  const sets = [...sess.matchAll(/(?<![.\w])(?:self\.)?client\s*=(?!=)\s*(\w+)/g)].map((m) => m[1]);
  const ops = builder.length === 1 && builder[0] === SESSION && build && watchdog >= 0
    && connect.search(new RegExp(String.raw`\bclient\s*=\s*${build[1]}\b`)) > watchdog
    && sets.every((w) => w === "nil" || w === build[1])
    ? "always gateway"
    : `not proven (APIClient built in: ${builder.join(", ") || "—"}; guard …gateway ${watchdog >= 0 ? "present" : "missing"}; client = ${sets.join(", ")})`;
  console.log(`  [Web↔iOS machine] iOS operation: ${ops}`);
  assert.equal(ops, "always gateway", `iOS can also connect without gateway — then the web rule WITHOUT gateway would apply there (host from /api/project-resources, "${nameW[2]}"), and (f3) binds only the gateway branch`);
});

// ── (f4) The counting rule exists once on iOS ──────────────────────────────────────────────────

test("Web ↔ iOS (f4): the counting rule (containers > 0) exists ONCE on iOS in ServicesRules — model and button do not count themselves, both components list sum.projects", () => {
  const iosQ = withoutCommentsLinePreserving(readRepo(RULES_IOS));
  const button = withoutCommentsLinePreserving(readRepo(BUTTON_IOS));
  const pill = withoutCommentsLinePreserving(readRepo(PILL_WEB));

  // The rule itself stands in ServicesRules (in sum and measured — that both have the same condition is held by (c);
  // how it is distributed in there is their business). Outside: no `.containers`.
  const rules = inBracket(iosQ, /\benum ServicesRules\s*\{/, RULES_IOS, "enum ServicesRules");
  const reader = bracketAreas(rules, /\bstatic func (\w+)\([^)]*\)[^{\n]*\{/g, RULES_IOS).filter((b) => /\.containers\b/.test(b.inside)).map((b) => b.hits[1]).sort();
  assert.ok(reader.length, `${RULES_IOS}: no function in ServicesRules reads .containers — where is the counting rule? Update the anchor`);
  const outside = iosQ.replace(rules, () => rules.replace(/[^\n]/g, " ")); // line-preserving, for the message
  const model = [...outside.matchAll(/\.containers\b/g)].map((m) => `${RULES_IOS}:${rowIn(outside, m.index)}`);
  console.log(`  [counting rule iOS] in ServicesRules: ${reader.join(", ")} · outside (model, decoder): ${model.length}`);
  assert.deepEqual(model, [], `${RULES_IOS}: outside ServicesRules (model, decoder) someone reads .containers — the counting rule would then exist twice`);

  // In the components: `containers` only for the text ("1 container" / "{n} containers"), never as a filter or
  // comparison — and the rows come from sum.projects, the set the sum ran over.
  const own = (text, file, equal1, valueForm) => [...text.matchAll(/\.containers\b/g)].flatMap((m) => {
    const afterwards = text.slice(m.index);
    const beforehand = text.slice(Math.max(0, m.index - 40), m.index);
    if (equal1.test(afterwards) || valueForm.test(beforehand)) return [];
    return [`${file}:${rowIn(text, m.index)}: ${text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index)).trim().slice(0, 100)}`];
  });
  const web = {
    rowsFrom: /\(\s*sum\??\.projects\b[^)]*\)\.map\(/.test(pill) ? "sum.projects" : "not from sum.projects",
    ownCountRule: [...own(pill, PILL_WEB, /^\.containers\s*===?\s*1\b/, /\bn:\s*[\w.]*$/),
      ...(/\bcounts\s*\(|\.filter\(\s*counts\s*\)/.test(pill) ? [`${PILL_WEB}: calls counts itself`] : [])],
  };
  const ios = {
    rowsFrom: /\bForEach\(\s*sum\??\.projects\b/.test(button) ? "sum.projects" : "not from sum.projects",
    ownCountRule: own(button, BUTTON_IOS, /^\.containers\s*==\s*1\b/, /"n":\s*[\w.]*$/),
  };
  equal("counting rule in the components", web, ios, [PILL_WEB, BUTTON_IOS]);
  assert.equal(web.rowsFrom, "sum.projects", "both components do not list their resource rows from sum.projects — sum and rows could mean different sets");
});

// ── (f5) Two ticks: the resources section stands only with running services ────────────────

test("Web ↔ iOS (f5): the resources section stands only if services run in the scope — the same rule, the same count as at the trigger", () => {
  // Services (web 30 s, iOS 20 s) and resources (web 15 s; iOS in the same tick, alongside — (f6)) arrive separately.
  // If the resources reported a freshly started container before the services listed it as running, the block (CPU/RAM
  // per project, sum) would stand under "No services running." — while the trigger was already bound to the count
  // (`triggerContent`).
  const webQ = withoutComments(readRepo(RULES_WEB));
  const pill = withoutComments(readRepo(PILL_WEB));
  const iosQ = withoutComments(readRepo(RULES_IOS));
  const button = withoutComments(readRepo(BUTTON_IOS));
  const rules = inBracket(iosQ, /\benum ServicesRules\s*\{/, RULES_IOS, "enum ServicesRules");

  // 1. The rule, RECOMPUTED on a grid (count 0…3 and −1 × sum yes/no × measureRow yes/no).
  const webParam = tsParameter(inBracket(webQ, /export function resourcesSection\(/, RULES_WEB, "function resourcesSection("));
  const iosParam = swiftParameter(inBracket(rules, /static func resourcesSection\(/, RULES_IOS, "static func resourcesSection("));
  assert.equal(webParam.length, 3, `${RULES_WEB}: resourcesSection does not take (count, sum, measurement) — update the anchor`);
  assert.equal(iosParam.length, 3, `${RULES_IOS}: ServicesRules.resourcesSection does not take (count:, sum:, measureRow:) — update the anchor`);
  let webFn;
  try { webFn = new Function(...webParam, `"use strict";\n${tsBody(webQ, "resourcesSection", RULES_WEB)}`); }
  catch (e) { assert.fail(`${RULES_WEB}: the body of resourcesSection is no JS any more (${e.message}) — update the anchor`); }
  const iosFn = swiftAsFunction(swiftBody(rules, "resourcesSection", RULES_IOS), iosParam, RULES_IOS, "ServicesRules.resourcesSection");
  const SUM = { cpu: 3, memBytes: 210 * 2 ** 20, projects: [] };
  const MESS = { measured: 0, total: 3 };
  const raster = [];
  // The 0 first: it is the finding (resources already there, services not yet) — and the first line of a message.
  for (const count of [0, 1, 2, 3, -1]) for (const sum of [null, SUM]) for (const mess of [null, MESS]) raster.push({ count, sum, mess });
  const shows = (fn, f) => {
    let r;
    try { r = fn(f.count, f.sum, f.mess); } catch (e) { return `throws: ${e.message}`; }
    return r === true ? "Section" : r === false ? "no section" : `other: ${JSON.stringify(r)}`;
  };
  const fall = (f) => `(count ${f.count}, sum ${f.sum ? "yes" : "no"}, measureRow ${f.mess ? "yes" : "no"})`;
  const deviations = raster.filter((f) => shows(webFn, f) !== shows(iosFn, f)).map((f) => `${fall(f)}: Web "${shows(webFn, f)}" · iOS "${shows(iosFn, f)}"`);
  assert.deepEqual(deviations, [], `resourcesSection computes differently on the two sides — Web (${RULES_WEB}) and iOS (${RULES_IOS} ServicesRules.resourcesSection):\n  ${deviations.slice(0, 8).join("\n  ")}`);
  const desired = (f) => (f.count > 0 && (f.sum || f.mess) ? "Section" : "no section");
  const offSpec = raster.filter((f) => shows(webFn, f) !== desired(f)).map((f) => `${fall(f)}: both "${shows(webFn, f)}", meant "${desired(f)}"`);
  assert.deepEqual(offSpec, [], `both sides deviate together (the section stands only with running services, then with sum OR measureRow):\n  ${offSpec.slice(0, 8).join("\n  ")}`);

  // 2. The count that goes in is THE SAME as at the trigger — otherwise the section would again stand next to a muted
  //    trigger without a number (or the other way round).
  const callW = pill.match(/\{resourcesSection\(([^()]*)\)\s*&&\s*\(/);
  const loadW = pill.match(/\btriggerContent\(\s*(\w+)\s*,/);
  assert.ok(callW && loadW, `${PILL_WEB}: \`{resourcesSection(…) && (\` or \`triggerContent(n, …)\` not found — update the anchor`);
  // The ports button — it carries the number of running services.
  const buttonVar = inBracket(button, /\bprivate var portsButton: some View\s*\{/, BUTTON_IOS, "private var portsButton");
  // The count of the trigger is the one passed out as accessibilityValue (the XCUITest reads it).
  const countI = (buttonVar.match(/\.accessibilityValue\(Text\(verbatim:\s*"\\\((\w+)\)"\)\)/) || [])[1];
  const loadI = countI && buttonVar.match(new RegExp(String.raw`\blet\s+(${countI})\s*=\s*([\w.]+)\s*\n`));
  // And the performance button shows the service load only with the SAME count (like `counts` from
  // `triggerContent(n, …)` on the web): `let cpu … = n > 0 ? model.sum…` with `let n = <the same source>`.
  const perfVar = inBracket(button, /\bprivate var performanceButton: some View\s*\{/, BUTTON_IOS, "private var performanceButton");
  const perfN = perfVar.match(/\blet\s+(\w+)\s*=\s*([\w.]+)\s*\n[\s\S]*?\blet\s+cpu\s*:\s*String\?\s*=\s*(\w+)\s*>\s*0\s*\?\s*model\.sum\b/);
  const countsW = pill.match(/const \{ count, counts, muted \} = triggerContent\(\s*(\w+)\s*,/);
  const callI = button.match(/\bif\s+ServicesRules\.resourcesSection\(([^()]*)\)\s*\{/);
  assert.ok(loadI && callI, `${BUTTON_IOS}: \`let n = …\` for the count of the trigger (accessibilityValue) or \`if ServicesRules.resourcesSection(…) {\` not found — update the anchor`);
  const argI = Object.fromEntries(parts(callI[1]).map((a) => { const [k, ...v] = a.split(":"); return [k.trim(), v.join(":").trim()]; }));
  const web = {
    count: parts(callW[1])[0] === loadW[1] ? "the trigger's" : `"${parts(callW[1])[0]}", the trigger counts "${loadW[1]}"`,
    performanceCount: countsW && countsW[1] === loadW[1] ? "the trigger's" : "another count (update the anchor)",
  };
  const ios = {
    count: argI.count === loadI[2] ? "the trigger's" : `"${argI.count}", the trigger counts "${loadI[2]}"`,
    performanceCount: perfN && perfN[1] === perfN[3] && perfN[2] === loadI[2] ? "the trigger's" : `another count (${perfN ? `${perfN[3]} = ${perfN[2]}` : "no `let cpu: String? = n > 0 ? model.sum…`"})`,
  };
  console.log(`  [Web↔iOS resources section] ${raster.length} cases equal · count: Web ${web.count} · iOS ${ios.count}`);
  equal("count of the resources section", web, ios, [PILL_WEB, BUTTON_IOS]);
  assert.equal(web.count, "the trigger's", "both sides ask the section with another count than the trigger");
});

// ── (g) Server at the very top, with cbase's share ───────────────────────────────────────────
//
// In the performance overview the server comes first, and it also shows how much of the server's resources cbase
// takes (the bar is colored differently for the part cbase takes, per category CPU, RAM, etc.). The machine block used
// to be the LAST section of the performance menu. "Separated" (4) only holds THAT `data-host` stands in the performance
// menu, not where, so the order is bound here:
//  · web: in the performance menu `data-host` stands before `t("Resources")`; iOS: `machineSection(calculator)` before
//    `resources(model.sum)` and before `instancesSection(groups)`.
//  · per bar of the machine (RAM, CPU, swap, disk) the cbase part from the module (`cbasePart(host, kind)` /
//    `CbaseRules.part(calculator, .kind)`) — the pills do not compute it themselves; the split of the bar comes from
//    `progressBarParts` / `CbaseRules.progressBar` (bound to the web in cbase-share-binding.test.mjs, macOS only). The
//    project bars stay single-part. The legend appears ONCE, only with a part.
//  · iOS decodes `cbase` OPTIONALLY — a synthesised Decodable demands every key, and a gateway without it (or a failed
//    measurement) would otherwise empty the whole machine.
// Counter-test map: the two web blocks swapped back (machine under "Resources") ⇒ "Web: server not first"; iOS
// `machineSection(calculator)` behind the instances ⇒ "iOS: server not first"; `cbase={cbaseParts.swap?.share}` removed from the
// swap bar ⇒ "bar without cbase part"; iOS `decodeIfPresent` → `decode` ⇒ "decoder"; the web bar splitting itself
// (`cbase / share`) instead of via `progressBarParts` ⇒ "does not split via progressBarParts"; the legend without
// `withCbase` ⇒ "not under `withCbase`".
test("(g) server at the very top: the machine block before 'Resources' (web and iOS), per bar the cbase part from the module, the legend once, decoded optionally", () => {
  const pill = withoutComments(readRepo(PILL_WEB));
  const perf = pill.slice(pill.search(/\sdata-status-performance-menu\s/));
  const host = perf.search(/\bdata-host\b/);
  const res = perf.search(/\bt\("Resources"\)/);
  assert.ok(host > 0 && res > 0, `${PILL_WEB}: data-host or t("Resources") is not in the performance menu — update the anchor`);
  assert.ok(host < res, `Web: server not first — in the performance menu "Resources" (index ${res}) stands before the machine block data-host (index ${host})`);
  // Per kind: the part from the module, the bar receives it, the line "cbase …" stands below it.
  const block = perf.slice(perf.lastIndexOf("{host && (() => {", host), res);
  assert.ok(block.length > 500, `${PILL_WEB}: the machine block (\`{host && (() => {\`) cannot be found — update the anchor`);
  const KINDS = ["ram", "load", "swap", "disk"];
  const missing = [];
  for (const kind of KINDS) {
    if (!new RegExp(String.raw`\bcbasePart\(host, "${kind}"\)`).test(block)) missing.push(`${kind}: cbasePart(host, "${kind}")`);
    if (!new RegExp(String.raw`<ProgressBar share=\{\w+\} cbase=\{cbaseParts\.${kind}\?\.share\} />`).test(block)) missing.push(`${kind}: bar without cbase part`);
    if (!new RegExp(String.raw`\{cbaseRow\("${kind}"\)\}`).test(block)) missing.push(`${kind}: no line "cbase …"`);
  }
  assert.deepEqual(missing, [], `${PILL_WEB}: the cbase part is missing in the machine block`);
  assert.equal((block.match(/<ProgressBar\b/g) || []).length, 4, "the machine block does not have exactly four bars (RAM, CPU, swap, disk)");
  const resources = perf.slice(res);
  assert.ok(/<ProgressBar share=\{ramRatio\} top="mt-2" \/>/.test(resources), "the bar per project is no longer the single-part one — update the anchor");
  assert.ok(!/cbase=/.test(resources), "a project bar carries a cbase part — that belongs only to the server");
  assert.equal((pill.match(/\bdata-cbase-legend\b/g) || []).length, 1, "the legend does not stand exactly once");
  assert.ok(/\{withCbase && \(\s*<div\b[^>]*\bdata-cbase-legend\b/.test(block), "the legend does not stand under `withCbase` (no part, no legend)");
  const progressBar = inBracket(pill, /function ProgressBar\([^)]*\)[^{\n]*\{/, PILL_WEB, "function ProgressBar");
  assert.ok(/\bprogressBarParts\(\s*share\s*,\s*cbase\s*\)/.test(progressBar), `${PILL_WEB}: the bar does not split via progressBarParts(share, cbase) from the module`);
  assert.ok(!/\bcbase\s*\/\s*[\w(]|[\w)]\s*\/\s*share\b/.test(progressBar), `${PILL_WEB}: the bar computes the split itself`);

  // iOS
  const button = withoutComments(readRepo(BUTTON_IOS));
  const menu = inBracket(button, /\bprivate struct PerformanceMenu: View\s*\{/, BUTTON_IOS, "private struct PerformanceMenu");
  const body = inBracket(menu, /\bvar body: some View\s*\{/, BUTTON_IOS, "PerformanceMenu.body");
  const r = body.search(/\bmachineSection\(calculator\)/);
  const rs = body.search(/\bresources\(model\.sum\)/);
  const ia = body.search(/\binstancesSection\(groups\)/);
  assert.ok(r > 0 && rs > 0 && ia > 0, `${BUTTON_IOS}: machineSection(calculator), resources(model.sum) or instancesSection(groups) is missing in the body — update the anchor`);
  assert.ok(r < rs && r < ia, `iOS: server not first — machineSection (index ${r}) stands behind resources (${rs}) or the instances (${ia})`);
  assert.equal((body.match(/\bmachineSection\(/g) || []).length, 1, "iOS: the machine does not stand exactly once in the menu");
  const section = inBracket(menu, /\bprivate func machineSection\(_ calculator: MachineStatus\) -> some View\s*\{/, BUTTON_IOS, "machineSection");
  const missingI = [];
  for (const kind of KINDS) {
    if (!new RegExp(String.raw`CbaseRules\.part\(calculator, \.${kind}\)`).test(section)) missingI.push(`${kind}: CbaseRules.part(calculator, .${kind})`);
    if (!new RegExp(String.raw`cbase: cbase\w+\.map \{ \(\$0, servicesCbaseText\(calculator, \.${kind}, \$0\)\) \}`).test(section)) missingI.push(`${kind}: progressBarValue without cbase part`);
  }
  assert.deepEqual(missingI, [], `${BUTTON_IOS}: the cbase part is missing in the machine section`);
  assert.equal((button.match(/accessibilityIdentifier\("status-cbase-legend"\)/g) || []).length, 1, "iOS: the legend does not stand exactly once");
  const progressBarI = inBracket(button, /\bprivate struct ServicesProgressBar: View\s*\{/, BUTTON_IOS, "private struct ServicesProgressBar");
  assert.ok(/CbaseRules\.progressBar\(share: share, cbase: cbase\)/.test(progressBarI), "iOS: the bar does not split via CbaseRules.progressBar");
  // Decoder: `cbase` optional, every field optional.
  const rules = withoutComments(readRepo(RULES_IOS));
  assert.ok(/cbase = \(try\? c\.decodeIfPresent\(Cbase\.self, forKey: \.cbase\)\) \?\? nil/.test(rules), "iOS: `cbase` is not decoded optionally (decoder)");
  for (const f of ["memBytes", "cpuCores", "swapBytes", "diskBytes"]) {
    assert.ok(new RegExp(String.raw`${f}: c\.dblOpt\(\.${f}\)`).test(rules), `iOS: MachineStatus.cbase does not read ${f} via dblOpt (null means "not measured", never 0)`);
  }
  console.log(`  [server at the top] Web data-host ${host} < Resources ${res} · iOS machine ${r} < resources ${rs}, instances ${ia}; 4 bars per side with cbase part`);
});

// ── (f6) The machine waits for no other request ─────────────────────────────────────────────
//
// Complaint: when opening the mobile app it takes about a minute until the performance metrics are loaded. Measured:
// the iOS round asked services → resources → `/gw/host` → browser ONE AFTER ANOTHER, and the resources cost the backend
// about 22 s (one `docker stats` per project container in sequence — fixed in services.js, guarded in
// server/backend/test/projectbox-services.test.js). The server block and the color of the symbol (`calculator`, about
// 0.2 s) thus stood behind the resources, every opening of the popover began the chain anew (`menu(open:)` → `tick()`,
// bound in (f2)), and the return from the background asked chat list, workspaces and `/api/usage` first (deadline 8 s,
// with an expired token `claude doctor` up to 60 s) — a request on a dead socket hung until the client's deadline
// (45 s). The web already asked `/gw/host` in an effect of its own. Bound:
//  · web: the effect that asks `/gw/host` asks only that.
//  · iOS: the function with the `/gw/host` branch waits for nothing before it, and `refresh(run:)` starts it via
//    `async let` BEFORE `await client.get("/api/project-resources"`.
//  · iOS: in `.onChange(of: scenePhase)` (AppShell) there is no `await` before the call to `services`, and the call
//    restarts the tick (`tick()` cancels a hanging request).
// Counter-test map: the branch behind services and resources ⇒ "behind 2 await" (round) and "behind 4 await" (return);
// `async let` moved behind the resources request ⇒ "started after the resources".
const SHELL_IOS = "mobile/CbaseMobile/Shell/AppShell.swift";
test("Web ↔ iOS (f6): the machine (/gw/host) waits for no other request — not in the round and not on return from the background", () => {
  // Web
  const pill = withoutComments(readRepo(PILL_WEB));
  const hostEff = bracketAreas(pill, /\buseEffect\(/g, PILL_WEB).filter((b) => /["'`]\/gw\/host\b/.test(b.inside));
  assert.equal(hostEff.length, 1, `${PILL_WEB}: ${hostEff.length} effects ask /gw/host — exactly one expected (update the anchor)`);
  const requestsW = [...parts(hostEff[0].inside)[0].matchAll(/(?:\bapi(?:<[^>]*>)?|\bfetch)\(\s*[`"']([^`"'?$]+)/g)].map((m) => m[1]);
  const web = requestsW.length === 1 && requestsW[0] === "/gw/host" ? "own request" : `shares the effect with ${requestsW.join(", ") || "—"}`;

  // iOS, the round
  const iosQ = withoutComments(readRepo(RULES_IOS));
  const branch = /\bif let\s+\w+\s*(?::\s*[\w.[\]?]+)?\s*=\s*try\?\s*await\s+client\.get\(\s*"\/gw\/host"/g;
  const branches = [...iosQ.matchAll(branch)];
  assert.equal(branches.length, 1, `${RULES_IOS}: ${branches.length} branches \`if let … = try? await client.get("/gw/host")\` — exactly one expected (update the anchor)`);
  const zPos = branches[0].index;
  const headers = [...iosQ.slice(0, zPos).matchAll(/\bfunc (\w+)\(([^)]*)\)[^{\n]*\{/g)];
  assert.ok(headers.length, `${RULES_IOS}: no function before the /gw/host branch — update the anchor`);
  const header = headers.at(-1);
  const body = inBracket(iosQ.slice(header.index), /^[^{]*\{/, RULES_IOS, `func ${header[1]}`);
  const bodyFrom = header.index + header[0].length;
  assert.ok(bodyFrom + body.length > zPos, `${RULES_IOS}: the /gw/host branch is not in the body of func ${header[1]} — update the anchor`);
  const waitingPrior = [...iosQ.slice(bodyFrom, zPos).matchAll(/\bawait\b/g)].length;
  const refreshI = bracketAreas(iosQ, /\bfunc refresh\(run\b[^)]*\)[^{]*\{/g, RULES_IOS)[0];
  assert.ok(refreshI, `${RULES_IOS}: func refresh(run:) not found — update the anchor`);
  const resPos = refreshI.inside.search(/\bawait\s+client\.get\(\s*"\/api\/project-resources"/);
  assert.ok(resPos >= 0, `${RULES_IOS}: no \`await client.get("/api/project-resources"\` in refresh(run:) — update the anchor`);
  let round;
  if (waitingPrior) round = `waits: the branch stands in func ${header[1]} behind ${waitingPrior} await`;
  else if (header[1] === "refresh") round = "stands in the round itself";
  else {
    const start = refreshI.inside.search(new RegExp(String.raw`\basync\s+let\s+\w+\s*(?::\s*Void\s*)?=\s*(?:self\.)?${header[1]}\(`));
    round = start < 0 ? `func ${header[1]} is not started via async let in refresh(run:)`
      : start > resPos ? `func ${header[1]} is started after the resources` : "alongside the resources";
  }

  // iOS, the return from the background
  const shell = withoutComments(readRepo(SHELL_IOS));
  const phase = inBracket(shell, /\.onChange\(of:\s*scenePhase\)\s*\{/, SHELL_IOS, ".onChange(of: scenePhase)");
  const call = phase.match(/\bservices\?\.(\w+)\(/);
  assert.ok(call, `${SHELL_IOS}: no call \`services?.…(\` in .onChange(of: scenePhase) — update the anchor`);
  const waitingBack = [...phase.slice(0, call.index).matchAll(/\bawait\b/g)].length;
  const method = inBracket(iosQ, new RegExp(String.raw`\bfunc ${call[1]}\(\)[^{\n]*\{`), RULES_IOS, `func ${call[1]}()`);
  const returning = waitingBack ? `waits: services?.${call[1]}() behind ${waitingBack} await`
    : /\btick\(\)/.test(method) ? "at once, tick restarted" : `at once, but services?.${call[1]}() does not restart the tick (a hanging request would stay)`;

  console.log(`  [Web↔iOS machine does not wait] Web: ${web} · iOS round: ${round} · iOS return: ${returning}`);
  assert.equal(web, "own request", `${PILL_WEB}: the machine waits for another request`);
  assert.equal(round, "alongside the resources", `${RULES_IOS}: the machine (/gw/host) waits for the resources — server block and color would come only after them`);
  assert.equal(returning, "at once, tick restarted", `${SHELL_IOS}: the return from the background makes the service values wait`);
});
