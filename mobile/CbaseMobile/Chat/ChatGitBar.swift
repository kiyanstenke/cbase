import SwiftUI

// The instance choice of a chat's git view on iOS — the counterpart of the choice in the head of the
// git section of the right chat rail on the web (web/src/components/chat/ChatRightSidebar.tsx). The
// computation lives in Chat/BarInstance.swift (twin of web/src/lib/bar-instance.ts, bound); here
// only loading, remembering, switching and showing:
//   - Without a choice the chat's git sheet (Code/GitPane.swift `ChatGitButton`) shows and drives
//     the instance OF THE CHAT (`chat=<id>`, the server decides: its copy, else main). With a choice
//     EXACTLY the chosen instance — a copy via `instance=<identifier>`, main without a parameter,
//     never both. What the sheet can do (stage, commit, pull/push, branch, diff, stash) then acts THERE.
//   - The whole `GitModel` is swapped (chat and instance are `let` there); the sheet rebuilds
//     GitPane per model (`.id`) so the tick and sub-sheets of the old target do not keep running.
//     The count on the button reads the same model and follows the choice.
//   - Remembered per chat in memory (`choices`), not in UserDefaults: after a restart the own
//     instance is unknown, and a forgotten choice would make a commit in the wrong container more
//     likely. It survives the rebuild of the button (chat switch).
//   - The source of the choice is `/api/projects` (`instance.copies[]` with `chatId`) — fresh on
//     appearing, on every `project/instance` or `project/copy` event of this project (AppState
//     `instanceEvents`) and when the app returns.
//   - If the choice drops (copy gone, cleaned up, failed, the chat moved in or out, 404
//     `UNKNOWN_INSTANCE`), the sheet follows the CHAT again — visibly, with a hint. The hint follows
//     every list read (`BarInstance.hintBySituation`); states appear as a word, never as an
//     identifier like "clearAway".
@MainActor
final class ChatGitBar: ObservableObject {
    /// The choice per chat (see header) — counterpart of the web's module map `barChoices`.
    private static var choices: [String: BarInstance.Choice] = [:]

    let client: APIClient
    let projectId: String
    let projectName: String
    /// The chat whose git state the sheet shows — nil in a draft (then main, without a choice).
    let chatId: String?
    /// Its binding (`chats.instance`: `copy-<name>` or nil = main) — the signature of the choice carries it;
    /// kept current via `bindingChanged`.
    @Published private(set) var binding: String?
    @Published private(set) var situation: CodeInstance.ListSituation = .loading
    @Published private(set) var field: CodeInstance.Field?
    @Published private(set) var choice: BarInstance.Choice?
    /// Why a choice dropped — stays until the human dismisses it or chooses again.
    @Published var hint: BarInstance.Hint?
    /// The git model of the current target — swapped when the target changes.
    @Published private(set) var git: GitModel
    private var target: BarInstance.Target

    init(client: APIClient, projectId: String, projectName: String, chatId: String?, binding: String?) {
        self.client = client
        self.projectId = projectId
        self.projectName = projectName
        self.chatId = chatId
        self.binding = binding
        let remembered = chatId.flatMap { Self.choices[$0] }
        choice = remembered
        // The target NEVER hangs on the tree — without a choice the chat, with a choice the choice (until the list is read it stays).
        let z = BarInstance.snapshot(projectId: projectId, field: nil, situation: .loading, chatId: chatId, binding: binding, ownFromServer: .unknown,
                                    choice: remembered).target
        target = z
        git = GitModel(client: client, apiBase: "/api/projects/\(projectId)", scopeName: projectName, chatId: z.chatId, instance: z.instance)
        git.onError = { [weak self] e in self?.error(e) }
    }

    /// What the chat-bound tree says about the own instance — only in chat mode (with a choice nobody reads it).
    var ownFromServer: BarInstance.Own {
        guard target.chatId != nil, git.loaded else { return .unknown }
        return git.copy.map { .copy($0) } ?? .main
    }

