import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Conductor: whether Squeak's link to Conductor works, and the one button that sets it up.
struct ConductorSettings: View {
    var body: some View {
        ScrollView {
            ConductorRelayCard().padding(.horizontal, 24).padding(.top, 8)
        }
    }
}

/// The status row, the steps and the buttons for the current state. Shared by Settings and Welcome.
struct ConductorRelayCard: View {
    @Environment(AppModel.self) private var model
    @State private var confirmReset = false
    @State private var confirmForce = false

    private var relay: RelayModel { model.relay }

    var body: some View {
        SettingsCard(title: "Your Conductor connection", subtitle: "Bring agent sessions and replies into Squeak.", symbol: "terminal") {
            VStack(alignment: .leading, spacing: Space.m) {
                if relay.needsServiceUpdate {
                    row(dot: Theme.offline, text: "Update the background service")
                    Text("This version of the Squeak service can't set up Conductor. Update it from Settings › Connections and this page fills in.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                } else if let s = relay.status {
                    row(dot: dot(s.state), text: s.message.isEmpty ? fallback(s.state) : s.message)
                    if !s.steps.isEmpty { steps(s.steps) }
                    if s.state == .unsupported {
                        Text("This Conductor version hasn't been tested with Squeak. Setting up anyway may not work.")
                            .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if s.state == .needsRestart {
                        Text("Quit Conductor completely and open it again so it picks up the link.")
                            .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let p = relay.problem {
                        Text(p).font(Typo.body).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true)
                    }
                    buttons(s.state)
                } else {
                    HStack(spacing: Space.s) {
                        ProgressView().controlSize(.small)
                        Text("Checking Conductor…").font(Typo.body).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .task { await relay.poll() }
        .confirmationDialog("Reset Conductor link?", isPresented: $confirmReset) {
            Button("Reset", role: .destructive) { Task { await relay.reset() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes Squeak's link to Conductor; new chats and live replies stop until you set it up again.")
        }
        .confirmationDialog("Set up anyway?", isPresented: $confirmForce) {
            Button("Set up anyway") { Task { await relay.setUp(force: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This Conductor version isn't tested with Squeak.")
        }
    }

    private func row(dot: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            Circle().fill(dot).frame(width: 8, height: 8).padding(.top, 5).accessibilityHidden(true)
            Text(verbatim: text).font(Typo.body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func steps(_ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, step in
                HStack(alignment: .top, spacing: Space.s) {
                    Text("\(i + 1).").font(Typo.body).monospacedDigit().foregroundStyle(Theme.muted)
                    Text(verbatim: step).font(Typo.body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder private func buttons(_ state: RelayState) -> some View {
        HStack(spacing: Space.s) {
            switch state {
            case .off, .error, .unknown:
                Button("Set up Conductor") { Task { await relay.setUp() } }
                    .buttonStyle(PrimaryButtonStyle()).disabled(relay.busy)
            case .needsRestart:
                Button("I restarted Conductor") { Task { await relay.refresh() } }
                    .buttonStyle(PrimaryButtonStyle()).disabled(relay.busy)
            case .waiting:
                Button("Check again") { Task { await relay.refresh() } }.buttonStyle(SecondaryButtonStyle())
            case .connected:
                Button("Reset") { confirmReset = true }.buttonStyle(SecondaryButtonStyle()).disabled(relay.busy)
            case .unsupported:
                Button("Set up anyway") { confirmForce = true }.buttonStyle(SecondaryButtonStyle()).disabled(relay.busy)
            case .notInstalled:
                EmptyView()
            }
            if relay.busy { ProgressView().controlSize(.small); Text("Working…").font(Typo.meta).foregroundStyle(Theme.muted) }
        }
    }

    private func dot(_ s: RelayState) -> Color {
        switch s {
        case .connected: Theme.working
        case .waiting, .needsRestart: Theme.needsYou
        case .error, .unknown: Theme.error
        case .off, .unsupported, .notInstalled: Theme.offline
        }
    }

    private func fallback(_ s: RelayState) -> String {
        switch s {
        case .connected: "Connected"
        case .notInstalled: "Conductor isn't installed"
        default: "Not connected"
        }
    }
}
