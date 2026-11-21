import SwiftUI
import UniformTypeIdentifiers

// Create a new project in server mode: counterpart of
// `web/src/components/projects/ProjectCreate.tsx`. Name (starts empty), sources (a folder from "Files", single files, ZIP, a git
// repository via `Code/ProjectClone.swift`) and the layout as its own page. "Create" is disabled without a name, with layout errors
// and while reading. After the POST `ProjectUploads` (Code/ProjectUpload.swift) uploads the sources; the project row shows progress.
//
// Without server mode the old dialog `CreateProjectSheet` (name only, the server creates the folder) remains.

struct ProjectCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let workspaceId: String
    let rules: LayoutRules
    /// From the "Upload folder" / "Upload ZIP" menu: the picker opens immediately.
    var withFolder = false
    var withZip = false
    /// From the "Clone git repository" menu: the clone sheet opens immediately.
    var withClone = false
    let onCreated: (_ projectId: String, _ uploads: [SourceUpload]) async -> Void

    private struct Entry: Identifiable { let seq: Int; let q: SelectedSource; var id: Int { seq } }
    private enum Choice { case folder, files, zip }

    @State private var name = ""
    @State private var sources: [Entry] = []
    @State private var steps: [LayoutStep] = []
    @State private var selection = ProjectLayout.SelectionTree(node: [], upload: [:], hints: [], omitted: 0)
    @State private var next = 1
    @State private var choice: Choice = .folder
    @State private var select = false
    @State private var read = false
    @State private var busy = false
    @State private var error = ""
    @State private var started = false
    @State private var memory = LayoutPlanMemory()
    @State private var cloneOpen = false

    private var plan: LayoutPlan { memory.plan(selection.node, steps, rules, .creation) }

    var body: some View {
        let plan = self.plan
        let locked = name.trimmingCharacters(in: .whitespaces).isEmpty || !plan.error.isEmpty || busy || read
        NavigationStack {
            CbForm {
                Section {
                    TextField(L("Project name"), text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("project-create-name")
                } header: {
                    Text(L("Name"))
                } footer: {
                    Text(L("The project gets its own container right away. Folders, files, archives and repositories end up exactly as the outline shows."))
                }
                Section {
                    if sources.isEmpty && !read {
                        Text(L("No source — the project starts empty."))
                            .cbFont(14)
                            .foregroundStyle(CbColor.textMuted)
                    }
                    ForEach(sources) { e in
                        sourceRow(e)
                            .swipeActions {
                                Button(L("Remove"), role: .destructive) { remove(e.seq) }
                            }
                    }
                    if read {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(L("Reading…")).cbFont(14).foregroundStyle(CbColor.textSecondary)
                        }
                    }
                    Menu {
                        Button { open(.folder) } label: { Label(L("Folder…"), systemImage: "folder") }
                        Button { open(.files) } label: { Label(L("Files…"), systemImage: "doc") }
                        Button { open(.zip) } label: { Label(L("ZIP archive…"), systemImage: "doc.zipper") }
                        Button { cloneOpen = true } label: { Label(L("Git repository…"), systemImage: "arrow.triangle.branch") }
                            .accessibilityIdentifier("project-source-clone")
                    } label: {
                        Label(L("Add source"), systemImage: "plus")
                    }
                    .disabled(read || busy)
                    .accessibilityIdentifier("project-source-new")
                } header: {
                    Text(L("Sources"))
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if selection.omitted > 0 {
                            Text(L("{n} files are left out (dependencies, build output, .DS_Store).", ["n": selection.omitted]))
                        }
                        ForEach(Array(selection.hints.prefix(5).enumerated()), id: \.offset) { _, h in
                            Text(ProjectLayoutPage.noticeText(h))
                        }
                        if sources.contains(where: { $0.q.clone == nil }) {
                            Text(L("After creating, the app uploads the files — please keep it in the foreground until the row shows “ready”. An interrupted upload can be resumed."))
                        }
                    }
                }
                Section {
                    NavigationLink {
                        ProjectLayoutPage(rootName: name.trimmingCharacters(in: .whitespaces), tree: selection.node, steps: $steps, rules: rules, mode: .creation,
                                               sourceMarker: { k in
                                                   guard let q = sources.first(where: { $0.seq == k.source })?.q, q.zip != nil,
                                                         k.origin == q.name.precomposedStringWithCanonicalMapping else { return nil }
                                                   return "ZIP"
                                               })
                    } label: {
                        HStack {
                            Label(L("Outline"), systemImage: "list.bullet.indent")
                            Spacer(minLength: 8)
                            if !plan.error.isEmpty {
                                Text(L("{n} errors", ["n": plan.error.count])).foregroundStyle(.red)
                            } else if !steps.isEmpty {
                                Text(L("Changes ({n})", ["n": steps.count])).foregroundStyle(CbColor.textSecondary)
                            } else if !plan.codeRepos.isEmpty || !plan.repos.isEmpty {
                                let n = Set(plan.codeRepos + plan.repos).count
                                Text(n == 1 ? L("1 code repo") : L("{n} code repos", ["n": n])).foregroundStyle(CbColor.textSecondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("project-create-layout")
                } footer: {
                    if !plan.error.isEmpty {
                        Text(L("The outline has errors — fix them first, then create.")).foregroundStyle(.red)
                    }
                }
                if !error.isEmpty {
                    InlineError(message: error)
                }
            }
            .navigationTitle(L("New project"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("Creating…") : L("Create")) { Task { await create() } }
                        .disabled(locked)
                        .accessibilityIdentifier("project-create")
                }
            }
            .fileImporter(
                isPresented: $select,
                allowedContentTypes: choice == .folder ? [.folder] : choice == .zip ? [.zip] : [.item],
                allowsMultipleSelection: choice == .files
            ) { result in
                guard case .success(let urls) = result, !urls.isEmpty else { return }
                Task { await read(urls, choice) }
            }
            .sheet(isPresented: $cloneOpen) {
                CloneSourceSheet(client: client, workspaceId: workspaceId) { a in
                    // The project name stays as it is (always typed in by the user).
                    sources.append(Entry(seq: next, q: SelectedSource(kind: "clone", name: a.name,
                                                                         clone: CloneSource(url: a.url, branch: a.branch.isEmpty ? nil : a.branch))))
                    next += 1
                    newCompute()
                }
                .cbSheet(.whole)
            }
            .task {
                guard withFolder || withZip || withClone, !started else { return }
                started = true
                if withClone { cloneOpen = true } else { open(withZip ? .zip : .folder) }
            }
        }
    }

    @ViewBuilder
    private func sourceRow(_ e: Entry) -> some View {
        if let k = e.q.clone {
            HStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(CbColor.textSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(e.q.name).cbFont(15).foregroundStyle(CbColor.text).lineLimit(1)
                    Text(k.branch.map { k.url + " · " + L("branch {branch}", ["branch": $0]) } ?? k.url)
                        .cbFont(12.5).foregroundStyle(CbColor.textMuted).lineLimit(1).truncationMode(.middle)
                }
            }
        } else {
            fileSourceRow(e)
        }
    }

    private func fileSourceRow(_ e: Entry) -> some View {
        let up = selection.upload[String(e.seq)] ?? []
        let bytes = up.reduce(0) { $0 + $1.size }
        var under = L("{n} files · {size}", ["n": up.count, "size": sizeText(bytes)])
        if e.q.skippedFolder > 0 { under += " · " + L("{n} folders skipped", ["n": e.q.skippedFolder]) }
        if let z = e.q.zip { under += " · " + L("archive {size}", ["size": sizeText(z.size)]) }
        return HStack(spacing: 10) {
            Image(systemName: e.q.zip != nil ? "doc.zipper" : e.q.kind == "folder" ? "folder" : "doc.on.doc").foregroundStyle(CbColor.textSecondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(e.q.zip?.fileName ?? (e.q.kind == "folder" ? e.q.name : L("Files")))
                    .cbFont(15)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(1)
                Text(under).cbFont(12.5).foregroundStyle(CbColor.textMuted)
            }
        }
    }

    private func open(_ w: Choice) {
        error = ""
        choice = w
        select = true
    }

    private func read(_ urls: [URL], _ w: Choice) async {
        read = true
        defer { read = false }
        let rules = self.rules
        let result: Result<SelectedSource, Error> = await Task.detached(priority: .userInitiated) {
            switch w {
            case .folder: return .success(ProjectRead.readFolder(urls[0], rules))
            case .files: return .success(ProjectRead.readFiles(urls))
            case .zip: return Result { try ProjectRead.readZip(urls[0]) }
            }
        }.value
        let q: SelectedSource
        switch result {
        case .success(let x): q = x
        case .failure(let e): error = e.localizedDescription; return
        }
        if q.files.isEmpty && q.kind == "files" { return }
        sources.append(Entry(seq: next, q: q))
        next += 1
        newCompute()
    }

    private func remove(_ seq: Int) {
        sources.removeAll { $0.seq == seq }
        // Changes refer to paths; without the source they would no longer fit.
        steps = []
        newCompute()
    }

    private func newCompute() {
        let list = sources.map { (seq: $0.seq, q: $0.q) }
        selection = ProjectLayout.treeFromSelection(ProjectRead.selection(list), rules, ProjectRead.gitFiles(list))
    }

    private func create() async {
        let plan = self.plan
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty, plan.error.isEmpty, !busy, !read else { return }
        struct Response: Decodable { let id: String }
        busy = true
        error = ""
        let list = sources.map { (seq: $0.seq, q: $0.q) }
        do {
            let (body, uploads) = try ProjectCreationComputation.body(name: name, sources: list, tree: selection, plan: plan)
            let p: Response = try await client.post("/api/workspaces/\(workspaceId)/projects", body: body)
            for u in uploads {
                let q = list.first(where: { $0.seq == u.source })?.q
                // ZIP: name, size and modification time are remembered (resume checks it is the same archive); the server knows the mapping.
                if let z = q?.zip { ProjectCreationComputation.remember(p.id, u.seq, kind: "zip", name: z.fileName, [], size: z.size, changed: z.changed) }
                else { ProjectCreationComputation.remember(p.id, u.seq, kind: q?.kind ?? u.kind, name: q?.name ?? "", plan.mapping[String(u.source)] ?? []) }
            }
            await onCreated(p.id, uploads)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            busy = false
        }
    }
}
