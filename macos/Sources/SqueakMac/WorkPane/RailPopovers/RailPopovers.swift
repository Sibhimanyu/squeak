import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: the rail's one-shot lists. Each is a popover anchored to its icon; picking a row opens a tab (the
// existing open-tab API on AppModel) and closes the popover. Nothing pins them. Labels are never cut: a long name widens
// the row and the list scrolls sideways, like the strip's "all tabs" list.

private enum RailPopoverMetrics {
    static let width: CGFloat = 380
    static let height: CGFloat = 460
}

/// The list's frame: a quiet title line, then the scrolling body.
private struct RailPopoverFrame<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: title).font(Typo.label).foregroundStyle(Theme.muted)
                .padding(.horizontal, Space.m).frame(height: 34, alignment: .leading)
            Rectangle().fill(Theme.line).frame(height: 1)
            content
        }
        .frame(width: RailPopoverMetrics.width, height: RailPopoverMetrics.height)
        .background(Theme.bg)
    }
}

private struct RailListScroll<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 2) { content }
                .padding(Space.s)
                .frame(minWidth: RailPopoverMetrics.width, alignment: .leading)
        }
    }
}

private struct RailPickRow<Leading: View, Trailing: View>: View {
    let title: String
    var detail: String?
    let action: () -> Void
    @ViewBuilder let leading: Leading
    @ViewBuilder let trailing: Trailing
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.s) {
                leading.frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title).font(Typo.body).foregroundStyle(Theme.ink).fixedSize()
                    if let detail { Text(verbatim: detail).font(Typo.meta).foregroundStyle(Theme.subtle).fixedSize() }
                }
                Spacer(minLength: Space.m)
                trailing
            }
            .padding(.horizontal, Space.s).padding(.vertical, 5)
            .frame(minHeight: 30)
            .frame(minWidth: RailPopoverMetrics.width - 2 * Space.s, alignment: .leading)
            .background(hovering ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.row))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(detail.map { "\(title), \($0)" } ?? title)
    }
}

