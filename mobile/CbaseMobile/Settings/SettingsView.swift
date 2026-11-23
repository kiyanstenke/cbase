import SwiftUI
import UIKit

// Settings: the same pages as the desktop client, in the SAME GROUPS and order. The source of the order is
// `SETTINGS_GROUPS` in `web/src/components/settings/SettingsModal.tsx`:
//
//   Account & connections  provider · usage · integrations · environment
//   Behavior               models · hooks · browser · chats · workflows (pulled out of "Usage")
//   Appearance & device    appearance · notify · language
//   Administration         administration (admins only)
//
// Ten entries in one list are a list; in three groups they are an answer to "what am I looking for right now". A guard
// binds the two lists together (set, order and count): whoever adds a page here adds it there too.
//
// TWO named exceptions (both measured in web/test/settings-form.test.mjs): "Environment" is ALWAYS in the list on mobile, on
// the web only in gateway operation; the phone has no other operation, the app always talks to a server, never to a built-in
// backend. And the fourth group "Administration" shows on BOTH devices only for an admin, the only condition in this list.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var theme: ThemeStore
    /// The page a jump from outside leads to (`takeJump`); `nil` = the list.
    @State private var jump: SettingsJump?

    /// Target of a jump: page and, for "Usage", the subpage.
    struct SettingsJump: Hashable {
        let page: String
        let subpage: String?
    }

    var body: some View {
        NavigationStack {
            CbList {
                CbSettingGroup(title: L("Account & connections")) {
                    row(L("Providers"), "square.stack.3d.down.right", L("Sign in to and switch between Claude, Codex and OpenRouter")) {
                        ProviderSettingsView()
                    }
                    row(L("Usage"), "chart.bar", L("Quotas, API value and OpenRouter costs")) {
                        UsageSettingsView()
                    }
                    row(L("Integrations"), "link.badge.plus", L("GitLab for workflow triggers, ngrok for preview links")) {
                        IntegrationsSettingsView()
                    }
                    row(L("Environment"), "server.rack", L("Storage and status of your server environment")) {
                        EnvironmentSettingsView()
                    }
                }
                CbSettingGroup(title: L("Behavior")) {
                    row(L("Models"), "cpu", L("Models of the internal tasks")) {
                        AgentModelSettingsView()
                    }
                    row(L("Hooks"), "link", L("Shell commands on agent events")) {
                        HooksSettingsView()
                    }
                    row(L("Browser"), "globe", L("Built-in Playwright browser")) {
                        BrowserSettingsView()
                    }
                    row(L("Chats"), "archivebox", L("Archive old chats automatically")) {
                        ChatSettingsView()
                    }
                    row(L("Workflows"), "point.3.connected.trianglepath.dotted", L("Cap and size guideline of dynamic workflows")) {
                        WorkflowsSettingsView()
                    }
                }
                CbSettingGroup(title: L("Appearance & device")) {
                    row(L("Appearance"), "paintpalette", L("Color scheme and text size")) {
                        AppearanceSettingsView()
                    }
                    row(L("Notifications"), "bell", L("What reaches the iPhone — and whether it arrives")) {
                        NotificationSettingsView()
                    }
                    row(L("Language"), "character.bubble", L("German / English")) {
                        LanguageSettingsView()
                    }
                }
                if session.user?.role == "admin" {
                    CbSettingGroup(title: L("Admin")) {
                        row(L("Admin"), "person.2.badge.gearshape", L("Users and resources per container")) {
                            AdministrationSettingsView()
                        }
                    }
                }
                // About — NOT a group of the list above: those are bound one-to-one to `SETTINGS_GROUPS` on the web
                // (web/test/settings-form.test.mjs), and on the web the same two facts stand outside the groups too, in the
                // "Third-Party Notices" row at the foot of the modal (SettingsModal.tsx `HINTS`). Hence a footer section
                // without a header, the place iOS keeps licence and version in. The AGPL (section 13) asks that whoever uses
                // cbase over the network can reach its source; on the phone this is the only place that says so.
                Section {
                    aboutRow(L("License"), "doc.text", Self.licenseName, Self.licenseURL)
                    aboutRow(L("Source code"), "chevron.left.forwardslash.chevron.right", Self.sourceLabel, Self.sourceURL)
                }
            }
            .navigationTitle(L("Settings"))
            .navigationBarTitleDisplayMode(.inline)
            // The jump from outside (`AppState.settingsJump`, e.g. "usage:claude" from a ring in the header).
            .navigationDestination(item: $jump) { target in
                jumpTarget(target)
                    .environmentObject(session)
                    .environmentObject(state)
                    .environmentObject(theme)
            }
            .toolbar { SheetClose(label: L("Done")) { dismiss() } }
        }
        .environmentObject(session)
        .environmentObject(state)
        .onAppear { takeJump() }
        .onChange(of: state.settingsJump) { takeJump() }
    }

    /// A jump "<page>" or "<page>:<subpage>", read once and deleted (otherwise the settings would jump there again on the next
    /// open). Known are "usage" (contract `USAGE_PAGE`, with subpage) and "workflows"; an unknown jump opens the list.
    private func takeJump() {
        guard let raw = state.settingsJump else { return }
        state.settingsJump = nil
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        guard let page = parts.first, [UsageContract.usagePage, UsageContract.workflowsPage].contains(page) else { return }
        jump = SettingsJump(page: page, subpage: parts.count > 1 ? parts[1] : nil)
    }

    @ViewBuilder
    private func jumpTarget(_ target: SettingsJump) -> some View {
        if target.page == UsageContract.workflowsPage {
            WorkflowsSettingsView()
        } else {
            UsageSettingsView(start: target.subpage)
        }
    }

    @ViewBuilder
    private func row<Destination: View>(
        _ title: String,
        _ symbol: String,
        _ subtitle: String,
        @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
                .environmentObject(session)
                .environmentObject(state)
                // The color scheme needs the appearance page; without this line a pushed view crashes on `@EnvironmentObject var theme`.
                .environmentObject(theme)
        } label: {
            // `withInfo: false`: the hint here is a signpost, not explanatory text, and in the label of a `NavigationLink` an (i) would
            // never get the tap anyway, the whole cell is the button. Whoever wants to know more opens the page.
            CbSettingRow(title: title, hint: subtitle, symbol: symbol, withInfo: false)
        }
        .accessibilityIdentifier("settings-\(symbol)")
    }

    // ── About ──

    /// cbase's own licence and where its source is — the same values as `PROJECT` in `web/src/lib/thirdParty.ts`. They are
    /// facts about the program, not UI text, so they stay untranslated (`Text(verbatim:)` in the row).
    static let licenseName = "GNU AGPL-3.0-only"
    static let licenseURL = "https://www.gnu.org/licenses/agpl-3.0.html"
    static let sourceURL = "https://github.com/kiyanstenke/cbase"
    /// The address shortened to owner and name, for the row. Derived, not written out a second time: the address belongs in
    /// exactly one place here, and the cleanliness guard counts a bare “owner/name” outside a repository URL as private.
    static var sourceLabel: String { sourceURL.split(separator: "/").suffix(2).joined(separator: "/") }

    /// A row of the About section: it leads out of the app, so it is a `Link`, not a `NavigationLink` — and like the rows
    /// above it carries no (i) (`withInfo: false`): in the label of a link the whole cell is the button.
    ///
    /// `.foregroundStyle(CbColor.text)` on the link: a `Link` paints its whole label in the accent, which would make these two
    /// titles the only colored ones in the list. The symbol keeps the accent of the rows above it — it reads `.tint` inside
    /// `CbSettingRow` and that is untouched. `layoutPriority` goes to the value: without it the title takes the width first and
    /// the address ends up as "github....e/cbase", which is exactly the thing the row is here to say.
    @ViewBuilder
    private func aboutRow(_ title: String, _ symbol: String, _ value: String, _ address: String) -> some View {
        if let url = URL(string: address) {
            Link(destination: url) {
                CbSettingRow(title: title, symbol: symbol, withInfo: false) {
                    HStack(spacing: 5) {
                        Text(verbatim: value)
                            .font(.subheadline)
                            .foregroundStyle(CbColor.textMuted)
                            .lineLimit(1)
                        Image(systemName: "arrow.up.right")
                            .font(.symbol(12))
                            .foregroundStyle(CbColor.textMuted)
                    }
                    .layoutPriority(1)
                }
                .foregroundStyle(CbColor.text)
            }
            .accessibilityIdentifier("settings-about-\(symbol)")
        }
    }
}
