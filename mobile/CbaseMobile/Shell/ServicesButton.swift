import SwiftUI

// Ports and performance in the header — two buttons instead of `● n`. Each is shaped like the usage rings beside it:
// symbol + number, secondary, no capsule.
//   · PORTS (`status-services`, `accessibilityValue` = the number): symbol + number of the scope's running services,
//     muted and WITHOUT a number at 0. Popover `status-services-menu`: running services (tap ⇒ Apps with the project
//     selected), agent browsers as a section, "All services → Apps". iOS has no forwarding.
//   · PERFORMANCE (`status-performance`, `accessibilityValue` = the CPU count): symbol + the CPU of the measured
//     services — the shortest useful number on the iPhone, RAM is in the popover — and only if the header has room
//     (`ViewThatFits`; on the iPhone 17 with two rings the symbol alone, see below and `TopBar` in `AppShell.swift`).
//     The machine's color (over 70 % yellow, over 90 % red) goes on the symbol, otherwise neutral (`performanceColor`,
//     bound to `performanceTone` on the web). Without a measurement only the symbol, muted.
//     Popover `status-performance-menu`: resources with "measured: x of n" (`status-services-sum`,
//     `status-services-resource-<projectId>`) and the machine (`status-services-machine`).
//   · ONE state for both popovers (`open`) — never two at once.
//   · Before the scope's first load: NOTHING (empty is not unknown).
//   · The machine is the host behind the gateway (`/gw/host`) and nothing else — never the quota of the own container
//     (see `ServicesStatusModel.calculator`).
//   · The PERFORMANCE popover tells the model that it is open (`model.menu(open:)`): closed, the model asks without
//     folder size, on opening immediately with it. The ports popover shows no folder size and therefore reports nothing.
//   · No start/stop — that stays on Apps.
//   · Preview links: every running service row with a port carries "Share link" on the right (menu with 1 day · 7 days ·
//     30 days · unlimited); an active link sits below it with address, `ShareLink`, copy, revoke and remaining time; a
//     link on a DIFFERENT instance than the row's names it (assignment as on the web, `PreviewRules.assignment`). Rules,
//     model and pieces are in `PreviewLinks.swift`; the model belongs to the button (an error after closing stays, red
//     dot `preview-error-point`); a server without the routes (404) shows nothing.
//   · Instances: if a project has TWO or more instances (main and copies), its group appears in the performance popover
//     in its own "Instances" section (project name, below it "Main", "k1 (Chat X)" with state and load), and in the
//     ports popover under a service, where it runs. The section does NOT hang on the resources section (which shows only
//     with running services in main) — otherwise a service running only in the copy would hide the group and clearing.
//     Every copy (never main) can be cleared away — through the SAME sheet as "Delete copy" in the tab (`CopyDeleteSheet`,
//     Code/CopyDelete.swift: preview, chats, lock; `DELETE …/stack-copies/<name>` with the copy's NAME, `k1` from
//     `p1/copy-k1`). NO switching — that exists only on the Mac (port forwarding), iOS has none. Whether a group shows is
//     decided by ONE rule: `ServicesRules.groupRows`, which projects, `ServicesRules.instanceGroups`.
//
// Identifiers: `status-services` (ports button), `status-services-menu` (its popover),
// `status-services-row-<id>` (each running service), `status-agent-browsers` (agent-browser section),
// `status-services-apps`; `status-performance` (performance button), `status-performance-menu` (its popover),
// `status-services-sum`, `status-services-resource-<projectId>`, `status-services-machine`; instances:
// `status-services-instances-<projectId>` (the group), `status-instance-clear-away-<identifier>` (clear-away button per
// copy), `status-instance-notice` (result in the menu).
struct ServicesButton: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: ServicesStatusModel
    /// Which popover is open — ONE state for both, so never two at once.
    @State private var open: StatusMenu?
    /// Preview links: the model lives HERE, not in the popover — a create that fails only after closing (502 NGROK) keeps
    /// its notice that way, and the button carries a red dot until the next opening (`errorUnseen`).
    @StateObject private var preview = PreviewLinksModel()

    enum StatusMenu { case ports, performance }

    var body: some View {
        if model.loaded {
            HStack(spacing: 2) {
                portsButton
                performanceButton
            }
        }
    }

    /// The popover `menu` is open as long as `open` names it; if the system closes it (tap outside),
    /// `open` falls back — but only if it still means THIS one.
    private func bound(_ menu: StatusMenu) -> Binding<Bool> {
        Binding(
            get: { open == menu },
            set: { fresh in
                if fresh { open = menu } else if open == menu { open = nil }
            }
        )
    }

    private var portsButton: some View {
        let n = model.running.count
        return Button {
            open = .ports
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "server.rack")
                    .font(.symbol(11.5, weight: .medium))
                if n > 0 {
                    // Fixed like the whole status row of the TopBar (text size; guard exception).
                    Text(verbatim: "\(n)")
                        .font(.system(size: 10.5, weight: .medium))
                        .monospacedDigit()
                }
            }
            .foregroundStyle(.secondary)
            .overlay(alignment: .topTrailing) {
                if preview.errorUnseen && open != .ports {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 6, height: 6)
                        .offset(x: 3, y: -2)
                        .accessibilityIdentifier("preview-error-point")
                }
            }
            // Muted means: the button steps back but does not vanish — the popover carries the
            // agent browsers even without services of its own.
            .opacity(n > 0 ? 1 : 0.55)
            .padding(.horizontal, 4)
            .frame(minWidth: 26, minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Fixed like the rings: the service count never wraps and is never truncated — only the number on the
        // performance button (`ViewThatFits`) and the workspace name may give way.
        .fixedSize()
        .accessibilityIdentifier("status-services")
        .accessibilityLabel(portsLabel(n: n))
        .accessibilityValue(Text(verbatim: "\(n)"))
        .popover(isPresented: bound(.ports)) {
            PortsMenu(model: model, preview: preview) { open = nil }
                .environmentObject(state)
                // Without this line the iPhone turns the popover into a bottom sheet.
                .presentationCompactAdaptation(.popover)
        }
    }

    private var performanceButton: some View {
        let n = model.running.count
        let verdict = model.verdict
        let color = performanceColor(stage: verdict?.stage)
        // The same count as on the ports button (like `triggerContent` on the web): without running services
        // no service load — otherwise "3 %" would sit next to a muted ports button when the resources
        // report a freshly started container before the services.
        let cpu: String? = n > 0 ? model.sum.map { servicesCpuText($0.cpu) } : nil
        let muted = cpu == nil && color == nil
        let symbol = Image(systemName: "waveform.path.ecg")
            .font(.symbol(11.5, weight: .semibold))
            .foregroundStyle(color ?? Color.secondary)
        return Button {
            open = .performance
        } label: {
            // The number only if the header has room — otherwise the symbol alone (measured in the simulator: on the
            // iPhone 17 with two rings, about 40 pt were missing with "12.3 %"; the workspace name was truncated and
            // the rings' percentages wrapped to two lines). `ViewThatFits` takes the first variant that fits the
            // proposal; the TopBar computes the proposal (name first, rings and ports button fixed). The number
            // is in any case the `accessibilityValue` and in the popover.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 4) {
                    symbol
                    if let cpu {
                        // Fixed like the whole status row of the TopBar (text size; guard exception).
                        Text(verbatim: cpu)
                            .font(.system(size: 10.5, weight: .medium))
                            .monospacedDigit()
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                symbol
            }
            .foregroundStyle(.secondary)
            .opacity(muted ? 0.55 : 1)
            .padding(.horizontal, 4)
            .frame(minWidth: 26, minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("status-performance")
        .accessibilityLabel(performanceLabel(verdict: verdict))
        .accessibilityValue(Text(verbatim: cpu ?? ""))
        .popover(isPresented: bound(.performance)) {
            PerformanceMenu(model: model)
                .environmentObject(state)
                // On the popover's CONTENT, not on `open`: so what counts is what is really on screen — even
                // if the system closes the popover itself. On opening the model asks again immediately, this time
                // with folder size ("Project files" appears only here); closed, it is `disk=0` again (as on the web).
                .onAppear { model.menu(open: true) }
                .onDisappear { model.menu(open: false) }
                .presentationCompactAdaptation(.popover)
        }
    }

    /// The performance symbol's color — the counterpart of `performanceTone` on the web: only the machine
    /// colors it, warn yellow, danger red, otherwise no color of its own (`nil`: the button's tone). The number of
    /// services does not enter.
    private func performanceColor(stage: ServicesRules.Stage?) -> Color? {
        switch stage {
        case .danger: return .red
        case .warn: return .orange
        case .ok, .none: return nil
        }
    }

    /// The counterpart of the ports entry's `title` on the web: number and scope.
    private func portsLabel(n: Int) -> String {
        [servicesCountText(n), servicesScopeText(state)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The counterpart of the performance entry's `title`: "Performance", scope, the reason for the color.
    private func performanceLabel(verdict: ServicesRules.MachineVerdict?) -> String {
        var parts = [L("Performance"), servicesScopeText(state)]
        if let verdict {
            parts.append(servicesMachineSet(verdict))
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

// ── The ports popover ──────────────────────────────────────────────────────────────────────
/// Header, running services, agent browsers, "All services → Apps" — without forwarding (iOS has
/// none) and without resources and machine (those are in the performance popover).
private struct PortsMenu: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: ServicesStatusModel
    /// Preview links: loaded on opening and on `vorschau/link`, never on a timer. A server without the routes (404)
    /// shows none of it (`Shell/PreviewLinks.swift`). Owned by the button (`ServicesButton`) so that a notice
    /// survives closing.
    @ObservedObject var preview: PreviewLinksModel
    let close: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(L("Services · {scope}", ["scope": servicesScopeText(state)]))
                    .cbFont(14, weight: .semibold)
                    .lineLimit(2)
                    .padding(.horizontal, 14)
                    .padding(.top, 12)
                    .padding(.bottom, 6)

                if let notice = preview.notice {
                    Text(verbatim: notice)
                        .cbFont(11.5)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 6)
                        .accessibilityIdentifier("preview-notice")
                }

                serviceList

                if !model.agentBrowsers.isEmpty {
                    Divider().padding(.vertical, 4)
                    browserSection
                }

                Divider().padding(.top, 4)
                Button {
                    close()
                    state.appsSelectedProject = nil
                    state.select(tab: .apps)
                    state.fadeInContent()
                } label: {
                    Text(L("All services → Apps"))
                        .cbFont(13.5, weight: .medium)
                        .foregroundStyle(.tint)
                        .cbRow(vertical: 11)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("status-services-apps")
            }
            .padding(.bottom, 4)
            // Identifier on the container ONLY with `.contain`: otherwise it would propagate to every child and
            // overwrite the rows' identifiers (see CbKit).
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("status-services-menu")
        }
        .frame(minWidth: 290, idealWidth: 320)
        .frame(maxHeight: 520)
        .task {
            preview.client = state.client
            await preview.load()
        }
        .onChange(of: state.previewTick) {
            Task { await preview.load() }
        }
        // What arrived before closing was shown by the popover — the dot on the button covers only what came AFTER.
        .onDisappear { preview.errorUnseen = false }
    }

    /// A service's project from the workspace list (it carries the instance per project); `nil` if nobody knows it (yet). Then
    /// `PreviewRules.target` says "unknown" and there is no link (never guess).
    private func project(from service: ProjectServiceRow) -> Project? {
        state.workspaces.lazy.flatMap(\.projects).first { $0.id == service.projectId }
    }

    /// Without ngrok access: close the popover and open the settings (Integrations → ngrok). Only after closing —
    /// a sheet that should appear while a popover is being torn down otherwise does not show.
    private func toTheSettings() {
        close()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            state.showSettings = true
        }
    }

    // ── Running services ──
    @ViewBuilder
    private var serviceList: some View {
        CbOverline(L("Running services"))
            .padding(.horizontal, 14)
            .padding(.top, 4)
            .padding(.bottom, 2)
        if model.running.isEmpty {
            Text(L("No services running."))
                .cbFont(13)
                .foregroundStyle(.secondary)
                .cbRow(vertical: 8)
        }
        ForEach(model.running) { service in
            serviceRow(service)
        }
    }

    /// A running service row: the jump to Apps, beside it "Share link" (preview links, only with a port and a known
    /// target) and below it the active links of this service. The menu sits NEXT TO the row's button, not in it — a menu
    /// inside a button would never get the tap.
    @ViewBuilder
    private func serviceRow(_ service: ProjectServiceRow) -> some View {
        // Assignment as on the web (`linkOfTheRow`): only a link on EXACTLY this target hides "Share link"; links on
        // another instance still sit below and name it.
        let target = PreviewRules.target(service: service, project: project(from: service))
        let assignment = PreviewRules.assignment(projectId: service.projectId, serviceId: service.id, target: target, in: preview.snapshot?.active ?? [])
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                serviceButton(service)
                if assignment.own == nil {
                    PreviewShareButton(
                        model: preview,
                        service: service,
                        target: target,
                        toTheSettings: toTheSettings
                    )
                    .padding(.trailing, 6)
                }
            }
            ForEach([assignment.own].compactMap { $0 } + assignment.additional) { link in
                PreviewLinkRow(model: preview, link: link, foreignInstance: PreviewRules.foreignInstance(link, target: target))
                    .padding(.leading, 28)
                    .padding(.trailing, 8)
                    .padding(.bottom, 6)
            }
        }
    }

    private func serviceButton(_ service: ProjectServiceRow) -> some View {
        Button {
            close()
            // Apps selects the project via `appsSelectedProject` — the same state the left drawer
            // sets there.
            state.appsSelectedProject = service.projectId
            // Like choosing a place in the right drawer: without a transaction, the new content fades in.
            state.select(tab: .apps)
            state.fadeInContent()
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 6, height: 6)
                VStack(alignment: .leading, spacing: 1) {
                    Text(service.name)
                        .cbFont(13.5)
                        .lineLimit(1)
                    // In the whole workspace the project says WHOSE service it is; in an entered
                    // project it would be the same word every time.
                    if state.enteredProject == nil, !service.projectName.isEmpty {
                        Text(service.projectName)
                            .cbFont(10.5)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    // Only in a project with two or more instances: where the service runs.
                    if let location = servicesRunLocationText(service) {
                        Text(location)
                            .cbFont(10.5)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Text(verbatim: service.port.map { ":\($0)" } ?? service.container)
                    .cbFont(11, design: .monospaced)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.symbol(9, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
            .cbRow(vertical: 8)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("status-services-row-\(service.id)")
    }

    // ── Agent browsers (a section in the services popover) ──
    @ViewBuilder
    private var browserSection: some View {
        let n = model.agentBrowsers.count
        Button {
            close()
            state.openCoding(.browser)
            state.fadeInContent()
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Image(systemName: "globe")
                        .font(.symbol(11))
                    Text(n == 1 ? L("1 agent browser active") : L("{n} agent browsers active", ["n": n]))
                        .cbFont(13)
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.right")
                        .font(.symbol(9, weight: .bold))
                        .foregroundStyle(.tertiary)
                }
                .foregroundStyle(.tint)
                Text(model.agentBrowsers.map { $0.label.isEmpty ? $0.id : $0.label }.joined(separator: " · "))
                    .cbFont(11)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .cbRow(vertical: 8)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("status-agent-browsers")
    }
}

// ── The performance popover ────────────────────────────────────────────────────────────────
/// Header, resources of the measured services with "measured: x of n", the machine — reachable without scrolling,
/// because the services no longer sit above them.
private struct PerformanceMenu: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: ServicesStatusModel
    /// The copy whose delete sheet (`CopyDeleteSheet`) is currently open — `nil` without a sheet.
    @State private var toClearAway: ProjectInstance?
    /// The sentence for the last clear-away (requested), visible in the menu until the next one.
    @State private var notice: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: [L("Performance"), servicesScopeText(state)].filter { !$0.isEmpty }.joined(separator: " · "))
                    .cbFont(14, weight: .semibold)
                    .lineLimit(2)
                    .padding(.horizontal, 14)
                    .padding(.top, 12)
                    .padding(.bottom, 6)

                if let notice {
                    Text(verbatim: notice)
                        .cbFont(11.5)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 6)
                        .accessibilityIdentifier("status-instance-notice")
                }

                // The server at the VERY TOP — as on the web, before "Resources". With cbase's share per bar.
                if let calculator = model.calculator {
                    machineSection(calculator)
                }

                // Resources: with a measurement the sum and the counted rows. WITHOUT any measurement
                // but with running services the section still shows — only with "measured: 0 of
                // n services" and no numbers (said openly), so that nobody misses that none of the
                // running services is measured.
                // The row comes from `model.measureRow` — `nil` until the resources have answered. If the
                // section hung ONLY on "services are running", "measured: 0 of 3" would show before the
                // first answer and after every failed query.
                // WHETHER it shows is decided by `ServicesRules.resourcesSection` (like `resourcesSection`
                // on the web): running services AND (sum OR measureRow).
                // The count belongs to it because services and resources arrive as two queries: if the
                // resources reported a container before the services, the section would show with a
                // sum under "No services running.".
                if ServicesRules.resourcesSection(count: model.running.count, sum: model.sum, measureRow: model.measureRow) {
                    if model.calculator != nil {
                        Divider().padding(.vertical, 4)
                    }
                    resources(model.sum)
                }
                // Instances as a SEPARATE section, from all resource rows — not under the resources section: that one
                // shows only with running services IN MAIN, and a service running only in the copy would otherwise take
                // the group (and iOS's only clear-away button) its place.
                let groups = ServicesRules.instanceGroups(model.resources)
                if !groups.isEmpty {
                    if model.calculator != nil || ServicesRules.resourcesSection(count: model.running.count, sum: model.sum, measureRow: model.measureRow) {
                        Divider().padding(.vertical, 4)
                    }
                    instancesSection(groups)
                }
                // Nothing measured yet (before the first answer, or without `/gw/host`, without running services and
                // without instances): said openly instead of an empty surface.
                if model.calculator == nil, groups.isEmpty,
                   !ServicesRules.resourcesSection(count: model.running.count, sum: model.sum, measureRow: model.measureRow) {
                    Text(L("No measurements."))
                        .cbFont(13)
                        .foregroundStyle(.secondary)
                        .cbRow(vertical: 8)
                }
            }
            .padding(.bottom, 8)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("status-performance-menu")
        }
        .frame(minWidth: 290, idealWidth: 320)
        .frame(maxHeight: 520)
        // Clearing away opens the SAME sheet as "Delete copy" in the "Instances" tab (Code/CopyDelete.swift): what stays
        // and what goes (`ServicesRules.clearAwayHint`), per repo what lands as copy/<name>/… in main, the copy's chats,
        // and the lock with a list (409 INSTANCE_WORKING). The DELETE exists only there — two places for the same
        // thing: delete one.
        .sheet(item: $toClearAway) { instance in
            if let client = state.client {
                CopyDeleteSheet(client: client, identifier: instance.identifier) { text in
                    notice = text
                    Task { await model.refresh() }
                }
                .cbSheet(.half)
            }
        }
    }

    // ── A project's instances ──
    /// The "Instances" section: per project with copies (`ServicesRules.instanceGroups`) its group — regardless of whether
    /// services run in main.
    @ViewBuilder
    private func instancesSection(_ groups: [ProjectResourceRow]) -> some View {
        CbOverline(L("Instances"))
            .padding(.horizontal, 14)
            .padding(.top, 4)
            .padding(.bottom, 2)
        ForEach(groups) { row in
            instancesGroup(row)
        }
    }

    /// A project's group: its name, below it "Main", "k1 (Chat X)" … — only from two instances on
    /// (`ServicesRules.groupRows`), otherwise nothing: a project with main alone looks as it did before.
    @ViewBuilder
    private func instancesGroup(_ row: ProjectResourceRow) -> some View {
        let instances = ServicesRules.groupRows(row.instances)
        if !instances.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.name)
                    .cbFont(12.5, weight: .medium)
                    .lineLimit(1)
                ForEach(instances) { instance in
                    instanceRow(instance)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("status-services-instances-\(row.projectId)")
        }
    }

    private func instanceRow(_ instance: ProjectInstance) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: servicesInstanceTitle(instance))
                    .cbFont(12)
                    .lineLimit(1)
                Text(verbatim: servicesInstanceLast(instance))
                    .cbFont(10.5)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            // Only a copy can be cleared away — main has no button. If it is already being cleared, "being cleared away"
            // replaces the button (otherwise a second tap would ask and "request" again).
            if ServicesRules.copyTarget(identifier: instance.identifier) != nil {
                if ServicesRules.offerClearAway(state: instance.state) {
                    Button {
                        toClearAway = instance
                    } label: {
                        Image(systemName: "trash")
                            .font(.symbol(12))
                            .foregroundStyle(.red)
                            .frame(minWidth: 32, minHeight: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Remove copy"))
                    .accessibilityIdentifier("status-instance-clear-away-\(instance.identifier)")
                } else {
                    Text(L("being removed"))
                        .cbFont(11)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .accessibilityIdentifier("status-instance-gets-cleared-away-\(instance.identifier)")
                }
            }
        }
    }

    // ── Resources of the measured services ──
    /// `sum == nil` means: no resource row counts. Then only the heading and
    /// "measured: 0 of n services" show — no numbers, never "0 % · 0 B"; the caller calls
    /// this only if `ServicesRules.resourcesSection` says so (running services and a sum
    /// or a `measureRow`).
    @ViewBuilder
    private func resources(_ sum: ServicesRules.Sum?) -> some View {
        HStack(spacing: 6) {
            CbOverline(L("Resources"))
            Spacer(minLength: 6)
            if let sum {
                Text(verbatim: "\(servicesCpuText(sum.cpu)) · \(formatBytes(sum.memBytes))")
                    .cbFont(11, weight: .medium)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("status-services-sum")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 4)
        // Say openly what the numbers do NOT contain: services without a container or in projects
        // without a measurement are missing from the sum. Without a sum that is every running service.
        // Whether the row shows is decided in ONE place (`ServicesRules.measureRow` via
        // `model.measureRow`), not by a comparison of its own here.
        if let measurement = model.measureRow {
            Text(L("measured: {x} of {n} services", ["x": measurement.measured, "n": measurement.total]))
                .cbFont(11)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.top, 2)
        }
        // Exactly the rows the sum ran over (`Sum.projects`) — the rule which row counts lives ONCE in
        // `ServicesRules.sum`, not again here.
        ForEach(sum?.projects ?? []) { row in
            let capacity = row.memCapacity
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(row.name)
                        .cbFont(12.5, weight: .medium)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(row.containers == 1 ? L("1 container") : L("{n} containers", ["n": row.containers]))
                        .cbFont(10.5)
                        .foregroundStyle(.secondary)
                }
                HStack(alignment: .top, spacing: 10) {
                    value(Text(verbatim: "CPU"), servicesCpuText(row.cpu))
                    value(Text(verbatim: "RAM"), capacity > 0
                         ? "\(formatBytes(row.memBytes)) / \(formatBytes(capacity))"
                         : formatBytes(row.memBytes))
                    value(Text(L("Project files")), formatBytes(row.diskBytes))
                }
                if capacity > 0 {
                    ServicesProgressBar(share: row.memBytes / capacity)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            // ONE element per row (accessibility reads name, container and values in one go) —
            // and the identifier sits on that one instead of propagating to every text inside.
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("status-services-resource-\(row.projectId)")
        }
    }

    // ── Machine ──
    @ViewBuilder
    private func machineSection(_ calculator: MachineStatus) -> some View {
        HStack(spacing: 6) {
            CbOverline(servicesMachineName())
                .accessibilityIdentifier("status-services-machine")
            Spacer(minLength: 6)
            Text(L("in use"))
                .cbFont(10.5)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.top, 4)
        let ramOccupied = max(0, calculator.mem.totalBytes - calculator.mem.availableBytes)
        // cbase's part per bar (`CbaseRules.part`, bound to the web) — `nil` without a gateway measurement: then
        // single-part bars and no cbase row.
        let cbaseRam = CbaseRules.part(calculator, .ram)
        let cbaseLoad = CbaseRules.part(calculator, .load)
        let cbaseSwap = CbaseRules.part(calculator, .swap)
        let cbaseDisk = CbaseRules.part(calculator, .disk)
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)],
                  alignment: .leading, spacing: 9) {
            if calculator.mem.totalBytes > 0 {
                progressBarValue(Text(verbatim: "RAM"),
                           "\(formatBytes(ramOccupied)) / \(formatBytes(calculator.mem.totalBytes))",
                           share: ServicesRules.ramShare(calculator) ?? 0,
                           cbase: cbaseRam.map { ($0, servicesCbaseText(calculator, .ram, $0)) })
            }
            if let load = ServicesRules.loadShare(calculator) {
                // The load can exceed 100 % (more work than cores): the number says so, the
                // bar caps.
                progressBarValue(Text(verbatim: "CPU"),
                           "\(Int((load * 100).rounded())) % · \(L("{n} cores", ["n": calculator.cpu.count]))",
                           share: load,
                           cbase: cbaseLoad.map { ($0, servicesCbaseText(calculator, .load, $0)) })
            }
            if let swap = calculator.swap, swap.totalBytes > 0 {
                let occupied = max(0, swap.totalBytes - swap.freeBytes)
                progressBarValue(Text(verbatim: "Swap"),
                           "\(formatBytes(occupied)) / \(formatBytes(swap.totalBytes))",
                           share: occupied / swap.totalBytes,
                           cbase: cbaseSwap.map { ($0, servicesCbaseText(calculator, .swap, $0)) })
            }
            if let disk = calculator.disk, let share = ServicesRules.diskShare(calculator) {
                progressBarValue(Text(L("Disk")),
                           "\(formatBytes(max(0, disk.totalBytes - disk.freeBytes))) / \(formatBytes(disk.totalBytes))",
                           share: share,
                           cbase: cbaseDisk.map { ($0, servicesCbaseText(calculator, .disk, $0)) })
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, cbaseRam == nil && cbaseLoad == nil && cbaseSwap == nil && cbaseDisk == nil ? 8 : 4)
        // The legend ONCE in the block, in the colors of stage "ok" — in yellow and red the same split applies (solid = cbase,
        // lightened = the rest of the occupied part).
        if cbaseRam != nil || cbaseLoad != nil || cbaseSwap != nil || cbaseDisk != nil {
            HStack(spacing: 12) {
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 2).fill(Color.accentColor).frame(width: 8, height: 8)
                    Text(verbatim: "cbase")
                }
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 2).fill(Color.accentColor.opacity(ServicesProgressBar.otherOpacity)).frame(width: 8, height: 8)
                    Text(L("others"))
                }
            }
            .cbFont(10.5)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("status-cbase-legend")
        }
    }

    private func value(_ title: Text, _ count: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            title
                .cbFont(9, weight: .semibold)
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(verbatim: count)
                .cbFont(11, design: .monospaced)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Value, bar and — with a gateway measurement — the "cbase …" line below (part and finished text).
    private func progressBarValue(_ title: Text, _ count: String, share: Double, cbase: (CbaseRules.Part, String)? = nil) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            value(title, count)
            ServicesProgressBar(share: share, cbase: cbase?.0.share)
            if let text = cbase?.1 {
                Text(L("cbase {value}", ["value": text]))
                    .cbFont(10, design: .monospaced)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
    }
}

