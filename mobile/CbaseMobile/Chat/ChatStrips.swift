import SwiftUI

// Choosing a workflow for a not-yet-started chat is done via `/workflow:<short-name>` in the
// slash picker (there is no picker sheet here).

/// A run parked at the usage limit: reason, time and a live countdown — plus the
/// option to try right away or to end the wait. Sits ABOVE the
/// workflow strip, since it is the answer to "why is nothing happening?".
struct ChatLimitStrip: View {
    @ObservedObject var model: ChatViewModel
    /// A one-second tick only while something is waiting (the countdown should run without burdening the chat).
    @State private var now = Date()
    /// Confirmation before "Cancel": the button deletes the wait row on the server TOGETHER WITH
    /// the parked job — the typed message is gone afterwards, and nothing warned about it before.
    /// A dialog instead of a subtitle on the button: the row is single-line, and a warning one only
    /// reads after the tap does not warn.
    @State private var abortQuestion = false

    var body: some View {
        if let wait = model.limitWait {
            // The form of the hints under the header (`CbHintSurface`): only the symbol carries the state
            // ("waiting"). Parked by the gate is not a limit hit: there the hand as in the history row
            // (`LimitEventView`), not the clock.
            //
            // ONE line only when title and subline fit in it COMPLETELY; otherwise the buttons go in a second line below
            // the text (otherwise they took exactly the time of day from the subline, which is the point). `ViewThatFits`
            // measures the ideal width: single-line texts count there with their full length, a truncated
            // version never gets its turn.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    CbHintSymbol(systemImage: symbol(wait))
                    texts(wait, singleLine: true)
                    Spacer(minLength: 8)
                    buttons(wait)
                }
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .top, spacing: 8) {
                        CbHintSymbol(systemImage: symbol(wait))
                            .padding(.top, 1)
                        texts(wait, singleLine: false)
                        Spacer(minLength: 0)
                    }
                    HStack(spacing: 16) {
                        buttons(wait)
                        Spacer(minLength: 0)
                    }
                    // Below the text, not below the symbol: the buttons belong to the statement next to them.
                    .padding(.leading, CbHintMass.symbolColumn + 8)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .cbHintSurface()
            // Without `children: .contain` the buttons inherit the strip's identifier (the third place
            // where this trap bites) and could no longer be addressed individually.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-limit-strip")
            .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now = $0 }
            // Same form as "Delete chat?": title visible, ONE destructive button, the dialog's
            // "Cancel" is supplied by the system — a custom one would read like the trigger
            // and say the opposite of what the strip button means.
            .confirmationDialog(L("Stop waiting?"), isPresented: $abortQuestion, titleVisibility: .visible) {
                Button(L("Stop waiting"), role: .destructive) {
                    Task { await model.cancelLimitWait() }
                }
            } message: {
                // If a running workflow hangs on the row, the server ends it as failed on
                // discard — that belongs BEFORE the tap, not in the history row after it.
                // ONE text, because the dialog shows only one.
                Text(wait.workflow
                    ? L("The waiting task will be discarded. The running workflow ends as failed.")
                    : L("The waiting task will be discarded."))
            }
        }
    }

    private func symbol(_ wait: LimitWaitState) -> String {
        wait.gate ? "hand.raised" : "clock.badge.exclamationmark"
    }

    /// Title and subline. `singleLine`: one line each (the version next to the buttons — chosen only when
    /// both fit completely); otherwise the subline may wrap.
    private func texts(_ wait: LimitWaitState, singleLine: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(wait.limitText)
                .cbFont(12.5, weight: .medium)
                .foregroundStyle(CbColor.text)
                .lineLimit(singleLine ? 1 : nil)
                .fixedSize(horizontal: false, vertical: true)
            Text(subtitle(wait))
                .cbFont(11)
                .foregroundStyle(CbColor.textMuted)
                .lineLimit(singleLine ? 1 : nil)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "Try now" or "Start anyway" and "Cancel" — the identifiers carry the UI tests.
    @ViewBuilder
    private func buttons(_ wait: LimitWaitState) -> some View {
        // "Start anyway" REPLACES "Try now" while the credit gate holds:
        // both buttons side by side would be two ways into the same turn, and one
        // would not say that it costs credit. On a REAL limit hit it does not
        // appear at all — the turn would not get through there anyway, the button would
        // be a trap rather than a choice.
        if wait.gate {
            // `trotzdem: true` is the approval itself — without the field the server parks
            // the turn at the gate again immediately (see `retryLimitNow`).
            Button(L("Start anyway (spends credits)")) {
                Task { await model.retryLimitNow(anyway: true) }
            }
            .cbFont(11.5, weight: .semibold)
            .buttonStyle(.plain)
            .foregroundStyle(CbColor.text)
            .lineLimit(1)
            .fixedSize()
            .disabled(model.limitBusy)
            .accessibilityIdentifier("chat-limit-anyway")
        } else {
            Button(L("Try now")) { Task { await model.retryLimitNow() } }
                .cbFont(11.5, weight: .semibold)
                .buttonStyle(.plain)
                .foregroundStyle(CbColor.text)
                .lineLimit(1)
                .fixedSize()
                .disabled(model.limitBusy)
                .accessibilityIdentifier("chat-limit-retry")
        }
        Button(L("Cancel")) { abortQuestion = true }
            .cbFont(11.5, weight: .medium)
            .buttonStyle(.plain)
            .foregroundStyle(CbColor.textMuted)
            .lineLimit(1)
            .fixedSize()
            .disabled(model.limitBusy)
            .accessibilityHint(L("The waiting task will be discarded."))
            .accessibilityIdentifier("chat-limit-cancel")
    }

    private func subtitle(_ wait: LimitWaitState) -> String {
        var parts: [String] = []
        // The REASON first, then the time: parked by the gate means the limit was not
        // reached at all — cbase only did not start anything new. Deliberately only two words: the
        // row is single-line, and an explanatory sentence would push the time out of view. What it
        // costs is on the button next to it.
        if wait.gate { parts.append(L("Credit gate")) }
        // A gate row NEVER carries `reason == "probe"` (its reason is "credit"), but can
        // still arise without a known reset: then the server sets `resetsAt` to 0 and
        // `dueAt` to the next probe time. Showing that as "Continuing at 14:12"
        // would be a promise nobody made.
        if wait.reason == "probe" || (wait.gate && (wait.resetsAt ?? 0) <= 0) {
            parts.append(L("Reset time unknown — checking back regularly."))
        } else {
            let due = Date(timeIntervalSince1970: wait.dueAt / 1000)
            // A turn does not always wait at the limit: a compaction is made up, not continued.
            let when = ["time": due.formatted(date: .omitted, time: .shortened)]
            parts.append(wait.kind == "compact" ? L("Compacting at {time}", when) : L("Continuing at {time}", when))
            let remaining = due.timeIntervalSince(now)
            if remaining > 0 { parts.append(countdown(remaining)) }
        }
        if wait.attempts > 0 { parts.append(L("Attempt {n}", ["n": String(wait.attempts + 1)])) }
        return parts.joined(separator: " · ")
    }

    private func countdown(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        if total >= 3600 { return "\(total / 3600) h \((total % 3600) / 60) min" }
        if total >= 60 { return "\(total / 60) min" }
        return "\(total) s"
    }
}

