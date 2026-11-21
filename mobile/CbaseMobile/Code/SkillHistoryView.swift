import SwiftUI

// History, undo, deletion requests and "Recently deleted" of the coding skills. The building blocks live here because two places
// need them: Coding → Skills (`Code/SkillsPane.swift`, detail sheet and list) and the chat, on the tool block of
// `cbase_skill_write` (`Chat/SkillWriteCard.swift`). Only a human undoes; the tool does not know it. Whether an entry can be
// reverted is computed by the server (`revertible`), and its 409 message shows on the entry.
//
// Confirmation happens in the row (second tap), not in a dialog: the chat cards live in UIHostingConfiguration cells of the
// mirrored list, which do not present reliably on their own (`Chat/ChatEnvironment.swift`). ONE pattern for both places.

/// What a cell keeps between two configurations: the chat's cells are rebuilt while streaming, and without an intermediate state
/// every card would reload on every token (and jump in height). Display only; each card fetches the truth fresh when it appears.
enum SkillCardsCache {
    static var requests: [String: SkillRequest] = [:]
    static var entries: [String: SkillHistoryEntry] = [:]
}

// ── Undo ────────────────────────────────────────────────────────────────────

/// "Undo" (or "Restore") with confirmation in the row: the first tap asks, the second reverts. The server's message
/// (409: skill changed since, references, name taken) shows below.
struct SkillUndoButton: View {
    let client: APIClient
    let entryId: String
    var title: String = L("Undo")
    var identifier: String = "skill-undo"
    /// Called after a successful revert; the caller reloads.
    let finished: () async -> Void

    @State private var asks = false
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                if asks {
                    CbTextButton(title: L("Really undo"), destructive: true, disabled: busy) {
                        Task { await revert() }
                    }
                    .accessibilityIdentifier(identifier + "-confirm")
                    CbTextButton(title: L("Cancel"), disabled: busy) { asks = false }
                        .accessibilityIdentifier(identifier + "-cancel")
                } else {
                    CbTextButton(title: title, disabled: busy) {
                        error = ""
                        asks = true
                    }
                    .accessibilityIdentifier(identifier)
                }
                if busy { CbLoading(compact: true) }
            }
            if !error.isEmpty {
                Text(error)
                    .cbFont(12.5)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(identifier + "-error")
            }
        }
    }

    private func revert() async {
        busy = true
        defer { busy = false }
        do {
            try await client.revertSkill(entryId: entryId)
            asks = false
            await finished()
        } catch {
            asks = false
            self.error = skillErrorText(error)
        }
    }
}

// ── One history entry ──────────────────────────────────────────────────────

/// Who, when, what, and field by field before → after. The guide is collapsed (it is long).
struct SkillHistoryRow: View {
    let entry: SkillHistoryEntry
    let client: APIClient
    let changed: () async -> Void

    @State private var guideOpen = false

    private var kindWord: String {
        switch entry.kind {
        case .create: return L("Created")
        case .change: return L("Updated")
        case .erase: return L("Deleted")
        case nil: return L("Updated")
        }
    }

