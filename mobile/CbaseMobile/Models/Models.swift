import Foundation

struct GatewayUser: Codable, Hashable, Sendable {
    let username: String
    let role: String
}

/// The API range of a server (`api` in `GET /gw/info`, VERSIONING.md "API level"); the app's side is `ApiContract`.
struct GatewayApiLevel: Codable, Hashable, Sendable {
    let level: Int?
    let oldest: Int?
}

/// `GET /gw/info`. Everything from `build` on is optional: a server from before the version contract sends none of it
/// (the synthesized `Decodable` would otherwise require every key). `build` is "x.y.z+N.g<sha7>[.dirty]", or "unknown" when the
/// server has no build record; `version` alone then is the gateway's package version.
struct GatewayInfo: Codable, Sendable {
    let gateway: Bool
    let version: String?
    let setup: Bool
    let authenticated: Bool
    let user: GatewayUser?
    let build: String?
    let commit: String?
    let release: String?
    let api: GatewayApiLevel?
    let gatewayVersion: String?

    /// The outcome of the server's API range for this app (no `api` = an old server = level 1).
    var compatibility: ApiContract.Compatibility {
        ApiContract.compatibility(serverLevel: api?.level, serverOldest: api?.oldest)
    }
}

struct LoginResponse: Codable, Sendable {
    let user: GatewayUser
}

struct EnvironmentResponse: Codable, Sendable {
    let ready: Bool?
}

struct Project: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var path: String
    var createdAt: Double
    /// Open setup of a new project (server `projectbox/setup/status.js`); missing once it is finished.
    /// Display: `Code/ProjectUpload.swift` (`ProjectSetupDisplay`).
    var setup: ProjectSetup?
    /// The service detection (`{ status, since }`) as long as a state exists.
    var detection: ProjectDetection?
    /// Remotes of a code repo with credentials in the URL ("remote hint"); names only, never the value.
    var remoteHints: [ProjectRemoteHint]?
    /// In server operation the main instance (`projectbox/names.js` projectInstanceField); only its state is read here
    /// (uploading afterwards works only when `ready`).
    var instance: ProjectInstanceShort?
    /// Open retroactive uploads (server `setup/status.js` uploadView); missing if none is open.
    var uploads: [RetroactiveUpload]?
    /// The layout job (server `projectbox/layout/job.js` layoutRow) as long as it is not `finished`.
    /// Display: `Code/LayoutInventory.swift` (`LayoutDisplay`).
    var layout: ProjectLayoutRow?
    /// Old containers of renamed stacks that can still be removed (server `projectbox/setup/status.js`); missing at 0.
    /// Display: `Code/OldContainerRemove.swift` in the services field of the project sheet.
    var superseded: Int?
    /// The number of code repos; the "Git" sub-item of the project view only appears for `repos > 0`.
    /// `nil` = not read (older server, reading failed), NOT "none" (`ProjectView.hatGitRepos`).
    var repos: Int?

    init(id: String, name: String, path: String, createdAt: Double = 0) {
        self.id = id
        self.name = name
        self.path = path
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Project"
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        // `try?`: an unreadable setup state (newer server, new fields) must never make the project list unreadable.
        setup = (try? c.decodeIfPresent(ProjectSetup.self, forKey: .setup)) ?? nil
        detection = (try? c.decodeIfPresent(ProjectDetection.self, forKey: .detection)) ?? nil
        remoteHints = (try? c.decodeIfPresent([ProjectRemoteHint].self, forKey: .remoteHints)) ?? nil
        instance = (try? c.decodeIfPresent(ProjectInstanceShort.self, forKey: .instance)) ?? nil
        uploads = (try? c.decodeIfPresent([RetroactiveUpload].self, forKey: .uploads)) ?? nil
        layout = (try? c.decodeIfPresent(ProjectLayoutRow.self, forKey: .layout)) ?? nil
        superseded = (try? c.decodeIfPresent(Int.self, forKey: .superseded)) ?? nil
        repos = (try? c.decodeIfPresent(Int.self, forKey: .repos)) ?? nil
    }
}

struct ProjectInstanceShort: Codable, Hashable, Sendable {
    let state: String
    /// A project container exists; the layout only exists then.
    let converted: Bool?
    /// "<project>/main" (server `projectInstanceField`); the preview link of a converted project names its instance from it
    /// (`PreviewRules.target`). If missing (older server), nothing is guessed.
    let identifier: String?
    /// The live copies (`identifier` = "<project>/copy-<name>"), for a chat's instance choice in the composer and in the chat
    /// header (`InstancesTree.chatInstanceOptions`). If missing (older server), there is no choice.
    let copies: [ProjectCopyShort]?

    /// The field for the twin's calculation (Code/InstancesTree.swift).
    var treeField: InstancesTree.Field {
        InstancesTree.Field(identifier: identifier, state: state, converted: converted,
                           copies: copies?.map { InstancesTree.CopyRow(identifier: $0.identifier, state: $0.state, copyState: $0.copyState) })
    }
}

extension ProjectInstanceShort {
    /// By hand (in the extension, so the memberwise initializer stays): an unreadable `copies` (different shape) costs only the
    /// chats' instance choice, not `state`, `identifier` and `converted`, on which the preview link, layout and relocation
    /// depend. A synthesized decoder would drag the whole `instance` field down with a type error in `copies` (`Project.init`
    /// reads it with `try?`). The other fields as before: `state` required, `converted` and `identifier` optional.
    /// `copies` is lenient PER ENTRY like on the web (lib/instances-tree.ts chatInstanceOptions): an entry that is not an
    /// object drops out alone, a field with the wrong type is nil (`ProjectCopyShort`). The binding
    /// (web/test/instances-tree-binding.test.mjs) runs its cases through THIS decoder and `treeField`, not through its own.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(String.self, forKey: .state)
        converted = try c.decodeIfPresent(Bool.self, forKey: .converted)
        identifier = try c.decodeIfPresent(String.self, forKey: .identifier)
        copies = (try? c.decodeIfPresent([LenientEntry<ProjectCopyShort>].self, forKey: .copies)).map { $0.compactMap(\.value) }
    }
}

/// A list entry that never throws: readable ⇒ `value`, otherwise nil (also for `null`, a string, a number); the list stays.
struct LenientEntry<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// A copy in the field `instance.copies` of /api/workspaces and /api/projects. Every field is optional (a missing one does not
/// make the project unreadable), a field with the wrong type is nil (like on the web). `state` = that of the instance row,
/// `copyState` = that of the copy row in stack_copies ("" without a live row, nil from an older server).
struct ProjectCopyShort: Codable, Hashable, Sendable {
    let identifier: String?
    let state: String?
    let copyState: String?

    init(identifier: String?, state: String?, copyState: String? = nil) {
        self.identifier = identifier
        self.state = state
        self.copyState = copyState
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        identifier = (try? c.decodeIfPresent(String.self, forKey: .identifier)) ?? nil
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil
        copyState = (try? c.decodeIfPresent(String.self, forKey: .copyState)) ?? nil
    }
}

/// The row of a layout job (like `LayoutRow` in `web/src/lib/api/events.ts`). `state`: `waiting` · `running` · `error`;
/// `holders` (the holders) only counts in `waiting`.
struct ProjectLayoutRow: Codable, Hashable, Sendable {
    let state: String
    let turned: Bool?
    let backward: Bool?
    let step: String?
    let error: String?
    let holders: Int?
}

