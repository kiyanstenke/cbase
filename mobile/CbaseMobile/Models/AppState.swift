import Foundation
import SwiftUI

// Global state of the mobile shell: home tabs (workspaces/apps/profile), active workspace, entered project, chosen category
// and the two drawers. The left drawer is category-specific, so the long-lived pane models (chat list, terminals, code,
// browser) live here so that drawer and content area always see the same instance.

// Three tabs: Coding · Apps · Profile. A remembered legacy raw value under `cbase.mobile.tab` no longer yields a `HomeTab` and
// falls back to the default in `restorePersisted`.
enum HomeTab: String, CaseIterable, Identifiable, Sendable {
    case workspaces
    case apps
    case profile

    var id: String { rawValue }

    // Labels as on the desktop: the implementation and coding agents run under the first tab, hence "Coding". The rawValue
    // `workspaces` stays: it is baked into stored states and into the accessibility identifiers of the UI tests.
    var displayLabel: String {
        switch self {
        case .workspaces: return "Coding"
        case .apps: return "Apps"
        case .profile: return "Profile"
        }
    }
}

enum WorkspaceCategory: String, CaseIterable, Identifiable, Sendable {
    case chats
    // The scheduled jobs directly after the chats; the same position as `scheduled` in web/src/lib/coding-tabs.ts (Code/ScheduledPane.swift).
    case scheduled
    case agents
    case workflows
    case projects
    case mcp
    case context
    case vars
    // Directly after the credentials; the same position as `skills` in web/src/lib/coding-tabs.ts.
    case skills
    case code
    case terminal
    case browser

    var id: String { rawValue }

    /// The raw value of the former standalone category "Dynamic workflows". It is now the kind "Dynamic" under "Workflows"
    /// (`WorkflowKind`); a stored `cbase.mobile.cat:<ws>` with this value leads to `.workflows` + `.dynamisch` in `AppState.enter`
    /// instead of silently to `.chats`. Deliberately placed AFTER `var id`: web/test/coding-tab.test.mjs reads the cases up to there.
    static let legacyDynworkflows = "dynworkflows"

    var displayLabel: String {
        switch self {
        case .chats: return "Chats"
        case .scheduled: return "Scheduled"
        case .agents: return "Agents"
        case .workflows: return "Workflows"
        case .projects: return "Projects"
        case .mcp: return "MCP"
        case .context: return "Context"
        case .vars: return "Credentials"
        case .skills: return "Skills"
        case .code: return "Files"
        case .terminal: return "Terminal"
        case .browser: return "Browser"
        }
    }

    /// A short clause per category; it appears in the overview of the Coding tab under the name. Short enough for one line; each
    /// page carries the detailed explanation in its own subtitle.
    var clause: String {
        switch self {
        case .chats: return "Work with the coding agents"
        case .scheduled: return "Tasks that message their chat at set times"
        case .agents: return "Your own subagents with role and model"
        case .workflows: return "Flows as a graph or as a saved script"
        case .projects: return "The projects of this workspace and their services"
        case .mcp: return "External tool servers for the agents"
        case .context: return "Dumpster and memory — what the agents know"
        case .vars: return "Access data and variables, kept sealed"
        case .skills: return "Instructions the agents load when needed"
        case .code: return "Files, search, git, problems and debug"
        case .terminal: return "Shell sessions in the workspace"
        case .browser: return "Your browser — and the agents' to watch"
        }
    }

    var symbol: String {
        switch self {
        case .chats: return "bubble.left.and.bubble.right"
        case .scheduled: return "clock"
        case .agents: return "person.2"
        case .workflows: return "arrow.triangle.branch"
        case .projects: return "folder"
        case .mcp: return "puzzlepiece.extension"
        case .context: return "tray.full"
        case .vars: return "key"
        case .skills: return "wand.and.stars"
        case .code: return "doc.text"
        case .terminal: return "terminal"
        case .browser: return "globe"
        }
    }

    /// Categories with a tool character of their own are set apart in the list.
    var isTool: Bool {
        switch self {
        case .code, .terminal, .browser: return true
        default: return false
        }
    }
}

enum ContextSubView: String, CaseIterable, Sendable {
    case dumpster
    case memory

    var displayLabel: String { self == .dumpster ? "Dumpster" : "Memory" }
}

enum CodeSubView: String, CaseIterable, Sendable {
    case files
    case search
    case git
    case problems
    case debug

    var displayLabel: String {
        switch self {
        case .files: return "Files"
        case .search: return "Search"
        case .git: return "Git"
        case .problems: return "Problems"
        case .debug: return "Debug"
        }
    }

    var symbol: String {
        switch self {
        case .files: return "folder"
        case .search: return "magnifyingglass"
        case .git: return "arrow.triangle.branch"
        case .problems: return "checkmark.seal"
        case .debug: return "ladybug"
        }
    }
}

/// The two kinds of the category "Workflows": the graph workflows and the library of dynamic workflows. The same values in the
/// same order as `WORKFLOW_KINDS` on the web (web/src/lib/coding-tabs.ts, bound by web/test/coding-tab.test.mjs).
enum WorkflowKind: String, CaseIterable, Sendable {
    case graph
    case dynamic
}

/// The kinds of the category "Agents": the subagents, the outer loop and the instructions for agents. The same values in the same
/// order as `AGENT_KINDS` on the web (web/src/lib/coding-tabs.ts).
enum AgentKind: String, CaseIterable, Sendable {
    case subagents
    case outerloop
    case instructions
}

enum ItemsSection: String, CaseIterable, Sendable {
    case own
    case adopt

    var displayLabel: String { self == .own ? "Own" : "Adopt" }
}

enum VarsFilter: String, CaseIterable, Sendable {
    case all
    case secret
    case variable
    case link
    case freeText

    var displayLabel: String {
        switch self {
        case .all: return "All"
        case .secret: return "Secrets"
        case .variable: return "Variables"
        case .link: return "Links"
        case .freeText: return "Free text"
        }
    }
}

/// Sort order of the chat list (overview and left drawer share it).
enum ChatSort: String, CaseIterable, Identifiable, Sendable {
    case newest
    case oldest
    case title
    /// Grouped by project (workspace chats first), newest on top within each.
    case project

    var id: String { rawValue }

    var displayLabel: String {
        switch self {
        case .newest: return "Newest first"
        case .oldest: return "Oldest first"
        case .title: return "Title A–Z"
        case .project: return "By project"
        }
    }

