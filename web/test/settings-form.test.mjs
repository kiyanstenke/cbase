// The basic form of the settings pages.
//
// Three promises. All three are matters of taste in the sense that breaking them breaks NOTHING: the page keeps rendering,
// no type is missing, no test but this one turns red. That is exactly why it stands here — a promise without a way that
// breaks it is none.
//
// (1) NO HAND-BUILT TOGGLE. `UsageSettings` and `BrowserSettings` once built it by hand (`h-6 w-11 rounded-full` plus an
//     absolutely positioned white knob) although `CbKit` has one that `NotificationSettings` uses. The replica is not only a
//     duplicate: it carries no `role="switch"` and no `aria-checked`, so it is no switch for a screen reader, and it does not
//     follow later changes of the kit. Hence the GENUS is measured (track + knob + own role), not just the one class chain.
//
// (2) NO VISIBLE EXPLANATORY PARAGRAPH OUTSIDE THE BUILDING BLOCKS. Ten of ten pages carried a sentence under their heading;
//     the heading now sits in the frame, the sentence is gone. Explanatory text lives as `hint`/`info` on `Row` or `Group` —
//     there the block clamps it to three lines and shows an (i) that makes the cut VISIBLE. A free <p> at page level bypasses
//     both. The rule is deliberately two-part because length alone does not separate: of the eight fallen page sentences two
//     were shorter (110, 156 characters) than the two that were allowed to stay (120, 146). What separates them is the
//     PLACE — at the very top, before everything else — and what makes a wall is the length. So both, each on its own.
//
// (3) PAGE AND GROUP LIST WEB <-> iOS. `SETTINGS_GROUPS` (SettingsModal.tsx) against the `CbSettingGroup`s in
//     `Settings/SettingsView.swift` — set, order AND the completeness count. The same pattern that once cost the app agent
//     `workflow` in the web and then seven days on the iPhone (see app-agents-catalog.test.mjs): a page is missing on ONE
//     device, without error, without a gap in the picture, without anyone looking. Two named exceptions, both MEASURED here
//     instead of kept quiet: "Environment" (web only in gateway mode, mobile always) and the group "Admin" (in BOTH clients
//     only for an admin — in the web at the filter in SettingsModal, on mobile as the ONLY condition of the list, around
//     exactly this group).
//     Counter-tests: the condition in SettingsView.swift laid around the group "Appearance & device" => red; the admin filter
//     in SettingsModal struck => red.
//
// Read BY PATH, from both trees, without import from mobile/ (model: coding-tab.test.mjs, app-agents-catalog.test.mjs). Whoever
// moves one of the files updates the line here.
//
// Run:  node --test web/test/settings-form.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const DIR = path.join(repo, "web", "src", "components", "settings");
const SOURCE_MODAL = path.join(DIR, "SettingsModal.tsx");
const SOURCE_KIT = path.join(DIR, "SettingsKit.tsx");
const SOURCE_CBKIT = path.join(repo, "web", "src", "components", "CbKit.tsx");
const SOURCE_IOS = path.join(repo, "mobile", "CbaseMobile", "Settings", "SettingsView.swift");

const read = (p) => fs.readFileSync(p, "utf8");
const short = (p) => path.relative(repo, p);

// What is in the folder and is NO page. Everything else is one — so a new page automatically falls under every rule here
// instead of waiting for a list nobody updates. `UsageKit.tsx` carries only the building blocks that the Usage subpages
// share — the subpages themselves (`Usage<Subpage>.tsx`) are pages and stand under every rule here.
const NO_PAGE = new Set(["SettingsKit.tsx", "SettingsModal.tsx", "UsageKit.tsx"]);

function files() {
  return fs.readdirSync(DIR).filter((n) => n.endsWith(".tsx")).sort();
}
function pagesFiles() {
  return files().filter((n) => !NO_PAGE.has(n));
}

