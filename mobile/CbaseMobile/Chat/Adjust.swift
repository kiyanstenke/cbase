import SwiftUI
import UIKit

// ── Adjust: rephrase the selected text according to an instruction ────────────────────────
//
// One action on the text instead of a rule per tool: set the text marker (long press, as in the
// timeline) → "Adjust" in the marker menu → the "Instructions for adjusting" sheet (a new
// instruction or a remembered one, each with an editable title) → the "adjust" app agent
// (Settings → Models) rephrases → the result lands on the clipboard. What gets sent is still
// decided by the card.
//
// The run does NOT belong to the sheet: it closes on tap, and the floating toast at the bottom
// centre (`AdjustToast`, at the app root) shows "running" → "finished" → gone. `AdjustCenter`
// is the small hub both places share.

struct AdjustPrompt: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var prompt: String
    var used: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        title = c.str(.title)
        prompt = c.str(.prompt)
        used = (try? c.decodeIfPresent(Double.self, forKey: .used)) ?? 0
    }
    enum CodingKeys: String, CodingKey { case id, title, prompt, used }
}

struct AdjustPromptsResponse: Decodable, Sendable {
    var items: [AdjustPrompt]
}

struct AdjustBody: Encodable, Sendable {
    var text: String
    var prompt: String?
    var promptId: String?
    var title: String?
}

struct AdjustResult: Decodable, Sendable {
    var fresh: String
    var model: String
    var promptId: String
    var title: String
}

struct AdjustPatch: Encodable, Sendable {
    var title: String?
    var prompt: String?
}

struct AdjustDeletion: Decodable, Sendable {
    var ok: Bool
    var items: [AdjustPrompt]
}

/// What the marker menu opens: the marked text.
struct AdjustRequest: Identifiable {
    let id = UUID()
    let text: String
}

/// The one running adjust job and its result, shared between sheet and toast.
@MainActor
final class AdjustCenter: ObservableObject {
    static let shared = AdjustCenter()

    enum State: Equatable {
        case running
        case finished(fresh: String)
        case error(String)
    }

    @Published var state: State?
    private var wakeup: Task<Void, Never>?

    func start(text: String, client: APIClient, prompt: String? = nil, promptId: String? = nil, title: String? = nil) {
        wakeup?.cancel()
        state = .running
        Task { [weak self] in
            do {
                let r: AdjustResult = try await client.post(
                    "/api/adjust",
                    body: AdjustBody(text: text, prompt: prompt, promptId: promptId, title: title),
                    timeout: 120
                )
                UIPasteboard.general.string = r.fresh
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                self?.show(.finished(fresh: r.fresh))
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                self?.show(.error(error.localizedDescription))
            }
        }
    }

    private func show(_ z: State) {
        state = z
        wakeup?.cancel()
        // "Finished" disappears on its own — the text is on the clipboard. An error stays until
        // someone has read it.
        guard case .finished = z else { return }
        wakeup = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard !Task.isCancelled, let self, case .finished = self.state else { return }
            self.state = nil
        }
    }

    func close() {
        wakeup?.cancel()
        state = nil
    }
}

// ── The floating toast at the bottom centre ───────────────────────────────────────────────
struct AdjustToast: View {
    @ObservedObject private var center = AdjustCenter.shared

    var body: some View {
        ZStack {
            if let z = center.state {
                content(z)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.cbSurface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(CbColor.edge))
                    .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
                    .frame(maxWidth: 420)
                    .onTapGesture { center.close() }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("adjust-toast")
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.35), value: center.state)
    }

    @ViewBuilder
    private func content(_ z: AdjustCenter.State) -> some View {
        switch z {
        case .running:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text(L("Adjusting text …"))
                    .cbFont(14, weight: .medium)
                    .accessibilityIdentifier("adjust-toast-running")
            }
        case .finished(let fresh):
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    Text(L("Adjusted — on the clipboard"))
                        .cbFont(14, weight: .medium)
                        .foregroundStyle(.green)
                        .accessibilityIdentifier("adjust-toast-finished")
                }
                Text(fresh)
                    .cbFont(13)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("adjust-toast-new")
            }
        case .error(let text):
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(L("Adjusting failed: {error}", ["error": text]))
                    .cbFont(13)
                    .lineLimit(3)
                    .accessibilityIdentifier("adjust-toast-error")
            }
        }
    }
}