    var symbol: String {
        switch self {
        case .newest: return "arrow.down"
        case .oldest: return "arrow.up"
        case .title: return "textformat.abc"
        case .project: return "folder"
        }
    }
}

/// The sections of the profile page; only the account.
enum ProfileSubView: String, CaseIterable, Sendable {
    case account

    var displayLabel: String { "Account" }
}

struct EnteredProject: Equatable, Hashable, Sendable {
    let id: String
    let name: String
}

/// Open state of the two drawers, deliberately a tiny object of its own.
///
/// It used to be `@Published` in `AppState`. Because half the app observes `AppState`, SwiftUI re-evaluated the whole view tree
/// when a swipe was released, exactly when the spring started. That was the stutter when the thumb lifted. Now only the shell
/// listens (`DrawerFlagWatcher`); the write sites stay unchanged because `AppState.leftOpen`/`rightOpen` forward to this.
@MainActor
final class DrawerFlags: ObservableObject {
    @Published var left = false
    @Published var right = false

    /// Sides that close WITHOUT travel the next time they close; set only for an OPEN side, i.e. exactly when the shell's observer is
    /// about to report a close, and consumed there (`takeWithoutTravel`). Not published: nobody draws afterwards, the shell asks at
    /// the moment of closing.
    private var withoutTravel: Set<DrawerSide> = []

    /// Closes both sides without travel; `true` if one was open.
    func closeWithoutTravel() -> Bool {
        let wasOpen = left || right
        if left { withoutTravel.insert(.left); left = false }
        if right { withoutTravel.insert(.right); right = false }
        return wasOpen
    }

    /// Whether THIS close happens without travel; the marker applies exactly once.
    func takeWithoutTravel(_ page: DrawerSide) -> Bool {
        withoutTravel.remove(page) != nil
    }
}

@MainActor
final class AppState: ObservableObject {
    // ── Navigation ──
    @Published var tab: HomeTab = .workspaces
    @Published var category: WorkspaceCategory = .chats
    let drawers = DrawerFlags()
    /// Not published; see `DrawerFlags`.
    var leftOpen: Bool {
        get { drawers.left }
        set { drawers.left = newValue }
    }
    var rightOpen: Bool {
        get { drawers.right }
        set { drawers.right = newValue }
    }
    /// Counter for fading in the content: every step fades the page below the header into `CbFade.content` (`AppShell`,
    /// `.cbFadeIn(bei:)`). Incremented in the SAME step as the view change, so the new content is already at opacity 0 in the first
    /// frame instead of flashing in fully once.
    @Published private(set) var fadeIn = 0
    @Published var showSettings = false
    /// Where the settings jump to when opened: "<page>" or "<page>:<subpage>", e.g. "usage:claude" from a ring in the header.
    /// `SettingsView` reads it once and clears it; `nil` = the list. Set BEFORE `showSettings = true` (`openSettings`).
    @Published var settingsJump: String?
    @Published var showNotifications = false
    // ── Scope ──
    @Published var workspaces: [Workspace] = []
    @Published var activeWorkspaceId: String?
    @Published var enteredProject: EnteredProject?
    @Published var overview: WorkspaceOverview?
    @Published var loadingWorkspaces = true
    @Published var workspaceError = ""

    // ── Sub-views of the left drawer ──
    @Published var contextSub: ContextSubView = .memory
    @Published var codeSub: CodeSubView = .files
    @Published var profileSub: ProfileSubView = .account
    /// The Coding tab starts at an OVERVIEW of its categories: a tap on the tab always leads there, and a category is opened from it
    /// (or via the right drawer, which shortens the way). The marker is PERSISTED (`persistScope`): whoever leaves the app in the
    /// middle of a terminal returns there, and whoever leaves it on the overview does too. Without a stored state (fresh install)
    /// the tab starts at the overview.
    @Published var showingCodingOverview = true
    @Published var appsSelectedProject: String?
    /// Own items vs. takeover of workspace items (agents/skills/MCP/credentials in the project).
    @Published var itemsSection: ItemsSection = .own
    /// The kind of the category "Workflows" (segment bar `Workflows/WorkflowKindBar.swift`), remembered per workspace like the
    /// category itself (`cbase.mobile.wfart:<ws>`, read in `enter`); like `cbase-wf-kind:<ws>` on the web.
    @Published var workflowKind: WorkflowKind = .graph {
        didSet {
            if let id = activeWorkspaceId { defaults.set(workflowKind.rawValue, forKey: "cbase.mobile.wfart:\(id)") }
        }
    }
    /// The kind of the category "Agents" (segment bar `Code/AgentKindBar.swift`), remembered per workspace like the workflow kind
    /// (`cbase.mobile.agentenart:<ws>`, read in `enter`); like `cbase-agents-kind:<ws>` on the web.
    @Published var agentKind: AgentKind = .subagents {
        didSet {
            if let id = activeWorkspaceId { defaults.set(agentKind.rawValue, forKey: "cbase.mobile.agentenart:\(id)") }
        }
    }
    @Published var varsFilter: VarsFilter = .all
    @Published var contextCategory: String?
    /// Categories of the project context (reported by the ProjectContextPane, for the drawer).
    @Published var projectContextCounts: [ContextCategory] = []
    @Published var projectsSelected: String?

    // ── Chat selection ──
    @Published var selectedChatId: String? {
        // The UIKit delegate of the notifications cannot reach any EnvironmentObject; it reads the open chat through this narrow
        // path to suppress, in the foreground, only THE banner whose card is already on screen.
        didSet { PushNotifications.openChat = selectedChatId }
    }
    /// Overview page instead of an open chat (when entering a workspace).
    @Published var showingChatOverview = true

