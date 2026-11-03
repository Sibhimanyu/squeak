import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

private func stageTitle(_ text: String, _ detail: String? = nil) -> some View {
    VStack(alignment: .leading, spacing: Space.s) {
        Text(text).font(Typo.title).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
        if let detail {
            Text(detail).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: Welcome

/// One sentence and the duck. Detection happens quietly while it shows.
struct WelcomeStage: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            DuckMark(width: 96).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Your agents. In view.")
                    .font(.system(size: 28, weight: .semibold)).tracking(-0.7).foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Squeak watches your coding agents and tells you when one needs you, so you can answer without switching apps.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Space.s)
        .onAppear { model.setup.redetect() }
    }
}

// MARK: Connect

/// The service, the hooks into each agent found, and Conductor's link, one progress list. It runs by itself once the
/// person has said yes (also when setup reopens after a quit), and stops only on a failure, which says why in words.
struct ConnectStage: View {
    @Environment(AppModel.self) private var model
    @State private var showDetails = false
    @State private var copied = false

    var body: some View {
        let flow = model.setupFlow
        let failure = flow.connectFailure
        VStack(alignment: .leading, spacing: Space.l) {
            if let failure {
                stageTitle("Squeak couldn't finish connecting")
                failureView(failure)
            } else if flow.connectReady {
                stageTitle("Squeak is connected", "Everything is in place. Continue to see your agents.")
            } else {
                stageTitle("Connecting Squeak",
                           model.setup.connectRunning
                               ? "This takes up to a minute the first time. You can close this window or quit Squeak; it picks up here next time."
                               : "Squeak installs a small background service and links to your agents.")
            }
            if flow.agentsFound.isEmpty {
                Button("Check again") { model.setup.redetect() }.buttonStyle(SecondaryButtonStyle())
            }
            if failure == nil, !flow.connectReady {
                Text("Squeak adds a small hook to Claude Code's and Codex's settings. You can remove it anytime.")
                    .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Space.s)
        .task {
            // Resume: whoever pressed Get started before (this launch or an earlier one) never presses Connect.
            let f = model.setupFlow
            if model.setup.progress.started, f.connectFailure == nil, !f.connectReady, !model.setup.connectRunning {
                model.startConnect()
            }
        }
    }

    private func failureView(_ row: ConnectRow) -> some View {
        VStack(alignment: .leading, spacing: Space.m) {
            if case .failed(let fix) = row.state {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(row.title).font(Typo.label).foregroundStyle(Theme.ink)
                    Text(fix).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .accessibilityElement(children: .combine)
                if row.id == "conductor" {
                    Button("Continue without Conductor") { model.continueWithoutConductor() }.buttonStyle(SecondaryButtonStyle())
                }
                if row.id != "service" || model.daemon.failure == nil {
                    ReportProblemButton(problem: "\(row.title): \(fix)", place: "Setup › Connect")
                }
                if row.id == "service", let details = model.daemon.failure?.details {
                    HStack(spacing: Space.s) {
                        Button(copied ? "Copied" : "Copy details") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(details, forType: .string)
                            copied = true
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        Button("Show log") {
                            let log = URL.homeDirectory.appending(path: "Library/Logs/squeak/squeak.log")
                            NSWorkspace.shared.activateFileViewerSelecting([log])
                        }
                        .buttonStyle(QuietButtonStyle())
                        ReportProblemButton(problem: "\(row.title): \(fix)", place: "Setup › Connect", details: details)
                    }
                    if SqueakMacApp.reportsEnabled {
                        Text("Report this sends the problem and the details above to a person on the Squeak team. You read it first.")
                            .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    DisclosureGroup("Technical details", isExpanded: $showDetails) {
                        Text(details)
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(Space.s)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
                            .padding(.top, Space.xs)
                    }
                    .font(Typo.body).foregroundStyle(Theme.muted)
                }
            }
        }
    }
}

// MARK: First win

/// Points at the duck, ticks when a session shows up, then offers a banner. It observes real sessions; it never
/// creates or sends a sample chat.
struct FirstWinStage: View {
    @Environment(AppModel.self) private var model
    @State private var showRecovery = false

    var body: some View {
        let flow = model.setupFlow
        let seen = flow.facts.hasActiveSession
        VStack(alignment: .leading, spacing: Space.l) {
            stageTitle("See your agents")
            HStack(alignment: .top, spacing: Space.s) {
                Group {
                    if seen { Lucide(.check, size: 14, color: Theme.working) }
                    else { ProgressView().controlSize(.small) }
                }
                .frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(seen ? "Squeak can see \(model.sessions.count) \(model.sessions.count == 1 ? "session" : "sessions")"
                              : "Start an agent session, or switch to one that's running")
                        .font(Typo.label).foregroundStyle(Theme.ink)
                    Text(seen ? "Needs you holds approvals and questions. Finished sessions move to Finished."
                              : "It appears under Working while it runs. This updates by itself.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)

            VStack(alignment: .leading, spacing: Space.s) {
                Text("Want a banner when it needs you?").font(Typo.label).foregroundStyle(Theme.ink)
                if model.setup.notifications != .authorized {
                    BannerPreview(title: model.sessions.first.map { $0.distinctTitle ?? $0.title } ?? "Your agent")
                }
                PermissionExplainer(kind: .notifications)
            }

            DisclosureGroup("Session not showing up?", isExpanded: $showRecovery) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text("Sessions that were already running may not have the new hooks. Start a fresh one, send a message, then check again.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    Button("Check again", action: model.recheck).buttonStyle(SecondaryButtonStyle())
                }
                .padding(.top, Space.s)
            }
            .font(Typo.body).foregroundStyle(Theme.muted)
        }
        .padding(.vertical, Space.s)
    }
}

// MARK: Done

/// "You're set", with at most three things to turn on later.
struct DoneStage: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            stageTitle("You're set", "Click the duck in your menu bar to see your agents. Nothing else is needed.")
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Turn on later").font(Typo.label).foregroundStyle(Theme.ink)
                later("Keep awake", "Keep this Mac reachable while you're away.", .awake)
                later("Quick-message shortcut", "Double-tap Control to message an agent from anywhere.", .general)
                later("Notification rules", "Choose what Telegram and Cliq may push.", .notifications)
            }
        }
        .padding(.vertical, Space.s)
    }

    private func later(_ title: String, _ detail: String, _ section: SettingsSection) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Typo.body).foregroundStyle(Theme.ink)
                Text(detail).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            Spacer()
            Button("Open") { model.openSettings(section) }.buttonStyle(QuietButtonStyle())
        }
        .accessibilityElement(children: .combine)
    }
}