/// A retroactive operation (like `RetroactiveUpload` in `web/src/lib/api/events.ts`). `state` as text: `upload` · `place` ·
/// `unpack` (only an archive being placed) · `error`. `interrupted`: no process works on it.
struct RetroactiveUpload: Codable, Hashable, Sendable {
    let operation: String
    let kind: String
    let state: String
    let since: Double?
    let newFolders: [String]?
    let archiveId: String?
    let lastChunk: Double?
    let conflict: String?
    let interrupted: Bool?
    /// Archive in `upload` only: the announced size.
    let bytes: Int?
    /// Files in `upload` without an open chunk only: how many files are staged (`capped`: at least that many).
    let staged: Int?
    let capped: Bool?
    let code: String?
    let error: String?
    /// Only `error` with `code` CONFLICT.
    let existing: Int?
    let examples: [String]?
}

/// The setup of a new project as exposed outward (server `store/project-setup.js` setupView). States as text, not as an
/// enum: a new state from a newer server should not make the row unreadable but stay quiet.
struct ProjectSetup: Codable, Hashable, Sendable {
    struct Source: Codable, Hashable, Sendable {
        let seq: Int
        let kind: String
        let target: String
        let state: String
        /// ZIP only: file name and last announced size of the archive (identity when resuming).
        let name: String?
        let bytes: Int?
        let code: String?
        let error: String?
        let host: String?
        /// Clone only: the address without user info and the branch (missing = the repository's default).
        let url: String?
        let branch: String?
        /// Clone only: the repository itself is fetched (server `cloneFetched`); "Take over as is" then takes it without missing submodules/LFS.
        let fetched: Bool?
        /// START of the last chunk request (ms).
        let lastChunk: Double?
    }
    struct Conflict: Codable, Hashable, Sendable {
        let existing: Int
        let examples: [String]
    }
    let state: String
    let step: String
    let phase: String?
    let error: String?
    let code: String?
    let waiting: String?
    let conflict: Conflict?
    let sources: [Source]
}

struct ProjectRemoteHint: Codable, Hashable, Sendable {
    let repo: String
    let remote: String
}

struct ProjectDetection: Codable, Hashable, Sendable {
    let status: String
    let since: Double?
}

struct Workspace: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var path: String
    var createdAt: Double
    var projects: [Project]

    init(id: String, name: String, path: String, createdAt: Double = 0, projects: [Project] = []) {
        self.id = id
        self.name = name
        self.path = path
        self.createdAt = createdAt
        self.projects = projects
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Workspace"
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        projects = try c.decodeIfPresent([Project].self, forKey: .projects) ?? []
    }
}

struct Chat: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var workspaceId: String
    var projectId: String?
    /// Chat folder (a purely logical grouping of the chat list, not a file system folder).
    /// Chats in the same folder read each other's artifacts.
    var folderId: String?
    var title: String
    var model: String
    var permissionMode: String
    var effort: String
    /// Ultracode: a MODE next to the effort level, not a level. When on, the server sets the level to xhigh, clamped to the
    /// model (`effort` then carries that clamped level). Read optionally, since an older server without the field would
    /// otherwise make the view unreadable; missing means off.
    var ultracode: Bool
    var provider: String
    var browserMode: String
    var contextTokens: Int
    var goal: String
    /// Goal paused (server `goalPaused`): the goal stays but is not pursued. Set via `PATCH /api/chats/:id {goalPaused}`;
    /// every setting or clearing of `goal` lifts the pause on the server. Read optionally: an older server does not know the
    /// field, and missing means "active".
    var goalPaused: Bool = false
    var contextSummary: String
    var pinned: Bool
    /// Notification choice per kind: "on" | "off". If a kind is missing the global default applies; "Default" is the
    /// absence of an entry, not a third stored value.
    var notify: [String: String]
    /// Autocompact: nil = default (global level), 0 = off, otherwise the level in percent of the context window.
    /// nil is the absence of a value, not a state.
    var autocompact: Int?
    var autocompactMax: Int?
    var createdAt: Double
    var updatedAt: Double
    /// Archive: time of archiving in ms, nil = active. An archived chat is read-only; the composer shows the archive bar
    /// instead of the input. The state ALWAYS comes from this field, never from a marker of the view.
    var archivedAt: Double?
    /// The kind of the chat (server `kind`): `normal` is a coding chat; legacy kinds (`manager` and the chats of the removed
    /// app agents, stored as `konflikt`, `dienst`, `context`, `ingest`; read-only on the server) do NOT belong in the coding view.
    /// Read where an identifier without a list entry is opened by id (`SelectedChatHost.fetchPerId`). If the field is missing
    /// (older server) it is a coding chat, as the server itself defaults (`r.kind || "normal"`).
    var kind: String
    /// The provider BEHIND a router that delivered the last answer, and its context window ("" / 0 = unknown); only for the
    /// context bar (`Chat/ContextDisplay.swift`); calculations use the catalog number. Live via `harness/provider`; the
    /// server clears both when model or provider change. If the field is missing (older server), none is known.
    var upstreamProvider: String = ""
    var upstreamWindow: Int = 0
    /// The instance the chat works in (server `chats.instance`): nil = main (also when missing, since an older server only
    /// knows main), otherwise "copy-<name>". Set in the composer (draft, sent with creation) and in the chat header
    /// (`PATCH /api/chats/:id {instance}`).
    var instance: String? = nil
    /// The orchestrator, if this chat is the child chat of a graph run (server `parentChatId`; only `GET /api/chats/:id`
    /// carries it, hence `SelectedChatHost.fetchPerId`; child chats appear in no list). A child chat works pinned in the
    /// instance where its run began; the chat header offers it no instance choice (the server answers 409 INSTANCE_PINNED).
    /// If the field is missing, it is not a child chat.
    var parentChatId: String? = nil
    /// Why the chat is in the archive (server `archiveReason`): "user" | "auto", nil while it is active. Only the archive view
    /// reads it (label "archived automatically"). Read optionally: an older server does not know the field, and a missing
    /// field must not make the list unreadable.
    var archiveReason: String? = nil
    /// The scheduled job this chat carries (server `scheduled/chat-field.js`; only `GET /api/chats` delivers it): name, status
    /// and next occurrence for the clock in the chat list. Read OPTIONALLY: an older server does not know the field, a `null`
    /// means "no job", and an unreadable value must not drag the list down.
    var job: ChatJob? = nil

    init(
        id: String,
        workspaceId: String,
        projectId: String? = nil,
        folderId: String? = nil,
        title: String = "New chat",
        model: String = "",
        permissionMode: String = "",
        effort: String = "",
        ultracode: Bool = false,
        provider: String = "claude",
        browserMode: String = "",
        contextTokens: Int = 0,
        goal: String = "",
        contextSummary: String = "",
        pinned: Bool = false,
        notify: [String: String] = [:],
        autocompact: Int? = nil,
        autocompactMax: Int? = nil,
        createdAt: Double = 0,
        updatedAt: Double = 0,
        archivedAt: Double? = nil,
        kind: String = "normal"
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.folderId = folderId
        self.title = title
        self.model = model
        self.permissionMode = permissionMode
        self.effort = effort
        self.ultracode = ultracode
        self.provider = provider
        self.browserMode = browserMode
        self.contextTokens = contextTokens
        self.goal = goal
        self.contextSummary = contextSummary
        self.pinned = pinned
        self.notify = notify
        self.autocompact = autocompact
        self.autocompactMax = autocompactMax
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.archivedAt = archivedAt
        self.kind = kind
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId) ?? ""
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        folderId = try c.decodeIfPresent(String.self, forKey: .folderId)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "New chat"
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
        permissionMode = try c.decodeIfPresent(String.self, forKey: .permissionMode) ?? ""
        effort = try c.decodeIfPresent(String.self, forKey: .effort) ?? ""
        // If the field is missing (older server), the mode is off.
        ultracode = try c.decodeIfPresent(Bool.self, forKey: .ultracode) ?? false
        provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? "claude"
        browserMode = try c.decodeIfPresent(String.self, forKey: .browserMode) ?? ""
        contextTokens = try c.decodeIfPresent(Int.self, forKey: .contextTokens) ?? 0
        goal = try c.decodeIfPresent(String.self, forKey: .goal) ?? ""
        goalPaused = (try? c.decodeIfPresent(Bool.self, forKey: .goalPaused)) ?? false
        contextSummary = try c.decodeIfPresent(String.self, forKey: .contextSummary) ?? ""
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        notify = try c.decodeIfPresent([String: String].self, forKey: .notify) ?? [:]
        // decodeIfPresent reads JSON null as nil, which is exactly "default".
        autocompact = try c.decodeIfPresent(Int.self, forKey: .autocompact)
        autocompactMax = try c.decodeIfPresent(Int.self, forKey: .autocompactMax)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        // If the field is missing (older server) or null, the chat is active.
        archivedAt = c.dblOpt(.archivedAt)
        let rawKind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        kind = rawKind.isEmpty ? "normal" : rawKind
        upstreamProvider = (try? c.decodeIfPresent(String.self, forKey: .upstreamProvider)) ?? ""
        upstreamWindow = (try? c.decodeIfPresent(Int.self, forKey: .upstreamWindow)) ?? 0
        instance = (try? c.decodeIfPresent(String.self, forKey: .instance)) ?? nil
        parentChatId = (try? c.decodeIfPresent(String.self, forKey: .parentChatId)) ?? nil
        archiveReason = c.strOpt(.archiveReason)
        job = (try? c.decodeIfPresent(ChatJob.self, forKey: .job)) ?? nil
    }
}

