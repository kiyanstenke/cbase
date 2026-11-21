import SwiftUI

// Profile page: account/server. Agent instructions per workspace/project live under Coding → Agents → Instructions
// (`Code/AgentInstructionsPane.swift`). The sub-view (`ProfileSubView`) remains as the pattern of the left drawer,
// today with the single section "Account".
struct ProfilePage: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        switch state.profileSub {
        case .account:
            AccountSection()
        }
    }
}

private struct AccountSection: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState
    @State private var showLogout = false
    @State private var showServerSwitch = false
    @State private var showAdministration = false

    var body: some View {
        PaneScaffold(title: L("Account"), subtitle: session.user?.username ?? "–") {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    PaneCard {
                        HStack {
                            Text(L("User")).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Text(session.user?.username ?? "–").font(.subheadline.weight(.medium))
                        }
                        HStack {
                            Text(L("Role")).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Text(session.user?.role == "admin" ? L("Admin##role") : L("User"))
                                .font(.subheadline.weight(.medium))
                        }
                    }
                    PaneCard {
                        SectionLabel(text: L("Server"))
                        Text(session.serverAddress)
                            .cbFont(12, design: .monospaced)
                            .textSelection(.enabled)
                        PillButton(title: L("Switch server"), systemImage: "network") {
                            showServerSwitch = true
                        }
                    }
                    // As in the desktop client: admins reach administration here. It is Settings → Administration,
                    // opened as a sheet — the same view, no second way.
                    if session.user?.role == "admin" {
                        PaneCard {
                            SectionLabel(text: L("Admin"))
                            Text(L("Users and resources per container"))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Button {
                                showAdministration = true
                            } label: {
                                Label(L("Open administration"), systemImage: "person.2.badge.gearshape")
                                    .font(.subheadline.weight(.medium))
                            }
                            .accessibilityIdentifier("account-admin")
                        }
                    }
                    PaneCard {
                        PillButton(title: L("Sign out"), systemImage: "rectangle.portrait.and.arrow.right", destructive: true) {
                            showLogout = true
                        }
                        .accessibilityIdentifier("account-logout")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
        }
        .sheet(isPresented: $showAdministration) {
            NavigationStack {
                AdministrationSettingsView()
                    .toolbar { SheetClose(label: L("Done")) { showAdministration = false } }
            }
            .environmentObject(session)
            .cbSheet(.whole)
        }
        .confirmationDialog(L("Sign out of cbase?"), isPresented: $showLogout, titleVisibility: .visible) {
            Button(L("Sign out"), role: .destructive) {
                state.detach()
                Task { await session.logout() }
            }
            Button(L("Cancel"), role: .cancel) {}
        }
        .confirmationDialog(L("Change server connection?"), isPresented: $showServerSwitch, titleVisibility: .visible) {
            Button(L("Switch server")) {
                state.detach()
                session.prepareServerChange()
            }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("You will return to the connection page. The current server address stays there for editing."))
        }
    }
}

// ── Left drawer: account ──────────────────────────────────────────
struct ProfileSidebar: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: L("Section"))
                ForEach(ProfileSubView.allCases, id: \.rawValue) { sub in
                    Button {
                        state.profileSub = sub
                        state.closeDrawersAfterChoice()
                    } label: {
                        HStack {
                            Text(L(sub.displayLabel))
                                .cbFont(13.5, weight: state.profileSub == sub ? .semibold : .regular)
                            Spacer()
                        }
                        .foregroundStyle(Color.primary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        // Selected neutrally like every drawer row.
                        .cbSelection(state.profileSub == sub, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("profile-sub-\(sub.rawValue)")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
    }
}