    // ── Chat list: sort order, search ──
    // The sort order survives an app restart (the user sets it once); the search is deliberately transient. Both views (overview +
    // left drawer) work on THIS state so they never show different things. There is no project filter to switch on: in an entered
    // project ONLY its chats and folders appear; `visibleChats`/`visibleFolders` depend solely on `enteredProject`.
    @Published var chatSort: ChatSort = .newest {
        didSet { defaults.set(chatSort.rawValue, forKey: "cbase.mobile.chats.sort") }
    }
    @Published var chatSearch = ""
    /// Expanded chat folders. Folder identifiers are globally unique, so one shared key suffices for all workspaces. Structure should
    /// not have to be expanded again at every start.
    @Published var openChatFolders: Set<String> = [] {
        didSet { defaults.set(Array(openChatFolders), forKey: "cbase.mobile.chats.open-folders") }
    }
    /// The values of the open draft (project, folder, model, level, instance): what the "New chat" entry chose. Deliberately
    /// transient; they apply only to the draft that is open right now. `nil` means no entry chose (app start, after opening a chat);
    /// `draftDefault` with the entered project then applies.
    @Published private(set) var chatDraft: NewChatDraft?
    /// The identifier of the draft view (`ChatHost`): it changes when an entry opens a DIFFERENT draft or the open one is already
    /// created; the model takes the values only in `init`. The same still-empty draft keeps it (local attachments stay).
    @Published private(set) var chatDraftIdentifier = UUID()
    /// The chat the open draft was created as on first send. The draft view keeps holding it (the list shows it only from the first
    /// message) and `selectedChatId` points to it (marking in the list, no banner for the open chat). If the view is rebuilt
    /// (category switched and back), it opens it as a chat instead of an empty draft.
    @Published private(set) var createdDraft: Chat?

    // ── Live state (global SSE stream) ──
    @Published var runningChats: Set<String> = []
    /// Chats with an open dynamic workflow, the runIds per chat: the workflow runs outside the turn, `runningChats` does not know it,
    /// yet the chat list's hexagon spins. Twin of web/src/lib/workflow-chats.ts (guard web/test/workflow-chats.test.mjs): initial
    /// state `dynWorkflows`, then the event `dyn_workflow` with `open`.
    @Published var workflowChats: [String: Set<String>] = [:]
    @Published var unreadChats: Set<String> = []
    @Published var unreadNotifications = 0
    /// Is the chat working: a turn is running OR a dynamic workflow is open? (Web: `chatWorking` in lib/workflow-chats.ts)
    func chatWorking(_ id: String) -> Bool { runningChats.contains(id) || workflowChats[id] != nil }

    // ── Long-lived pane models ──
    @Published private(set) var chatList: WorkspaceChatsViewModel?
    /// Event `outer_loop` (a run of an outer loop agent changes state): the list, the runs and the chat info hang on this counter
    /// and reload, without a polling interval.
    @Published private(set) var outerLoopTick = 0
    /// Event `instructions` `{ workspaceId, projectId }`: after every write of a section the "Instructions" page reloads
    /// (`Code/AgentInstructionsPane.swift`).
    @Published private(set) var instructionsTick = 0
    /// Event `scheduled` (a run of a scheduled job changes state or the job is deleted): the "Scheduled" page and its open sheet
    /// reload, and so does the chat list, whose clock carries the next occurrence (`Chat.job`).
    @Published private(set) var scheduledTick = 0
    /// Event `timeline` `{ projectId }`: a counter per project; the page Projects → Timeline and the sheet from the chat reload
    /// (Code/ProjectTimeline.swift).
    @Published private(set) var timelineTick: [String: Int] = [:]
    /// Event `preview/link` (a preview link changes state): the ports popover and the ngrok group of the integrations reload,
    /// without a polling interval (`Shell/PreviewLinks.swift`).
    @Published private(set) var previewTick = 0
    /// Archive: counts the `chat_archive` events and the own actions (`reportArchive`). Open conversations (`ChatComposer`) and the
    /// archive list hang on the counter `archiveChanged`; an open conversation asks WHOM a notice named with
    /// `archiveNamed(_:since:)` and the OLD counter value of its `onChange`, because two notices before the next render produce
    /// one `onChange` and both must arrive (`ArchiveNotices`).
    @Published private(set) var archiveNotices = ArchiveNotices()
    var archiveChanged: Int { archiveNotices.revision }
    func archiveNamed(_ chatId: String, since old: Int) -> Bool { archiveNotices.named(chatId, since: old) }
    /// The first switching on of the auto-archive sends one `chat_archive` per archived chat, and EACH reloaded the coding list and
    /// the archive. An event that names no open chat therefore waits here (`reportArchive(…, sofort: false)`); all together go out
    /// as ONE notice `archiveBundleNs` after the LAST one; every further one cancels the waiting task and restarts it. An immediate
    /// one takes everything collected along.
    private var archiveCollected: [String] = []
    private var archiveBundle: Task<Void, Never>?
    static let archiveBundleNs: UInt64 = 300_000_000
    @Published private(set) var terminals: TerminalSessionsModel?
    @Published private(set) var codeModel: CodeBrowserModel?
    /// Per project a counter of the `project/layout` events; the "Outline" page reloads on it.
    @Published var layoutEvents: [String: Int] = [:]
    /// Per project a counter of the `project/superseded` events and the last end (for display in the sheet).
    @Published var supersededEvents: [String: Int] = [:]
    @Published var supersededEnd: [String: JSONValue] = [:]
    @Published private(set) var browserModel: BrowserSessionModel?
    @Published private(set) var gitModel: GitModel?
    @Published private(set) var debugModel: DebugModel?
    /// The instance choice of the Code tab in the entered project (Code/CodeInstanceChoice.swift); nil in the workspace.
    @Published private(set) var codeInstance: CodeInstanceModel?
    /// Counts the `project/instance` and `project/copy` events per project: the instance choice of a chat's git sheet
    /// (Chat/ChatGitBar.swift) rereads the project list at each one (a copy became ready, was cleaned up, a chat moved in or out).
    @Published private(set) var instanceEvents: [String: Int] = [:]
    /// A jump to a sub-item of a project (`projectShow` in Code/ProjectView.swift; "Instances" from "Create copy …" at a chat's
    /// instance choice, "Git" from the git overview): the Projects page sets the segment (`ProjectsPane`), the tab picks the wish up
    /// (`ProjectInstancesPage`: open instance, "Create copy" dialog) and clears it. A wish nobody picks up within a minute expires
    /// (`ProjectWish.verfallen`).
    @Published var projectWish: ProjectWish?
    /// A jump "agent in chat" (`openChat(_:agent:)`, Chat/AgentJump.swift): the view of THIS chat opens the subagent sheet with the
    /// agent as soon as its history is loaded, and clears the request.
    @Published var agentJump: AgentJump?

    private(set) var client: APIClient?
    private var eventsTask: Task<Void, Never>?
    /// Batched reload of the workspaces after `project/setup`/`project/upload`/`project/instance` (a setup reports several within seconds).
    private var projectListTask: Task<Void, Never>?
    private var notificationsTask: Task<Void, Never>?
    private var pendingPushPayload: [AnyHashable: Any]?
    private var scopeToken = ""
    private var seenNotificationId = UserDefaults.standard.integer(forKey: "cbase.mobile.notif-seen")