/// The value behind "cbase": bytes for RAM, swap, disk; for the CPU percent of the cores — like the load above ("15 %").
func servicesCbaseText(_ calculator: MachineStatus, _ kind: CbaseRules.Kind, _ part: CbaseRules.Part) -> String {
    switch kind {
    case .load:
        return "\(Int((part.value / Double(max(1, calculator.cpu.count)) * 100).rounded())) %"
    case .ram, .swap, .disk:
        // `formatBytes` shows the smallest as "1 kB" — a measured 0 means 0 here.
        return part.value == 0 ? "0 B" : formatBytes(part.value)
    }
}

/// Bar of the OCCUPIED part, colored with the same stage as the performance symbol — one scale, not two. Two-part when
/// the gateway knows cbase's share: from the left cbase in the stage's color, behind it the rest of the occupied part in
/// the same color, lightened — the stage stays the statement of the whole bar. `CbaseRules.progressBar` computes the split
/// (bound to `progressBarParts` on the web); without a cbase part single-part.
private struct ServicesProgressBar: View {
    let share: Double
    var cbase: Double? = nil
    /// The opacity of the "other" part — the same as `opacity-40` on the web, also in the legend.
    static let otherOpacity = 0.4

    var body: some View {
        let parts = CbaseRules.progressBar(share: share, cbase: cbase)
        GeometryReader { geo in
            let width = geo.size.width * parts.width / 100
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.18))
                if let part = parts.cbase {
                    HStack(spacing: 0) {
                        Rectangle().fill(color).frame(width: width * part / 100)
                        Rectangle().fill(color.opacity(Self.otherOpacity))
                    }
                    .frame(width: width)
                    .clipShape(Capsule())
                } else {
                    Capsule()
                        .fill(color)
                        .frame(width: width)
                }
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }

    private var color: Color {
        switch ServicesRules.stage(share) {
        case .danger: return .red
        case .warn: return .orange
        case .ok: return .accentColor
        }
    }
}

