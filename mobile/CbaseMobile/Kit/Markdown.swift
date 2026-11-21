import SwiftUI
import UIKit

// ── Markdown of chat answers ────────────────────────────────────────────────
//
// `AttributedString(markdown:)` handles only the INLINE level (bold, italic, code, links, strikethrough); everything block-like
// arrived as raw text: "## Title", "- item", "1. item", "> quote", "| column |". So this parser recognizes the blocks itself and leaves the
// inline level to Foundation — the same scope as the web client (`web/src/components/Markdown.tsx`), so the same answer looks
// the same on the phone and at the desk.

enum MDAlign {
    case leading, center, trailing
}

/// A list item. `checked` is set only for task lists (`- [ ]` / `- [x]`). The content is blocks again — so items carry nested
/// lists, code blocks and several paragraphs.
struct MDItem {
    var checked: Bool?
    var blocks: [MDBlock]
}

indirect enum MDBlock {
    case heading(level: Int, text: String)
    case paragraph(text: String)
    case code(language: String, text: String)
    case list(ordered: Bool, start: Int, items: [MDItem])
    case quote(blocks: [MDBlock])
    case table(header: [String]?, rows: [[String]], alignments: [MDAlign])
    case rule
}

// ── Parser ──────────────────────────────────────────────────────────────────

struct MarkdownParser {
    static func parse(_ source: String) -> [MDBlock] {
        parse(lines: source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\t", with: "    ")
            .components(separatedBy: "\n"))
    }

    static func parse(lines: [String]) -> [MDBlock] {
        var out: [MDBlock] = []
        var index = 0
        while index < lines.count {
            let start = index
            let line = lines[index]

            if isBlank(line) {
                index += 1
                continue
            }
            if let fence = fenceMarker(line) {
                out.append(codeBlock(lines, &index, fence: fence))
            } else if let (level, text) = headingParts(line) {
                out.append(.heading(level: level, text: text))
                index += 1
            } else if isRule(line) {
                out.append(.rule)
                index += 1
            } else if isQuote(line) {
                out.append(quoteBlock(lines, &index))
            } else if let table = tableBlock(lines, &index) {
                out.append(table)
            } else if marker(line) != nil {
                out.append(listBlock(lines, &index))
            } else {
                out.append(paragraphBlock(lines, &index))
            }
            // Safety net: no branch may stand still, or the view hangs.
            if index == start { index += 1 }
        }
        return out
    }

    // ── Detection ───────────────────────────────────────────────────────────

