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
    var installedNotice: String?
    var dismissInstalledNotice: (() -> Void)?

    private var phase: UpdateFlow.Phase { updater.flow.phase }

    var body: some View {
        if let text = UpdateFlowCopy.status(phase, inPlaceDenied: updater.flow.inPlaceInstallDenied) {
            surface {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: Space.s) {
                        if UpdateFlowCopy.isBusy(phase), updater.flow.phase.progress == nil {
                            ProgressView().controlSize(.small).scaleEffect(0.8).frame(width: 12, height: 12)
                                .accessibilityLabel("Working")
                        }
                        Text(text).font(font).foregroundStyle(failed ? Theme.negative : style == .popup ? Theme.muted : Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.updatesFrequently)
                        Spacer(minLength: 6)
                    }
                    if let value = UpdateFlowCopy.progress(phase) {
                        ProgressView(value: value).tint(style == .popup ? Theme.ink : Theme.primaryFill).controlSize(.small)
                            .accessibilityLabel("Update progress")
                            .accessibilityValue("\(Int((value * 100).rounded())) percent")
                    }
                    FlowLayout(spacing: 12) {
                        buttons
                        if case .installing = phase, updater.canRetryTermination {
                            Button("Try Again") { updater.retryTermination() }
                                .buttonStyle(.plain).font(font).foregroundStyle(Theme.ink)
                        }
                        if failed { ReportProblemButton(problem: text, place: "Update", title: "Report") }
                    }
                    notes
                }
            }
        } else if let installedNotice {
            surface {
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Text(installedNotice).font(font).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 6)
                    Button("Dismiss") { dismissInstalledNotice?() }
                        .buttonStyle(.plain).font(font).foregroundStyle(Theme.ink)
                }
            }
        }
    }

    private var failed: Bool { if case .failed = phase { true } else { false } }

    @ViewBuilder private func surface<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if style == .popup {
            content().padding(10)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line))
                .padding(.top, 8)
        } else { content() }
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
