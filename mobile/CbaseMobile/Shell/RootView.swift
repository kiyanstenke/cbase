import SwiftUI
import UIKit

struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    /// Boot splash as in the desktop client — runs once per cold start over everything,
    /// while `bootstrap()` sets up the connection in the background.
    @State private var showBootSplash = BootSplashView.isEnabled

    var body: some View {
        ZStack {
            Group {
                switch session.phase {
                case .connecting:
                    LoadingScreen(title: L("Connecting to cbase…"))
                case .startingEnvironment:
                    LoadingScreen(title: L("Starting your server environment…"))
                case .needsLogin(let setup):
                    LoginView(setup: setup)
                case .connectionFailed(let message):
                    ConnectionView(error: message)
                case .ready:
                    AppShell()
                }
            }
            .animation(.easeInOut(duration: 0.2), value: session.phase)

            if showBootSplash {
                BootSplashView { showBootSplash = false }
                    .zIndex(10)
            }
        }
        .task { await session.bootstrap() }
        // Adjust: the floating indicator at the bottom center — running · done · error.
        // At the root, so that it stays above every page after the sheet closes.
        .overlay(alignment: .bottom) {
            AdjustToast()
                .padding(.horizontal, 16)
                .padding(.bottom, 74)
        }
    }
}

// Boot splash at app start, identical to the desktop app (web/src/components/BootSplash.tsx):
// the lens and "cbase" beside it, centered, nothing else. It is deliberately SHORT (under a
// second) — it only masks the connection setup that RootView does in the background meanwhile,
// and is no show.
struct BootSplashView: View {
    /// UI tests switch the splash off with a launch argument: `-cbase.mobile.boot-splash 0`.
    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: "cbase.mobile.boot-splash") == nil
            || UserDefaults.standard.bool(forKey: "cbase.mobile.boot-splash")
    }

    let onFinished: () -> Void

    @State private var entered = false
    @State private var fading = false

    /// The same values as on the web (BootSplash.tsx): fade in, hold, fade out.
    private static let fadeInS: Double = 0.30
    private static let holdNs: UInt64 = 700_000_000
    private static let hideS: Double = 0.30

    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()

            lockup
                .opacity(entered ? 1 : 0)
                .scaleEffect(entered ? 1 : 0.95)
                .offset(y: entered ? 0 : 6)
                .animation(.easeOut(duration: Self.fadeInS), value: entered)
        }
        .opacity(fading ? 0 : 1)
        .allowsHitTesting(!fading)
        .accessibilityHidden(true)
        .task {
            // Leave one frame (like requestAnimationFrame on the web), then fade in.
            try? await Task.sleep(nanoseconds: 40_000_000)
            guard !Task.isCancelled else { return }
            entered = true
            try? await Task.sleep(nanoseconds: Self.holdNs)
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: Self.hideS)) { fading = true }
            try? await Task.sleep(nanoseconds: UInt64(Self.hideS * 1_000_000_000))
            guard !Task.isCancelled else { return }
            onFinished()
        }
    }

    private var lockup: some View {
        HStack(spacing: 14) {
            CbaseLogo(size: 62)
            Text("cbase")
                .cbFont(42, weight: .bold)
                .foregroundStyle(.primary)
        }
    }
}

/// The mark INSIDE the app is always the lens — never the app-icon tile: its dark ground
/// belongs on the home screen, not in a light view. `HexagonMark` remains alongside,
/// but is something else: an ink-colored symbol for run states.
struct CbaseLogo: View {
    var size: CGFloat = 32

    var body: some View {
        Image("CbaseLens")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct LoadingScreen: View {
    let title: String

    var body: some View {
        VStack(spacing: 18) {
            HexagonMark()
                .frame(width: 42, height: 42)
                .foregroundStyle(.tint)
                .symbolEffect(.rotate, options: .repeat(.continuous))
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CbColor.ground)
    }
}

struct HexagonMark: View {
    var body: some View {
        Image(systemName: "hexagon")
            .resizable()
            .scaledToFit()
    }
}

struct ConnectionView: View {
    @EnvironmentObject private var session: SessionStore
    let error: String?
    @State private var address = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField("https://server.example", text: $address)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { Task { await apply() } }
                        .accessibilityIdentifier("server-address")
                } header: {
                    Text(L("API base"))
                } footer: {
                    Text(L("The app expects a cbase gateway with /gw/info and then uses the same account session as the desktop client."))
                }

                if let error, !error.isEmpty {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await apply() }
                    } label: {
                        Label(L("Connect"), systemImage: "arrow.right.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("connect-button")
                }
                .listRowBackground(Color.clear)
            }
            .navigationTitle(L("Connect cbase"))
            .onAppear { address = session.serverAddress }
        }
    }

    private func apply() async {
        session.serverAddress = address
        await session.connect()
    }
}

struct LoginView: View {
    @EnvironmentObject private var session: SessionStore
    let setup: Bool
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    HStack(spacing: 12) {
                        CbaseLogo(size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("cbase")
                                .font(.headline)
                            Text(session.serverAddress)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }

                Section(setup ? L("Create admin account") : L("Sign in with your account")) {
                    TextField(L("Username"), text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                        .accessibilityIdentifier("login-username")
                    SecureField(L("Password"), text: $password)
                        .textContentType(setup ? .newPassword : .password)
                        .submitLabel(.go)
                        .onSubmit { Task { await submit() } }
                        .accessibilityIdentifier("login-password")
                }

                if !error.isEmpty {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView().padding(.trailing, 4) }
                            Text(busy ? L("Signing in…") : setup ? L("Create account") : L("Sign in"))
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || username.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                    .accessibilityIdentifier("login-submit")

                    Button(L("Different server address")) {
                        session.phase = .connectionFailed("")
                    }
                    .frame(maxWidth: .infinity)
                }
                .listRowBackground(Color.clear)
            }
            .navigationTitle(L("sign-in"))
            .onAppear { username = session.savedUsername }
        }
    }

    private func submit() async {
        guard !busy else { return }
        busy = true
        error = ""
        do {
            try await session.login(username: username, password: password, setup: setup)
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
