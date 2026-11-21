import SwiftUI
import UIKit

struct ArtifactBrowserSheet: View {
    @ObservedObject var model: ChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var importing = false
    @State private var textDraft = false
    /// Files that already exist in the chat. They wait here for the user's yes — the
    /// server never overwrites anything on its own.
    @State private var conflicts: [PendingArtifactUpload] = []
    /// Expanded folders of the tree (key as in `artifactTree`). Default: all closed —
    /// structure first, then content.
    @State private var openDirs: Set<String> = []

    var body: some View {
        NavigationStack {
            Group {
                // Outputs visible (Chat/ChatOutputs.swift): the chat's output location as the first row — always there, read-only.
                if model.artifacts.isEmpty {
                    CbList {
                        OutputsEntryPoint(model: model)
                        ContentUnavailableView(
                            L("No artifacts yet"),
                            systemImage: "doc.on.doc",
                            description: Text(L("Skills can store specifications, tickets, and other durable files for this chat here — or you upload files yourself."))
                        )
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                    .listStyle(.plain)
                } else {
                    // A file system instead of a list: folders become rows that fold open and
                    // shut. With more than a handful of files the structure would otherwise not be visible.
                    CbList {
                        OutputsEntryPoint(model: model)
                            .cbRows(.ground)
                        ArtifactNodeRows(
                            nodes: artifactTree(model.artifacts),
                            depth: 0,
                            open: $openDirs
                        ) { artifact in
                            ArtifactDetailView(model: model, fileId: artifact.id, fallback: artifact)
                        }
                        // The app's only PLAIN list: its rows span the full width and should form no
                        // bands — dark on the ground, light like the system white (the inner
                        // row ground beats the `surface` of `CbList`).
                        .cbRows(.ground)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle(L("Artifacts"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "chat-artifacts-close") { dismiss() }
                // Two ways into the same file store: a file from the device or a text
                // typed/pasted in here.
                ToolbarItem(placement: .topBarTrailing) {
                    if !model.artifactUploading {
                        Button {
                            textDraft = true
                        } label: {
                            Label(L("Paste text as an artifact"), systemImage: "text.badge.plus")
                        }
                        .disabled(model.isDraft)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.artifactUploading {
                        ProgressView()
                    } else {
                        Button {
                            importing = true
                        } label: {
                            Label(L("Upload"), systemImage: "square.and.arrow.up")
                        }
                        .disabled(model.isDraft)
                    }
                }
            }
            .sheet(isPresented: $textDraft) { ArtifactTextDraftSheet(model: model).cbSheet(.whole) }
            // Put files by hand into THIS chat's artifacts — the same target the skills
            // otherwise fill.
            .fileImporter(
                isPresented: $importing,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                guard case .success(let urls) = result, !urls.isEmpty else { return }
                // The content is read IMMEDIATELY: the picker's security grant only holds
                // here, a later question ("overwrite?") would reach the file too late.
                var picked: [PendingArtifactUpload] = []
                for url in urls {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else {
                        model.error = L("\"{name}\" could not be read.", ["name": url.lastPathComponent])
                        continue
                    }
                    picked.append(PendingArtifactUpload(name: url.lastPathComponent, data: data))
                }
                guard !picked.isEmpty else { return }
                Task { conflicts = await model.uploadArtifacts(picked) }
            }
            .alert(L("Overwrite files?"), isPresented: Binding(get: { !conflicts.isEmpty }, set: { if !$0 { conflicts = [] } })) {
                Button(L("Cancel"), role: .cancel) { conflicts = [] }
                Button(L("Overwrite"), role: .destructive) {
                    let pending = conflicts
                    conflicts = []
                    Task { await model.uploadArtifacts(pending, overwrite: true) }
                }
            } message: {
                Text(L("These files already exist in this chat: {names}", ["names": conflicts.map(\.name).joined(separator: ", ")]))
            }
        }
        .task { await model.loadArtifacts() }
    }
}

/// Title of a text → file name of the artifact. Artifacts have no title field of their own; their
/// path IS their name. Without an extension (one starting with a letter) `.md` is appended —
/// "Note 12.8" gets `.md`, "spec.json" stays as typed. Must match the web version
/// (`artifactNameFromTitle` in web/src/components/chat/ChatCatalog.tsx).
private func artifactFileName(fromTitle title: String) -> String {
    let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let dot = clean.lastIndex(of: "."), dot != clean.startIndex else { return "\(clean).md" }
    let ext = clean[clean.index(after: dot)...]
    let looksLikeExtension = (1...8).contains(ext.count)
        && ext.first?.isLetter == true
        && ext.allSatisfy { $0.isLetter || $0.isNumber }
    return looksLikeExtension ? clean : "\(clean).md"
}

/// Store a text as an artifact: the title becomes the file name, the text the content. Goes through
/// the same chain as a file upload (`uploadArtifacts`) — so the same conflict question and the
/// same reload of the list apply.
private struct ArtifactTextDraftSheet: View {
    @ObservedObject var model: ChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var text = ""
    @State private var conflict = false

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var fileName: String { artifactFileName(fromTitle: title) }
    private var canSave: Bool {
        !trimmedTitle.isEmpty
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.artifactUploading
    }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField(L("Title, e.g. meeting notes"), text: $title)
                } header: {
                    Text(L("Title"))
                } footer: {
                    Text(trimmedTitle.isEmpty
                         ? L("No title, no file name")
                         : L("Saved as \"{name}\"", ["name": fileName]))
                }
                Section(L("Content")) {
                    TextEditor(text: $text)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(minHeight: 200)
                }
            }
            .navigationTitle(L("Text as an artifact"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "chat-artifact-text-close") { dismiss() }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.artifactUploading {
                        ProgressView()
                    } else {
                        Button(L("Save")) { save() }
                            .disabled(!canSave)
                    }
                }
            }
            .alert(L("Overwrite file?"), isPresented: $conflict) {
                Button(L("Cancel"), role: .cancel) { }
                Button(L("Overwrite"), role: .destructive) { save(overwrite: true) }
            } message: {
                Text(L("\"{name}\" already exists in this chat.", ["name": fileName]))
            }
        }
    }

