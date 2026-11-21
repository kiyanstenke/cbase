// The distribution of the project image into every user container. Guard: tools/check/projectbox-distribution.test.mjs.
//
// WHAT HOLDS. Every running user container ("B") holds `cbase-projectbox:latest` inside, and this tag NEVER points at anything
// unchecked: the backend creates every project container from it. Two steps per B:
//   PREPARE (`prepareProjectbox`)
//   1. read the inner id (`docker exec -u agent <B> docker image inspect … cbase-projectbox:latest`);
//   2. equal to the id of the host candidate `cbase-projectbox:cand-<release>` ⇒ only remove leftover probe containers (for
//      EVERY readable plan, not only before a probe). Likewise if the ids differ but both carry the same SOURCE (label
//      `cbase.projectbox.source`, lib/projectbox.mjs): then only the host's build cache produced a new id, and loading would
//      recreate every project container. Without a label on either side (older release, rollback rebuild) the id counts as
//      before. Otherwise
//   3. load: `docker save <cand> | docker exec -i -u agent <B> docker load` as a STREAM (nothing lands on the host's disk). If
//      the id already lies inside (after a rollback, or a tag was lost), only put the name `<cand>` on it inside — no
//      stream. Then the inner id of the candidate against the host's (hash, no timestamp);
//   4. the start probe inside: `docker run -d --privileged -e CBASE_DOCKER_POOL=<probe pool> --label cbase.probe=1 <cand>`,
//      wait until `docker exec <id> docker info` answers AND the entrypoint's status file says `phase=ready` (`error`/`ended`
//      ⇒ EXIT.STATUS with its notice; loop until the event; if the probe container dies, stop at once with its last log lines;
//      product cap PROBE_CAP attempts at one-second intervals, with a message), then `git lfs version` and `git config --system
//      --get-all credential.helper` in the probe container (both or neither, see `lfsPart`),
//      `docker rm -f -v <id>` by id (`-v`: an anonymous volume, e.g. from a VOLUME of the image, goes with it). If the probe
//      container stays, the probe counts as failed — otherwise a privileged dockerd that nobody removes would stand next to the
//      tag. If 3 or 4 fail anywhere — also a `docker run` or `docker load` that itself fails —, the freshly set name `<cand>` is
//      gone again (an unchecked candidate must not lie around inside), and the script ends with a code from EXIT.
//   REPOINT (`repointProjectbox`)
//   5. per B whose preparation passed: the id of `<cand>` inside once more against the checked one, then inside
//      `docker tag <cand> cbase-projectbox:latest`. A B that arrived since the preparation is prepared here (1–4 with the same
//      host id); if the host candidate was missing, each B shows that reason;
//   6. clean up: inside the two most recent candidates stay (by release, `cand-<release>`), older ones go by id — except :latest
//      and every image that any container in B uses (a stopped project container too).
//
// A FAILURE IN ONE B ONLY HOLDS BACK ITS TAG. Nothing here throws because of one B: its :latest stays as it was (a checked older
// candidate), the row is red in the table, a warning says what stays, and the next deploy tries again. Only the DEPLOY throws if
// the host candidate is missing or unreadable: it was built and checked lines before, "missing" is a read error there — and the
// preparation stands before the tag, so nothing is repointed yet. In the ROLLBACK "missing" means "the target release is older
// than the project box (or its candidate was cleaned up)": a warning, also in a dry run (`candidateGetsBuilt`).
//
// EVERY CALL INTO B HAS A CAP. `dx` = `timeout <EXEC_CAP_S> docker exec -u agent <B> …`, the stream when loading `timeout
// <LOAD_CAP_S>`; if one expires (GNU timeout, exit 124), "Cap exceeded: …" stands in the message, and the B counts as unknown
// resp. failed. The attempt caps (DAEMON_CAP, PROBE_CAP) count only loop rounds; a single hanging `docker exec` (sysbox, an inner
// dockerd that no longer answers) would otherwise hold the tool indefinitely — and every `./deploy server` enters every B before
// the gate, even without a needed swap.
//
// WHERE IT RUNS. Deploy (`targets/server.mjs` rollOutAfterBackendBuild): PREPARE after the check of both images and BEFORE
// `docker tag <cand> cbase-backend:latest`, REPOINT at the start of swapContainer — before the early return "all already run this
// image" (else the distribution would never run when only the project box changes) and before the idle gate (else the ≈ 100 s
// per B would lie between the idle verdict and the swap). Loading without idle is harmless: tagging happens only after the probe,
// and a project container is recreated only when its project is idle. Rollback (`targets/rollback.mjs`): both in a row
// (`distributeProjectbox`) with the TARGET release — only AFTER every B is swapped, healthy and its inner containers fetched
// back and `:latest`/`current` of the host are repointed (swap first, then repoint). All docker commands run via ssh on the host,
// like the rest of the deploy tool.
//
// THE PROBE POOL `10.249.0.0/16`. The probe container hangs on B's default network (docker0 in 172.16.0.0/12), its inner dockerd
// creates its docker0 from this pool — visible only in the probe's network namespace, B has no route there (measured: the inner
// pools need not differ per project container). Still a range of its own that coincides with NOTHING in B (OCCUPIED_RANGES,
// guard in the test): not level 2 (10.230.0.0/16), not the inner pool of the project containers (10.241.0.0/16) — a leftover probe
// container is thus told from a project container by its address —, not the block list (LAN, wg0/wg1, host bridges, eth0 of B)
// and not the default pools of B's own daemon (172.17–172.31/16, 192.168.0.0/16), from which docker0 and the networks of
// unconverted stacks come. Size 24 as in the entrypoint; /16 is the measured form.
import { config } from "../config.mjs";
import { isDryRun } from "../../check/lib/sh.mjs";
import { sshAct, sshProbe } from "./ssh.mjs";
import { readImageId } from "./remote.mjs";
import { projectboxCand } from "../../check/lib/projectbox.mjs";
import {
  readScript as readScriptOf, tagScript as tagScriptOf, short, projectboxPlan, sourceFromLabels, projectboxSituation, cleanupPlan,
  projectboxRows, leftoversScript, prepareScript, cleanupScript,
} from "../../check/lib/projectbox-scripts.mjs";
import * as log from "../../check/lib/log.mjs";

