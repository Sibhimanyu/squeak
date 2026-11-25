import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: the work pane beside a Duck's chat. A header with the Duck's name, the pin and a close control, a
// segmented picker (Changes / Files / Canvas / Terminal), then the existing view for that choice, hosted as it is.

struct WorkPanePane: View {
    let session: HostSession
    let view: WorkPaneView
    let width: CGFloat
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = WorkPaneStore.shared
        let duck = WorkPaneActions.duckKey(session)
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
                Text(verbatim: model.workbenchTitle(session)).font(Typo.heading).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
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
            Picker("View", selection: Binding(get: { view }, set: { store.open($0, duck: duck) })) {
                ForEach(WorkPaneView.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden()
            .padding(.horizontal, Space.m).padding(.bottom, Space.s)
        }
    }

    @ViewBuilder private var content: some View {
        switch view {
        case .changes: WorkPaneChanges(session: session)
        case .files: WorkPaneFiles(session: session)
        case .canvas: WorkPaneCanvas(session: session)
        case .terminal: WorkPaneTerminal(session: session)
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
    let session: HostSession
    @Environment(AppModel.self) private var model
    @AppStorage("changesAsTree") private var asTree = false

    private var files: FilesModel? { session.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) } }

    var body: some View {
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
    }
}

private struct WorkPaneFiles: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    private var files: FilesModel? { session.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) } }

    var body: some View {
        if let files, let file = files.activeFile {
            VStack(spacing: 0) {
                WorkPaneBack(title: "Files") { files.showChat() }
                FileViewer(files: files, file: file).id(file.path)
            }
        } else {
            FilesTab(session: session).heresayPrivate()
        }
    }
}

private struct WorkPaneCanvas: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if case .artifact(let pond, let path) = model.location {
            VStack(spacing: 0) {
                WorkPaneBack(title: "Canvas") { model.leaveArtifact() }
                ArtifactViewerPage(pond: pond, path: path, embedded: true).id(path)
            }
        } else if let remote = StreamArtifactsPin.remoteKey(for: session) {
            RemoteArtifactsTab(key: remote)
        } else if let project = StreamArtifactsPin.projectId(for: session) {
            ArtifactsTab(projectId: project)
        } else {
            Text("This Duck's Pond has no canvases yet.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

/// The Duck's terminal, in the pane (there is no bottom dock in the new layout). Shell chips appear with a second shell.
private struct WorkPaneTerminal: View {
    let session: HostSession
    private let host = TerminalHost.shared

    var body: some View {
        let folder = TerminalWorkspace.availability(cwd: session.cwd).folder
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
            TerminalPanelView(session: session)
        }
        .onAppear {
            host.focusPending = true
            KeyFocus.shared.setTerminalOpen(true)
        }
        .onDisappear { KeyFocus.shared.setTerminalOpen(false) }
    }
}