    private func save(overwrite: Bool = false) {
        let pending = PendingArtifactUpload(name: fileName, data: Data(text.utf8))
        Task {
            // A NEW error (too large, network gone) must not throw away the typed text —
            // the sheet then stays open, the chat below shows the message.
            let errorBefore = model.error
            let conflicts = await model.uploadArtifacts([pending], overwrite: overwrite)
            if !conflicts.isEmpty { conflict = true; return }
            if model.error == errorBefore { dismiss() }
        }
    }
}

// Not `private`: the tree rows in ChatFolderViews.swift link here.
struct ArtifactDetailView: View {
    @ObservedObject var model: ChatViewModel
    /// The file is held by its IDENTITY, not as a snapshot: if the agent rewrites it while the
    /// preview is open, it appears with a new sha256 in `model.artifacts` — and only that fires
    /// `.task(id:)` again. With a snapshot the old content would stay. The id is origin + path:
    /// in the chat folder two chats can carry the same path, a comparison on `path` alone would
    /// hit the wrong file.
    let fileId: String
    /// State on opening — carries the view if the file has been deleted meanwhile.
    let fallback: ChatArtifact
    private var artifact: ChatArtifact { model.artifacts.first { $0.id == fileId } ?? fallback }
    @State private var content: ChatArtifactContent?
    @State private var image: UIImage?
    @State private var downloadedFile: URL?
    @State private var loading = true
    @State private var error = ""
    /// The editing state — here and not in the text body, because the button, back and sheet lock
    /// read it (see `ArtifactDraft` in ChatFolderViews.swift).
    @StateObject private var draft = ArtifactDraft()

    /// Only the chat's OWN artifact is written — those of the neighbour chats of the same folder
    /// are deliberately read-only, and the server rejects them anyway. Otherwise `ArtifactTextBody`
    /// shows plain text instead of an editor.
    private var writable: Bool { artifact.own != false }
    private var editable: Bool { writable && draft.loaded }

    /// Save by hand. The saved state comes from the response (the model inserts it in place into
    /// its list) — no reload that would replace the editor.
    private func save() async -> Bool {
        let file = artifact
        return await draft.save { text, sha in
            let saved = try await model.saveArtifact(file, text: text, expectedSha256: sha)
            content = .saved(saved, text: text)
            return saved.sha256
        }
    }

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .padding()
                }
            } else if let content, content.encoding == "utf8" {
                // No separate edit sheet: the same view, just touchable.
                ScrollView {
                    ArtifactTextBody(content: content, draft: draft, editable: writable)
                }
            } else {
                ContentUnavailableView(
                    L("No preview"),
                    systemImage: artifact.mime == "application/pdf" ? "doc.richtext" : "doc",
                    description: Text(error.isEmpty ? L("This file can be downloaded and shared.") : error)
                )
            }
        }
        .navigationTitle(artifact.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let downloadedFile {
                    ShareLink(item: downloadedFile) {
                        Label(L("Split"), systemImage: "square.and.arrow.up")
                    }
                } else {
                    Button {
                        Task { await prepareDownload() }
                    } label: {
                        Label(L("Download"), systemImage: "arrow.down.circle")
                    }
                }
            }
            if editable {
                ToolbarItem(placement: .topBarTrailing) {
                    ArtifactSaveButton(draft: draft, save: save)
                }
            }
        }
        .modifier(ArtifactEditing(draft: draft, active: editable, name: artifact.name, save: save))
        .task(id: artifact.sha256) { await loadPreview() }
    }

    /// Loads the preview — on opening with a spinner, afterwards (new sha256 in `model.artifacts`:
    /// the agent wrote, or the own save) in place: `loading` would otherwise be the reason the
    /// editor yielded and was rebuilt. A content that is already the current one (the own save
    /// inserted it) is not even fetched.
    private func loadPreview() async {
        if let content, content.sha256 == artifact.sha256 { return }
        if content == nil && image == nil { loading = true }
        error = ""
        do {
            if artifact.mime.hasPrefix("image/") {
                image = UIImage(data: try await model.artifactImageData(artifact))
            } else if artifact.isText {
                let fresh = try await model.artifactContent(artifact)
                content = fresh
                draft.takeOver(fresh)
            }
        } catch {
            // Superseded by a newer fetch (the sha256 changed again) — the newer one counts.
            if Task.isCancelled { return }
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func prepareDownload() async {
        do {
            downloadedFile = try await model.downloadArtifact(artifact)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
