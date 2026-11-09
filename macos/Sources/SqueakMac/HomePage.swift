import SqueakIcons
import SqueakMacCore
import SwiftUI

/// DESIGN.md §8.10, Home (⇧⌘H): the workspaces you touched lately, across projects, newest first. **Job:** one place to
/// pick the work back up when no chat is open. Rows carry Squeak's own marks (the folded mark of the workspace's
/// chats, else its age); nothing here is sorted by urgency.
struct HomePage: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let recent = WorkspaceNavigation.recent(model.sidebarTree, limit: 14)
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                HStack(spacing: Space.m) {
                    DuckMark(width: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Home").font(Typo.title).foregroundStyle(Theme.ink)
                        Text(recent.isEmpty ? "Nothing recent." : "Pick up where you left off.").font(Typo.body).foregroundStyle(Theme.muted)
                    }
                }
                if recent.isEmpty {
                    Text("Start a workspace from the sidebar, or open a project.").font(Typo.body).foregroundStyle(Theme.subtle)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Recent").font(Typo.heading).foregroundStyle(Theme.ink).padding(.bottom, Space.xs)
                        ForEach(recent) { item in HomeRow(item: item) }
                    }
                }
            }
            .frame(maxWidth: 640, alignment: .leading)
            .padding(.horizontal, Space.xl).padding(.vertical, Space.xl)
            .frame(maxWidth: .infinity)
        }
    }
}

private struct HomeRow: View {
    let item: RecentWorkspace
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    var body: some View {
        let ws = item.workspace
        Button { if let chat = ws.chats.first { model.select(chat.key) } } label: {
            HStack(spacing: Space.s) {
                Lucide(.gitBranch, size: 14, color: Theme.muted).frame(width: 18)
                Text(verbatim: ws.name).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                Text(verbatim: item.project).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
                if let branch = ws.branchLabel {
                    Text(verbatim: branch).font(Typo.code).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Text(verbatim: "\(ws.chats.count) \(ws.chats.count == 1 ? "chat" : "chats")").font(Typo.meta).foregroundStyle(Theme.subtle)
                MarkSlot(mark: ws.foldedMark?.mark, words: ws.foldedMark?.words, age: ws.lastActivityAt)
            }
            .padding(.horizontal, Space.s).frame(height: 36)
            .background(hovering ? Theme.selected.opacity(0.5) : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel("\(ws.name), \(item.project)")
    }
}
