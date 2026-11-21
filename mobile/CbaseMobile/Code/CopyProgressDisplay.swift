import SwiftUI

// Progress of a copy that is waiting or being built, as a word and a bar. For the list row and the header of an instance's page
// in the "Instances" tab (Code/ProjectInstances.swift). There is no "Active runs" pill on iOS as on the web.
//
// The computation — what is shown — is `InstancesTree.progressDetail` (Code/InstancesTree.swift, bound to the web:
// web/test/instances-tree-binding.test.mjs); only the words and the form live here, the same as on the web
// (web/src/components/projects/CopyProgress.tsx):
//  – phases in words (clone1 "Clone", freeze "Freezing", clone2 "Second clone", creation "Container setup", prepare
//    "Preparing", start "Start"), in start with the compose start's stage; an unknown phase shows raw (a newer server);
//  – the bar is thin: DETERMINATE with `share` (estimated from the project's last finished copy), INDETERMINATE without (a running
//    band — never an invented number), while waiting only the empty track. The band runs in a `TimelineView` (no stateful
//    animation: in a `List` a `repeatForever` travelled along when the row reloaded) and stands still with "Reduce Motion"
//    (then a calm half fill across the full width);
//  – "about 4 min left" only if the remaining time is estimated; `overrun` says in orange "taking longer than last time" instead
//    of naming a remaining time.
// Colors from `CbColor` and the accent — no system surfaces.
enum CopyProgressText {
    /// The build phase as a word.
    static func phaseWord(_ phase: String) -> String {
        switch phase {
        case "clone1": return L("Clone")
        case "freeze": return L("Freezing")
        case "clone2": return L("Second clone")
        case "creation": return L("Container setup")
        case "prepare": return L("Preparing")
        case "start": return L("Start##noun")
        default: return phase
        }
    }

    /// "Step 3 of 6 · Second clone" (in start plus "· Stage 2/3") — only for a known step, else nil.
    static func stepSet(_ a: InstancesTree.ProgressDetail) -> String? {
        guard a.kind == "step" else { return nil }
        var parts = [L("Step {n} of {m}", ["n": a.step, "m": a.steps]), phaseWord(a.phase)]
        if let s = a.stage { parts.append(L("Stage {seq}/{from}", ["seq": s.seq, "from": s.from])) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// "about 4 min left" — only with an estimated remaining time (never on overrun).
    static func restSet(_ a: InstancesTree.ProgressDetail) -> String? {
        a.restMin.map { L("about {n} min left", ["n": Int($0)]) }
    }
}

/// Step and remaining time as one line with the small symbol — nothing if neither exists (while waiting, the situation word says it).
struct CopyStepRow: View {
    let a: InstancesTree.ProgressDetail

    var body: some View {
        let parts = [CopyProgressText.stepSet(a), CopyProgressText.restSet(a)].compactMap { $0 }
        if !parts.isEmpty {
            HStack(spacing: 4) {
                Image(systemName: "circle.dashed").font(.symbol(10.5))
                Text(verbatim: parts.joined(separator: " · "))
                    .cbFont(12.5, digitsEqual: true)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .foregroundStyle(CbColor.textMuted)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("instance-progress-set")
        }
    }
}

/// The hint when the running step takes longer than last time.
struct CopyOverrunHint: View {
    let a: InstancesTree.ProgressDetail

    var body: some View {
        if a.overrun {
            Text(L("taking longer than last time"))
                .cbFont(12.5)
                .foregroundStyle(Color.orange)
                .accessibilityIdentifier("instance-progress-overrun")
        }
    }
}

/// The thin bar: determinate with `share`, indeterminate without, while waiting only the track.
struct CopyProgressBar: View {
    let a: InstancesTree.ProgressDetail
    @Environment(\.accessibilityReduceMotion) private var quiet

    private var waiting: Bool { a.kind == "queue" || a.kind == "storage" }

    var body: some View {
        GeometryReader { g in
            let w = g.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(CbColor.edge)
                if !waiting {
                    if let share = a.share {
                        Capsule().fill(Color.accentColor)
                            .frame(width: max(0, min(1, share)) * w)
                            .animation(.easeOut(duration: 0.7), value: share)
                    } else if quiet {
                        Capsule().fill(Color.accentColor.opacity(0.35))
                    } else {
                        // The running band: a third of the width, from outside left to outside right, 1.6 s per pass (as on the web).
                        TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
                            let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                            let p = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
                            Capsule().fill(Color.accentColor.opacity(0.8))
                                .frame(width: w / 3)
                                .offset(x: -w / 3 + p * (w + w / 3))
                        }
                    }
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 3)
        .accessibilityElement()
        .accessibilityLabel(L("Progress"))
        .accessibilityValue(a.share.flatMap { waiting ? nil : "\(Int(($0 * 100).rounded())) %" } ?? "")
        .accessibilityIdentifier(waiting ? "copy-progress-bar-waiting" : a.share != nil ? "copy-progress-bar-determinate" : "copy-progress-bar-indeterminate")
    }
}
