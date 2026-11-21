// The quotes in the composer island ("Reply" at the text marker) — modelled on ChatGPT's input
// field, in the form of the island (HIG, semantic system colors, no fixed values):
//   - the card: per quote "1.", muted "Selected text:", below it the quote in text color (at most
//     three lines), on the right a pencil (edit sheet) and a trash can;
//   - below it the marker "1 annotation" with a speech bubble and a round × for all — it expands
//     and collapses the card.
// Both sit INSIDE the island above the input row, like the waiting attachments (a stack ABOVE the
// island belongs to the docked strips). A new quote expands the card. The list itself is held by
// `ChatViewModel.quotes`; it goes out with `send` (`ChatViewModel+Quotes.swift`) via `ChatComposer`.
import SwiftUI

struct QuoteAnnotations: View {
    @ObservedObject var model: ChatViewModel
    /// Prefix of the accessibility identifiers (in the coding chat "chat").
    let prefix: String
    @State private var open = true
    @State private var editing: QuoteEditing?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if open {
                card
            }
            marker
        }
        .padding(.horizontal, 10)
        .onChange(of: model.quotes.count) { old, fresh in
            if fresh > old { open = true }
        }
        .sheet(item: $editing) { job in
            QuoteEditSheet(text: job.text) { fresh in
                model.replaceQuote(at: job.id, through: fresh)
            }
            .cbSheet(.half)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(model.quotes.enumerated()), id: \.offset) { index, quote in
                if index > 0 {
                    Divider().padding(.leading, 38)
                }
                row(index: index, quote: quote)
            }
        }
        // In the composer island: translucent on glass (`CbGlass.innen`).
        .background(CbGlass.inside, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        // `children: .contain`: an identifier on the container would otherwise replace those of the buttons inside it.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(prefix)-quote-card")
    }

    private func row(index: Int, quote: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(index + 1).")
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 16, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(L("Selected text:"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(quote)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("\(prefix)-quote-\(index)")
            }
            HStack(spacing: 2) {
                Button {
                    editing = QuoteEditing(id: index, text: quote)
                } label: {
                    Image(systemName: "pencil")
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(L("Edit annotation"))
                .accessibilityIdentifier("\(prefix)-quote-edit-\(index)")
                Button {
                    model.removeQuote(at: index)
                } label: {
                    Image(systemName: "trash")
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(L("Remove annotation"))
                .accessibilityIdentifier("\(prefix)-quote-remove-\(index)")
            }
            .buttonStyle(.plain)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.top, -6)
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 10)
    }

    private var marker: some View {
        let n = model.quotes.count
        return HStack(spacing: 4) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "text.bubble")
                    Text(n == 1 ? L("1 annotation") : L("{n} annotations", ["n": n]))
                }
                .padding(.leading, 11)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("\(prefix)-quote-marker")
            Button {
                model.clearQuotes()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 7)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("Remove all annotations"))
            .accessibilityIdentifier("\(prefix)-quotes-clear")
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(.primary)
        .background(.cbElevated, in: Capsule())
    }
}

/// Which quote the sheet edits — its position in the list and the text when opened.
struct QuoteEditing: Identifiable {
    let id: Int
    let text: String
}

/// "Edit annotation": the quote in a sheet with a multi-line field. "Done" applies (empty means remove),
/// "Cancel" leaves it as it was.
private struct QuoteEditSheet: View {
    @State var text: String
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Bool

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .focused($focus)
                .padding(.horizontal, 12)
                .accessibilityIdentifier("quote-edit-field")
                .navigationTitle(L("Edit annotation"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    SheetClose(label: L("Cancel")) { dismiss() }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(L("Done")) {
                            save(text)
                            dismiss()
                        }
                        .accessibilityIdentifier("quote-edit-finished")
                    }
                }
                .onAppear { focus = true }
        }
    }
}
