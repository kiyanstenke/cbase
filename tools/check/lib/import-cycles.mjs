// Import CYCLES: Tarjan over a file set, and the verdict against a named list.
//
// Shared by the server guard (server/backend/test/import-direction.test.js) and the web guard, so the calculation does
// not exist twice. The ONLY parameter is the edge construction: the server resolves `./x.js` relatively, the web
// additionally `@/` and `.js → .ts/.tsx` and drops type imports — the RESOLUTION belongs to the language, the CYCLE
// COMPUTATION does not.
//
// The list is built so that it is printed on every run, may only shrink, and goes red on a new cycle, a grown one,
// two merged ones, a broken-up one — AND on an entry without a cycle. Whoever resolves a cycle turns the suite red
// until they remove its entry.
//
// A `.test.js` must not import another (its tests would run twice) — hence a library and no borrowing from the
// neighbouring test.

// A cycle is named by its size and its edges — derived, so no name can drift.
export const cycleShort = (files) => `[${files.length}] ${files[0]}${files.length > 1 ? ` … ${files[files.length - 1]}` : ""}`;

/**
 * The import cycles of a file set (strongly connected components, Tarjan). Pure: no file, no process state.
 * Each cycle comes sorted alphabetically, the cycles by size — the output is the comparison value against the
 * list, it must not depend on the read order.
 * @param {{path: string, text: string}[]} files  paths relative to electron/server, posix
 * @returns {string[][]}
 */
export function importCycles(files, edgesOf) {
  const node = files.map((f) => f.path.split("\\").join("/"));
  const inSet = new Set(node);
  const edgeList = new Map();
  for (const f of files) {
    const rel = f.path.split("\\").join("/");
    edgeList.set(rel, [...new Set(edgesOf(f, inSet))].filter((z) => inSet.has(z)));
  }
  const index = new Map(), deep = new Map(), onStack = new Set(), stack = [], cycles = [];
  let counter = 0;
  // Recursive: the depth is the longest path in the tree (a good 140 files) — an iterative version
  // would be three times as long for nothing.
  const visits = (v) => {
    index.set(v, counter); deep.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of edgeList.get(v) || []) {
      if (!index.has(w)) { visits(w); deep.set(v, Math.min(deep.get(v), deep.get(w))); }
      else if (onStack.has(w)) deep.set(v, Math.min(deep.get(v), index.get(w)));
    }
    if (deep.get(v) !== index.get(v)) return;
    const component = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); component.push(w); } while (w !== v);
    // A component of ONE file is a cycle only if it imports itself.
    if (component.length > 1 || (edgeList.get(v) || []).includes(v)) cycles.push(component.sort());
  };
  for (const v of node) if (!index.has(v)) visits(v);
  return cycles.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/**
 * The violations of measured cycles against the allow list. Matching is by INTERSECTION, not by equality:
 * only so is a grown cycle distinguishable from a new one.
 * @param {string[][]} cycles  from importCycles
 * @param {{files: string[], reason: string, followUpJob: string}[]} allowed
 * @returns {string[]}
 */
export function cycleViolations(cycles, allowed) {
  const violations = [];
  const alreadyNamed = new Map();
  const sets = allowed.map((e, i) => {
    if (!Array.isArray(e.files) || !e.files.length || !e.reason || !e.followUpJob) {
      violations.push(`Entry ${i + 1} incomplete — every cycle needs a file set, reason and follow-up job`);
    }
    for (const d of e.files || []) {
      if (alreadyNamed.has(d)) violations.push(`${d} is in two entries (${alreadyNamed.get(d)} and ${cycleShort(e.files)}) — one cycle, one entry`);
      else alreadyNamed.set(d, cycleShort(e.files));
    }
    return new Set(e.files || []);
  });
  const hit = allowed.map(() => new Set());
  // How many CYCLES per entry? An entry stands for ONE cycle. If it breaks up into two smaller ones, both
  // together still cover its whole file set — "grew" and "shrank" are then both silent, and the too wide
  // entry would let the cycle silently grow back to the old set.
  const cyclesPerEntry = allowed.map(() => 0);
  for (const cycle of cycles) {
    const hits = sets.map((s, i) => (cycle.some((d) => s.has(d)) ? i : -1)).filter((i) => i >= 0);
    for (const i of hits) { for (const d of cycle) if (sets[i].has(d)) hit[i].add(d); cyclesPerEntry[i]++; }
    if (!hits.length) {
      violations.push(`NEW cycle ${cycleShort(cycle)}: ${cycle.join(", ")} — no entry in CYCLES_ALLOWED. Revert the edge; or, if the cycle is intended, name it (file set, reason, follow-up job)`);
      continue;
    }
    if (hits.length > 1) {
      violations.push(`Cycle ${cycleShort(cycle)} pulls ${hits.length} known cycles together (${hits.map((i) => cycleShort(allowed[i].files)).join(" + ")}) — a new edge has connected them`);
      continue;
    }
    const grown = cycle.filter((d) => !sets[hits[0]].has(d));
    if (grown.length) violations.push(`Cycle ${cycleShort(allowed[hits[0]].files)} GREW by ${grown.length}: ${grown.join(", ")} — the list may only shrink`);
  }
  allowed.forEach((e, i) => {
    if (!e.files?.length) return;                    // already reported above
    if (!hit[i].size) {
      violations.push(`Entry ${cycleShort(e.files)} has no cycle anymore — remove it (it stood for: ${e.followUpJob})`);
      return;
    }
    if (cyclesPerEntry[i] > 1) {
      violations.push(`Entry ${cycleShort(e.files)} BROKE UP into ${cyclesPerEntry[i]} cycles — one entry per cycle; an entry covering two cycles is too wide and lets them silently grow together again`);
      return;
    }
    const way = e.files.filter((d) => !hit[i].has(d));
    if (way.length) violations.push(`Entry ${cycleShort(e.files)} SHRANK by ${way.length}: ${way.join(", ")} are in no cycle anymore — shorten the entry, otherwise it silently grows back`);
  });
  return violations;
}