// The pure part lives in projectbox-scripts.mjs (public leaf); everything is re-exported here, with the configured image name where
// the scripts need one.
export * from "../../check/lib/projectbox-scripts.mjs";
export const readScript = (container, options = {}) => readScriptOf(container, { image: config.remote.projectboxImage, ...options });
export const tagScript = (options) => tagScriptOf({ image: config.remote.projectboxImage, ...options });
const latestRef = () => `${config.remote.projectboxImage}:latest`;

// ── The flow (ssh) ───────────────────────────────────────────────────────────────────────────────────────────────────

// The source of a host image (label) — null if it carries none or is unreadable (then the id counts).
async function hostSourceRead(ref) {
  const r = await sshProbe(`docker image inspect --format '{{json .Config.Labels}}' ${ref}`, { check: false });
  return r.code === 0 ? sourceFromLabels(r.stdout) : null;
}

const lastRows = (r) => `${r.stderr || ""}\n${r.stdout || ""}`.split("\n").map((z) => z.trim()).filter(Boolean).slice(-3).join(" · ");
const leftoversCount = (r) => (/^Probe leftovers removed: (\d+)$/m.exec(r.stdout || "") || [])[1];

// PREPARE — per running B read, load, check the id, start probe; NO tag. Returns { cause, cand, hostId, dry, perB, withoutCandidate,
// hostUnknown } with `perB`: Map<B, { state, situation, reason }>, state ∈ current · ready · dry · unknown · failed.
// `withoutCandidate`/`hostUnknown` say why `perB` stayed empty — the repoint then names THIS reason per B, not "not prepared".
// `candidateGetsBuilt` (deploy): a missing host candidate is a read error (real run) resp. "not built yet" (dry run); without
// (rollback): "missing" is a warning — in a real run as in a dry run.
// The host candidate is read even without a running B: one that arrives before the repoint is caught up there with the same id.
export async function prepareProjectbox({ containers, release, cause = "Deploy", candidateGetsBuilt = false }) {
  log.step(`Preparing project box (${cause})`);
  const cand = projectboxCand(release, config.remote.projectboxImage);
  const empty = { cause, cand, hostId: null, dry: false, perB: new Map(), withoutCandidate: false, hostUnknown: null };
  const host = await readImageId(cand);
  const notReattached = `Nothing was repointed: ${config.remote.image}:latest and current stand as they stood — roll out again.`;
  if (host.unknown) {
    if (candidateGetsBuilt) throw new Error(`Host candidate ${cand} is not readable (${host.unknown}). ${notReattached}`);
    log.warn(`Host candidate ${cand} is not readable (${host.unknown}) — nothing distributed; inside ${latestRef()} stays as it is.`);
    return { ...empty, hostUnknown: host.unknown, error: [`Host candidate ${cand} not readable: ${host.unknown}`] };
  }
  const dry = Boolean(host.missing && candidateGetsBuilt && isDryRun());
  if (host.missing && !dry) {
    if (candidateGetsBuilt) throw new Error(`Host candidate ${cand} is missing although it was just built and checked. ${notReattached}`);
    log.warn(`Host candidate ${cand} is missing — nothing distributed (the target release is older than the project box, or its candidate was cleaned up); inside ${latestRef()} stays as it is.`);
    return { ...empty, withoutCandidate: true };
  }
  const hostId = host.id || null;
  const hostSource = hostId ? await hostSourceRead(cand) : null;
  if (!containers.length) {
    log.detail("no running user container — nothing to distribute (a stopped one gets it with the next deploy)");
    return { ...empty, hostId, hostSource, dry };
  }
  if (dry) log.detail(`(dry run: ${cand} is not built — the path for a deviating id is shown)`);
  const perB = new Map();
  const rows = [];
  for (const c of containers) {
    const { st, row } = await prepareOneBefore(c, { cand, hostId, hostSource, dry, tag: containers.length > 1 ? ` (${c.slice(0, 26)}…)` : "" });
    perB.set(c, st);
    rows.push(row);
  }
  log.table(rows);
  return { ...empty, hostId, hostSource, dry, perB };
}

