import SqueakMacCore
import SwiftUI

/// Hosts the existing viewers in the centre. Each item identifies its own source, even if opened from another Duck.
struct PondItemPage: View {
    let item: TabItem
    let workspace: PondWorkspace
    @Environment(AppModel.self) private var model

    var body: some View {
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
                    if let path = source.path {
                        PondDiffTab(session: session, path: path, files: model.filesModel(root: root)) {
                            model.closePondItem(item)
                        }
                    } else {
                        PondReviewAllTab(session: session, files: model.filesModel(root: root))
                    }
                } else {
                    unavailable("This Duck’s changes are unavailable.")
                }
            case .artifact:
                if let source = ArtifactTabID.parse(item.id) {
                    ArtifactViewerPage(pond: source.pond, path: source.path, embedded: true)
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
        .id(item)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .heresayPrivate()
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
    let message: String
    let close: () -> Void

    var body: some View {
        VStack(spacing: Space.s) {
            Text(verbatim: message).font(Typo.body).foregroundStyle(Theme.muted)
            Button("Close tab", action: close).buttonStyle(SecondaryButtonStyle()).fixedSize()
        }
        .padding(Space.l)
    }
}