    private let defaults = UserDefaults.standard

    // ── Derived values ──
    var activeWorkspace: Workspace? {
        workspaces.first(where: { $0.id == activeWorkspaceId })
    }

    var scopeApiBase: String {
        if let project = enteredProject { return "/api/projects/\(project.id)" }
        if let id = activeWorkspaceId { return "/api/workspaces/\(id)" }
        return ""
    }

    var scopeKey: String {
        if let project = enteredProject { return "proj:\(project.id)" }
        return "ws:\(activeWorkspaceId ?? "-")"
    }

    var scopeName: String {
        enteredProject?.name ?? activeWorkspace?.name ?? L("Workspace")
    }

    /// The coding categories. In the entered project `.projects` is also part of them: there it is called "Project" and opens the
    /// view of THIS project directly (`ProjectsPane(onlyProject:)`) instead of being absent. The list stays the same (right drawer and
    /// overview both read only it); name and symbol are computed by `categoryTitle` and `categorySymbol`.
    var categories: [WorkspaceCategory] {
        WorkspaceCategory.allCases
    }

    /// The name of a coding category (English key for `L`): in the entered project `.projects` is called "Project".
    func categoryTitle(_ category: WorkspaceCategory) -> String {
        category == .projects && enteredProject != nil ? "Project" : category.displayLabel
    }

    /// The symbol for it: in the entered project a separate one in place of "Projects" (as on the web).
    func categorySymbol(_ category: WorkspaceCategory) -> String {
        category == .projects && enteredProject != nil ? "folder.badge.gearshape" : category.symbol
    }

    /// The overview's clause for it.
    func categoryClause(_ category: WorkspaceCategory) -> String {
        category == .projects && enteredProject != nil ? "Services, outline and instances of this project" : category.clause
    }

    // There is no count behind each coding category any more; `overview.contextCount` is still read, in the left drawer
    // (see LeftDrawerBody).

    // ── Setup ──
    func attach(client: APIClient) {
        guard self.client !== client else { return }
        self.client = client
        restorePersisted()
        Task { await loadWorkspaces(initial: true) }
        startEventStream()
        startNotificationPolling()
        if let pendingPushPayload {
            self.pendingPushPayload = nil
            Task { await openPushPayload(pendingPushPayload) }
        }
    }

    func detach() {
        eventsTask?.cancel()
        eventsTask = nil
        notificationsTask?.cancel()
        notificationsTask = nil
        client = nil
        chatList = nil
        terminals = nil
        codeModel = nil
        browserModel = nil
        gitModel = nil
        debugModel = nil
        codeInstance = nil
        overview = nil
        workspaces = []
        activeWorkspaceId = nil
        enteredProject = nil
    }

    private func restorePersisted() {
        if let saved = defaults.string(forKey: "cbase.mobile.ws") { activeWorkspaceId = saved }
        if let raw = defaults.string(forKey: "cbase.mobile.tab"), let value = HomeTab(rawValue: raw) {
            tab = value
        }
        // The "Only this project" switch is gone, and so is its stored value.
        defaults.removeObject(forKey: "cbase.mobile.chats.only-project")
        if defaults.object(forKey: "cbase.mobile.codingOverview") != nil {
            showingCodingOverview = defaults.bool(forKey: "cbase.mobile.codingOverview")
        }
        if let raw = defaults.string(forKey: "cbase.mobile.chats.sort"), let value = ChatSort(rawValue: raw) {
            chatSort = value
        }
        // The sort order of the task list is gone, and so is its stored value.
        defaults.removeObject(forKey: "cbase.mobile.todos.sort")
        if let saved = defaults.stringArray(forKey: "cbase.mobile.chats.open-folders") {
            openChatFolders = Set(saved)
        }
    }

    // ── Chat folders ──
    func toggleChatFolder(_ id: String) {
        if openChatFolders.contains(id) { openChatFolders.remove(id) } else { openChatFolders.insert(id) }
    }

    func revealChatFolder(_ id: String) {
        openChatFolders.insert(id)
    }