/// Autocompact: the global level and the allowed levels; the server (autocompact.js) is the source of the list. 0 means off.
///
/// `maxTokens` is the absolute cap: compaction happens at the EARLIER of share and cap. Decoded by hand and tolerant: an older
/// server without the two fields must not make the settings unreadable.
struct AutocompactDoc: Decodable, Sendable {
    let percent: Int
    let stages: [Int]
    let maxTokens: Int
    let maxStages: [Int]
    enum CodingKeys: String, CodingKey { case percent, stages, maxTokens, maxStages }
    static let stagesDefault = [30, 40, 50, 60, 70, 80, 90]
    static let maxDefault = (1...20).map { $0 * 50_000 }
    init(percent: Int = 0, stages: [Int] = AutocompactDoc.stagesDefault,
         maxTokens: Int = 0, maxStages: [Int] = AutocompactDoc.maxDefault) {
        self.percent = percent; self.stages = stages; self.maxTokens = maxTokens; self.maxStages = maxStages
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        percent = try c.decodeIfPresent(Int.self, forKey: .percent) ?? 0
        let list = try c.decodeIfPresent([Int].self, forKey: .stages) ?? []
        stages = list.isEmpty ? AutocompactDoc.stagesDefault : list
        maxTokens = try c.decodeIfPresent(Int.self, forKey: .maxTokens) ?? 0
        let maxList = try c.decodeIfPresent([Int].self, forKey: .maxStages) ?? []
        maxStages = maxList.isEmpty ? AutocompactDoc.maxDefault : maxList
    }
}

/// A folder of the chat list. It belongs to a workspace and optionally to ONE project; only chats of the same scope may go
/// in. Nothing is created in the file system.
struct ChatFolder: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var workspaceId: String
    var projectId: String?
    var name: String
    var chatCount: Int
    var createdAt: Double
    var updatedAt: Double
    /// Archive: set = the folder is archived; nil = active.
    var archivedAt: Double?

    init(
        id: String,
        workspaceId: String = "",
        projectId: String? = nil,
        name: String = "",
        chatCount: Int = 0,
        createdAt: Double = 0,
        updatedAt: Double = 0,
        archivedAt: Double? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.name = name
        self.chatCount = chatCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.archivedAt = archivedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspaceId = c.str(.workspaceId)
        projectId = c.strOpt(.projectId)
        name = c.str(.name)
        chatCount = c.int(.chatCount)
        createdAt = c.dbl(.createdAt)
        updatedAt = c.dbl(.updatedAt)
        archivedAt = c.dblOpt(.archivedAt)
    }
}

struct Attachment: Codable, Identifiable, Hashable, Sendable {
    var id: String { file }
    let name: String
    let file: String
    let mime: String
    let size: Int
    /// Width and height of an image attachment in pixels. The server reads them from the file header on upload
    /// (png/jpeg/gif/webp); with them the tile's height is fixed BEFORE the image has loaded (`RemoteAttachmentImage`), so
    /// the chat does not end up scrolled to the wrong place. `nil` means "not known" (older attachment, other format); the
    /// old behavior then applies.
    var w: Int?
    var h: Int?

    /// Pasted text (see `PastedText`); shown as a card instead of a file row.
    var isPastedText: Bool { PastedText.matches(name: name) }

    /// Aspect ratio (width / height) from `w`/`h`, only if both are known and greater than 0.
    var aspectRatio: Double? {
        guard let w, let h, w > 0, h > 0 else { return nil }
        return Double(w) / Double(h)
    }
}

/// Large pastes do NOT land in the input field but as an attachment (as in Claude): the prompt stays readable, and the agent
/// reads the text from the file with the Read tool.
///
/// Such an attachment is recognised by its FILE NAME, the only field that travels with the attachment through server,
/// database and all clients. The web client uses the same spelling (`pastedFileName` in
/// web/src/components/chat/ChatBubbleRow.tsx), so a paste from the iPhone also appears as a card on the desktop.
enum PastedText {
    static let minChars = 1200
    static let minLines = 25
    static let previewChars = 420
    /// Larger attachments get no preview, only the badge.
    static let fetchMax = 512_000

    static func isLarge(_ text: String) -> Bool {
        text.count >= minChars || text.split(separator: "\n", omittingEmptySubsequences: false).count >= minLines
    }

    static func fileName() -> String {
        "pasted-text-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)).txt"
    }

    static func matches(name: String) -> Bool {
        let lower = name.lowercased()
        guard lower.hasPrefix("pasted-text"), lower.hasSuffix(".txt") else { return false }
        let middle = lower.dropFirst("pasted-text".count).dropLast(".txt".count)
        return middle.isEmpty || (middle.hasPrefix("-") && middle.dropFirst().allSatisfy { $0.isLetter || $0.isNumber })
    }

