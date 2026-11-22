import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The Artifacts tab (right zone beside a pond page): what the pond's ducks made for the person to look at, grouped by
// duck, newest first. A click opens the artifact full size in the centre (`ArtifactViewer.swift`); each row can open in
// the default app, reveal in Finder, and copy its path. The list is the host's (`GET /native/projects/<id>/artifacts`);
// the rules are in `Ponds/Artifacts.swift`.

@MainActor @Observable
final class ArtifactsModel {
    private(set) var items: [ArtifactItem] = []
    private(set) var loaded = false
    private(set) var failed = false
    private var projectId = ""
    private var task: Task<Void, Never>?

    /// Reads now and again every few seconds (the host answers from a cache), so a duck's new `show` appears at once.
    func follow(_ id: String, host: NativeHostClient) {
        if id != projectId { items = []; loaded = false; failed = false }
        projectId = id
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let rows = try await host.artifacts(projectId: id)
                    guard let self, self.projectId == id else { return }
                    if rows != self.items { self.items = rows }
                    self.loaded = true; self.failed = false
                } catch {
                    self?.failed = true; self?.loaded = true
                }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    func stop() { task?.cancel(); task = nil }
}

/// One list per pond, shared by the tab and the viewer (which reads a file's duck and branch from it).
@MainActor @Observable
final class ArtifactsStore {
    static let shared = ArtifactsStore()
    @ObservationIgnored private var models: [String: ArtifactsModel] = [:]
    func model(for projectId: String) -> ArtifactsModel {
        if let m = models[projectId] { return m }
        let m = ArtifactsModel()
        models[projectId] = m
        return m
    }
}

struct ArtifactsTab: View {
    let projectId: String
    @Environment(AppModel.self) private var model

    private var feed: ArtifactsModel { ArtifactsStore.shared.model(for: projectId) }

    private func open(_ item: ArtifactItem) {
        model.openArtifact(pond: PondsModel.shared.key(forProject: projectId), path: item.path)
    }

    var body: some View {
        list
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: projectId) { feed.follow(projectId, host: model.nativeHost) }
        .onDisappear { feed.stop() }
    }

    @ViewBuilder private var list: some View {
        let groups = Artifacts.grouped(feed.items)
        if groups.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(feed.loaded ? "Nothing to look at yet." : "Looking for artifacts…").font(Typo.heading).foregroundStyle(Theme.ink)
                if feed.loaded {
                    Text(feed.failed
                         ? "Squeak couldn't read this pond's artifacts."
                         : "Pages a duck opens, and design files, slides, documents and media in the pond's folders, show up here.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
            Spacer(minLength: 0)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.m, pinnedViews: []) {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: group.title).font(Typo.meta).foregroundStyle(Theme.subtle)
                                .padding(.horizontal, Space.s).padding(.bottom, 2)
                            ForEach(group.items) { item in ArtifactRow(item: item, selected: model.location.artifactPath == item.path) { open(item) } }
                        }
                    }
                }
                .padding(Space.s)
            }
        }
    }
}

extension ArtifactKind {
    var lucide: LucideName {
        switch self {
        case .page: .globe
        case .doc: .fileText
        case .slides: .layers
        case .video, .audio: .file
        case .image: .image
        case .pdf, .other: .file
        case .psd: .layers
        case .ai: .palette
        case .svg: .penTool
        }
    }
}

private enum ArtifactActions {
    static func openDefault(_ item: ArtifactItem) { NSWorkspace.shared.open(URL(fileURLWithPath: item.path)) }
    static func reveal(_ item: ArtifactItem) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: item.path)]) }
}

private struct ArtifactRow: View {
    let item: ArtifactItem
    var selected = false
    /// A row of a remote pond: the file is on the owner's Mac, so there is no path to open, reveal or copy until it is fetched.
    var remote = false
    let select: () -> Void
    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        HStack(spacing: Space.s) {
            Lucide(item.kind.lucide, size: 16, color: Theme.muted).frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: item.name).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                Text(verbatim: Artifacts.meta(item)).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 4)
            if remote {
                if item.size > 0 { Text(verbatim: Artifacts.sizeText(item.size)).font(Typo.meta).foregroundStyle(Theme.subtle) }
            } else {
                if hovering {
                    iconButton(.externalLink, Artifacts.openLabel(item.kind)) { ArtifactActions.openDefault(item) }
                    iconButton(.folder, "Reveal in Finder") { ArtifactActions.reveal(item) }
                }
                Button(copied ? "Copied" : "Copy") { copy() }
                    .buttonStyle(QuietButtonStyle()).help("Copy path").accessibilityLabel("Copy path of \(item.name)")
            }
        }
        .padding(.horizontal, Space.s).padding(.vertical, 5)
        .background(hovering || selected ? Theme.selected : Color.clear, in: RoundedRectangle(cornerRadius: Radius.row))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: select)
        .contextMenu {
            if !remote {
                Button(Artifacts.openLabel(item.kind)) { ArtifactActions.openDefault(item) }
                Button("Reveal in Finder") { ArtifactActions.reveal(item) }
                Button("Copy path") { copy() }
            }
        }
        .accessibilityElement(children: .combine).accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(item.name), \(Artifacts.meta(item))")
    }

    private func iconButton(_ name: LucideName, _ help: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Lucide(name, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle()) }
            .buttonStyle(.plain).help(help).accessibilityLabel(help)
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(item.path, forType: .string)
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
    }
}


