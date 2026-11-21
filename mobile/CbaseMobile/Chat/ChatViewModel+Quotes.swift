// Quotes from the history: "Reply" on the text marker. The quotes sit as a card above the field, the field shows the
// tag "1 note" (`Chat/ChatQuotes.swift`).
//
// What goes out: every line prefixed with "> " — the fence around foreign text, a quote is data,
// not an instruction —, several quotes separated by a blank line, the own message after them (`send`). The same
// computation lives on the web in `web/src/lib/quotes.ts`.
import Foundation

extension ChatViewModel {

    /// Store the selection as a quote. While quotes wait, the message is no command — an open slash picker closes.
    func attachQuote(_ text: String) {
        let quote = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !quote.isEmpty else { return }
        quotes.append(quote)
        slashQuery = nil
    }

    /// Adopt an edited quote; empty means remove (an empty quote would otherwise go out as "> ").
    func replaceQuote(at index: Int, through text: String) {
        guard quotes.indices.contains(index) else { return }
        let fresh = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if fresh.isEmpty {
            removeQuote(at: index)
        } else {
            quotes[index] = fresh
        }
    }

    func removeQuote(at index: Int) {
        guard quotes.indices.contains(index) else { return }
        quotes.remove(at: index)
        if quotes.isEmpty { updateSlash(for: input) }
    }

    func clearQuotes() {
        quotes = []
        updateSlash(for: input)
    }

    /// A quote as a Markdown quote block: every line prefixed with "> ". Split at EVERY line break, not only "\n":
    /// in Swift "\r\n" is ONE Character and not equal to "\n" — a CRLF quote got
    /// its "> " only before the first line, the server (`shortName.js:withoutQuotes`, splits at "\n") read the rest as a separate
    /// line of the human, and a quoted `/workflow:x` was an instruction again. Guard: `web/test/slash.test.mjs` runs
    /// this function with `xcrun swift`.
    static func quoteBlock(_ text: String) -> String {
        text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
            .map { "> \($0)" }
            .joined(separator: "\n")
    }

    /// The message as it goes out: the quotes first, the input after them. Without quotes it is unchanged.
    static func withQuotes(_ quotes: [String], _ text: String) -> String {
        let blocks = quotes
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map(quoteBlock)
        if blocks.isEmpty { return text }
        return (text.isEmpty ? blocks : blocks + [text]).joined(separator: "\n\n")
    }
}