/// Progress of the running workflow — directly under the chat name, with skip and
/// cancel. A finished run stays as a quiet row: later too it should be recognizable
/// that this chat followed a workflow.
struct ChatWorkflowStrip: View {
    @ObservedObject var model: ChatViewModel
    /// One-second tick for the total runtime — only while the run is open.
    @State private var now = Date()

    var body: some View {
        if let run = model.workflowRun {
            // The form of the hints under the header (`CbHintSurface`). Without a state color
            // on the symbol (like the status rows, Chat/StatusForm.swift) — the subline says the state.
            HStack(spacing: 8) {
                CbHintSymbol(systemImage: "arrow.triangle.branch")
                VStack(alignment: .leading, spacing: 1) {
                    Text(run.name)
                        .cbFont(12.5, weight: .medium)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                    Text(subtitle(run))
                        .cbFont(11)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                // Total runtime of the run — ticking while it runs or waits.
                if let runtime = run.runtime(at: now) {
                    Text(Self.runtimeText(runtime))
                        .cbFont(11.5, weight: .medium, digitsEqual: true)
                        .foregroundStyle(run.isActive ? CbColor.text : CbColor.textMuted)
                        .accessibilityIdentifier("chat-workflow-runtime")
                        .accessibilityLabel(L("Total runtime of this run"))
                }
                if run.isActive {
                    Button(L("Skip")) { Task { await model.skipWorkflowStep() } }
                        .cbFont(11.5, weight: .medium)
                        .buttonStyle(.plain)
                        .foregroundStyle(CbColor.textMuted)
                        .disabled(model.workflowBusy)
                        .accessibilityIdentifier("chat-workflow-skip")
                    // Cancel ends the WHOLE run, without confirmation — hence in text color, not muted like
                    // "Skip" next to it: two similar-looking words close together made the wrong tap
                    // too easy.
                    Button(L("Cancel")) { Task { await model.cancelWorkflow() } }
                        .cbFont(11.5, weight: .medium)
                        .buttonStyle(.plain)
                        .foregroundStyle(CbColor.text)
                        .disabled(model.workflowBusy)
                        .accessibilityIdentifier("chat-workflow-cancel")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .cbHintSurface()
            // Without `children: .contain` skip and cancel inherited the strip's identifier
            // and could no longer be addressed individually.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-workflow-strip")
            .task(id: run.isActive) {
                guard run.isActive else { return }
                while !Task.isCancelled {
                    now = Date()
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
        }
    }

    /// "38s", "4m 12s", "2h 07m" — its own tier for hours, because triggered runs sometimes work
    /// half the day and nobody reads "326m 41s".
    static func runtimeText(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total >= 3600 { return String(format: "%dh %02dm", total / 3600, (total % 3600) / 60) }
        if total >= 60 { return String(format: "%dm %02ds", total / 60, total % 60) }
        return "\(total)s"
    }

    private func subtitle(_ run: WorkflowRunState) -> String {
        switch run.status {
        case "waiting":
            return run.pending == "review" ? L("waiting for your review") : L("waiting for your answer")
        case "running":
            var parts = [L("Step {step}/{total}", [
                "step": String(run.step),
                "total": (run.approx ? "ca. " : "") + String(run.total),
            ])]
            if !run.nodeTitle.isEmpty { parts.append(run.nodeTitle) }
            if let index = run.loopIndex, let total = run.loopTotal {
                parts.append(L("Item {i}/{n}", ["i": String(index), "n": String(total)]))
            }
            return parts.joined(separator: " · ")
        case "done":
            return L("completed")
        case "cancelled":
            return L("cancelled")
        default:
            return run.note.isEmpty ? L("failed") : (run.note == "Chat deleted" ? L("Chat deleted") : run.note)
        }
    }
}
