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

/// The service, the hooks into each agent found, and Conductor's link, one progress list. Stops only on failure.
struct ConnectStage: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let flow = model.setupFlow
        VStack(alignment: .leading, spacing: Space.l) {
            stageTitle("Connecting Squeak", "Squeak sets itself up in a few seconds.")
            ForEach(flow.connectRows.filter { $0.state.isFailed }) { row in failure(row) }
            if flow.agentsFound.isEmpty {
                Button("Check again") { model.setup.redetect() }.buttonStyle(SecondaryButtonStyle())
            }
            if !flow.connectReady || model.setup.connectRunning {
                Text("Squeak adds a small hook to Claude Code's and Codex's settings. You can remove it anytime.")
                    .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Space.s)
    }

    private func failure(_ row: ConnectRow) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if case .failed(let fix) = row.state {
                Text(row.title).font(Typo.label).foregroundStyle(Theme.ink)
                Text(fix).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                if row.id == "conductor" {
                    Button("Continue without Conductor") { model.continueWithoutConductor() }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .accessibilityElement(children: .combine)
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
