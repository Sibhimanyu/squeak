import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the centre: a 44pt header (project / workspace, branch chip, inspector toggle), a 36pt strip
// of the workspace's chats as tabs, then the chat itself (`SessionDetail`, restyled in a later step).

struct WorkbenchCentre: View {
    @Environment(AppModel.self) private var model
    let sidebarHidden: Bool
    @Binding var inspectorOpen: Bool
    let toggleSidebar: () -> Void
    let showingCompose: Bool

    var body: some View {
        let chat = (showingCompose || model.navFilter == .usage) ? nil : model.selectedSession
        VStack(spacing: 0) {
            if let chat {
                let place = model.sidebarTree.place(of: chat.key)
                WorkbenchHeader(
                    session: chat, project: place?.project.name ?? HomeProjects.projectName(chat), workspace: place?.workspace.name,
                    sidebarHidden: sidebarHidden, inspectorOpen: $inspectorOpen, toggleSidebar: toggleSidebar)
                if let workspace = place?.workspace { WorkbenchTabs(workspace: workspace) }
            } else {
                HStack {
                    if sidebarHidden { SidebarToggleButton(action: toggleSidebar).padding(.leading, 78) }
                    Spacer(minLength: 0)
                }
                .frame(height: Metrics.header).background(WindowDragArea())
            }
            if showingCompose {
                DesktopComposePage()
            } else {
                DetailView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct SidebarToggleButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "sidebar.left").font(.system(size: 15)).foregroundStyle(Theme.muted)
                .frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show sidebar")
        .help("Show sidebar (⌘B)")
    }
}

private struct WorkbenchHeader: View {
    let session: HostSession
    let project: String
    let workspace: String?
    let sidebarHidden: Bool
    @Binding var inspectorOpen: Bool
    let toggleSidebar: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: Space.s) {
            if sidebarHidden { SidebarToggleButton(action: toggleSidebar).padding(.leading, 62) }
            HStack(spacing: 6) {
                Text(verbatim: project).foregroundStyle(Theme.muted)
                if let workspace {
                    Text("/").foregroundStyle(Theme.subtle)
                    Text(verbatim: workspace).foregroundStyle(Theme.ink)
                }
            }
            .font(Typo.label).lineLimit(1)
            if let branch = session.branch, !branch.isEmpty {
                HStack(spacing: 4) {
                    Lucide(.gitBranch, size: 11, color: Theme.muted)
                    Text(verbatim: branch).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                }
                .padding(.horizontal, 7).frame(height: 22)
                .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
            }
            HeaderDiffstat(sessionKey: session.key.hostSessionId, activityStamp: model.activity.count)
            Spacer(minLength: 0)
            Button { inspectorOpen.toggle() } label: {
                Image(systemName: "sidebar.right").font(.system(size: 15)).foregroundStyle(inspectorOpen ? Theme.ink : Theme.muted)
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(inspectorOpen ? "Hide inspector" : "Show inspector")
            .help(inspectorOpen ? "Hide inspector (⌘⌥B)" : "Show inspector (⌘⌥B)")
        }
        .padding(.leading, Space.l).padding(.trailing, Space.m)
        .frame(height: Metrics.header)
        .background(WindowDragArea())
    }
}

/// The workspace's chats, newest first (the tree's order), as tabs: 28 high in a 36 strip, 210 at most.
private struct WorkbenchTabs: View {
    let workspace: SidebarWorkspace
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(workspace.chats) { s in tab(s) }
                }
                .padding(.horizontal, Space.m)
            }
            Button { NewChatController.shared.show() } label: {
                Lucide(.plus, size: Metrics.iconSmall, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.trailing, Space.m)
            .accessibilityLabel("New chat").help("New chat (⌘N)")
        }
        .frame(height: Metrics.tabStrip)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func tab(_ s: HostSession) -> some View {
        let selected = model.selected == s.key
        return Button { model.select(s.key) } label: {
            HStack(spacing: 6) {
                Circle().fill(Theme.color(for: s.state)).frame(width: 7, height: 7)
                Text(verbatim: SessionText.headline(s)).font(Typo.body).foregroundStyle(selected ? Theme.ink : Theme.muted).lineLimit(1)
                if s.showsConductorBadge { ConductorChip() }
            }
            .padding(.horizontal, 10).frame(height: 28).frame(maxWidth: 210)
            .background(selected ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(SessionText.headline(s)), \(SessionText.stateWord(s))")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
