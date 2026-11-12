import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

private func stepTitle(_ text: String, _ detail: String? = nil) -> some View {
    VStack(alignment: .leading, spacing: Space.s) {
        Text(text).font(Typo.title).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
        if let detail {
            Text(detail).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// One line of a step: a mark (done, working, failed, waiting), a title, and what it means.
private struct StatusRow: View {
    let state: ConnectRowState
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .top, spacing: Space.s) {
            Group {
                switch state {
                case .done: Lucide(.check, size: 14, color: Theme.working)
                case .working: ProgressView().controlSize(.small)
                case .failed: Lucide(.circleAlert, size: 14, color: Theme.negative)
                case .pending: Circle().strokeBorder(Theme.lineStrong, lineWidth: 1.5).frame(width: 10, height: 10)
                }
            }
            .frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typo.label).foregroundStyle(Theme.ink)
                if let detail { Text(detail).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(label)\(detail.map { ". \($0)" } ?? "")")
    }

    private var label: String {
        switch state {
        case .done: "done"
        case .working: "in progress"
        case .failed: "needs attention"
        case .pending: "waiting"
        }
    }
}

// MARK: Welcome

struct WelcomeStep: View {
    var body: some View {
        stepTitle("Welcome to Squeak",
                  "Squeak watches your Claude Code and Codex agents and tells you the moment one needs you, so you can answer from your Mac, your iPhone or Telegram.")
    }
}

// MARK: Start Squeak

struct ServiceStep: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let flow = model.setupFlow
        let row = flow.serviceRow
        let approval = flow.serviceNeedsApproval
        VStack(alignment: .leading, spacing: Space.l) {
            stepTitle("Start Squeak",
                      "Squeak keeps a small background service running. It is what watches your agents, even when this window is closed.")
            Card {
                VStack(alignment: .leading, spacing: Space.m) {
                    // First: macOS's own permission for a background item. Nothing starts until it is given.
                    StatusRow(state: approval ? .failed("") : flow.serviceRunning || row.state != .pending ? .done : .pending,
                              title: "Allow Squeak to run in the background",
                              detail: approval
                                  ? "macOS has Squeak's background item switched off. Turn on Squeak in Login Items, then come back: Squeak starts on its own."
                                  : nil)
                    if approval {
                        HStack {
                            Button("Open Login Items Settings") { model.perform(.openLoginItems) }.buttonStyle(PrimaryButtonStyle())
                            Spacer()
                        }
                    }
                    Divider().overlay(Theme.line)
                    StatusRow(state: approval ? .pending : row.state,
                              title: flow.serviceRunning ? "Squeak is running" : row.state == .working ? "Starting Squeak…" : "Background service",
                              detail: approval ? nil : failure(row.state) ?? stepLine(row.state))
                    if !approval, row.state.isFailed {
                        HStack(spacing: Space.s) {
                            Button("Try again") { model.retryService() }.buttonStyle(PrimaryButtonStyle())
                                .accessibilityLabel("Try starting Squeak again")
                            Button("Copy details") { model.copyServiceDetails() }.buttonStyle(SecondaryButtonStyle())
                            Button("Show log") { model.showServiceLog() }.buttonStyle(SecondaryButtonStyle())
                            if SqueakMacApp.reportsEnabled, let report = SetupFailureReporter.shared.current {
                                Button("Send report") { ReportRouter.shared.present(text: report.reportText()) }
                                    .buttonStyle(SecondaryButtonStyle())
                                    .accessibilityHint("Opens a report with the details filled in. You read it before it is sent.")
                            }
                            Spacer()
                        }
                    } else if !approval, !flow.serviceRunning, row.state == .pending {
                        HStack {
                            Button("Start Squeak") { model.startService() }.buttonStyle(PrimaryButtonStyle())
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    private func failure(_ s: ConnectRowState) -> String? {
        if case .failed(let why) = s { return why }
        return nil
    }

    /// One line on what is happening now, so a slow start never looks frozen.
    private func stepLine(_ s: ConnectRowState) -> String? {
        guard s == .working else { return nil }
        return (model.daemon.step ?? .installing).rawValue
    }
}

// MARK: Your agents

struct AgentsStep: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let flow = model.setupFlow
        let names = flow.agentsFound
        VStack(alignment: .leading, spacing: Space.l) {
            stepTitle("Your agents", "Squeak hears your agents through small hooks it adds to Claude Code and Codex.")
            if names.isEmpty { none } else { found(flow, names) }
        }
    }

    private var none: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("No agent found on this Mac").font(Typo.label).foregroundStyle(Theme.ink)
                Text("Install Claude Code or Codex and Squeak will pick it up. You can also continue now and connect later from Settings › Setup.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Check again") { model.setup.redetect(); model.recheck() }.buttonStyle(SecondaryButtonStyle())
                    Spacer()
                }
            }
        }
    }

    @ViewBuilder private func found(_ flow: SetupFlow, _ names: [String]) -> some View {
        let row = flow.hooksRow
        Card {
            VStack(alignment: .leading, spacing: Space.m) {
                ForEach(names, id: \.self) { name in
                    StatusRow(state: flow.isHooked(name) ? .done : row.state == .working ? .working : .pending,
                              title: name, detail: flow.isHooked(name) ? "Connected" : "Found on this Mac")
                }
                if case .failed(let why) = row.state { Text(why).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true) }
                if !flow.connectReady || row.state.isFailed {
                    HStack(spacing: Space.s) {
                        Button(row.state.isFailed ? "Try again" : "Connect") { model.connectAgents() }
                            .buttonStyle(PrimaryButtonStyle()).disabled(row.state == .working || !flow.serviceRunning)
                            .accessibilityLabel(row.state.isFailed ? "Try connecting your agents again" : "Connect your agents")
                        if row.state == .working { ProgressView().controlSize(.small) }
                        Spacer()
                    }
                }
            }
        }
        VStack(alignment: .leading, spacing: 4) {
            Text("What this changes").font(Typo.label).foregroundStyle(Theme.ink)
            if names.contains("Claude Code") {
                Text("Claude Code: adds Squeak's hooks to ~/.claude/settings.json. Your other entries are kept and a backup is made.")
            }
            if names.contains("Codex") {
                Text("Codex: adds one marked block to ~/.codex/AGENTS.md. Nothing outside the block is touched.")
            }
            Text("Remove them any time in Settings › Setup.")
        }
        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        if flow.connectReady { proof(flow) }
    }

    private func proof(_ flow: SetupFlow) -> some View {
        let live = model.sessions.filter { $0.state == .working || $0.state == .blocked || $0.state == .finished || $0.alive == true }
        return VStack(alignment: .leading, spacing: Space.s) {
            Text("Sessions Squeak can see").font(Typo.label).foregroundStyle(Theme.ink)
            if live.isEmpty {
                HStack(spacing: Space.s) {
                    ProgressView().controlSize(.small)
                    Text("None yet. Start an agent session and it appears here by itself.").font(Typo.body).foregroundStyle(Theme.muted)
                }
                Text("A session that was already running may not have the hooks. Start a fresh one if it doesn't show up.")
                    .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(live.prefix(4), id: \.key) { s in
                    HStack(spacing: Space.s) {
                        Lucide(.check, size: 13, color: Theme.working)
                        Text(s.distinctTitle ?? s.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
                if live.count > 4 { Text("and \(live.count - 4) more").font(Typo.meta).foregroundStyle(Theme.muted) }
            }
        }
    }
}

// MARK: Account

struct AccountStep: View {
    @Environment(AppModel.self) private var model
    private var m: AccountModel { model.account }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            stepTitle("Account", "Optional. Sign in with Zoho, Google or email to see this Mac from your browser and iPhone without a QR code. Everything works without one.")
            Card {
                VStack(alignment: .leading, spacing: Space.m) {
                    if let email = m.email {
                        StatusRow(state: .done, title: "Signed in", detail: email)
                    } else if m.canSignIn {
                        HStack {
                            Button("Sign in") { m.openSignIn(from: .setup) }
                                .buttonStyle(PrimaryButtonStyle()).disabled(m.busy)
                                .accessibilityLabel("Sign in with a Squeak account")
                            if m.busy { ProgressView().controlSize(.small) }
                            Spacer()
                        }
                        Text("Squeak's window opens a sign-in page: Zoho, Google or email.").font(Typo.meta).foregroundStyle(Theme.muted)
                    } else {
                        Text("Squeak couldn't reach its sign-in page. Update the Squeak service, or try again later in Settings › Account.")
                            .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let n = m.notice { Text(n).font(Typo.meta).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true) }
                }
            }
        }
    }
}

