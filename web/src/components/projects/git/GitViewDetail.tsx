"use client";

// The detail of a branch in the git overview: on the right in the view's kit `SplitPane` (from `@5xl/kit`), below it slid over the
// timeline, with ‹ back. From the top: the state against the main branch and the remote (for a copy also since its creation), the
// commits ahead (the cap says it is one), the changed files with +/− — a tap shows the diff `<main>...<branch>` in the existing
// diff sheet (components/GitSidebar.tsx `DiffModal`, no hunk staging: everything here is read-only), the MR (no row without a
// GitLab remote, "GitLab not connected" without read access), the origin and who uses the branch, with a jump
// (components/projects/git/GitWords.tsx).
//
// Loaded on selection and again as soon as the row carries a new last commit (`row.last.t`) — not on the view's tick: the detail
// is a git run of its own in the instance. EMPTY IS NOT UNKNOWN: before the answer "loading…", after an error the error;
// `commits: null` means "cannot be computed without a main branch", never "none" — unless `failed` names a reason for the part
// (git failed).
import { useEffect, useState } from "react";
import {
  errorFields, fetchGitBranchDetail, fetchGitBranchDiff,
  type GitViewRow, type GitBranchDetail, type GitMr,
} from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import { Section, Hint, Loading, SplitBackButton, ROW_INSIDE } from "@/components/CbKit";
import { S } from "@/components/projects/ProjectForm";
import { DiffModal } from "@/components/GitSidebar";
import { dateShort, keyColor } from "@/components/projects/git/Timeline";
import {
  UserJump, ChatsJump, oldWord, groupWord, instanceWord, rowName, arrows, beforeWord, stateWord, type GitLocation, type Translator,
} from "@/components/projects/git/GitWords";

const countText = (n: number) => n.toLocaleString(dateLocale());

function pipelineWord(status: string, t: Translator): string {
  switch (status) {
    case "success": return t("Pipeline ✓");
    case "failed": return t("Pipeline ✗");
    case "running": case "pending": case "created": case "preparing": case "waiting_for_resource": return t("Pipeline running");
    case "canceled": return t("Pipeline canceled");
    case "skipped": return t("Pipeline skipped");
    case "manual": return t("Pipeline waiting for approval");
    default: return t("Pipeline {status}", { status });
  }
}

/** The MR row — `null` if the repo has no GitLab remote (`no-gitlab`: then no row is shown at all). */
function MrRow({ mr, t }: { mr: GitMr | null; t: Translator }) {
  if (!mr) return <p className="text-[12.5px] text-dim">{t("not loaded")}</p>;
  if (mr.state !== null) {
    switch (mr.state) {
      case "no-gitlab": return null;
      case "no-access": return <p className="text-[12.5px] text-dim" data-git-mr="no-access">{t("GitLab not connected")}</p>;
      case "none": return <p className="text-[12.5px] text-dim" data-git-mr="none">{t("No open merge request")}</p>;
      case "error": return <p className="text-[12.5px] text-warn" data-git-mr="error">{t("Merge request not readable: {reason}", { reason: mr.error || "—" })}</p>;
    }
  }
  const title = `${mr.iid !== null ? `!${mr.iid} ` : ""}${mr.title}`;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]" data-git-mr="open">
      {mr.url
        ? <a href={mr.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent hover:underline">{title}</a>
        : <span className="min-w-0 truncate">{title}</span>}
      <span className="text-dim">{t("open → {target}", { target: mr.target || "—" })}</span>
      {mr.pipeline && (mr.pipeline.url
        ? <a href={mr.pipeline.url} target="_blank" rel="noreferrer" className="text-dim hover:text-fg hover:underline">{pipelineWord(mr.pipeline.status, t)}</a>
        : <span className="text-dim">{pipelineWord(mr.pipeline.status, t)}</span>)}
    </div>
  );
}

