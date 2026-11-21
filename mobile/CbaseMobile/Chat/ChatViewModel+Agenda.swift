import Foundation

// The agenda of ONE coding chat — the iOS counterpart of `web/src/components/chat/chatAgenda.ts`: loaded from the route
// (`GET /api/chats/:id/agenda`) on EVERY stream connection (`connected`, the first one too: after a dropped stream the
// route's state is the truth, and each chat has its own model and stream), updated from the `harness/agenda` event.
// The transitions are computed by `Agenda` (Chat/Agenda.swift) — only the paths live here. Only with `withDynWorkflows`
// (the coding chat). A draft without an id does not load. Read-only — the chat's agent maintains the agenda.
extension ChatViewModel {

    func loadAgenda() async {
        guard withDynWorkflows, !isDraft else { return }
        let chatId = chat.id
        do {
            // The path is NOT pre-encoded: `APIClient.makeURL` sets `components.path` and encodes it itself.
            let response: Agenda.Response = try await client.get("/api/chats/\(chatId)/agenda")
            guard chat.id == chatId else { return }
            agendaState = Agenda.loaded(agendaState, response: response, chatId: chatId)
        } catch {
            // Failed is not empty: a state already shown stays, plus the error; the next connection asks again.
            guard chat.id == chatId else { return }
            agendaState.error = error.localizedDescription
        }
    }

    /// For the `agenda` event from the stream (ChatViewModel+Stream.swift).
    func agendaEvent(_ event: JSONValue) { // internal, for extensions
        guard withDynWorkflows else { return }
        agendaState = Agenda.afterEvent(agendaState, event: try? JSONEncoder().encode(event), chatId: chat.id)
    }

    /// Is a sheet in progress? Then the "Agenda" header button carries its dot.
    var agendaInWork: Bool { Agenda.inWork(agendaState.agenda) }

    // MARK: Remembered fold state (agenda as a tree)
    //
    // Per device and chat, only the DEVIATIONS from the default, under the same key as `localStorage` on the web
    // (`Agenda.foldKey`). An unreadable entry means the default (`Agenda.readDeviations`); none of it is server truth.

    /// The remembered deviations of this chat (none in a draft without an id).
    func agendaDeviations() -> [String: Bool] {
        guard !isDraft else { return [:] }
        return Agenda.readDeviations(UserDefaults.standard.string(forKey: Agenda.foldKey(chat.id)))
    }

    /// Remembers this chat's deviations — without any deviation the entry disappears.
    func rememberAgendaDeviations(_ deviations: [String: Bool]) {
        guard !isDraft else { return }
        let key = Agenda.foldKey(chat.id)
        if let text = Agenda.deviationsText(deviations) {
            UserDefaults.standard.set(text, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