    static func preview(_ text: String) -> String {
        String(text.prefix(previewChars))
    }
}

/// A selected file on its way into the artifacts. It survives a question ("already exists, overwrite?") because the content
/// has already been read: the security grant of the file picker only holds inside the importer's callback.
struct PendingArtifactUpload: Identifiable, Hashable, Sendable {
    let id = UUID()
    let name: String
    let data: Data
}

/// Body of the write call on an artifact or context file (PUT .../file). `expectedSha256` is the state the editor had in front
/// of them: if someone else has written in the meantime, the server answers 409 instead of silently overwriting their work.
struct ArtifactWrite: Encodable, Sendable {
    let path: String
    let content: String
    let encoding: String
    let expectedSha256: String

    init(path: String, content: String, expectedSha256: String) {
        self.path = path
        self.content = content
        self.encoding = "utf8"
        self.expectedSha256 = expectedSha256
    }
}

struct ChatArtifact: Codable, Identifiable, Hashable, Sendable {
    /// Origin + path: in a chat FOLDER two chats can have the same path (both "plan.md"), so the path alone is no identity.
    var id: String { "\(chatId ?? ""):\(path)" }
    let path: String
    let name: String
    let mime: String
    let size: Int
    let createdAt: Double
    let modifiedAt: Double
    let sha256: String
    /// If the chat is in a chat folder, the artifacts of the sibling chats are in the list too: `own == false`, plus the
    /// origin. Foreign artifacts are READ-ONLY, and they are read through the own chat WITH the owner's `chatId`.
    let chatId: String?
    let chatTitle: String?
    let own: Bool?

    var isText: Bool {
        mime.hasPrefix("text/")
            || mime.contains("json")
            || mime.contains("yaml")
            || mime.contains("xml")
            || mime.contains("javascript")
            || mime.contains("typescript")
    }
}

struct ChatArtifactContent: Codable, Hashable, Sendable {
    let path: String
    let name: String
    let mime: String
    let size: Int
    let createdAt: Double
    let modifiedAt: Double
    let sha256: String
    let offset: Int
    let nextOffset: Int?
    let truncated: Bool
    let encoding: String
    let content: String
}

struct LogEntry: Codable, Hashable, Sendable {
    /// Row id from the database, monotonically increasing. It becomes the stable identity of the history row built from it
    /// (see TimelineItem.id).
    let id: Int
    let role: String
    let text: String
    let ts: Double
    let attachments: [Attachment]?
    /// Truncated in the window (server chats/log-window.js): the length of the untruncated `text`; fetch it in full via
    /// `GET …/log/row/<id>` (`ChatViewModel+Window.swift`, `resolveTruncation`). Missing = untruncated.
    let truncated: Int?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Older servers deliver no id; it then stays 0 and the identity falls back to the position in the history
        // (buildTimeline).
        id = c.int(.id)
        role = c.str(.role)
        text = c.str(.text)
        ts = c.dbl(.ts)
        attachments = c.list(.attachments, Attachment.self)
        truncated = try? c.decodeIfPresent(Int.self, forKey: .truncated)
    }

    enum CodingKeys: String, CodingKey { case id, role, text, ts, attachments, truncated }
}

/// Response of `GET /api/chats/:id/log/delta?since=<id>` (chats/routes.js): only the rows AFTER `since`, plus total count and
/// highest id. The client recounts: if the total does not add up, rows were deleted and it loads in full (the same check as
/// on the web, `chatCache.ts` `syncChatCache`). Used for the reconcile at the first `connected`
/// (`ChatViewModel+Reconcile.swift`). Missing fields are 0/empty; the reconcile then falls back to the full history.
struct LogDelta: Decodable, Sendable {
    let total: Int
    let lastId: Int
    let rows: [LogEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = c.int(.total)
        lastId = c.int(.lastId)
        rows = c.list(.rows, LogEntry.self)
    }

    enum CodingKeys: String, CodingKey { case total, lastId, rows }
}

struct ProviderModel: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let context: Int
    /// The reasoning levels THIS model supports: measured, not assumed (server: `efforts` per entry in `CODEX_MODELS` and
    /// `CLAUDE_MODELS`). Third-party providers do not send it at all; it is then `nil` and `EffortLevels` falls back to the five
    /// preset levels ("unknown"). An EMPTY list is something else: the model supports NO levels (Haiku 4.5), so no picker and
    /// no level. Decoding missing and empty to the same `[]` (as `c.strings` does) would lose exactly this distinction.
    /// Decoded optionally because a synthesized `Decodable` would require EVERY key; a missing `efforts` would otherwise make
    /// the whole provider list unreadable.
    let efforts: [String]?

    init(id: String, label: String, context: Int, efforts: [String]? = nil) {
        self.id = id
        self.label = label
        self.context = context
        self.efforts = efforts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        label = c.str(.label, c.str(.id))
        context = c.int(.context, 200_000)
        efforts = (try? c.decodeIfPresent([String].self, forKey: .efforts)) ?? nil
    }
}

struct Provider: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let connected: Bool
    let models: [ProviderModel]
    let authMethod: String?
    let defaultModel: String?
    /// The provider's default level; optional: if missing, a new chat's level stays empty and the server resolves it in the
    /// run (`effortRunning`).
    let defaultEffort: String?
    /// The provider's capabilities: the same type as on the provider card (`ProviderCaps`, Models/AccountModels.swift); what is
    /// read here is `caps.effort`: off ⇒ no effort picker, `/effort` says so (`EffortLevels.withoutSelection`). Optional: a
    /// server without `caps` stays readable; missing means "unknown", and the selection is offered as before.
    let caps: ProviderCaps?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        label = c.str(.label, c.str(.id))
        connected = c.bool(.connected)
        models = c.list(.models, ProviderModel.self)
        authMethod = c.strOpt(.authMethod)
        defaultModel = c.strOpt(.defaultModel)
        defaultEffort = c.strOpt(.defaultEffort)
        caps = (try? c.decodeIfPresent(ProviderCaps.self, forKey: .caps)) ?? nil
    }
}

struct ProvidersResponse: Codable, Sendable {
    let active: String
    let providers: [Provider]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.str(.active)
        providers = c.list(.providers, Provider.self)
    }
}

/// The reasoning levels of a model: ONE source for all effort pickers of the app (chat settings, new chat, workflow run)
/// and for `/effort`.
///
/// A hard-wired list of levels was wrong in one place, and live: `-c model_reasoning_effort=max` with `-m gpt-5.5` ends in an
/// HTTP 400 ("Unsupported value: 'max' is not supported with the 'gpt-5.5' model"), and the whole turn is lost before it
/// starts. The server measures the list per model and sends it as `efforts`.
///
/// There are FIVE levels: the sixth was named differently per provider and is gone from the ordering, the catalogs and all
/// pickers; a stored legacy value migrates to `max` when the server starts. Codex' `none`/`minimal` offers no choice.
///
/// Claude also carries `efforts` per model, and an EMPTY list means "no levels" (Haiku 4.5: no picker, no level; see
/// `noLevels`). If it is missing (third-party provider, a model outside the catalog), the five preset levels apply: cbase
/// knows nothing about foreign models, and an invented lock would be worse than none. Same rule as the clamp on the spawn
/// side (`codexEffortFallback` in codex.js, which computes like all four other `effortFallback` from workflows.js).
enum EffortLevels {
    /// The ORDER of the levels, and nothing else.
    ///
    /// It mirrors `EFFORT_LEVELS` from server/backend/electron/server/workflows.js, the only source for what "higher" means
    /// (low < medium < high < xhigh < max). It is repeated here because `fallback` needs an order and a model's supported list
    /// brings none: it is a set, in any written order. `preset` below is NOT an order but the fallback (identical in
    /// characters but with another meaning: "what a model without a measurement supports", bound to `CLAUDE_EFFORTS`). A
    /// second ordering list next to it is exactly how the clamps would drift apart again; hence
    /// `web/test/effort-ios.test.mjs` holds this one against the server's.
    static let stages = ["low", "medium", "high", "xhigh", "max"]

