import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10 (⌘K palette, mock f) and its keyboard map. The palette and the shortcut sheet float over the
// conversation window on a scrim: 640 wide, 120 from the top, `radius-panel`, `surface-raised`, `shadow-float`.
// Matching, ranking and the shortcut list live in SqueakMacCore (`CommandPalette`, `ShortcutRegistry`); this file
// only draws them and maps each action to an existing AppModel method or pane toggle.

extension Notification.Name {
    /// "Search chats" in the palette: the sidebar field takes focus.
    static let squeakFocusSidebarSearch = Notification.Name("SqueakFocusSidebarSearch")
    /// The sidebar's Search row and Back and Forward (⌘[, ⌘]).
    static let squeakOpenPalette = Notification.Name("SqueakOpenPalette")
    static let squeakOpenShortcuts = Notification.Name("SqueakOpenShortcuts")
    static let squeakNavigateBack = Notification.Name("SqueakNavigateBack")
    static let squeakNavigateForward = Notification.Name("SqueakNavigateForward")
}

/// One modifier on the conversation window: ⌘K opens the palette, ⌘⌥/ the shortcut sheet.
struct CommandPaletteHost: ViewModifier {
    @Environment(AppModel.self) private var model
    @AppStorage("sidebarCollapsed") private var sidebarCollapsed = false
    @AppStorage("inspectorOpen") private var inspectorOpen = false
    @AppStorage("terminalOpen") private var terminalOpen = false
    @AppStorage("paletteRecents") private var recentsJSON = ""
    @State private var paletteOpen = false
    @State private var shortcutsOpen = false

    func body(content: Content) -> some View {
        content
            .background {
                VStack {
                    Button("Command palette") { shortcutsOpen = false; paletteOpen.toggle() }
                        .keyboardShortcut("k", modifiers: .command)
                    Button("Keyboard shortcuts") { paletteOpen = false; shortcutsOpen.toggle() }
                        .keyboardShortcut("/", modifiers: [.command, .option])
                    Button("Back") { NotificationCenter.default.post(name: .squeakNavigateBack, object: nil) }
                        .keyboardShortcut("[", modifiers: .command)
                    Button("Forward") { NotificationCenter.default.post(name: .squeakNavigateForward, object: nil) }
                        .keyboardShortcut("]", modifiers: .command)
                    // ⌘T and ⇧⌘N, the registry's "New chat tab" and "New stream".
                    Button("New chat tab") { NewChatController.shared.show() }
                        .keyboardShortcut("t", modifiers: .command)
                    Button("New stream") { perform(.newWorkspace) }
                        .keyboardShortcut("n", modifiers: [.command, .shift])
                        .disabled(!context.canMakeWorkspace)
                }
                .opacity(0).accessibilityHidden(true)
            }
            .onReceive(NotificationCenter.default.publisher(for: .squeakOpenPalette)) { _ in shortcutsOpen = false; paletteOpen = true }
            .onReceive(NotificationCenter.default.publisher(for: .squeakOpenShortcuts)) { _ in paletteOpen = false; shortcutsOpen = true }
            .overlay {
                if paletteOpen {
                    PaletteScrim { paletteOpen = false }
                    CommandPaletteView(items: items, recents: recents, run: run, close: { paletteOpen = false })
                        .transition(.opacity)
                } else if shortcutsOpen {
                    PaletteScrim { shortcutsOpen = false }
                    ShortcutSheetView(close: { shortcutsOpen = false }).transition(.opacity)
                }
            }
    }

    // MARK: What the palette can do now

    private var chat: HostSession? { model.selectedSession }
    private var chatIsNative: Bool { chat?.source == .squeak }
    private var nativeProject: NativeProject? {
        chat.flatMap { NativeWorkspaceMaking.project(named: HomeProjects.projectName($0), in: model.native.projects) }
    }

