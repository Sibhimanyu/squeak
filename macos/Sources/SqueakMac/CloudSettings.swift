import AppKit
import SqueakMacCore
import SwiftUI

/// A visible one-tap Copy: anything the owner has to type somewhere else carries one.
struct CopyButton: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Button(copied ? "Copied" : "Copy") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
        }
        .buttonStyle(SecondaryButtonStyle())
        .accessibilityLabel("Copy \(text)")
    }
}

/// Settings › Cloud: Squeak's one cloud. Signing in is the setup.
struct CloudSettings: View {
    @Environment(AppModel.self) private var app
    private var m: CloudModel { app.cloud }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "Squeak cloud", subtitle: "How your phone, browser and Cliq reach this Mac.", symbol: "cloud") {
                if let h = m.hosted {
                    if let email = h.email ?? app.account.email {
                        HStack(spacing: Space.s) {
                            Text("Signed in as").font(Typo.label).foregroundStyle(Theme.ink)
                            Text(verbatim: email).font(Typo.body).foregroundStyle(Theme.muted).textSelection(.enabled)
                            Spacer()
                        }
                    }
                    if let s = h.statusSentence {
                        StatusLine(dot: dot(h), text: s)
                    }
                    if h.phase == .error, let e = h.error {
                        ReportProblemButton(problem: e, place: "Settings › Cloud")
                    }
                    HStack {
                        if h.needsSignIn {
                            Button("Sign in…") { app.account.openSignIn(from: .settings) }
                                .buttonStyle(PrimaryButtonStyle()).disabled(app.account.busy)
                                .accessibilityLabel("Sign in to Squeak")
                        } else {
                            Button {
                                Task { await m.connect() }
                            } label: {
                                if m.reconnecting { ProgressView().controlSize(.small) } else { Text("Reconnect") }
                            }
                            .buttonStyle(SecondaryButtonStyle()).disabled(m.reconnecting || h.phase == .connecting)
                        }
                        Spacer()
                    }
                    if let l = h.legacySentence { Footnote(l) }
                    if let n = m.notice { Footnote(n) }
                } else {
                    StatusLine(dot: nil, text: "Checking")
                }
            }
            Footnote("Sealed documents only: the cloud never holds a readable word.")
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .task { await m.refresh(); await m.pollWhileConnecting() }
    }

    private func dot(_ h: HostedCloud) -> Color? {
        switch h.phase {
        case .ready: Theme.done
        case .connecting: Theme.working
        case .error: Theme.negative
        default: nil
        }
    }
}
