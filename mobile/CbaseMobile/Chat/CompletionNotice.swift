import Foundation

/// The completion notice of a subagent — TWO kinds under one role.
///
/// The server stores it under the role `user` (for the main agent it is the input of a new turn); for the
/// human it is a system notice. Marker: the start `<task-notification>` (server
/// `runs/completionNotice.js`, web twin `web/src/lib/completionNotice.ts`). History building (`buildTimeline`), stream
/// (`user_message`, `message_injected`) and the queue strip (`ChatComposer`) ask HERE — otherwise the XML would stand as a user bubble on the stage.
enum CompletionNotice {
    static let marker = "<task-notification>"

    static func isNotice(_ text: String) -> Bool { text.hasPrefix(marker) }

    /// The FIRST occurrence of the element, unescaped — `nil` if it is missing (missing is not empty: see `<name>`).
    private static func fieldOrNil(_ text: String, _ name: String) -> String? {
        guard let on = text.range(of: "<\(name)>"),
              let closeRange = text.range(of: "</\(name)>", range: on.upperBound..<text.endIndex) else { return nil }
        return String(text[on.upperBound..<closeRange.lowerBound])
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func field(_ text: String, _ name: String) -> String { fieldOrNil(text, name) ?? "" }

    /// The name from the summary — only for old data WITHOUT `<name>`. Finished and stopped end
    /// EXACTLY with their outcome; on failure the FIRST `" failed: ` separates (the error text may itself carry `"…" failed`).
    /// Without a known status: finished · stopped · failed. The SAME rule as `nameFromSummary` in
    /// web/src/lib/completionNotice.ts, bound in web/test/completion-notice-binding.test.mjs.
    static func nameFromSummary(_ summary: String, status: String) -> String {
        let header = "Agent \""
        guard summary.hasPrefix(header) else { return "" }
        let rest = String(summary.dropFirst(header.count))
        let open = status.isEmpty
        if open || status == "completed", rest.hasSuffix("\" completed") { return String(rest.dropLast("\" completed".count)) }
        if open || status == "stopped", rest.hasSuffix("\" was stopped") { return String(rest.dropLast("\" was stopped".count)) }
        if open || status == "failed", let i = rest.range(of: "\" failed: ") { return String(rest[rest.startIndex..<i.lowerBound]) }
        return ""
    }

    /// Name, outcome and id — `nil` if the text is no completion notice. The name stands in its own element;
    /// the summary is only the fallback for old data.
    static func read(_ text: String) -> (agentId: String, name: String, status: String)? {
        guard isNotice(text) else { return nil }
        let raw = field(text, "status")
        let status = ["completed", "stopped", "failed"].contains(raw) ? raw : ""
        let name = fieldOrNil(text, "name") ?? nameFromSummary(field(text, "summary"), status: status)
        return (field(text, "task-id"), name, status)
    }

    /// The completion notice of a dynamic WORKFLOW (server `dynworkflows/run.js`, `completionNotice`): the summary begins
    /// with `Workflow "`, the task-id is that of the end marker of the same run. Like `isWorkflowNotice` on the web.
    static func isWorkflow(_ text: String) -> Bool { isNotice(text) && field(text, "summary").hasPrefix("Workflow \"") }

    /// The completion notice of a GRAPH workflow in the background (server `workflows/graph-background.js`,
    /// `graphCompletionNotice`): summary `Graph-Workflow "…"`. Counts ONLY for the wording of the row as a workflow;
    /// `duplicate` still asks `isWorkflow` alone (a graph run has no end marker). Like
    /// `isGraphWorkflowNotice` on the web.
    static func isGraphWorkflow(_ text: String) -> Bool { isNotice(text) && field(text, "summary").hasPrefix("Graph-Workflow \"") }

    /// The notice of a MONITOR (server `runs/monitor-notice.js`):
    /// summary `Monitor "<name>" event` or `Monitor "<name>" ended — …`, name in `<name>`. Like `isMonitorNotice` on the web.
    static func isMonitor(_ text: String) -> Bool { isNotice(text) && field(text, "summary").hasPrefix("Monitor \"") }

    /// The wording of the monitor row per `<status>` — like `monitorLabel` on the web.
    static func monitorRow(status: String, name: String) -> String { L(monitorKey(status: status), ["name": name]) }

    private static func monitorKey(status: String) -> String {
        switch status {
        case "running": return "Monitor “{name}” reports"
        case "failed": return "Monitor “{name}” failed"
        case "timed_out": return "Monitor “{name}” timed out"
        case "flooded": return "Monitor “{name}” throttled"
        case "stopped": return "Monitor “{name}” stopped"
        default: return "Monitor “{name}” ended"
        }
    }

    /// The outcome in the wake-up call of a COPY — the values like `CopyOutcome` on the web.
    enum CopyOutcome: String {
        case ready, notBuilt = "not-built", clearedAway, neverBuiltRemoved = "never-built-removed"
        case notClearedAway = "not-cleared-away"
    }

    /// Name and outcome from the wake-up call of a copy — `nil` if the text is none. The server writes it without
    /// `<name>` and `<status>`; both stand only in the summary `Copy "<name>" <outcome>` (`stacks/inset.js`
    /// moveInWakeText: "ready" · "not built: …"; `stacks/remove.js` copyWakeText: "removed" · "removed (never built)" ·
    /// "not removed: …"). The summary wording is English on the wire (stored German notes are rewritten by the migration
    /// tool, no alias here) — the readers are here and on the web. The name ends at the FIRST `"` (a copy name carries none); an unknown form is none.
    /// The SAME rule as `readCopyNotice` in web/src/lib/completionNotice.ts, bound in
    /// web/test/completion-notice-binding.test.mjs.
    static func copy(_ text: String) -> (name: String, outcome: CopyOutcome)? {
        guard isNotice(text) else { return nil }
        let summary = field(text, "summary")
        let header = "Copy \""
        guard summary.hasPrefix(header) else { return nil }
        let rest = summary.dropFirst(header.count)
        guard let i = rest.firstIndex(of: "\""), i > rest.startIndex else { return nil }
        let name = String(rest[rest.startIndex..<i])
        let tail = String(rest[rest.index(after: i)...])
        let outcome: CopyOutcome
        if tail == " ready" { outcome = .ready }
        else if tail.hasPrefix(" not built: ") { outcome = .notBuilt }
        else if tail == " removed" { outcome = .clearedAway }
        else if tail == " removed (never built)" { outcome = .neverBuiltRemoved }
        else if tail.hasPrefix(" not removed: ") { outcome = .notClearedAway }
        else { return nil }
        return (name, outcome)
    }

    /// The system row, already translated: "Subagent "Name" finished | stopped | failed" — for a dynamic
    /// workflow "Workflow "Name" …" (same keys as the end marker; also for the
    /// graph workflow), for the wake-up call of a copy "Copy "Name" ready | not built | removed | removed (never built) |
    /// not removed" —, without a name "System message".
    static func row(_ text: String) -> String {
        let (key, name) = rowKey(text)
        return name.map { L(key, ["name": $0]) } ?? L(key)
    }

    /// The tone of the row (status row with symbol instead of a divider line) — read from the English KEY, as on the web.
    static func tone(_ text: String) -> SeparatorTone { SeparatorTone.from(kind: "completionNotice", key: rowKey(text).key) ?? .ok }

    /// Key and name of the row, not yet translated (`row` translates, `tone` reads the key).
    private static func rowKey(_ text: String) -> (key: String, name: String?) {
        // The copy FIRST: recognized by the summary, not by the name (like `finishedRow` on the web).
        if let k = copy(text) {
            switch k.outcome {
            case .ready: return ("Copy “{name}” ready", k.name)
            case .notBuilt: return ("Copy “{name}” not built", k.name)
            case .clearedAway: return ("Copy “{name}” removed", k.name)
            case .neverBuiltRemoved: return ("Copy “{name}” removed (never built)", k.name)
            case .notClearedAway: return ("Copy “{name}” not removed", k.name)
            }
        }
        // A monitor before the completion notice: its `<status>` knows more than finished/stopped/failed (like `finishedRow`).
        if isMonitor(text) {
            let name = fieldOrNil(text, "name") ?? ""
            return name.isEmpty ? ("System message", nil) : (monitorKey(status: field(text, "status")), name)
        }
        guard let f = read(text), !f.name.isEmpty else { return ("System message", nil) }
        if isWorkflow(text) || isGraphWorkflow(text) {
            switch f.status {
            case "stopped": return ("Workflow “{name}” stopped", f.name)
            case "failed": return ("Workflow “{name}” failed", f.name)
            default: return ("Workflow “{name}” finished", f.name)
            }
        }
        switch f.status {
        case "stopped": return ("Subagent \"{name}\" stopped", f.name)
        case "failed": return ("Subagent \"{name}\" failed", f.name)
        default: return ("Subagent \"{name}\" finished", f.name)
        }
    }

    /// Does the notice say nothing the row before does not already say? That of a workflow DIRECTLY behind the end marker
    /// of the same run (same task-id) is a duplicate and is dropped in the history; if something came between, it stays — there it shows where the main agent got the result.
    /// `markerTaskId`: the task-id of the end marker if the last row is one, else `nil`. Like `completionNoticeDuplicate`
    /// on the web (web/src/lib/completionNotice.ts).
    static func duplicate(markerTaskId: String?, _ text: String) -> Bool {
        guard let markerTaskId, !markerTaskId.isEmpty, isWorkflow(text) else { return false }
        return field(text, "task-id") == markerTaskId
    }

    /// An entry of the queue: the row of a SYSTEM NOTICE (name and state instead of XML, no
    /// trash — the server rejects a discard with 409), `nil` for an ordinary input. Marker: the field
    /// `systemNotice` of the server OR the marker on the text. Counterpart: `queueEntry` in lib/completionNotice.ts.
    static func queue(text: String, systemNotice: Bool?) -> String? {
        // The third kind first: the message of an agent is likewise a
        // system row without trash (Chat/InboundAgentMessage.swift). Like `queueEntry` on the web.
        if let message = InboundAgentMessage.queue(text) { return message }
        guard systemNotice == true || isNotice(text) else { return nil }
        return row(text)
    }
}

/// The tone of an event row. Completion notices (subagent, workflow, monitor, copy) and the
/// markers of a dynamic workflow are EVENTS, not boundaries — they stand as a `StatusRow` with a symbol, like
/// their counterparts ("Monitor started", "Workflow finished"). A line stays only for real boundaries: compaction,
/// clearing, hint. Read from the English key — the interface language plays no role.
/// The SAME rule as `separatorTone` in web/src/lib/separator-tone.ts (counterpart); the kinds are named as there.
enum SeparatorTone: String, Hashable, Sendable {
    case start, ok, error, notice

    private static let errorWords = ["failed", "stopped", "timed out", "throttled", "interrupted", "not built", "not removed"]

    /// `nil` = the row stays a divider line. `kind`: "workflow-start" · "workflow-end" · "completionNotice".
    static func from(kind: String, key: String) -> SeparatorTone? {
        if kind == "workflow-start" { return .start }
        guard kind == "completionNotice" || kind == "workflow-end" else { return nil }
        if key.hasSuffix(" reports") { return .notice }
        if errorWords.contains(where: { key.contains($0) }) { return .error }
        return .ok
    }

    /// The symbols the existing status rows already carry (ChatTimelineRow): workflow start `arrow.right`,
    /// "Monitor ended"/"Workflow finished" `checkmark.circle`, "Workflow failed" `circle`,
    /// "Monitor triggered" `bolt`.
    var symbol: String {
        switch self {
        case .start: return "arrow.right"
        case .ok: return "checkmark.circle"
        case .error: return "circle"
        case .notice: return "bolt"
        }
    }
}
