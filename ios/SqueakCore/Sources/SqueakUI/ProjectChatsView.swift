#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// The project's chats share one flat list. Provider identity, unread weight, age and activity
/// have separate places, so an animation cannot obscure the information it accompanies.
struct ProjectChatsView: View {
    @Environment(AppModel.self) private var model
    let name: String
    @Binding var path: [HomeRoute]
    @State private var query = ""
    @State private var shownOrder: [String] = []
    @State private var startingChat = false
    @State private var quickReply: PhoneSnapshot.Session?
    @FocusState private var searchFocused: Bool

    private var active: [PhoneSnapshot.Session] {
        model.home.sessions.filter { Presentation.projectName($0) == name }
    }

    private var older: [PhoneSnapshot.Session] {
        model.recentChats.filter { Presentation.projectName($0) == name && !model.isHiddenHere($0) }
    }

    private var sessions: [PhoneSnapshot.Session] {
        StableOrder.arrange(Presentation.newestFirst(active + older), previous: shownOrder) { $0.key }
    }

    private var visible: [PhoneSnapshot.Session] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !search.isEmpty else { return sessions }
        return sessions.filter {
            [Presentation.displayTitle($0), Presentation.subtitle($0), Presentation.secondLine($0) ?? "", $0.message ?? ""]
                .contains { $0.localizedStandardContains(search) }
        }
    }

    private var subtitle: String {
        let count = sessions.count
        let workspaces = Set(sessions.map(Presentation.workspaceName).filter { !$0.isEmpty })
        let scope = workspaces.count == 1 ? workspaces.first : (workspaces.isEmpty ? nil : "\(workspaces.count) workspaces")
        return ["\(count) \(count == 1 ? "chat" : "chats")", scope].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        List {
            header
                .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 20, trailing: 20))
                .listRowSeparator(.hidden)
                .listRowBackground(Theme.bg)
            if visible.isEmpty {
                ContentUnavailableView {
                    Label { Text(query.isEmpty ? "No chats yet" : "No matching chats") } icon: {
                        Lucide(query.isEmpty ? .messageSquare : .search, size: 28, color: Theme.muted)
                    }
                } description: {
                    Text(query.isEmpty ? "Start a chat in this project." : "Try another title, agent or phrase.")
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Theme.bg)
            } else {
                let activeKeys = Set(active.map(\.key))
                ForEach(visible) { session in
                    // A plain button preserves the complete navigation hit target without a disclosure
                    // chevron competing with the timestamp and the trailing activity glyph.
                    Button {
                        Haptics.play(.navigate)
                        path.append(.session(session.key))
                    } label: {
                        SessionRow(session: session, recent: !activeKeys.contains(session.key), inProject: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                        .buttonStyle(.press)
                        .modifier(SessionSwipe(session: session) { quickReply = session })
                        .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                        .alignmentGuide(.listRowSeparatorLeading) { _ in 36 }
                        .listRowSeparatorTint(Theme.line)
                        .listRowBackground(Theme.bg)
                }
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { Haptics.play(.refresh); shownOrder = []; await model.refresh() }
        .onAppear { shownOrder = [] }
        .onChange(of: sessions.map(\.key), initial: true) { _, keys in shownOrder = keys }
        .safeAreaInset(edge: .bottom) { ConnectionBar() }
        .toolbar {
            if model.home.workspaces != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Haptics.play(.tap); startingChat = true } label: {
                        Lucide(.squarePen, size: 20, label: "New chat in \(name)", color: Theme.muted)
                    }
                }
            }
        }
        .sheet(isPresented: $startingChat) { NewChatEntry(project: name) }
        .sheet(item: $quickReply) { session in QuickReply(session: session) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 14) {
                ProjectMark(name: name, size: 48, folder: true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(name).font(.largeTitle.bold()).foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text(subtitle).font(.subheadline).foregroundStyle(Theme.muted)
                }
            }
            HStack(spacing: 10) {
                Lucide(.search, size: 18, color: Theme.muted)
                TextField("Search chats", text: $query)
                    .font(.body).focused($searchFocused)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                    .submitLabel(.search)
                    .onSubmit { searchFocused = false }
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Lucide(.x, size: 16, label: "Clear search", color: Theme.muted)
                    }
                    .buttonStyle(.press)
                    .frame(minWidth: 28, minHeight: 28)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
        }
    }
}

#endif
