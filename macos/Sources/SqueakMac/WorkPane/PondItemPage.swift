import SqueakMacCore
import SwiftUI

/// Hosts the existing viewers in the centre. Each item identifies its own source, even if opened from another Duck.
struct PondItemPage: View {
    let item: TabItem
    let workspace: PondWorkspace
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let gone = PondLiveTabsModel.shared.live(workspace.project.id).goneState(item) {
                // The source is gone: say so, and leave closing to the person.
                PondItemUnavailable(title: gone.title, message: gone.detail) { model.closePondItem(item) }
            } else {
                content
            }
        }
        .id(item)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .heresayPrivate()
        .onAppear { PondLiveTabsModel.shared.visit(item, pond: workspace.project.id) }
    }

    @ViewBuilder private var content: some View {
        Group {
            switch item.kind {
            case .file:
                if let source = item.fileSource {
                    PondFilePage(files: model.filesModel(root: source.root), path: source.path) { model.closePondItem(item) }
                } else {
                    unavailable("This file is unavailable.")
                }
            case .diff, .reviewAll:
                if let source = item.diffSource, let key = SessionKey(stringValue: source.session),
                   let session = model.session(key), let root = session.cwd, !root.isEmpty {
                    // A Stream's tab opens its files from the Stream's folder; the chat's folder is the Pond's.
                    let filesRoot = model.streamRoot(source.stream) ?? root
                    if let path = source.path {
                        PondDiffTab(session: session, path: path, stream: source.stream, files: model.filesModel(root: filesRoot)) {
                            model.closePondItem(item)
                        }
                    } else {
                        PondReviewAllTab(session: session, stream: source.stream, files: model.filesModel(root: filesRoot))
                    }
                } else {
                    unavailable("This Duck’s changes are unavailable.")
                }
            case .artifact:
                if let source = ArtifactTabID.parse(item.id) {
                    ArtifactTab(pond: source.pond, path: source.path)
                } else {
                    unavailable("This artifact is unavailable.")
                }
            case .notebook:
                ScrollView {
                    PondNotebookSection(project: workspace.project)
                        .frame(maxWidth: 640, alignment: .leading)
                        .padding(Space.l).frame(maxWidth: .infinity, alignment: .top)
                }
            case .duck, .duckling:
                EmptyView()
            }
        }
    }

    private func unavailable(_ message: String) -> some View {
        PondItemUnavailable(message: message) { model.closePondItem(item) }
    }
}

private struct PondFilePage: View {
    let files: FilesModel
    let path: String
    let close: () -> Void
    @State private var read = false

    var body: some View {
        Group {
            if let file = files.open.first(where: { $0.path == path }) {
                FileViewer(files: files, file: file)
            } else if read {
                PondItemUnavailable(message: "This file could not be opened.", close: close)
            } else {
                Text("Reading the file…").font(Typo.body).foregroundStyle(Theme.muted)
            }
        }
        .task {
            await files.loadPondFile(path)
            read = true
        }
    }
}

private struct PondItemUnavailable: View {
    var title: String?
    let message: String
    let close: () -> Void

    var body: some View {
        VStack(spacing: Space.s) {
            if let title { Text(verbatim: title).font(Typo.heading).foregroundStyle(Theme.ink) }
            Text(verbatim: message).font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Button("Close tab", action: close).buttonStyle(SecondaryButtonStyle()).fixedSize()
        }
        .padding(Space.l)
    }
}
