import SwiftUI

// The two global switches "Continue automatically at the limit" and "Start no new turn from N %" (the credit gate), plus
// the list of runs currently waiting for a limit reset — all three stand at the top of the usage page in the web client,
// BEFORE the subscription bars. That is where they belong: it is the answer to the question that comes first when you
// look at an almost empty quota ("and what happens when it is used up?").
//
// They sit on their own subpage "At the limit" of Usage (`UsageAtLimitView` in UsageSettings.swift), in both clients;
// the waiting list is tappable (jump into the chat).
//
// Two routes, not one: `/api/auto-continue` (on/off plus waiting list) and `/api/credit-gate` (on/off plus the percentage
// mark). They have different defaults and different side effects when switched off — a shared body would silently flip
// the other when one is toggled.
//
// Own file with own state and own loading — like the blocks of the hooks page: if the route fails, that must not drag
// down the quota bars next to it. An error here therefore does not turn the whole usage page red, but appears as one
// line in this section.
//
// Form language: system list style (Section/Toggle) like the rest of the settings area.
//
// Explicitly NOT here: countdown, attempt counter, "Try now" and "Cancel". That is the business of `ChatLimitStrip` in
// the affected chat, which shows exactly ONE waiting run and can therefore render it richly. This list is the overview
// of all, not its replacement.

// MARK: - Models

/// Response of `GET /api/auto-continue`: the global setting plus ALL waiting runs.
///
/// Do not confuse with `LimitWaitResponse` — that carries the ONE waiting run of a chat (`{wait, enabled}`) and belongs to
/// the chat route. Two contracts in one struct drift apart at the next rework.
struct AutoContinueDoc: Decodable, Sendable {
    let enabled: Bool
    let waiting: [LimitWaitState]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The server default is ON (`getSetting("auto_continue", "1") !== "0"`). A missing field must therefore never be
        // read as "off".
        enabled = c.bool(.enabled, true)
        waiting = c.list(.waiting, LimitWaitState.self)
    }

    enum CodingKeys: String, CodingKey { case enabled, waiting }
}

/// Response of the switch (`PUT /api/auto-continue`): `{ ok, enabled }`. The waiting list does NOT come along — when
/// switching on it has to be reloaded.
struct AutoContinueToggleResponse: Decodable, Sendable {
    let enabled: Bool

    init(from decoder: Decoder) throws {
        enabled = try decoder.container(keyedBy: CodingKeys.self).bool(.enabled, true)
    }

    enum CodingKeys: String, CodingKey { case enabled }
}

/// The credit gate is its OWN route (`GET`/`PUT /api/credit-gate`), not a second field on the auto-continue switch: it is
/// a setting of its own with its own default (OFF, while auto-continue is ON) and its own side effect when switched off.
///
/// `threshold` is the percentage from which nothing new starts. It comes from the server so the label does not maintain a
/// second 99 of its own — one number, one source. Default 99 here nonetheless: a label without a number would be
/// pointless, and 99 is the value the server carries today.
struct CreditGateDoc: Decodable, Sendable {
    let enabled: Bool
    let threshold: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Default OFF: the server reads missing as off as well (`getSetting(…, "0") === "1"`).
        enabled = c.bool(.enabled)
        threshold = c.int(.threshold, 99)
    }

    enum CodingKeys: String, CodingKey { case enabled, threshold }
}

/// Exactly the fields needed to jump into the waiting chat. Only coding chats exist.
struct AutoContinueChatTarget: Decodable, Sendable {
    let id: String
    let workspaceId: String
    let projectId: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        workspaceId = c.str(.workspaceId)
        projectId = c.str(.projectId)
    }

    enum CodingKeys: String, CodingKey { case id, workspaceId, projectId }
}

// MARK: - View

