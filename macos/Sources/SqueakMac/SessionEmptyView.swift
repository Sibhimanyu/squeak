import SwiftUI

/// Shared recovery for an empty live catalog, in the menu panel and the sessions sidebar.
struct SessionEmptyView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: Space.s) {
            Text(title).font(Typo.label).foregroundStyle(Theme.ink)
            Text(message).font(Typo.body).foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            if model.health != nil {
                HStack(spacing: Space.m) {
                    Button("Check again", action: model.recheck).buttonStyle(SecondaryButtonStyle())
                    Button("Review setup") {
                        model.dismissMenuBar?()
                        model.openSettings(.setup)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.ink)
                }
                .padding(.top, Space.xs)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Space.l).padding(.vertical, Space.xl)
    }

    private var title: String {
        if model.health == nil { return "Connecting…" }
        return model.isConnected ? "No sessions yet" : "Check the background service"
    }

    private var message: String {
        if model.health == nil { return "Looking for the Squeak service on this Mac." }
        if !model.isConnected { return "Squeak can’t reach its service. Review Setup to install or repair it, then check again." }
        return "Start a new Claude Code or Codex session in Conductor or your terminal and send a message. Sessions already running during setup may need restarting to pick up the agent hooks."
    }
}
