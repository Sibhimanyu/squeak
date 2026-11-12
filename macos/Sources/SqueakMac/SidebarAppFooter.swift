import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Version, update actions and progress live together at the foot of the sidebar.
struct SidebarAppFooter: View {
    let updater: AppUpdater
    var version = AppModel.appVersion
    let openShortcuts: () -> Void
    let openSettings: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var flash = false
    private var phase: UpdateFlow.Phase { updater.flow.phase }
    /// Checking and "Up to date" live in one reserved line under the version, so a check never moves the sidebar.
    private var quickPhase: Bool {
        switch phase { case .checking, .upToDate, .idle: true; default: false }
    }
    private var quickLine: String? {
        switch phase { case .checking, .upToDate: UpdateFlowCopy.footerStatus(phase); default: nil }
    }
    private var notes: [String] {
        switch phase {
        case .available: updater.availableNotes
        case .readyToInstall: updater.readyNotes
        default: []
        }
    }

    var body: some View {
        content
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.ink.opacity(flash ? 0.08 : 0)))
            .onChange(of: updater.highlightTick) { _, _ in
                withAnimation(reduceMotion ? nil : Motion.quick) { flash = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { withAnimation(reduceMotion ? nil : Motion.standard) { flash = false } }
            }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            if updater.needsPermission {
                permission
            } else if !quickPhase, let status = UpdateFlowCopy.footerStatus(phase, inPlaceDenied: updater.inPlaceInstallDenied) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 6) {
                        if UpdateFlowCopy.isBusy(phase), updater.progress == nil {
                            ProgressView().controlSize(.mini).frame(width: 12, height: 14)
                                .accessibilityLabel("Update in progress")
                        }
                        Text(status).font(.system(size: 12)).foregroundStyle(isFailure ? Theme.negative : Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                    if let progress = updater.progress {
                        ProgressView(value: progress).tint(Theme.ink).controlSize(.small)
                            .accessibilityLabel("Update progress")
                            .accessibilityValue("\(Int((progress * 100).rounded())) percent")
                    }
                    FlowLayout(spacing: 8) {
                        if case .installing = phase, updater.canRetryTermination {
                            Button("Try Again") {
                                updater.retryTermination()
                            }
                            .buttonStyle(SecondaryButtonStyle())
                        }
                        ForEach(updater.actions.filter { UpdateFlowCopy.footerActions(phase, inPlaceDenied: updater.inPlaceInstallDenied).contains($0) }, id: \.self) { action in
                            // Real buttons, so Install / Restart to update read as something to press, not as text.
                            Button(UpdateFlowCopy.label(action)) {
                                updater.perform(action)
                            }
                            .buttonStyle(UpdateActionButtonStyle(primary: action == updater.primaryAction))
                        }
                    }
                    if !notes.isEmpty {
                        DisclosureGroup {
                            VStack(alignment: .leading, spacing: 5) {
                                ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                                    Text("• \(note)").font(.system(size: 11)).foregroundStyle(Theme.muted)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .padding(.top, 4)
                        } label: {
                            Text("What's new").font(.system(size: 11)).foregroundStyle(Theme.muted)
                        }
                    }
                }
            }
            HStack(spacing: 4) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Squeak").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
                    Text("v\(version)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted)
                        .textSelection(.enabled).accessibilityLabel("Current version \(version)")
                    Text(quickLine ?? " ").font(.system(size: 11)).foregroundStyle(Theme.subtle)
                        .frame(height: 14, alignment: .leading).opacity(quickLine == nil ? 0 : 1)
                        .animation(Motion.standard, value: quickLine)
                        .accessibilityHidden(quickLine == nil).accessibilityAddTraits(.updatesFrequently)
                }
                Spacer(minLength: 0)
                Button { updater.checkForUpdates() } label: {
                    spinningRefresh
                        .frame(width: 26, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!updater.isActive || phase == .checking)
                .help(updater.isActive ? "Check for updates" : "Updates are available in the installed Squeak app")
                .accessibilityLabel("Check for updates")
                updateOptions
                iconButton(.circleHelp, "Keyboard shortcuts (⌥⌘/)", action: openShortcuts)
                iconButton(.settings, "Settings (⌘,)", action: openSettings)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Motion.standard, value: quickPhase)
        .background(Theme.sidebar)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    @ViewBuilder private var spinningRefresh: some View {
        if phase == .checking && !reduceMotion {
            TimelineView(.animation) { ctx in
                Lucide(.refreshCw, size: 16, color: Theme.ink)
                    .rotationEffect(.degrees(ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9 * 360))
            }
        } else {
            Lucide(.refreshCw, size: 16, color: phase == .checking ? Theme.ink : Theme.muted)
        }
    }

    private var isFailure: Bool { if case .failed = phase { true } else { false } }

    private var updateOptions: some View {
        SqueakMenu {
            Button("Check for updates") { updater.checkForUpdates() }
                .disabled(!updater.isActive)
            Divider()
            Toggle("Check automatically", isOn: Binding(get: { updater.automaticallyChecks }, set: { updater.automaticallyChecks = $0 }))
                .disabled(!updater.isActive)
            Toggle("Download automatically", isOn: Binding(get: { updater.automaticallyInstalls }, set: { updater.automaticallyInstalls = $0 }))
                .disabled(!updater.isActive)
            Divider()
            Button("Settings…", action: openSettings)
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 26, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        .accessibilityLabel("Update options")
    }

    private var permission: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Allow Squeak to check for updates automatically?").font(.system(size: 12)).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Allow") { updater.respondToPermission(true) }.buttonStyle(PrimaryButtonStyle())
                Button("Not now") { updater.respondToPermission(false) }.buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    private func iconButton(_ name: LucideName, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(name, size: 16, color: Theme.muted).frame(width: 26, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(label).help(label)
    }
}
