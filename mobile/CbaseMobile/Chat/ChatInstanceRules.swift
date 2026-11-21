import Foundation

// The pure rules of the instance of a coding chat on iOS, in ONE place and EXECUTED in
// web/test/chat-instance-ios.test.mjs (`xcrun swiftc` with Models/JSONValue.swift and
// Code/InstancesTree.swift). Foundation only, no L(…): translation happens in the view
// (Chat/ChatHeader.swift `ChatInstanceChoice`).
//   - `announcement`: what `harness`/`chat_settings` say about the instance of the open chat. The server
//     reports every change of `chats.instance` this way (runs/instance-switch.js `chatInstanceSet`,
//     `instanceAfterProjectSwitch`) — `instance: null` means main. A `chat_settings` WITHOUT the
//     field (the workflow driver only reports run fields there) says nothing about the instance.
//   - `draftChoice`: the copy remembered in the draft only counts while the live list offers it as
//     an option — otherwise main (nil). Otherwise a draft would carry on a dead copy and the first
//     send would fail with 409 UNKNOWN_INSTANCE.
//   - `eintraege`: the menu entries. Without live options there is no menu — EXCEPT when the chat is
//     bound to a copy that is no longer an option: then main (the way back) and the binding (not
//     selectable) are shown. Every converted project with a read field has options (at least main).
//   - `copyCreate`: whether "Create copy …" is among the entries — only with options (an
//     "Instances" tab exists).
//   - `zeile`: an option as a row of the tree (`InstancesTree.readTree`), so its state gets the SAME
//     position and word as in the "Instances" tab (`ProjectInstancesPage.situationText`) rather than
//     the raw server state in the menu.
enum ChatInstanceRules {
    /// What a stream event says about the instance: nothing, or the new binding (nil = main).
    enum Announcement: Equatable {
        case no
        case instance(String?)
    }

    /// One entry of the instance choice.
    struct Entry: Equatable, Identifiable {
        var id: String { name }
        /// `main` or `copy-<name>`.
        let name: String
        /// State of the instance row — empty when unknown (main without options, a binding without an option).
        let state: String
        /// false: the chat's binding, which is no longer an option — shown so one sees where the chat stands, but not selectable.
        let selectable: Bool
    }

    /// The binding as the value of `chat.instance`: nil for main (null, empty, "main"), otherwise the name.
    static func binding(_ value: String?) -> String? {
        let w = InstancesTree.chatInstanceName(value)
        return w == InstancesTree.main ? nil : w
    }

    /// `harness`/`chat_settings` → the statement about the instance. Only an existing `instance` field (text or null) says anything.
    static func announcement(_ event: JSONValue) -> Announcement {
        guard let raw = event["instance"] else { return .no }
        switch raw {
        case .null: return .instance(nil)
        case .string(let s): return .instance(binding(s))
        default: return .no
        }
    }

    /// The instance remembered in the draft checked against the names of the live options: stays while it is listed there, otherwise nil (main).
    static func draftChoice(_ selected: String?, live: [String]) -> String? {
        guard let g = binding(selected) else { return nil }
        return live.contains(g) ? g : nil
    }

    /// The menu entries from the options (`InstancesTree.chatInstanceOptions`) and the chat's binding. Empty: no menu.
    static func entries(_ options: [InstancesTree.Option], selected: String?) -> [Entry] {
        var list = options.map { Entry(name: $0.name, state: $0.state, selectable: true) }
        guard let g = binding(selected), !list.contains(where: { $0.name == g }) else { return list }
        if list.isEmpty { list = [Entry(name: InstancesTree.main, state: "", selectable: true)] }
        list.append(Entry(name: g, state: "", selectable: false))
        return list
    }

    /// "Create copy …" below the choice: exactly when options exist — a converted project with a read field (`chatInstanceOptions`
    /// returns at least main there). If the choice only appears because of a binding to a dead copy (no options: the project is not
    /// converted or its field is not readable), there is no "Instances" tab the entry could lead to.
    static func copyCreate(_ options: [InstancesTree.Option]) -> Bool {
        !options.isEmpty
    }

    /// An entry as a row of the tree — for position and word of the "Instances" tab. nil when the name is not an instance.
    static func row(name: String, state: String) -> InstancesTree.Instance? {
        let raw: [String: Any] = ["loaded": true, "instances": [["name": name, "state": state] as [String: Any]]]
        return InstancesTree.readTree(raw)?.instances.first
    }
}