    /// The fallback.
    static let preset = ["low", "medium", "high", "xhigh", "max"]

    /// The label of a level. Identical characters in both languages, hence no `L(…)`;
    /// an unknown level appears as it came; nothing is guessed here.
    static func label(_ level: String) -> String {
        switch level {
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "X-High"
        case "max": return "Max"
        default: return level
        }
    }

    /// The levels this model supports.
    ///
    /// An EMPTY `model` is not a missing one but the choice "provider default": `defaultModel` from `/api/providers` is then
    /// run, and its levels apply. Falling back to the preset would offer the five preset levels in a new chat although the
    /// default model supports others (gpt-5.5 has no `max`), and the user would pick a level the provider rejects with HTTP
    /// 400. `defaultModel` is guaranteed to be in the same `models` list (`defaultModelFor` in the backend), so the detour
    /// always finds something.
    ///
    /// Without a match (no provider chosen, provider list not loaded yet, model outside the catalog) it stays with the
    /// preset: nothing is invented about the unknown.
    static func levels(_ providers: [Provider], provider: String, model: String) -> [String] {
        guard let provider = providers.first(where: { $0.id == provider }) else { return preset }
        let id = model.isEmpty ? (provider.defaultModel ?? "") : model
        guard let list = provider.models.first(where: { $0.id == id })?.efforts else { return preset }
        return list
    }

    /// Does the model support NO levels according to the catalog? True only for an explicitly empty list (Haiku 4.5); a missing
    /// `efforts` is "unknown". Then there is no picker, and `/effort` sets nothing. The same question as `effortNoLevels` on
    /// the web (web/src/lib/effort.ts), bound in web/test/effort-ios.test.mjs.
    static func noLevels(_ providers: [Provider], provider: String, model: String) -> Bool {
        guard let provider = providers.first(where: { $0.id == provider }) else { return false }
        let id = model.isEmpty ? (provider.defaultModel ?? "") : model
        guard let list = provider.models.first(where: { $0.id == id })?.efforts else { return false }
        return !list.contains { stages.contains($0.lowercased()) }
    }

    /// The provider a selection CALCULATES with: the set one, otherwise the globally active one (`active` from
    /// `/api/providers`). "Default (global)" on the workflow run is an empty provider, and so is an old chat without a stored
    /// provider; empty is not unknown. Calculating with "" would offer the five preset levels. Same rule as `effortProvider`
    /// on the web (web/src/lib/effort.ts).
    static func effectiveProvider(_ provider: String, active: String) -> String {
        provider.isEmpty ? active : provider
    }

    /// Why there is NO effort selection; "" means there is one. THE decision "picker yes/no" of the app, made once here:
    /// "provider" (the provider explicitly has `caps.effort` off), "model" (the model supports NO levels according to the
    /// catalog, see `noLevels`), otherwise "", also for a model outside the catalog and a provider without `caps` (unknown ⇒
    /// the preset levels). The provider is resolved as in `effectiveProvider`. Bound to `effortWithoutSelection` on the web
    /// (web/test/effort-ios.test.mjs).
    static func withoutSelection(_ providers: [Provider], provider: String, model: String, active: String = "") -> String {
        let id = effectiveProvider(provider, active: active)
        if providers.first(where: { $0.id == id })?.caps?.effort == false { return "provider" }
        return noLevels(providers, provider: id, model: model) ? "model" : ""
    }

    /// The answer of `/effort` without a selection: translated, one sentence per reason, identical to the web
    /// (`effortWithoutSelectionText`). The keys are literals in `L(…)`, otherwise loc-audit would not see them.
    static func withoutSelectionText(_ reason: String) -> String {
        reason == "provider"
            ? L("This provider has no thinking level — /effort sets nothing here.")
            : L("This model has no thinking levels — /effort sets nothing here.")
    }

    /// Which level ACTUALLY runs instead of the set one.
    ///
    /// The same calculation as the ONE clamp at spawn (`effortFallback` in server/backend/electron/server/workflows.js, called
    /// by all five connectors) and as on the web (`effortFallback` in web/src/lib/effort.ts):
    ///
    /// **The substitute is the highest supported level that is NOT ABOVE the requested one; if there is none below, it is
    /// the lowest supported one.**
    ///
    /// That it is never above the request is the REASON and not merely the form: one level more means more thinking tokens,
    /// and the user pays for them from their subscription limit. So it clamps DOWN, never up: whoever chose `xhigh` did not
    /// order `max`. Taking the LAST element of the supported list would, for a model with a GAP (gpt-5.5 had a level above
    /// the missing `max`), jump past the supported `xhigh` to a level ABOVE the request, while the four other clamps clamp down.
    ///
    /// Two cases return the input unchanged, both with reason: a model WITHOUT a catalog entry (the supported list is empty;
    /// its maximum is unknown, and guessing would be worse than passing through) and a supported level (nothing to clamp).
    /// Whatever is not in `stages` at all is NOT a level; the result is then "" as for "Auto": no flag, the run thinks with
    /// the provider's default.
    static func fallback(_ providers: [Provider], provider: String, model: String, set: String) -> String {
        let selected = set.trimmingCharacters(in: .whitespaces).lowercased()
        guard let wish = stages.firstIndex(of: selected) else { return "" }
        // Calculate over the RANKS, not the catalog's written order: `efforts` is a set, and nobody promised it is written
        // ascending.
        let supported = levels(providers, provider: provider, model: model)
            .compactMap { stages.firstIndex(of: $0.lowercased()) }
            .sorted()
        // Empty (no levels) ⇒ no level, like the server (`effortFallback`) and the web.
        guard !supported.isEmpty else { return "" }
        guard !supported.contains(wish) else { return selected }
        return stages[supported.last { $0 < wish } ?? supported[0]]
    }

    /// The level a NEW chat stores if nobody chose one: its provider's default level from `/api/providers`, clamped to the
    /// model (`fallback`; an empty model is the provider default). "" without a default (older server, list not loaded) or on
    /// a model without levels; the server then resolves the default in the run (`effortRunning`); the guard is there, not
    /// here. The same preselection as `effortSel` on the web (`chat/chatModelChoice.ts`).
    static func standard(_ providers: [Provider], provider: String, model: String) -> String {
        guard let level = providers.first(where: { $0.id == provider })?.defaultEffort, !level.isEmpty else { return "" }
        return fallback(providers, provider: provider, model: model, set: level)
    }

