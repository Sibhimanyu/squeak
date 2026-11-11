import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the workspace of a Squeak chat: its sidebar mark while it sets up or when setup failed, the
// context menu (run script, setup log, archive), the setup log sheet, and the project settings sheet.

/// The age's slot (28x16) for a workspace that is not ready: the quiet loader while it sets up, the failed mark
/// when setup failed; the tooltip carries the words.
struct LifecycleSlot: View {
    let mark: WorkspaceLifecycle.Mark

    var body: some View {
        ZStack {
            switch mark {
            case .settingUp: DotGridLoader(size: 12, quiet: true)
            case .setupFailed: Lucide(.circleX, size: 14, color: Theme.negative).accessibilityHidden(true)
            }
        }
        .frame(width: 28, height: 16, alignment: .trailing)
        .help(WorkspaceLifecycle.words(mark))
        .accessibilityLabel(WorkspaceLifecycle.words(mark))
    }
}

struct WorkspaceMenu: View {
    let workspace: NativeWorkspace
    @Environment(AppModel.self) private var model

    var body: some View {
        let run = model.git.runs[workspace.id]
        let ready = workspace.state == "ready"
        Button(run?.running == true ? "Stop run script" : "Run") { model.toggleRun(workspace) }.disabled(!ready)
        if run?.running == true, let title = WorkspaceLifecycle.openTitle(port: run?.port ?? workspace.port) {
            Button(title) { model.openLocalhost(workspace) }
        }
        if FileManager.default.fileExists(atPath: workspace.path) {
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: workspace.path)]) }
        }
        Divider()
        Button("View setup log…") { model.git.logSheet = LogSheet(workspaceId: workspace.id, name: workspace.displayTitle) }
        Divider()
        Button("Archive stream…", role: .destructive) { model.archiveNativeWorkspace(workspace) }
            .disabled(workspace.state == "setting_up")
    }
}

// MARK: Setup log

struct SetupLogSheet: View {
    let sheet: LogSheet
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var log: NativeWorkspaceLog?
    @State private var failed = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.s) {
                Text("Setup log").font(Typo.heading).foregroundStyle(Theme.ink)
                Text(verbatim: sheet.name).font(Typo.body).foregroundStyle(Theme.muted)
                if let mark = log.flatMap({ WorkspaceLifecycle.mark($0.state) }) { LifecycleSlot(mark: mark) }
                Spacer(minLength: 0)
            }
            ScrollView {
                Text(verbatim: body_).font(Typo.code).foregroundStyle(log?.log.isEmpty == false ? Theme.ink : Theme.muted)
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
            }
            .frame(height: 320)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            HStack(spacing: Space.s) {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(log?.log ?? "", forType: .string)
                    copied = true
                } label: {
                    HStack(spacing: 6) {
                        Lucide(copied ? .check : .copy, size: 13, color: Theme.ink)
                        Text(copied ? "Copied" : "Copy")
                    }
                }
                .buttonStyle(SecondaryButtonStyle()).disabled(log?.log.isEmpty != false)
                Spacer(minLength: 0)
                Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
            }
        }
        .padding(Space.l).frame(width: 640)
        .background(Theme.surfaceRaised)
        .task {
            while !Task.isCancelled {
                if let read = try? await model.nativeHost.workspaceLog(workspaceId: sheet.workspaceId) { log = read; failed = false } else { failed = true }
                // Follows a setup in progress; a finished one is read once.
                if log.map({ $0.state != "setting_up" }) == true { break }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private var body_: String {
        if let text = log?.log, !text.isEmpty { return text }
        if failed { return "Squeak couldn't read the log." }
        return log == nil ? "Reading the log…" : "The setup script printed nothing."
    }
}