    private var context: PaletteContext {
        let c = chat
        return PaletteContext(
            chat: c, chatIsNative: chatIsNative,
            chatWaitsOnApproval: chatIsNative && model.native.card?.kind == .approval,
            chatIsWorking: c.map { $0.state == .working && (chatIsNative || $0.conductorSessionId != nil) } ?? false,
            canOpenInHost: model.openHostName != nil && model.openURL != nil, hostName: model.openHostName,
            // Squeak's own chats: the host's git actions (enabled as the header's cluster is); a Conductor chat's PR
            // is a request typed into the chat.
            canCommitPush: nativeGitAllows(.commitPush),
            canCreatePR: chatIsNative
                ? nativeGitAllows(.createPR)
                : c.map { $0.source == .conductor && $0.conductorSessionId != nil && $0.state != .working } ?? false,
            canMakeWorkspace: nativeProject != nil && model.native.makingWorkspaceIn == nil)
    }

    private func nativeGitAllows(_ kind: GitActionKind) -> Bool {
        guard let c = chat, chatIsNative, model.git.busy == nil, let status = model.gitStatus(c) else { return false }
        return GitPresentation.isEnabled(kind, status)
    }

    private var items: [PaletteItem] { CommandPalette.items(sessions: model.sessions, context: context) }

    private var recents: [String] { PaletteRecentsMemo.ids(recentsJSON) }

    private func remember(_ id: String) {
        var r = PaletteRecentsMemo.decoded(recentsJSON)
        r.record(id)
        if let d = try? JSONEncoder().encode(r), let s = String(data: d, encoding: .utf8) { recentsJSON = s }
    }

    // MARK: Running a pick

    private func run(_ item: PaletteItem) {
        remember(item.id)
        paletteOpen = false
        switch item.target {
        case .chat(let key), .workspace(let key):
            model.select(key)
        case .action(let a):
            perform(a)
        }
    }

    private func perform(_ a: PaletteAction) {
        let c = chat
        switch a {
        case .newChat: NewChatController.shared.show()
        case .newWorkspace: if let p = nativeProject { model.nativeMakeWorkspace(projectId: p.id) }
        case .searchChats:
            Task { @MainActor in paletteOpen = true }
        case .toggleSidebar: sidebarCollapsed.toggle()
        case .toggleInspector: inspectorOpen.toggle()
        case .toggleTerminal: if !inspectorOpen { inspectorOpen = true; terminalOpen = true } else { terminalOpen.toggle() }
        case .openSettings: model.openSettings()
        case .openUsage: model.openUsage()
        case .showShortcuts: shortcutsOpen = true
        case .stopChat:
            guard let c else { return }
            Task { if c.source == .squeak { await model.nativeInterrupt(c) } else { await model.stopChat(c) } }
        case .approve: if let c { model.nativeAllow(c) }
        case .deny: if let c { model.nativeDeny(c) }
        case .commitPush: if let c { model.runGitAction(c, .commitPush) }
        case .createPR:
            guard let c else { break }
            if c.source == .squeak { model.runGitAction(c, .createPR) } else { Task { await model.askForPullRequest(c) } }
        case .copyBranch:
            if let b = c?.branch, !b.isEmpty {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(b, forType: .string)
            }
        case .revealFolder:
            if let p = c?.cwd, FileManager.default.fileExists(atPath: p) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
            }
        case .openInHost: model.openInHost()
        }
    }
}

extension View {
    /// ⌘K palette and ⌘⌥/ shortcut sheet over this view.
    func commandPalette() -> some View { modifier(CommandPaletteHost()) }
}

// MARK: Chrome

/// The scrim: 45% black in dark, 28% ink in light (DESIGN.md); a click outside closes.
private struct PaletteScrim: View {
    @Environment(\.colorScheme) private var scheme
    let dismiss: () -> Void
    var body: some View {
        (scheme == .dark ? Color.black.opacity(0.45) : Theme.ink.opacity(0.28))
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture(perform: dismiss)
            .accessibilityHidden(true)
    }
}

private struct PaletteKeycap: View {
    let text: String
    var body: some View {
        Text(text).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
            .padding(.horizontal, 5).frame(minWidth: 20, minHeight: 18)
            .background(Theme.bg.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.chip))
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
    }
}

