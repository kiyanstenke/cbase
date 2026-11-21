import SwiftUI
import UIKit

// View of ONE chat folder on the iPhone, the same thing as on the desktop but stacked: first the
// CONTEXT (what the user puts in), then the ARTIFACTS (what the chats produced).
//
// Why two kinds with nearly the same technique? They play different roles. Context is input
// (briefings, specs, minutes, sample data): the human uploads it, every chat of the folder may
// READ it, no agent may change it. Artifacts are output: each belongs to one chat, which also
// writes it. The separate names keep the difference visible in the UI and in the agent's toolset
// (cbase_folder_context_read vs. cbase_artifacts_write).

@MainActor
final class FolderContentViewModel: ObservableObject {
    @Published var context: [ChatArtifact] = []
    @Published var artifacts: [ChatArtifact] = []
    @Published var loading = true
    @Published var uploading = false
    @Published var error = ""
    /// Files that already exist in the folder. They wait here for the user's yes; the server
    /// never overwrites anything on its own.
    @Published var conflicts: [PendingArtifactUpload] = []

    let client: APIClient
    let folder: ChatFolder

    init(client: APIClient, folder: ChatFolder) {
        self.client = client
        self.folder = folder
    }

    func load() async {
        loading = true
        async let contextResponse: [ChatArtifact]? = try? await client.get("/api/chat-folders/\(folder.id)/context")
        async let artifactsResponse: [ChatArtifact]? = try? await client.get("/api/chat-folders/\(folder.id)/artifacts")
        context = (await contextResponse) ?? []
        artifacts = (await artifactsResponse) ?? []
        loading = false
    }

    /// Upload context. Existing paths are NOT silently overwritten but reported in `conflicts`;
    /// the view asks and calls again with `overwrite: true`.
    func upload(_ files: [PendingArtifactUpload], overwrite: Bool = false) async {
        guard !files.isEmpty else { return }
        uploading = true
        var pending: [PendingArtifactUpload] = []
        for file in files {
            do {
                _ = try await client.uploadFolderContext(
                    folderId: folder.id, path: file.name, data: file.data, overwrite: overwrite
                )
            } catch let failure as APIError where failure.status == 409 && !overwrite {
                pending.append(file)
            } catch {
                self.error = error.localizedDescription
            }
        }
        uploading = false
        conflicts = pending
        await load()
    }

