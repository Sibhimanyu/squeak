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
            cloudBlock
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

    private func cloudAction(_ h: HostedCloud, _ known: Bool) {
        if h.needsSignIn {
            if known, h.signInUrl != nil { Task { await m.connectCloud(signInUrl: h.signInUrl) } }
            else { m.openSignIn(from: .settings) }
        } else { Task { await app.cloud.connect() } }
    }

    @ViewBuilder private func actionLabel(_ title: String) -> some View {
        if app.cloud.reconnecting { ProgressView().controlSize(.small) } else { Text(title) }
    }

    private func dot(_ h: HostedCloud) -> Color? {
        switch h.phase {
        case .ready: Theme.done
        case .connecting: Theme.working
        case .error: Theme.negative
        default: nil
        }
    }

    /// Squeak's cloud under the account: how phones, the browser and Cliq reach this Mac. No second "Signed in as".
    @ViewBuilder private var cloudBlock: some View {
        let cloud = app.cloud
        if cloud.available, let h = cloud.hosted {
            let known = m.email != nil || h.email != nil
            SettingsCard(title: "Squeak cloud", subtitle: "How your phone, browser and Cliq reach this Mac.", symbol: "cloud") {
                if let s = h.statusSentence(accountKnown: known) { StatusLine(dot: dot(h), text: s) }
                if h.phase == .error, let e = h.error { ReportProblemButton(problem: e, place: "Settings › Account") }
                if let title = h.actionTitle(accountKnown: known) {
                    HStack {
                        if h.needsSignIn {
                            Button { cloudAction(h, known) } label: { actionLabel(title) }
                                .buttonStyle(PrimaryButtonStyle()).disabled(m.busy || cloud.reconnecting)
                        } else {
                            Button { cloudAction(h, known) } label: { actionLabel(title) }
                                .buttonStyle(SecondaryButtonStyle()).disabled(m.busy || cloud.reconnecting || h.phase == .connecting)
                        }
                        Spacer()
                    }
                }
                if let l = h.legacySentence(accountKnown: known) { Footnote(l) }
                if let n = cloud.notice { Footnote(n) }
            }
        }
    }
}
