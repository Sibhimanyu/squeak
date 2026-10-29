import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

enum AwayChoice: Equatable { case iphone, web, telegram }

private func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }

/// What the person will get, in plain words, with a way to change it.
private struct AwayResult: View {
    @Environment(AppModel.self) private var model
    let channel: String

    var body: some View {
        Card {
            HStack(alignment: .top, spacing: Space.s) {
                Lucide(.check, size: 14, color: Theme.working).padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(channel) is set up").font(Typo.label).foregroundStyle(Theme.ink)
                    Text("You'll get approvals, questions, and when a Conductor chat finishes.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button("Change") { model.openSettings(.notifications) }.buttonStyle(QuietButtonStyle())
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// "Get pinged when you're not at your Mac": one way to start, or Not now (Skip for now in the footer).
struct AwayStage: View {
    @Environment(AppModel.self) private var model
    @Binding var choice: AwayChoice?
    @State private var showMore = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            switch choice {
            case .iphone: IPhoneAway()
            case .web: WebAway(useTelegram: { choice = .telegram })
            case .telegram: TelegramAway()
            case nil: chooser
            }
        }
        .padding(.vertical, Space.s)
    }

    private var chooser: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Get pinged when you're not at your Mac").font(Typo.title).foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Pick one, or choose Skip for now.").font(Typo.body).foregroundStyle(Theme.muted)
            }
            if model.awayConfigured { AwayResult(channel: "A phone channel") }
            option("iPhone app", tag: "Recommended", "Alerts and answers on your iPhone, on Wi-Fi or away.") { choice = .iphone }
            option("Web, any phone or computer", tag: nil, "Nothing to install. Add it to your home screen.") { choice = .web }
            option("Telegram", tag: nil, "Cards in a private Telegram chat, with alerts on any phone.") { choice = .telegram }
            DisclosureGroup("More", isExpanded: $showMore) {
                VStack(alignment: .leading, spacing: Space.s) {
                    more("Zoho Cliq", "For teams. Needs a Cliq bot, which you create in Zoho.") { model.openSettings(.cliq) }
                    more("Phone calls", "Needs a SIP phone such as 3CX. Squeak rings you when an agent is waiting.") { model.openSettings(.voice) }
                }
                .padding(.top, Space.s)
            }
            .font(Typo.body).foregroundStyle(Theme.muted)
        }
    }

    private func option(_ title: String, tag: String?, _ detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Card {
                HStack(spacing: Space.m) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: Space.s) {
                            Text(title).font(Typo.label).foregroundStyle(Theme.ink)
                            if let tag { Text(tag).font(Typo.meta).foregroundStyle(Theme.muted) }
                        }
                        Text(detail).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }

    private func more(_ title: String, _ detail: String, settings: @escaping () -> Void) -> some View {
        Card {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(title).font(Typo.label).foregroundStyle(Theme.ink)
                Text(detail).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Space.s) {
                    Button("Open Settings › \(title)", action: settings).buttonStyle(SecondaryButtonStyle())
                }
            }
        }
    }
}

// MARK: Pairing shared by iPhone and web

/// The first step of both: where the phone channel lives (your own Firebase or the shared server), then a QR.
private struct PhoneChannelGate<Content: View>: View {
    @Environment(AppModel.self) private var app
    @State private var settingUp = false
    @State private var setupFinished = false
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
            } else if !m.phoneEnabled {
                Card {
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text("First, choose where it lives").font(Typo.label).foregroundStyle(Theme.ink)
                        Text("Your phone reaches this Mac through Firebase. Squeak can set up your own (free, recommended) or use its shared server.")
                            .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                        Button("Choose") { settingUp = true }.buttonStyle(PrimaryButtonStyle())
                    }
                }
            } else {
                content()
            }
        }
        .task { await m.refreshRemote() }
        .sheet(isPresented: $settingUp) {
            FirebaseSetupSheet(channels: m, finished: $setupFinished, movingFromShared: m.onSharedServer)
        }
    }
}

/// The pairing code, as a QR of `text`, with the Mac's approval row below it.
private struct PairPanel: View {
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
            if let e = m.pairingError { Text(e).font(Typo.meta).foregroundStyle(Theme.muted) }
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

// MARK: iPhone app

private struct IPhoneAway: View {
    @Environment(AppModel.self) private var app
    private var paired: Bool { !(app.channels.remote?.activeDevices.isEmpty ?? true) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("iPhone app").font(Typo.title).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                HStack(spacing: Space.s) {
                    Text("Needs iOS 18 or later.").font(Typo.body).foregroundStyle(Theme.muted)
                    Button("Get the iPhone app") { open("https://squeak-5c9gvo.web.app/") }.buttonStyle(QuietButtonStyle())
                }
            }
            PhoneChannelGate {
                if paired {
                    AwayResult(channel: "Your iPhone")
                } else {
                    PairPanel(text: { $0 }, caption: "1. Open Squeak on your iPhone.\n2. Choose Pair with a Mac, then scan this code.\n3. Check the code on the phone matches the one that appears here, then approve.")
                }
            }
        }
    }
}

// MARK: Web