// One B: read (until its inner Docker answers), plan, then clear leftovers resp. prepare. Returns { st, row }.
async function prepareOneBefore(c, { cand, hostId, hostSource = null, dry, tag, addition = "" }) {
  const situation = projectboxSituation((await sshProbe(readScript(c, { wait: true }))).stdout);
  const plan = dry
    ? (situation.latest === "unknown" ? "unknown" : "load")
    : projectboxPlan({ hostId, inside: { [c]: situation.latest }, hostSource, insideSource: { [c]: situation.source } })[c];
  const label = `Project box inside${tag}`;
  if (plan === "unknown") {
    const reason = situation.daemon || situation.reason || "not readable";
    return { st: { state: "unknown", situation, reason }, row: [label, `unknown (${reason})${addition} — nothing loaded, nothing tagged; the next deploy distributes`, "warn"] };
  }
  if (plan === "nothing" || plan === "source") {
    const r = await sshAct(leftoversScript(c), { check: false });
    const n = leftoversCount(r);
    const st = { state: "current", situation, reason: null };
    const like = plan === "source"
      ? `current by source (${short(hostSource)}): inside ${short(situation.latest)}, ${cand} ${short(hostId)} — not distributed, the project containers stay`
      : `current (${cand}, ${short(hostId)})`;
    if (!r.skipped && r.code !== 0) return { st, row: [label, `${like}${addition}; probe leftovers NOT removed: ${lastRows(r)}`, "warn"] };
    return { st, row: [label, `${like}${addition}${n ? `; ${n} probe leftover(s) removed` : ""}`, "ok"] };
  }
  const r = await sshAct(prepareScript({ container: c, cand, hostId: hostId || `<id of ${cand}>`, dry }), { check: false });
  if (r.skipped) return { st: { state: "dry", situation, reason: null }, row: [label, `Dry run${addition}: load, start probe (commands above)`, null] };
  if (r.code !== 0) {
    const reason = `exit ${r.code} — ${lastRows(r)}`;
    return { st: { state: "failed", situation, reason }, row: [label, `FAILED${addition} (${reason}) — ${latestRef()} inside stays as it is`, "bad"] };
  }
  return { st: { state: "ready", situation, reason: null }, row: [label, `${cand} (${short(hostId)}) lies inside, start probe passed${addition} — repointed with the new state`, "ok"] };
}