// ── Texts ──────────────────────────────────────────────────────────────────────────────────

/// "Workspace" or "Workspace › Project" — the same scope the header beside it shows.
@MainActor
func servicesScopeText(_ state: AppState) -> String {
    let workspace = state.activeWorkspace?.name ?? ""
    guard let project = state.enteredProject else { return workspace }
    return workspace.isEmpty ? project.name : "\(workspace) › \(project.name)"
}

func servicesCountText(_ n: Int) -> String {
    switch n {
    // No period: in accessibility the sentence sits in the middle of a row ("… · Workspace").
    case 0: return L("No services running")
    case 1: return L("1 service running")
    default: return L("{n} services running", ["n": n])
    }
}

/// An instance's name from its identifier "<project>/<instance>": the copy's name ("k1" from "p1/copy-k1", like the resources'
/// `name`), "Main" for main, otherwise the identifier itself (never guess).
func servicesInstanceName(_ identifier: String) -> String {
    if let target = ServicesRules.copyTarget(identifier: identifier) { return target.name }
    return identifier.hasSuffix("/main") ? L("Main") : identifier
}

/// "Main" or "k1 (Chat X)" — the copy with its chat's title, if it has one.
func servicesInstanceTitle(_ instance: ProjectInstance) -> String {
    let name = servicesInstanceName(instance.identifier)
    guard let chat = instance.chatTitle, !chat.isEmpty else { return name }
    return "\(name) (\(chat))"
}