    private static func isBlank(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static func indentOf(_ line: String) -> Int {
        var count = 0
        for character in line {
            if character == " " { count += 1 } else { break }
        }
        return count
    }

    private static func dedent(_ line: String, by columns: Int) -> String {
        var drop = 0
        for character in line {
            if drop >= columns || character != " " { break }
            drop += 1
        }
        return String(line.dropFirst(drop))
    }

    /// ``` or ~~~ (up to three spaces of indent), returns the character and the language.
    private static func fenceMarker(_ line: String) -> (character: Character, language: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard indentOf(line) <= 3 else { return nil }
        for candidate: Character in ["`", "~"] {
            let fence = String(repeating: String(candidate), count: 3)
            if trimmed.hasPrefix(fence) {
                let rest = trimmed.dropFirst(3).drop(while: { $0 == candidate })
                return (candidate, String(rest).trimmingCharacters(in: .whitespaces))
            }
        }
        return nil
    }

    private static func headingParts(_ line: String) -> (Int, String)? {
        guard indentOf(line) <= 3 else { return nil }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var level = 0
        for character in trimmed {
            if character == "#" { level += 1 } else { break }
        }
        guard level >= 1, level <= 6 else { return nil }
        let rest = trimmed.dropFirst(level)
        guard rest.first == " " || rest.isEmpty else { return nil }
        // Closing hashes ("## Title ##") are not part of the text.
        var text = rest.trimmingCharacters(in: .whitespaces)
        while text.hasSuffix("#") { text = String(text.dropLast()) }
        return (level, text.trimmingCharacters(in: .whitespaces))
    }

    /// Rule: three or more `-`, `*` or `_`, only spaces between.
    private static func isRule(_ line: String) -> Bool {
        guard indentOf(line) <= 3 else { return false }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first, first == "-" || first == "*" || first == "_" else { return false }
        var count = 0
        for character in trimmed {
            if character == first { count += 1 } else if character != " " { return false }
        }
        return count >= 3
    }

    private static func isQuote(_ line: String) -> Bool {
        indentOf(line) <= 3 && line.trimmingCharacters(in: .whitespaces).hasPrefix(">")
    }

    /// A block start that ends a loose list continuation.
    private static func isBlockStart(_ line: String) -> Bool {
        fenceMarker(line) != nil || headingParts(line) != nil || isRule(line) || isQuote(line) || isPipeRow(line)
    }

    // ── Code block ──────────────────────────────────────────────────────────

    private static func codeBlock(_ lines: [String], _ index: inout Int, fence: (character: Character, language: String)) -> MDBlock {
        let closing = String(repeating: String(fence.character), count: 3)
        var body: [String] = []
        index += 1
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).hasPrefix(closing) {
                index += 1
                break
            }
            body.append(line)
            index += 1
        }
        while body.last.map(isBlank) == true { body.removeLast() }
        return .code(language: fence.language, text: body.joined(separator: "\n"))
    }

    // ── Quote ───────────────────────────────────────────────────────────────

    private static func quoteBlock(_ lines: [String], _ index: inout Int) -> MDBlock {
        var inner: [String] = []
        while index < lines.count {
            let line = lines[index]
            if isQuote(line) {
                var rest = String(line.trimmingCharacters(in: .whitespaces).dropFirst())
                if rest.hasPrefix(" ") { rest = String(rest.dropFirst()) }
                inner.append(rest)
                index += 1
                continue
            }
            // Loose continuation: a line directly under the quote still belongs to it.
            if !isBlank(line), !isBlockStart(line), marker(line) == nil, !inner.isEmpty {
                inner.append(line.trimmingCharacters(in: .whitespaces))
                index += 1
                continue
            }
            break
        }
        return .quote(blocks: parse(lines: inner))
    }

    // ── Table ───────────────────────────────────────────────────────────────

    private static func isPipeRow(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("|") && trimmed.hasSuffix("|") && trimmed.count >= 2
    }

    private static func cells(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed = String(trimmed.dropFirst()) }
        if trimmed.hasSuffix("|"), !trimmed.hasSuffix("\\|") { trimmed = String(trimmed.dropLast()) }
        // Escaped pipes ("\|") must not split the cell.
        return trimmed
            .replacingOccurrences(of: "\\|", with: "\u{0001}")
            .components(separatedBy: "|")
            .map { $0.replacingOccurrences(of: "\u{0001}", with: "|").trimmingCharacters(in: .whitespaces) }
    }

    /// Separator row of a table → alignment per column, otherwise nil.
    private static func alignmentRow(_ line: String) -> [MDAlign]? {
        guard line.contains("|") || line.contains("-") else { return nil }
        let parts = cells(line)
        guard !parts.isEmpty else { return nil }
        var alignments: [MDAlign] = []
        for part in parts {
            let body = part.trimmingCharacters(in: .whitespaces)
            guard body.count >= 1 else { return nil }
            let left = body.hasPrefix(":")
            let right = body.hasSuffix(":")
            let dashes = body.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            alignments.append(left && right ? .center : right ? .trailing : .leading)
        }
        return alignments
    }

    private static func tableBlock(_ lines: [String], _ index: inout Int) -> MDBlock? {
        let line = lines[index]
        guard line.contains("|") else { return nil }

        // With a separator row: the first row is the header row (valid also without edge pipes).
        if index + 1 < lines.count, let alignments = alignmentRow(lines[index + 1]) {
            let header = cells(line)
            var rows: [[String]] = []
            var cursor = index + 2
            while cursor < lines.count, lines[cursor].contains("|"), !isBlank(lines[cursor]) {
                rows.append(cells(lines[cursor]))
                cursor += 1
            }
            index = cursor
            return .table(header: header, rows: rows, alignments: alignments)
        }

        // Without a separator row only real pipe rows, otherwise every sentence with a "|" would be a table.
        guard isPipeRow(line) else { return nil }
        var rows: [[String]] = []
        var cursor = index
        while cursor < lines.count, isPipeRow(lines[cursor]) {
            rows.append(cells(lines[cursor]))
            cursor += 1
        }
        index = cursor
        return .table(header: nil, rows: rows, alignments: [])
    }

    // ── Lists ───────────────────────────────────────────────────────────────

    private struct Marker {
        let indent: Int
        let ordered: Bool
        let number: Int
        let contentIndent: Int
        let content: String
    }

    private static func marker(_ line: String) -> Marker? {
        let characters = Array(line)
        var cursor = 0
        while cursor < characters.count, characters[cursor] == " " { cursor += 1 }
        let indent = cursor
        guard cursor < characters.count else { return nil }

        func content(from position: Int) -> (Int, String) {
            var start = position
            while start < characters.count, characters[start] == " " { start += 1 }
            return (start, start < characters.count ? String(characters[start...]) : "")
        }

        let symbol = characters[cursor]
        if symbol == "-" || symbol == "*" || symbol == "+" {
            guard !isRule(line) else { return nil }
            guard cursor + 1 < characters.count, characters[cursor + 1] == " " else { return nil }
            let (start, text) = content(from: cursor + 1)
            return Marker(indent: indent, ordered: false, number: 0, contentIndent: start, content: text)
        }

        var digits = ""
        var position = cursor
        while position < characters.count, characters[position].isNumber, digits.count < 9 {
            digits.append(characters[position])
            position += 1
        }
        guard !digits.isEmpty, position < characters.count,
              characters[position] == "." || characters[position] == ")" else { return nil }
        guard position + 1 < characters.count, characters[position + 1] == " " else { return nil }
        let (start, text) = content(from: position + 1)
        return Marker(indent: indent, ordered: true, number: Int(digits) ?? 1, contentIndent: start, content: text)
    }

    /// `[ ] task` / `[x] task` at the item start → state and remaining text.
    private static func taskBox(_ text: String) -> (Bool, String)? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 3, trimmed.hasPrefix("[") else { return nil }
        let inner = trimmed[trimmed.index(trimmed.startIndex, offsetBy: 1)]
        guard trimmed[trimmed.index(trimmed.startIndex, offsetBy: 2)] == "]" else { return nil }
        let rest = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        switch inner {
        case " ": return (false, rest)
        case "x", "X": return (true, rest)
        default: return nil
        }
    }

    private static func listBlock(_ lines: [String], _ index: inout Int) -> MDBlock {
        guard let first = marker(lines[index]) else {
            let paragraph = MDBlock.paragraph(text: lines[index])
            index += 1
            return paragraph
        }
        let ordered = first.ordered
        let baseIndent = first.indent
        var items: [MDItem] = []

        while index < lines.count {
            let line = lines[index]

            if isBlank(line) {
                var lookahead = index + 1
                while lookahead < lines.count, isBlank(lines[lookahead]) { lookahead += 1 }
                guard lookahead < lines.count else { break }
                let next = lines[lookahead]
                let continuesList = (marker(next)?.indent ?? Int.max) <= baseIndent + 1
                    || indentOf(next) > baseIndent
                guard continuesList else { break }
                index = lookahead
                continue
            }

            guard let current = marker(line), current.indent <= baseIndent + 1, current.ordered == ordered else { break }

            var body = [current.content]
            index += 1
            while index < lines.count {
                let next = lines[index]
                if isBlank(next) {
                    var lookahead = index + 1
                    while lookahead < lines.count, isBlank(lines[lookahead]) { lookahead += 1 }
                    guard lookahead < lines.count, indentOf(lines[lookahead]) >= current.contentIndent else { break }
                    body.append("")
                    index = lookahead
                    continue
                }
                // The next item of the same level ends this one.
                if let following = marker(next), following.indent <= baseIndent + 1 { break }
                if indentOf(next) >= current.contentIndent || marker(next) != nil {
                    body.append(dedent(next, by: current.contentIndent))
                    index += 1
                    continue
                }
                // Loose continuation: a non-indented following line without a block start of its own.
                if !isBlockStart(next) {
                    body.append(next.trimmingCharacters(in: .whitespaces))
                    index += 1
                    continue
                }
                break
            }

            var checked: Bool?
            if let box = taskBox(body.first ?? "") {
                checked = box.0
                body[0] = box.1
            }
            while body.last.map(isBlank) == true { body.removeLast() }
            items.append(MDItem(checked: checked, blocks: parse(lines: body)))
        }

        return .list(ordered: ordered, start: ordered ? max(1, first.number) : 1, items: items)
    }

    // ── Paragraph ───────────────────────────────────────────────────────────

    private static func paragraphBlock(_ lines: [String], _ index: inout Int) -> MDBlock {
        var body = [lines[index]]
        index += 1
        while index < lines.count {
            let line = lines[index]
            if isBlank(line) || isBlockStart(line) || marker(line) != nil { break }
            if index + 1 < lines.count, alignmentRow(lines[index]) != nil { break }
            body.append(line)
            index += 1
        }
        return .paragraph(text: body.joined(separator: "\n"))
    }
}

