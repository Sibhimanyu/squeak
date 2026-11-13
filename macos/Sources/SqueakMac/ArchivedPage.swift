import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the Archived page: every archived thread across all ponds, grouped by pond, newest archived first,
// with search. Open shows a thread read-only (a Squeak chat's composer is replaced by Unarchive); Unarchive puts it
// back in the lists. What goes where is decided in `ArchivedPage`; this only draws.

struct ArchivedPageView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var ponds: PondsModel { .shared }

    var body: some View {
        let sessions = model.allSessions
        let shared = ponds.hides.all
        let groups = ArchivedPage.groups(sessions: sessions, shared: shared, query: query, title: { model.workbenchTitle($0) },
            pondOf: { session in ponds.key(of: session).map { ponds.name(key: $0) } })
        let total = ArchivedPage.count(sessions: sessions, shared: shared)
        ScrollView {
            VStack(alignment: .leading, spacing: Space.m) {
                Text("Archived").font(Typo.title).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Text("Threads you put away. Squeak chats stay in Squeak; any other thread is hidden in Squeak only, and a thread someone else started is hidden from your view only.")
                    .font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted).accessibilityHidden(true)
                    TextField("Find an archived thread or pond", text: $query).textFieldStyle(.plain)
                        .font(Typo.body).accessibilityLabel("Find an archived thread or pond")
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .buttonStyle(.borderless).foregroundStyle(Theme.muted).accessibilityLabel("Clear search")
                    }
                }
                .padding(12).background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                if groups.isEmpty {
                    Text(total == 0 ? ArchivedPage.emptyWords : ArchivedPage.noMatchWords)
                        .font(Typo.body).foregroundStyle(Theme.muted).padding(.vertical, Space.m)
                } else {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: Space.xs) {
                            Text(verbatim: group.pond).font(Typo.label).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                            VStack(spacing: 0) {
                                ForEach(group.entries) { entry in ArchivedRow(entry: entry) }
                            }
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                        }
                    }
                }
            }
            .padding(Space.xl).frame(maxWidth: 760).frame(maxWidth: .infinity)
        }
        .scrollContentBackground(.hidden)
    }
}

private struct ArchivedRow: View {
    let entry: ArchivedEntry
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            ThreadDuckView(id: entry.id, agent: entry.agent, size: ThreadDuck.Size.sidebarRow)
            Text(verbatim: entry.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
            Spacer(minLength: 8)
            Text(entry.archivedAt, style: .relative).font(Typo.meta).foregroundStyle(Theme.subtle)
            Button("Open") { open() }.buttonStyle(.borderless).font(Typo.footnote).foregroundStyle(Theme.ink)
            Button("Unarchive") { unarchive() }.buttonStyle(.borderless).font(Typo.footnote).foregroundStyle(Theme.ink)
        }
        .padding(.horizontal, 12).frame(height: 40)
        .background(hovering ? Theme.selected.opacity(0.4) : .clear)
        .onHover { hovering = $0 }
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(entry.title), \(entry.pond)")
    }

    private func open() {
        switch entry.target {
        case .session(let key): model.select(key)
        case .shared(let pondId, let threadId):
            PondsModel.shared.route = .thread(project: entry.pond == ArchivedPage.otherPond ? "" : entry.pond, pondId: pondId, threadId: threadId)
        }
    }

    private func unarchive() {
        switch entry.target {
        case .session(let key): if let s = model.session(key) { model.archiveThread(s, archived: false) }
        case .shared(_, let threadId): PondsModel.shared.unhideShared(threadId: threadId)
        }
    }
}
