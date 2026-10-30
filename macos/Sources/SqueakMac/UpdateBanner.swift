import SqueakMacCore
import SwiftUI

/// What the update is doing and what the person can do about it, drawn from `AppUpdater.flow`: the menu-bar popup
/// banner and Settings › About › Updates both use it, so they always agree. Pressing a button is never a silent
/// no-op: the flow starts, attaches to or queues the work, or shows why it cannot.
///
/// Update available [Install] > Downloading 2.x… 42% (bar, [Cancel] when Sparkle can) > Preparing 2.x… >
/// Update 2.x is ready [Restart to update] > Restarting Squeak… (spinner) ; a failure shows one plain sentence with
/// [Try again] [Download manually] [Dismiss]; when macOS refused the in-place install it is [Download update]
/// [Open App Management settings] [Try again] [Dismiss], and later updates on that Mac lead with Download update.
struct UpdateBanner: View {
    enum Style { case popup, settings }

    let updater: AppUpdater
    var style: Style = .popup

    private var phase: UpdateFlow.Phase { updater.flow.phase }

    var body: some View {
        if let text = UpdateFlowCopy.status(phase, inPlaceDenied: updater.flow.inPlaceInstallDenied) {
            VStack(alignment: .leading, spacing: 5) {
                if case .failed = phase {
                    Text(text).font(font).foregroundStyle(Theme.error)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    HStack(spacing: 14) { buttons }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        if UpdateFlowCopy.isBusy(phase), updater.flow.phase.progress == nil {
                            ProgressView().controlSize(.small).scaleEffect(0.8).frame(width: 12, height: 12)
                                .accessibilityLabel("Working")
                        }
                        Text(text).font(font).foregroundStyle(style == .popup ? Theme.muted : Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.updatesFrequently)
                        Spacer(minLength: 6)
                        HStack(spacing: 12) { buttons }
                    }
                }
                if let value = UpdateFlowCopy.progress(phase) {
                    ProgressView(value: value).tint(Theme.primaryFill).controlSize(.small)
                        .accessibilityLabel("Update progress")
                        .accessibilityValue("\(Int((value * 100).rounded())) percent")
                }
                notes
            }
        }
    }

    private var primary: UpdateFlowCopy.Action? { UpdateFlowCopy.primaryAction(phase, inPlaceDenied: updater.flow.inPlaceInstallDenied) }

    private var font: Font { style == .popup ? .system(size: 12) : .callout }

    @ViewBuilder private var buttons: some View {
        ForEach(updater.actions, id: \.self) { action in
            Button(UpdateFlowCopy.label(action)) { updater.perform(action) }
                .buttonStyle(.plain)
                .font(.system(size: style == .popup ? 12 : 13, weight: action == primary ? .semibold : .medium))
                .foregroundStyle(style == .popup ? Theme.ink : Color.accentColor)
        }
    }

    @ViewBuilder private var notes: some View {
        switch phase {
        case .available: UpdateNotesDisclosure(notes: updater.availableNotes, size: style == .popup ? 11.5 : 12)
        case .readyToInstall: UpdateNotesDisclosure(notes: updater.readyNotes, size: style == .popup ? 11.5 : 12)
        default: EmptyView()
        }
    }
}

private extension UpdateFlow.Phase {
    var progress: Double? { UpdateFlowCopy.progress(self) }
}