// ── Rendering ───────────────────────────────────────────────────────────────

extension Text {
    /// Inline markup (bold, italic, code, links, strikethrough) via Foundation. `inlineOnlyPreservingWhitespace`, because the full
    /// block parser drops the paragraph boundaries and so "read." + "The" stick together.
    init(markdown source: String) {
        // `Text` cannot draw images — show them as a link with a caption.
        let prepared = source.replacingOccurrences(
            of: "!\\[([^\\]]*)\\]\\(",
            with: "[$1](",
            options: .regularExpression
        )
        if let attributed = try? AttributedString(
            markdown: prepared,
            options: .init(
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) {
            // KNOWN EDGE CASE: a paragraph with a code span can lose its last line as "…" — SwiftUI's Text MEASURES the wrap at a word
            // boundary more optimistically than it DRAWS it (mono metric; measured 42 instead of 64 pt in the width of the iPhone 17
            // cell). Not curable via attributes: an explicit font attribute on the code run and even removing the intent do NOT change
            // the reported height. Documented in `testWideErrorResultsKeepCellFrameTight`.
            self.init(attributed)
        } else {
            self.init(source)
        }
    }
}

struct MarkdownView: View {
    let source: String
    var spacing: CGFloat = 8

    var body: some View {
        MarkdownBlocksView(blocks: parsed, spacing: spacing)
            .chatSelectable()
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var parsed: [MDBlock] {
        #if DEBUG
        if PerfProbe.isOn {
            return PerfProbe.shared.measure("md.parse") { MarkdownParser.parse(source) }
        }
        #endif
        return MarkdownParser.parse(source)
    }
}

struct MarkdownBlocksView: View {
    let blocks: [MDBlock]
    var spacing: CGFloat = 8

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block, spacing: spacing)
            }
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MDBlock
    var spacing: CGFloat