    /// Visible folders: in the entered project only its folders, otherwise all of the workspace (like the web,
    /// `ChatPane.visibleFolders`). While a search runs, only folders remain whose name matches or that contain a matching chat;
    /// otherwise empty folders would stand above the hit.
    func visibleFolders(_ folders: [ChatFolder], matching chats: [Chat]) -> [ChatFolder] {
        var list = folders
        if let project = enteredProject {
            list = list.filter { $0.projectId == project.id }
        }
        let needle = chatSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return list }
        let hit = Set(chats.compactMap(\.folderId))
        return list.filter { $0.name.lowercased().contains(needle) || hit.contains($0.id) }
    }

    /// Restrict and sort the chat list to the entered project and the search. In a project ONLY its chats appear, pinned or not,
    /// and workspace chats without a project do not either (like the web, `ChatPane.scopedChats`). Pinned chats always stand on top;
    /// otherwise "Oldest first" would devalue pinning.
    func visibleChats(_ chats: [Chat], projects: [Project] = [], folders: [ChatFolder] = []) -> [Chat] {
        var list = chats
        if let project = enteredProject {
            list = list.filter { $0.projectId == project.id }
        }
        let needle = chatSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !needle.isEmpty {
            list = list.filter { chat in
                if chat.title.lowercased().contains(needle) { return true }
                if chat.model.lowercased().contains(needle) { return true }
                if chat.provider.lowercased().contains(needle) { return true }
                // The folder name counts too; otherwise a search would find the folder but none of its chats and show an empty folder.
                if let id = chat.folderId,
                   let folder = folders.first(where: { $0.id == id })?.name.lowercased(),
                   folder.contains(needle) { return true }
                if let name = projects.first(where: { $0.id == chat.projectId })?.name.lowercased() {
                    return name.contains(needle)
                }
                return false
            }
        }
        let sort = chatSort
        // Project name for grouping; workspace chats (without a project) sort first as "". If the name is missing (project not in the
        // list), the identifier counts; the point is a stable grouping.
        let projectName: (Chat) -> String = { chat in
            guard let id = chat.projectId, !id.isEmpty else { return "" }
            return projects.first(where: { $0.id == id })?.name ?? id
        }
        list.sort { first, second in
            if first.pinned != second.pinned { return first.pinned }
            switch sort {
            case .newest: return first.updatedAt > second.updatedAt
            case .oldest: return first.updatedAt < second.updatedAt
            case .title: return first.title.localizedCaseInsensitiveCompare(second.title) == .orderedAscending
            case .project:
                let left = projectName(first)
                let right = projectName(second)
                if left != right {
                    return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
                }
                return first.updatedAt > second.updatedAt
            }
        }
        return list
    }

    private func persistScope() {
        if let id = activeWorkspaceId { defaults.set(id, forKey: "cbase.mobile.ws") }
        defaults.set(tab.rawValue, forKey: "cbase.mobile.tab")
        defaults.set(showingCodingOverview, forKey: "cbase.mobile.codingOverview")
        if let id = activeWorkspaceId {
            defaults.set(category.rawValue, forKey: "cbase.mobile.cat:\(id)")
            if let project = enteredProject {
                defaults.set([project.id, project.name], forKey: "cbase.mobile.proj:\(id)")
            } else {
                defaults.removeObject(forKey: "cbase.mobile.proj:\(id)")
            }
        }
    }

    /// Reloads the workspaces (including the setup state per project) 300 ms after the last project event.
    /// A removal of old containers is finished: from the `project/superseded` event or, if it was lost in a gap of the stream, from
    /// the sheet asking again (`GET …/superseded?state=1`, `last`; `nil` = no report any more, e.g. after a backend restart). The
    /// sheet hangs on the counter, the field on the end, the number `superseded` on the project list.
    func takeOverSuperseded(_ projectId: String, end: JSONValue?) {
        supersededEvents[projectId, default: 0] &+= 1
        supersededEnd[projectId] = end
        projectListSoon()
    }

    func projectListSoon() {
        projectListTask?.cancel()
        projectListTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await self?.loadWorkspaces()
        }
    }

    func loadWorkspaces(initial: Bool = false) async {
        guard let client else { return }
        if initial { loadingWorkspaces = true }
        do {
            let list: [Workspace] = try await client.get("/api/workspaces")
            workspaces = list
            workspaceError = ""
            if let id = activeWorkspaceId, list.contains(where: { $0.id == id }) {
                if initial { await enter(workspaceId: id, restore: true) }
            } else if let first = list.first, initial {
                await enter(workspaceId: first.id, restore: true)
            } else if !list.contains(where: { $0.id == activeWorkspaceId }) {
                activeWorkspaceId = nil
                overview = nil
            }
        } catch let apiError as APIError where apiError.isUnauthorized {
            workspaceError = apiError.message
        } catch {
            workspaceError = error.localizedDescription
        }
        loadingWorkspaces = false
    }

    /// Enter a workspace: restore category/project from the last visit.
    func enter(workspaceId: String, restore: Bool = false) async {
        let changed = workspaceId != activeWorkspaceId
        activeWorkspaceId = workspaceId
        if changed || restore {
            var restoredProject: EnteredProject?
            if restore, let saved = defaults.stringArray(forKey: "cbase.mobile.proj:\(workspaceId)"),
               saved.count == 2 {
                restoredProject = EnteredProject(id: saved[0], name: saved[1])
            }
            enteredProject = restoredProject
            let savedKind = defaults.string(forKey: "cbase.mobile.wfart:\(workspaceId)").flatMap(WorkflowKind.init(rawValue:))
            workflowKind = savedKind ?? .graph
            agentKind = defaults.string(forKey: "cbase.mobile.agentenart:\(workspaceId)").flatMap(AgentKind.init(rawValue:)) ?? .subagents
            if restore, let raw = defaults.string(forKey: "cbase.mobile.cat:\(workspaceId)"),
               raw == WorkspaceCategory.legacyDynworkflows {
                // Named legacy: the former category "Dynamic workflows" is now the kind "Dynamic".
                category = .workflows
                workflowKind = .dynamic
            } else if restore, let raw = defaults.string(forKey: "cbase.mobile.cat:\(workspaceId)"),
               let value = WorkspaceCategory(rawValue: raw) {
                category = value
            } else {
                category = .chats
            }
            selectedChatId = nil
            showingChatOverview = true
            appsSelectedProject = nil
        }
        rebuildScopeModels()
        persistScope()
        await reloadOverview()
    }

    func enterProject(_ project: Project) {
        enteredProject = EnteredProject(id: project.id, name: project.name)
        category = .chats
        selectedChatId = nil
        showingChatOverview = true
        rebuildScopeModels()
        persistScope()
        Task { await reloadOverview() }
    }

    /// "Open in the Code tab" from the outline: the code category of the (just entered) project, the tree expanded down to the repo.
    /// If the model does not exist yet (a remembered copy is loading, `waiting`), the wish waits until it does.
    func showCode(projectId: String, path: String) {
        guard enteredProject?.id == projectId else { return }
        select(category: .code)
        codeSub = .files
        if let m = codeModel { m.show(path) } else { codeTargetWaiting = (projectId, path) }
    }
    private var codeTargetWaiting: (projectId: String, path: String)?

    /// Per project the last applied (or already present on entering) end of an outline (`report.end.at`); missing = not yet read. An
    /// end is thus applied exactly once, even if the event was lost in the stream.
    private var layoutEndAt: [String: Double] = [:]

    /// Read the job's end and apply it to the Code, Git and Debug tabs if it is newer than the last one seen. `firstTime`: only
    /// remember it (an older end does not belong to what is open now).
    func bringAlongLayout(projectId: String, firstTime: Bool = false) async {
        guard let client else { return }
        struct Response: Decodable { let job: LayoutJob }
        var end: LayoutReport.End?
        do {
            let r: Response = try await client.get("/api/projects/\(projectId)/layout/job")
            end = r.job.state == "finished" ? r.job.report?.end : nil
        } catch let e as APIError where e.code == "NO_JOB" {
            end = nil
        } catch {
            return
        }
        let at = end?.at ?? 0
        let soFar = layoutEndAt[projectId]
        layoutEndAt[projectId] = max(at, soFar ?? 0)
        if firstTime && soFar == nil { return }
        guard let end, at > (soFar ?? 0) else { return }
        applyLayout(projectId: projectId, LayoutEnd(ways: end.ways ?? [], gone: end.gone ?? []))
    }

    /// The project's location in the viewed area: "" on its project route, its folder relative to the workspace on the workspace
    /// route; otherwise the area does not show the project.
    private func applyLayout(projectId: String, _ end: LayoutEnd) {
        let prefix: String
        if scopeApiBase == "/api/projects/\(projectId)" {
            prefix = ""
        } else if let ws = workspaces.first(where: { scopeApiBase == "/api/workspaces/\($0.id)" }),
                  let p = ws.projects.first(where: { $0.id == projectId }) {
            let root = ws.path.hasSuffix("/") ? String(ws.path.dropLast()) : ws.path
            guard p.path.hasPrefix(root + "/") else { return }
            prefix = String(p.path.dropFirst(root.count + 1)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        } else {
            return
        }
        codeModel?.afterLayout(end, prefix: prefix)
        gitModel?.afterLayout(end, prefix: prefix)
        debugModel?.afterLayout(end, prefix: prefix)
    }

    func leaveProject() {
        guard enteredProject != nil else { return }
        enteredProject = nil
        selectedChatId = nil
        showingChatOverview = true
        rebuildScopeModels()
        persistScope()
        Task { await reloadOverview() }
    }

    func select(category next: WorkspaceCategory) {
        guard categories.contains(next) else { return }
        category = next
        // Choosing a category means leaving the overview, from wherever (overview, right drawer, services menu of the header).
        showingCodingOverview = false
        visitedCategories.insert(next)
        persistScope()
    }

    /// Open a specific coding category: tab, category, leave the overview. The one path for the overview rows and cross-references.
    func openCoding(_ next: WorkspaceCategory) {
        select(tab: .workspaces)
        select(category: next)
    }

    /// Terminal and browser stay permanently mounted after the first visit (running commands and the screencast survive the
    /// category change), and not at all before, so unused panes build no connections.
    @Published private(set) var visitedCategories: Set<WorkspaceCategory> = [.chats]

    func hasVisited(_ category: WorkspaceCategory) -> Bool {
        visitedCategories.contains(category)
    }

    func select(tab next: HomeTab) {
        // A tap on "Coding" ALWAYS leads to the overview first: the tab is an area with many categories. A second tap on the already
        // active tab therefore also leads to the overview; the gesture "tap the tab again = go home" exists on iOS.
        if next == .workspaces { showingCodingOverview = true }
        tab = next
        persistScope()
    }

    /// Briefly fade in the content below the header (see `fadeIn`); call it in the same step as the switch.
    func fadeInContent() {
        fadeIn &+= 1
    }

    /// A CHOICE in a drawer closes it WITHOUT travel: the card is immediately back in its place and the new content fades in instead
    /// of the whole card sliding back sideways. Dragging, releasing, the tap next to the drawer and its ✕ keep travelling with the
    /// shell's spring (`AppShell.settleDrawer`). With both drawers closed the call does nothing; the same paths (`openChat`, …) also
    /// serve pages and pushes. `fadeIn: false` if no new content comes.
    func closeDrawersAfterChoice(fadeIn: Bool = true) {
        if drawers.closeWithoutTravel(), fadeIn { fadeInContent() }
    }

    func reloadOverview() async {
        guard let client, let id = activeWorkspaceId else {
            overview = nil
            return
        }
        do {
            overview = try await client.get("/api/workspaces/\(id)/overview")
        } catch {
            // The overview is display only; errors must not block navigation.
        }
    }

    /// On a scope change (workspace/project) rebuild all scope-bound models.
    private func rebuildScopeModels() {
        guard let client, let workspace = activeWorkspace else {
            chatList = nil
            terminals = nil
            codeModel = nil
            browserModel = nil
            gitModel = nil
            debugModel = nil
            codeInstance = nil
            // Reset the identifier too: otherwise the SAME scope, available again later, counts as "already built" and the models stay nil forever.
            scopeToken = ""
            return
        }
        let token = scopeKey
        guard token != scopeToken else { return }
        scopeToken = token
        chatList = WorkspaceChatsViewModel(client: client, workspaceId: workspace.id)
        browserModel = BrowserSessionModel(client: client, apiBase: scopeApiBase)
        // Code, Git, Debugger and Terminal follow the Code tab's instance choice; in the workspace and without a choice that is main, with
        // models and addresses as before. The choice reads the project list; until then what it says without a list applies (for a
        // remembered copy: wait, never briefly main without a label).
        if let project = enteredProject {
            let choice = CodeInstanceModel(client: client, projectId: project.id)
            choice.onSwitch = { [weak self] w in self?.buildCodeModels(w) }
            choice.unsaved = { [weak self] in self?.codeModel?.dirty == true ? 1 : 0 }
            codeInstance = choice
            choice.apply()
            Task { await choice.load() }
        } else {
            codeInstance = nil
            buildCodeModels(nil)
        }
        // The chat list MUST be kicked off here. Otherwise the fresh model sits in `loading`, and the permanently mounted chat overview's
        // `.task` does NOT fire again when the model is replaced. Whoever switched into a project and back saw the loading skeleton
        // forever.
        Task { await chatList?.startIfNeeded() }
    }

    /// The models of the Code tab (Code, Git, Debugger, Terminal) for the effective instance choice: nil or without a copy, main.
    /// If the choice is pending (list loading, copy remembered), they stay empty: the view then shows "Loading…".
    private func buildCodeModels(_ choice: CodeInstance.Choice?) {
        guard let client else { return }
        if choice?.waiting == true {
            codeModel = nil
            gitModel = nil
            debugModel = nil
            terminals = nil
            return
        }
        let param = choice?.param
        let copy = choice?.copy
        terminals = TerminalSessionsModel(client: client, apiBase: scopeApiBase, scopeKey: scopeKey, instance: param, copy: copy)
        let code = CodeBrowserModel(client: client, apiBase: scopeApiBase, instance: param, copy: copy)
        code.onError = { [weak self] e in self?.codeInstance?.error(e) }
        codeModel = code
        gitModel = GitModel(client: client, apiBase: scopeApiBase, scopeName: scopeName, instance: param)
        debugModel = DebugModel(client: client, apiBase: scopeApiBase, instance: param)
        if let z = codeTargetWaiting, enteredProject?.id == z.projectId {
            codeTargetWaiting = nil
            code.show(z.path)
        }
        if let pid = enteredProject?.id, layoutEndAt[pid] == nil { Task { await bringAlongLayout(projectId: pid, firstTime: true) } }
    }

    // ── Chat selection ──
    func openChat(_ id: String) {
        selectedChatId = id
        showingChatOverview = false
        showingCodingOverview = false
        unreadChats.remove(id)
        closeDrawersAfterChoice()
        category = .chats
        // Another chat (or the same one from the list after the view left it) opens through the list.
        if id != createdDraft?.id { createdDraft = nil }
        // The last entry's choice applies only to ITS draft; the next one without an entry starts at the default again.
        chatDraft = nil
        persistScope()
    }

    /// Open the chat and an agent in it (twin of `openAgent` in web/src/lib/agent-jump.ts): like `openChat(_:)`, plus the request
    /// that `MobileChatView` translates into the subagent sheet with exactly this agent.
    func openChat(_ id: String, agent agentId: String) {
        agentJump = agentId.isEmpty ? nil : AgentJump(chatId: id, agentId: agentId)
        openChat(id)
    }

    /// The values the draft view starts with: the last entry's choice, otherwise the entered project.
    var draftDefault: NewChatDraft {
        if let chatDraft { return chatDraft }
        var preset = NewChatDraft()
        preset.projectId = enteredProject?.id ?? ""
        return preset
    }

    /// `inFolder` starts the draft IN a chat folder; the chat is only created with the first message, so the folder binding must
    /// accompany the draft until then.
    func startNewChat(inFolder folderId: String? = nil) {
        var preset = NewChatDraft()
        preset.projectId = enteredProject?.id ?? ""
        preset.folderId = folderId ?? ""
        openDraft(preset)
    }

    /// Open the draft of a new chat: the ONE path for the drawer, the "New chat" sheet, the folder menu and "Start chat" on an
    /// instance. No `POST`: the chat is created on first send with exactly these values (`ChatViewModel.ensureServerChat`).
    func openDraft(_ preset: NewChatDraft) {
        if preset != draftDefault || createdDraft != nil { chatDraftIdentifier = UUID() }
        chatDraft = preset
        createdDraft = nil
        selectedChatId = nil
        showingChatOverview = false
        showingCodingOverview = false
        closeDrawersAfterChoice()
        category = .chats
        if !preset.folderId.isEmpty { revealChatFolder(preset.folderId) }
        persistScope()
    }

    /// The open draft was just created. The view stays (it holds history, stream and sending), the chat counts as the open one from
    /// now on; the list reloads after the first message (`ChatViewModel.afterFirstMessage`).
    func draftCreated(_ chat: Chat) {
        createdDraft = chat
        selectedChatId = chat.id
    }

    func showChatOverview() {
        showingChatOverview = true
        selectedChatId = nil
        closeDrawersAfterChoice()
    }

    // ── Notifications (service events) ──
    func markNotificationsRead(highestId: Int) {
        guard highestId > seenNotificationId else {
            unreadNotifications = 0
            return
        }
        seenNotificationId = highestId
        UserDefaults.standard.set(highestId, forKey: "cbase.mobile.notif-seen")
        unreadNotifications = 0
    }

    private func startNotificationPolling() {
        guard notificationsTask == nil, let client else { return }
        notificationsTask = Task { [weak self] in
            while !Task.isCancelled {
                if let response: ServiceEventsResponse = try? await client.get(
                    "/api/services/events",
                    query: [URLQueryItem(name: "since", value: "0")]
                ) {
                    await self?.applyNotifications(response.events)
                }
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
    }

    private func applyNotifications(_ events: [ServiceEvent]) {
        unreadNotifications = events.filter { $0.id > seenNotificationId }.count
    }

    // ── Global event stream (running chats / new answers) ──
    /// After the background: rebuild the global stream immediately instead of waiting until the system reports the sleeping
    /// connection as dead. Its first event ("init") carries the AUTHORITATIVE list of running chats. Without this, a stale
    /// "running" state stood for minutes after tapping a notification and then vanished abruptly once the stream eventually
    /// reconnected by itself.
    func restartEventStream() {
        eventsTask?.cancel()
        eventsTask = nil
        startEventStream()
    }

    private func startEventStream() {
        guard eventsTask == nil, let client else { return }
        eventsTask = Task { [weak self] in
            var retry: UInt64 = 500_000_000
            while !Task.isCancelled {
                do {
                    for try await event in client.stream("/api/events") {
                        await self?.handleGlobalEvent(event)
                    }
                    retry = 500_000_000
                } catch is CancellationError {
                    return
                } catch {
                    try? await Task.sleep(nanoseconds: retry)
                    retry = min(retry * 2, 8_000_000_000)
                }
            }
        }
    }

    private func handleGlobalEvent(_ event: JSONValue) {
        let type = event["type"]?.stringValue ?? ""
        if type == "init" {
            runningChats = Set(event["running"]?.arrayValue?.compactMap(\.stringValue) ?? [])
            // An older backend sends no `dynWorkflows`: "none known"; the events after it are still correct.
            var workflows: [String: Set<String>] = [:]
            for row in event["dynWorkflows"]?.arrayValue ?? [] {
                guard let chatId = row["chatId"]?.stringValue, !chatId.isEmpty,
                      let runId = row["runId"]?.stringValue, !runId.isEmpty else { continue }
                workflows[chatId, default: []].insert(runId)
            }
            workflowChats = workflows
            // Reconnected: an outline's end may have fallen into the gap.
            if let pid = enteredProject?.id, layoutEndAt[pid] != nil { Task { await bringAlongLayout(projectId: pid) } }
        } else if type == "run", let id = event["chatId"]?.stringValue {
            if event["running"]?.boolValue == true {
                runningChats.insert(id)
            } else {
                runningChats.remove(id)
                if event["answered"]?.boolValue == true, id != selectedChatId {
                    unreadChats.insert(id)
                }
                Task { await chatList?.load() }
            }
        } else if type == "dyn_workflow", let id = event["chatId"]?.stringValue, !id.isEmpty,
                  let runId = event["runId"]?.stringValue, !runId.isEmpty, let open = event["open"]?.boolValue {
            // Start and end of a run, counted per runId: one run's end does not stop the icon of a second run.
            var runs = workflowChats[id] ?? []
            if open { runs.insert(runId) } else { runs.remove(runId) }
            let fresh: Set<String>? = runs.isEmpty ? nil : runs
            if workflowChats[id] != fresh { workflowChats[id] = fresh } // publish only on change, so the list is not redrawn
        } else if type == "skills", let wid = event["workspaceId"]?.stringValue {
            // A mutation, an undo, a request or a decision: open skill pages and request cards in this workspace's chat reload
            // (`Models/SkillHistoryModels.swift`).
            SkillEvents.shared.report(workspaceId: wid)
        } else if type == "outer_loop" {
            outerLoopTick &+= 1
        } else if type == "instructions" {
            instructionsTick &+= 1
        } else if type == "timeline", let pid = event["projectId"]?.stringValue, !pid.isEmpty {
            timelineTick[pid, default: 0] &+= 1
        } else if type == "scheduled" {
            scheduledTick &+= 1
            Task { await chatList?.load() }
        } else if type == "preview/link" {
            previewTick &+= 1
        } else if type == "chat_title",
                  let id = event["chatId"]?.stringValue,
                  let title = event["title"]?.stringValue {
            chatList?.applyTitle(title, to: id)
        } else if type == "project/layout", let projectId = event["projectId"]?.stringValue {
            // The open "Outline" page hangs on this project's counter (job, check, end); the project list carries the job as a row, and a check
            // changes nothing there.
            layoutEvents[projectId, default: 0] &+= 1
            if event["kind"]?.stringValue != "check" { projectListSoon() }
            if event["kind"]?.stringValue == "finished" {
                // The Code, Git and Debug tabs move to the new paths (file, folder, chosen repo, breakpoints), via the job's end with its
                // timestamp, so it takes effect exactly once.
                Task { await bringAlongLayout(projectId: projectId) }
            }
        } else if type == "project/superseded", let projectId = event["projectId"]?.stringValue {
            // Removing old containers is done or failed: the number `superseded` on the project list and the open sheet
            // (`OldContainerRemove.swift`, hangs on the counter) reload.
            takeOverSuperseded(projectId, end: event)
        } else if type == "project/setup" || type == "project/upload" {
            // The setup of a new project went one step further: the project list carries its state.
            // A retroactive upload was placed, failed (also CONFLICT) or is interrupted: the same field `uploads`; without this branch the
            // row would stay on "placing files" until pull-to-refresh.
            projectListSoon()
        } else if type == "project/instance", let projectId = event["projectId"]?.stringValue {
            // The instance choice of a chat's git sheet (Chat/ChatGitBar.swift) hangs on this project's counter.
            instanceEvents[projectId, default: 0] &+= 1
            // "Container being created" → ready appears in the project list.
            projectListSoon()
            // A copy of this project became ready, paused or was cleaned up: the Code tab's choice rereads.
            if let choice = codeInstance, projectId == choice.projectId { Task { await choice.load() } }
        } else if type == "project/copy", let projectId = event["projectId"]?.stringValue {
            // The clean-up path silently deletes a copy's instance row and afterwards reports only `project/copy` (→ removed); without this
            // counter the git sheet's choice would keep its old own copy after a move out.
            instanceEvents[projectId, default: 0] &+= 1
            // `instance.copies` of the project list carries the chats' instance choice (composer, header): reread.
            projectListSoon()
        } else if type == "chat_archive" {
            // Archived or restored, by another client, with a folder, by a run, by the auto-archive. If it names the OPEN chat it takes effect
            // immediately and its bar appears at once; otherwise bundled (the auto-archive reports each chat individually). The kind
            // (`kind`) once decided whether the coding list reloads; a legacy conversation appears in no list now, and one reload too many
            // does no harm.
            let chatIds = event["chatIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
            reportArchive(chatIds, immediately: selectedChatId.map { chatIds.contains($0) } ?? false)
        }
    }

    /// The same notice as the `chat_archive` event, also for the OWN action, without waiting for the stream (it may be down; an open
    /// conversation would otherwise show the bar only the next time it opens). Own actions take effect at once (default);
    /// `sofort: false` sets only the event that names no open chat, and it is bundled (`archiveBundle`).
    func reportArchive(_ chatIds: [String], immediately: Bool = true) {
        archiveCollected += chatIds
        archiveBundle?.cancel()
        archiveBundle = nil
        guard !immediately else {
            archiveServe()
            return
        }
        archiveBundle = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.archiveBundleNs)
            guard !Task.isCancelled else { return }
            self?.archiveServe()
        }
    }

    /// What was collected as ONE notice: per id into `ArchiveNotices` (even bundled, no id is lost), then the coding list reloads (as at
    /// a run's end). The archive list and the open conversations read the counter themselves (`ArchiveList`, `ChatComposer`), once
    /// per bundle.
    private func archiveServe() {
        let chatIds = archiveCollected
        archiveCollected = []
        archiveBundle = nil
        archiveNotices.report(chatIds)
        Task { await chatList?.load() }
    }

    /// Open the target of a native notification. Workspace and project are in the payload because the last locally opened scope may
    /// differ from the chat that reported.
    func openPushPayload(_ payload: [AnyHashable: Any]) async {
        guard client != nil else {
            pendingPushPayload = payload
            return
        }
        let string = { (key: String) -> String in payload[key] as? String ?? "" }
        let workspaceId = string("workspaceId")
        let projectId = string("projectId")
        let chatId = string("chatId")
        // Every push carries `chatId` and opens through `openChat`.
        await openCodingChat(chatId, workspaceId: workspaceId, projectId: projectId)
    }

    /// Open a coding chat in its scope: first enter the chat's workspace and project, then the chat. The ONE path for a notification
    /// and for a chat the server creates ("Start service with agent"). An empty `chatId` only opens the scope.
    func openCodingChat(_ chatId: String, workspaceId: String, projectId: String) async {
        if !workspaceId.isEmpty, workspaceId != activeWorkspaceId {
            if workspaces.isEmpty { await loadWorkspaces(initial: false) }
            if workspaces.contains(where: { $0.id == workspaceId }) {
                await enter(workspaceId: workspaceId)
            }
        }
        if !projectId.isEmpty, enteredProject?.id != projectId {
            if overview == nil { await reloadOverview() }
            if let project = overview?.projects.first(where: { $0.id == projectId }) {
                enterProject(project)
            }
        } else if projectId.isEmpty, enteredProject != nil {
            // A workspace chat lies outside the currently open project. Without this switch the chat would be selected but not found in the
            // project chat list.
            leaveProject()
        }

        showNotifications = false
        tab = .workspaces
        if !chatId.isEmpty { openChat(chatId) }
    }
}

extension AppState {
    /// Opens the settings, optionally straight onto a page (`settingsJump`, e.g. "usage:codex").
    func openSettings(_ jump: String? = nil) {
        settingsJump = jump
        showSettings = true
    }
}
