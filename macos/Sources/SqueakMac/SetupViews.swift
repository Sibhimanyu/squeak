import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Setup: what first run covered, done or skipped, with "Set up" to reopen that part.
struct SetupSettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRemove = false

    var body: some View {
        let flow = model.setupFlow
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Setup").font(Typo.title).foregroundStyle(Theme.ink)
                Text("What Squeak set up, and what you skipped. Open any part to do it now.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                ForEach(SetupStage.listed) { stage in row(stage, flow) }
                if let h = model.setup.hooks, h.state == .installed || h.state == .partial {
                    Button("Remove agent hooks…") { confirmRemove = true }
                        .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, Space.s)
                }
            }
            .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 20)
        }
        .task { await model.setup.poll(model) }
        .confirmationDialog("Remove Squeak's agent hooks?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { Task { await model.setup.uninstallHooks() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Squeak stops hearing when Claude Code and Codex need you. Your other settings are left alone.")
        }
    }

    private func detail(_ s: SetupStage) -> String {
        switch s {
        case .connect: "The background service, agent hooks and Conductor's link."
        case .firstWin: "See a session in the menu bar and get a banner when it needs you."
        case .away: "Get pinged on your phone when you're not at your Mac."
        default: ""
        }
    }

    private func row(_ stage: SetupStage, _ flow: SetupFlow) -> some View {
        let state = flow.state(stage)
        return HStack(spacing: Space.s) {
            switch state {
            case .done: Lucide(.check, size: 14, color: Theme.working)
            case .skipped: Circle().strokeBorder(Theme.offline, lineWidth: 1.5).frame(width: 10, height: 10)
            case .todo: Circle().fill(Theme.muted).frame(width: 8, height: 8)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(stage.title).font(Typo.label).foregroundStyle(state == .done ? Theme.muted : Theme.ink)
                Text(detail(stage)).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Text(state == .done ? "Done" : state == .skipped ? "Skipped" : "Not done").font(Typo.meta).foregroundStyle(Theme.muted)
            Button(state == .done ? "Open" : "Set up") {
                model.unskipSetupStage(stage)
                OnboardingController.shared.show(at: stage)
            }
            .buttonStyle(SecondaryButtonStyle())
        }
        .padding(.horizontal, Space.m).padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}
