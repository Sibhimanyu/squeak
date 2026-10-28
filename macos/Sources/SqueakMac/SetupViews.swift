import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Setup.
struct SetupSettings: View {
    var body: some View {
        ScrollView {
            SetupChecklistView().padding(.horizontal, 28).padding(.leading, 20).padding(.top, 8).padding(.bottom, 20)
        }
    }
}

/// The first-run checklist: one row per step, the first unfinished required step carrying the one yellow
/// button, finished steps folded to a tick. Used by Settings › Setup and the Welcome window.
struct SetupChecklistView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRemove = false

    private var checklist: SetupChecklist { model.setupChecklist }

    var body: some View {
        let c = checklist
        VStack(alignment: .leading, spacing: Space.s) {
            header(c)
            ForEach(c.steps) { step in
                if step.state == .done { doneRow(step) } else { SetupStepRow(step: step, isPrimary: c.primary == step.id, run: run) }
            }
            if let h = model.setup.hooks, h.state == .installed || h.state == .partial {
                Button("Remove agent hooks…") { confirmRemove = true }
                    .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, Space.xs)
            }
        }
        .task { await model.setup.poll(model) }
        .confirmationDialog("Remove Squeak's agent hooks?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { Task { await model.setup.uninstallHooks() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Squeak stops hearing when Claude Code and Codex need you. Your other settings are left alone.")
        }
    }

    private func header(_ c: SetupChecklist) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack {
                Text(c.isComplete ? "You're set up" : "Finish setting up").font(Typo.heading).foregroundStyle(Theme.ink)
                Spacer()
                Text(c.progressLabel).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
            }
            Text("Required steps first. Everything else is optional and can wait.")
                .font(Typo.body).foregroundStyle(Theme.muted)
        }
        .padding(.bottom, Space.xs)
        .accessibilityElement(children: .combine)
    }

    private func doneRow(_ s: SetupStep) -> some View {
        HStack(spacing: Space.s) {
            Lucide(.check, size: 14, color: Theme.working)
            Text(s.title).font(Typo.body).foregroundStyle(Theme.muted)
            Spacer()
        }
        .padding(.horizontal, Space.m).padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(s.title), done")
    }

    private func run(_ action: SetupAction) {
        switch action {
        case .installService:
            model.daemon.repair()
        case .repairService:
            model.daemon.repair()
        case .installHooks:
            Task { await model.setup.installHooks() }
        case .setUpConductor:
            model.setup.conductorSkipped = false
            Task { await model.relay.setUp() }
        case .skipConductor:
            model.setup.conductorSkipped = true
        case .requestNotifications:
            Notifier.shared.requestAuthorization()
            Task { await model.setup.refresh(model) }
        case .openNotificationSettings:
            open("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        case .grantInputMonitoring:
            HotKeyCenter.shared.requestInputMonitoring()
        case .openAccessibility:
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        case .openChannels:
            model.openSettings(.connections)
        }
    }

    private func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }
}

private struct SetupStepRow: View {
    let step: SetupStep
    let isPrimary: Bool
    let run: (SetupAction) -> Void
    @Environment(AppModel.self) private var model

    private var busy: Bool {
        switch step.id {
        case .service: model.daemon.busy || model.setupFacts.service == .installing
        case .hooks: model.setup.hooksBusy
        case .conductor: model.relay.busy
        default: false
        }
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Circle().fill(dot).frame(width: 8, height: 8).accessibilityHidden(true)
                    Text(step.title).font(Typo.label).foregroundStyle(step.state == .blocked ? Theme.muted : Theme.ink)
                    if step.state == .optional || (!step.required && step.state != .error) {
                        Text("Optional").font(Typo.meta).foregroundStyle(Theme.subtle)
                    }
                }
                Text(verbatim: step.why).font(Typo.body).foregroundStyle(step.state == .error ? Theme.error : Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if step.id == .conductor, isPrimary, step.state == .todo || step.state == .error {
                    ConductorRelayCard()
                    if let skip = step.secondaryAction, let title = step.secondaryTitle {
                        Button(title) { run(skip) }.buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                } else {
                    buttons
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var buttons: some View {
        HStack(spacing: Space.s) {
            if let action = step.action, let title = step.actionTitle {
                if isPrimary {
                    Button(title) { run(action) }.buttonStyle(PrimaryButtonStyle()).disabled(busy)
                } else {
                    Button(title) { run(action) }.buttonStyle(SecondaryButtonStyle()).disabled(busy || step.state == .blocked)
                }
            }
            if let skip = step.secondaryAction, let title = step.secondaryTitle {
                Button(title) { run(skip) }.buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            if busy { ProgressView().controlSize(.small); Text("Working…").font(Typo.meta).foregroundStyle(Theme.muted) }
        }
    }

    private var dot: Color {
        switch step.state {
        case .done: Theme.working
        case .todo: Theme.needsYou
        case .error: Theme.error
        case .blocked, .optional: Theme.offline
        }
    }
}
