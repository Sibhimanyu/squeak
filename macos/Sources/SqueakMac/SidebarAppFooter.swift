import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Version, update actions and progress live together at the foot of the sidebar.
struct SidebarAppFooter: View {
    let updater: AppUpdater
    var version = AppModel.appVersion
    let openShortcuts: () -> Void
    let openSettings: () -> Void

    private var phase: UpdateFlow.Phase { updater.flow.phase }
    private var notes: [String] {
        switch phase {
        case .available: updater.availableNotes
        case .readyToInstall: updater.readyNotes
        default: []
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if updater.needsPermission {
                permission
            } else if let status = UpdateFlowCopy.status(phase, inPlaceDenied: updater.inPlaceInstallDenied) {
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
                                updater.useSidebarPresentation()
                                updater.retryTermination()
                            }
                            .buttonStyle(.plain).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
                        }
                        ForEach(updater.actions, id: \.self) { action in
                            Button(UpdateFlowCopy.label(action)) {
                                updater.useSidebarPresentation()
                                updater.perform(action)
                            }
                            .buttonStyle(.plain)
                            .font(.system(size: 12, weight: action == updater.primaryAction ? .semibold : .regular))
                            .foregroundStyle(action == updater.primaryAction ? Theme.ink : Theme.muted)
                            .padding(.vertical, 3)
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
                }
                Spacer(minLength: 0)
                Button { updater.checkForUpdates(presenting: false) } label: {
                    Lucide(.refreshCw, size: 16, color: Theme.muted)
                        .frame(width: 26, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!updater.isActive)
                .help(updater.isActive ? "Check for updates" : "Updates are available in the installed Squeak app")
                .accessibilityLabel("Check for updates")
                updateOptions
                iconButton(.circleHelp, "Keyboard shortcuts (⌥⌘/)", action: openShortcuts)
                iconButton(.settings, "Settings (⌘,)", action: openSettings)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sidebar)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private var isFailure: Bool { if case .failed = phase { true } else { false } }

    private var updateOptions: some View {
        Menu {
            Button("Check for updates") { updater.checkForUpdates(presenting: false) }
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
            HStack(spacing: 14) {
                Button("Allow") { updater.respondToPermission(true) }
                Button("Not now") { updater.respondToPermission(false) }
            }
            .buttonStyle(.plain).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
        }
    }

    private func iconButton(_ name: LucideName, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(name, size: 16, color: Theme.muted).frame(width: 26, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(label).help(label)
    }
}
