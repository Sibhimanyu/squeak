#if os(iOS)
import SqueakCore
import SwiftUI

/// "On your Mac": the running apps as icons, the one in front highlighted, and under them the controls for that
/// app, which change with it: Conductor's workspaces and their chats, a browser's or Terminal's tabs, or a line
/// saying there is nothing to switch inside. Tapping an app brings it to the front and the controls follow.
/// Everything shown is what the Mac answered; this only draws it.
struct NowOnMacCard: View {
    @Environment(AppModel.self) private var model
    let apps: [PhoneSnapshot.MacApp]
    let open: (String) -> Void
    let quit: (PhoneSnapshot.MacApp) -> Void
    let more: () -> Void

    @State private var tabs: FrontTabs?
    @State private var busy = false
    @State private var problem: String?
    /// The workspace whose chats show: the one on screen until you pick another.
    @State private var picked: String?

    private var front: PhoneSnapshot.MacApp? { apps.first { $0.active == true } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            appStrip
            if let front {
                Rectangle().fill(Theme.line).frame(height: 1)
                header(front)
                content
                if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.muted) }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .task(id: apps.map(\.id).joined(separator: ",")) { await model.loadAppIcons(apps.map(\.id)) }
        // The controls follow whichever app is in front: read again when that changes.
        .task(id: front?.id ?? "") {
            picked = nil
            await load()
        }
    }

    private func load(_ change: ControlsCommand.Change = .listTabs) async {
        busy = true
        let (answer, failure) = await model.frontTabs(change)
        if let answer { tabs = answer }
        problem = failure
        busy = false
    }

    // MARK: Apps

    private var appStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 6) {
                ForEach(apps) { app in
                    Button { open(app.id) } label: { appTile(app) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Bring to front", systemImage: "macwindow") { open(app.id) }
                            Button("Quit \(app.name)", systemImage: "xmark.circle", role: .destructive) { quit(app) }
                        }
                        .accessibilityLabel(app.active == true ? "\(app.name), in front" : app.name)
                        .accessibilityHint("Brings it to the front. Hold to quit it.")
                }
                Button(action: more) {
                    VStack(spacing: 6) {
                        Image(systemName: "square.grid.2x2").font(.system(size: 20, weight: .medium)).foregroundStyle(Theme.muted)
                            .frame(width: 44, height: 44)
                            .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.lineStrong))
                        Text("All apps").font(.caption2).foregroundStyle(Theme.muted)
                    }
                    .frame(width: 64)
                }
                .buttonStyle(.plain)
            }
            .padding(.vertical, 2)
        }
    }

    private func appTile(_ app: PhoneSnapshot.MacApp) -> some View {
        let inFront = app.active == true
        return VStack(spacing: 6) {
            Group {
                if let icon = model.appIcons[app.id] {
                    Image(uiImage: icon).resizable().interpolation(.high).scaledToFit()
                } else {
                    // Until the icon arrives: the app's first letter, never a blank square.
                    Text(String(app.name.prefix(1))).font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.ink)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 11))
                }
            }
            .frame(width: 44, height: 44)
            .padding(3)
            .background(inFront ? Theme.surfaceRaised : .clear, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(inFront ? Theme.lineStrong : .clear))
            Text(app.name).font(.caption2).foregroundStyle(inFront ? Theme.ink : Theme.muted).lineLimit(1)
        }
        .frame(width: 64)
    }

    // MARK: The app in front

    private func header(_ front: PhoneSnapshot.MacApp) -> some View {
        HStack(spacing: 8) {
            Text(MacControlsFormat.tabsTitle(tabs?.app?.id == front.id ? tabs : nil, fallback: front.name))
                .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            Spacer()
            Button { Task { await load() } } label: {
                if busy { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise") }
            }
            .foregroundStyle(Theme.muted).frame(minWidth: 44, minHeight: 32)
            .accessibilityLabel("Read again")
        }
    }

    @ViewBuilder
    private var content: some View {
        if let tabs, tabs.app?.id == front?.id {
            if let workspaces = tabs.workspaces, !workspaces.isEmpty {
                conductor(workspaces)
            } else if let list = tabs.tabs, !list.isEmpty {
                ForEach(list) { tab in
                    row(tab.title, current: tab.selected) { Task { await load(.selectTab(tab.index, title: tab.title)) } }
                }
            } else {
                Text(tabs.note ?? "Nothing to switch inside \(front?.name ?? "this app").").font(.footnote).foregroundStyle(Theme.muted)
            }
        } else if busy {
            Text("Reading \(front?.name ?? "the app")…").font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    /// Workspaces as chips (tap: Conductor goes there, to its newest chat), the chosen one's chats as rows below.
    private func conductor(_ workspaces: [FrontTabs.Workspace]) -> some View {
        let shown = workspaces.first { $0.id == picked } ?? workspaces.first { $0.current == true } ?? workspaces[0]
        return VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(workspaces) { workspace in
                        Button {
                            picked = workspace.id
                            if let first = workspace.chats.first, workspace.current != true {
                                Task { await load(.showChat(first.id)) }
                            }
                        } label: { workspaceChip(workspace, chosen: workspace.id == shown.id) }
                        .buttonStyle(.plain)
                        .disabled(busy)
                        .accessibilityLabel(workspace.current == true ? "\(workspace.name), open in Conductor" : workspace.name)
                    }
                }
                .padding(.vertical, 1)
            }
            if shown.chats.isEmpty {
                Text("No chats open in this workspace.").font(.footnote).foregroundStyle(Theme.muted)
            }
            ForEach(shown.chats) { chat in
                row(chat.title, current: chat.current == true, working: chat.working) { Task { await load(.showChat(chat.id)) } }
            }
        }
    }

    private func workspaceChip(_ workspace: FrontTabs.Workspace, chosen: Bool) -> some View {
        let parts = workspace.name.components(separatedBy: " · ")
        return HStack(spacing: 8) {
            if let repo = workspace.repo, let icon = model.projectIcon(repo) {
                Image(uiImage: icon).resizable().scaledToFill().frame(width: 22, height: 22).clipShape(RoundedRectangle(cornerRadius: 5))
            } else {
                Text(String((workspace.repo ?? workspace.name).prefix(1)).uppercased())
                    .font(.caption.weight(.bold)).foregroundStyle(Theme.ink)
                    .frame(width: 22, height: 22).background(Theme.surface, in: RoundedRectangle(cornerRadius: 5))
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(parts.first ?? workspace.name).font(.caption.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                if parts.count > 1 { Text(parts[1]).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1) }
            }
            if workspace.current == true { Circle().fill(Theme.working).frame(width: 6, height: 6).accessibilityHidden(true) }
        }
        .padding(.horizontal, 10).frame(minHeight: 44)
        .frame(maxWidth: 200)
        .background(chosen ? Theme.surfaceRaised : .clear, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(chosen ? Theme.lineStrong : Theme.line))
    }

    private func row(_ title: String, current: Bool, working: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if working { Circle().fill(Theme.working).frame(width: 7, height: 7).accessibilityHidden(true) }
                Text(title).font(.subheadline).lineLimit(1).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                if current { Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(current ? Theme.lineStrong : Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(working ? "\(title), working" : title)
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}
#endif
