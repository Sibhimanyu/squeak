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
                        Text("Signed in as").font(Typo.label).foregroundStyle(Theme.ink)
                        Text(verbatim: email).font(Typo.body).foregroundStyle(Theme.muted).textSelection(.enabled)
                        Spacer()
                        Button("Sign out…") { confirmSignOut = true }
                            .buttonStyle(DestructiveButtonStyle()).disabled(m.busy)
                            .accessibilityLabel("Sign out of \(email)")
                    }
                    .accessibilityElement(children: .contain)
                    Toggle(isOn: Binding(get: { m.askOwnDevices }, set: { v in Task { await m.setAskOwnDevices(v) } })) {
                        Text("Ask before adding my own devices").font(Typo.label).foregroundStyle(Theme.ink)
                    }
                    .toggleStyle(.switch).disabled(m.busy)
                    Footnote("When off, an iPhone or browser signed in to \(email) joins this Mac without a code. You're told each time and can revoke it.")
                } else if m.canSignIn {
                    Footnote("Sign in to see this Mac from your browser and iPhone without a QR code.")
                    HStack {
                        Button(m.busy ? "Waiting for sign-in…" : "Sign in…") { m.signIn() }
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
        .task { await m.refresh() }
        .confirmationDialog("Sign out of your Squeak account?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { Task { await m.signOut() } }
        } message: {
            Text("Browsers and iPhones signed in to \(m.email ?? "this account") will no longer see this Mac. Devices already paired keep working.")
        }
    }
}