private struct WebAway: View {
    @Environment(AppModel.self) private var app
    let useTelegram: () -> Void
    private var paired: Bool { !(app.channels.remote?.activeDevices.isEmpty ?? true) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Web, any phone or computer").font(Typo.title).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Text("Nothing to install. Scan the code and Squeak opens at \(RemotePairing.webAppAddress).")
                    .font(Typo.body).foregroundStyle(Theme.muted)
            }
            PhoneChannelGate {
                if paired {
                    AwayResult(channel: "Squeak on the web")
                } else {
                    PairPanel(text: WebPairLink.url(fromPairingURL:), caption: "Scan this code with your phone's camera. Then approve the device here.")
                }
                homeScreen
            }
        }
    }

    private var homeScreen: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Keep it on your home screen").font(Typo.label).foregroundStyle(Theme.ink)
                Text("iPhone, in Safari: Share › Add to Home Screen.").font(Typo.body).foregroundStyle(Theme.muted)
                Text("Android, in Chrome: ⋮ › Add to Home screen (or Install app).").font(Typo.body).foregroundStyle(Theme.muted)
                Text("The web version has no notifications when it's closed. Pair Telegram too for alerts.")
                    .font(Typo.body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                Button("Set up Telegram", action: useTelegram).buttonStyle(SecondaryButtonStyle())
            }
        }
    }
}

// MARK: Telegram

/// BotFather, a token (taken from the clipboard), a chat, a test card. All state lives in `ChannelsModel`.
private struct TelegramAway: View {
    @Environment(AppModel.self) private var app
    @State private var botFatherOpened = false
    @State private var baseline = NSPasteboard.general.changeCount
    private var m: ChannelsModel { app.channels }

    private var tokenReady: Bool { m.tokenLooksValid || m.tokenSet }
    private var sent: Bool { m.testResult?.hasPrefix("Sent") == true }
    private var step: TelegramStep {
        TelegramStep.current(botFatherOpened: botFatherOpened, tokenReady: tokenReady, chatLinked: !m.allowed.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Telegram").font(Typo.title).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Text("Five short steps. Squeak does the typing.").font(Typo.body).foregroundStyle(Theme.muted)
            }
            VStack(alignment: .leading, spacing: Space.m) {
                ForEach(TelegramStep.allCases, id: \.rawValue) { s in stepRow(s) }
            }
            if sent { AwayResult(channel: "Telegram") }
        }
        .task { await m.pollCandidates() }
        .task { await watchClipboard() }
        .onChange(of: m.tokenLooksValid) { _, valid in
            // A token needs saving before the bot can hear a message, so it is saved as soon as it is found.
            if valid, !m.restarting { Task { await m.saveTelegram() } }
        }
    }

    private func isCurrent(_ s: TelegramStep) -> Bool { s == step || (s == .createBot && step == .copyToken) }

    private func stepRow(_ s: TelegramStep) -> some View {
        let done = sent ? true : s.rawValue < step.rawValue && !(s == .createBot && step == .copyToken)
        return HStack(alignment: .top, spacing: Space.m) {
            ZStack {
                Circle().fill(done ? Theme.working.opacity(0.15) : Theme.surfaceRaised).frame(width: 24, height: 24)
                if done { Lucide(.check, size: 12, color: Theme.working) }
                else { Text("\(s.rawValue + 1)").font(Typo.label).foregroundStyle(Theme.ink) }
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(s.title).font(Typo.label).foregroundStyle(done || isCurrent(s) ? Theme.ink : Theme.muted)
                if isCurrent(s) && !sent { detail(s) }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func detail(_ s: TelegramStep) -> some View {
        switch s {
        case .openBotFather:
            Button("Open BotFather") { open("https://t.me/BotFather"); botFatherOpened = true }.buttonStyle(PrimaryButtonStyle())
        case .createBot:
            Text("Send /newbot, then pick a name and a username for your bot.").font(Typo.body).foregroundStyle(Theme.muted)
        case .copyToken:
            HStack(spacing: Space.s) {
                if tokenReady {
                    Lucide(.check, size: 14, color: Theme.working)
                    Text("Token found").font(Typo.body).foregroundStyle(Theme.muted)
                } else {
                    ProgressView().controlSize(.small)
                    Text("Waiting for you to copy it. Squeak fills it in.").font(Typo.body).foregroundStyle(Theme.muted)
                    Button("Paste") { m.pasteToken() }.buttonStyle(QuietButtonStyle())
                }
            }
        case .sendMessage:
            VStack(alignment: .leading, spacing: Space.s) {
                if m.tokenSet {
                    Text("Open your new bot in Telegram and send it any message.").font(Typo.body).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    if m.candidates.isEmpty {
                        HStack(spacing: Space.s) { ProgressView().controlSize(.small); Text("Waiting for a message…").font(Typo.body).foregroundStyle(Theme.muted) }
                    }
                    ForEach(m.candidates) { c in
                        HStack {
                            Text(c.name.isEmpty ? "Chat" : c.name).font(Typo.body).foregroundStyle(Theme.ink)
                            Spacer()
                            Button("Link this chat") { m.link(c) }.buttonStyle(PrimaryButtonStyle())
                        }
                    }
                } else {
                    HStack(spacing: Space.s) { ProgressView().controlSize(.small); Text("Saving the token…").font(Typo.body).foregroundStyle(Theme.muted) }
                }
            }
        case .test:
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: Space.s) {
                    Button("Save and send a test card") { Task { await m.saveTelegram(); await m.sendTest() } }
                        .buttonStyle(PrimaryButtonStyle()).disabled(m.testing || m.restarting)
                    if m.testing || m.restarting { ProgressView().controlSize(.small) }
                }
                if let r = m.testResult, !sent { Text(r).font(Typo.meta).foregroundStyle(Theme.muted) }
            }
        }
    }

    /// Fills the token when something that looks like one is copied after this screen opened.
    private func watchClipboard() async {
        while !Task.isCancelled {
            let count = NSPasteboard.general.changeCount
            if count != baseline {
                baseline = count
                if !tokenReady, let s = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   ChannelsModel.isBotToken(s) {
                    m.tokenDraft = s
                }
            }
            try? await Task.sleep(for: .milliseconds(700))
        }
    }
}