    /// The label of the empty entry on an INHERITING field: "Default · <level>" with exactly the level that then thinks
    /// (`standard`: the provider's default level, clamped to the model), without a known level just "Default". An empty
    /// provider calculates with the globally active one. Counterpart on the web: `effortStandardLabel`
    /// (web/src/lib/effort.ts), bound in web/test/effort-ios.test.mjs.
    ///
    /// Variant `asChat` ("the CHAT's level applies"): the run level of a workflow. Empty transfers nothing there: a manual
    /// start in an existing chat thinks with that chat's level, only a fresh run chat gets the default level:
    /// "As the chat · new: <level>" (without a level "As the chat"). Same calculation; web `effortStandardLabel(…, asChat)`.
    static func standardLabel(_ providers: [Provider], provider: String, model: String, active: String = "", asChat: Bool = false) -> String {
        let level = standard(providers, provider: effectiveProvider(provider, active: active), model: model)
        if asChat { return level.isEmpty ? L("As the chat") : L("As the chat · new: {level}", ["level": label(level)]) }
        return level.isEmpty ? L("Default") : L("Default · {level}", ["level": label(level)])
    }

    // ── Ultracode: a TOGGLE next to the level, not a level (independent of the level) ─────────────
    //
    // It is deliberately NOT in `stages`: as another entry of the order, `fallback` would clamp it to max. The chat carries it as
    // a field of its own (`Chat.ultracode`); the picker shows only the levels, the toggle sits next to it (`UltracodeToggle`,
    // Kit/EffortSelection.swift). Switching it on or off leaves the level alone. Like `ULTRACODE` on the web
    // (web/src/lib/effort.ts).

    /// The word with which `/effort ultracode` flips the toggle; not a level, never on the wire.
    static let ultracode = "ultracode"

    /// An entry of the picker. Only id and label: what happens to the level is stated IN the label and nowhere else; a second
    /// field next to it would be an intermediate layer that none of the four pickers reads.
    struct Entry: Identifiable, Hashable, Sendable {
        let id: String
        let label: String
    }

    /// The picker's selection WITHOUT the "Automatic" entry; each page labels that itself, the wordings differ.
    ///
    /// `current` is included even if the model does not carry the level: if it vanished, the picker would show a change the
    /// user never made. It is therefore MARKED, and the mark names the SUBSTITUTE rather than just the loss: the clamp does not
    /// drop the level but puts another one in its place. "Max · not supported" would be only half the truth, and the half
    /// that is no longer true (something does run; for gpt-5.5 it is X-High).
    ///
    /// The label deliberately names only the RESULT and not who rejects. On the web there are two wordings for that (the
    /// Claude CLI itself discards an unknown `--effort`, otherwise the model answers with 400), carried there by a tooltip. A
    /// picker entry on the iPhone has none, and "runs as X-High" is true in both cases.
    static func selection(_ providers: [Provider], provider: String, model: String, current: String) -> [Entry] {
        let supported = levels(providers, provider: provider, model: model)
        var entries = supported.map { Entry(id: $0, label: label($0)) }
        let selected = current.trimmingCharacters(in: .whitespaces)
        if !selected.isEmpty && !supported.contains(selected) {
            // An empty substitute means "no level at all" (something not in `stages`); no flag is sent and the provider's
            // default thinks. That is "Automatic" and not a level without a name: an empty label after the middle dot
            // would say nothing.
            let running = fallback(providers, provider: provider, model: model, set: selected)
            let asWhat = running.isEmpty ? L("Automatic") : label(running)
            entries.append(Entry(
                id: selected,
                label: "\(label(selected)) · \(L("runs as {fallback}", ["fallback": asWhat]))"
            ))
        }
        return entries
    }
}

struct QueuedMessage: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let text: String
    /// Only user messages can be controlled; event and channel entries stay put. Optional, so an older server without the
    /// field does not make the whole queue unreadable (a synthesized `Decodable` requires every NON-optional key).
    let controllable: Bool?
    /// The queued completion notice of a subagent: the strip shows name and state and no trash can
    /// (`CompletionNotice.queue`). Optional for the same reason as `controllable`.
    let systemNotice: Bool?
}

struct PermissionRequest: Identifiable, Hashable, Sendable {
    var id: String { requestId }
    let requestId: String
    let toolName: String
    let input: JSONValue
    let toolUseId: String?
    /// The server's suggestion for "do not ask again" (e.g. `Bash(git status:*)`).
    var suggestedRule: String = ""
}

struct RunSummary: Codable, Hashable, Sendable {
    var secs: Int
    var inTok: Int
    var outTok: Int
    var aborted: Bool?
    var compacted: Bool?
    /// The end of the run (server seconds or milliseconds, `locDate(fromServer:)`): from the history the `ts` of the meta row,
    /// live the time of `run_done`. Shown after the metrics row (like `endText` on the web).
    var at: Double?
}

enum TimelineRole: String, Hashable, Sendable {
    case user, assistant, divider, clear, info, goal, monitor, workflow, limit, ask, capture
    /// Channel message: a card from the conversation of two chats, role "channel".
    case channel
    /// Message from an agent (agent communication): the third kind under the role "user", a "Message from …" card instead of a
    /// user bubble (Chat/InboundAgentMessage.swift).
    case message
    /// Approval of a tool that carries an approval mark: the card with the call and its parameters, role "approval"; the ruling
    /// arrives as a row of its own, "approval_ruling".
    case approval
    /// Approval card of a dynamic workflow: role "workflow_approval", the ruling as a row of its own,
    /// "workflow_approval_ruling" (Chat/WorkflowApproval.swift). A role of its OWN, not that of the tool approval.
    case workflowApproval
}

/// A row in the history about the usage limit (parked, resumed, discarded), live via SSE and identical from the stored
/// history (role "limit").
struct LimitLine: Hashable, Sendable {
    // wait | resume | retry | cancel | off | credits | too-long | gave-up | model_switch
    // | gate | gate-free | gate-stale (| gate-off only in old histories). The meaning of the start kinds is documented at the
    // view (LimitEventView in ChatComponents.swift).
    var kind: String
    var group: String = ""
    var limitText: String = ""
    var reason: String = ""
    var text: String = ""
    var dueAt: Double = 0
    var attempts: Int = 0
    /// Only for kind "resume": woken before the reset because a newer measurement shows the credit gate as free (account
    /// switch); the heading then does not say "reset".
    var early: Bool = false

    init(json: JSONValue) {
        kind = json["kind"]?.stringValue ?? ""
        early = json["early"]?.boolValue ?? false
        group = json["group"]?.stringValue ?? ""
        limitText = json["limitText"]?.stringValue ?? ""
        reason = json["reason"]?.stringValue ?? ""
        text = json["text"]?.stringValue ?? ""
        dueAt = json["dueAt"]?.doubleValue ?? 0
        attempts = json["attempts"]?.intValue ?? 0
    }
}

// ── Question with a choice card (tool cbase_ask) ───────────────────────────────
// The agent asks a question and attaches its recommendations as options; the user answers with a tap instead of typing.
// Question and choice live in the history (role "ask"/"ask_answer"), so the card does not live in memory and survives every
// restart.
struct AskOption: Identifiable, Hashable, Sendable {
    var id: String { label }
    var label: String
    var description: String

