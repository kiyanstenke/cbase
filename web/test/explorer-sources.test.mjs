// The explorer as in VS Code, in the sources - what the pure computations (explorer-tree/-names/-decoration/-actions) do not see: the
// drawing in components/code/explorer/ and its connection in CodePane. Each promise has a counter-test (a copy with ONE changed spot
// that occurs exactly once in the source); the check must fail on it.
//
//   Menu             through a portal on the body, sheet `cb-pop` (popClass), rows from the kit, shortcut on the right, NO `fixed inset-0` -
//                    it closes via a document mousedown outside `[data-tree-menu]`.
//   Symbols          files ONLY via FileSymbol (Seti), folders without symbol, no own SVG in the row.
//   Form             indent 8 px per level, arrow 16 px, row 22 px / 13 px, indent lines only on hover.
//   Addresses        only via `calls` (instance choice, web/test/code-instance.test.mjs), download with instance, no `fetch` in the explorer.
//   Git              "ignored" from the server (`/git/ignored`), reread when the git state changes; colors from the cards.
//   Problems         only with a visible tree, only after the pause, only the answer of the last run; ONE source with tab color and status
//                    bar (lib/diagnostic-status.ts): after every pause ALL open tabs are asked (otherwise a tab in the background stayed
//                    red), read from the stock, no own stock.
//   Field            preselection without extension, notice with role, an error keeps the field open.
//   Dragging         expand after 500 ms, alt copies, never into itself, files from outside keep uploading.
//   CodePane         ONE tree (the old one is gone), activity bar, "Find in Folder..." opens the search with the folder, the active file is
//                    shown, the chosen view underlined.
//   Texts            every `t("...")` of the explorer is in lib/i18n-de.ts; every file in the folder is registered here (a new one would
//                    otherwise be seen by no one).
//   Repairs          keys and menu come from `keyToAction`/`menuPlan`, every action hits the FOCUS (the segment); focus returns after
//                    enter/Esc in the field and after menu actions; a drag carries explorer and instance, foreign ones are rejected;
//                    moving by drag asks with "Do not ask me again" (browser storage in try/catch), an occupied name "Replace?"; paste via
//                    `insertTargets`, a single file opens fixed; run numbers per folder and for "ignored", reread on git state,
//                    "ignored" debounced, chains of the server seeded, open chains with all segments; `autoRevealExclude` except
//                    explicitly; omitted and clipped said; deleted things drop out of `children`/`openSet`; `aria-activedescendant`, `treeitem`
//                    for "loading"/"new", the root as a button; the field grows with the text scale; the symbol in the field follows the
//                    input, no own bullet; "Open in Terminal" as a hook up to CodePane.
//   Slices           "Open in Integrated Terminal" starts a NEW terminal in the folder (code-layout `newTerminal`, TerminalPanel sends `cwd`);
//                    the sections (ExplorerSections: tree controlled via `collapsed`/`toggle`, storage in try/catch, drag bar only between two open
//                    ones, the outline ONCE for tab and section); the timeline (`POST .../git/log` with `timeAxis`, run number, "unknown"
//                    != "no repo", click -> diff tab in the chat, special view on the page); sticky scroll (measured while scrolling,
//                    shadow from `--tree-shadow`); the search widget (alt+cmd+F, hits marked, Esc closes, down into the tree, hint
//                    "only loaded").
//
// Run:  node --test --test-reporter=tap web/test/explorer-sources.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const FOLDER = ["src", "components", "code", "explorer"];
const FILES = {
  menu: "TreeMenu.tsx", tree: "ExplorerTree.tsx", row: "TreeRow.tsx", header: "ExplorerHeader.tsx", field: "InlineField.tsx",
  hook: "useExplorer.ts", problems: "tree-problems.ts",
  sections: "ExplorerSections.tsx", timeAxis: "TimeAxis.tsx", sticky: "TreeSticky.tsx", search: "TreeSearch.tsx", window: "TreeWindow.tsx",
};
const Q = {
  ...Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, read(...FOLDER, f)])),
  list: fs.readdirSync(path.join(webDir, ...FOLDER)).filter((f) => /\.tsx?$/.test(f)).sort(),
  codePane: read("src", "components", "CodePane.tsx"),
  chatCode: read("src", "components", "chat", "ChatCodeArea.tsx"),
  layout: read("src", "components", "code", "panel", "code-layout.ts"),
  terminalPanel: read("src", "components", "TerminalPanel.tsx"),
  prompts: read("src", "components", "Prompts.tsx"),
  css: read("src", "app", "globals.css"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const block = (css, sel) => {
  const i = css.indexOf(`\n${sel} {\n`);
  assert.ok(i >= 0, `globals.css: ${sel} not found (stale anchor)`);
  return css.slice(i, css.indexOf("\n}", i + 1));
};
const has = (s, part, notice) => assert.ok(s.includes(part), notice);

/** The keys of all `t("...")` in the explorer. */
const key = (q) => [...new Set(Object.keys(FILES).flatMap((k) => [...withoutComments(q[k]).matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`))))];

function check(q) {
  // Every file in the folder is registered here - otherwise the checks below would run past it.
  assert.deepEqual(q.list, Object.values(FILES).sort(), "components/code/explorer/ has a file this guard does not know (add it to FILES)");
  const ex = Object.fromEntries(Object.keys(FILES).map((k) => [k, withoutComments(q[k])]));
  const c = withoutComments(q.codePane);

  // Menu
  has(ex.menu, "return createPortal(", "the context menu is not in a portal on the body");
  has(ex.menu, "    document.body,\n", "the context menu is not in a portal on the body");
  has(ex.menu, "className={`${popClass} fixed z-50", "the context menu does not carry `cb-pop` (popClass)");
  has(ex.menu, "className={point.danger ? menuRowDanger : menuRow}", "the menu row is not the kit row");
  has(ex.tree, 'case "erase": return { label: t("Delete"), shortcut: "⌘⌫", run: ', "\"Delete\" in the explorer menu is colored differently from VS Code or has no shortcut");
  has(ex.hook, "const w = deleteWarning(list, oRef.current.unsaved?.() ?? []);", "deleting does not ask about unsaved changes (VS Code `deleteFiles`)");
  has(c, "unsaved: () => allBuffers().filter((p) => p.dirty)", "CodePane does not report the unsaved buffers to the explorer");
  assert.ok(/data-tree-shortcut>\{point\.shortcut\}<\/span>/.test(ex.menu), "the shortcut is not on the right of the row");
  has(ex.menu, `!e.target.closest("[data-tree-menu]")`, "the menu does not close on a click outside");
  has(ex.menu, `document.addEventListener("mousedown", onOutside, true);`, "the menu does not close on a click outside");
  for (const k of Object.keys(FILES)) assert.ok(!/inset-0/.test(ex[k]), `${FILES[k]}: a click catcher as fixed inset-0`);
  assert.ok(!/role="menu"/.test(ex.tree) && ex.tree.includes("<TreeMenu "), "ExplorerTree builds its own menu instead of TreeMenu");

  // Symbols
  has(ex.row, `import { FileSymbol } from "@/components/code/FileSymbol";`, "TreeRow does not take the file symbols from FileSymbol.tsx");
  has(ex.row, "{!folder && !field && <FileSymbol path={row.path}", "a folder gets a file symbol (VS Code: folders without symbol)");
  assert.equal(ex.row.split("<FileSymbol").length - 1, 1, "TreeRow draws more than one file symbol");
  for (const k of ["row", "tree"]) assert.ok(!/<svg\b/.test(ex[k]), `${FILES[k]}: an own SVG instead of FileSymbol`);

  // Form
  has(ex.row, "export const inset = (depth: number) => 8 + depth * 8;", "the indent is not 8 px per level");
  has(ex.row, `<span className="grid w-4 shrink-0 place-items-center`, "the arrow is not 16 px wide");
  const rowCss = block(q.css, ".cb-tree-row");
  assert.ok(rowCss.includes("  font-size: 13px;\n") && rowCss.includes("  line-height: 22px;\n"), "the row is not 22 px / 13 px");
  assert.ok(block(q.css, ".cb-tree-line").includes("  opacity: 0;\n") && q.css.includes(".cb-tree:hover .cb-tree-line { opacity: 1; }"),
    "the indent lines do not appear only on hover");

  // Addresses
  for (const k of Object.keys(FILES)) {
    assert.ok(!ex[k].includes("`${apiBase}"), `${FILES[k]}: an address past calls (the instance was missing)`);
    assert.ok(!/\bfetch\(/.test(ex[k]), `${FILES[k]}: fetch past calls`);
  }
  has(ex.tree, "startFileDownload(apiBase, target, instance)", "the download does not go to the chosen instance");
  has(ex.hook, "calls<{ omitted?: number }>(`/files/copy`, ", "copying does not go through POST .../files/copy");

  // Git
  has(ex.hook, "calls<GitIgnored>(`/git/ignored`)", "\"ignored\" does not come from the server");
  has(ex.hook, "}, [loadIgnored, load, active, o.gitKey]);", "\"ignored\" does not reread when the git state changes");
  has(c, "apiBase, instance, calls, active: isActive, gitKey,", "CodePane does not pass the git state to the explorer");
  has(c, "explorerCards(gitRepos, ex.ignored, treeProblems)", "the decoration cards are missing");
  // Typing in the editor grows the buffer tick per key - the problems of the tree stay the SAME list as long as their content is equal
  // (otherwise cards and decoration of every row would recompute); the index of the focus row and the upload field do not compute/write per render.
  has(withoutComments(q.problems), "if (sameSituation(out, last.current)) return last.current;", "the problems of the tree are a new list per key");
  has(withoutComments(q.problems), "a.length === b.length && a.every((x, i) => x.file === b[i].file && x.severity === b[i].severity)", "sameSituation does not compare every entry");
  has(withoutComments(q.tree), "const focusIndex = useMemo(() => rowOf(rows, ex.focus), [rows, ex.focus]);", "the index of the focus row computes through all rows on every render");
  has(withoutComments(q.tree), "<UploadField field={fileField} onChoice={filesSelected} />", "the upload field renders with the tree (React rewrites it per key)");
  has(withoutComments(q.tree), "const UploadField = memo(function UploadField(", "the upload field is not memoized");
  has(ex.row, "data-tree-character>{deco.character}</span>", "there is no \"2, M\" on the right");

  // Problems
  has(ex.problems, "if (!on) return;", "problems ask even with a hidden tree");
  has(ex.problems, "}, PROBLEMS_PAUSE_MS);", "problems ask without a pause");
  has(ex.problems, "if (seq === run.current) for (const [k, z] of responses) setDiagnostics(k, z);", "a late answer overwrites a newer one");
  // ONE source with tab color and status bar: after every pause ALL open tabs are asked (asking only unknown ones left a tab in the
  // background red), reading is from lib/diagnostic-status.ts, no own stock beside it.
  has(ex.problems, "if (p?.status.state !== \"loaded\") return;", "the tree does not ask every loaded tab");
  assert.ok(!ex.problems.includes("|| diagnosticsOf(p.key)) return;"), "the tree asks only unknown ones - a tab in the background would stay red");
  has(ex.problems, "const z = p ? diagnosticsOf(p.key) : null;", "the tree does not read from the shared stock");
  assert.ok(!/\buseState\b/.test(withoutComments(ex.problems)), "the tree keeps its own stock of problems");
  has(c, `useTreeProblems({ on: isActive && mode === "explorer" && !treeHidden,`, "CodePane asks for problems even without a visible tree");

  // Field
  has(ex.field, "const [a, b] = nameSelection(beginning, isFolder);", "the field does not select the name without extension");
  has(ex.field, "el.setSelectionRange(a, b);", "the field does not select the name without extension");
  has(ex.field, `role={notice.kind === "error" ? "alert" : "status"}`, "the notice below the field has no role");
  has(ex.hook, "if (p.error) { setEditingError({ code: p.error }); return false; }", "an error closes the field");

  // Dragging
  has(ex.tree, "export const EXPAND_MS = 500;", "a folder under the pointer does not expand after 500 ms");
  has(ex.tree, `void ex.deposit(q, z, e.altKey ? "copy" : "move", e.altKey ? {} : { questions: { targetName: z ? nameOf(z) : name } });`, "alt does not copy, or moving by drag does not ask");
  has(ex.tree, ".some((p) => z === p || z.startsWith(`${p}/`))", "a folder can be dragged into itself");
  has(ex.tree, ".then((files) => ex.uploadIn(z, files))", "files from outside no longer upload");

  // CodePane and header
  has(c, "<ExplorerTree ex={ex} ", "CodePane does not draw the explorer");
  for (const old of ["TreeLevel", "TreeRow", "dirChildren", "loadDir("]) assert.ok(!c.includes(old), `the old tree is still in CodePane (${old})`);
  has(c, "<ActivityBar mode={mode} setMode={setMode}", "the activity bar is missing");
  has(c, "onSearchInFolder={searchInFolder}", "\"Find in Folder...\" is not connected");
  has(c, `setSearchFolder((s) => ({ path: p, seq: (s?.seq ?? 0) + 1 })); setMode("search");`, "\"Find in Folder...\" does not open the search with the folder");
  assert.ok(/if \(!activePath \|\| activePath\.startsWith\("\/"\)\) return;[^\n]*\n\s*showInTree\(activePath\);\n\s*\}, \[activePath, showInTree\]\);/.test(c),
    "the active file is not shown in the tree");
  has(ex.header, `{mode === m && <span aria-hidden className="absolute bottom-0`, "the chosen view is not underlined");

  // Keys and menu from lib/explorer-actions.ts, every action hits the focus (in a compact row the segment).
  has(ex.tree, "const a = keyToAction({ key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });", "the keys do not come from keyToAction");
  has(ex.tree, "const plan = menuPlan({ target, kind: target === null ? \"dir\" : kind,", "the menu does not come from menuPlan");
  has(ex.tree, `case "rename": if (f !== null && targets.length <= 1) ex.startRename(f); return;`, "enter/F2 does not rename the segment with the focus");
  has(ex.tree, `case "search-in-folder": if (f !== null && fKind === "dir") onSearchInFolder(f); return;`, "alt+shift+F does not search in the folder");
  has(ex.hook, "const n = selectIn({ selection: selectionRef.current, focus: focusRef.current, anchor: anchor.current }, rowsRef.current, path, mod);", "the selection does not come from lib/explorer-actions.ts");
  // The focus returns.
  has(ex.tree, "const h = requestAnimationFrame(() => surface.current?.focus({ preventScroll: true }));", "the focus does not return to the tree");
  assert.equal(ex.tree.split("onFinished={ex.toTree}").length - 1, 2, "after enter/Esc in the field the focus does not return (new AND rename)");
  has(ex.field, "void takeOver().then((ok) => { if (ok) onFinished?.(); });", "enter in the field does not return the focus");
  has(ex.field, "done.current = true; onAbort(); onFinished?.(); }", "Esc in the field does not return the focus");
  has(ex.tree, "const run = FOCUS_BACK.has(x.action) ? () => { p.run(); ex.toTree(); } : p.run;", "after a menu action the focus does not return");
  // A drag carries explorer and instance; foreign ones are rejected.
  has(ex.tree, "const data: DragData = { origin: location.origin, apiBase: location.apiBase, instance: location.instance, paths: q };", "a drag does not carry explorer and instance");
  has(ex.tree, "d.apiBase !== apiBase || (d.instance ?? null) !== (instance ?? null)", "a drag from a foreign explorer is dropped");
  // Question before moving (checkmark per device, storage in try/catch), "Replace?" for an occupied name.
  has(ex.hook, `const dragQuestions = () => { try { return localStorage.getItem(DRAG_QUESTIONS_KEY) !== "0"; } catch { return true; } };`, "the question before dragging does not read the storage protected");
  has(ex.hook, `checkMark: { text: t("Do not ask me again"), onConfirm: (enabled) => { if (enabled) dragNotMoreQuestions(); } }`, "\"Do not ask me again\" is missing");
  has(q.prompts, "if (result) question?.checkMark?.onConfirm(checked);", "the question's checkmark is not reported (only after \"yes\")");
  has(ex.hook, "if (replace.has(to)) { await calls(`/files?path=${encodeURIComponent(to)}`, { method: \"DELETE\" }); oRef.current.onDeleted(to); }", "replacing does not delete the old target");
  // Paste like VS Code; a single pasted file opens fixed.
  has(ex.hook, "const plan = insertTargets(el, kindOf(el), z.paths);", "paste does not compute through insertTargets");
  has(ex.hook, `if (finished.length === 1 && kindOf(finished[0].from) === "file") oRef.current.onOpen(finished[0].to, true);`, "a single pasted file does not open fixed");
  // Run numbers, reread on git state, debounced, chains seeded, open chains.
  has(ex.hook, "if ((versions.current.get(d) ?? 0) > seq) continue;", "a late list overwrites a newer one");
  has(ex.hook, "if (seq === ignoreSeq.current) setIgnored(r.repos ?? []);", "a late \"ignored\" answer overwrites a newer one");
  has(ex.hook, `for (const d of ["", ...[...openRef.current].filter((x) => childrenRef.current[x] !== undefined)]) void load(d);`, "a new git state does not reread the open folders");
  has(ex.hook, "    loadIgnored();\n  }, [loadIgnored, load, active, o.gitKey]);", "\"ignored\" is not debounced on the git state");
  has(ex.hook, "ignClock.current = setTimeout(() => { ignClock.current = null; void loadIgnoredNow(); }, IGNORED_QUIET_MS);", "\"ignored\" is not debounced");
  has(ex.hook, "...(chainsSeed(r.entries) as [string, FileEntry[]][])", "the server's chains are not seeded");
  has(ex.hook, "const n = openSegments(rows, openSet);", "an open chain does not put its segments into `openSet`");
  // autoRevealExclude, except explicitly.
  has(ex.hook, "if (!force && showExcluded(path)) return;", "\"Reveal Active File\" expands node_modules");
  has(c, "showInTree(path, false, true);", "\"Show in Explorer View\" does not force");
  // Omitted and clipped things said; deleted things drop out of `children` and `openSet`.
  has(ex.hook, `omitted += typeof r?.omitted === "number" ? r.omitted : 0;`, "omitted entries of a copy stay silent");
  has(ex.tree, "{ex.ignoredClipped && (", "a clipped \"ignored\" list stays silent");
  has(ex.tree, "{ex.hint && (", "the hint is not shown");
  has(ex.hook, "setOpen((prev) => ([...prev].some(below) ? new Set([...prev].filter((p) => !below(p))) : prev));", "deleted things stay in `openSet`");
  has(ex.hook, "const kindOf = useCallback((p: string): \"dir\" | \"file\" | null =>", "the kind of a path is not three-valued");
  // Accessibility.
  has(ex.tree, "aria-activedescendant={focusIndex >= 0 ? rowsId(focusIndex) : undefined}", "the tree does not name the row with the focus");
  assert.equal(ex.tree.split(`role="treeitem" aria-level={z.depth + 1}`).length - 1, 2, "\"loading\" and \"new\" are no treeitem");
  has(ex.row, "      id={id}\n      role=\"treeitem\"", "the row carries no id");
  has(ex.header, "<button type=\"button\" aria-expanded={!closed} onClick={onToggle}", "the root is no button with aria-expanded");
  // Field height with the text scale; symbol in the field; no own bullet.
  assert.ok(block(q.css, ".cb-tree-field").includes("  height: calc(20px * var(--cb-text-scale, 1));\n"), "the field does not grow with the text scale");
  has(ex.field, "{symbol?.(value)}", "the symbol in the field does not follow the input");
  assert.ok(!/>•</.test(ex.row), "the own bullet of the heavy folders is back");
  // "Open in Terminal" as a hook up to CodePane.
  has(ex.tree, "terminal: Boolean(onInTerminal)", "\"Open in Terminal\" does not hang on the hook");
  has(c, "onInTerminal={", "CodePane does not pass on the \"Open in Terminal\" hook");

  // "Open in Integrated Terminal" starts a NEW terminal in the folder, the panel on TERMINAL.
  has(c, "onInTerminal={lay.newTerminal}", "\"Open in Terminal\" does not start a terminal in the folder");
  const lay = withoutComments(q.layout);
  has(lay, `terminal({ kind: "fresh", cwd: folder });`, "the new terminal does not get the folder");
  has(lay, `set({ ...s, open: true, tab: "terminal" });`, "the panel does not show the new terminal");
  has(withoutComments(q.terminalPanel), "JSON.stringify(cwd ? { cols: 80, rows: 24, cwd } : { cols: 80, rows: 24 })", "the terminal does not send its folder to the server");
  // The sections.
  has(c, "closed={closed} onTo={toggle} ", "the tree is not controlled by the sections");
  // "Open Preview" in the explorer on a Markdown file (VS Code `markdown.showPreview`, explorer/context) - files and chat.
  has(c, "onPreview={previewFromExplorer}", "the explorer does not open a Markdown preview");
  has(c, "if (st) { st.preview?.open(path); return; }", "in the chat the preview from the explorer opens nothing");
  has(c, "applyGroups((x) => E.openPreview(x, x.active, path))", "the preview from the explorer does not open in the active group");
  has(withoutComments(q.tree), "preview: Boolean(onPreview) && target !== null && isMarkdown(target),", "\"Open Preview\" also on non-Markdown");
  has(withoutComments(q.tree), `case "preview": return { label: t("Open Preview"), run: () => { if (target !== null) onPreview?.(target); } };`, "\"Open Preview\" without wording or path");
  has(ex.tree, "const rootTo = collapsed ?? ownTo;", "the tree does not listen to the section");
  assert.equal(c.split("{layoutContent}").length - 1, 2, "tab and section do not show the SAME outline");
  has(c, "onOpen={setSectionOpen}", "CodePane does not know whether the outline is visible");
  has(ex.sections, "try { return stateFrom(JSON.parse(localStorage.getItem(KEY) || \"null\")); } catch { return SECTIONS_DEFAULT; }", "the remembered state is not read protected");
  has(ex.sections, "try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {", "the state is not remembered protected");
  has(ex.sections, "{i > 0 && pullPair(status, i - 1) && (", "a drag bar stands where it moves nothing");
  // The header actions on hover over the WHOLE section (and while a menu is open), also the root's; OUTLINE with "Collapse All"/"...";
  // TIMELINE with pin, refresh, filter (remembered) and the file name in the header.
  has(ex.sections, `className="group/section relative flex min-h-0 shrink-0 flex-col overflow-hidden"`, "the section is no group for hover");
  has(ex.sections, `export const HEADER_ACTIONS = "hidden shrink-0 items-center gap-px group-hover/section:flex group-focus-within/section:flex has-[[aria-expanded=true]]:flex";`, "the actions do not appear on hover over the section");
  has(ex.sections, "{actions && open && <span className={HEADER_ACTIONS} data-section-actions>{actions}</span>}", "the header does not take the actions from HEADER_ACTIONS");
  has(ex.header, `"hidden group-hover/section:flex group-focus-within/section:flex"`, "the root's actions appear only over its header");
  assert.ok(!/group-hover:flex/.test(withoutComments(ex.sections) + withoutComments(ex.header)), "a header shows its actions only over itself");
  has(ex.sections, "actions={layoutActions} />", "OUTLINE has no actions in the header");
  has(c, "layoutActions={<LayoutActions t={t} choice={layoutChoice} />}", "CodePane does not give the section the outline's actions");
  has(ex.sections, "const timeFile = pinned ?? activeFile;", "when pinned the timeline still follows the editor");
  has(ex.sections, "onClick={() => setPinned(pinned ? null : activeFile)}", "\"Pin the Current Timeline\" is missing");
  has(ex.sections, `<MenuEntry label={t("Git History")} selected={gitOn} onClick={() => setGitOn(!gitOn)} `, "\"Filter Timeline\" does not offer the source");
  has(ex.sections, `try { localStorage.setItem(GIT_KEY, on ? "1" : "0"); } catch {`, "the filter is not remembered (protected)");
  has(ex.sections, "description={timeFile ? timeFile.slice(timeFile.lastIndexOf(\"/\") + 1) : undefined}", "the timeline header does not name the file");
  has(ex.sections, "{timeAxis({ seq: timeSeq, file: timeFile, gitOn })}", "the timeline does not get file or filter");
  has(c, "file={file} repos={gitRead ? gitRepos.map((r) => r.relPath) : null}", "CodePane does not give the timeline the (pinned) file");
  has(c, "seq={seq} gitOn={gitOn} onOpen={openTimeAxis} />", "CodePane does not give the timeline the filter");
  // The timeline: pages like VS Code (as many as the view shows; "Load more" with the cursor of the last entry), the short time of
  // VS Code with a dash instead of repetition, the diff title of VS Code, "all sources filtered out".
  has(ex.timeAxis, `calls<unknown>("/git/log", { method: "POST", body: JSON.stringify({ repo: target.repo, file: target.file, timeAxis: true, limit }) })`, "the timeline does not ask `git log --follow` of the file");
  has(ex.timeAxis, "const limit = Math.min(TIME_AXIS_CAP, Math.max(pagesSize(surface.current?.clientHeight ?? 0), equal));", "the first page is not as large as the view (or what is already loaded)");
  has(ex.timeAxis, `calls<unknown>("/git/log", { method: "POST", body: JSON.stringify({ repo: target.repo, file: c.file, timeAxis: true, limit: pagesSize(surface.current?.clientHeight ?? 0), after: c.after }) })`, "\"Load more\" does not ask from the last entry (with its path)");
  has(ex.timeAxis, "const data = appendTo(l.data, fresh);", "\"Load more\" does not append the page");
  has(ex.timeAxis, "{cursorOf(situation.data) && (", "\"Load more\" is not the last row");
  has(ex.timeAxis, `{loadingMore ? t("Loading…") : t("Load more")}`, "\"Load more\" is not named like VS Code");
  has(ex.timeAxis, "if (mine !== run.current) return;\n        const data = normTimeAxis(raw);", "a late timeline answer overwrites a newer one");
  has(ex.timeAxis, `setSituation(data ? { key, kind: "finished", data } : { key, kind: "unknown" });`, "an old server would read \"no entries\"");
  // The diff is a tab - a single click the (italic) preview, a double click fixed (web/test/editor-inputs.test.mjs holds click, double
  // click, "Open Commit" and the context menu). Title like VS Code `git.timeline.openDiff` - the file's name TODAY (across a rename),
  // on the left the predecessor (the next older entry; unknown before an unloaded page).
  has(ex.timeAxis, "const entries = situation.data.entries, moreAvailable = Boolean(cursorOf(situation.data));", "the predecessor does not know the unloaded page");
  has(ex.timeAxis, "const prior = priorOf(entries, entries.indexOf(e), moreAvailable);", "the diff does not know its predecessor");
  has(ex.timeAxis, "onOpen(entrySource(repo, e, { current: target.file, prior }), { title: diffTitle(target.file, e.hash, prior), short: e.short, fixed });", "a click does not open the commit's diff (title like VS Code)");
  has(ex.timeAxis, "onClick={(m) => { if (m.detail < 2) open(e); }}", "a click opens nothing");
  has(ex.timeAxis, "const column = timeColumn(situation.data.entries, now, t);", "the time is not the short one of VS Code");
  has(ex.timeAxis, `<span className="hidden group-hover/row:inline group-focus-visible/row:inline">{z.text}</span>`, "the same time as above is back (VS Code: a dash)");
  has(ex.timeAxis, `else if (!gitOn) content = empty(t("All timeline sources have been filtered out."));`, "\"filtered out\" is missing");
  has(ex.timeAxis, `if (target.kind !== "ok" || !gitOn) return;`, "filtered out is asked anyway");
  assert.ok(!ex.timeAxis.includes("relativeTime("), "the time says \"ago ...\" again");
  // The row height is measured fractionally; when typing the focus jumps to the first hit; the switches INSIDE the field. Measured on an
  // entry row in the window (TreeWindow.tsx), fallback 22 px (VS Code `ExplorerDelegate.ITEM_HEIGHT`).
  has(ex.tree, `const rowHeight = (el: HTMLElement | null) => el?.querySelector<HTMLElement>(".cb-tree-window > .cb-tree-row[data-tree-path]")?.getBoundingClientRect().height || ROW_PX;`, "the row height is rounded (offsetHeight)");
  assert.ok(!/offsetHeight \|\| (22|ROW_PX)/.test(ex.tree), "a spot still measures the row rounded");
  has(ex.tree, "if (target) { e.focusOn(target.path); e.scrollTo(target.path); }\n  }, [searchState.text, searchState.mode, searchState.fuzzy]);", "when typing the focus does not jump to the first hit");
  has(ex.hook, "const focusOn = useCallback((path: string) => { focusRef.current = path; setFocus(path); }, []);", "the jump changes the selection");
  const frame = ex.search.indexOf("data-tree-search-frame>"), close = ex.search.indexOf("data-tree-search-close");
  const inField = frame >= 0 && close > frame ? ex.search.slice(frame, close) : "";
  assert.ok(inField.includes(`data-tree-search-toggle="fuzzy"`) && inField.includes(`data-tree-search-toggle="filter"`) && /data-tree-search-toggle="filter"[\s\S]*<\/div>/.test(inField), "the switches are not in the field");
  has(ex.search, `className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-fg outline-none"`, "the field has an own frame beside the switches");
  has(c, "repos={gitRead ? gitRepos.map((r) => r.relPath) : null}", "unread repos would read \"no repo\"");
  has(c, "if (stRef.current) { stRef.current.openDiff?.(source, o); return; }", "in the chat the timeline opens no diff tab");
  has(c, `applyGroups((s) => G.open(s, E.diffKey(source, o.title), { fixed, unsaved: dirtyOf }));`, "on the page the timeline opens no diff tab (in the active group)");
  has(withoutComments(q.chatCode), `openDiff: (source, o) => tabsRef.current.open({ kind: "diff", target: z, source, title: o.title, short: o.short }, { fixed: Boolean(o.fixed) }),`, "the chat does not open the timeline's diff as a tab");
  // Sticky scroll.
  has(ex.tree, "<TreeSticky node={sticky} ", "the tree does not draw the sticky folders");
  // The window reports every scroll event (`onScroll`), the tree sets state only when the sticky folders change.
  has(ex.tree, "draw={draw} onScroll={computeSticky} />", "sticky scroll does not follow scrolling");
  has(ex.tree, "const stickyRows = useMemo(() => rows.map(", "sticky scroll does not compute over the shown rows");
  has(ex.sticky, `<div aria-hidden className="cb-tree-sticky-shadow"`, "the sticky folders cast no shadow");
  assert.ok(q.css.includes("box-shadow: var(--tree-shadow) 0 3px 2px -2px"), "the shadow is not `scrollbar.shadow`");
  // The search widget.
  has(ex.tree, "if (isSearchKey(e, isMac())) {", "alt+cmd+F does not open the search in the tree");
  has(ex.tree, "hits={search && z.chain.some((g) => search.hits.has(g.path)) ? search.hits : null}", "hits are not marked in the name");
  has(ex.tree, `const rows: readonly Row[] = search && searchState.mode === "filter" ? search.rows : ex.rows;`, "filtering does not show only the hits");
  has(ex.search, `if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }`, "Esc does not close the search");
  has(ex.search, `else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onIntoTheTree(); }`, "down does not go into the tree");
  has(ex.search, `placeholder={t("Type to search")}`, "the field does not say \"Type to search\"");
  has(ex.search, `{unloaded && text !== "" && <div`, "that only loaded things are searched stays silent");
  has(ex.search, `className="cb-pop absolute`, "the search widget does not carry cb-pop");
  assert.ok(q.css.includes(".cb-tree-hits { color: var(--tree-hits);"), "the hits are not `list.highlightForeground`");

  // Texts
  const missing = key(q).filter((k) => !q.i18n.includes(`\n  ${JSON.stringify(k)}: `));
  assert.deepEqual(missing, [], "explorer texts without an entry in lib/i18n-de.ts");
}

const SABOTAGES = [
  ["menu without portal", "menu", "return createPortal(", "return ("],
  ["menu as click catcher", "menu", `className="cb-kit" data-tree-menu>`, `className="cb-kit fixed inset-0" data-tree-menu>`],
  ["menu without cb-pop", "menu", "`${popClass} fixed z-50", "`fixed z-50"],
  ["menu row by hand", "menu", "className={point.danger ? menuRowDanger : menuRow}", `className="block w-full px-3 py-1.5 text-left"`],
  ["delete without warning", "hook", "const w = deleteWarning(list, oRef.current.unsaved?.() ?? []);", "const w = deleteWarning(items, []);"],
  ["CodePane without unsaved changes", "codePane", "unsaved: () => allBuffers().filter((p) => p.dirty)", "unsavedX: () => [].filter((p) => p.dirty)"],
  ["delete red", "tree", 'case "erase": return { label: t("Delete"), shortcut: "⌘⌫", run: ', 'case "eraseX": return { label: t("Delete"), shortcutX: "⌘⌫", danger: true, run: '],
  ["shortcut missing", "menu", "data-tree-shortcut>{point.shortcut}</span>", `data-tree-shortcut>{""}</span>`],
  ["menu does not close outside", "menu", `!e.target.closest("[data-tree-menu]")`, `!e.target.closest("body")`],
  ["own menu in the tree", "tree", "{menu && <TreeMenu ", `{menuX && <div role="menu" />}{false && <TreeMenu `],
  ["folder with symbol", "row", "{!folder && !field && <FileSymbol path={row.path}", "{!fieldX && <FileSymbol pathX={rowX.path}"],
  ["own symbol", "row", `{folder && <span className="w-1.5 shrink-0" />}`, `{folderX && <svg className="w-1.5 shrink-0" />}`],
  ["indent 12 px", "row", "8 + depth * 8;", "8 + depthX * 12;"],
  ["arrow 20 px", "row", `<span className="grid w-4 shrink-0 place-items-center`, `<span className="grid w-5 shrink-0 place-items-center`],
  ["row 24 px", "css", "  font-size: 13px;\n  line-height: 22px;\n  white-space: nowrap;", "  font-size: 13px;\n  line-height: 24px;\n  white-space: nowrap;"],
  ["lines always visible", "css", "  opacity: 0;\n  transition: opacity 0.1s;", "  opacity: 1;\n  transition: opacity 0.1s;"],
  ["fetch past calls", "hook", "await calls<{ omitted?: number }>(`/files/copy`, ", "await fetch(`/files/copy`, "],
  ["download without instance", "tree", "startFileDownload(apiBase, target, instance)", "startFileDownload(apiBase, targetX)"],
  ["ignored not from the server", "hook", "calls<GitIgnored>(`/git/ignored`)", "calls<GitIgnored>(`/git/status`)"],
  ["ignored does not reread", "hook", "}, [loadIgnored, load, active, o.gitKey]);", "}, [loadIgnored, loadX, activeX]);"],
  ["CodePane without git key", "codePane", "apiBase, instance, calls, active: isActive, gitKey,", "apiBase, instance, calls, active: isActive, gitKey: \"\","],
  ["no character on the right", "row", "data-tree-character>{deco.character}</span>", "data-tree-character>{null}</span>"],
  ["problems also hidden", "problems", "if (!on) return;", ""],
  ["problems without pause", "problems", "}, PROBLEMS_PAUSE_MS);", "}, 0);"],
  ["problems without run number", "problems", "if (seq === run.current) for (const [k, z] of responses) setDiagnostics(k, z);", "for (const [k, z] of responses) setDiagnostics(k, z);"],
  ["problems only unknown", "problems", "if (p?.status.state !== \"loaded\") return;", "if (p?.status.state !== \"loaded\" || diagnosticsOf(p.key)) return;"],
  ["problems past the stock", "problems", "const z = p ? diagnosticsOf(p.key) : null;", "const z = p ? ownCount(p) : null;"],
  ["problems with own stock", "problems", "import { useEffect, useMemo, useRef, useSyncExternalStore } from \"react\";", "import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from \"react\";"],
  ["CodePane always asks", "codePane", `useTreeProblems({ on: isActive && mode === "explorer" && !treeHidden,`, "useTreeProblems({ on: true,"],
  ["field without preselection", "field", "el.setSelectionRange(a, b);", "el.select();"],
  ["notice without role", "field", `role={notice.kind === "error" ? "alert" : "status"} `, ""],
  ["an error closes the field", "hook", "if (p.error) { setEditingError({ code: p.error }); return false; }", "if (p.error) { setEditingError({ code: p.error }); return true; }"],
  ["expand after 1 s", "tree", "export const EXPAND_MS = 500;", "export const EXPAND_MS = 1000;"],
  ["alt moves", "tree", `void ex.deposit(q, z, e.altKey ? "copy" : "move", e.altKey ? {} : { questions: { targetName: z ? nameOf(z) : name } });`, `void ex.deposit(q, z, "moveX", { questionsX: { targetName: name } });`],
  ["drag does not ask", "tree", `void ex.deposit(q, z, e.altKey ? "copy" : "move", e.altKey ? {} : { questions: { targetName: z ? nameOf(z) : name } });`, `void ex.deposit(q, z, e.altKey ? "copyX" : "moveX");`],
  ["droppable into itself", "tree", ".some((p) => z === p || z.startsWith(`${p}/`))", ".some(() => false)"],
  ["files from outside drop out", "tree", ".then((files) => ex.uploadIn(z, files))", ".then(() => undefined)"],
  ["old tree back", "codePane", "<ExplorerTree ex={ex} ", "<TreeLevel /><ExplorerTree ex={ex} "],
  ["no activity bar", "codePane", "<ActivityBar mode={mode} setMode={setMode}", "<div data-mode={mode} data-set={setMode}"],
  ["search without folder", "codePane", "onSearchInFolder={searchInFolder}", `onSearchInFolder={() => setMode("search")}`],
  ["active file not shown", "codePane", "    showInTree(activePath);\n", ""],
  ["no underline", "header", `{mode === m && <span aria-hidden className="absolute bottom-0`, `{false && <span aria-hidden className="absolute bottom-0`],
  ["translation missing", "i18n", `  "Find in Folder…": "In Ordner suchen…",\n`, ""],
  // VX-R
  ["keys by hand", "tree", "const a = keyToAction({ key: e.key,", "const a = ownKeys({ key: e.key,"],
  ["enter renames the row instead of the segment", "tree", `case "rename": if (f !== null && targets.length <= 1) ex.startRename(f); return;`, `case "renameX": if (focusRow && targetsX.length <= 1) ex.startRename(focusRow.path); return;`],
  ["no focus back", "tree", "const h = requestAnimationFrame(() => surface.current?.focus({ preventScroll: true }));", "const h = requestAnimationFrame(() => undefined);"],
  ["Esc does not return the focus", "field", "done.current = true; onAbort(); onFinished?.(); }", "doneX.current = true; onAbort(); }"],
  ["menu does not return the focus", "tree", "const run = FOCUS_BACK.has(x.action) ? () => { p.run(); ex.toTree(); } : p.run;", "const run = p.run;"],
  ["drag without instance", "tree", "instance: location.instance, paths: q };", "instanceX: null, pathsX: q };"],
  ["foreign drag dropped", "tree", "d.apiBase !== apiBase || (d.instance ?? null) !== (instance ?? null)", "false"],
  ["storage unprotected", "hook", `const dragQuestions = () => { try { return localStorage.getItem(DRAG_QUESTIONS_KEY) !== "0"; } catch { return true; } };`, `const dragQuestions = () => localStorage.getItem(DRAG_QUESTIONS_KEY) !== "0";`],
  ["checkmark also on abort", "prompts", "if (result) question?.checkMark?.onConfirm(checked);", "question?.checkMark?.onConfirm(checked);"],
  ["replace without delete", "hook", "if (replace.has(to)) { await calls(`/files?path=${encodeURIComponent(to)}`, { method: \"DELETE\" }); oRef.current.onDeleted(to); }", ""],
  ["paste into the target folder as before", "hook", "const plan = insertTargets(el, kindOf(el), z.paths);", "const plan = { groupsX: [{ targetX: targetFolder(el) ?? \"\", sourcesX: z.paths }] };"],
  ["pasted file does not open", "hook", `if (finished.length === 1 && kindOf(finished[0].from) === "file") oRef.current.onOpen(finished[0].to, true);`, ""],
  ["list without run number", "hook", "if ((versions.current.get(d) ?? 0) > seq) continue;", ""],
  ["ignored without run number", "hook", "if (seq === ignoreSeq.current) setIgnored(r.repos ?? []);", "setIgnored(r.repos ?? []);"],
  ["git state rereads nothing", "hook", `for (const d of ["", ...[...openRef.current].filter((x) => childrenRef.current[x] !== undefined)]) void load(d);`, ""],
  ["ignored immediately on git state", "hook", "    loadIgnored();\n  }, [loadIgnored, load, active, o.gitKey]);", "    void loadIgnoredNow();\n  }, [loadIgnored, loadX, activeX, o.gitKey]);"],
  ["chains not seeded", "hook", "...(chainsSeed(r.entries) as [string, FileEntry[]][])", "...([] as [string, FileEntry[]][])"],
  ["open chain without segments", "hook", "const n = openSegments(rows, openSet);", "const n = openX;"],
  ["node_modules expanded", "hook", "if (!force && showExcluded(path)) return;", ""],
  ["show in explorer without force", "codePane", "showInTree(path, false, true);", "showInTree(activePath);"],
  ["omitted silent", "hook", `omitted += typeof r?.omitted === "number" ? r.omitted : 0;`, ""],
  ["clipped silent", "tree", "{ex.ignoredClipped && (", "{false && ("],
  ["deleted stays open", "hook", "setOpen((prev) => ([...prev].some(below) ? new Set([...prev].filter((p) => !below(p))) : prev));", ""],
  ["without aria-activedescendant", "tree", "aria-activedescendant={focusIndex >= 0 ? rowsId(focusIndex) : undefined}", ""],
  ["root without button", "header", "<button type=\"button\" aria-expanded={!closed} onClick={onToggle}", "<span onClick={onToggle}"],
  ["field with fixed height", "css", "  height: calc(20px * var(--cb-text-scale, 1));\n", "  height: 20px;\n"],
  ["symbol in the field fixed", "field", "{symbol?.(value)}", "{symbol?.(startX)}"],
  ["own dot back", "row", `{!field && deco.point && <span className="shrink-0 pl-2 pr-3 text-[9px]"`, `{rowX.chain[0].heavy && <span>•</span>}{!fieldX && deco.point && <span className="shrink-0 pl-2 pr-3 text-[9px]"`],
  ["terminal without hook", "tree", "terminal: Boolean(onInTerminal)", "terminal: true"],
  // Slice A
  ["terminal only shown", "codePane", "onInTerminal={lay.newTerminal}", "onInTerminal={() => lay.setBottom(\"terminal\")}"],
  ["new terminal without folder", "layout", `terminal({ kind: "fresh", cwd: folder });`, `terminal({ kindX: "freshX" });`],
  ["panel stays closed", "layout", `set({ ...s, open: true, tab: "terminal" });`, "set(s);"],
  ["terminal without cwd", "terminalPanel", "JSON.stringify(cwd ? { cols: 80, rows: 24, cwd } : { cols: 80, rows: 24 })", "JSON.stringify({ cols: 80, rows: 24 })"],
  ["problems new per key", "problems", "if (sameSituation(out, last.current)) return last.current;", ""],
  ["sameSituation by length only", "problems", " && a.every((x, i) => x.file === b[i].file && x.severity === b[i].severity)", ""],
  ["upload field unmemoized", "tree", "const UploadField = memo(function UploadField(", "const UploadField = (function UploadField("],
  ["focus index per render", "tree", "const focusIndex = useMemo(() => rowOf(rows, ex.focus), [rows, ex.focus]);", "const focusIndex = rowOf(rowsX, ex.focus);"],
  ["explorer without preview", "codePane", "onPreview={previewFromExplorer}", ""],
  ["preview dead in the chat", "codePane", "if (st) { st.preview?.open(path); return; }", "if (st) return;"],
  ["preview on every file", "tree", "preview: Boolean(onPreview) && target !== null && isMarkdown(target),", "previewX: Boolean(onPreview),"],
  ["tree uncontrolled", "codePane", "closed={closed} onTo={toggle} ", " "],
  ["tree does not listen", "tree", "const rootTo = collapsed ?? ownTo;", "const rootTo = ownTo;"],
  ["second outline", "codePane", "            {layoutContent}\n", "            <LayoutTree />\n"],
  ["outline never loads", "codePane", "onOpen={setSectionOpen}", ""],
  ["state read unprotected", "sections", "try { return stateFrom(JSON.parse(localStorage.getItem(KEY) || \"null\")); } catch { return SECTIONS_DEFAULT; }", "return stateFrom(JSON.parse(localStorage.getItem(KEY) || \"null\"));"],
  ["drag bar everywhere", "sections", "{i > 0 && pullPair(status, i - 1) && (", "{i > 0 && ("],
  ["section without group", "sections", `className="group/section relative flex min-h-0`, `className="relative flex min-h-0`],
  ["actions only over the header", "sections", "group-hover/section:flex group-focus-within/section:flex has-[[aria-expanded=true]]:flex", "group-hover:flex group-focus-within:flex"],
  ["root only over the header", "header", `"hidden group-hover/section:flex group-focus-within/section:flex"`, `"hidden group-hover:flex group-focus-within:flex"`],
  ["outline without actions", "sections", "actions={layoutActions} />", "/>"],
  ["pinning without effect", "sections", "const timeFile = pinned ?? activeFile;", "const timeFile = activeFile;"],
  ["pinning missing", "sections", "onClick={() => setPinned(pinned ? null : activeFile)}", "onClick={() => undefined}"],
  ["filter missing", "sections", `<MenuEntry label={t("Git History")} selected={gitOn} onClick={() => setGitOn(!gitOn)} `, `<MenuEntry label={t("Git History")} onClick={() => undefined} `],
  ["filter forgotten", "sections", `try { localStorage.setItem(GIT_KEY, on ? "1" : "0"); } catch {`, "try { void on; } catch {"],
  ["header without file", "sections", "description={timeFile ? timeFile.slice(timeFile.lastIndexOf(\"/\") + 1) : undefined}", "descriptionX={undefined}"],
  ["timeline without filter", "codePane", "seq={seq} gitOn={gitOn} onOpen", "seq={seq} gitOn={true} onOpen"],
  ["timeline without follow", "timeAxis", "file: target.file, timeAxis: true, limit }", "file: targetX.file, limit }"],
  ["fixed page", "timeAxis", "const limit = Math.min(TIME_AXIS_CAP, Math.max(pagesSize(surface.current?.clientHeight ?? 0), equal));", "const limit = TIME_AXIS_CAP;"],
  ["load more without cursor", "timeAxis", "file: c.file, timeAxis: true, limit: pagesSize(surface.current?.clientHeight ?? 0), after: c.after }", "file: targetX.file, timeAxisX: true, limit: pagesSize(surfaceX.current?.clientHeight ?? 0) }"],
  ["load more replaces", "timeAxis", "const data = appendTo(l.data, fresh);", "const data = freshX;"],
  ["load more missing", "timeAxis", "{cursorOf(situation.data) && (", "{false && ("],
  ["timeline without run number", "timeAxis", "if (mine !== run.current) return;\n        const data = normTimeAxis(raw);", "const data = normTimeAxis(raw);"],
  ["old server empty", "timeAxis", `setSituation(data ? { key, kind: "finished", data } : { key, kind: "unknown" });`, `setSituation({ keyX, kindX: "finishedX", dataX: data ?? { entriesX: [], clippedX: false } });`],
  ["click opens nothing", "timeAxis", "onClick={(m) => { if (m.detail < 2) open(e); }}", "onClick={() => undefined}"],
  ["diff title the subject", "timeAxis", "{ title: diffTitle(target.file, e.hash, prior), short: e.short, fixed }", "{ titleX: e.subject, shortX: e.short, fixedX }"],
  ["diff title with the old name", "timeAxis", "{ title: diffTitle(target.file, e.hash, prior), short: e.short, fixed }", "{ titleX: diffTitle(e.file, e.hash, priorX), shortX: e.short, fixedX }"],
  ["source without today's file", "timeAxis", "entrySource(repo, e, { current: target.file, prior })", "entrySource(repo, e, { priorX })"],
  ["predecessor before an unloaded page the empty tree", "timeAxis", "const prior = priorOf(entries, entries.indexOf(e), moreAvailable);", "const prior = priorOf(entriesX, entriesX.indexOf(e));"],
  ["long time", "timeAxis", "const column = timeColumn(situation.data.entries, now, t);", "const column = situationX.data.entries.map(() => ({ text: relativeTime(0, nowX, dateLocale()), doubledX: false }));"],
  ["time doubled", "timeAxis", `<span className="hidden group-hover/row:inline group-focus-visible/row:inline">{z.text}</span>`, "<span />"],
  ["filtered out silent", "timeAxis", `else if (!gitOn) content = empty(t("All timeline sources have been filtered out."));`, ""],
  ["row height rounded", "tree", `?.getBoundingClientRect().height || ROW_PX;`, `?.offsetHeight || ROW_PX;`],
  ["no jump when typing", "tree", "if (target) { e.focusOn(target.path); e.scrollTo(target.path); }\n  }, [searchState.text", "void targetX;\n  }, [searchState.text"],
  ["switches beside the field", "search", "          onClick={() => setMode(mode === \"filter\" ? \"highlight\" : \"filter\")} data-tree-search-toggle=\"filter\"><FilterSymbol /></button>\n        </div>\n", "          onClick={() => setMode(mode === \"filter\" ? \"highlight\" : \"filter\")} data-tree-search-toggle=\"filter\"><FilterSymbol /></button>\n"],
  ["unread means no repo", "codePane", "repos={gitRead ? gitRepos.map((r) => r.relPath) : null}", "repos={gitRepos.map((r) => r.relPath)}"],
  ["chat without diff tab", "codePane", "if (stRef.current) { stRef.current.openDiff?.(source, o); return; }", "if (stRef.current) return;"],
  ["page without diff", "codePane", `applyGroups((s) => G.open(s, E.diffKey(source, o.title), { fixed, unsaved: dirtyOf }));`, ""],
  ["chat opens no tab", "chatCode", `openDiff: (source, o) => tabsRef.current.open({ kind: "diff", target: z, source, title: o.title, short: o.short }, { fixed: Boolean(o.fixed) }),`, ""],
  ["no sticky", "tree", "<TreeSticky node={sticky} ", "<TreeSticky nodeX={[]} "],
  ["sticky does not scroll along", "tree", "draw={draw} onScroll={computeSticky} />", "drawX={drawX} />"],
  ["sticky over all rows", "tree", "const stickyRows = useMemo(() => rows.map(", "const stickyRows = useMemo(() => ex.rows.map("],
  ["without shadow", "sticky", `<div aria-hidden className="cb-tree-sticky-shadow"`, `<div aria-hidden className="hidden"`],
  ["alt+cmd+F dead", "tree", "if (isSearchKey(e, isMac())) {", "if (false) {"],
  ["hits unmarked", "tree", "hits={search && z.chain.some((g) => search.hits.has(g.path)) ? search.hits : null}", "hitsX={null}"],
  ["filtering shows everything", "tree", `const rows: readonly Row[] = search && searchState.mode === "filter" ? search.rows : ex.rows;`, "const rows: readonly RowX[] = ex.rows;"],
  ["Esc does not close", "search", `if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }`, `if (e.key === "Escape") { e.preventDefault(); }`],
  ["down stays in the field", "search", `else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onIntoTheTree(); }`, ""],
  ["hint silent", "search", `{unloaded && text !== "" && <div`, `{false && <div`],
  ["shadow fixed", "css", "box-shadow: var(--tree-shadow) 0 3px 2px -2px", "box-shadow: #000 0 3px 2px -2px"],
  ["hits without color", "css", ".cb-tree-hits { color: var(--tree-hits);", ".cb-tree-hits { color: inherit;"],
];

test("explorer: the sources keep their promises (menu, symbols, form, addresses, git, problems, field, dragging, CodePane, texts)", (t) => {
  check(Q);
  t.diagnostic(`${key(Q).length} explorer texts translated, ${Q.list.length} files in the folder`);
});

test("explorer: each counter-test of the sources is caught", (t) => {
  for (const [name, k, old, fresh] of SABOTAGES) {
    const places = Q[k].split(old).length - 1;
    assert.equal(places, 1, `counter-test "${name}" is stale: the spot occurs ${places}x in ${k}`);
    assert.throws(() => check({ ...Q, [k]: Q[k].replace(old, fresh) }), `counter-test "${name}" was not caught`);
  }
  assert.throws(() => check({ ...Q, list: [...Q.list, "Fresh.tsx"].sort() }), "a new file in the folder goes unnoticed");
  t.diagnostic(`${SABOTAGES.length + 1} counter-tests caught`);
});