    func deleteContext(_ file: ChatArtifact) async {
        do {
            let _: OKResponse = try await client.delete(
                "/api/chat-folders/\(folder.id)/context/file",
                query: [
                    URLQueryItem(name: "path", value: file.path),
                    URLQueryItem(name: "expectedSha256", value: file.sha256),
                ]
            )
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // ── Reading and downloading ───────────────────────────────────────────────
    // Context and artifact live on different routes: context on the FOLDER, an artifact on ITS
    // chat. So every file in the view carries its kind (`FolderFile`).
    func content(_ file: FolderFile) async throws -> ChatArtifactContent {
        try await client.get(readPath(file), query: [
            URLQueryItem(name: "path", value: file.artifact.path),
            URLQueryItem(name: "maxBytes", value: "1048576"),
        ])
    }

    func imageData(_ file: FolderFile) async throws -> Data {
        try await client.data(downloadPath(file), query: [
            URLQueryItem(name: "path", value: file.artifact.path),
            URLQueryItem(name: "inline", value: "1"),
        ])
    }

    func download(_ file: FolderFile) async throws -> URL {
        try await client.downloadToTemporaryFile(
            downloadPath(file),
            query: [URLQueryItem(name: "path", value: file.artifact.path)],
            fallbackName: file.artifact.name
        )
    }

    /// Edit a file of the folder view BY HAND. It is written through the same route it is read
    /// from (context on the FOLDER, an artifact on ITS chat), so the rule "an artifact is written
    /// only by its own chat" still holds; the human just stands in for the agent.
    ///
    /// Afterwards the list is NOT reloaded; the one row is patched in place: `load()` replaced
    /// both lists and the open preview rebuilt its editor, losing cursor, scroll position and undo.
    func save(_ file: FolderFile, text: String, expectedSha256: String) async throws -> ChatArtifact {
        let saved: ChatArtifact = try await client.put(
            readPath(file),
            body: ArtifactWrite(path: file.artifact.path, content: text, expectedSha256: expectedSha256)
        )
        switch file.kind {
        case .context:
            if let index = context.firstIndex(where: { $0.id == file.artifact.id }) {
                context[index] = context[index].afterTheSave(saved)
            }
        case .artifact:
            if let index = artifacts.firstIndex(where: { $0.id == file.artifact.id }) {
                artifacts[index] = artifacts[index].afterTheSave(saved)
            }
        }
        return saved
    }

    /// The current state of a file in the view: after a save or reload the list carries the new
    /// sha256, the copy inside `FolderFile` does not.
    func current(_ file: FolderFile) -> ChatArtifact {
        (file.kind == .context ? context : artifacts).first { $0.id == file.artifact.id } ?? file.artifact
    }

    private func readPath(_ file: FolderFile) -> String {
        file.kind == .context
            ? "/api/chat-folders/\(folder.id)/context/file"
            : "/api/chats/\(file.artifact.chatId ?? "")/artifacts/file"
    }

    private func downloadPath(_ file: FolderFile) -> String {
        file.kind == .context
            ? "/api/chat-folders/\(folder.id)/context/download"
            : "/api/chats/\(file.artifact.chatId ?? "")/artifacts/download"
    }
}

/// A file of the folder view with its kind, which decides the route.
struct FolderFile: Identifiable, Hashable {
    enum Kind { case context, artifact }
    let kind: Kind
    let artifact: ChatArtifact
    var id: String { "\(kind == .context ? "ctx" : "kind"):\(artifact.id)" }
}

/// The folder view itself. A sheet over the chat list so it is reachable from the overview AND
/// from the left drawer without leaving the navigation behind it.
struct FolderContentSheet: View {
    @StateObject private var model: FolderContentViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var importing = false
    @State private var deleting: ChatArtifact?
    /// Expanded folders per tree, kept apart because "briefing.md" can be context on the left and
    /// an artifact on the right, and the keys would otherwise collide.
    @State private var contextOpen: Set<String> = []
    @State private var artifactsOpen: Set<String> = []
    /// Folder whose chat nodes were already expanded once (only once, otherwise every refresh
    /// would re-expand what the user collapsed by hand).
    @State private var primed = ""

    init(client: APIClient, folder: ChatFolder) {
        _model = StateObject(wrappedValue: FolderContentViewModel(client: client, folder: folder))
    }

    var body: some View {
        NavigationStack {
            CbList {
                Section {
                    if model.loading && model.context.isEmpty {
                        ProgressView()
                    } else if model.context.isEmpty {
                        Text(L("No context yet. Upload briefings, specifications or sample data — every chat in this folder can then read them."))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ArtifactNodeRows(
                            nodes: artifactTree(model.context),
                            depth: 0,
                            open: $contextOpen,
                            swipeDelete: { deleting = $0 }
                        ) { artifact in
                            FolderFileDetailView(model: model, file: FolderFile(kind: .context, artifact: artifact))
                        }
                    }
                } header: {
                    Text(L("Folder context"))
                } footer: {
                    Text(L("Every chat in this folder may read this — read-only."))
                }

                if model.artifacts.isEmpty {
                    Section(L("Artifacts of the chats")) {
                        if model.loading {
                            ProgressView()
                        } else {
                            Text(L("No artifacts in this folder yet."))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    // A file tree instead of one section per chat: the folder's artifacts each
                    // belong to one chat (`own == false`); the tree makes that the top level and
                    // folds the real directories below it. Showing the full path on every row
                    // hid the structure once there were more than a handful of files.
                    Section(L("Artifacts of the chats")) {
                        ArtifactNodeRows(
                            nodes: artifactTree(model.artifacts),
                            depth: 0,
                            open: $artifactsOpen
                        ) { artifact in
                            FolderFileDetailView(model: model, file: FolderFile(kind: .artifact, artifact: artifact))
                        }
                    }
                }
            }
            .navigationTitle(model.folder.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose { dismiss() }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.uploading {
                        ProgressView()
                    } else {
                        Button {
                            importing = true
                        } label: {
                            Label(L("Upload context files"), systemImage: "square.and.arrow.up")
                        }
                        .accessibilityIdentifier("folder-context-upload")
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if !model.error.isEmpty {
                    InlineError(message: model.error)
                        .padding()
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result, !urls.isEmpty else { return }
                // The content is read IMMEDIATELY: the security grant of the selection only holds
                // here; a later question ("overwrite?") would reach the file too late.
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
                Task { await model.upload(picked) }
            }
            .alert(
                L("Overwrite files?"),
                isPresented: Binding(get: { !model.conflicts.isEmpty }, set: { if !$0 { model.conflicts = [] } })
            ) {
                Button(L("Cancel"), role: .cancel) { model.conflicts = [] }
                Button(L("Overwrite"), role: .destructive) {
                    let pending = model.conflicts
                    model.conflicts = []
                    Task { await model.upload(pending, overwrite: true) }
                }
            } message: {
                Text(L("These files already exist in this folder: {names}", ["names": model.conflicts.map(\.name).joined(separator: ", ")]))
            }
            .confirmationDialog(
                deleting.map { L("Delete \"{name}\" from the folder context?", ["name": $0.path]) } ?? "",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible
            ) {
                Button(L("Delete"), role: .destructive) {
                    if let file = deleting { Task { await model.deleteContext(file) } }
                    deleting = nil
                }
                Button(L("Cancel"), role: .cancel) { deleting = nil }
            }
            .task {
                await model.load()
                if primed != model.folder.id, !model.artifacts.isEmpty {
                    primed = model.folder.id
                    artifactsOpen = Set(artifactChatKeys(artifactTree(model.artifacts)))
                }
            }
            .cbRefreshable { await model.load() }
        }
    }
}

/// Preview of a file of the folder view. Deliberately standalone instead of reusing
/// `ArtifactDetailView`, which is tied to a CHAT model (it re-reads the file from
/// `model.artifacts` when the agent overwrites it); there is no running chat here.
struct FolderFileDetailView: View {
    @ObservedObject var model: FolderContentViewModel
    let file: FolderFile
    @State private var content: ChatArtifactContent?
    @State private var image: UIImage?
    @State private var downloadedFile: URL?
    @State private var loading = true
    @State private var error = ""
    /// The edit state lives here and not in the text body because the button, back and sheet lock
    /// read it (see `ArtifactDraft` in ChatFolderViews.swift).
    @StateObject private var draft = ArtifactDraft()

    /// The state from the model's list, not the copy taken when the view opened.
    private var currentFile: ChatArtifact { model.current(file) }

    /// Save by hand. The saved state comes from the response; no reload, which would replace the
    /// editor.
    private func save() async -> Bool {
        await draft.save { text, sha in
            let saved = try await model.save(file, text: text, expectedSha256: sha)
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
                    ArtifactTextBody(content: content, draft: draft, editable: true)
                }
            } else {
                ContentUnavailableView(
                    L("No preview"),
                    systemImage: file.artifact.mime == "application/pdf" ? "doc.richtext" : "doc",
                    description: Text(error.isEmpty ? L("This file can be downloaded and shared.") : error)
                )
            }
        }
        .navigationTitle(file.artifact.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let downloadedFile {
                    ShareLink(item: downloadedFile) {
                        Label(L("Split"), systemImage: "square.and.arrow.up")
                    }
                } else {
                    Button {
                        Task {
                            do { downloadedFile = try await model.download(file) }
                            catch { self.error = error.localizedDescription }
                        }
                    } label: {
                        Label(L("Download"), systemImage: "arrow.down.circle")
                    }
                }
            }
            if draft.loaded {
                ToolbarItem(placement: .topBarTrailing) {
                    ArtifactSaveButton(draft: draft, save: save)
                }
            }
        }
        .modifier(ArtifactEditing(draft: draft, active: draft.loaded, name: file.artifact.name, save: save))
        // Opens with a spinner, afterwards in place: `loading` made the editor vanish and
        // re-form. Content that is already current (one's own save) is not fetched again.
        .task(id: currentFile.sha256) {
            if let content, content.sha256 == currentFile.sha256 { return }
            if content == nil && image == nil { loading = true }
            error = ""
            do {
                if file.artifact.mime.hasPrefix("image/") {
                    image = UIImage(data: try await model.imageData(file))
                } else if file.artifact.isText {
                    let fresh = try await model.content(file)
                    content = fresh
                    draft.takeOver(fresh)
                }
            } catch {
                if Task.isCancelled { return }
                self.error = error.localizedDescription
            }
            loading = false
        }
    }
}