// MARK: A remote pond's Artifacts: the owner's outputs, asked of the owner's Mac

/// The owner's artifact list for one remote pond. Asked when the tab opens (and by Refresh), not on a timer: every ask
/// goes through the pond to the owner's Mac.
@MainActor @Observable
final class RemoteArtifactsModel {
    enum Phase: Equatable { case idle, loading, loaded, offline, refused(String), failed }
    private(set) var items: [ArtifactItem] = []
    private(set) var phase: Phase = .idle
    private(set) var ownerName: String?
    private var loadedAt: Date?
    private var task: Task<Void, Never>?

    /// Loads unless a list younger than `maxAge` is already here (or one is on its way).
    func load(pondId: String, host: NativeHostClient, maxAge: TimeInterval = 90, force: Bool = false) {
        if task != nil { return }
        if !force, let at = loadedAt, Date().timeIntervalSince(at) < maxAge { return }
        phase = .loading
        task = Task { [weak self] in
            let answer = try? await RemoteArtifacts.waitForList(PondsClient(host: host), pond: pondId)
            guard let self else { return }
            self.task = nil
            switch answer {
            case .items(let rows, let owner)?:
                self.items = rows; self.ownerName = owner ?? self.ownerName; self.phase = .loaded; self.loadedAt = Date()
            case .refused(let why)?: self.phase = .refused(why)
            case .pending?: self.phase = .offline
            case nil: self.phase = .failed
            }
        }
    }

    func stop() { task?.cancel(); task = nil; if phase == .loading { phase = items.isEmpty ? .idle : .loaded } }
}

@MainActor @Observable
final class RemoteArtifactsStore {
    static let shared = RemoteArtifactsStore()
    @ObservationIgnored private var models: [String: RemoteArtifactsModel] = [:]
    func model(for key: String) -> RemoteArtifactsModel {
        if let m = models[key] { return m }
        let m = RemoteArtifactsModel()
        models[key] = m
        return m
    }
}

struct RemoteArtifactsTab: View {
    /// The pond's directory key.
    let key: String
    @Environment(AppModel.self) private var model

    private var feed: RemoteArtifactsModel { RemoteArtifactsStore.shared.model(for: key) }
    private var pondId: String? { PondsModel.shared.pond(key: key)?.id }
    private var ownerMac: String { PondsModel.shared.chrome(key: key).ownerMac }

    private func reload(force: Bool = false) {
        guard let pondId else { return }
        feed.load(pondId: pondId, host: model.nativeHost, force: force)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s) {
                Text(verbatim: RemoteArtifacts.fromLine(ownerMac)).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1)
                Spacer(minLength: 0)
                Button(feed.phase == .loading ? "Asking\u{2026}" : "Refresh") { reload(force: true) }
                    .buttonStyle(QuietButtonStyle()).disabled(feed.phase == .loading)
            }
            .padding(.horizontal, Space.m).padding(.top, Space.s)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: key) { reload() }
        .onDisappear { feed.stop() }
    }

    @ViewBuilder private var content: some View {
        let groups = Artifacts.grouped(feed.items)
        if groups.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(headline).font(Typo.heading).foregroundStyle(Theme.ink)
                if let detail { Text(detail).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
                if feed.phase == .offline || feed.phase == .failed {
                    Button("Try again") { reload(force: true) }.buttonStyle(SecondaryButtonStyle())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
            Spacer(minLength: 0)
        } else {
            if feed.phase == .offline || feed.phase == .failed {
                Text(RemoteArtifacts.offline(ownerMac)).font(Typo.meta).foregroundStyle(Theme.muted)
                    .padding(.horizontal, Space.m).padding(.top, Space.s)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.m) {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: group.title).font(Typo.meta).foregroundStyle(Theme.subtle)
                                .padding(.horizontal, Space.s).padding(.bottom, 2)
                            ForEach(group.items) { item in
                                ArtifactRow(item: item, selected: model.location.artifactPath == item.path, remote: true) {
                                    model.openArtifact(pond: key, path: item.path)
                                }
                            }
                        }
                    }
                }
                .padding(Space.s)
            }
        }
    }

    private var headline: String {
        switch feed.phase {
        case .idle, .loading: "Asking \(ownerMac)\u{2026}"
        case .loaded: "Nothing to look at yet."
        case .offline, .failed: "Can\u{2019}t reach \(ownerMac)"
        case .refused: "Not shared"
        }
    }

    private var detail: String? {
        switch feed.phase {
        case .loaded: "Pages, design files, slides, documents and media the owner\u{2019}s ducks make show up here. Code stays on their Mac."
        case .offline: RemoteArtifacts.offline(ownerMac)
        case .failed: "Squeak couldn\u{2019}t read this pond\u{2019}s artifacts."
        case .refused(let why): why
        default: nil
        }
    }
}
