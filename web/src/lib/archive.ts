// The archive in the web: the pure calculations. A leaf with NO import: `web/test/archive.test.mjs` compiles the file with tsc without a
// tsconfig and runs it; an import here would break that. The UI (ArchiveView, ArchiveEntry, useArchive) calls only these functions;
// where a rule stands, it stands once.
//
// The reason texts are written by the SERVER (`open[].text`, via T()); nothing is translated here except the sentences of the
// confirmations (shells, deleting folders), and those go through the passed `t`. Their NUMBERS come from the server; a missing number
// is never 0 here.

/** What the calculations read on a chat. */
export interface ArchiveChatKind {
  id: string;
  title?: string;
  folderId?: string | null;
  archivedAt?: number | null;
  /** Who archived: "auto" = the "Archive chats automatically" tick. */
  archiveReason?: "user" | "auto" | null;
}
/** What the calculations read on a folder. */
export interface ArchiveFolderKind {
  id: string;
  name: string;
  archivedAt?: number | null;
}

export interface ArchiveGroups<C extends ArchiveChatKind, O extends ArchiveFolderKind> {
  /** Archived folders with their archived chats, most recently archived first. */
  folder: { folder: O; chats: C[] }[];
  /** Archived chats outside an archived folder; `label` is the name of their (active) folder. */
  loose: { chat: C; label: string }[];
}

const time = (x: { archivedAt?: number | null }) => x.archivedAt ?? 0;
const mostRecentFirst = (a: { archivedAt?: number | null }, b: { archivedAt?: number | null }) => time(b) - time(a);

/**
 * The archive view in groups. `chats` are the archived chats (`archive=only`), `folder` ALL folders of the kind (`archive=including`);
 * the active ones only supply the labels of the loose chats (`loose`). Archived folders come first, each with its chats; an archived
 * folder without a chat is still there (it is archived itself). Per group `archivedAt DESC`; `pinned` plays no role in the archive.
 */
export function archiveGroups<C extends ArchiveChatKind, O extends ArchiveFolderKind>(chats: C[], folder: O[]): ArchiveGroups<C, O> {
  const byId = new Map(folder.map((o) => [o.id, o]));
  const archived = folder.filter((o) => o.archivedAt != null).sort(mostRecentFirst);
  const inArchiveFolder = new Set(archived.map((o) => o.id));
  return {
    folder: archived.map((o) => ({ folder: o, chats: chats.filter((c) => c.folderId === o.id).sort(mostRecentFirst) })),
    loose: chats
      .filter((c) => !c.folderId || !inArchiveFolder.has(c.folderId))
      .sort(mostRecentFirst)
      .map((chat) => ({ chat, label: (chat.folderId && byId.get(chat.folderId)?.name) || "" })),
  };
}

/**
 * The archive view's own search: title and folder name, case-insensitive. If the folder name matches, the whole group stays; otherwise
 * only the chats whose title matches, and a group without a hit drops out.
 */
export function archiveSearch<C extends ArchiveChatKind, O extends ArchiveFolderKind>(q: string, groups: ArchiveGroups<C, O>): ArchiveGroups<C, O> {
  const n = q.trim().toLowerCase();
  if (!n) return groups;
  const hits = (s: string | undefined) => (s || "").toLowerCase().includes(n);
  return {
    folder: groups.folder
      .map((g) => (hits(g.folder.name) ? g : { folder: g.folder, chats: g.chats.filter((c) => hits(c.title)) }))
      .filter((g) => hits(g.folder.name) || g.chats.length > 0),
    loose: groups.loose.filter((l) => hits(l.chat.title) || hits(l.label)),
  };
}

/** A reason of the precheck, as the server writes it. */
export interface ArchiveReason { reason: string; text: string }
/** A locked chat of the FOLDER precheck. */
export interface ArchiveLockedChat { chatId: string; title?: string; open: ArchiveReason[] }
/** The precheck: on a chat `open: ArchiveReason[]`, on a folder `open: ArchiveLockedChat[]`. */
export interface ArchivePrecheck {
  open?: (ArchiveReason | ArchiveLockedChat)[];
  terminals?: number;
}
export interface ArchiveHint {
  /** Open work ⇒ the entry is locked (the PUT answered 409). */
  locked: boolean;
  /** The ONLY reason is the open question ⇒ "Discard question and archive" is offered. */
  onlyQuestion: boolean;
  /** The gray rows under the entry: the server texts, on a folder per chat with title. */
  rows: string[];
  /** The shell sentence ("Ends 1 open shell"), empty at 0; it also appears in the confirmation before archiving. */
  shells: string;
}

