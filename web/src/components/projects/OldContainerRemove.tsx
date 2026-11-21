"use client";

// Remove the old containers of renamed stacks.
//
// After a layout change the containers of a renamed compose stack stay behind, stopped (the new stack's DB starts empty, the old
// one lives in them). The project's services page then shows the section "Old containers (N)" (field `superseded` on the project);
// the button reads the inventory (`GET …/superseded`, in the project container), the confirmation names every container and data
// area with name and size, and exactly what was shown is confirmed (`POST …/superseded/remove` with `confirmed`, including the
// containers that were shown as running — one started since stays) — anything that was added afterwards, or that another
// container uses in the meantime, stays (server, `superseded.js`). The end is reported by the event `project/superseded`; if it
// is lost in a gap of the stream, polling `GET …/superseded?status=1` (every 5 s while it runs) fetches the report as `last`.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeGlobalEvents } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Hint, Modal, ModalTitle, Spinner, ghost, pill } from "@/components/CbKit";
import { sizeText } from "@/components/projects/ProjectLayout";
import { Section, S } from "@/components/projects/ProjectForm";

interface Stack {
  stackPrior: string;
  stackNow: string;
  since: number;
  container: { id: string; name: string; state: string; size: number | null }[];
  volumes: { name: string; size: number | null }[];
  networks: { id: string; name: string }[];
  images: { id: string; name: string; size: number | null }[];
}
interface Stays { kind: string; name: string; reason: string }
interface End {
  state: "finished" | "error";
  since?: number;
  removed: { container: string[]; volumes: string[]; networks: string[]; images: string[]; bytes: number };
  stays: Stays[];
  error?: string;
}
interface Inventory {
  stacks: Stack[];
  stays: Stays[];
  total: { bytes: number; withoutSize: number };
  running: boolean;
  last?: End;
}

const danger = `${pill} bg-danger text-white hover:opacity-90`;
const errorOf = (e: unknown) => String((e as Error)?.message || e);
const KIND: Record<string, string> = { container: "container", volume: "Data volume", network: "Network", image: "Image" };
/** Like the server's `RUNNING`: removal stops these containers first. */
const RUNNING = new Set(["running", "restarting", "paused"]);
const STATE: Record<string, string> = {
  missing: "already gone",
  running: "running (started by hand)",
  restarting: "restarting (running)",
  paused: "paused (running)",
  exited: "stopped",
  created: "created",
  dead: "dead",
};
const INQUIRY_MS = 5_000;

const emptyRemoved = () => ({ container: [], volumes: [], networks: [], images: [], bytes: 0 });
function asEnd(e: Partial<End> | null | undefined): End | null {
  if (!e || (e.state !== "finished" && e.state !== "error")) return null;
  return { state: e.state, since: e.since, removed: { ...emptyRemoved(), ...(e.removed ?? {}) }, stays: e.stays ?? [], error: e.error };
}
const removedCount = (e: End) => e.removed.container.length + e.removed.volumes.length + e.removed.networks.length + e.removed.images.length;

