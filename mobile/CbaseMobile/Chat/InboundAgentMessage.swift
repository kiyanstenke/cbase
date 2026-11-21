import Foundation

/// An agent's message to this chat (agent communication): the THIRD kind under the role `user` (next to the user message
/// and the completion notice, `CompletionNotice.swift`).
///
/// The server stores a message with cause "message" under the role `user` (for the recipient it is the input of a turn)
/// in this form (`server/backend/electron/server/runs/message-marker.js`, `buildMessage`):
///
///     <cbase-message from="<display name>" kind="agent|outer_loop" address="<chat:<id>|graph:<startId>|…>">
///     <text, XML-escaped (&amp; &lt; &gt; &quot;)>
///     </cbase-message>
///
/// For the human it is a card "Message from <from>" (outer loop: "Outer loop <from>"), not a user bubble, and it closes
/// no question. The timeline build (`buildTimeline`), the stream (`user_message`, `message_injected`) and the queue strip
/// (via `CompletionNotice.queue`) ask HERE. The SAME rule as `readMessage` in web/src/lib/agents-message.ts (rules 1-5 in its
/// header), bound in web/test/agents-message-binding.test.mjs.
/// Computed on UTF-16 (`NSString`) like in JavaScript: `String.hasSuffix("\n")` would see a `\r\n` as ONE character.
/// Imports only Foundation: the binding runs the file on its own.
struct InboundAgentMessage: Hashable, Sendable {
    /// Display name of the sender: data, not translated.
    var from: String
    /// `agent` | `outer_loop`; an unknown value stays as it came.
    var kind: String
    /// The sender's reply address (`chat:<id>`, `graph:<startId>`, …).
    var address: String
    /// The text, un-escaped again. Foreign text.
    var text: String

    static let marker = "<cbase-message"
    private static let end = "</cbase-message>"

    /// Rule 1: the kind: the text STARTS with the marker (compared on UTF-16, like `startsWith`).
    static func isMessage(_ text: String) -> Bool { text.utf16.starts(with: marker.utf16) }

    /// Rule 5: `&lt;` `&gt;` `&quot;` first, `&amp;` last.
    private static func entXml(_ s: String) -> String {
        s.replacingOccurrences(of: "&lt;", with: "<", options: .literal)
            .replacingOccurrences(of: "&gt;", with: ">", options: .literal)
            .replacingOccurrences(of: "&quot;", with: "\"", options: .literal)
            .replacingOccurrences(of: "&amp;", with: "&", options: .literal)
    }

    private static let valuePattern = try! NSRegularExpression(pattern: "([a-z_]+)=\"([^\"]*)\"")

    /// Sender, kind, address and text; `nil` if the text is no message or its head or end is missing.
    static func read(_ text: String) -> InboundAgentMessage? {
        guard isMessage(text) else { return nil }
        let ns = text as NSString
        let start = (marker as NSString).length
        // Rule 2: the head extends to the FIRST `>`.
        let headerEnd = ns.range(of: ">", options: .literal, range: NSRange(location: start, length: ns.length - start)).location
        guard headerEnd != NSNotFound else { return nil }
        let rest = ns.substring(from: headerEnd + 1) as NSString
        // Rule 4: the body up to the LAST end.
        let endAt = rest.range(of: end, options: [.literal, .backwards]).location
        guard endAt != NSNotFound else { return nil }
        // Rule 3: per `name="…"` in the head, the first one counts.
        let header = ns.substring(with: NSRange(location: start, length: headerEnd - start))
        var values: [String: String] = [:]
        for m in valuePattern.matches(in: header, range: NSRange(location: 0, length: (header as NSString).length)) {
            let name = (header as NSString).substring(with: m.range(at: 1))
            if values[name] == nil { values[name] = entXml((header as NSString).substring(with: m.range(at: 2))) }
        }
        var body = rest.substring(to: endAt) as NSString
        if body.length > 0, body.character(at: 0) == 10 { body = body.substring(from: 1) as NSString }
        if body.length > 0, body.character(at: body.length - 1) == 10 { body = body.substring(to: body.length - 1) as NSString }
        return InboundAgentMessage(from: values["from"] ?? "", kind: values["kind"] ?? "", address: values["address"] ?? "", text: entXml(body as String))
    }

    /// What the card shows: the parsed message; for a text with the marker whose head or end is missing, a card without
    /// sender showing the raw text (rule 1: never a user bubble). `nil` for any other input. Like `messageCard`.
    static func card(_ text: String) -> InboundAgentMessage? {
        guard isMessage(text) else { return nil }
        return read(text) ?? InboundAgentMessage(from: "", kind: "", address: "", text: text)
    }

    /// The card's heading, already translated. Like `messageHeader` on the web.
    var header: String {
        let outer = kind == "outer_loop"
        if from.isEmpty { return outer ? L("Outer loop") : L("Message from an agent") }
        return outer ? L("Outer loop {name}", ["name": from]) : L("Message from {name}", ["name": from])
    }

    /// A queue entry: the card's heading as a system row (no trash can), `nil` for any other input. Asked by
    /// `CompletionNotice.queue`, BEFORE the completion notice. Like `messageQueue` on the web.
    static func queue(_ text: String) -> String? { card(text)?.header }
}