type Translator = (s: string, p?: Record<string, string | number>) => string;
const fill: Translator = (s, p) => (p ? s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : s);

/**
 * The gray row under an archived chat in the archive view: the name of its (active) folder and, if the tick archived it,
 * "archived automatically"; otherwise a chat never touched would look like one the user put away. Only "auto" counts: "user" and an
 * unknown reason (a server without the field) say nothing.
 */
export function archiveRowLabel(folderName: string, reason: string | null | undefined, t: Translator = fill): string {
  const parts = [folderName, reason === "auto" ? t("archived automatically") : ""].filter(Boolean);
  return parts.join(" · ");
}

/** The range of days: an integer from 1 to 365; the route rejects anything else with 400. */
export const AUTO_ARCHIVE_DAYS = { min: 1, max: 365 } as const;

/** The input "after … days" as a number, or `null` if it is not valid; then nothing goes out. */
export function archiveDays(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= AUTO_ARCHIVE_DAYS.min && n <= AUTO_ARCHIVE_DAYS.max ? n : null;
}

/** The "Archive chats automatically" setting as the server keeps it. */
export interface AutoArchiveStatus { enabled: boolean; days: number }

/**
 * Saving on the "Chats" page. Every handler used to build its body from the state of the last SERVER response: typing days and then
 * clicking the switch at once sent `{enabled: old, days: new}` on blur and `{enabled: !old, days: old}` on click; the second PUT took
 * the just-saved days back, and whichever answer came last decided.
 *
 * Now ONE local state applies, set at once (optimistically); every change merges into it, and `show` reports it to the page. The jobs
 * run one after another (chain), and each reads the state at the moment of ITS run: the last wins, a job that a later one already took
 * along writes nothing. The PUT always carries both fields. An error resets to the last CONFIRMED state (also what still waited after it)
 * and reports the text; a success clears the error line. Before `loaded` the storage accepts nothing: "not loaded yet" is not "off, 30 days".
 */
export function autoArchiveStorage(
  write: (value: AutoArchiveStatus) => Promise<AutoArchiveStatus>,
  { show, error }: { show: (status: AutoArchiveStatus) => void; error: (text: string) => void },
) {
  let confirmed: AutoArchiveStatus | null = null;
  let local: AutoArchiveStatus | null = null;
  let chain: Promise<void> = Promise.resolve();
  const equal = (a: AutoArchiveStatus, b: AutoArchiveStatus) => a.enabled === b.enabled && a.days === b.days;
  const run = async () => {
    const target = local;
    if (!target || !confirmed || equal(target, confirmed)) return;
    try {
      const s = await write({ enabled: target.enabled, days: target.days });
      confirmed = s;
      error("");
      // If nothing newer came meanwhile, the answer applies; otherwise the newer state is already there and the next job writes it.
      if (local === target) {
        local = s;
        if (!equal(s, target)) show(s);
      }
    } catch (e) {
      local = confirmed;
      show(confirmed);
      error(String((e as Error)?.message ?? e));
    }
  };
  return {
    /** The server's state when the page opens. */
    loaded(s: AutoArchiveStatus) {
      confirmed = s;
      local = s;
      show(s);
    },
    /** The state the page shows (optimistic); `null` before loading. */
    state: () => local,
    /** A change (one or both fields): shown at once, saved in the queue. The promise resolves after this job. */
    change(part: Partial<AutoArchiveStatus>): Promise<void> {
      if (!local) return chain;
      local = { ...local, ...part };
      show(local);
      chain = chain.then(run);
      return chain;
    },
  };
}

/**
 * When the automatic archive is switched on for the first time, the first pass archives many chats at once, and each sends its own
 * `chat_archive`. Every list reloaded per event (coding: chats and folders, the archive view), hundreds of fetches in a second for a
 * hundred chats. Since then: an event that concerns the OPEN chat takes effect at once (the archive bar must not wait); every other
 * triggers a bundled reload.
 */
export function archiveEventImmediately(chatIds: unknown, openId: string | null | undefined): boolean {
  return Boolean(openId) && Array.isArray(chatIds) && chatIds.includes(openId);
}

/** How long a bundled reload waits for further events; the same 300 ms as `afterRunTimer` in ChatPane. */
export const ARCHIVE_BUNDLE_MS = 300;

/**
 * A bundled reload: `nudge()` postpones the run by `ms` (every further nudge within the delay bundles with it), `immediately()` loads
 * now and takes a pending run along, `abort()` cleans up on unmount. The clock is injectable (the test drives it by hand, without
 * waiting for time).
 */
