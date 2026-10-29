import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Setup.
struct SetupSettings: View {
    var body: some View {
        ScrollView {
            SetupChecklistView().padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 20)
        }
    }
}

/// The first-run checklist: one row per step, the first unfinished required step carrying the one yellow
/// button, finished steps folded to a tick. Used by Settings › Setup and the Welcome window.
struct SetupChecklistView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRemove = false
    @State private var showExtras = false

    private var checklist: SetupChecklist { model.setupChecklist }

    var body: some View {
        let c = checklist
        VStack(alignment: .leading, spacing: Space.s) {
            header(c)
            ForEach(c.steps.filter(\.required)) { step in
                stepRow(step, primary: c.primary)
            }
            if c.isComplete {
                HStack(alignment: .top, spacing: Space.s) {
                    Image(systemName: "menubar.rectangle").foregroundStyle(Theme.muted).accessibilityHidden(true)
                    Text("Click the duck in your menu bar to see your agents. Start a new agent session to try it.")
                        .font(Typo.body).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, Space.s)
            }
            DisclosureGroup(isExpanded: $showExtras) {
                VStack(alignment: .leading, spacing: Space.s) {
                    ForEach(c.steps.filter { !$0.required }) { step in
                        stepRow(step, primary: nil)
                    }
                    if let h = model.setup.hooks, h.state == .installed || h.state == .partial {
                        Button("Remove agent hooks…") { confirmRemove = true }
                            .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, Space.xs)
                    }
                }
                .padding(.top, Space.s)
            } label: {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("Make it yours").font(Typo.label).foregroundStyle(Theme.ink)
                    Text("Optional · Notifications, shortcuts and phone access")
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                }
            }
            .padding(.top, Space.m)
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
        let required = c.steps.filter(\.required)
        let completed = required.filter { $0.state == .done }.count
        return VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .firstTextBaseline) {
                Text(c.isComplete ? "Ready when you are" : "Connect your agents")
                    .font(Typo.title).foregroundStyle(Theme.ink)
                Spacer()
                Text("\(completed) of \(required.count)")
                    .font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
            }
            ProgressView(value: Double(completed), total: Double(max(required.count, 1)))
                .tint(Theme.working)
                .accessibilityLabel("Essential setup")
                .accessibilityValue("\(completed) of \(required.count) steps complete")
            Text(c.isComplete ? "The essentials are ready. Explore the extras below whenever you like." : "Follow the steps below. You can finish later in Settings › Setup.")
                .font(Typo.body).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, Space.s)
    }

    @ViewBuilder private func stepRow(_ step: SetupStep, primary: SetupStepID?) -> some View {
        if step.state == .done {
            doneRow(step)
        } else {
            SetupStepRow(step: step, isPrimary: primary == step.id, run: run)
        }
    }

    private func doneRow(_ s: SetupStep) -> some View {
        HStack(spacing: Space.s) {
            Lucide(.check, size: 14, color: Theme.working)
            Text(s.id == .hooks ? "Claude Code & Codex connected" : s.title).font(Typo.body).foregroundStyle(Theme.muted)
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
                    Text(step.id == .hooks ? "Connect Claude Code & Codex" : step.title).font(Typo.label).foregroundStyle(step.state == .blocked ? Theme.muted : Theme.ink)
                    Spacer(minLength: 0)
                    if step.state == .blocked {
                        Text("Waiting").font(Typo.meta).foregroundStyle(Theme.muted)
                    } else if isPrimary {
                        Text(step.state == .error ? "Needs attention" : "Next step")
                            .font(Typo.meta).foregroundStyle(Theme.muted)
                    } else if step.state == .optional || (!step.required && step.state != .error) {
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
        case .todo: Theme.muted
        case .error: Theme.error
        case .blocked, .optional: Theme.offline
        }
    }
}