    init(json: JSONValue) {
        label = json["label"]?.stringValue ?? ""
        description = json["description"]?.stringValue ?? ""
    }
}

struct AskQuestion: Identifiable, Hashable, Sendable {
    let id = UUID()
    var header: String
    var question: String
    var multiSelect: Bool
    var options: [AskOption]

    init(json: JSONValue) {
        header = json["header"]?.stringValue ?? ""
        question = json["question"]?.stringValue ?? ""
        multiSelect = json["multiSelect"]?.boolValue ?? false
        options = (json["options"]?.arrayValue ?? []).map(AskOption.init(json:)).filter { !$0.label.isEmpty }
    }
}

struct AskAnswer: Hashable, Sendable {
    var header: String
    var question: String
    var selected: [String]
    var text: String

    init(header: String = "", question: String = "", selected: [String] = [], text: String = "") {
        self.header = header
        self.question = question
        self.selected = selected
        self.text = text
    }

    init(json: JSONValue) {
        header = json["header"]?.stringValue ?? ""
        question = json["question"]?.stringValue ?? ""
        selected = (json["selected"]?.arrayValue ?? []).compactMap { $0.stringValue }
        text = json["text"]?.stringValue ?? ""
    }
}

struct AskCardState: Hashable, Sendable {
    var requestId: String
    var questions: [AskQuestion]
    /// Set = answered (shows the choice made).
    var answers: [AskAnswer]?
    /// Still tappable: unanswered AND no user message came afterwards (the same rule as on the server; otherwise skipped cards
    /// would stay clickable forever).
    var answerable: Bool
}

// ── Approval of a tool that carries an approval mark ─────────────────────────────
// An agent calls a tool that carries an approval mark. The run waits until the user decides: approve (also with changed
// parameters) or reject (with a reason, which goes to the model as a tool error). Request and ruling live in the history
// (role "approval" / "approval_ruling"), so the card survives every restart of the app.
struct ApprovalRuling: Hashable, Sendable {
    /// allow | deny
    var behavior: String
    var reason: String
    /// user · stop (run aborted) · running (the run ended without anyone deciding)
    var origin: String
    var updatedInput: JSONValue?
    var at: Double
    /// Coding card: the standing rule remembered at approval, otherwise empty.
    var remember: String

    init(json: JSONValue) {
        behavior = json["behavior"]?.stringValue ?? ""
        reason = json["reason"]?.stringValue ?? ""
        origin = json["origin"]?.stringValue ?? "user"
        if let u = json["updatedInput"], u.objectValue != nil { updatedInput = u } else { updatedInput = nil }
        at = json["at"]?.doubleValue ?? 0
        remember = json["remember"]?.stringValue ?? ""
    }
}

struct ApprovalCardState: Hashable, Sendable {
    var requestId: String
    /// Full name of the call (mcp__<server>__<tool> or mcp__cbase__cbase_…).
    var toolName: String
    /// Display name of the server ("cbase", "Teams archive") and the short tool name.
    var server: String
    var tool: String
    var description: String
    var writing: Bool?
    var input: JSONValue
    var at: Double
    /// Still open: the run waits. With a ruling the card closes.
    var open: Bool
    var ruling: ApprovalRuling?

    init(json: JSONValue, open: Bool = true) {
        requestId = json["requestId"]?.stringValue ?? ""
        toolName = json["toolName"]?.stringValue ?? ""
        server = json["server"]?.stringValue ?? ""
        tool = json["tool"]?.stringValue ?? ""
        description = json["description"]?.stringValue ?? ""
        writing = json["writing"]?.boolValue
        input = json["input"] ?? .object([:])
        at = json["at"]?.doubleValue ?? 0
        self.open = open
        ruling = nil
        if server.isEmpty || tool.isEmpty {
            // An event without a mark: split the name so the card is never labeled empty.
            let parts = toolName.split(separator: "__", omittingEmptySubsequences: true).map(String.init)
            if parts.count >= 3, parts[0] == "mcp" {
                if server.isEmpty { server = parts[1] == "cbase" ? "cbase" : parts[1] }
                if tool.isEmpty { tool = parts.dropFirst(2).joined(separator: "__") }
            } else if tool.isEmpty {
                tool = toolName
            }
        }
    }
}

/// A capture by an agent of the chat (cbase_screenshot / cbase_recording_*) that the server shows by itself at the end of the
/// turn: a screenshot or screen video of its chat browser, live via SSE (capture_message) and identical from the stored
/// history (role "capture"). `collapsed`: above the cap per turn (six) the card stays closed until opened, as on the web.
struct CaptureState: Hashable, Sendable {
    var captureId: String
    var kind: String          // screenshot | recording
    var caption: String
    var poster: String
    var video: String?
    var w: Int
    var h: Int
    var durationMs: Double
    var url: String
    var title: String
    var collapsed: Bool

    init(json: JSONValue) {
        captureId = json["captureId"]?.stringValue ?? ""
        kind = json["kind"]?.stringValue ?? "screenshot"
        caption = json["caption"]?.stringValue ?? ""
        poster = json["poster"]?.stringValue ?? "poster.jpg"
        video = json["video"]?.stringValue
        w = json["w"]?.intValue ?? 0
        h = json["h"]?.intValue ?? 0
        durationMs = json["durationMs"]?.doubleValue ?? 0
        url = json["url"]?.stringValue ?? ""
        title = json["title"]?.stringValue ?? ""
        collapsed = json["collapsed"]?.boolValue ?? false
    }
}

/// A row of the workflow driver in the history (start, step, branch verdict, question, skipped, end), live via SSE and
/// identical from the stored history.
struct WorkflowLine: Hashable, Sendable {
    var kind: String
    var name: String = ""
    var title: String = ""
    var text: String = ""
    var note: String = ""
    var step: Int = 0
    var total: Int = 0
    var approx: Bool = false
    var count: Int = 0
    var yes: Bool?
    var status: String = ""
    var loopIndex: Int?
    var loopTotal: Int?
    var loopItem: String?
    /// Only kind "cap" (round cap): rounds run, rounds allowed, rounds granted afterwards.
    var rounds: Int = 0
    var cap: Int = 0
    var granted: Int = 0
    /// Tick "without a question": the run left the loop by itself.
    var auto: Bool = false
    /// Only kind "review": the user's verdict ("ok"/"issues"); empty = the request itself.
    var verdict: String = ""
    /// Only kind "review": which review round it is.
    var round: Int = 0
    /// Only kind "command": the slash command run before the node (/clear, /compact …).
    var command: String = ""
    /// Only kind "gate" (closing gate): verdict and allowed rounds. `round` counts as for the review.
    var done: Bool?
    var maxRounds: Int = 0

