#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// "New chat": where it starts, which agent, which model and how hard it thinks, and the first message.
/// The phone only offers what the Mac listed (the workspaces, and the models Conductor's own picker has);
/// the Mac checks both again, and the command is signed on this phone behind Face ID, like a reply.
struct NewChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let workspaces: [PhoneSnapshot.Workspace]
    @State private var workspaceId: String?
    @State private var agent = NewChatAgent.claude
    @State private var modelId: String?
    @State private var level: String?
    @State private var showingAllModels = false
    @State private var text = ""
    @State private var sending = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    static let maxCharacters = 20_000
    /// Models shown before "More models": the favourites, or the first few.
    private static let shortList = 4

    init(workspaces: [PhoneSnapshot.Workspace]) {
        self.workspaces = workspaces
        let args = ProcessInfo.processInfo.arguments
        let first = workspaces.first
        _workspaceId = State(initialValue: first?.id)
        _agent = State(initialValue: first?.agent ?? .claude)
        if args.contains("-squeak-newchat-filled") {
            _text = State(initialValue: "Add a retry with backoff to the payment webhook, and cover it with a test.")
        }
        if args.contains("-squeak-newchat-error") {
            _problem = State(initialValue: "That workspace isn't available any more. Pick another.")
        }
    }

    private var workspace: PhoneSnapshot.Workspace? { workspaces.first { $0.id == workspaceId } }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var tooLong: Bool { trimmed.count > Self.maxCharacters }
    private var canStart: Bool { workspace != nil && !trimmed.isEmpty && !tooLong && !sending }

    /// The models for the chosen agent, favourites first as the Mac listed them. Empty from an older Mac.
    private var models: [PhoneSnapshot.ChatModel] { (model.snapshot?.chatModels ?? []).filter { $0.agent == agent.rawValue } }
    private var chosen: PhoneSnapshot.ChatModel? { models.first { $0.id == modelId } ?? models.first }
    private var shownModels: [PhoneSnapshot.ChatModel] {
        guard !showingAllModels, models.count > Self.shortList else { return models }
        let favourites = models.filter(\.favorite)
        let short = favourites.count >= 2 ? favourites : Array(models.prefix(Self.shortList))
        // A chosen model outside the short list stays on screen.
        if let chosen, !short.contains(where: { $0.id == chosen.id }) { return short + [chosen] }
        return short
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if workspaces.isEmpty {
                        card { Text("Your Mac has no workspace to start a chat in. Create one in Conductor first.")
                            .foregroundStyle(Theme.muted).padding(16) }
                    } else {
                        section("Where") { workspaceRow }
                        section("Agent") { agentTiles }
                        if !models.isEmpty {
                            section("Model") { modelList }
                            if let chosen, !chosen.levels.isEmpty {
                                section("Thinking", footer: "More thinking is slower and uses more of your plan.") { levelChips(chosen) }
                            }
                        }
                        section("First message", footer: messageFooter) { messageField }
                        if let problem { problemRow(problem) }
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .safeAreaInset(edge: .bottom) { if !workspaces.isEmpty { startBar } }
            .interactiveDismissDisabled(sending)
            .onAppear { settleChoice() }
            .onChange(of: agent) { _, _ in modelId = nil; level = nil; settleChoice() }
            .onChange(of: model.snapshot?.chatModels) { _, _ in settleChoice() }
        }
        .foregroundStyle(Theme.ink)
    }

    /* ---------- pieces ---------- */

    private func section<Content: View>(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted).padding(.leading, 4)
                .accessibilityAddTraits(.isHeader)
            card { content() }
            if let footer {
                Text(footer).font(.footnote).foregroundStyle(tooLong && title == "First message" ? Theme.error : Theme.muted).padding(.horizontal, 4)
            }
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }

    private var workspaceRow: some View {
        NavigationLink {
            WorkspacePicker(workspaces: workspaces, selection: $workspaceId) { picked in agent = picked.agent }
        } label: {
            HStack(spacing: 12) {
                if let workspace { ProjectMark(name: Presentation.split(label: workspace.label).repo ?? workspace.label, size: 32, folder: true) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(workspace.map { Presentation.split(label: $0.label).repo ?? $0.label } ?? "Choose a workspace")
                        .font(.headline).foregroundStyle(workspace == nil ? Theme.muted : Theme.ink).lineLimit(1)
                    if let workspace, let branch = Presentation.split(label: workspace.label).repo == nil ? nil : Presentation.split(label: workspace.label).title as String? {
                        Text(branch).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Lucide(.chevronRight, size: 16, color: Theme.subtle)
            }
            .padding(14).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Choose another workspace")
    }

    private var agentTiles: some View {
        HStack(spacing: 10) {
            ForEach(NewChatAgent.allCases, id: \.self) { option in
                let selected = option == agent
                Button { agent = option; UISelectionFeedbackGenerator().selectionChanged() } label: {
                    HStack(spacing: 10) {
                        Image(option == .claude ? "agent-claude" : "agent-codex", bundle: .module).resizable().scaledToFit().frame(width: 28, height: 28)
                            .accessibilityHidden(true)
                        Text(Presentation.agentName(option.rawValue)).font(.headline)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 52)
                    .background(selected ? Theme.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? Theme.lineStrong : Theme.line, lineWidth: selected ? 1.5 : 1))
                    .contentShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Presentation.agentName(option.rawValue))
                .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(10)
    }

    private var modelList: some View {
        VStack(spacing: 0) {
            ForEach(Array(shownModels.enumerated()), id: \.element.id) { index, option in
                if index > 0 { Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 14) }
                Button { modelId = option.id; level = option.defaultLevel; UISelectionFeedbackGenerator().selectionChanged() } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.label).font(.body).foregroundStyle(Theme.ink).lineLimit(1)
                            if option.favorite { Text("Favorite in Conductor").font(.caption).foregroundStyle(Theme.muted) }
                        }
                        Spacer(minLength: 8)
                        if option.id == chosen?.id { Lucide(.check, size: 18, color: Theme.ink) }
                    }
                    .padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.label + (option.favorite ? ", favorite" : ""))
                .accessibilityAddTraits(option.id == chosen?.id ? [.isButton, .isSelected] : .isButton)
            }
            if models.count > shownModels.count || showingAllModels && models.count > Self.shortList {
                Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 14)
                Button { withAnimation(.easeOut(duration: 0.2)) { showingAllModels.toggle() } } label: {
                    HStack {
                        Text(showingAllModels ? "Fewer models" : "More models (\(models.count - shownModels.count))").font(.subheadline.weight(.medium))
                        Spacer(minLength: 8)
                        Lucide(showingAllModels ? .chevronUp : .chevronDown, size: 14, color: Theme.subtle)
                    }
                    .padding(.horizontal, 14).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func levelChips(_ chosen: PhoneSnapshot.ChatModel) -> some View {
        HStack(spacing: 6) { chips(chosen) }
            .padding(10)
    }

    @ViewBuilder
    private func chips(_ chosen: PhoneSnapshot.ChatModel) -> some View {
        ForEach(chosen.levels, id: \.self) { option in
            let selected = option == (level ?? chosen.defaultLevel)
            Button { level = option; UISelectionFeedbackGenerator().selectionChanged() } label: {
                Text(Self.levelName(option, short: true)).font(.subheadline.weight(selected ? .semibold : .regular))
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .foregroundStyle(selected ? Theme.ink : Theme.muted)
                    .padding(.horizontal, 4).frame(maxWidth: .infinity, minHeight: 44)
                    .background(selected ? Theme.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? Theme.lineStrong : Theme.line, lineWidth: selected ? 1.5 : 1))
                    .contentShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Self.levelName(option))
            .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        }
    }

    /// "Extra high" in words, "X-high" where five chips share a row.
    static func levelName(_ level: String, short: Bool = false) -> String {
        switch level {
        case "xhigh": short ? "X-high" : "Extra high"
        default: level.prefix(1).uppercased() + level.dropFirst()
        }
    }

    private var messageField: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $text).focused($focused)
                .frame(minHeight: 140).scrollContentBackground(.hidden).padding(.horizontal, 10).padding(.vertical, 6)
            if text.isEmpty {
                Text("What should it do?").foregroundStyle(Theme.subtle)
                    .padding(.top, 14).padding(.leading, 15).allowsHitTesting(false)
            }
        }
    }

    private var messageFooter: String {
        tooLong ? "That's over the \(Self.maxCharacters)-character limit." : "Signed on this iPhone and checked by your Mac."
    }

    private func problemRow(_ message: String) -> some View {
        card {
            HStack(alignment: .top, spacing: 10) {
                StatusDot(color: Theme.error).padding(.top, 6)
                Text(message).foregroundStyle(Theme.ink)
            }
            .padding(14).accessibilityElement(children: .combine)
        }
    }

    /// What will start, in one line, over the button: the choice is on screen before it is made.
    private var summary: String {
        var parts: [String] = []
        if let chosen {
            parts.append(chosen.label)
            if !chosen.levels.isEmpty { parts.append("\(Self.levelName(level ?? chosen.defaultLevel ?? "medium").lowercased()) thinking") }
        } else {
            parts.append(Presentation.agentName(agent.rawValue))
        }
        if let workspace { parts.append(Presentation.split(label: workspace.label).repo ?? workspace.label) }
        return parts.joined(separator: " · ")
    }

    private var startBar: some View {
        VStack(spacing: 8) {
            Text(summary).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
            Button { Task { await start() } } label: {
                HStack(spacing: 8) {
                    if sending { ProgressView().tint(Theme.primaryText) }
                    Text(sending ? "Starting…" : "Start chat").font(.headline)
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 12))
            .tint(Theme.primaryFill)
            .foregroundStyle(Theme.primaryText)
            .disabled(!canStart)
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(Theme.bg)
    }

    /// Keeps the model and level on something the Mac offers for the chosen agent.
    private func settleChoice() {
        guard let first = models.first(where: \.favorite) ?? models.first else { return }
        let current = models.first { $0.id == modelId } ?? first
        modelId = current.id
        if let level, current.levels.contains(level) { return }
        level = current.defaultLevel ?? current.levels.first
    }

    private func start() async {
        guard let workspace else { return }
        focused = false
        sending = true
        problem = nil
        // What is on screen is what is sent: the model and level, when the Mac listed any.
        let picked = chosen
        let result = await model.startChat(
            in: workspace, agent: agent, text: trimmed,
            model: picked?.id, thinking: picked.flatMap { $0.levels.isEmpty ? nil : (level ?? $0.defaultLevel) })
        sending = false
        switch result {
        case .started: dismiss()
        case .cancelled: break
        case let .refused(reason): problem = reason
        }
    }
}

/// Every workspace the Mac listed, searchable by repo or branch.
private struct WorkspacePicker: View {
    let workspaces: [PhoneSnapshot.Workspace]
    @Binding var selection: String?
    let onPick: (PhoneSnapshot.Workspace) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var shown: [PhoneSnapshot.Workspace] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? workspaces : workspaces.filter { $0.label.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        List {
            ForEach(shown) { workspace in
                Button {
                    selection = workspace.id
                    onPick(workspace)
                    dismiss()
                } label: {
                    HStack {
                        Text(workspace.label).lineLimit(1)
                        Spacer(minLength: 8)
                        Text(Presentation.agentName(workspace.defaultAgent)).font(.subheadline).foregroundStyle(Theme.muted)
                        if workspace.id == selection {
                            Lucide(.check, size: 18, label: "Selected", color: Theme.ink)
                        }
                    }
                    .frame(minHeight: 44)
                }
                .foregroundStyle(Theme.ink)
                .listRowBackground(Color.clear)
            }
            if shown.isEmpty { ContentUnavailableView.search(text: query).listRowBackground(Color.clear) }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Workspace")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search workspaces…")
    }
}
#endif