export function GitViewDetail({ projectId, repo, row, mainBranch, color, location, now, t, onBack }: {
  projectId: string;
  /** `rel` of the view's repo. */
  repo: string;
  row: GitViewRow;
  mainBranch: string | null;
  color: number | null;
  location: GitLocation;
  now: number;
  t: Translator;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<GitBranchDetail | null>(null);
  const [error, setError] = useState("");
  const [diff, setDiff] = useState<{ file: string; diff?: string; error?: string; clipped?: boolean } | null>(null);
  const lastT = row.last?.t ?? null;

  useEffect(() => {
    let alive = true;
    setError("");
    fetchGitBranchDetail(projectId, { repo, instance: row.instance, name: row.name })
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setError(errorFields(e).text); });
    return () => { alive = false; };
  }, [projectId, repo, row.instance, row.name, lastT]);

  const showDiff = (file: string) => {
    setDiff({ file });
    fetchGitBranchDiff(projectId, { repo, instance: row.instance, name: row.name, file })
      .then((d) => setDiff((cur) => (cur?.file === file ? { file, diff: d.diff, clipped: d.clipped } : cur)))
      .catch((e) => setDiff((cur) => (cur?.file === file ? { file, error: errorFields(e).text } : cur)));
  };

  // The list row is the truth for the numbers (it comes on the tick); the detail adds commits, files, MR and origin.
  const z = row;
  const copy = z.instance !== "main";
  const last = beforeWord(z.last?.t ?? null, now, t);
  const toMainValue = z.toMain
    ? (z.toMain.merged ? t("merged into {main}", { main: mainBranch ?? "—" }) : t("{arrows} to {main}", { arrows: arrows(z.toMain), main: mainBranch ?? "—" }))
    : t("no main branch detected");
  // A detached HEAD has no upstream — no remote statement instead of "local only".
  const toRemoteValue = z.detached ? null : z.remote === null
    ? (z.local ? t("local only") : null)
    : z.toRemote ? t("{arrows} to {remote}", { arrows: arrows(z.toRemote), remote: z.remote }) : z.remote;
  const sum = detail?.files?.reduce((s, d) => ({ plus: s.plus + (d.plus ?? 0), minus: s.minus + (d.minus ?? 0) }), { plus: 0, minus: 0 }) ?? null;
  const origin = detail?.origin ?? null;
  const user = z.user ?? detail?.row?.user ?? null;

  return (
    <section className="flex min-w-0 flex-col gap-5 pb-6 pr-2" data-git-view-detail={z.name}>
      <div className="flex min-w-0 flex-col gap-1">
        <SplitBackButton label={t("All branches")} onClick={onBack} />
        <div className="flex min-w-0 items-center gap-2">
          {copy && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: keyColor(color) }} aria-hidden />}
          <h3 className="min-w-0 truncate font-mono text-[15px] font-semibold" title={rowName(z, t)}>{rowName(z, t)}</h3>
        </div>
        <p className="text-[12px] text-dim">
          {[groupWord(z.group, t), instanceWord(z.instance, t), last && t("last {when}", { when: last })].filter(Boolean).join(" · ")}
        </p>
        {z.last && <p className="min-w-0 truncate text-[12.5px]" title={z.last.subject}>{z.last.subject}<span className="text-dim"> · {z.last.author}</span></p>}
      </div>

      <Section symbol={S.repos(14)} title={t("State")}>
        <div className="flex flex-col gap-0.5 font-mono text-[12.5px] tabular-nums" data-git-snapshot>
          <span>{toMainValue}</span>
          {toRemoteValue && <span>{toRemoteValue}</span>}
          {z.sinceCreation && <span>{t("{arrows} since the copy was created", { arrows: arrows(z.sinceCreation) })}</span>}
        </div>
      </Section>

      {error && <Hint tone="danger">{t("The detail could not be loaded: {reason}", { reason: error })}</Hint>}
      {!detail && !error && <Loading />}

      {detail && (
        <>
          <Section
            symbol={S.changes(14)}
            title={detail.commits ? t("Commits ahead ({n})", { n: detail.clipped?.commits?.total ?? detail.commits.length }) : t("Commits ahead")}
            data={{ "data-git-commits": detail.commits?.length ?? "" }}
          >
            {detail.commits === null ? (
              detail.failed?.commits
                ? <p className="text-[12.5px] text-warn" data-git-failed="commits">{t("Not readable: {reason}", { reason: detail.failed.commits })}</p>
                : <p className="text-[12.5px] text-dim">{t("Cannot be computed without a detected main branch.")}</p>
            ) : detail.commits.length === 0 ? (
              <p className="text-[12.5px] text-dim">{t("None — the branch is not ahead.")}</p>
            ) : (
              <div className="flex flex-col">
                {detail.clipped?.commits && (
                  <p className="pb-1 text-[12px] text-dim">{t("{shown} of {total} shown", { shown: countText(detail.clipped.commits.shown), total: countText(detail.clipped.commits.total) })}</p>
                )}
                {detail.commits.map((c) => (
                  <div key={c.sha} className="flex min-w-0 items-baseline gap-2 py-0.5 text-[12.5px]" title={`${c.sha}\n${c.author}`}>
                    <span className="shrink-0 font-mono text-[11.5px] text-dim">{c.sha.slice(0, 8)}</span>
                    <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                    {c.t !== null && <span className="shrink-0 text-[11.5px] tabular-nums text-dim">{oldWord(c.t, now, t)}</span>}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            symbol={S.code(14)}
            title={sum ? t("Files (+{plus} −{minus})", { plus: countText(sum.plus), minus: countText(sum.minus) }) : t("Files")}
            data={{ "data-git-files": detail.files?.length ?? "" }}
          >
            {detail.files === null ? (
              detail.failed?.files
                ? <p className="text-[12.5px] text-warn" data-git-failed="files">{t("Not readable: {reason}", { reason: detail.failed.files })}</p>
                : <p className="text-[12.5px] text-dim">{t("Cannot be computed without a detected main branch.")}</p>
            ) : detail.files.length === 0 ? (
              <p className="text-[12.5px] text-dim">{t("No changed files.")}</p>
            ) : (
              <div className="-mx-2 flex flex-col">
                {detail.clipped?.files && (
                  <p className="px-2 pb-1 text-[12px] text-dim">{t("{shown} of {total} shown", { shown: countText(detail.clipped.files.shown), total: countText(detail.clipped.files.total) })}</p>
                )}
                {detail.files.map((d) => (
                  <button key={d.file} type="button" onClick={() => showDiff(d.file)} title={t("Show diff")} className={`${ROW_INSIDE} py-1! text-left`} data-git-file={d.file}>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{d.file}</span>
                    {d.binary
                      ? <span className="shrink-0 text-[11.5px] text-dim">{t("binary")}</span>
                      : <span className="shrink-0 font-mono text-[11.5px] tabular-nums"><span className="text-ok">+{d.plus ?? "?"}</span> <span className="text-danger">−{d.minus ?? "?"}</span></span>}
                  </button>
                ))}
              </div>
            )}
          </Section>

          {detail.mr?.state !== "no-gitlab" && (
            <Section symbol={S.link(14)} title={t("Merge request")}>
              <MrRow mr={detail.mr} t={t} />
            </Section>
          )}

          <Section symbol={S.layout(14)} title={t("Origin")}>
            <div className="text-[12.5px]" data-git-origin={origin?.source ?? ""}>
              {origin === null ? <span className="text-dim">{t("not loaded")}</span>
                : origin.source === "cbase" ? (
                  origin.user
                    ? <span className="inline-flex min-w-0 items-center gap-1">{t("created by")} <UserJump b={origin.user} state={origin.state} location={location} t={t} /></span>
                    : <span>{t("by cbase")}{origin.state ? ` · ${stateWord(origin.state, t)}` : ""}</span>
                )
                : origin.source === "reflog" ? (
                  <span>{origin.at !== null
                    ? t("created {date} from {from}", { date: dateShort(origin.at), from: origin.from })
                    : t("created from {from}", { from: origin.from })}</span>
                )
                : <span className="text-dim">{t("Origin unknown")}</span>}
            </div>
          </Section>
        </>
      )}

      <Section symbol={S.chats(14)} title={t("User")}>
        <div className="flex flex-col gap-0.5 text-[12.5px]" data-git-user-section>
          {user ? <UserJump b={user} state={z.state} location={location} t={t} /> : (z.state ? <span>{stateWord(z.state, t)}</span> : null)}
          {(z.checkedOut ?? []).map((a) => {
            const place = `${instanceWord(a.instance, t)}${a.worktree ? ` · ${t("Worktree")} ${a.worktree}` : ""}`;
            const notBackedUp = a.notBackedUp ? ` · ${t("{n} unsaved", { n: a.notBackedUp })}` : "";
            return (
              <span key={`${a.instance}\u0000${a.worktree ?? ""}`} className="flex min-w-0 items-center gap-1 text-dim">
                {a.chats && a.chats.length
                  ? <ChatsJump chats={a.chats} t={t} front={`${t("checked out in {where}", { where: place })}${notBackedUp} · `} />
                  : <span className="min-w-0 truncate">{t("checked out in {where}", { where: place })}{notBackedUp}</span>}
              </span>
            );
          })}
          {!user && !z.state && (z.checkedOut ?? []).length === 0 && <span className="text-dim">—</span>}
        </div>
      </Section>

      {diff && (
        <DiffModal
          title={diff.file}
          badge={diff.clipped ? t("truncated") : `${mainBranch ?? "?"}...${z.name}`}
          diff={diff.diff}
          error={diff.error}
          onClose={() => setDiff(null)}
        />
      )}
    </section>
  );
}
