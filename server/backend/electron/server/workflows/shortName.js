// Short name of a graph workflow: the form under which a workflow is named in a message — `/workflow:<shortname>`.
//
// A leaf without imports. The server computes the short name ONCE over the effective set of a chat (or of a
// workspace/project) and delivers it in both picker lists; web and iOS do not compute it themselves — two computations
// in two languages would be two truths.
//
// shortBase(name)        the base form: lowercase, umlauts spelled out, accents removed, every run of other characters
//                        "-", no "-" at the edges, at most 60 characters, empty ⇒ "workflow". The rule is a copy of
//                        `store/_util.js:slugifyTitle` without its special case, so the leaf stays import-free.
// withShortNames(list)   per entry `shortName`, unique across the list: in creation order (createdAt, then id) each
//                        takes the first free name from base, base-2, base-3, … — stable whatever order the list
//                        arrives in. Returned in INPUT order.
// WORKFLOW_MENTION       the mention in a text; counts at the start and after whitespace (several names in one
//                        message), never inside a word or path (`path/workflow:x`). Compared in lowercase.
// withoutQuotes(text)    the text without its quote lines ("> …") — what stands there, the human did not say themselves.
// mentions(text)         the short names mentioned in the human's OWN lines — lowercase, each name once, in order of
//                        mention. Lives in this leaf so the web test and the server check the same computation
//                        (web/test/slash.test.mjs binds it to `web/src/lib/quotes.ts`); `slash-workflow.js` re-exports it.

export const SHORT_MAX = 60;

export function shortBase(name) {
  const base = String(name || "")
    .toLowerCase()
    .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, SHORT_MAX).replace(/-+$/, "");
  return base || "workflow";
}

const creationFollowUp = (a, b) => {
  const ca = Number(a.createdAt) || 0;
  const cb = Number(b.createdAt) || 0;
  if (ca !== cb) return ca - cb;
  const ia = String(a.id ?? "");
  const ib = String(b.id ?? "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
};

export function withShortNames(list) {
  const entries = Array.isArray(list) ? list : [];
  const allocated = new Set();
  const short = new Array(entries.length);
  const followUp = entries.map((w, i) => ({ w, i })).sort((a, b) => creationFollowUp(a.w, b.w));
  for (const { w, i } of followUp) {
    const base = shortBase(w.name);
    let k = base;
    for (let n = 2; allocated.has(k); n++) k = `${base}-${n}`;
    allocated.add(k);
    short[i] = k;
  }
  return entries.map((w, i) => ({ ...w, shortName: short[i] }));
}

// Group 1 is the mentioned short name (any case — comparison happens in lowercase). With `g`: whoever uses `exec` in
// a loop resets `lastIndex`; `matchAll` does that by itself.
export const WORKFLOW_MENTION = /(?:^|\s)\/workflow:([a-z0-9][a-z0-9-]{0,63})(?=$|[\s.,;:!?)])/gi;

// A quote line: a ">" at the start (after whitespace). Web and iOS put quotes from the history BEFORE the human's own
// message this way — every line with "> ", the fence around foreign text. A mention inside a quote never counts:
// otherwise a quoted agent sentence "then start /workflow:ship" would become the human's announcement, and a quoted
// UNKNOWN name would make the reply unsendable (404). A quote is data, not an instruction.
const QUOTE_ROW = /^[ \t]*>/;
export function withoutQuotes(text) {
  return String(text ?? "").split("\n").filter((row) => !QUOTE_ROW.test(row)).join("\n");
}

export function mentions(text) {
  const out = [];
  for (const m of withoutQuotes(text).matchAll(WORKFLOW_MENTION)) {
    const k = m[1].toLowerCase();
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
