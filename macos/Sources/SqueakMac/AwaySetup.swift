import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// MARK: Pairing shared by iPhone and web

/// The first step of both: where the phone channel lives (your own Firebase or the shared server), then a QR.
struct PhoneChannelGate<Content: View>: View {
    @Environment(AppModel.self) private var app
    @ViewBuilder var content: () -> Content
    private var m: ChannelsModel { app.channels }

    var body: some View {
        Group {
            if m.remoteOutdated || !m.daemonReachable {
                Card {
                    Text(m.daemonReachable ? "Update the Squeak service, then come back here." : "The Squeak service isn't answering yet. Go back to Connect, or try again in a moment.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            } else if m.remote == nil {
                HStack(spacing: Space.s) { ProgressView().controlSize(.small); Text("Checking…").font(Typo.body).foregroundStyle(Theme.muted) }
            } else if let h = app.cloud.hosted, !h.isReady {
                Card {
                    VStack(alignment: .leading, spacing: Space.s) {
                        if h.needsSignIn {
                            Text("Sign in to Squeak").font(Typo.label).foregroundStyle(Theme.ink)
                            Text("Your phone reaches this Mac through your Squeak account. Signing in here sets it up.")
                                .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                            HStack {
                                Button("Sign in") { app.account.openSignIn(from: .setup) }
                                    .buttonStyle(PrimaryButtonStyle()).disabled(app.account.busy)
                                    .accessibilityLabel("Sign in with a Squeak account")
                                if app.account.busy { ProgressView().controlSize(.small) }
                            }
                        } else {
                            StatusLine(dot: h.phase == .error ? Theme.negative : Theme.working, text: h.statusSentence ?? "Connecting…")
                            if h.phase == .error {
                                Button("Reconnect") { Task { await app.cloud.connect() } }.buttonStyle(SecondaryButtonStyle())
                            }
                        }
                        if let n = app.cloud.notice { Text(n).font(Typo.meta).foregroundStyle(Theme.muted) }
                    }
                }
            } else if !m.phoneEnabled {
                Card {
                    Text("Update the Squeak service, then come back here.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                content()
            }
        }
        .task { await m.refreshRemote(); await app.cloud.refresh(); await app.cloud.pollWhileConnecting() }
    }
}

/// The pairing code, as a QR of `text`, with the Mac's approval row below it.
struct PairPanel: View {
    @Environment(\.displayScale) private var displayScale
    @Environment(AppModel.self) private var app
    let text: (String) -> String?
    let caption: String
    private var m: ChannelsModel { app.channels }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(alignment: .top, spacing: Space.l) {
                qr
                Text(caption).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(m.remote?.pending ?? []) { PendingRow(request: $0) }
            if let e = m.pairingError {
                Text(e).font(Typo.meta).foregroundStyle(Theme.muted)
                ReportProblemButton(problem: e, place: "Away setup › Pairing")
            }
            Text("Keep this code private. Anyone who scans it can ask to pair, and you still approve here.")
                .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
        .task { await m.startPairing() }
        .task { await m.pollRemote() }
        .onDisappear { m.endPairing() }
    }

    @ViewBuilder private var qr: some View {
        Group {
            if let url = m.pairingURL, let t = text(url), let image = QRCode.image(for: t, points: 160, displayScale: displayScale) {
                Image(nsImage: image).interpolation(.none).resizable().frame(width: image.size.width, height: image.size.height)
                    .accessibilityLabel("Pairing code")
            } else if m.pairingError != nil {
                Lucide(.circleAlert, size: 24, color: Theme.subtle)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width: 160, height: 160)
        .padding(12)
        // A QR needs a light ground in either appearance.
        .background(Color.white, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.lineStrong))
    }
}

