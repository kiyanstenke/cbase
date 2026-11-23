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
    @State private var showDeleteAccount = false

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
                    // App Store guideline 5.1.1(v): the account can be deleted where it was created — in the app.
                    PaneCard {
                        Button(role: .destructive) {
                            showDeleteAccount = true
                        } label: {
                            Label(L("Delete account…"), systemImage: "trash")
                                .font(.subheadline.weight(.medium))
                        }
                        .accessibilityIdentifier("account-delete")
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
        .sheet(isPresented: $showDeleteAccount) {
            DeleteAccountSheet()
                .environmentObject(session)
                .environmentObject(state)
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

// ── Delete account ────────────────────────────────────────────────
// Re-authenticated with the password (POST /gw/account/delete). 403 (wrong password) and 409 (last admin) stay in the sheet as an
// inline error in the reader's language (`accountDeleteErrorText` by the response's code); on success SessionStore returns to the login and the sheet goes with the shell.
/// Shown from Profile → Account and from Settings → Account: one sheet, one deletion path.
struct DeleteAccountSheet: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var running = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    Text(L("All your workspaces, chats, projects and provider logins stored on this server are deleted. This cannot be undone."))
                        .font(.subheadline)
                    SecureField(L("Password"), text: $password)
                        .textContentType(.password)
                        .accessibilityIdentifier("account-delete-password")
                } footer: {
                    Text(L("Enter your password to confirm."))
                }
                if !error.isEmpty {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .font(.footnote)
                            .accessibilityElement(children: .combine) // ONE element for the tests (icon and text otherwise both carry the id)
                            .accessibilityIdentifier("account-delete-error")
                    }
                }
                Section {
                    Button(role: .destructive) {
                        Task { await run() }
                    } label: {
                        Text(running ? L("Deleting…") : L("Delete account"))
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(running || password.isEmpty)
                    .accessibilityIdentifier("account-delete-confirm")
                }
            }
            .navigationTitle(L("Delete account"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(label: L("Cancel"), locked: running) { dismiss() } }
        }
    }

    private func run() async {
        running = true
        error = ""
        do {
            try await session.deleteAccount(password: password)
            state.detach()
            dismiss()
        } catch {
            self.error = accountDeleteErrorText(error)
            running = false
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
