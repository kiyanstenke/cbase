import SwiftUI

// ── Notification center (the bell) ──────────────────────────────────────────
struct NotificationsView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var events: [ServiceEvent] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            CbList {
                if loading && events.isEmpty {
                    Section { CbLoading(compact: true) }
                }
                if events.isEmpty && !loading {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(L("No notifications.")).font(.subheadline)
                            Text(L("Service outages and recoveries appear here."))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                ForEach(events) { event in
                    Button {
                        // A requested review or a triggered run opens in the normal chat list.
                        if let chatId = event.chatId, !chatId.isEmpty {
                            dismiss()
                            state.openChat(chatId)
                        }
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            ZStack {
                                Circle().fill(tint(event).opacity(0.15))
                                Image(systemName: symbol(event))
                                    .font(.symbol(12, weight: .semibold))
                                    .foregroundStyle(tint(event))
                            }
                            .frame(width: 28, height: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(event.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                    Spacer()
                                    Text(locRelative(event.at))
                                        .cbFont(10)
                                        .monospacedDigit()
                                        .foregroundStyle(.secondary)
                                }
                                Text(event.body).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                                if answered(event) {
                                    // Done: no longer a prompt — the card is closed.
                                    Text(L("Answered")).font(.caption2).foregroundStyle(.secondary)
                                } else if event.chatId?.isEmpty == false {
                                    Text(event.kind == "review" ? L("Answer review →") : L("Open chat →"))
                                        .font(.caption2)
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .opacity(answered(event) ? 0.7 : 1)
                    .accessibilityIdentifier("notification-\(event.id)")
                }
            }
            .navigationTitle(L("Notifications"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Done")) { dismiss() }
                ToolbarItem(placement: .topBarTrailing) {
                    if !events.isEmpty {
                        Button(L("Clear all"), role: .destructive) { Task { await clearAll() } }
                    }
                }
            }
            .task { await load() }
        }
    }

    /// A question or review whose card is already closed (answered, answered via a channel,
    /// dismissed) — it stays as history but no longer asks for anything.
    private func answered(_ event: ServiceEvent) -> Bool {
        event.resolved && (event.kind == "question" || event.kind == "review")
    }

    private func symbol(_ event: ServiceEvent) -> String {
        if answered(event) { return "checkmark.circle" }
        switch event.kind {
        case "down": return "exclamationmark.triangle.fill"
        case "question": return "questionmark.circle.fill"
        // A requested review waits for a HUMAN — the same symbol as in the history.
        case "review": return "person.crop.circle.badge.checkmark"
        case "trigger", "workflow": return "bolt.fill"
        default: return "checkmark.circle.fill"
        }
    }

    private func tint(_ event: ServiceEvent) -> Color {
        if answered(event) { return .secondary }
        switch event.kind {
        case "down": return .red
        case "question", "review", "trigger", "workflow": return .accentColor
        default: return .green
        }
    }

    private func load() async {
        guard let client = session.client else { return }
        loading = true
        defer { loading = false }
        if let response: ServiceEventsResponse = try? await client.get(
            "/api/services/events",
            query: [URLQueryItem(name: "since", value: "0")]
        ) {
            events = response.events.reversed()
            state.markNotificationsRead(highestId: events.map(\.id).max() ?? 0)
        }
    }

    private func clearAll() async {
        guard let client = session.client else { return }
        _ = try? await client.send("/api/services/events", method: .delete)
        events = []
        state.unreadNotifications = 0
    }
}
