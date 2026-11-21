import SwiftUI

// The timeline of ONE chat's project as a sheet from the header (⋯ → "Timeline"), only when the chat has a project. The
// same list as Projects → Project → Timeline (Code/ProjectTimeline.swift). A tap on a hit closes the sheet and opens the
// chat (for a subagent with its sheet, `AppState.openChat(_:agent:)`); if it is THIS chat without a subagent, it only closes.
struct ProjectTimelineSheet: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    let projectName: String
    let chatId: String?
    /// Open THIS chat's agenda (ChatView: close the sheet, then the agenda sheet); an item of another chat opens that chat.
    var openAgenda: (() -> Void)? = nil

    @StateObject private var model: ProjectTimelineModel

    init(client: APIClient, projectId: String, projectName: String, chatId: String?, openAgenda: (() -> Void)? = nil) {
        self.projectId = projectId
        self.projectName = projectName
        self.chatId = chatId
        self.openAgenda = openAgenda
        _model = StateObject(wrappedValue: ProjectTimelineModel(client: client, projectId: projectId))
    }

    var body: some View {
        NavigationStack {
            ProjectTimelineList(model: model, open: { f in
                guard let cid = f.chatId else { return }
                dismiss()
                if let agent = f.subagentId {
                    state.openChat(cid, agent: agent)
                } else if cid != chatId {
                    state.openChat(cid)
                }
            }, agenda: { p in
                // The agenda item: this chat ⇒ its agenda sheet; another ⇒ that chat (its agenda in the header).
                guard let cid = p.chatId else { return }
                dismiss()
                if cid == chatId { openAgenda?() } else { state.openChat(cid) }
            })
            .cbSheetBase()
            .navigationTitle(projectName.isEmpty ? L("Timeline") : L("Timeline") + " · " + projectName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "chat-timeline-close") { dismiss() } }
        }
        .accessibilityIdentifier("chat-timeline-sheet")
        .task { if !model.loaded { await model.load() } }
        .onChange(of: state.timelineTick[projectId] ?? 0) { _, _ in Task { await model.load() } }
    }
}