/// State and load of an instance, e.g. "ready · 3 % · 210 MB"; without a state only the load.
func servicesInstanceLast(_ instance: ProjectInstance) -> String {
    let last = "\(servicesCpuText(instance.cpu)) · \(formatBytes(instance.memBytes))"
    return instance.state.isEmpty ? last : "\(instance.state) · \(last)"
}

/// "in Main, k1" — where a service runs; only in a project with two or more instances and only if it runs somewhere.
func servicesRunLocationText(_ service: ProjectServiceRow) -> String? {
    guard let list = service.instances, ServicesRules.group(count: list.count) else { return nil }
    let names = list.filter(\.running).map { servicesInstanceName($0.identifier) }
    guard !names.isEmpty else { return nil }
    return L("in {instances}", ["instances": names.joined(separator: ", ")])
}

/// CPU in percent with at most one decimal: "12 %", "12.3 %".
func servicesCpuText(_ cpu: Double) -> String {
    let rounded = (cpu * 10).rounded() / 10
    if rounded == rounded.rounded() { return "\(Int(rounded)) %" }
    return String(format: "%.1f %%", rounded)
}

/// "Server" — the app knows only gateway operation (`SessionStore.connect` requires `/gw/info`
/// with `gateway: true`), and there the machine is called that on the web too; "This machine" exists only in the
/// desktop client without a gateway. There is no fallback to the quota of the own container any more
/// (see `ServicesStatusModel.calculator`).
func servicesMachineName() -> String {
    L("Server")
}

/// The reason for the color, e.g. "Server: RAM 92 % used (14.7 GB / 16 GB)".
func servicesMachineSet(_ verdict: ServicesRules.MachineVerdict) -> String {
    let pct = Int((verdict.share * 100).rounded())
    let occupied = formatBytes(verdict.occupied)
    let total = formatBytes(verdict.total)
    let set: String
    switch verdict.kind {
    case .ram: set = L("RAM {pct} % used ({occupied} / {total})", ["pct": pct, "occupied": occupied, "total": total])
    case .load: set = L("CPU load {pct} % per core", ["pct": pct])
    case .disk: set = L("Disk {pct} % used ({occupied} / {total})", ["pct": pct, "occupied": occupied, "total": total])
    }
    return "\(servicesMachineName()): \(set)"
}
