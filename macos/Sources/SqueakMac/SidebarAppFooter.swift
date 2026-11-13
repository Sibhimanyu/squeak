import AppKit
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
    @AppStorage(UpdatePrompt.dismissedKey) private var dismissedVersion = ""
    private var installer: UpdateInstallController { .shared }
    private var daemon: DaemonManager { AppModel.shared.daemon }
    /// Squeak chats working now: they live in the session host and keep going through an app update.
    private var chatsWorking: Int {
        AppModel.shared.sessions.filter { $0.key.hostSessionId.hasPrefix(NativeAdapter.keyPrefix) && $0.isActive }.count
    }
    /// Install and Restart go through the gate (it asks only when a terminal tab would lose a running command).
    private func act(_ action: UpdateFlowCopy.Action) {
        guard action == .install || action == .restart, let v = updater.availableVersion ?? updater.readyVersion else { updater.perform(action); return }
        installer.request(version: v, offeredVersion: { [updater] in updater.availableVersion ?? updater.readyVersion },
                          perform: { [updater] in updater.installWhenReady() })
    }
    /// The quiet "Later"-able prompt covers only an offered update; every other phase keeps its normal block.
    private var quietOffer: Bool {
        guard case .available = phase else { return false }
        return !updater.inPlaceInstallDenied && updater.availableVersion != nil
    }
    private var promptMode: UpdatePrompt.Mode {
        quietOffer ? UpdatePrompt.mode(available: updater.availableVersion, dismissed: dismissedVersion.isEmpty ? nil : dismissedVersion, installed: version) : .none
    }
    private var phase: UpdateFlow.Phase { updater.flow.phase }
    /// The mapping lives in `UpdateFooterRow`; Cancel is dropped when Sparkle gave nothing to cancel with.
    private var footerItems: [UpdateFooterRow.Item] {
        UpdateFooterRow.items(phase, inPlaceDenied: updater.inPlaceInstallDenied, canRetryTermination: updater.canRetryTermination).filter {
            if case .flow(let a) = $0.kind { return updater.actions.contains(a) }
            return true
        }
    }
    private func run(_ item: UpdateFooterRow.Item) {
        switch item.kind {
        case .flow(let a): act(a)
        case .retryTermination: updater.retryTermination()
        case .later: dismissedVersion = updater.availableVersion ?? ""
        case .restartEngine, .cancelWaiting: break
        }
    }
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
            } else if installer.isWaiting {
                waitingRow
            } else if quietOffer {
                if promptMode == .row { quietRow }
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
                    FlowLayout(spacing: 12) {
                        ForEach(footerItems, id: \.label) { item in
                            Button(item.label) { run(item) }.buttonStyle(.plain).modifier(QuietAction(primary: item.primary))
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
            if daemon.hostPending { engineRow }
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
                Button {
                    if promptMode == .dot { dismissedVersion = "" } else { updater.checkForUpdates() }
                } label: {
                    spinningRefresh
                        .frame(width: 26, height: 28).contentShape(Rectangle())
                        .overlay(alignment: .topTrailing) {
                            if promptMode == .dot { Circle().fill(Theme.muted).frame(width: 6, height: 6).padding(.top, 5).padding(.trailing, 3) }
                        }
                }
                .buttonStyle(.plain)
                .disabled(!updater.isActive || phase == .checking)
                .help(promptMode == .dot ? "Update \(updater.availableVersion ?? "") is waiting" : updater.isActive ? "Check for updates" : "Updates are available in the installed Squeak app")
                .accessibilityLabel(promptMode == .dot ? "Update waiting, show it" : "Check for updates")
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

    /// One quiet line: muted text, then plain text buttons. "Later" puts it away for this version (a dot marks the refresh icon).
    private var quietRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text(UpdateInstallGate.rowLine(version: updater.availableVersion ?? "", chatsWorking: chatsWorking, waiting: false))
                    .font(.system(size: 12)).foregroundStyle(Theme.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                ForEach(footerItems, id: \.label) { item in
                    Button(item.label) { run(item) }.buttonStyle(.plain).modifier(QuietAction(primary: item.primary))
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

    /// "Install when free" is waiting: one muted line and a plain Cancel.
    private var waitingRow: some View {
        HStack(spacing: 10) {
            Text(UpdateInstallGate.rowLine(version: installer.waitingFor ?? "", chatsWorking: 0, waiting: true))
                .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            ForEach(UpdateFooterRow.waitingItems(), id: \.label) { item in
                Button(item.label) { installer.cancel() }.buttonStyle(.plain).modifier(QuietAction(primary: item.primary))
            }
        }
    }

    /// The engine (session host) update is waiting for running chats; "Restart now" confirms before stopping them.
    private var engineRow: some View {
        HStack(spacing: 10) {
            Text(EngineCatchUp.line(chats: daemon.hostWaitingChats)).font(.system(size: 12)).foregroundStyle(Theme.muted)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(UpdateFooterRow.engineRestartLabel) {
                let alert = NSAlert()
                alert.messageText = EngineCatchUp.confirmText(chats: daemon.hostWaitingChats)
                alert.addButton(withTitle: "Restart")
                alert.addButton(withTitle: "Cancel")
                if alert.runModal() == .alertFirstButtonReturn { daemon.restartHostNow() }
            }
            .buttonStyle(.plain).modifier(QuietAction(primary: true))
        }
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

    private var isFailure: Bool { if case .failed(let f) = phase { !f.calm } else { false } }

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
