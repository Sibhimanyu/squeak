import Foundation
import SqueakMacCore

/// Keeps the open diff, file and artifact tabs of each Pond live. The strip's refresh loop calls `refresh`; it reads
/// the existing streams (the Duck's changes and git status, the file on disk, the Pond's artifact list) and hands the
/// readings to `PondLiveTabs`, which decides what is "updated" and what is gone. Nothing here closes a tab.
@MainActor @Observable
final class PondLiveTabsModel {
    static let shared = PondLiveTabsModel()
    private(set) var ponds: [String: PondLiveTabs] = [:]

    func live(_ pond: String) -> PondLiveTabs { ponds[pond] ?? PondLiveTabs() }

    /// The person opened `item`: its "updated" mark goes at once, without waiting for the next reading.
    func visit(_ item: TabItem, pond: String) {
        guard var live = ponds[pond], live.isUpdated(item) else { return }
        live.visit(item)
        ponds[pond] = live
    }

    func refresh(workspace: PondWorkspace, model: AppModel) async {
        let pond = workspace.project.id
        let items = model.tabStore.pondItems(pond).filter { [.diff, .reviewAll, .file, .artifact].contains($0.kind) }
        let current = model.tabStore.currentPondItem(pond)
        var live = ponds[pond] ?? PondLiveTabs()
        live.retain(items)
        for item in items {
            let source = await read(item, workspace: workspace, model: model)
            live.observe(item, source, viewing: item == current)
        }
        if live != ponds[pond] { ponds[pond] = live }
    }

    private func read(_ item: TabItem, workspace: PondWorkspace, model: AppModel) async -> PondTabSource {
        switch item.kind {
        case .diff, .reviewAll:
            guard let source = item.diffSource, let key = SessionKey(stringValue: source.session) else { return .unknown }
            let session = model.session(key)
            guard let session else { return PondTabSources.diff(duckExists: false, merged: false, changes: nil, path: source.path) }
            let store = model.changesStore(for: key.hostSessionId)
            await store.refresh(sessionKey: key.hostSessionId, visible: true)
            return PondTabSources.diff(
                duckExists: true, merged: model.gitStatus(session)?.pr?.state == .merged,
                changes: store.changes?.files, path: source.path)
        case .file:
            guard let source = item.fileSource else { return .unknown }
            let (root, path) = (source.root, source.path)
            let stamp = await Task.detached {
                (path.hasPrefix("/") ? URL(fileURLWithPath: path) : FileDisk.resolve(root: root, relative: path)).flatMap(FileDisk.stamp)
            }.value
            return PondTabSources.file(checked: true, stamp: stamp)
        case .artifact:
            guard let source = ArtifactTabID.parse(item.id), source.pond == workspace.pond else { return .unknown }
            let feed = ArtifactsStore.shared.model(for: workspace.project.id)
            if !feed.isFollowing { feed.follow(workspace.project.id, host: model.nativeHost) }
            return PondTabSources.artifact(loaded: feed.loaded, failed: feed.failed, listed: feed.items.first { $0.path == source.path })
        default:
            return .unknown
        }
    }
}
