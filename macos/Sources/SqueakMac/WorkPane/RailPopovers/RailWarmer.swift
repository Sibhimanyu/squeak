import Foundation
import SqueakMacCore

// DESIGN.md 8.12: the rail's lists open at once. While a page with a rail shows, this keeps each list's data loaded and
// current in the background, so a list that opens draws what is already here and refreshes in place (no "Reading..." line,
// no rows jumping). Changes, Artifacts and Tasks come from the host (Changes by a light poll, Artifacts by its event stream,
// Tasks by the Room's own catch-up); Files from the folder on this Mac. All of it is read off the main thread.

@MainActor enum RailWarmer {
    /// Runs until the page goes away. The first pass paints from whatever the host already holds (`cached`), then every pass
    /// reads the current lists.
    static func keepWarm(scope: WorkPaneScope, model: AppModel) async {
        var first = true
        while !Task.isCancelled {
            if model.windowVisible {
                await warmOnce(scope: scope, model: model, cached: first)
                first = false
            }
            try? await Task.sleep(for: .seconds(10))
        }
    }

    static func warmOnce(scope: WorkPaneScope, model: AppModel, cached: Bool) async {
        let pond = model.pondWorkspace
        async let changes: Void = RailChangesSource.refreshBadge(scope: scope, model: model, cached: cached)
        async let files: Void = warmFiles(scope: scope, model: model)
        if let projectId = pond?.project.id {
            ArtifactsStore.shared.model(for: projectId).ensureFollowing(projectId, host: model.nativeHost)
            await PondRoomStore.shared.model(for: projectId).warm(host: model.nativeHost)
        }
        _ = await (changes, files)
    }

    private static func warmFiles(scope: WorkPaneScope, model: AppModel) async {
        let root: String?
        switch scope {
        case .duck(let s): root = s.cwd
        case .pond(let p): root = p.root
        }
        guard let root, !root.isEmpty, FileManager.default.fileExists(atPath: root) else { return }
        await model.filesModel(root: root).warm()
    }
}
