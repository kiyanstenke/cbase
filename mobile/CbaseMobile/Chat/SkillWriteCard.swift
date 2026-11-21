import SwiftUI

// The tool block of `cbase_skill_write` in the history: under the ordinary tool row "Skill <name> created/changed" with
// "Undo", the state fetched fresh via `skill-history?skillId=` (can it be undone? already undone?); for `requested`
// the request card (approve/reject, status after the decision, `Code/SkillHistoryView.swift`). What is read is the
// tool's result (`SkillWriteResult.from`); a failure shows only the row.
//
// The history cells are UIHostingConfiguration cells and inherit nothing from the SwiftUI tree: client and workspace
// come through `chatSkillContext`, set per cell in `ChatTimelineStage.rowView`. Without it (call sheet) only the
// sentence is shown, without buttons.

/// What the card needs to ask the server.
struct SkillChatContext {
    let client: APIClient
    let workspaceId: String
}

private struct ChatSkillContextKey: EnvironmentKey {
    static let defaultValue: SkillChatContext? = nil
}

extension EnvironmentValues {
    var chatSkillContext: SkillChatContext? {
        get { self[ChatSkillContextKey.self] }
        set { self[ChatSkillContextKey.self] = newValue }
    }
}

struct SkillWriteCard: View {
    let result: SkillWriteResult
    @Environment(\.chatSkillContext) private var context

    var body: some View {
        switch result.kind {
        case .requested:
            if let context, let requestId = result.requestId {
                SkillRequestCard(client: context.client, requestId: requestId, workspaceId: context.workspaceId)
            } else {
                set(L("Deletion of {name} requested", ["name": result.name]))
            }
        case .created, .changed, .unchanged:
            SkillChangeRow(result: result, context: context)
        }
    }

    private func set(_ text: String) -> some View {
        Text(verbatim: text)
            .chatFont(.subheadline)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("chat-skill-set")
    }
}

/// "Skill <name> created" or "changed": on the right the state of the history entry: "Undo" if the server calls it
/// undoable, "Undone" if that already happened, otherwise nothing (the skill has changed since).
private struct SkillChangeRow: View {
    let result: SkillWriteResult
    let context: SkillChatContext?

    @ObservedObject private var events = SkillEvents.shared
    @State private var entry: SkillHistoryEntry?

    init(result: SkillWriteResult, context: SkillChatContext?) {
        self.result = result
        self.context = context
        _entry = State(initialValue: result.historyId.flatMap { SkillCardsCache.entries[$0] })
    }

    private var set: String {
        switch result.kind {
        case .created: return L("Skill {name} created", ["name": result.name])
        case .unchanged: return L("Skill {name} unchanged", ["name": result.name])
        default: return L("Skill {name} changed", ["name": result.name])
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "wand.and.stars")
                    .chatFont(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text(verbatim: set)
                    .chatFont(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .accessibilityIdentifier("chat-skill-set")
                Spacer(minLength: 0)
                if entry?.revertedAt != nil {
                    Text(L("Undone"))
                        .chatFont(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("chat-skill-reverted")
                }
            }
            if let context, let entry, entry.revertible, entry.revertedAt == nil {
                SkillUndoButton(client: context.client, entryId: entry.id, identifier: "chat-skill-undo") {
                    await load()
                }
                .padding(.leading, -8)
            }
        }
        .task(id: result.historyId) { await load() }
        .onChange(of: context.map { events.counter($0.workspaceId) } ?? 0) { Task { await load() } }
    }

    private func load() async {
        guard let context, let historyId = result.historyId, let skillId = result.skillId, result.kind != .unchanged else { return }
        guard let list = try? await context.client.skillHistory(workspaceId: context.workspaceId, skillId: skillId) else { return }
        let fresh = list.first { $0.id == historyId }
        entry = fresh
        SkillCardsCache.entries[historyId] = fresh
    }
}