// ── The sheet: new instruction or a remembered one ───────────────────────────────────────
struct AdjustSheet: View {
    let text: String
    let client: APIClient
    @Environment(\.dismiss) private var dismiss
    @State private var instruction = ""
    @State private var title = ""
    @State private var items: [AdjustPrompt] = []
    @State private var loading = true
    @State private var error = ""
    @State private var edit: AdjustPrompt?

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    Text(text)
                        .cbFont(13)
                        .lineLimit(8)
                        .accessibilityIdentifier("adjust-text")
                } header: {
                    Text(L("Selected text"))
                } footer: {
                    Text(L("The selected text is rephrased according to your instruction; the result is then on the clipboard."))
                }

                Section(L("New instruction")) {
                    ZStack(alignment: .topLeading) {
                        if instruction.isEmpty {
                            Text(L("How should the text sound? e.g. “Casual and short, the way I write in Teams — informal, no period at the end”"))
                                .cbFont(14)
                                .foregroundStyle(Color(.placeholderText))
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $instruction)
                            .cbFont(14)
                            .frame(minHeight: 88)
                            .accessibilityIdentifier("adjust-instruction")
                    }
                    TextField(L("Title to recognize it later (optional)"), text: $title)
                        .accessibilityIdentifier("adjust-title")
                    Button {
                        run(prompt: instruction)
                    } label: {
                        Label(L("Adjust"), systemImage: "wand.and.stars")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("adjust-go")
                    .listRowBackground(Color.clear)
                }

                Section(L("Recently used")) {
                    if loading {
                        ProgressView()
                    } else if items.isEmpty {
                        Text(L("No instruction remembered yet — the first one appears here after the first adjustment."))
                            .cbFont(13)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(items) { it in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(it.title)
                                .cbFont(14, weight: .medium)
                                .accessibilityIdentifier("adjust-entry-title-\(it.id)")
                            Text(it.prompt)
                                .cbFont(12.5)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                            HStack(spacing: 10) {
                                Button(L("Adjust with this")) { run(promptId: it.id) }
                                    .buttonStyle(.borderedProminent)
                                    .controlSize(.small)
                                    .accessibilityIdentifier("adjust-with-it-\(it.id)")
                                Button(L("Edit")) { edit = it }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    .accessibilityIdentifier("adjust-edit-\(it.id)")
                                Spacer(minLength: 0)
                            }
                        }
                        .padding(.vertical, 2)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { remove(it) } label: { Label(L("Remove"), systemImage: "trash") }
                        }
                    }
                }

                if !error.isEmpty {
                    Section { Text(error).foregroundStyle(.red).cbFont(13) }
                }
            }
            .navigationTitle(L("Instructions for adjusting"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "adjust-abort", label: L("Cancel")) { dismiss() }
            }
            .task { await load() }
            .sheet(item: $edit) { it in
                AdjustEditSheet(entry: it, client: client) { fresh in
                    items = items.map { $0.id == fresh.id ? fresh : $0 }
                }
                .cbSheet(.whole)
            }
        }
    }

    private func load() async {
        do {
            let r: AdjustPromptsResponse = try await client.get("/api/adjust/prompts", timeout: 20)
            items = r.items
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    /// Go: the sheet closes, the toast takes over. The server remembers the instruction.
    private func run(prompt: String? = nil, promptId: String? = nil) {
        let p = prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
        if promptId == nil, (p ?? "").isEmpty { return }
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        dismiss()
        AdjustCenter.shared.start(text: text, client: client, prompt: promptId == nil ? p : nil, promptId: promptId, title: t.isEmpty ? nil : t)
    }

    private func remove(_ it: AdjustPrompt) {
        Task {
            do {
                let r: AdjustDeletion = try await client.delete("/api/adjust/prompts/\(it.id)")
                items = r.items
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Change the title and instruction of a remembered instruction.
struct AdjustEditSheet: View {
    let entry: AdjustPrompt
    let client: APIClient
    let onSaved: (AdjustPrompt) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var prompt = ""
    @State private var error = ""
    @State private var saves = false

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("Title")) {
                    TextField(L("Title"), text: $title)
                        .accessibilityIdentifier("adjust-edit-title")
                }
                Section(L("Instruction")) {
                    TextEditor(text: $prompt)
                        .cbFont(14)
                        .frame(minHeight: 120)
                        .accessibilityIdentifier("adjust-edit-prompt")
                }
                if !error.isEmpty {
                    Section { Text(error).foregroundStyle(.red).cbFont(13) }
                }
            }
            .navigationTitle(L("Edit instruction"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Save")) { save() }
                        .disabled(saves || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("adjust-edit-save")
                }
            }
            .onAppear {
                title = entry.title
                prompt = entry.prompt
            }
        }
    }

    private func save() {
        saves = true
        Task {
            do {
                let r: AdjustPrompt = try await client.patch("/api/adjust/prompts/\(entry.id)", body: AdjustPatch(title: title, prompt: prompt))
                onSaved(r)
                dismiss()
            } catch {
                self.error = error.localizedDescription
                saves = false
            }
        }
    }
}
