import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: the work pane beside a Duck's chat. A header with the Duck's name, the pin and a close control, then
// the existing view the rail chose (Changes / Files / Artifacts / Terminal), hosted as it is. The rail is the only switcher.

struct WorkPanePane: View {
    let scope: WorkPaneScope
    let view: WorkPaneView
    let width: CGFloat
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = WorkPaneStore.shared
        let duck = scope.key
        VStack(spacing: 0) {
            header(store, duck: duck)
            Rectangle().fill(Theme.line).frame(height: 1)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
    }

    private func header(_ store: WorkPaneStore, duck: String) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.s) {
                Text(verbatim: scope.title).font(Typo.heading).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: Space.s)
                Button { store.setPinned(!store.pane.pinned) } label: {
                    Image(systemName: store.pane.pinned ? "pin.fill" : "pin").font(.system(size: 13))
                        .foregroundStyle(store.pane.pinned ? Theme.ink : Theme.muted)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(store.pane.pinned ? "Unpin: the pane closes when you switch Ducks" : "Pin: keep the pane open when you switch Ducks")
                .accessibilityLabel(store.pane.pinned ? "Unpin work pane" : "Pin work pane")
                .accessibilityAddTraits(store.pane.pinned ? .isSelected : [])
                Button { store.close() } label: {
                    Lucide(.x, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("Close the work pane").accessibilityLabel("Close work pane")
            }
            .padding(.horizontal, Space.m)
            .frame(height: Metrics.header - 8)
        }
    }

    @ViewBuilder private var content: some View {
        switch view {
        case .changes: WorkPaneChanges(scope: scope)
        case .files: WorkPaneFiles(scope: scope)
        case .artifacts: WorkPaneArtifacts(scope: scope)
        case .terminal: WorkPaneTerminal(scope: scope)
        }
    }
}

/// A slim "back" row over a viewer the pane shows in place of a list.
private struct WorkPaneBack: View {
    let title: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 4) {
                    Lucide(.chevronLeft, size: 13, color: Theme.muted)
                    Text(verbatim: title).font(Typo.label).foregroundStyle(Theme.muted)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Space.m).frame(height: 30).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("Back to \(title)")
            Rectangle().fill(Theme.line).frame(height: 1)
        }
    }
}

private struct WorkPaneChanges: View {
    let scope: WorkPaneScope
    @Environment(AppModel.self) private var model
    @AppStorage("changesAsTree") private var asTree = false

    /// The Duck's chat, or (a Pond) a real session working in the Pond's folder; nil when nothing runs there.
    private var session: HostSession? { scope.changesSession(model) }
    private var files: FilesModel? {
        switch scope {
        case .duck(let s): s.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) }
        case .pond(let p): model.filesModel(root: p.root)
        }
    }

    var body: some View {
        if let session {
            if let files, files.review.isOpen {
                VStack(spacing: 0) {
                    WorkPaneBack(title: "Changes") { files.closeReview() }
                    ReviewView(files: files, session: session).heresayPrivate()
                }
            } else {
                VStack(spacing: 0) {
                    let count = model.changesStore(for: session.key.hostSessionId).changes?.files.count
                    HStack {
                        Text(verbatim: count.map(ChangeListing.header(count:)) ?? "Changes").font(Typo.label).foregroundStyle(Theme.muted)
                        Spacer(minLength: 0)
                        Button { asTree.toggle() } label: {
                            Lucide(asTree ? .list : .folderTree, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).help(asTree ? "Show as a list" : "Show as a tree").accessibilityLabel(asTree ? "Show as a list" : "Show as a tree")
                    }
                    .padding(.horizontal, Space.m).frame(height: 34)
                    Rectangle().fill(Theme.line).frame(height: 1)
                    ChangesTab(session: session, activityStamp: model.activity.count, asTree: asTree).heresayPrivate()
                }
            }
        } else {
            // A Pond whose own folder has no Duck working in it: nothing to read, and nothing is made up.
            Text("Nothing is changing in the Pond's own folder. A Duck's changes show in its own view.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

private struct WorkPaneFiles: View {
    let scope: WorkPaneScope
    @Environment(AppModel.self) private var model

    private var root: String? {
        switch scope {
        case .duck(let s): s.cwd.flatMap { $0.isEmpty ? nil : $0 }
        case .pond(let p): p.root
        }
    }
    private var files: FilesModel? { root.map { model.filesModel(root: $0) } }

    var body: some View {
        if let files, let file = files.activeFile {
            VStack(spacing: 0) {
                WorkPaneBack(title: "Files") { files.showChat() }
                FileViewer(files: files, file: file).id(file.path)
            }
        } else {
            switch scope {
            case .duck(let s): FilesTab(session: s).heresayPrivate()
            case .pond(let p): FilesTab(root: p.root, changesSession: p.changesSession(in: model.allSessions), storeKey: p.paneKey).heresayPrivate()
            }
        }
    }
}

private struct WorkPaneArtifacts: View {
    let scope: WorkPaneScope
    @Environment(AppModel.self) private var model

    var body: some View {
        if case .artifact(let pond, let path) = model.location {
            VStack(spacing: 0) {
                WorkPaneBack(title: "Artifacts") { model.leaveArtifact() }
                ArtifactViewerPage(pond: pond, path: path, embedded: true).id(path)
            }
        } else if case .pond(let p) = scope {
            ArtifactsTab(projectId: p.projectId)
        } else if case .duck(let session) = scope, let remote = StreamArtifactsPin.remoteKey(for: session) {
            RemoteArtifactsTab(key: remote)
        } else if case .duck(let session) = scope, let project = StreamArtifactsPin.projectId(for: session) {
            ArtifactsTab(projectId: project)
        } else {
            Text("This Duck's Pond has no artifacts yet.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

/// The Duck's (or the Pond's folder's) terminal, in the pane (there is no bottom dock in the new layout). Shell chips appear with a second shell.
private struct WorkPaneTerminal: View {
    let scope: WorkPaneScope
    private let host = TerminalHost.shared

    private var cwd: String? {
        switch scope {
        case .duck(let s): s.cwd
        case .pond(let p): p.root
        }
    }

    var body: some View {
        let folder = TerminalWorkspace.availability(cwd: cwd).folder
        let tabs = folder.map { host.registry.tabs($0) } ?? []
        let selected = folder.flatMap { host.registry.selected($0)?.id }
        VStack(spacing: 0) {
            if let folder {
                HStack(spacing: 4) {
                    ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                        Button { host.select(workspace: folder, tab.id) } label: {
                            Text(verbatim: InspectorLowerTab.terminalTitle(number: index + 1)).font(Typo.label)
                                .foregroundStyle(selected == tab.id ? Theme.ink : Theme.muted)
                                .padding(.horizontal, 8).frame(height: 24)
                                .background(selected == tab.id ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                    Button { host.add(workspace: folder, folder: folder) } label: {
                        Lucide(.plus, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("New shell").accessibilityLabel("New shell")
                }
                .padding(.horizontal, Space.s).frame(height: 32)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
            switch scope {
            case .duck(let session): TerminalPanelView(session: session)
            case .pond(let p): TerminalPanelView(session: nil, cwd: p.root)
            }
        }
        .onAppear {
            host.focusPending = true
            KeyFocus.shared.setTerminalOpen(true)
        }
        .onDisappear { KeyFocus.shared.setTerminalOpen(false) }
    }
}
