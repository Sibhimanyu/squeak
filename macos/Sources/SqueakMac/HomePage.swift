import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The desktop landing page. Workspace state drives the board; opening a card resumes its relevant chat.
struct DashboardPage: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    private let pins = WorkbenchPrefs.shared

    private var columns: [DashboardColumn] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let board = DashboardBoard.build(model.sidebarTree, pins: pins.pins.ids)
        return (model.dashboardFilter?.apply(to: board) ?? board).map { column in
            DashboardColumn(lane: column.lane, workspaces: column.workspaces.filter { item in
                query.isEmpty
                    || [item.project, item.workspace.name, item.workspace.branch ?? ""]
                        .contains { $0.localizedCaseInsensitiveContains(query) }
                    || item.workspace.chats.contains { model.workbenchTitle($0).localizedCaseInsensitiveContains(query) }
            })
        }
    }

    var body: some View {
        let columns = self.columns
        VStack(alignment: .leading, spacing: 0) {
            header
            HStack(spacing: 12) {
                SearchField(text: $query, placeholder: "Filter workspaces…")
                    .frame(maxWidth: 320)
                Spacer(minLength: 0)
                let total = columns.reduce(0) { $0 + $1.workspaces.count }
                Text("\(total) \(total == 1 ? "workspace" : "workspaces")")
                    .font(Typo.meta).foregroundStyle(Theme.muted).monospacedDigit()
            }
            .padding(.horizontal, Space.xl).padding(.bottom, Space.l)
            GeometryReader { geometry in
                let width = max(220, (geometry.size.width - 36) / 4)
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(columns) { column in
                            DashboardLaneView(column: column, pinned: pins.pins.ids)
                                .frame(width: width, height: geometry.size.height)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .padding(.horizontal, Space.xl).padding(.bottom, Space.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: Space.l) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Dashboard").font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                if let filter = model.dashboardFilter {
                    Button { model.dashboardFilter = nil } label: {
                        HStack(spacing: 6) {
                            Text("Showing \(filter.label)")
                            Lucide(.x, size: 12, color: Theme.muted)
                        }
                    }
                    .buttonStyle(.plain).font(Typo.body).foregroundStyle(Theme.muted)
                    .accessibilityLabel("Show all workspaces")
                } else {
                    Text("Your workspaces, at a glance.").font(Typo.body).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 12)
            if let resume = model.dashboardResumeSession {
                Button { model.select(resume.key) } label: {
                    HStack(spacing: 7) {
                        Text("Continue last workspace")
                        Lucide(.arrowRight, size: 14, color: Theme.ink)
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
                .help("Continue \(model.workbenchTitle(resume))")
            }
        }
        .padding(.horizontal, Space.xl).padding(.top, Space.l).padding(.bottom, Space.xl)
    }
}

private struct DashboardLaneView: View {
    let column: DashboardColumn
    let pinned: Set<String>

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(column.lane.title).font(Typo.label).foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("\(column.workspaces.count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 2).frame(height: 24)
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if column.workspaces.isEmpty {
                        Text(column.lane.emptyMessage).font(Typo.body).foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4).padding(.vertical, 20)
                    }
                    ForEach(column.workspaces) { item in
                        DashboardWorkspaceCard(item: item, lane: column.lane, pinned: pinned.contains(item.id))
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .padding(12)
        .background(Theme.sidebar.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(column.lane.title)
    }
}

private struct DashboardWorkspaceCard: View {
    @Environment(AppModel.self) private var model
    let item: RecentWorkspace
    let lane: DashboardLane
    let pinned: Bool
    @State private var hovered = false

    var body: some View {
        let workspace = item.workspace
        let chat = DashboardBoard.destination(in: workspace)
        Button { if let chat { model.select(chat.key) } } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text(verbatim: item.project).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                    Spacer(minLength: 4)
                    if pinned { Lucide(.pin, size: 11, color: Theme.subtle) }
                    MarkSlot(mark: chat.flatMap { model.mark(for: $0) }, age: workspace.lastActivityAt)
                }
                Text(verbatim: chat.map { model.workbenchTitle($0) } ?? workspace.name)
                    .font(Typo.label).foregroundStyle(Theme.ink).lineLimit(3)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                if let preview = preview(chat), !preview.isEmpty {
                    Text(verbatim: preview).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                HStack(spacing: 5) {
                    Lucide(.gitBranch, size: 11, color: Theme.subtle)
                    Text(verbatim: workspace.branch ?? workspace.name).font(Typo.meta).foregroundStyle(Theme.muted)
                        .lineLimit(1).truncationMode(.middle)
                }
                HStack(spacing: 6) {
                    Text("\(workspace.chats.count) \(workspace.chats.count == 1 ? "chat" : "chats")")
                        .font(Typo.meta).foregroundStyle(Theme.subtle)
                    Spacer(minLength: 0)
                    if let chat { AgentAvatar(session: chat, size: 14) }
                }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(hovered ? Theme.selected : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(hovered ? Theme.lineStrong : Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(chat == nil)
        .onHover { hovered = $0 }
        .accessibilityLabel("\(chat.map { model.workbenchTitle($0) } ?? workspace.name), \(item.project), \(lane.title)")
        .help("Open \(workspace.name) in \(item.project)")
        .contextMenu {
            Button(pinned ? "Unpin" : "Pin to top") { WorkbenchPrefs.shared.togglePin(workspace.id) }
        }
    }

    private func preview(_ chat: HostSession?) -> String? {
        guard let chat else { return nil }
        if chat.state == .blocked { return model.question(for: chat.key) }
        if chat.state == .working { return model.liveStep(chat.key) }
        return model.menuReplyPreviews[chat.key]
    }
}