private struct RailEmptyLine: View {
    let text: String
    var body: some View {
        Text(verbatim: text).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Changes

/// Flow: the person opens Changes to see what Ducks changed and picks a file to read its diff in a tab, or picks
/// "Review all from <Duck>" to read every change of that Duck in one tab. On the Dashboard and in the Room the list is
/// the whole Pond's, by Duck; in a Duck it is that Duck's only.
struct RailChangesPopover: View {
    let scope: WorkPaneScope
    let close: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        RailPopoverFrame(title: "Changes") {
            let sections = RailChangesSource.sections(scope: scope, model: model)
            if sections.isEmpty {
                RailEmptyLine(text: RailChangesSource.isLoaded(scope: scope, model: model)
                    ? RailChanges.emptyLine(isPond: scope.isPond) : "Reading the changes…")
                Spacer(minLength: 0)
            } else {
                RailListScroll {
                    ForEach(sections) { section in
                        sectionHeader(section)
                        if let label = section.reviewAllLabel {
                            RailPickRow(title: label, action: { reviewAll(section) }, leading: {
                                Image(systemName: "square.stack").font(.system(size: 12)).foregroundStyle(Theme.muted)
                            }, trailing: { EmptyView() })
                        }
                        ForEach(section.rows) { row in
                            RailPickRow(title: ChangesPresentation.fileName(row.path), detail: ChangeListing.split(row.path).folder.nilIfEmpty,
                                        action: { open(row, in: section) }, leading: { StatusSquare(status: row.status) }, trailing: {
                                HStack(spacing: 5) {
                                    if row.added > 0 { Text("+\(row.added)").foregroundStyle(Theme.success) }
                                    if row.removed > 0 { Text("−\(row.removed)").foregroundStyle(Theme.negative) }
                                }
                                .font(.system(size: 12, design: .monospaced)).monospacedDigit().fixedSize()
                            })
                            .disabled(section.sessionKey == nil)
                        }
                        if section.hidden > 0 {
                            Text("and \(section.hidden) more").font(Typo.meta).foregroundStyle(Theme.subtle)
                                .padding(.horizontal, Space.s).padding(.vertical, 4)
                        }
                    }
                }
            }
        }
        .task { await RailChangesSource.refresh(scope: scope, model: model, force: true) }
    }

    private func sectionHeader(_ section: RailChangeSection) -> some View {
        HStack(spacing: Space.s) {
            Text(verbatim: section.title).font(Typo.meta).fontWeight(.semibold).foregroundStyle(Theme.muted)
            if let branch = section.branch { Text(verbatim: branch).font(Typo.meta).foregroundStyle(Theme.subtle) }
        }
        .fixedSize().padding(.horizontal, Space.s).padding(.top, Space.s).padding(.bottom, 2)
        .accessibilityAddTraits(.isHeader)
    }

    private func session(_ section: RailChangeSection) -> HostSession? {
        section.sessionKey.flatMap { SessionKey(stringValue: $0) }.flatMap { model.session($0) }
    }

    private func open(_ row: RailChangeRow, in section: RailChangeSection) {
        if let session = session(section) { model.openPondDiff(session: session, path: row.path) }
        close()
    }

    private func reviewAll(_ section: RailChangeSection) {
        if let session = session(section) { model.openPondDiff(session: session, path: nil) }
        close()
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// Where the Changes list and the rail's badge read from, by page scope.
@MainActor enum RailChangesSource {
    static func sections(scope: WorkPaneScope, model: AppModel) -> [RailChangeSection] {
        switch scope {
        case .pond(let p):
            guard let changes = PondChangesStore.shared.model(for: p.projectId).changes else { return [] }
            return RailChanges.pondSections(
                changes, sessions: model.allSessions, mainSessionKey: p.changesSession(in: model.allSessions)?.key.stringValue)
        case .duck(let s):
            let files = model.changesStore(for: s.key.hostSessionId).changes?.files ?? []
            let duck = model.pondWorkspace?.roster.ducks?.first { $0.id == s.duckId }
            return RailChanges.duckSection(
                name: duck?.name ?? model.workbenchTitle(s), duckId: s.duckId, branch: s.branch, sessionKey: s.key.stringValue, files: files)
        }
    }

    static func isLoaded(scope: WorkPaneScope, model: AppModel) -> Bool {
        switch scope {
        case .pond(let p): PondChangesStore.shared.model(for: p.projectId).loaded
        case .duck(let s): model.changesStore(for: s.key.hostSessionId).changes != nil
        }
    }

    static func refresh(scope: WorkPaneScope, model: AppModel, force: Bool = false) async {
        switch scope {
        case .pond(let p): await PondChangesStore.shared.model(for: p.projectId).refresh(projectId: p.projectId, host: model.nativeHost, force: force)
        case .duck(let s): await model.changesStore(for: s.key.hostSessionId).refresh(sessionKey: s.key.hostSessionId, visible: true, activityChanged: true)
        }
    }
}

extension WorkPaneScope {
    var isPond: Bool { if case .pond = self { true } else { false } }
}

// MARK: Artifacts

/// Flow: the person opens Artifacts to find something a Duck made and picks it to read it full size in a tab. The whole
/// Pond's artifacts are listed, the current Duck's own first.
struct RailArtifactsPopover: View {
    let scope: WorkPaneScope
    let close: () -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var projectId: String? { model.pondWorkspace?.project.id }

    var body: some View {
        RailPopoverFrame(title: "Artifacts") {
            if let projectId {
                let feed = ArtifactsStore.shared.model(for: projectId)
                let groups = RailArtifacts.groups(feed.items, currentDuckId: currentDuckId, query: query)
                if !feed.items.isEmpty { searchField }
                if groups.isEmpty {
                    RailEmptyLine(text: feed.items.isEmpty
                        ? (feed.loaded ? (feed.failed ? "Squeak couldn't read this Pond's artifacts." : "Nothing to look at yet.") : "Looking for artifacts…")
                        : Artifacts.noMatch(query))
                    Spacer(minLength: 0)
                } else {
                    RailListScroll {
                        ForEach(groups) { group in
                            Text(verbatim: group.title).font(Typo.meta).fontWeight(.semibold).foregroundStyle(Theme.muted)
                                .fixedSize().padding(.horizontal, Space.s).padding(.top, Space.s).padding(.bottom, 2)
                                .accessibilityAddTraits(.isHeader)
                            ForEach(group.items) { item in
                                RailPickRow(title: item.name, detail: Artifacts.meta(item), action: { open(item, projectId: projectId) },
                                            leading: { Lucide(item.kind.lucide, size: 16, color: Theme.muted) }, trailing: { EmptyView() })
                            }
                        }
                    }
                }
            } else {
                RailEmptyLine(text: "This Pond has no artifacts yet.")
                Spacer(minLength: 0)
            }
        }
        .task(id: projectId) {
            if let projectId { ArtifactsStore.shared.model(for: projectId).follow(projectId, host: model.nativeHost) }
        }
        .onDisappear { if let projectId { ArtifactsStore.shared.model(for: projectId).stop() } }
    }

    private var currentDuckId: String? {
        if case .duck(let s) = scope { s.duckId } else { nil }
    }

    private var searchField: some View {
        HStack(spacing: Space.s) {
            Lucide(.search, size: 13, color: Theme.muted)
            TextField("Find an artifact", text: $query).textFieldStyle(.plain).font(Typo.body)
                .accessibilityLabel("Find an artifact")
            if !query.isEmpty {
                Button { query = "" } label: { Lucide(.x, size: 12, color: Theme.muted).frame(width: 20, height: 20) }
                    .buttonStyle(.plain).accessibilityLabel("Clear the search")
            }
        }
        .padding(.horizontal, Space.m).frame(height: 36)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func open(_ item: ArtifactItem, projectId: String) {
        model.openArtifact(pond: PondsModel.shared.key(forProject: projectId), path: item.path)
        close()
    }
}

// MARK: Files

/// Flow: the person opens Files to find a file: types in the search, or picks from Recent (opened or shown by Ducks),
/// or walks the tree of the Pond's folder (in a Duck, that Duck's Stream). Picking a file opens it as a tab.
struct RailFilesPopover: View {
    let scope: WorkPaneScope
    let close: () -> Void
    @Environment(AppModel.self) private var model

    private var root: String? {
        switch scope {
        case .duck(let s): s.cwd.flatMap { $0.isEmpty ? nil : $0 }
        case .pond(let p): p.root.isEmpty ? nil : p.root
        }
    }

    var body: some View {
        RailPopoverFrame(title: "Files") {
            if let root, FileManager.default.fileExists(atPath: root) {
                FilesList(files: model.filesModel(root: root), root: root, close: close)
            } else {
                RailEmptyLine(text: "This folder is not on this Mac.")
                Spacer(minLength: 0)
            }
        }
    }
}

private struct FilesList: View {
    let files: FilesModel
    let root: String
    let close: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.s) {
                Lucide(.search, size: 13, color: Theme.muted)
                TextField("Find a file", text: Bindable(files).filter).textFieldStyle(.plain).font(Typo.body)
                    .accessibilityLabel("Find a file")
                    .onSubmit { if let first = files.filtered.first { pick(first) } }
                if files.isFiltering {
                    Button { files.filter = "" } label: { Lucide(.x, size: 12, color: Theme.muted).frame(width: 20, height: 20) }
                        .buttonStyle(.plain).accessibilityLabel("Clear the search")
                }
            }
            .padding(.horizontal, Space.m).frame(height: 36)
            Rectangle().fill(Theme.line).frame(height: 1)
            RailListScroll {
                if files.isFiltering {
                    if files.filtered.isEmpty { RailEmptyLine(text: "No file matches.") }
                    ForEach(files.filtered, id: \.self) { path in fileRow(path) }
                } else {
                    recent
                    heading("All files")
                    let rows = files.rows
                    if rows.isEmpty { RailEmptyLine(text: files.children[""] == nil ? "Reading the folder…" : "This folder is empty.") }
                    ForEach(rows) { row in treeRow(row) }
                }
            }
        }
        .task(id: root) { await files.refreshTree() }
    }

    @ViewBuilder private var recent: some View {
        if let workspace = model.pondWorkspace {
            let ids = RailRecentStore.shared.ids(in: workspace.project.id, openTabs: model.tabStore.pondItems(workspace.project.id))
            if !ids.isEmpty {
                heading("Recent")
                ForEach(ids, id: \.self) { id in
                    let item = TabItem(.file, id)
                    let path = item.fileSource?.path ?? id
                    RailPickRow(title: ChangesPresentation.fileName(path), detail: ChangeListing.split(path).folder.nilIfEmpty,
                                action: { model.openPondItem(item); close() },
                                leading: { Lucide(.fileText, size: 13, color: Theme.muted) }, trailing: { EmptyView() })
                }
            }
        }
    }

    private func heading(_ text: String) -> some View {
        Text(verbatim: text).font(Typo.meta).fontWeight(.semibold).foregroundStyle(Theme.muted)
            .fixedSize().padding(.horizontal, Space.s).padding(.top, Space.s).padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }

    private func fileRow(_ path: String) -> some View {
        RailPickRow(title: ChangesPresentation.fileName(path), detail: ChangeListing.split(path).folder.nilIfEmpty,
                    action: { pick(path) }, leading: { Lucide(.fileText, size: 13, color: Theme.muted) }, trailing: { EmptyView() })
    }

    private func treeRow(_ row: FileRow) -> some View {
        let e = row.entry
        return Button {
            if e.isDirectory { files.toggle(e.path) } else { pick(e.path) }
        } label: {
            HStack(spacing: 5) {
                Group {
                    if e.isDirectory { Lucide(row.expanded ? .chevronDown : .chevronRight, size: 11, color: Theme.subtle) } else { Color.clear }
                }
                .frame(width: 14)
                Lucide(e.isDirectory ? .folder : .fileText, size: 13, color: row.ignored ? Theme.subtle : Theme.muted)
                Text(verbatim: e.name).font(Typo.body).foregroundStyle(row.ignored ? Theme.subtle : Theme.ink).fixedSize()
                Spacer(minLength: 4)
            }
            .padding(.leading, CGFloat(row.depth) * 12 + 8).padding(.trailing, Space.m)
            .frame(minWidth: RailPopoverMetrics.width - 2 * Space.s, minHeight: 26, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(e.isDirectory ? "\(e.name), folder, \(row.expanded ? "open" : "closed")" : e.name)
    }

    private func pick(_ path: String) {
        files.openFile(path)
        close()
    }
}