/** The section on the services page — with `count > 0` (field `superseded` on the project) and with the result of a removal. */
export function OldContainerRemove({ projectId, count, onFinished }: { projectId: string; count: number; onFinished?: () => void }) {
  const t = useT();
  const [isOpen, setOpen] = useState(false);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [sends, setSends] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [end, setEnd] = useState<End | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  // Counts the ends (event or polling): if one arrives before the answer to a POST or GET, "running" must not switch on again afterwards.
  const ends = useRef(0);
  // `since` of our own POST — a `last` from polling belongs to this run only if it matches.
  const ownRun = useRef<number | null>(null);

  const load = useCallback(async () => {
    const prior = ends.current;
    setLoading(true);
    setError(null);
    // Never an old list under a new error: what is not readable right now is unknown.
    setInventory(null);
    try {
      const r = await api<Inventory>(`/api/projects/${projectId}/superseded`);
      setInventory(r);
      if (ends.current === prior) setRunning(r.running);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const takeOver = useCallback((e: End | null) => {
    ends.current += 1;
    ownRun.current = null;
    setRunning(false);
    setSends(false);
    setError(null);
    setEnd(e);
    if (openRef.current) void load();
    else setInventory(null);
    finished.current?.();
  }, [load]);

  useEffect(() => subscribeGlobalEvents((evt) => {
    if (evt.type !== "project/superseded" || String(evt.projectId ?? "") !== projectId) return;
    takeOver(asEnd(evt as unknown as Partial<End>));
  }), [projectId, takeOver]);

  // While it runs, poll cheaply: the event can be missing in a gap of the stream (sleep, network change, gateway).
  useEffect(() => {
    if (!running) return;
    let out = false;
    const id = window.setInterval(() => {
      const prior = ends.current;
      void api<{ running: boolean; last: Partial<End> | null }>(`/api/projects/${projectId}/superseded?status=1`)
        .then((s) => {
          if (out || s.running || ends.current !== prior) return;
          const l = asEnd(s.last);
          const mine = ownRun.current;
          takeOver(l && (mine === null || l.since === mine) ? l : null);
        })
        .catch(() => {});
    }, INQUIRY_MS);
    return () => { out = true; window.clearInterval(id); };
  }, [running, projectId, takeOver]);

  const open = () => { setOpen(true); setEnd(null); void load(); };

  async function remove() {
    if (!inventory || sends) return;
    const confirmed = {
      container: inventory.stacks.flatMap((s) => s.container.map((c) => c.id)),
      running: inventory.stacks.flatMap((s) => s.container.filter((c) => RUNNING.has(c.state)).map((c) => c.id)),
      volumes: inventory.stacks.flatMap((s) => s.volumes.map((v) => v.name)),
      networks: inventory.stacks.flatMap((s) => s.networks.map((n) => n.id)),
      images: inventory.stacks.flatMap((s) => s.images.map((i) => i.id)),
    };
    setError(null);
    setSends(true);
    const prior = ends.current;
    try {
      const r = await api<{ ok: boolean; since?: number }>(`/api/projects/${projectId}/superseded/remove`, { method: "POST", body: JSON.stringify({ confirmed }) });
      if (ends.current === prior) {
        ownRun.current = typeof r?.since === "number" ? r.since : null;
        setRunning(true);
      }
      setOpen(false);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setSends(false);
    }
  }

  // Without old containers and without a result nothing shows. The component stays mounted anyway: if the count drops to zero
  // after the removal, the result would otherwise vanish.
  if (count === 0 && !end && !running && !isOpen) return null;

  const size = (n: number | null) => (n === null ? t("Size unknown") : sizeText(n));
  const dataAreas = inventory ? inventory.stacks.reduce((n, s) => n + s.volumes.length, 0) : 0;

  return (
    // A section in the form of the instances (ProjectForm.tsx): tile with archive box, title, the button on the right, the sentence
    // below — no hairlines above and below the block.
    <Section
      symbol={S.archive(15)}
      title={t("Old containers ({n})", { n: count })}
      className="mt-6 shrink-0"
      data={{ "data-old-container": count }}
      under={count > 0 ? t("Stopped containers of renamed stacks — their data volumes hold the old state; the new stack started empty.") : undefined}
      right={running ? (
        <span className="flex items-center gap-2 text-[12px] text-dim"><Spinner /> {t("Removing…")}</span>
      ) : count === 0 ? undefined : (
        <button type="button" onClick={open} className={ghost} data-old-container-open>{t("Remove old containers")}</button>
      )}
    >
      {!isOpen && error && <div className="mt-2"><Hint tone="danger">{error}</Hint></div>}
      {end && (
        <div className="mt-2 space-y-1">
          {(end.state === "finished" || removedCount(end) > 0) && (
            <Hint tone={end.state === "finished" && end.stays.length === 0 ? "ok" : "warn"}>
              {t("Removed: {c} containers, {v} data volumes, {n} networks, {i} images ({size}).", {
                c: end.removed.container.length, v: end.removed.volumes.length, n: end.removed.networks.length, i: end.removed.images.length,
                size: sizeText(end.removed.bytes),
              })}
            </Hint>
          )}
          {end.state === "error" && <Hint tone="danger">{t("Removing failed: {reason}", { reason: end.error ?? "" })}</Hint>}
          {end.stays.map((b, i) => (
            <div key={i} className="text-[11.5px] text-warn">{t("Kept: {kind} {name} — {reason}", { kind: t(KIND[b.kind] ?? b.kind), name: b.name, reason: b.reason })}</div>
          ))}
        </div>
      )}

      {isOpen && (
        <Modal onClose={() => setOpen(false)} width={600} label={t("Remove old containers")}>
          <ModalTitle hint={t("Exactly what is listed here is removed — the data volumes too, for good.")}>{t("Remove old containers")}</ModalTitle>
          {loading && <div className="flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> {t("Reading the containers in the project container…")}</div>}
          {error && <Hint tone="danger">{error}</Hint>}
          {inventory && inventory.running && <Hint tone="warn">{t("A removal is already running.")}</Hint>}
          {inventory && !loading && (
            <div className="space-y-3">
              {inventory.stacks.length === 0 && <div className="text-[12.5px] text-dim">{t("There are no old containers left.")}</div>}
              {inventory.stacks.map((s) => (
                <div key={`${s.stackPrior}\u0000${s.stackNow}`} className="cb-kit-pane divide-y divide-edge rounded-2xl" data-old-container-stack={s.stackPrior}>
                  <div className="px-3 py-1.5 text-[11.5px] font-semibold text-dim">{t("Stack “{old}” — now called “{fresh}”", { old: s.stackPrior, fresh: s.stackNow })}</div>
                  {s.container.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <span className={`shrink-0 text-[11px] ${RUNNING.has(c.state) ? "text-warn" : "text-dim"}`}>
                        {STATE[c.state] ? t(STATE[c.state]) : c.state}
                      </span>
                      <span className="shrink-0 tabular-nums text-[11px] text-dim">{c.state === "missing" ? "" : size(c.size)}</span>
                    </div>
                  ))}
                  {s.volumes.map((v) => (
                    <div key={v.name} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-danger">
                      <span className="min-w-0 flex-1 truncate">{t("Data volume {name}", { name: v.name })}</span>
                      <span className="shrink-0 tabular-nums text-[11px]">{size(v.size)}</span>
                    </div>
                  ))}
                  {s.images.map((i) => (
                    <div key={i.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-dim">
                      <span className="min-w-0 flex-1 truncate">{t("Image {name}", { name: i.name })}</span>
                      <span className="shrink-0 tabular-nums text-[11px]">{size(i.size)}</span>
                    </div>
                  ))}
                  {s.networks.length > 0 && (
                    <div className="px-3 py-1.5 text-[12px] text-dim">{t("Networks: {names}", { names: s.networks.map((n) => n.name).join(", ") })}</div>
                  )}
                </div>
              ))}
              {inventory.stays.length > 0 && (
                <div className="space-y-0.5">
                  {inventory.stays.map((b, i) => (
                    <div key={i} className="text-[11.5px] text-dim">{t("Kept: {kind} {name} — {reason}", { kind: t(KIND[b.kind] ?? b.kind), name: b.name, reason: b.reason })}</div>
                  ))}
                </div>
              )}
              {inventory.stacks.length > 0 && (
                <div className="text-[12px] text-dim">
                  {inventory.total.withoutSize > 0
                    ? t("Together {size}, plus {n} of unknown size.", { size: sizeText(inventory.total.bytes), n: inventory.total.withoutSize })
                    : t("Together {size}.", { size: sizeText(inventory.total.bytes) })}
                </div>
              )}
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className={ghost}>{t("Cancel")}</button>
            <button
              type="button"
              disabled={!inventory || loading || sends || !!error || inventory.running || inventory.stacks.length === 0}
              onClick={() => void remove()}
              className={`${danger} disabled:opacity-40`}
              data-old-container-remove
            >
              {dataAreas > 0 ? t("Remove, including {n} data volumes", { n: dataAreas }) : t("Remove")}
            </button>
          </div>
        </Modal>
      )}
    </Section>
  );
}