    var body: some View {
        switch block {
        // `fixedSize(vertical:)` on both text blocks: in a self-sizing cell (UIHostingConfiguration) the height proposal for rendering
        // can lie minimally below the measurement — a multi-line text then swallows its last line. With a fixed ideal height it
        // renders completely regardless of the proposal.
        // Headings and paragraphs are markable in the chat history (long press, see `ChatHighlightableText`) — outside it the same view
        // renders the plain SwiftUI `Text` with `fixedSize` unchanged.
        case let .heading(level, text):
            ChatHighlightableText(
                source: text,
                fontSize: headingSize(level),
                fontWeight: level <= 2 ? .bold : .semibold
            )
            .frame(maxWidth: .infinity, alignment: .leading)

        case let .paragraph(text):
            ChatHighlightableText(source: text)
                .frame(maxWidth: .infinity, alignment: .leading)

        case let .code(language, text):
            MarkdownCodeBlock(language: language, text: text)

        case let .list(ordered, start, items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        MarkdownBullet(ordered: ordered, number: start + offset, checked: item.checked)
                        MarkdownBlocksView(blocks: item.blocks, spacing: 4)
                    }
                }
            }

        case let .quote(blocks):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.accentColor.opacity(0.55))
                    .frame(width: 3)
                MarkdownBlocksView(blocks: blocks, spacing: 6)
                    .foregroundStyle(.secondary)
                    // For the marker text in the quote: it cannot inherit `foregroundStyle`.
                    .environment(\.chatMarkdownSecondaryText, true)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .table(header, rows, alignments):
            MarkdownTable(header: header, rows: rows, alignments: alignments)

        case .rule:
            Divider()
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return 22
        case 2: return 19
        case 3: return 17
        default: return 16
        }
    }
}

private struct MarkdownBullet: View {
    let ordered: Bool
    let number: Int
    let checked: Bool?