// Comments drop out BEFORE every measurement — in two forms, since JSX has its own. The house writes the reason at the place
// where it applies; a sentence above a line ("here a <p> with the explanation stood") is exactly what this test asks for and
// must not turn it red itself.
function withoutComments(text) {
  return text
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((z) => (/^\s*\/\//.test(z) ? "" : z))
    .join("\n");
}

// Every anchor THROWS if it grabs into the void. The silent death of a source measurement is the empty set: it equals every
// other empty set, and the test stays green without having measured anything.
function cut(sourcePath, text, pattern, declaration) {
  const block = text.match(pattern);
  assert.ok(
    block,
    `Declaration "${declaration}" not found in ${short(sourcePath)} — rebuilt or ` +
      "reformatted? Update the anchor here, do NOT delete the test.",
  );
  return block[1];
}

// And every anchor counts what it SKIPPED: a regex measures the spelling it knows, and the next line is written in one nobody
// thought of.
function complete(rows, read, looks, sourcePath, hint) {
  const candidates = rows.filter(looks);
  assert.equal(
    candidates.length,
    read.length,
    `${short(sourcePath)}: ${candidates.length} rows look like an entry, rows read: ` +
      `${read.length}. ${hint}\nRows:\n` +
      candidates.map((z) => "  " + z.trim()).join("\n") +
      `\nRead: ${read.join(", ")}`,
  );
}

// ── (1) The toggle ───────────────────────────────────────────────────────────────────────────

// Every `className` of a file, as raw text: both "…" and {`…`}. The raw text suffices — what is measured is which utilities
// stand together on ONE element, not their value.
function classesChains(text) {
  const out = [];
  for (const m of text.matchAll(/className=\{?`([^`]*)`\}?/g)) out.push({ chain: m[1], index: m.index });
  for (const m of text.matchAll(/className="([^"]*)"/g)) out.push({ chain: m[1], index: m.index });
  return out;
}

test("Settings: no hand-built toggle", () => {
  // The three traces of a replica, each red on its own. Together they cover the genus: the track (a wide, round rectangle),
  // the knob (absolute, light) and the role (whoever builds their own toggle either adds `role="switch"` — then it is a
  // second toggle — or leaves it out, then it is none for a screen reader).
  const error = [];
  let chains = 0;
  for (const n of files()) {
    const p = path.join(DIR, n);
    const text = withoutComments(read(p));
    for (const { chain, index } of classesChains(text)) {
      chains++;
      const row = text.slice(0, index).split("\n").length;
      // (a) the measured old track, verbatim as it stood twice
      if (/\bh-6 w-11\b/.test(chain)) {
        error.push(`${short(p)}:${row} — track "h-6 w-11" (the old handwork): ${chain.trim()}`);
        continue;
      }
      // (b) the genus: an absolute, round, light knob is the button of a toggle and has no other purpose in a settings
      //     PAGE.
      if (/\babsolute\b/.test(chain) && /\brounded-full\b/.test(chain) && /\bbg-white\b/.test(chain)) {
        error.push(`${short(p)}:${row} — knob (absolute + rounded-full + bg-white): ${chain.trim()}`);
      }
    }
    // (c) an own switch role in the folder: the house toggle stands in CbKit.
    for (const m of text.matchAll(/role="switch"/g)) {
      const row = text.slice(0, m.index).split("\n").length;
      error.push(`${short(p)}:${row} — own role="switch"`);
    }
  }
  assert.deepEqual(
    error,
    [],
    "A hand-built toggle stands under web/src/components/settings/ again:\n  " +
      error.join("\n  ") +
      "\n\nThe house toggle is `Toggle` from @/components/CbKit — it carries " +
      "role=\"switch\" and aria-checked, a replica does not.",
  );

  // The opposite direction: the kit toggle must EXIST and be used here. Without this half the test would stay green if someone
  // struck all toggles without replacement — and "no replica" would be true without meaning anything.
  const kit = read(SOURCE_CBKIT);
  assert.match(
    kit,
    /export function Toggle\(\{[^}]*\}[\s\S]{0,400}?role="switch"/,
    short(SOURCE_CBKIT) +
      ": `Toggle` no longer exists or carries no role=\"switch\". It is the component this guard points the pages to — " +
      "whoever replaces it updates this line.",
  );
  let user = 0;
  let places = 0;
  for (const n of pagesFiles()) {
    const text = withoutComments(read(path.join(DIR, n)));
    const hits = [...text.matchAll(/<Toggle\b/g)].length;
    if (hits) { user++; places += hits; }
  }
  assert.ok(
    places > 0,
    "Not a single settings page still uses `Toggle` from the kit. Either all " +
      "toggles are gone (then that is a decision that belongs justified here), or " +
      "they are named differently now — then this guard is blind.",
  );
  console.log(
    `  [Settings] ${chains} className chains checked, 0 replicas; ` +
      `kit toggle in ${places} places on ${user} pages`,
  );
});

// ── (2) The explanatory text ─────────────────────────────────────────────────────────────────

// The literals in a piece of JSX, summed up. Interpolations ({subtitle}, {error}) count ZERO — deliberately: what comes in at
// runtime is state, not explanatory text, and its length is not in this file.
function literalLength(raw) {
  return [...raw.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((m) => m[1])
    .filter((s) => s.length > 2)
    .reduce((a, b) => a + b.length, 0);
}

function paragraphs(text) {
  return [...text.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => ({
    raw: m[1],
    index: m.index,
    length: literalLength(m[1]),
    row: text.slice(0, m.index).split("\n").length,
  }));
}

// The spans in which a paragraph is CONTENT and not explanation: the preview shows what something will look like — there the
// text IS what is shown.
function previewSpans(text) {
  const out = [];
  for (const m of text.matchAll(/<Preview\b/g)) {
    const end = text.indexOf("</Preview>", m.index);
    if (end > 0) out.push([m.index, end]);
  }
  return out;
}
const inSpan = (i, spans) => spans.some(([a, b]) => i > a && i < b);

// The cap for a free paragraph. Measured, not guessed: the three-line clamp of a `hint` carries about 165 characters in the
// NARROWEST column of this modal (models page, 680 px page minus a ~220 px wide select, 12 px font). 200 is the next round
// number above: anything longer would be a wall EVEN as a hint and belongs behind the (i). For comparison the page sentences
// that fell: 432 (hooks), 294, 272 (models), 270 (usage), 231, 215, 181, 177 (browser) characters.
const CAP = 200;

test("Settings: no page begins with an explanatory paragraph", () => {
  // The finding: "ten of ten pages carry a sentence under the heading". The heading now sits in the frame (SettingsModal),
  // the sentence is gone. What is measured is the FIRST unconditional child of the page: an `{error && <p …>}` before it is
  // state and stays allowed — it stands there only if something went wrong.
  const error = [];
  const beginnings = [];
  for (const n of pagesFiles()) {
    const p = path.join(DIR, n);
    const base = n.replace(/\.tsx$/, "");
    const text = withoutComments(read(p));
    const body = cut(
      p, text,
      new RegExp(`export function ${base}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n  return \\(\\n    <[^\\n]*\\n([\\s\\S]*?)\\n  \\);`),
      `export function ${base}() … return ( <wrapper>`,
    );
    // The children of the shell stand exactly one level deeper (6 spaces). Rows indented deeper belong to a child and are not
    // meant here.
    const kind = body
      .split("\n")
      .filter((z) => /^ {6}[<{]/.test(z) && !z.startsWith("      </"))
      .map((z) => z.trim())[0];
    assert.ok(
      kind,
      `${short(p)}: no child found on the first level of the page shell — has the shell been ` +
        "rebuilt (fragment instead of <div>, other indentation)? Update the anchor here.",
    );
    beginnings.push(`${base}: ${kind.slice(0, 40)}`);
    const tag = kind.match(/^<([A-Za-z][\w.]*)/);
    if (tag && ["p", "h1", "h2", "h3"].includes(tag[1])) {
      error.push(`${short(p)} begins with <${tag[1]}>: ${kind.slice(0, 100)}`);
    }
  }
  assert.deepEqual(
    error,
    [],
    "A settings page carries a page sentence or a heading of its own again:\n  " +
      error.join("\n  ") +
      "\n\nThe heading comes from the frame (SettingsModal reads " +
      "`SECTIONS.label`), and explanatory text belongs as `hint` on the `Row` or the `Group` " +
      "it speaks to — there the block clamps it to three lines and shows the (i). " +
      "Keep the page free of headings and sentences of its own.",
  );
  console.log(`  [Settings] ${beginnings.length} pages, first child per page: ${beginnings.join(" · ")}`);
});

test("Settings: no free paragraph over the three-line cap, no heading with an explanatory paragraph", () => {
  const tooLong = [];
  const subtitle = [];
  let measured = 0;
  let longest = 0;

  for (const n of files()) {
    const p = path.join(DIR, n);
    const text = withoutComments(read(p));
    const preview = previewSpans(text);

    for (const a of paragraphs(text)) {
      measured++;
      // In a <Preview> the text IS what is shown, not the explanation of it.
      if (inSpan(a.index, preview)) continue;
      longest = Math.max(longest, a.length);
      if (a.length > CAP) {
        tooLong.push(
          `${short(p)}:${a.row} — ${a.length} characters (cap ${CAP}): ` +
            a.raw.replace(/\s+/g, " ").trim().slice(0, 90) + "…",
        );
      }
    }

    // Heading plus paragraph: the subtitle of ONE card is allowed (on the provider page a line of state, mostly an
    // interpolation, stands under every <h3>). What is caught here is the heading with an explanatory paragraph below — the
    // form in which the page sentence once stood ten times.
    for (const m of text.matchAll(/<(h[123])\b[^>]*>[\s\S]*?<\/\1>\s*(?:\{[^{}]*\}\s*)?<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      const length = literalLength(m[2]);
      if (length > 60) {
        subtitle.push(
          `${short(p)}:${text.slice(0, m.index).split("\n").length} — <${m[1]}> with ${length} ` +
            "characters of paragraph below: " + m[2].replace(/\s+/g, " ").trim().slice(0, 80) + "…",
        );
      }
    }
  }

  assert.deepEqual(
    tooLong,
    [],
    "A free paragraph under web/src/components/settings/ is longer than the three-line clamp " +
      "of a hint carries:\n  " + tooLong.join("\n  ") +
      "\n\nSo long, it belongs as `hint` on the `Row` or `Group` it speaks to: the " +
      "block clamps it to three lines and shows the (i) with the full wording. A " +
      "free <p> bypasses both — it is the wall again. " +
      "No wording has to change for this: it is the same string.",
  );
  assert.deepEqual(
    subtitle,
    [],
    "A heading with an explanatory paragraph below:\n  " + subtitle.join("\n  ") +
      "\n\nOne-line subtitles in a card are meant and allowed (provider page); a whole sentence under a heading is the page " +
      "sentence in small.",
  );
  console.log(
    `  [Settings] ${measured} <p> measured, longest free paragraph ${longest} characters ` +
      `(cap ${CAP}), 0 headings with explanatory paragraph`,
  );
});

test("Settings: only the frame carries an <h2>", () => {
  // The page heading stands ONCE — in the header of the modal. A second one in the page would not be wrong but doubled, and
  // that is how the finding arose: `GitlabSettings` called itself "GitLab" in its own heading and "Integrations" in the
  // navigation. There is no named exception: the provider sheet with an own frame and title is gone.
  const EXCEPTIONS = {};
  const error = [];
  for (const n of pagesFiles()) {
    const p = path.join(DIR, n);
    const count = [...withoutComments(read(p)).matchAll(/<h2\b/g)].length;
    const allowed = EXCEPTIONS[n] ?? 0;
    if (count !== allowed) error.push(`${short(p)}: ${count} <h2>, allowed ${allowed}`);
  }
  assert.deepEqual(
    error,
    [],
    "The number of <h2> is wrong:\n  " + error.join("\n  ") +
      "\n\nThe heading comes from the frame. If a page needs a frame of its own with a title again (a sheet over the modal), it " +
      "belongs here as a named exception.",
  );
  assert.match(
    read(SOURCE_MODAL),
    /<h2 className="min-w-0 flex-1 truncate/,
    short(SOURCE_MODAL) +
      ": the header no longer carries an <h2>. Then the open page has a heading NOWHERE — " +
      "and the promise of this guard would be fulfilled by being empty.",
  );
});

// ── (3) The binding web <-> iOS ──────────────────────────────────────────────────────────────

function webGroups() {
  const text = read(SOURCE_MODAL);
  const block = cut(
    SOURCE_MODAL, text,
    /export const SETTINGS_GROUPS: \{ title: string; keys: string\[\] \}\[\] = \[\n([\s\S]*?)\n\];/,
    "export const SETTINGS_GROUPS",
  );
  const rows = withoutComments(block).split("\n").filter((z) => z.trim());
  const groups = rows
    .map((z) => z.match(/\{ title: "([^"]+)", keys: \[([^\]]*)\] \}/))
    .filter(Boolean)
    .map((m) => ({ title: m[1], keys: [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]) }));
  complete(
    rows, groups.map((g) => g.title), (z) => /\btitle\s*:/.test(z), SOURCE_MODAL,
    "A group written differently (multi-line, single quotes, a " +
      "key from a variable) would run past this regex — and the pages in it " +
      "would be absent from the comparison with iOS.",
  );
  // The label per key stands in SECTIONS, and it IS the dictionary key (t() when rendering) — on mobile the same string stands
  // in L(…). So the wording is compared.
  const sectionsBlock = cut(
    SOURCE_MODAL, text,
    /const SECTIONS: Section\[\] = \[\n([\s\S]*?)\n\];/,
    "const SECTIONS: Section[]",
  );
  const sRows = withoutComments(sectionsBlock).split("\n").filter((z) => z.trim());
  const labels = new Map();
  for (const z of sRows) {
    const m = z.match(/\{ key: "([^"]+)", label: "([^"]+)"/);
    if (m) labels.set(m[1], m[2]);
  }
  complete(
    sRows, [...labels.keys()], (z) => /\bkey\s*:/.test(z), SOURCE_MODAL,
    "A page whose row looks different would have no label here — and the " +
      "comparison with iOS would run against `undefined`.",
  );
  return { groups, labels };
}

function iosGroups() {
  // The list is `CbList` (ground and rows in the palette, Kit/CbColor.swift) or `List`.
  const text = withoutComments(read(SOURCE_IOS));
  const list = cut(
    SOURCE_IOS, text,
    /NavigationStack \{\n {12}(?:Cb)?List \{\n([\s\S]*?)\n {12}\}\n {12}\.navigationTitle/,
    "NavigationStack { List { … } .navigationTitle",
  );
  const rows = list.split("\n").filter((z) => z.trim());
  const groups = [];
  for (const z of rows) {
    const g = z.match(/CbSettingGroup\(title: L\("([^"]+)"\)\)/);
    if (g) { groups.push({ title: g[1], entries: [] }); continue; }
    const r = z.match(/^\s*row\(L\("([^"]+)"\)/);
    if (r) {
      assert.ok(groups.length, `${short(SOURCE_IOS)}: row "${r[1]}" stands before the first group.`);
      groups[groups.length - 1].entries.push(r[1]);
    }
  }
  complete(
    rows, groups.map((g) => g.title), (z) => /CbSettingGroup\(/.test(z), SOURCE_IOS,
    "A group called differently (title from a constant, multi-line) is absent for " +
      "this test — and the pages in it would be unbound.",
  );
  complete(
    rows, groups.flatMap((g) => g.entries), (z) => /^\s*row\(/.test(z), SOURCE_IOS,
    "A row that does not pass the title as an L(\"…\") literal in first place would run past the " +
      "regex — the page would be bound without being checked.",
  );
  return groups;
}

test("Settings: groups and pages stand the same in web and iOS — set, order, count", () => {
  const { groups: web, labels } = webGroups();
  const ios = iosGroups();

  // First the web side against itself: a key in a group that SECTIONS does not have is a dead entry; a page in SECTIONS that
  // stands in no group is unreachable — the list is built from the groups, not from SECTIONS.
  const inGroups = web.flatMap((g) => g.keys);
  const unknown = inGroups.filter((k) => !labels.has(k));
  assert.deepEqual(
    unknown, [],
    "These keys stand in SETTINGS_GROUPS but in no SECTION: " + unknown.join(", "),
  );
  const homeless = [...labels.keys()].filter((k) => !inGroups.includes(k));
  assert.deepEqual(
    homeless, [],
    "These pages stand in SECTIONS but in NO group — so they are reachable nowhere in the modal, without error and " +
      "without a gap in the picture: " + homeless.join(", "),
  );

  const webTitle = web.map((g) => g.title);
  const iosTitle = ios.map((g) => g.title);
  assert.deepEqual(
    iosTitle, webTitle,
    "The groups diverge.\n  Web: " + webTitle.join(" · ") +
      "\n  iOS: " + iosTitle.join(" · ") +
      "\nSource of the order is SETTINGS_GROUPS in " + short(SOURCE_MODAL) + ".",
  );

  for (let i = 0; i < web.length; i++) {
    const expected = web[i].keys.map((k) => labels.get(k));
    assert.deepEqual(
      ios[i].entries, expected,
      `Group "${web[i].title}" does not carry the same pages in the same ` +
        "order in web and iOS.\n  Web: " + expected.join(" · ") + "\n  iOS: " + ios[i].entries.join(" · ") +
        "\nA page that stands on only ONE device is missing on the other without an error message " +
        "and without a gap in the picture — that is how the app agent `workflow` diverged for seven " +
        "days (see app-agents-catalog.test.mjs).",
    );
  }

  // The FIRST named exception. It stands here as a MEASUREMENT and not as silence: both lists carry "Environment", but in the
  // web the entry hangs on gateway mode, on mobile not — on the phone there is no other mode, the app always talks to a server.
  // If one of the two halves falls away, that is a decision and belongs here.
  assert.match(
    read(SOURCE_MODAL),
    /!!gw \|\| s\.key !== "environment"/,
    short(SOURCE_MODAL) +
      ": \"Environment\" no longer hangs on gateway mode. In local mode (without gateway) there is no " +
      "server environment — the page would stand empty in the list.",
  );
  // The SECOND named exception: the group "Admin" stands in BOTH clients only for an admin. In the web at the same filter as
  // "Environment"; on mobile as the ONLY condition of the list, and it encloses exactly this group — a second condition or one
  // that encloses more would be a third, unchecked exception.
  assert.match(
    read(SOURCE_MODAL),
    /gw\?\.user\.role === "admin" \|\| s\.key !== "administration"/,
    short(SOURCE_MODAL) +
      ": \"Admin\" no longer hangs on the admin role. Every path in it is admin-only in the gateway " +
      "— for another user a page would stand there whose loading ends in 403.",
  );
  const iosList = cut(
    SOURCE_IOS, withoutComments(read(SOURCE_IOS)),
    /NavigationStack \{\n {12}(?:Cb)?List \{\n([\s\S]*?)\n {12}\}\n {12}\.navigationTitle/,
    "NavigationStack { List { … }",
  );
  const ADMIN_CONDITION = 'if session.user?.role == "admin" {';
  const iosRows = iosList.split("\n");
  const conditions = iosRows.map((z, i) => ({ z: z.trim(), i })).filter(({ z }) => /^(if|switch)\b/.test(z));
  assert.deepEqual(
    conditions.map(({ z }) => z),
    [ADMIN_CONDITION],
    short(SOURCE_IOS) +
      ": the mobile list carries a condition other than the ONE named around \"Admin\". On mobile every " +
      "other page stands unconditionally (\"Environment\" included) — a condition here would be another, " +
      "unchecked exception. If it is meant to be, it belongs named in this test.",
  );
  const enclosed = [];
  for (let j = conditions[0].i + 1, depth = 1; j < iosRows.length && depth > 0; j++) {
    depth += (iosRows[j].match(/\{/g) || []).length - (iosRows[j].match(/\}/g) || []).length;
    if (depth > 0) enclosed.push(iosRows[j]);
  }
  const enclosedGroups = enclosed.map((z) => z.match(/CbSettingGroup\(title: L\("([^"]+)"\)\)/)?.[1]).filter(Boolean);
  const administrationGroup = web.find((g) => g.keys.includes("administration"));
  assert.ok(administrationGroup, "SETTINGS_GROUPS carries the page \"administration\" in no group");
  assert.deepEqual(
    enclosedGroups,
    [administrationGroup.title],
    short(SOURCE_IOS) + ": the admin condition does not enclose exactly the group \"" + administrationGroup.title + "\", but: " +
      (enclosedGroups.join(", ") || "no group"),
  );

  console.log(
    `  [Settings] ${web.length} groups, ${inGroups.length} pages — web and iOS ` +
      `congruent; 2 named exceptions (Environment: web only in gateway mode, mobile always; ` +
      `Admin: in both only for admins)`,
  );
});

// ── ONE default model per provider ─────────────────────────────────────────────────────────────
// A third-party provider used to carry two "default model" fields: the row under Settings -> Provider (`PUT /api/default-model`,
// read by every run) and one in the provider editor (`defaultModel` in the body of `/api/provider-configs`, read only by the
// connector) — measured: two ways, two models. The row remains, in BOTH clients; the editor shows none and sends none. There
// is no editor in any client any more — free providers are deleted, OpenRouter has a fixed card without a model field. So the
// promise reads: "no editor, no body with `defaultModel`, no route `/api/provider-configs`".
// Counter-tests: the picker back in the iOS editor => red; `defaultModel:` back in the web save body => red; `defaultModel: "x"`
// put into the body of `POST /api/provider` (ProviderSettings.tsx, `setActive`) => red ("a body sends a default model past the
// row on another route").
test("ONE default model per provider — the row of the provider page, in web and iOS; no editor any more that carries a second one", () => {
  const swiftWithoutComments = (text) => text.split("\n").map((z) => z.replace(/\/\/.*$/, "")).join("\n");
  const web = withoutComments(read(path.join(DIR, "ProviderSettings.tsx")));
  assert.ok(!web.includes("function ProviderFormSheet("), "Web: the provider editor is back");
  assert.ok(!web.includes("/api/provider-configs"), "Web: the page talks to /api/provider-configs again (no longer exists on the server)");
  assert.doesNotMatch(web, /JSON\.stringify\(\{[^}]*\bdefaultModel\b/, "Web: a body sends a default model past the row on another route");
  assert.equal([...web.matchAll(/<Group title=\{t\("Default model"\)\}>/g)].length, 1, "Web: the ONE row per provider");
  assert.match(web, /\/api\/default-model/, "… and it writes via PUT /api/default-model");

  const iosDir = path.join(repo, "mobile", "CbaseMobile");
  assert.ok(!fs.existsSync(path.join(iosDir, "Settings", "ProviderEditor.swift")), "iOS: the provider editor (Settings/ProviderEditor.swift) still stands");
  const pageIos = swiftWithoutComments(read(path.join(iosDir, "Settings", "ProviderSettings.swift")));
  assert.doesNotMatch(pageIos, /"defaultModel":/, "iOS: a body sends a default model");
  assert.ok(!pageIos.includes("/api/provider-configs"), "iOS: the page talks to /api/provider-configs again");
  assert.match(pageIos, /CbSettingRow\(title: L\("Default model"\)\)/, "iOS: the ONE row per provider");
  assert.match(pageIos, /"\/api\/default-model"/, "… and it writes via PUT /api/default-model");
});

// ── The settings of the dynamic workflows in BOTH clients ─────────────────────────────────────
// The group "Dynamic workflows" (on the "Workflows" page) lies on the same page in web AND iOS — the page binding above
// therefore does not see if ONE row in it stands on only one device. What is bound here is the route of each setting
// (`/api/dyn-workflow-…`, the same set in the settings sources of both clients) and the label of the steps of the size
// guideline (the same steps as the server, `dynworkflows/size.js` SIZES, and the same words). Counter-test: the iOS row
// (Settings/WorkflowSizeSection.swift) put aside => red.
test("Dynamic workflows: every setting stands in web AND iOS — same routes, steps of the size guideline labelled the same", () => {
  const swiftWithoutComments = (text) => text.split("\n").map((z) => z.replace(/\/\/.*$/, "")).join("\n");
  const routes = (texts) => new Set(texts.flatMap((t) => [...t.matchAll(/["'`](\/api\/dyn-workflow-[a-z-]+)["'`]/g)].map((m) => m[1])));
  const webTexts = files().map((n) => withoutComments(read(path.join(DIR, n))));
  const iosDir = path.join(repo, "mobile", "CbaseMobile", "Settings");
  const iosTexts = fs.readdirSync(iosDir).filter((n) => n.endsWith(".swift")).map((n) => swiftWithoutComments(read(path.join(iosDir, n))));
  const web = [...routes(webTexts)].sort();
  const ios = [...routes(iosTexts)].sort();
  assert.ok(web.includes("/api/dyn-workflow-cap") && web.includes("/api/dyn-workflow-size"), `Web: ${web}`);
  assert.deepEqual(ios, web, "iOS and web set the same settings of the dynamic workflows");

  const server = read(path.join(repo, "server", "backend", "electron", "server", "dynworkflows", "size.js"));
  const stages = JSON.parse(/export const SIZES = Object\.freeze\((\[[^\]]*\])\)/.exec(server)[1]);
  const webSource = read(path.join(DIR, "WorkflowsSettings.tsx"));
  const block = /const SIZE_LABEL[^{]*\{([^}]*)\}/.exec(webSource);
  assert.ok(block, "anchor: SIZE_LABEL in WorkflowsSettings.tsx");
  const webLabel = Object.fromEntries([...block[1].matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const iosSource = read(path.join(iosDir, "WorkflowSizeSection.swift"));
  const iosLabel = Object.fromEntries([...iosSource.matchAll(/case "(\w+)": return L\("([^"]*)"\)/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(webLabel), stages, "Web labels exactly the steps of the server");
  assert.deepEqual(iosLabel, webLabel, "iOS labels them word for word");
});