// MARK: Your phone

struct PhoneStep: View {
    @Environment(AppModel.self) private var model
    private var paired: Bool { !(model.channels.remote?.activeDevices.isEmpty ?? true) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            stepTitle("Your phone", "Optional. Follow your agents and answer them from your iPhone.")
            if model.account.email != nil { signedIn } else { pairing }
        }
    }

    private var signedIn: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.s) {
                if paired { StatusRow(state: .done, title: "Your phone is connected") }
                Text("Open Squeak on your iPhone and sign in with the same account.").font(Typo.label).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("It finds this Mac by itself. Needs iOS 18 or later.").font(Typo.body).foregroundStyle(Theme.muted)
                HStack {
                    Button("Get the iPhone app") { open("https://sibhimanyu.github.io/squeak/ios/") }.buttonStyle(SecondaryButtonStyle())
                    Spacer()
                }
            }
        }
    }

    private var pairing: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.s) {
                Text("Needs iOS 18 or later.").font(Typo.body).foregroundStyle(Theme.muted)
                Button("Get the iPhone app") { open("https://sibhimanyu.github.io/squeak/ios/") }.buttonStyle(QuietButtonStyle())
            }
            PhoneChannelGate {
                if paired {
                    StatusRow(state: .done, title: "Your iPhone is paired")
                } else {
                    PairPanel(text: { $0 }, caption: "1. Open Squeak on your iPhone.\n2. Choose Pair with a Mac, then scan this code.\n3. Check the code on the phone matches the one that appears here, then approve.")
                }
            }
        }
    }

    private func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }
}

// MARK: Done

struct DoneStep: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            stepTitle("You're set", "Click the duck in your menu bar to see your agents. Nothing else is needed.")
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Make it yours").font(Typo.label).foregroundStyle(Theme.ink)
                extra("Telegram", "Get cards and answer agents from a private chat.", .telegram)
                extra("Zoho Cliq", "Updates and replies through your Cliq bot.", .cliq)
                extra("Voice calls", "A phone call when an agent is waiting for you.", .voice)
                extra("Keep awake permissions", "Keep this Mac reachable while you're away.", .awake)
                extra("Add-ons", "Add apps like Conductor to see and answer their chats too.", .addons)
            }
        }
    }

    private func extra(_ title: String, _ detail: String, _ section: SettingsSection) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Typo.body).foregroundStyle(Theme.ink)
                Text(detail).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            Spacer()
            Button("Open") { model.openSettings(section) }.buttonStyle(QuietButtonStyle())
                .accessibilityLabel("Open \(title) settings")
        }
        .accessibilityElement(children: .contain)
    }
}
