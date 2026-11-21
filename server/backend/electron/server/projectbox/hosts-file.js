// The block of the project names in /etc/hosts of the user container. A leaf: only node:*. Which names belong in is computed by
// projectbox/names.js; here stands only HOW the block gets into the file.
//
// withHostsBlock(old, entries)       PURE: the new text. The block stands between `# cbase-projects BEGIN` and `# cbase-projects END`,
//     one line `<ip> <name>` per entry. It replaces an existing block in its place, is appended if there is none, and disappears
//     entirely if there is no entry. Every foreign line stays byte-equal (read and written as latin1: one byte per character, also what
//     is no UTF-8). A broken block (BEGIN without END, END without BEGIN) is an ERROR, no reason to guess: an "until the end of the
//     file" would take foreign lines along that someone wrote behind an orphaned BEGIN. Several complete blocks become one (at the place
//     of the first). If the file has no final line ending, the last foreign line gets one — otherwise BEGIN would stand on it — and it
//     stays when the block falls again later.
// writeHostsBlock(path, entries)     reads, computes, writes with ONE `fs.writeFileSync` (O_TRUNC: the same inode — the file is in B the
//     target of a bind mount of the outer Docker; tmp + rename would create a new inode, and B would keep seeing the old file).
//     Unchanged ⇒ no write. Not readable, not writable, broken block ⇒ a message on stderr and `{ error }`, NEVER a throw: a missing name
//     is no reason to let a creation or a deletion fail (the next start of B writes the block anew). A file that does not exist is not
//     created.
// hostsPath()                         `CBASE_HOSTS_FILE` (test seam, read at run time) or /etc/hosts.
//
// Entry: `{ ip, name }`. An ip that is no IPv4/IPv6 address, or a name that is no hostname, is NOT written (`skipped` with reason) —
// what stands here is read by every resolver in B; a line break in a name would write a foreign line. A name that already stands in the
// block counts once (the first wins, like in the resolver).
import fs from "node:fs";
import net from "node:net";

export const BLOCK_BEGINNING = "# cbase-projects BEGIN";
export const BLOCK_END = "# cbase-projects END";
export const HOSTS_DEFAULT = "/etc/hosts";
export const hostsPath = () => process.env.CBASE_HOSTS_FILE || HOSTS_DEFAULT;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/** The valid entries and the skipped ones (with reason). */
export function checkEntries(entries) {
  const gut = [];
  const skipped = [];
  const names = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    const ip = String(e?.ip ?? "");
    const name = String(e?.name ?? "");
    if (!net.isIP(ip)) { skipped.push({ ip, name, reason: "not an IP address" }); continue; }
    if (!HOSTNAME.test(name)) { skipped.push({ ip, name, reason: "not a hostname" }); continue; }
    if (names.has(name)) { skipped.push({ ip, name, reason: "name twice" }); continue; }
    names.add(name);
    gut.push({ ip, name });
  }
  return { gut, skipped };
}

const withoutCr = (z) => (z.endsWith("\r") ? z.slice(0, -1) : z);

/** The new text of the file — pure. Returns `{ text, skipped }` or `{ error }`. */
export function withHostsBlock(old, entries) {
  const { gut, skipped } = checkEntries(entries);
  const rows = String(old ?? "").split("\n");
  // A final line ending gives an empty last element — it is NO line and stays at the end.
  const endsWithLineEnding = rows.length > 1 && rows[rows.length - 1] === "";
  if (endsWithLineEnding || (rows.length === 1 && rows[0] === "")) rows.pop();

  const keep = [];
  let insertAt = -1;
  let open = -1;
  for (let i = 0; i < rows.length; i++) {
    const z = withoutCr(rows[i]);
    if (z === BLOCK_BEGINNING) {
      if (open >= 0) return { error: `broken block: second “${BLOCK_BEGINNING}” in line ${i + 1} without “${BLOCK_END}” after line ${open + 1}` };
      open = i;
      if (insertAt < 0) insertAt = keep.length;
      continue;
    }
    if (z === BLOCK_END) {
      if (open < 0) return { error: `broken block: “${BLOCK_END}” in line ${i + 1} without “${BLOCK_BEGINNING}”` };
      open = -1;
      continue;
    }
    if (open < 0) keep.push(rows[i]);
  }
  if (open >= 0) return { error: `broken block: “${BLOCK_BEGINNING}” in line ${open + 1} without “${BLOCK_END}”` };

  const block = gut.length ? [BLOCK_BEGINNING, ...gut.map((e) => `${e.ip} ${e.name}`), BLOCK_END] : [];
  const fresh = insertAt >= 0
    ? [...keep.slice(0, insertAt), ...block, ...keep.slice(insertAt)]
    : [...keep, ...block];
  // Line ending at the end: as before — and always when the block newly came to the end (END closes a line).
  const blockAppended = block.length > 0 && insertAt < 0;
  const withEnd = fresh.length > 0 && (endsWithLineEnding || blockAppended);
  return { text: fresh.join("\n") + (withEnd ? "\n" : ""), skipped };
}

/**
 * Set the block in `path`. Returns `{ written, unchanged, error, skipped }` — never a throw.
 * @param {string} path
 * @param {{ ip: string, name: string }[]} entries
 */
export function writeHostsBlock(path, entries) {
  const out = { written: false, unchanged: false, error: null, skipped: [] };
  let old;
  try { old = fs.readFileSync(path, "latin1"); } catch (e) {
    out.error = `${path} not readable (${e?.code || e?.message || e}) — the names of the project containers are missing there`;
    console.warn(`[projectbox] ${out.error}`);
    return out;
  }
  const r = withHostsBlock(old, entries);
  if (r.error) {
    out.error = `${path}: ${r.error} — nothing written`;
    console.warn(`[projectbox] ${out.error}`);
    return out;
  }
  out.skipped = r.skipped;
  for (const u of r.skipped) console.warn(`[projectbox] ${path}: “${u.ip} ${u.name}” not written (${u.reason})`);
  if (r.text === old) { out.unchanged = true; return out; }
  try {
    fs.writeFileSync(path, r.text, "latin1");
    out.written = true;
  } catch (e) {
    out.error = `${path} not writable (${e?.code || e?.message || e}) — the names of the project containers are missing there (entry.sh gives agent the permission)`;
    console.warn(`[projectbox] ${out.error}`);
  }
  return out;
}