    var snapshot: BarInstance.Snapshot {
        BarInstance.snapshot(projectId: projectId, field: field, situation: situation, chatId: chatId, binding: binding, ownFromServer: ownFromServer,
                            choice: choice)
    }

    /// The chat's binding changed (switch in the head, `cbase_switch_instance`, move in or out): a remembered choice drops
    /// (signature, hint "own"), and the chat-bound tree is read again — it now names the new instance. If the target
    /// changes, `anwenden` loads the new model itself.
    func bindingChanged(_ fresh: String?) {
        guard fresh != binding else { return }
        binding = fresh
        let prior = git
        apply()
        if git === prior { Task { await prior.load() } }
    }

    /// The project's row from `/api/projects` — only what the choice needs. A missing field means: no statement.
    private struct Row: Decodable {
        let id: String
        let instance: Instance?
        struct Instance: Decodable {
            let identifier: String?
            let converted: Bool?
            let copies: [Copy]?
        }
        struct Copy: Decodable {
            let identifier: String?
            let state: String?
            let chatId: String?
        }
    }

    func load() async {
        do {
            let list: [Row] = try await client.get("/api/projects")
            let z = list.first(where: { $0.id == projectId })?.instance
            field = z.map { i in
                CodeInstance.Field(identifier: i.identifier, converted: i.converted,
                                 copies: i.copies?.map { CodeInstance.CopyRow(identifier: $0.identifier, state: $0.state, chatId: $0.chatId) })
            }
            situation = .loaded
            // A shown hint follows the freshly read list — otherwise it froze at the first fallback.
            if hint != nil { hint = BarInstance.hintBySituation(hint, field: field, situation: .loaded) }
        } catch {
            // A list once read stays as it was; only with no answer at all is the situation "fehler".
            if situation != .loaded { situation = .error }
        }
        apply()
    }

    /// Apply the state: forget a dropped choice (with a hint), swap the model when the target changes.
    func apply() {
        let s = snapshot
        if choice != nil, s.remember == nil {
            remember(nil)
            if let h = s.hint { hint = h }
        }
        let fresh = snapshot.target
        guard fresh != target else { return }
        target = fresh
        let g = GitModel(client: client, apiBase: "/api/projects/\(projectId)", scopeName: projectName, chatId: fresh.chatId, instance: fresh.instance)
        g.onError = { [weak self] e in self?.error(e) }
        git = g
        Task { await g.load() }
    }

    /// The human chooses an instance — choosing the own one means: the chat again.
    func select(_ identifier: String) {
        guard let chatId else { return }
        hint = nil
        remember(BarInstance.select(snapshot, identifier: identifier, projectId: projectId, field: field, chatId: chatId, binding: binding))
        apply()
    }

    /// An error of a fetch or an action: if the server calls the CHOSEN instance unknown, the choice drops (back to the chat).
    func error(_ error: Error) {
        guard let e = error as? APIError, let h = BarInstance.afterError(choice, code: e.code, identifier: e.identifier) else { return }
        remember(nil)
        hint = h
        apply()
        Task { await load() }
    }

    private func remember(_ w: BarInstance.Choice?) {
        choice = w
        guard let chatId else { return }
        if let w { Self.choices[chatId] = w } else { Self.choices.removeValue(forKey: chatId) }
    }

    static func label(_ name: String?) -> String {
        name.map { L("Copy {name}", ["name": $0]) } ?? L("Main")
    }

    static func text(_ h: BarInstance.Hint) -> String {
        switch h {
        case .own:
            return L("This chat's copy changed — Git follows the chat again.")
        case .notReady(let name, let state):
            return L("The copy {name} is not ready ({state}) — Git shows this chat's instance again.", ["name": name, "state": CodeInstanceBar.stateWord(state)])
        case .transient(let name, let state):
            return L("The copy {name} is not ready right now ({state}) — Git stays with it.", ["name": name, "state": CodeInstanceBar.stateWord(state)])
        case .gone(let name):
            return name.isEmpty
                ? L("The chosen instance no longer exists — Git shows this chat's instance again.")
                : L("The copy {name} no longer exists — Git shows this chat's instance again.", ["name": name])
        }
    }
}

