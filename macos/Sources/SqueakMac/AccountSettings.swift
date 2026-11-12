import SqueakMacCore
import SwiftUI

/// Settings › Account: optional. Signed in, this Mac appears under "Your Macs" for the account's
/// browsers and iPhones, and you still approve each one here.
struct AccountSettings: View {
    @Environment(AppModel.self) private var app
    @State private var confirmSignOut = false
    private var m: AccountModel { app.account }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "Squeak account", subtitle: "Optional. Everything works without one.", symbol: "person.crop.circle") {
                if let email = m.email {
                    HStack(spacing: Space.m) {
                        AccountAvatar(image: m.avatar, email: email, size: 40)
                        Text("Signed in as").font(Typo.label).foregroundStyle(Theme.ink)
                        Text(verbatim: email).font(Typo.body).foregroundStyle(Theme.muted).textSelection(.enabled)
                        Spacer()
                        Button("Sign out…") { confirmSignOut = true }
                            .buttonStyle(DestructiveButtonStyle()).disabled(m.busy)
                            .accessibilityLabel("Sign out of \(email)")
                    }
                    .accessibilityElement(children: .contain)
                    if m.canSignIn {
                        HStack {
                            Button("Change photo…") { m.changePhoto() }
                                .buttonStyle(SecondaryButtonStyle()).disabled(m.busy)
                                .accessibilityLabel("Change your photo")
                            Spacer()
                        }
                    }
                    Toggle(isOn: Binding(get: { m.askOwnDevices }, set: { v in Task { await m.setAskOwnDevices(v) } })) {
                        Text("Ask before adding my own devices").font(Typo.label).foregroundStyle(Theme.ink)
                    }
                    .toggleStyle(.switch).disabled(m.busy)
                    connectionStatus
                    Footnote("When off, an iPhone or browser signed in to \(email) joins this Mac without a code. You're told each time and can revoke it.")
                } else if m.canSignIn {
                    Footnote("Sign in to see this Mac from your browser and iPhone without a QR code.")
                    HStack {
                        Button("Sign in…") { m.openSignIn(from: .settings) }
                            .buttonStyle(PrimaryButtonStyle()).disabled(m.busy)
                            .accessibilityLabel("Sign in with a Squeak account")
                        Spacer()
                    }
                } else {
                    StatusLine(dot: nil, text: "Sign-in needs Squeak's cloud")
                }
                if let n = m.notice { Footnote(n) }
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .task { await m.refresh(); await app.cloud.refresh(); await app.cloud.pollWhileConnecting() }
        .confirmationDialog("Sign out of your Squeak account?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { Task { await m.signOut() } }
        } message: {
            Text("Browsers and iPhones signed in to \(m.email ?? "this account") will no longer see this Mac. Devices already paired keep working.")
        }
    }

    private func dot(_ tone: AccountConnection.Tone) -> Color? {
        switch tone {
        case .ok: Theme.done
        case .working: Theme.working
        case .error: Theme.negative
        case .quiet: nil
        }
    }

    /// How this Mac reaches Squeak's cloud, as one quiet line under the identity row. Signing in sets it up; a press
    /// of Retry only shows when something can be done (an error, or the sign-in step that never reached the daemon).
    @ViewBuilder private var connectionStatus: some View {
        let cloud = app.cloud
        if cloud.available, let h = cloud.hosted, let line = h.connectionLine(accountKnown: m.email != nil) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                if let d = dot(line.tone) { Circle().fill(d).frame(width: 8, height: 8).accessibilityHidden(true) }
                Text(line.text).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if line.retry {
                    Button { retry(h) } label: { if cloud.reconnecting || m.busy { ProgressView().controlSize(.small) } else { Text("Retry") } }
                        .buttonStyle(SecondaryButtonStyle()).disabled(m.busy || cloud.reconnecting)
                }
            }
            .accessibilityElement(children: .combine)
            if h.phase == .error, let e = h.error { ReportProblemButton(problem: e, place: "Settings › Account") }
            if let n = cloud.notice { Footnote(n) }
        }
    }

    private func retry(_ h: HostedCloud) {
        if h.needsSignIn { Task { await m.connectCloud(signInUrl: h.signInUrl) } }
        else { Task { await app.cloud.connect() } }
    }
}