export function bundler(
  run: () => void,
  ms: number = ARCHIVE_BUNDLE_MS,
  clock: { set: (f: () => void, ms: number) => unknown; erase: (t: unknown) => void } = {
    set: (f, n) => setTimeout(f, n),
    erase: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
) {
  let timer: unknown;
  const cancel = () => { if (timer !== undefined) clock.erase(timer); timer = undefined; };
  return {
    nudge() { cancel(); timer = clock.set(() => { timer = undefined; run(); }, ms); },
    immediately() { cancel(); run(); },
    abort: cancel,
  };
}

/**
 * The hint for the "Archive" menu entry from the precheck. `null` (not loaded yet) is NOT locked: the PUT checks itself and answers 409
 * with the same reasons. `t` translates only the shell sentence and the substitute for an empty title; the reasons are server text.
 */
export function archiveHint(v: ArchivePrecheck | null | undefined, t: Translator = fill): ArchiveHint {
  const open = v?.open ?? [];
  const rows: string[] = [];
  for (const o of open) {
    if ("chatId" in o) rows.push(`${o.title || t("Untitled")}: ${o.open.map((g) => g.text).join(" · ")}`);
    else rows.push(o.text);
  }
  const n = v?.terminals ?? 0;
  return {
    locked: open.length > 0,
    onlyQuestion: open.length === 1 && !("chatId" in open[0]) && open[0].reason === "question",
    rows,
    shells: n === 1 ? t("Ends 1 open shell") : n > 1 ? t("Ends {n} open shells", { n }) : "",
  };
}

/** A number from the server, or `null` if it is missing or none. Never a guessed 0. */
const count = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);

/**
 * The confirmation before archiving when shells are ended in the process: `null` means "no confirmation" and applies ONLY if the
 * precheck REPORTED 0 open shells. If it failed (`null`) or the number is missing, that is not 0 (empty is not unknown): then the entry
 * asks without a number instead of silently ending a running shell (the PUT knows no expected shell count and ends whatever is open).
 */
export function archiveShellQuestion(v: { terminals?: unknown } | null | undefined, t: Translator = fill): string | null {
  const n = count(v?.terminals);
  if (n === null) return t("Archive? Open shells could not be checked — any open shell will be ended.");
  if (n === 0) return null;
  return n === 1 ? t("Archive? 1 open shell will be ended.") : t("Archive? {n} open shells will be ended.", { n });
}

/** What the server counts on a folder (`GET /api/chat-folders/:id/archive`). */
export interface FolderCounts { chats?: unknown; contextFiles?: unknown }

/**
 * The sentence of the confirmation before PERMANENTLY deleting an archived folder, from the SERVER's numbers: `chats` is exactly the set
 * that `DELETE …?permanently=1` deletes (the same function `finalSet` there), `contextFiles` the files that go with the folder. Never
 * from the archive view's group: the search filtered it (for "invoice" one of three chats stood there, three were deleted).
 *
 * `null` if the number of chats is unknown: then nobody asks and nothing is deleted, since a confirmation without the number would not
 * hold. An unknown number of context files, in contrast, is not 0: the sentence names them without a number. The verb follows the number
 * ("1 chat will be lost"); with context files the subject is always plural.
 */
export function folderDeleteQuestion(z: FolderCounts | null | undefined, name: string, t: Translator = fill): string | null {
  const n = count(z?.chats);
  if (n === null) return null;
  const m = count(z?.contextFiles);
  const chats = n === 1 ? t("1 chat") : t("{n} chats", { n });
  if (m === null) return t("Delete folder \"{name}\" permanently? {chats} and all of the folder's context files will be lost (number unknown).", { name, chats });
  if (m > 0) {
    const files = m === 1 ? t("1 context file") : t("{n} context files", { n: m });
    return t("Delete folder \"{name}\" permanently? {chats} and {files} will be lost.", { name, chats, files: files });
  }
  return n === 1
    ? t("Delete folder \"{name}\" permanently? {chats} will be lost.##one", { name, chats })
    : t("Delete folder \"{name}\" permanently? {chats} will be lost.", { name, chats });
}

/**
 * The addition to the confirmation before DISSOLVING a folder: its context files go with it, the chats stay. 0 ⇒ no sentence; an unknown
 * number ⇒ the sentence without a number, never the silence of a guessed 0.
 */