    private var actorWord: String {
        switch entry.who {
        case .agent:
            let title = (entry.chatTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return title.isEmpty ? L("Agent") : L("Agent · {chat}", ["chat": title])
        case .human: return L("manual")
        case nil: return ""
        }
    }

    private var header: String {
        [kindWord, actorWord, skillWhen(entry.at) ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(header)
                    .cbFont(13.5, weight: .medium)
                    .foregroundStyle(entry.revertedAt == nil ? CbColor.text : CbColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("skill-history-header-\(entry.id)")
                Spacer(minLength: 0)
                if entry.revertedAt != nil {
                    Text(L("Undone"))
                        .cbFont(12, weight: .medium)
                        .foregroundStyle(CbColor.textMuted)
                        .accessibilityIdentifier("skill-history-back-\(entry.id)")
                }
            }
            fields
            if entry.revertible && entry.revertedAt == nil {
                SkillUndoButton(
                    client: client,
                    entryId: entry.id,
                    title: entry.kind == .erase ? L("Restore") : L("Undo"),
                    identifier: "skill-history-undo-\(entry.id)",
                    finished: changed
                )
                .padding(.leading, -8)
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Only what changed. On create the new description, on delete nothing (the name is in the sheet's header).
    @ViewBuilder
    private var fields: some View {
        let prior = entry.prior
        let after = entry.after
        if let prior, let after {
            if prior.name != after.name {
                field(L("Name"), "\(prior.name) → \(after.name)", mono: true)
            }
            if prior.description != after.description {
                field(L("Description"), "\(short(prior.description)) → \(short(after.description))")
            }
            if prior.body != after.body {
                guide(prior: prior.body, after: after.body)
            }
        } else if let after, entry.kind == .create, !after.description.isEmpty {
            field(L("Description"), short(after.description))
        }
    }

    private func field(_ marker: String, _ text: String, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(marker)
                .cbFont(12, weight: .medium)
                .foregroundStyle(CbColor.textMuted)
            Text(verbatim: text)
                .cbFont(13, design: mono ? .monospaced : nil)
                .foregroundStyle(CbColor.textSecondary)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func guide(prior: String, after: String) -> some View {
        DisclosureGroup(isExpanded: $guideOpen) {
            VStack(alignment: .leading, spacing: 8) {
                Text(L("Previous")).cbFont(12, weight: .medium).foregroundStyle(CbColor.textMuted)
                CbCodeBox(text: prior.isEmpty ? " " : prior)
                Text(L("After")).cbFont(12, weight: .medium).foregroundStyle(CbColor.textMuted)
                CbCodeBox(text: after.isEmpty ? " " : after)
            }
            .padding(.top, 6)
        } label: {
            Text(L("Instructions changed"))
                .cbFont(13)
                .foregroundStyle(CbColor.textSecondary)
        }
        .accessibilityIdentifier("skill-history-guide-\(entry.id)")
    }

    private func short(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
        if t.isEmpty { return L("(empty)") }
        return t.count > 160 ? String(t.prefix(160)) + "…" : t
    }
}

// ── The "History" section in the detail sheet ─────────────────────────────

/// The entries of ONE skill, newest first; reloads after a skill event of the workspace. A load error shows as a message,
/// never as "No history yet." (empty is not unknown).
struct SkillHistorySection: View {
    let client: APIClient
    let workspaceId: String
    let skillId: String
    /// After an undo: the page's list reloads.
    let changed: () async -> Void

    @ObservedObject private var events = SkillEvents.shared
    @State private var entries: [SkillHistoryEntry] = []
    @State private var loaded = false
    @State private var error = ""

    var body: some View {
        ProjectField(L("History"), symbol: "clock.arrow.circlepath", right: loaded && !entries.isEmpty ? String(entries.count) : nil) {
            if !error.isEmpty {
                InlineError(message: error)
            } else if !loaded {
                CbLoading(compact: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if entries.isEmpty {
                Text(L("No history yet."))
                    .cbFont(13)
                    .foregroundStyle(CbColor.textMuted)
                    .accessibilityIdentifier("skill-history-empty")
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                        if index > 0 { CbHairline() }
                        SkillHistoryRow(entry: entry, client: client) {
                            await load()
                            await changed()
                        }
                    }
                }
            }
        }
        .task { await load() }
        .onChange(of: events.counter(workspaceId)) { Task { await load() } }
    }

    private func load() async {
        do {
            entries = try await client.skillHistory(workspaceId: workspaceId, skillId: skillId)
            loaded = true
            error = ""
        } catch {
            self.error = skillErrorText(error)
        }
    }
}

// ── The request card ───────────────────────────────────────────────────────

/// An agent's deletion request: skill, who, when, reason; open with Approve/Reject, otherwise the status. Fetches the request
/// itself (`GET /api/skill-requests/:id`) and reloads after a skill event of the workspace. Appears in the detail sheet of the
/// skill page and in the chat on the tool block.
struct SkillRequestCard: View {
    let client: APIClient
    let requestId: String
    let workspaceId: String
    /// After a decision; the page reloads its list.
    var decided: () async -> Void = {}

    @ObservedObject private var events = SkillEvents.shared
    @State private var request: SkillRequest?
    @State private var busy = false
    @State private var error = ""

    init(client: APIClient, requestId: String, workspaceId: String, decided: @escaping () async -> Void = {}) {
        self.client = client
        self.requestId = requestId
        self.workspaceId = workspaceId
        self.decided = decided
        _request = State(initialValue: SkillCardsCache.requests[requestId])
    }

    private var open: Bool { request?.status == .open }

    var body: some View {
        CbPane(accent: open) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "trash")
                        .font(.symbol(13, weight: .semibold))
                        .foregroundStyle(open ? Color.orange : CbColor.textMuted)
                        .accessibilityHidden(true)
                    Text(L("Deletion requested"))
                        .cbFont(14.5, weight: .semibold)
                        .foregroundStyle(CbColor.text)
                    Spacer(minLength: 0)
                    if let request, !open {
                        Text(statusWord(request.status))
                            .cbFont(12.5, weight: .medium)
                            .foregroundStyle(statusColor(request.status))
                            .accessibilityIdentifier("skill-request-status")
                    }
                }
                if let request {
                    Text(verbatim: request.skillName)
                        .cbFont(14, design: .monospaced)
                        .foregroundStyle(CbColor.text)
                        .accessibilityIdentifier("skill-request-name")
                    if let from = fromRow(request) {
                        Text(verbatim: from)
                            .cbFont(12.5)
                            .foregroundStyle(CbColor.textMuted)
                    }
                    if let reason = request.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
                        Text(verbatim: reason)
                            .cbFont(13)
                            .foregroundStyle(CbColor.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("skill-request-reason")
                    }
                    if open && !request.current {
                        Text(L("The skill has changed since the request."))
                            .cbFont(12.5)
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    // A stale request can no longer be decided; the server discards it on the next read.
                    if open && request.current {
                        HStack(spacing: 4) {
                            CbTextButton(title: L("Approve"), destructive: true, disabled: busy) {
                                Task { await decide(true) }
                            }
                            .accessibilityIdentifier("skill-request-approve")
                            CbTextButton(title: L("Deny"), disabled: busy) {
                                Task { await decide(false) }
                            }
                            .accessibilityIdentifier("skill-request-reject")
                            if busy { CbLoading(compact: true) }
                        }
                        .padding(.leading, -8)
                    }
                } else if error.isEmpty {
                    CbLoading(compact: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !error.isEmpty {
                    Text(error)
                        .cbFont(12.5)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("skill-request-error")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .task(id: requestId) { await load() }
        .onChange(of: events.counter(workspaceId)) { Task { await load() } }
    }

    private func fromRow(_ a: SkillRequest) -> String? {
        let title = (a.chatTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = [title.isEmpty ? L("Agent") : L("Agent · {chat}", ["chat": title]), skillWhen(a.at) ?? ""]
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func statusWord(_ s: SkillRequest.Status?) -> String {
        switch s {
        case .open: return L("Open##state")
        case .approved: return L("Approved")
        case .rejected: return L("Rejected")
        case .expired: return L("Expired")
        case nil: return L("state unknown")
        }
    }

    private func statusColor(_ s: SkillRequest.Status?) -> Color {
        switch s {
        case .approved: return .red
        case .rejected: return CbColor.textSecondary
        default: return CbColor.textMuted
        }
    }

    private func load() async {
        do {
            let fresh = try await client.skillRequest(id: requestId)
            request = fresh
            SkillCardsCache.requests[requestId] = fresh
            error = ""
        } catch {
            self.error = skillErrorText(error)
        }
    }

    private func decide(_ approve: Bool) async {
        busy = true
        defer { busy = false }
        error = ""
        do {
            if let fresh = try await client.decideSkillRequest(id: requestId, approve: approve) {
                request = fresh
                SkillCardsCache.requests[requestId] = fresh
            } else {
                await load()
            }
            await decided()
        } catch {
            self.error = skillErrorText(error)
            await load()
        }
    }
}

// ── "Recently deleted" ────────────────────────────────────────────────────

/// A row of the "Recently deleted" list: the old name, who and when, on the right "Restore" (= undo of the delete entry), only if
/// the server calls it revertible (otherwise another skill carries the name).
struct SkillDeletedRow: View {
    let entry: SkillHistoryEntry
    let client: APIClient
    /// At workspace level a project skill shows its project.
    let showProject: Bool
    let restored: () async -> Void

    private var shortLine: String {
        var parts: [String] = []
        if showProject, entry.projectId != nil {
            parts.append(L("Project · {name}", ["name": entry.projectName ?? "—"]))
        }
        switch entry.who {
        case .agent:
            let title = (entry.chatTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            parts.append(title.isEmpty ? L("deleted by agent") : L("deleted by agent · {chat}", ["chat": title]))
        default:
            parts.append(L("deleted"))
        }
        if let when = skillWhen(entry.at) { parts.append(when) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CbTileRow(
                symbol: "trash",
                situation: .off,
                title: entry.skillName.isEmpty ? L("Skill") : entry.skillName,
                titleMono: true,
                shortLine: Text(verbatim: shortLine),
                active: false
            )
            if entry.revertible {
                SkillUndoButton(
                    client: client,
                    entryId: entry.id,
                    title: L("Restore"),
                    identifier: "skill-deleted-restore-\(entry.id)",
                    finished: restored
                )
                .padding(.leading, 56)
                .padding(.top, -6)
                .padding(.bottom, 6)
            }
        }
    }
}