    /// From an SSE event or the stored JSON of a "workflow" message.
    init(json: JSONValue) {
        kind = json["kind"]?.stringValue ?? ""
        name = json["name"]?.stringValue ?? ""
        title = json["title"]?.stringValue ?? ""
        text = json["text"]?.stringValue ?? ""
        note = json["note"]?.stringValue ?? ""
        step = json["step"]?.intValue ?? 0
        total = json["total"]?.intValue ?? 0
        approx = json["approx"]?.boolValue ?? false
        count = json["count"]?.intValue ?? 0
        yes = json["yes"]?.boolValue
        status = json["status"]?.stringValue ?? ""
        rounds = json["rounds"]?.intValue ?? 0
        cap = json["cap"]?.intValue ?? 0
        granted = json["granted"]?.intValue ?? 0
        auto = json["auto"]?.boolValue ?? false
        verdict = json["verdict"]?.stringValue ?? ""
        round = json["round"]?.intValue ?? 0
        command = json["command"]?.stringValue ?? ""
        done = json["done"]?.boolValue
        maxRounds = json["max"]?.intValue ?? 0
        if let loop = json["loop"] {
            loopIndex = loop["index"]?.intValue
            loopTotal = loop["total"]?.intValue
            loopItem = loop["item"]?.stringValue
        }
    }
}

enum ChatBlockKind: String, Hashable, Sendable {
    case text, thinking, tool, error
}

/// The marker of a message TO a workflow agent (agent communication; transcript kind "message"): sender (`agent` | `human`),
/// delivery state (`delivered` · `after_turn` · `earmarked` · `not_delivered`) and, for an undelivered one, the reason. A block
/// with this marker is a `.text` block; the timeline shows sender and state instead of "Text" (`CallEntry`,
/// Chat/ChatDetailSheet.swift).
struct ChatMessageMarker: Hashable, Sendable {
    let from: String
    let state: String
    let reason: String
}

struct ChatBlock: Identifiable, Hashable, Sendable {
    /// STABLE identifier. `buildTimeline` assigns "b-<row id>" (at most one block per log row); blocks created live keep their
    /// random identifier because they are mutated IN PLACE across renders. Why it matters: with a fresh UUID per reconcile
    /// every block lost its SwiftUI identity at every server sync, all `@State` (expanded/collapsed) fell back, and the error
    /// boxes replayed their expand flip AFTER the cell's self-sizing (visible as an empty band around the last message).
    let id: String
    var kind: ChatBlockKind
    var text: String
    var toolUseId: String?
    var toolName: String?
    var detail: String
    var input: JSONValue?
    var result: String?
    var resultIsError: Bool
    var done: Bool
    var children: [ChatBlock]
    /// Set only on a message to a workflow agent (`DynTranscript.blocks`), otherwise nil.
    var message: ChatMessageMarker?
    /// The row id of a result truncated in the window (`ChatViewModel+Window.swift`), otherwise nil.
    var truncated: Int? = nil

    init(
        id: String = "live-" + UUID().uuidString,
        kind: ChatBlockKind,
        text: String = "",
        toolUseId: String? = nil,
        toolName: String? = nil,
        detail: String = "",
        input: JSONValue? = nil,
        result: String? = nil,
        resultIsError: Bool = false,
        done: Bool = false,
        children: [ChatBlock] = [],
        message: ChatMessageMarker? = nil
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.toolUseId = toolUseId
        self.toolName = toolName
        self.detail = detail
        self.input = input
        self.result = result
        self.resultIsError = resultIsError
        self.done = done
        self.children = children
        self.message = message
    }
}

/// An item of the CLI's own task list (TaskCreate/TaskUpdate). The `id` is the CLI's ("1") and stays stable across updates;
/// that is what lets SwiftUI change only the one item when it is ticked off instead of rebuilding the whole list.
struct NativeTask: Identifiable, Hashable, Sendable {
    let id: String
    var subject: String
    var activeForm: String?
    var status: String
}

struct TimelineItem: Identifiable, Hashable, Sendable {
    /// STABLE identifier. Rows built from the log carry "row-<row id>", rows created live "live-<UUID>". Why it matters:
    /// `buildTimeline` runs again at every reconcile with the server, and with a fresh UUID per row EVERY row got a new
    /// identity, so SwiftUI discarded the whole history and rebuilt it. That was exactly the flicker when opening a chat
    /// from a notification.
    let id: String
    var role: TimelineRole
    var blocks: [ChatBlock]
    var attachments: [Attachment]
    var streaming: Bool
    var summary: RunSummary?
    var label: String
    var achieved: Bool?
    var turns: Int?
    var continuing: String?
    var event: String?
    var status: String?
    var workflow: WorkflowLine?
    var limit: LimitLine?
    var ask: AskCardState?
    var capture: CaptureState?
    var channel: ChannelCard?
    var message: InboundAgentMessage? // only role .message (Chat/InboundAgentMessage.swift)
    var approval: ApprovalCardState?
    var marker: WorkflowMarker? // only role .divider: start/end marker of a dynamic workflow (Chat/WorkflowMarker.swift)
    var wfApproval: WorkflowApprovalState? // only role .workflowApproval (Chat/WorkflowApproval.swift)
    /// Only role .divider: set ⇒ an event (completion notice, workflow marker), drawn as a status row with a symbol instead
    /// of a line (Chat/CompletionNotice.swift `SeparatorTone`); nil ⇒ a real boundary (compaction, hint).
    var tone: SeparatorTone?
    var dimmed: Bool
    /// When the row was created (ms), for the day separator (Chat/DaySeparator.swift). From the log the time of the FIRST row it
    /// was built from (`buildTimeline`), live the moment of creation (default below).
    var at: Double

    init(
        id: String = "live-" + UUID().uuidString,
        role: TimelineRole,
        blocks: [ChatBlock] = [],
        attachments: [Attachment] = [],
        streaming: Bool = false,
        summary: RunSummary? = nil,
        label: String = "",
        achieved: Bool? = nil,
        turns: Int? = nil,
        continuing: String? = nil,
        event: String? = nil,
        status: String? = nil,
        workflow: WorkflowLine? = nil,
        limit: LimitLine? = nil,
        ask: AskCardState? = nil,
        capture: CaptureState? = nil,
        channel: ChannelCard? = nil,
        message: InboundAgentMessage? = nil,
        approval: ApprovalCardState? = nil,
        marker: WorkflowMarker? = nil,
        wfApproval: WorkflowApprovalState? = nil,
        tone: SeparatorTone? = nil,
        dimmed: Bool = false,
        at: Double = Date().timeIntervalSince1970 * 1000
    ) {
        self.id = id
        self.role = role
        self.blocks = blocks
        self.attachments = attachments
        self.streaming = streaming
        self.summary = summary
        self.label = label
        self.achieved = achieved
        self.turns = turns
        self.continuing = continuing
        self.event = event
        self.status = status
        self.workflow = workflow
        self.limit = limit
        self.ask = ask
        self.capture = capture
        self.channel = channel
        self.message = message
        self.approval = approval
        self.marker = marker
        self.wfApproval = wfApproval
        self.tone = tone
        self.dimmed = dimmed
        self.at = at
    }
}

struct APIMessageResponse: Codable, Sendable {
    let ok: Bool
    let queued: Bool?
    let injected: Bool?
    let position: Int?
    let queue: [QueuedMessage]?
    /// The chat waits at the usage limit or credit gate (run wait row, no process): the message is queued BEHIND the parked
    /// continuation, and no turn is running. Missing on older servers.
    let parked: Bool?
}

struct CompactResponse: Codable, Sendable {
    let ok: Bool
    let note: String?
    let chars: Int?
}

struct ClearChatResponse: Codable, Sendable {
    let ok: Bool
    let at: Double
}

struct FileSearchResponse: Codable, Sendable {
    let results: [String]
}