export function contextFilesSentence(contextFiles: unknown, t: Translator = fill): string {
  const m = count(contextFiles);
  if (m === null) return t("All of the folder's context files will be deleted (number unknown).");
  return m === 1 ? t("The folder's 1 context file will be deleted.") : m > 1 ? t("The folder's {n} context files will be deleted.", { n: m }) : "";
}

/**
 * After permanently deleting a folder, the archive view reports the ids of the deleted chats with this window event (`detail: string[]`);
 * whoever holds or caches one of them (coding: `useArchive`) lets go. A window event because the coding list gets no new prop
 * (`ChatListPaneProps` stays) and the server reports the deletion to no window.
 */
export const CHATS_DELETED = "cbase-chats-deleted";

/**
 * Does `openTarget` open a chat that is NOT in the list as an archived one? Only if it is archived, of kind "normal" and belongs to
 * THIS workspace, and, where `project` is set, to this project. Only the stored PRESELECTION checks the project (there the list is already
 * filtered to the project); the address (`?chat=`) and the event `cbase-open-chat` also open an ACTIVE chat in any project, and an
 * archived one must not be treated more strictly there (the channel bar jumped into the void).
 */
export function archiveTargetMatches(
  c: { archivedAt?: number | null; kind?: string | null; workspaceId?: string | null; projectId?: string | null } | null | undefined,
  { wsId, project }: { wsId: string; project: string | null },
): boolean {
  if (!c || c.archivedAt == null) return false;
  if ((c.kind ?? "normal") !== "normal" || c.workspaceId !== wsId) return false;
  return !project || c.projectId === project;
}

// ── Flows ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The FLOWS of the confirmations live here, not in the components: there were three places where a guessed value silently stayed green
// (a catch that guesses numbers; a `?? { terminals: 0 }`; an inverted filter). The effects (fetch, confirmation, deleting) come in as
// arguments; the components pass the API functions through UNWRAPPED (`archive.test.mjs` binds that).

/**
 * Load the precheck. If it fails, that means `null`: UNKNOWN, not "no shell, no open work". An `{ open: [], terminals: 0 }` here would
 * mean the PUT ends a running shell without a word (it knows no expected shell count).
 */
export function loadPrecheck<V>(load: () => Promise<V>): Promise<V | null> {
  return load().then((v) => v, () => null);
}

/**
 * The "Archive" flow: await the precheck (a still-running fetch is awaited, a failed one is `null`), then `archiveShellQuestion`, then
 * the PUT. `false` = aborted. No substitute value for the state: `null` asks without a number.
 */
export async function archiveProcedure(
  state: Promise<{ terminals?: unknown } | null> | { terminals?: unknown } | null | undefined,
  { question, execute, t = fill }: { question: (text: string) => Promise<boolean>; execute: () => Promise<unknown>; t?: Translator },
): Promise<boolean> {
  const v = await state;
  const text = archiveShellQuestion(v, t);
  if (text && !(await question(text))) return false;
  await execute();
  return true;
}

/**
 * Which chats a permanently deleted folder really took along: those that stood in it BEFORE and are no longer in the archive AFTER the
 * reload (the server only detaches a foreign chat, it stays in the archive). If the reload failed (`null`), all seen before count as
 * gone: the server deleted the folder's kind, and that is exactly what the archive view shows.
 */
export function deletedIds(prior: string[], current: { chats: { id: string }[] } | null): string[] {
  if (!current) return prior;
  const stays = new Set(current.chats.map((c) => c.id));
  return prior.filter((id) => !stays.has(id));
}

export type FolderDeleteResult =
  | { status: "without-counts" | "aborted"; ids: [] }
  | { status: "deleted"; ids: string[] };

/**
 * The "Delete permanently" flow on an archived folder. The numbers come from the SERVER (`counts` = the folder archive precheck, the same
 * set as the DELETE); if the fetch fails, there is NO confirmation and no deleting (`without-counts`): a guessed number would mean "0
 * chats will be lost" while the DELETE deleted all. If `erase` throws, the flow throws (the view shows the error). `ids` are the ids
 * that are really gone (`deletedIds`).
 */