/// The git sheet of a chat: GitPane of the current target, the choice in the head, a hint above the content.
struct ChatGitSheet: View {
    @ObservedObject var bar: ChatGitBar

    var body: some View {
        ChatGitSheetContent(bar: bar, git: bar.git)
    }
}

private struct ChatGitSheetContent: View {
    @ObservedObject var bar: ChatGitBar
    /// Observed because the choice hangs on `loaded`/`copy` of the chat-bound tree.
    @ObservedObject var git: GitModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let s = bar.snapshot
        // The ✕ of every head sheet — here before the title, the sheet has no navigation bar.
        GitPane(model: git, headerAddition: header(s), hintAddition: hint(s),
                headerFront: AnyView(SheetCloseButton(identifier: "chat-git-close") { dismiss() }))
            // New per model: tick, sub-sheets and state of the old target do not keep running (like the `key` on the web).
            .id(ObjectIdentifier(git))
            // As its own container: an identifier on a stack overwrote that of every button in the head — the ✕
            // (`chat-git-close`) and the instance choice could not be found by the test bench.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-git-sheet")
    }

    /// The choice in the head: a menu as soon as there are at least two instances; while the list reloads after a choice, the chosen one as a
    /// marker; otherwise nothing (the title names the copy as before).
    private func header(_ s: BarInstance.Snapshot) -> AnyView? {
        guard !s.options.isEmpty || s.foreign else { return nil }
        let shown = ChatGitBar.label(s.shownName)
        let title = s.foreign ? shown : L("{instance} · this chat", ["instance": shown])
        let foreignText = L("Not this chat's instance — Git shows and acts on {instance}.", ["instance": shown])
        if s.options.isEmpty {
            return AnyView(
                ChatGitInstanceLabel(title: title, foreign: true, withArrow: false)
                    .accessibilityLabel(foreignText)
                    .accessibilityIdentifier("chat-git-instance-foreign")
            )
        }
        return AnyView(
            Menu {
                ForEach(s.options, id: \.identifier) { o in
                    let name = ChatGitBar.label(o.kind == "copy" ? o.name : nil)
                    let row = o.own ? L("{instance} · this chat", ["instance": name]) : name
                    Button { bar.select(o.identifier) } label: {
                        if o.identifier == s.shown { Label(row, systemImage: "checkmark") } else { Text(row) }
                    }
                    .accessibilityIdentifier("chat-git-instance-\(o.kind == "main" ? "main" : o.name)")
                }
            } label: {
                ChatGitInstanceLabel(title: title, foreign: s.foreign, withArrow: true)
            }
            .accessibilityLabel(s.foreign ? foreignText : title)
            .accessibilityIdentifier("chat-git-instance-choice")
        )
    }

    private func hint(_ s: BarInstance.Snapshot) -> AnyView? {
        let transient: BarInstance.Hint? = { if case .transient = s.hint { return s.hint } else { return nil } }()
        guard let h = bar.hint ?? transient else { return nil }
        return AnyView(
            HStack(alignment: .top, spacing: 8) {
                Label(ChatGitBar.text(h), systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat-git-instance-hint")
                if bar.hint != nil {
                    Button(L("Dismiss##hide")) { bar.hint = nil }
                        .font(.caption)
                }
            }
            .padding(10)
            .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 11))
        )
    }
}

/// The capsule of the choice: the own instance in the accent, a foreign one orange with a warning sign — foreign means git does NOT act where the
/// chat works.
private struct ChatGitInstanceLabel: View {
    let title: String
    let foreign: Bool
    let withArrow: Bool

    var body: some View {
        HStack(spacing: 5) {
            if foreign {
                Image(systemName: "exclamationmark.triangle.fill").font(.symbol(10, weight: .semibold))
            }
            Text(title).lineLimit(1)
            if withArrow {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.symbol(9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .cbFont(12, weight: .medium)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .foregroundStyle(foreign ? Color.orange : Color.accentColor)
        .background(foreign ? Color.orange.opacity(0.14) : CbColor.elevated, in: Capsule())
        .fixedSize()
    }
}
