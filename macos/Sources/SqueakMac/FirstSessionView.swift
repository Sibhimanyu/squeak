import SqueakMacCore
import SwiftUI

/// A real-session walkthrough. It observes the catalog; it never creates or sends a sample chat.
struct FirstSessionView: View {
    @Environment(AppModel.self) private var model
    @State private var showRecovery = false
    var backToSetup: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Try your first session").font(Typo.title).foregroundStyle(Theme.ink)
                Text("A small task is enough to see Squeak in action.")
                    .font(Typo.body).foregroundStyle(Theme.muted)
            }

            VStack(alignment: .leading, spacing: Space.m) {
                instruction(1, title: "Start a fresh agent session", message: model.setupFacts.conductorInstalled && !model.setup.conductorSkipped
                    ? "In Conductor, start a new Claude Code or Codex chat and send a small task. A new session picks up the hooks you just installed."
                    : "In your terminal, start claude or codex and send a small task. A new session picks up the hooks you just installed.")
                instruction(2, title: "Find it under the duck", message: "Click Squeak in your menu bar. Your session appears under Working while it runs, or Finished when it’s done. Open it to see its messages.")
                instruction(3, title: "Know when to come back", message: "When an agent asks a question or needs approval, look under Needs you. Reply where Squeak offers it; otherwise return to the agent. Finished sessions move to Finished.")
            }

            Card {
                HStack(alignment: .top, spacing: Space.s) {
                    Image(systemName: model.isConnected && !model.sessions.isEmpty ? "checkmark.circle" : "antenna.radiowaves.left.and.right")
                        .foregroundStyle(model.isConnected && !model.sessions.isEmpty ? Theme.working : Theme.muted)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(statusTitle).font(Typo.label).foregroundStyle(Theme.ink)
                        Text(statusMessage).font(Typo.body).foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            DisclosureGroup("Session not showing up?", isExpanded: $showRecovery) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text("Sessions already running during setup may not have the new hooks. Start a fresh session, send a message, then check again. You can also review the background service and agent hooks in Setup.")
                        .font(Typo.body).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: Space.m) {
                        Button("Check again", action: model.recheck).buttonStyle(SecondaryButtonStyle())
                        Button("Back to setup", action: backToSetup).buttonStyle(.plain).foregroundStyle(Theme.ink)
                    }
                }
                .padding(.top, Space.s)
            }
            .font(Typo.body).foregroundStyle(Theme.muted)
        }
        .padding(.bottom, Space.m)
        .task { await model.setup.poll(model) }
    }

    private var statusTitle: String {
        if model.health == nil { return "Connecting to Squeak…" }
        if !model.isConnected { return "The background service needs attention" }
        if model.sessions.isEmpty { return "Ready for your session" }
        return "Squeak can see \(model.sessions.count) \(model.sessions.count == 1 ? "session" : "sessions")"
    }

    private var statusMessage: String {
        if !model.isConnected { return "If this continues, go back to Setup to check the service." }
        if model.sessions.isEmpty { return "Your session will appear here once Squeak detects it. This screen updates automatically." }
        return "Open Squeak or click the menu-bar duck to find yours. This count updates automatically."
    }

    private func instruction(_ number: Int, title: String, message: String) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Text("\(number)").font(Typo.label).foregroundStyle(Theme.ink)
                .frame(width: 26, height: 26)
                .background(Theme.surfaceRaised, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(Typo.label).foregroundStyle(Theme.ink)
                Text(message).font(Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