private struct PalettePanel<Content: View>: View {
    let width: CGFloat
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(spacing: 0, content: content)
            .frame(width: width)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.panel))
            .overlay(RoundedRectangle(cornerRadius: Radius.panel).strokeBorder(Theme.lineStrong.opacity(0.8)))
            .clipShape(RoundedRectangle(cornerRadius: Radius.panel))
            .shadow(color: .black.opacity(0.45), radius: 25, x: 0, y: 18)
            .padding(.top, 120)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

// MARK: Palette

struct CommandPaletteView: View {
    @Environment(AppModel.self) private var model
    let items: [PaletteItem]
    let recents: [String]
    let run: (PaletteItem) -> Void
    let close: () -> Void
    @State private var query = ""
    @State private var index = 0
    @FocusState private var focused: Bool

    private var sections: [PaletteSection] { CommandPalette.results(query: query, items: items, recents: recents) }
    private var flat: [PaletteItem] { sections.flatMap(\.items) }

    var body: some View {
        let sections = self.sections
        let flat = sections.flatMap(\.items)
        PalettePanel(width: 640) {
            HStack(spacing: 12) {
                Lucide(.search, size: 16, color: Theme.muted)
                TextField("Search chats, streams and actions", text: $query)
                    .textFieldStyle(.plain).font(.system(size: 17)).foregroundStyle(Theme.ink)
                    .focused($focused)
                    .onSubmit { if flat.indices.contains(index) { run(flat[index]) } }
                    .accessibilityLabel("Command palette")
            }
            .padding(.horizontal, 16).frame(height: 52)
            Hairline()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        if flat.isEmpty {
                            Text("No matches").font(Typo.body).foregroundStyle(Theme.subtle).padding(.horizontal, 12).padding(.vertical, 16)
                        }
                        ForEach(sections) { section in
                            Text(section.group.title).font(Typo.meta).foregroundStyle(Theme.muted)
                                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                            ForEach(section.items) { item in
                                row(item, selected: flat.indices.contains(index) && flat[index].id == item.id && flat[index].group == section.group)
                                    .id("\(section.group.rawValue)/\(item.id)")
                            }
                        }
                    }
                    .padding(8)
                }
                .frame(maxHeight: 420)
                .onChange(of: index) { _, i in
                    if flat.indices.contains(i) { proxy.scrollTo(anchorId(flat[i]), anchor: nil) }
                }
            }
            Hairline()
            footer
        }
        .onAppear { focused = true }
        .onChange(of: query) { _, _ in index = 0 }
        .onKeyPress(.downArrow) { move(1, count: self.flat.count); return .handled }
        .onKeyPress(.upArrow) { move(-1, count: self.flat.count); return .handled }
        .onKeyPress(.escape) { close(); return .handled }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    private func anchorId(_ item: PaletteItem) -> String { "\(item.group.rawValue)/\(item.id)" }

    private func move(_ d: Int, count: Int) {
        guard count > 0 else { return }
        index = (index + d + count) % count
    }

    @ViewBuilder private func row(_ item: PaletteItem, selected: Bool) -> some View {
        Button { run(item) } label: {
            HStack(spacing: 10) {
                leading(item).frame(width: 20, height: 20)
                Text(item.title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                if !item.context.isEmpty {
                    Text(item.context).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 8)
                if let k = item.shortcut { PaletteKeycap(text: k) }
            }
            .padding(.horizontal, 10).frame(height: 36).frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.selected : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { if $0, let i = flat.firstIndex(where: { $0.id == item.id && $0.group == item.group }) { index = i } }
    }

    @ViewBuilder private func leading(_ item: PaletteItem) -> some View {
        switch item.target {
        case .chat(let key):
            if let s = model.session(key), let mark = model.mark(for: s) {
                ChatMarkGlyph(mark: mark)
            } else {
                Lucide(.messageSquare, size: 14, color: Theme.subtle)
            }
        case .workspace: Lucide(.gitBranch, size: 14, color: Theme.muted)
        case .action(let a): actionIcon(a)
        }
    }

    @ViewBuilder private func actionIcon(_ a: PaletteAction) -> some View {
        switch a {
        case .newChat: Lucide(.plus, size: 14, color: Theme.muted)
        case .newWorkspace: Lucide(.layers, size: 14, color: Theme.muted)
        case .searchChats: Lucide(.search, size: 14, color: Theme.muted)
        case .toggleSidebar: Image(systemName: "sidebar.left").font(.system(size: 13)).foregroundStyle(Theme.muted)
        case .toggleInspector: Image(systemName: "sidebar.right").font(.system(size: 13)).foregroundStyle(Theme.muted)
        case .toggleTerminal: Lucide(.squareTerminal, size: 14, color: Theme.muted)
        case .openSettings: Lucide(.settings, size: 14, color: Theme.muted)
        case .openUsage: Lucide(.gauge, size: 14, color: Theme.muted)
        case .showShortcuts: Lucide(.keyboard, size: 14, color: Theme.muted)
        case .stopChat: Image(systemName: "stop.circle").font(.system(size: 13)).foregroundStyle(Theme.muted)
        case .approve: Lucide(.check, size: 14, color: Theme.muted)
        case .deny: Lucide(.x, size: 14, color: Theme.muted)
        case .commitPush, .createPR: Lucide(.gitBranch, size: 14, color: Theme.muted)
        case .copyBranch: Lucide(.copy, size: 14, color: Theme.muted)
        case .revealFolder: Lucide(.folder, size: 14, color: Theme.muted)
        case .openInHost: Lucide(.externalLink, size: 14, color: Theme.muted)
        }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            hint(["↑", "↓"], "move")
            hint(["↵"], "open")
            hint(["esc"], "close")
            Spacer()
            HStack(spacing: 4) {
                Text("Type").font(Typo.meta).foregroundStyle(Theme.subtle)
                PaletteKeycap(text: ">")
                Text("for actions only").font(Typo.meta).foregroundStyle(Theme.subtle)
            }
        }
        .padding(.horizontal, 16).frame(height: 38)
    }

    private func hint(_ keys: [String], _ label: String) -> some View {
        HStack(spacing: 4) {
            ForEach(keys, id: \.self) { PaletteKeycap(text: $0) }
            Text(label).font(Typo.meta).foregroundStyle(Theme.subtle)
        }
    }
}

