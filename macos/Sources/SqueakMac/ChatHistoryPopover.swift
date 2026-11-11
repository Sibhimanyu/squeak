import SqueakIcons
import SqueakMacCore
import SwiftUI

/// "Chat history" (DESIGN.md §8.10): the clock at the right end of a workspace's tab strip. Every chat of the pond,
/// newest first; typing filters by title and by what was said (the host's search, debounced). Return opens the chat
/// as a tab and closes the list, ⌘Return opens it and stays, Esc closes. The rules are `ChatHistory` (core).
struct ChatHistoryPopover: View {
    let workspace: SidebarWorkspace
    let dismiss: () -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var hits: [ChatSearchHit] = []
    @State private var selection: SessionKey?
    @FocusState private var focused: Bool

    private var project: SidebarProject? {
        guard let key = workspace.chats.first?.key else { return nil }
        return model.sidebarTree.place(of: key)?.project
    }

    private var rows: [ChatHistoryRow] {
        let chats = (project?.workspaces ?? [workspace]).flatMap { ws in
            ws.chats.map { s in
                (session: s, title: model.workbenchTitle(s), place: [ws.displayTitle, ws.branchLabel].compactMap { $0 }.joined(separator: " · "))
            }
        }
        return ChatHistory.rows(chats: chats, query: query, hits: hits, fallbackSnippet: { Self.oneLine(model.lastAgentText($0.key)) })
    }

    var body: some View {
        let shown = rows
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Lucide(.search, size: 13, color: Theme.muted)
                TextField("Search chats", text: $query).textFieldStyle(.plain).font(.system(size: 14)).focused($focused)
                    .onKeyPress(keys: [.upArrow, .downArrow, .return]) { press in handle(press, shown) }
            }
            .padding(.horizontal, 12).frame(height: 40)
            Divider()
            if shown.isEmpty {
                Text(ChatHistory.words(query).isEmpty ? "No chats yet" : "No chats match")
                    .font(.system(size: 13)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.vertical, 28)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(shown) { row in
                                ChatHistoryRowView(row: row, selected: selection == row.key)
                                    .id(row.key)
                                    .onTapGesture { open(row.key, stay: false) }
                                    .onHover { if $0 { selection = row.key } }
                            }
                        }
                        .padding(6)
                    }
                    .onChange(of: selection) { _, key in if let key { proxy.scrollTo(key) } }
                }
            }
        }
        .frame(width: 520, height: 420)
        .onAppear { focused = true; selection = ChatHistory.reselect(selection, in: shown) }
        .onChange(of: query) { _, _ in selection = ChatHistory.reselect(selection, in: rows) }
        .task(id: query) { await search() }
        .onChange(of: hits) { _, _ in selection = ChatHistory.reselect(selection, in: rows) }
        .onExitCommand { dismiss() }
        .accessibilityLabel("Chat history")
    }

    private func handle(_ press: KeyPress, _ shown: [ChatHistoryRow]) -> KeyPress.Result {
        switch press.key {
        case .upArrow: selection = ChatHistory.move(from: selection, in: shown, by: -1)
        case .downArrow: selection = ChatHistory.move(from: selection, in: shown, by: 1)
        default:
            if case let .open(key, stay) = ChatHistory.action(selected: selection, command: press.modifiers.contains(.command)) {
                open(key, stay: stay)
            }
        }
        return .handled
    }

    /// Brings the chat back as a tab (it may have been closed) and shows it; with `stay` only the tab returns.
    private func open(_ key: SessionKey, stay: Bool) {
        if let place = model.sidebarTree.place(of: key) { WorkbenchPrefs.shared.forgetClosed(key, in: place.workspace.id) }
        if !stay {
            model.select(key)
            dismiss()
        }
    }

    /// The host finds words inside Squeak chats' messages; a host without the route leaves title filtering alone.
    private func search() async {
        guard !ChatHistory.words(query).isEmpty else { hits = []; return }
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled else { return }
        let projectId = model.nativeWorkspace(of: workspace)?.projectId
        hits = (try? await model.nativeHost.search(query: query, projectId: projectId)) ?? []
    }

    private static func oneLine(_ text: String?) -> String? {
        guard let t = text?.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces), !t.isEmpty
        else { return nil }
        return String(t.prefix(140))
    }
}

private struct ChatHistoryRowView: View {
    let row: ChatHistoryRow
    let selected: Bool

    private var dot: Color? {
        switch row.state {
        case .working: Theme.working
        case .blocked: Theme.warning
        case .error: Theme.negative
        case .finished: Theme.done
        default: nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Circle().fill(dot ?? .clear).frame(width: 7, height: 7)
                Text(verbatim: row.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 8)
                if let at = row.lastActivityAt {
                    Text(verbatim: ShortRelativeTime.format(at)).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
            }
            Text(verbatim: [row.place, SessionText.agentName(row.agent)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1).padding(.leading, 15)
            if let snippet = row.snippet {
                Text(highlighted(snippet)).font(.system(size: 12)).foregroundStyle(Theme.subtle).lineLimit(1).padding(.leading, 15)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Radius.control).fill(selected ? Theme.selected : .clear))
        .contentShape(Rectangle())
    }

    private func highlighted(_ s: String) -> AttributedString {
        var out = AttributedString(s)
        if let r = row.highlight {
            let chars = Array(s.utf16)
            if r.lowerBound >= 0, r.upperBound <= chars.count,
               let from = String.Index(utf16Offset: r.lowerBound, in: s) as String.Index?,
               let to = String.Index(utf16Offset: r.upperBound, in: s) as String.Index?,
               let range = Range(from..<to, in: out) {
                out[range].foregroundColor = Theme.ink
                out[range].font = .system(size: 12, weight: .semibold)
            }
        }
        return out
    }
}