export async function folderPermanentlyProcedure(
  o: { id: string; name: string },
  { counts, question, erase, prior, loadAgain, t = fill }: {
    counts: (id: string) => Promise<FolderCounts>;
    question: (text: string) => Promise<boolean>;
    erase: (id: string) => Promise<unknown>;
    /** The ids of the chats that stood in the folder before deleting (from the UNFILTERED archive). */
    prior: () => string[];
    /** Reload the archive; `null` if it failed. */
    loadAgain: () => Promise<{ chats: { id: string }[] } | null>;
    t?: Translator;
  },
): Promise<FolderDeleteResult> {
  const z = await loadPrecheck(() => counts(o.id));
  const text = folderDeleteQuestion(z, o.name, t);
  if (text === null) return { status: "without-counts", ids: [] };
  if (!(await question(text))) return { status: "aborted", ids: [] };
  const ids = prior();
  await erase(o.id);
  return { status: "deleted", ids: deletedIds(ids, await loadAgain()) };
}

/**
 * The LAST click wins, not the last answer. One mark per open request; the returned check stays true only for the most recent request.
 * Before switching, the flow asks it: an older request whose fetches arrive later switches nothing anymore.
 */
export function lastWins(): () => () => boolean {
  let n = 0;
  return () => {
    const mine = ++n;
    return () => mine === n;
  };
}

/** What `openTargetProcedure` reads on a chat loaded by id. */
export interface TargetChat {
  id: string;
  archivedAt?: number | null;
  /** The chat that started this one as a background run of a graph workflow; set only on a child chat. */
  parentChatId?: string | null;
  kind?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
}

/**
 * Open a chat by id: from the list, otherwise as an archived one. `listItems` may be a promise: the caller takes the mark (`applies`) at
 * the moment of the click, BEFORE its list fetch. After every fetch the flow asks `applies()`: a meanwhile newer request (or another
 * switch) wins, this one opens nothing anymore. The metadata stand BEFORE switching (`setMeta` before `open`). `false` = not opened.
 *
 * Also for a CHILD chat (`parentChatId` set): it is not archived but appears in no chat list; without metadata it would stand untitled
 * for the length of a fetch. It arrives via the event route (`openOtherwise`: card in "Background Tasks", bell, push);
 * `archiveTargetMatches` stays unchanged, so the preselection does not open it. Not archived ⇒ the composer stays open.
 *
 * `openId`: the chat that is OPEN right now (ChatPane `activeIdRef.current`). If it is the target, the flow opens nothing anew and reports
 * `true`: `open()` would otherwise empty pending attachments and approval cards, reset `busy` and rebuild the stream just because a jump
 * ("1 chat running ›", "Agent in chat", bell, pill) pointed at the open chat. The caller's mark still applies from the click (an older,
 * still-running request for another chat no longer switches). `alreadyOpen` then runs instead of opening (ChatPane: a folder view
 * above the chat closes; "a chat wins" as in `open`).
 */
export async function openTargetProcedure<C extends TargetChat>(
  id: string,
  listItems: { id: string }[] | Promise<{ id: string }[]>,
  { applies, loadChat, setMeta, open, wsId, project, openOtherwise = false, openId = null, alreadyOpen }: {
    applies: () => boolean;
    loadChat: (id: string) => Promise<C | null>;
    setMeta: (c: C) => void;
    open: (id: string) => Promise<void>;
    wsId: string;
    project: string | null;
    openOtherwise?: boolean;
    /** The chat open right now; if it is the target, nothing is opened anew. */
    openId?: string | null;
    alreadyOpen?: () => void;
  },
): Promise<boolean> {
  if (openId !== null && openId === id) { alreadyOpen?.(); return true; }
  const list = await listItems;
  if (!applies()) return false;
  if (list.some((x) => x.id === id)) { await open(id); return true; }
  let c: C | null = null;
  try { c = await loadChat(id); } catch { /* an error is no answer "does not exist", and no opening */ }
  if (!applies()) return false;
  if (!archiveTargetMatches(c, { wsId, project }) && !openOtherwise) return false;
  if (c && (c.archivedAt != null || Boolean(c.parentChatId))) setMeta(c);
  await open(id);
  return true;
}

/**
 * What a repeated fetch about an open ARCHIVED chat says. `load` is `loadArchiveChat` (`null` ONLY on 404). Deleted (from another
 * window; the server reports deletions to none) ⇒ `deleted`, the client lets go of it. An error is `unknown`, never "deleted".
 */
export async function recheckArchive<C extends { archivedAt?: number | null }>(
  id: string,
  load: (id: string) => Promise<C | null>,
): Promise<{ state: "deleted" | "archived" | "back" | "unknown"; chat: C | null }> {
  let c: C | null;
  try { c = await load(id); } catch { return { state: "unknown", chat: null }; }
  if (c === null) return { state: "deleted", chat: null };
  return { state: c.archivedAt != null ? "archived" : "back", chat: c };
}