    var body: some View {
        if let checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .chatFont(.fixed(13))
                .foregroundStyle(checked ? Color.accentColor : Color.secondary)
                .accessibilityLabel(checked ? L("done") : L("open"))
        } else if ordered {
            // The number keeps its OWN font (`.system(.body, design: .default).monospacedDigit()`) and does not inherit the container's.
            //
            // That the number in the cards (info row, channel) stands 2 pt larger than its own paragraph is a cosmetic flaw LEFT ON PURPOSE
            // here. To fix it, swap `.body` for the environment's base size (`chatMarkdownBaseSize`) — at 17 that is the same font as
            // today, in the cards the paragraph's. That is a change to the look, not to the scaling, and belongs in a step of its own.
            Text(verbatim: "\(number).")
                .chatFont(.body, design: .default, monospacedDigit: true)
                .foregroundStyle(.secondary)
        } else {
            // The bullet carries no font of its own — it inherits the paragraph's beside it and grows with it.
            Text(verbatim: "•")
                .foregroundStyle(.secondary)
        }
    }
}

private struct MarkdownCodeBlock: View {
    let language: String
    let text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Header: language on the left, copy button on the right. It ALWAYS stands — also without a language, otherwise the button
            // would have no room and lie over the code.
            HStack(spacing: 8) {
                Text(language)
                    .chatFont(.fixed(10), weight: .semibold)
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                // Deliberately a plain button: a `contextMenu` would inherit the mirroring of the history cells (see the head of
                // ChatComponents.swift).
                Button {
                    UIPasteboard.general.string = text
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    copied = true
                    Task {
                        try? await Task.sleep(for: .milliseconds(1200))
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        // The glyph grows with the language mark beside it. Unlike the message bar (`MessageActionsBar`, which deliberately
                        // stays fixed) this is not a standalone button band but the second half of ONE header: mark left and glyph right
                        // stand in the same HStack on the same baseline, and a growing mark beside a fixed glyph is exactly the inconsistency
                        // the table header one level down had. The frame (24 × 20) stays: the text size changes font sizes, not spacings or
                        // hit areas.
                        .chatFont(.fixed(11), weight: .semibold)
                        .foregroundStyle(copied ? Color.accentColor : Color.secondary)
                        .frame(width: 24, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("code-copy")
                .accessibilityLabel(L("Copy code"))
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            ScrollView(.horizontal) {
                Text(text)
                    .chatFont(.caption, design: .monospaced)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
            }
            // See the result box in `ToolCallView` (ChatComponents): horizontal ScrollViews in history rows need the vertical ideal
            // height, otherwise the cell measures wrong.
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.cbElevated, in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct MarkdownTable: View {
    let header: [String]?
    let rows: [[String]]
    let alignments: [MDAlign]

    private var columnCount: Int {
        max(header?.count ?? 0, rows.map(\.count).max() ?? 0)
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 6) {
                if let header {
                    GridRow {
                        ForEach(0..<columnCount, id: \.self) { column in
                            cell(header.indices.contains(column) ? header[column] : "", column: column, header: true)
                        }
                    }
                    Divider().gridCellColumns(max(1, columnCount))
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<columnCount, id: \.self) { column in
                            cell(row.indices.contains(column) ? row[column] : "", column: column)
                        }
                    }
                }
            }
            .padding(.vertical, 2)
        }
        // See `MarkdownCodeBlock` directly above.
        .fixedSize(horizontal: false, vertical: true)
    }

    /// EXACTLY ONE font setting per cell — hence in here, not at the caller: two settings both write `EnvironmentValues.font`, and
    /// which wins would be decided by the nesting instead of the intent (that is how the header once lost semibold and size).
    private func cell(_ text: String, column: Int, header: Bool = false) -> some View {
        let alignment = alignments.indices.contains(column) ? alignments[column] : .leading
        return Text(markdown: text)
            .modifier(MarkdownCellsFont(header: header))
            .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .gridColumnAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
    }
}

/// The one font decision of a table cell: the header carries its own markup, the data cell inherits the container's — like the
/// bullet.
private struct MarkdownCellsFont: ViewModifier {
    let header: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if header {
            content.chatFont(.callout, weight: .semibold)
        } else {
            content
        }
    }
}
