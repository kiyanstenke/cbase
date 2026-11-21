import SwiftUI

// The bar that replaces the input in an archived chat. It is rendered EXCLUSIVELY from `ChatComposer` — as a variant inside
// the island. The island itself stays: `ChatComposerRoot` measures its height at the `keyboardLayoutGuide`, and swapping the
// whole island would be a second rebuild repeating the stage's keyboard bugs.
//
// It is also the undo of archiving: after "Archive" the chat stays open, with it.

struct ArchiveBar: View {
    /// Time of archiving in ms (nil = unknown, then without a date).
    let archivedAt: Double?
    let restore: () async throws -> Void
    @State private var running = false
    @State private var error: String?

    private var text: String {
        guard let archivedAt, archivedAt > 0 else { return L("Archived — read only") }
        let f = DateFormatter()
        f.locale = Loc.locale
        f.setLocalizedDateFormatFromTemplate("dd.MM.yyyy")
        return L("Archived on {date} — read only", ["date": f.string(from: locDate(fromServer: archivedAt))])
    }

    var body: some View {
        // The form of the hints (`CbHintSurface`): muted symbol and muted text on `elevated`, no edge of its own; the way back is
        // the palette's neutral primary button instead of an accent capsule.
        HStack(spacing: 10) {
            Image(systemName: "archivebox")
                .font(.symbol(15, weight: .medium))
                .foregroundStyle(CbColor.textMuted)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(CbColor.textMuted)
                .lineLimit(2)
                .accessibilityIdentifier("archive-bar-text")
            Spacer(minLength: 4)
            Button {
                running = true
                Task {
                    defer { running = false }
                    do { try await restore() } catch {
                        self.error = error.localizedDescription.isEmpty ? L("Restoring failed") : error.localizedDescription
                    }
                }
            } label: {
                Text(L("Restore"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(CbColor.primaryButtonText)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(CbColor.primaryButton.opacity(running ? 0.45 : 1), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(running)
            .accessibilityIdentifier("archive-bar-restore")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 50)
        // One step on the island (`CbColor.elevated` on `surface`).
        .background(CbColor.elevated, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .padding(.horizontal, 10)
        // `children: .contain` is mandatory: an identifier on the stack otherwise REPLACES the button's inside it.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("archive-bar")
        .alert(
            L("Restoring failed"),
            isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } }),
            presenting: error
        ) { _ in
            Button(L("OK"), role: .cancel) { error = nil }
        } message: { text in
            Text(text)
        }
    }
}