// MARK: Shortcut sheet

struct ShortcutSheetView: View {
    let close: () -> Void
    @State private var query = ""
    @FocusState private var focused: Bool

    var body: some View {
        let sections = ShortcutRegistry.sections(matching: query)
        PalettePanel(width: 640) {
            HStack(spacing: 12) {
                Lucide(.keyboard, size: 16, color: Theme.muted)
                TextField("Keyboard shortcuts", text: $query)
                    .textFieldStyle(.plain).font(.system(size: 17)).foregroundStyle(Theme.ink).focused($focused)
                    .accessibilityLabel("Search keyboard shortcuts")
                PaletteKeycap(text: "esc")
            }
            .padding(.horizontal, 16).frame(height: 52)
            Hairline()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if sections.isEmpty {
                        Text("No shortcuts match").font(Typo.body).foregroundStyle(Theme.subtle).padding(12)
                    }
                    ForEach(sections, id: \.area) { section in
                        Text(section.area).font(Typo.meta).foregroundStyle(Theme.muted)
                            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                        ForEach(section.entries) { entry in
                            HStack(spacing: 8) {
                                Text(entry.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                                Spacer(minLength: 8)
                                ForEach(Array(entry.chords.enumerated()), id: \.offset) { _, chord in PaletteKeycap(text: chord.display) }
                            }
                            .padding(.horizontal, 12).frame(height: 30)
                        }
                    }
                }
                .padding(8)
            }
            .frame(maxHeight: 460)
        }
        .onAppear { focused = true }
        .onKeyPress(.escape) { close(); return .handled }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }
}

/// The stored recents decoded once per stored string, not on every palette body.
@MainActor enum PaletteRecentsMemo {
    private static var json = ""
    private static var value = PaletteRecents()

    static func decoded(_ stored: String) -> PaletteRecents {
        if stored != json {
            json = stored
            value = (try? JSONDecoder().decode(PaletteRecents.self, from: Data(stored.utf8))) ?? PaletteRecents()
        }
        return value
    }

    static func ids(_ stored: String) -> [String] { decoded(stored).ids }
}