/// Is hung into the usage page's `List` and delivers one or two `Section`s: the switch always, the waiting list only if
/// something is really waiting. An empty box "Waiting for a reset" would be a claim without content.
struct AutoContinueSection: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState

    /// `nil` means "not loaded yet" — NOT "off". The server default is ON, and a briefly flashing "off" would be a lie
    /// about a setting that costs money and waiting time. `on != false` is therefore rendered: `nil` looks like ON but is
    /// locked.
    @State private var on: Bool?
    /// The credit gate. Again `nil` = not loaded yet — and it shows that way: instead of a locked switch at OFF the row
    /// shows "—". A gate whose query failed is not off, it is unknown; a switch at OFF would claim the account ran
    /// unchecked while the server has long been holding it. For the same reason a failure does NOT fall back to `false`
    /// but leaves `nil`.
    @State private var gate: Bool?
    /// The gate's percentage mark — comes from the server so the label does not maintain a second 99 of its own. 99 as
    /// the initial value because a label without a number would be none.
    @State private var threshold = 99
    @State private var waiting: [LimitWaitState] = []
    /// Set only when BOTH queries succeeded: the mark locks the `.task` for the whole section, and the auto-continue
    /// branch alone used to write it — a failed gate query then stayed for the lifetime of the page without retry. A
    /// failure on either route should be retried the next time the row appears.
    @State private var loaded = false
    @State private var toggles = false
    @State private var error = ""

    // The row form of the settings kit: title, below it up to THREE lines of hint, on the right the switch. The two labels
    // were the longest of all the settings (nine and six lines) and pushed every number of the usage page below the edge.
    // The wording is unchanged — it is only truncated, and the (i) at the title shows it in full.
    var body: some View {
        Group {
            CbSettingGroup(title: L("Behavior at the limit")) {
                CbSettingRow(
                    title: L("Continue automatically when the limit resets"),
                    // Wording identical to the web client: the old sentence promised "exactly then" and "one chat", while
                    // workflow, schedule and scheduled job park the same way and after twelve continuations it is over.
                    hint: L("When a chat, a workflow or a scheduled task runs into the 5-hour or weekly limit, the work is parked and resumed as soon as the limit resets — even across a restart. After 12 consecutive continuations it gives up. Usage credits and spend caps do not recover on their own, so those are not waited on. Switching this off discards waiting continuations — except those parked by the usage gate, which belong to the switch below.")
                ) {
                    Toggle("", isOn: Binding(
                        get: { on != false },
                        set: { value in
                            // The optimistic value belongs SYNCHRONOUSLY in the setter, not in the task: SwiftUI reads the
                            // binding back in the same pass, the task runs only afterwards. Whoever flips it only there sees
                            // the switch snap back and a blink later jump again by itself. A switch that wobbles twice looks
                            // broken.
                            on = value
                            Task { await toggle(value) }
                        }
                    ))
                    .labelsHidden()
                    // The label stays on the switch although it no longer sits on it: without it a screen reader would say
                    // only "switch", and the test rig reads the mark from exactly this label.
                    .accessibilityLabel(L("Continue automatically when the limit resets"))
                    .disabled(on == nil || toggles)
                    .accessibilityIdentifier("usage-auto-continue-toggle")
                }
                // Loading hangs on this ROW, not on the section: a modifier on a section is delicate in a List, a row is
                // unquestionably a row. And this row always stands.
                .task {
                    guard !loaded else { return }
                    await load()
                }

                // The credit gate stands NEXT TO the switch above, in the same group: it is the second half of the same
                // question ("and what happens when it is used up?"), only with the opposite sign — one waits for the reset,
                // the other starts nothing new at all.
                //
                // The label says explicitly what cbase can NOT do. Whether credit is consumed beyond the window is decided
                // by the provider's server and communicated only in the response headers of the model request; there is no
                // flag for it. A promise of "no credit" would be a lie, and the hard stop sits in the account — that is
                // what it points to.
                CbSettingRow(title: gateTitle, hint: gateHint) {
                    if let gateState = gate {
                        Toggle("", isOn: Binding(
                            get: { gateState },
                            set: { value in
                                gate = value               // synchronous, for the same reason as above
                                Task { await gateToggle(value) }
                            }
                        ))
                        .labelsHidden()
                        // The test rig reads the server's percentage mark from THIS label — a toggle pulls its label into its
                        // own accessibility element.
                        .accessibilityLabel(gateTitle)
                        .disabled(toggles)
                        .accessibilityIdentifier("usage-credit-gate-toggle")
                    } else {
                        // Unknown is not OFF: while the query is pending or failed, "—" is shown instead of a locked switch at
                        // OFF. A toggle has no third state; the dash is the honest answer, and the `.task` on the row above
                        // retries at the next appearance because `loaded` is not set without this response.
                        Text("—")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(gateTitle)
                            .accessibilityIdentifier("usage-credit-gate-unknown")
                    }
                }

                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("usage-auto-continue-error")
                }
            }

            if !waiting.isEmpty {
                CbSettingGroup(
                    title: L("Waiting for a reset"),
                    hint: L("Tap to open the chat that is waiting.")
                ) {
                    ForEach(waiting) { waiting in row(waiting) }
                }
            }
        }
    }

    /// Title and hint of the gate — built ONCE because both appear in two places (at the switch and at the "—" row while the
    /// state is unknown). Two copies would drift apart at the next wording.
    ///
    /// Wording identical to the web client ("Do not start a new turn above {p}%"). The percentage mark stays `{p}` from the
    /// server — one number, one source.
    private var gateTitle: String {
        L("Do not start a new turn above {p}%", ["p": threshold])
    }

    /// Two paragraphs in ONE hint, separated by a blank line — as on the web: the first says WHAT is parked (not just the
    /// turn: the verdict too, and independently of the switch above), the second what cbase can NOT do. The truncated row
    /// reads them as running text, the popover at the (i) shows both. Both sentences remain keys of their own.
    private var gateHint: String {
        L("Once the blocking time window is {p} percent full, cbase starts no new model work — no turn, no verdict — but parks it until the reset, regardless of the switch above. The chat then offers a button that releases this one turn, including its subagents.", ["p": threshold])
            + "\n\n"
            + L("cbase prevents the START — not the credit spend of work that is already running: the provider's server decides that. The hard stop lives in your account. Applies to Claude only: Codex reports its utilization only after a run, third-party providers have no windows.")
    }

    /// A waiting row.
    ///
    /// The server delivers NEITHER chat title NOR workspace for a waiting run (the row carries only its `chatId`) — the
    /// header is therefore the limit, exactly as in the web client. Inventing a title is impossible, and loading one per
    /// row would be a call for information the desktop does not give either.
    ///
    /// The provider stands next to it if the server names it: two chats at the same limit would otherwise give two
    /// identical-looking rows. As text, not as `ProviderMark` — the mark knows only Claude and Codex and would show a
    /// wrong one for a third-party provider.
    private func row(_ waiting: LimitWaitState) -> some View {
        Button {
            Task { await chatOpen(waiting) }
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(waiting.limitText)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text(subtitle(waiting))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                if !waiting.provider.isEmpty {
                    Text(waiting.provider)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary.opacity(0.6))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The identifier belongs on the button, not on the stack inside: on a stack without an accessibility element of
        // its own it moves to every child.
        .accessibilityIdentifier("usage-limit-wait-\(waiting.chatId)")
    }

    /// With `reason == "probe"` the server does NOT know the reset — no clock time may be shown: `dueAt` is there only the
    /// next probe time, not a promise. `dueAt == 0` falls into the same branch, otherwise a broken row would show
    /// "01/01/1970".
    ///
    /// A verdict catch-up deliberately reads like "run": for the user the flow simply continues. The desktop does the
    /// same.
    private func subtitle(_ waiting: LimitWaitState) -> String {
        // Third case beside "probe" and a broken row: the credit gate without a known reset. It carries `gate`,
        // `resetsAt == 0` and as `dueAt` only the next probe time — a clock time from it would be an invented promise.
        let text: String
        if waiting.reason == "probe" || waiting.dueAt <= 0 || (waiting.gate && (waiting.resetsAt ?? 0) <= 0) {
            text = L("Reset time unknown — checking back regularly.")
        } else {
            let due = Date(timeIntervalSince1970: waiting.dueAt / 1000)
            let when: [String: CustomStringConvertible] = ["time": locWeekdayTime(due)]
            text = waiting.kind == "compact"
                ? L("Compacting at {time}", when)
                : L("Continuing at {time}", when)
        }
        // Parked by the gate means: the limit was NOT reached, cbase merely did not start. Without this suffix the row would
        // look like a limit that hit, and the user would look for the fault at the provider instead of in their own setting.
        // It belongs on the row without a known reset too — that one is otherwise not explained at all.
        return waiting.gate ? "\(L("Credit gate")) · \(text)" : text
    }

    // MARK: - Calls

    /// A failure assumes the server default (ON) and leaves the list empty instead of showing a red row: this section is
    /// the side stage of the usage page, and an unreachable side stage must not look like a quota outage. An error becomes
    /// visible only when SWITCHING — there someone wanted something.
    private func load() async {
        // Without a connection the gate is UNKNOWN too — `gate` stays `nil` and shows "—" instead of falling to OFF.
        guard let client = session.client else { on = true; return }
        var bothPresent = true
        if let doc: AutoContinueDoc = try? await client.get("/api/auto-continue") {
            on = doc.enabled
            waiting = doc.waiting
        } else {
            on = true
            waiting = []
            bothPresent = false
        }
        // Two routes, two settings: if one fails, the other stays operable (a switch locked by a foreign failure would be
        // indistinguishable from a broken one). `loaded` is ONE mark for both, though, and it locks the retry — so it is set
        // only when BOTH have answered (it used to come from the branch above alone, and a failed gate query stayed as "OFF"
        // for the lifetime of the page). A failure leaves `gate` untouched: `nil` on the first query (row shows "—"),
        // otherwise the last confirmed state — after a toggle the truth comes from the PUT response, and a lame GET
        // afterwards must not turn it back to unknown.
        if let doc: CreditGateDoc = try? await client.get("/api/credit-gate") {
            gate = doc.enabled
            threshold = doc.threshold
        } else {
            bothPresent = false
        }
        loaded = bothPresent
    }

    /// The optimistic value has already been set by the binding setter; here it is only about confirming or revoking it.
    ///
    /// It is always revoked to `!value`, never to a remembered previous state: the switch is two-valued, and the VISIBLE
    /// state before the tap was by definition the opposite of what was just chosen — from `nil` too, which looks like ON,
    /// one can only switch to OFF. A remembered value would be the new one anyway since the setter.
    private func toggle(_ value: Bool) async {
        error = ""
        guard let client = session.client else {
            // Without a connection NOTHING is saved. Leaving the switch in its new position would be a lie about a setting
            // that costs waiting time; letting it snap back wordlessly would look like a user's slip. So both: back AND a
            // line naming the reason.
            on = !value
            error = L("No connection to the server — the setting was not saved.")
            return
        }
        // The server reads EVERYTHING except `false`, `"0"` and `0` as ON — an empty body too. A synthesized Encodable that
        // omits a `nil` field would thus switch on by accident; the body therefore carries an explicit real Bool.
        struct Body: Encodable { let enabled: Bool }
        toggles = true
        defer { toggles = false }
        do {
            let response: AutoContinueToggleResponse = try await client.put(
                "/api/auto-continue", body: Body(enabled: value))
            on = response.enabled        // the server truth wins over the optimistic value
            // Reload in BOTH directions: the waiting list does not come with the response, and switching off discards only
            // the time-limit rows — those parked by the credit gate belong to the switch below and stay. The view used to
            // empty the list by hand ("a second way to the same empty list") and thereby claimed nothing was waiting any
            // more while the server still carried the gate rows. The web client reloads for the same reason.
            await load()
        } catch {
            // Back to the visible state from before, NOT to nil — otherwise the switch would be locked after an error, and
            // one could no longer get out of the wrong state.
            on = !value
            self.error = L("The setting could not be saved.")
        }
    }

    /// The same pattern for the credit gate, only against its own route.
    ///
    /// When switching OFF the server releases the runs already parked by the gate. The waiting list is therefore RELOADED
    /// here — unlike when switching on, where nothing arises that could be seen immediately: the gate takes effect only at
    /// the next start attempt.
    private func gateToggle(_ value: Bool) async {
        error = ""
        guard let client = session.client else {
            gate = !value
            error = L("No connection to the server — the setting was not saved.")
            return
        }
        struct Body: Encodable { let enabled: Bool }
        toggles = true
        defer { toggles = false }
        do {
            let response: CreditGateDoc = try await client.put(
                "/api/credit-gate", body: Body(enabled: value))
            gate = response.enabled
            threshold = response.threshold
            if !value { await load() }
        } catch {
            gate = !value
            self.error = L("The setting could not be saved.")
        }
    }

    /// Jump to the waiting chat.
    ///
    /// The waiting row carries only its `chatId`; workspace and project appear only in this response — and both decide where
    /// the chat can be found at all. The jump goes via `openPushPayload`, that is, the ONE path an iPhone notification takes
    /// too: it switches the workspace and enters or leaves the project. A second rebuild from `enter` + `select(tab:)` +
    /// `openChat` could not do that and would drift apart at the next rework.
    ///
    /// What `openPushPayload` alone can NOT do therefore comes first: it switches the workspace only into one listed in
    /// `state.workspaces`, and reloads that list only if it is EMPTY. A non-empty but stale list passes both checks — and
    /// the waiting chat would open in the currently open, WRONG workspace. This is exactly where the two views diverge:
    /// the waiting row is global, the device's workspace list is the state of the last fetch.
    private func chatOpen(_ waiting: LimitWaitState) async {
        guard let client = session.client else { return }
        error = ""
        // Deleted chat (404): silently do nothing. An error message here would explain nothing that the vanished entry
        // does not settle itself at the next load.
        guard let target: AutoContinueChatTarget = try? await client.get("/api/chats/\(waiting.chatId)"),
              !target.id.isEmpty else { return }

        // Unknown target workspace: refresh the list once. A workspace added since the last fetch is the most common
        // case — and the only one a reload heals.
        let foreign = !target.workspaceId.isEmpty && target.workspaceId != state.activeWorkspaceId
        if foreign, !state.workspaces.contains(where: { $0.id == target.workspaceId }) {
            await state.loadWorkspaces()
        }
        if foreign, !state.workspaces.contains(where: { $0.id == target.workspaceId }) {
            // Unknown even after refreshing: this login does not see the workspace. Then we must NOT jump — the chat would
            // open in the current workspace, and that would be the wrong one. It is said nonetheless: a silent slip is
            // indistinguishable from a dead button.
            error = L("The waiting chat sits in a workspace this login cannot see.")
            return
        }

        // Always the coding chat: a manager conversation no longer starts a turn (that kind is read-only) and therefore
        // waits at no limit.
        let payload: [AnyHashable: Any] = ["workspaceId": target.workspaceId, "projectId": target.projectId, "chatId": target.id]
        // Close the settings sheet first: the jump acts on the view BEHIND it, which one would not see otherwise.
        state.showSettings = false
        await state.openPushPayload(payload)
    }
}
