import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Setup: what first run covered, done or skipped, with "Set up" to reopen that part.
struct SetupSettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRemove = false
    @State private var pairingGateway = false

    var body: some View {
        let flow = model.setupFlow
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("What Squeak set up, and what you skipped. Open any part to do it now.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                ForEach(SetupStage.listed) { stage in row(stage, flow) }
                phoneCallsSetup
                if let h = model.setup.hooks, h.state == .installed || h.state == .partial {
                    Button("Remove agent hooks…") { confirmRemove = true }
                        .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, Space.s)
                }
            }
            .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 20)
        }
        .task { await model.setup.poll(model) }
        .task {
            await model.channels.refreshVoice()
            await model.channels.refreshGateway()
            await model.channels.refreshNaturalSetup()
        }
        .onDisappear { model.channels.stopWatchingNaturalSetup() }
        .sheet(isPresented: $pairingGateway, onDismiss: { model.channels.endGatewayPairing() }) {
            GatewayPairSheet().environment(model)
        }
        .confirmationDialog("Remove Squeak's agent hooks?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { Task { await model.setup.uninstallHooks() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Squeak stops hearing when Claude Code and Codex need you. Your other settings are left alone.")
        }
    }

    private var phoneCallsSetup: some View {
        let m = model.channels
        let list = PhoneCallsChecklist(m.phoneFacts)
        return VStack(alignment: .leading, spacing: Space.s) {
            Text("Phone calls setup").font(Typo.label).foregroundStyle(Theme.ink)
            ForEach(list.steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    checklistMark(step.state).frame(width: 16)
                        .accessibilityLabel(step.state == .done ? "Done" : step.state == .working ? "In progress" : "Needs attention")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.title + (step.isOptional ? " (optional)" : "")).font(Typo.label)
                        Text(step.detail).font(Typo.meta).foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    if let action = step.action {
                        Button(action.label) { run(action) }
                            .buttonStyle(SecondaryButtonStyle())
                            .disabled(actionDisabled(action))
                    }
                }
                .accessibilityElement(children: .contain)
            }
            if let error = m.gatewayError, !pairingGateway { Footnote(error) }
            if let error = m.testError { Footnote(error) }
            if let note = m.naturalSetupNote { Footnote(note) }
            Text(list.summaryLine).font(.callout.weight(.semibold))
                .foregroundStyle(list.isReady ? Theme.done : Color.secondary)
        }
        .padding(.horizontal, Space.m).padding(.vertical, Space.s)
    }

    @ViewBuilder private func checklistMark(_ state: PhoneCallsStep.State) -> some View {
        switch state {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.done)
        case .todo: Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.needsYou)
        case .blocked, .unknown: Image(systemName: "circle").foregroundStyle(Theme.muted)
        case .working: ProgressView().controlSize(.small)
        }
    }

    private func actionDisabled(_ action: PhoneCallsAction) -> Bool {
        let m = model.channels
        return switch action {
        case .pairGateway: m.gatewayConnecting || m.gatewayUpdating
        case .updateAddon: m.gatewayBusy || m.gatewayUpdating || m.gatewayConnecting
        case .testCall: m.testPlacing
        case .installVoice, .retryVoice: m.naturalSetup?.isRunning == true
        case .setExtension, .setPin: false
        }
    }

    private func run(_ action: PhoneCallsAction) {
        let m = model.channels
        switch action {
        case .pairGateway: pairingGateway = true
        case .updateAddon: Task { await m.updateGatewayAddon() }
        case .testCall: Task { await m.testCall() }
        case .installVoice, .retryVoice: Task { await m.startNaturalSetup() }
        case .setExtension:
            model.voiceSettingsTarget = .extensionToRing
            model.openSettings(.voice)
        case .setPin:
            model.voiceSettingsTarget = .pin
            model.openSettings(.voice)
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