// REPOINT — per B whose preparation passed, `<cand>` → :latest inside, then clean up. `containers`: the B that are running NOW. One
// that arrived since the preparation (the gateway creates at any time) is prepared HERE — with the already checked host candidate,
// else it would stay without a project box until the next deploy. If the host candidate was missing or unreadable, each B shows
// exactly that, not "not prepared". Never throws because of one B: returns { plan, error }, and a warning says what stays.
export async function repointProjectbox(preparation, { containers = null } = {}) {
  if (!preparation || !(preparation.perB instanceof Map)) throw new TypeError("repointProjectbox: the preparation (prepareProjectbox) is missing");
  const { cause, cand, hostId, hostSource = null, dry, withoutCandidate = false, hostUnknown = null } = preparation;
  const perB = new Map(preparation.perB);
  const error = [...(preparation.error || [])];
  const plan = {};
  const rows = [];
  const names = [...new Set([...perB.keys(), ...(containers || [])])];
  const tag = (c) => (names.length > 1 ? ` (${c.slice(0, 26)}…)` : "");
  const fresh = (containers || []).filter((c) => !perB.has(c));
  const toTag = [...perB.keys()].filter((c) => ["ready", "dry"].includes(perB.get(c).state));
  if (toTag.length || fresh.length) log.step(`Repointing project box (${cause})`);
  for (const c of fresh) {
    const label = `Project box inside${tag(c)}`;
    if (hostUnknown) {
      plan[c] = "unknown";
      rows.push([label, `Host candidate ${cand} not readable (${hostUnknown}) — inside ${latestRef()} stays as it is`, "warn"]);
    } else if (withoutCandidate) {
      plan[c] = "without candidate";
      rows.push([label, `Host candidate ${cand} is missing — inside ${latestRef()} stays as it is`, "warn"]);
    } else if (dry || !hostId) {
      plan[c] = "not prepared";
      rows.push([label, "not prepared (was not running at the preparation, dry run) — the next deploy distributes", "warn"]);
    } else {
      const { st, row } = await prepareOneBefore(c, { cand, hostId, hostSource, dry: false, tag: tag(c), addition: " (arrived only at the repoint)" });
      perB.set(c, st);
      rows.push(row);
      if (st.state === "ready") toTag.push(c);
    }
  }
  for (const [c, st] of perB) {
    plan[c] = st.state;
    if (st.state === "failed") error.push(`${c}: ${st.reason}`);
  }
  for (const c of toTag) {
    const r = await sshAct(tagScript({ container: c, ref: cand, hostId: hostId || `<id of ${cand}>`, dry }), { check: false });
    if (r.skipped) { rows.push([`Project box inside${tag(c)}`, "Dry run: tag (command above)", null]); continue; }
    if (r.code !== 0) {
      const reason = `Exit ${r.code} — ${lastRows(r)}`;
      plan[c] = "failed";
      error.push(`${c}: ${reason}`);
      rows.push([`Project box inside${tag(c)}`, `FAILED at the repoint (${reason}) — ${latestRef()} inside stays as it is`, "bad"]);
      continue;
    }
    plan[c] = "reattached";
    const prior = perB.get(c).situation?.latest;
    rows.push([`Project box inside${tag(c)}`, `${prior ? `${short(prior)} → ` : ""}${cand} (${short(hostId)}), start probe passed`, "ok"]);
    const after = projectboxSituation((await sshProbe(readScript(c))).stdout);
    const on = cleanupPlan({ images: after.images, used: after.used, latest: after.latest });
    if (on.unknown) log.detail(`${c}: candidates inside not readable — nothing cleaned up`);
    else if (on.remove.length) {
      log.detail(`${c}: ${on.remove.length} old candidate(s) removed inside by id (staying: ${on.stay.join(", ")})`);
      await sshAct(cleanupScript({ container: c, ids: on.remove }), { check: false });
    }
  }
  if (rows.length) log.table(rows);
  if (error.length) {
    log.warn(`Project box (${cause}): ${error.join("; ")}. There ${latestRef()} stays inside on the previous, checked state — everything else goes on; the next deploy tries again (./deploy status shows the state per B).`);
  }
  return { plan, error };
}

// Both in a row — the rollback (after swap, repointing of the host and fetching back the inner containers).
export async function distributeProjectbox({ containers, release, cause = "Rollback", candidateGetsBuilt = false }) {
  const v = await prepareProjectbox({ containers, release, cause, candidateGetsBuilt });
  return repointProjectbox(v, { containers });
}

// For `./deploy status` (the wiring as ONE function that the guard drives): the host candidate of the running release and per B the
// two rows — read-only, without waiting for the inner Docker. Returns { header, perB: Map<B, rows> }.
export async function projectboxStatus({ release, containers }) {
  const hostRef = release ? projectboxCand(release, config.remote.projectboxImage) : null;
  const host = hostRef ? await readImageId(hostRef) : null;
  const hostSource = host?.id ? await hostSourceRead(hostRef) : null;
  const header = [
    "Project box candidate (host)",
    !hostRef ? "—" : host.id ? `${hostRef} (${short(host.id)})` : host.missing ? `${hostRef} missing (release older than the project box?)` : `${hostRef} not readable (${host.unknown})`,
    host?.id ? null : "warn",
  ];
  const perB = new Map();
  for (const c of containers) {
    const situation = projectboxSituation((await sshProbe(readScript(c))).stdout);
    perB.set(c, projectboxRows({ situation, hostId: host?.id || null, hostRef, hostUnknown: host?.unknown || null, hostSource }));
  }
  return { header, perB };
}
