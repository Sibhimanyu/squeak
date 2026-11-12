import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The phone-calls setup checklist, at the foot of Settings › Phone calls (it lived on the Setup page).
struct PhoneCallsSetupList: View {
    @Environment(AppModel.self) private var model
    @State private var pairingGateway = false

    var body: some View {
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
                .foregroundStyle(list.isReady ? Theme.info : Color.secondary)
        }
        .padding(.horizontal, Space.m).padding(.vertical, Space.s)
        .sheet(isPresented: $pairingGateway, onDismiss: { m.endGatewayPairing() }) {
            GatewayPairSheet().environment(model)
        }
    }

    @ViewBuilder private func checklistMark(_ state: PhoneCallsStep.State) -> some View {
        switch state {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.info)
        case .todo: Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.negative)
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
}
