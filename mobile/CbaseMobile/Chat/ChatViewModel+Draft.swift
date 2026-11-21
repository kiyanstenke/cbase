// Persisted composer draft of a chat.
import Foundation

extension ChatViewModel {

    // MARK: - Composer draft

    /// A real chat hangs on its id. A draft without a server chat hangs on workspace, project and folder — its model id
    /// is random (see init) and is no good as a key; `ensureServerChat` re-keys the entry to the chat id on creation.
    static func draftKey(chatId: String) -> String { // internal, for extensions
        "cbase.mobile.draft:\(chatId)"
    }

    static func draftKey(newIn workspace: Workspace, projectId: String?, folderId: String?) -> String { // internal, for extensions
        "cbase.mobile.draft:new:\(workspace.id):\(projectId ?? "ws"):\(folderId ?? "")"
    }

    /// Key and text are captured when scheduling, not when writing: so the last state arrives even if the view releases
    /// the model within the throttle. Every further change reschedules and cancels the previous run.
    func planeDraft() { // internal, for extensions
        draftTask?.cancel()
        let key = draftKey
        let text = input
        draftTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            Self.writeDraft(text, forKey: key)
        }
    }

    private static func writeDraft(_ text: String, forKey key: String) {
        if text.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(text, forKey: key)
        }
    }

    /// Write at once without waiting for the throttle — for a view that is about to disappear.
    func flushDraft() {
        draftTask?.cancel()
        draftTask = nil
        Self.writeDraft(input, forKey: draftKey)
    }

    /// After sending there is no draft any more — and a still scheduled write must not revive it.
    func dismissDraft() { // internal, for extensions
        draftTask?.cancel()
        draftTask = nil
        UserDefaults.standard.removeObject(forKey: draftKey)
    }
}
