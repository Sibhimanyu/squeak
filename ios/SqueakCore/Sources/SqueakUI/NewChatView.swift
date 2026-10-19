#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// "New chat": pick one of the Mac's workspaces, an agent and a first message.
/// The phone only offers what the Mac listed; the Mac checks the list again and
/// the command is signed on this phone behind Face ID, like a reply.
struct NewChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let workspaces: [PhoneSnapshot.Workspace]
    @State private var workspaceId: String?
    @State private var agent = NewChatAgent.claude
    @State private var text = ""
    @State private var sending = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    static let maxCharacters = 20_000

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

    var body: some View {
        NavigationStack {
            Form {
                if workspaces.isEmpty {
                    Section {
                        Text("Your Mac has no workspace to start a chat in. Create one in Conductor first.")
                            .foregroundStyle(Theme.muted)
                    }
                } else {
                    Section("Workspace") {
                        NavigationLink {
                            WorkspacePicker(workspaces: workspaces, selection: $workspaceId) { picked in
                                agent = picked.agent
                            }
                        } label: {
                            Text(workspace?.label ?? "Choose a workspace").lineLimit(1)
                                .foregroundStyle(workspace == nil ? Theme.muted : Theme.ink)
                        }
                        .frame(minHeight: 44)
                    }
                    Section {
                        Picker("Agent", selection: $agent) {
                            Text("Claude").tag(NewChatAgent.claude)
                            Text("Codex").tag(NewChatAgent.codex)
                        }
                        .pickerStyle(.segmented)
                        .listRowBackground(Color.clear)
                    } header: { Text("Agent") } footer: {
                        Text("Starts with that workspace's usual settings.")
                    }
                    Section {
                        ZStack(alignment: .topLeading) {
                            TextEditor(text: $text).focused($focused)
                                .frame(minHeight: 140).scrollContentBackground(.hidden)
                            if text.isEmpty {
                                Text("What should it do?").foregroundStyle(Theme.subtle)
                                    .padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
                            }
                        }
                    } header: { Text("First message") } footer: {
                        if tooLong {
                            Text("That's over the \(Self.maxCharacters)-character limit.").foregroundStyle(Theme.error)
                        } else {
                            Text("Signed on this iPhone and checked by your Mac.")
                        }
                    }
                    if let problem {
                        Section {
                            HStack(alignment: .top, spacing: 10) {
                                StatusDot(color: Theme.error).padding(.top, 6)
                                Text(problem).foregroundStyle(Theme.ink)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .safeAreaInset(edge: .bottom) { if !workspaces.isEmpty { startButton } }
            .interactiveDismissDisabled(sending)
        }
        .foregroundStyle(Theme.ink)
    }

    private var startButton: some View {
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
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(Theme.bg)
    }

    private func start() async {
        guard let workspace else { return }
        focused = false
        sending = true
        problem = nil
        let result = await model.startChat(in: workspace, agent: agent, text: trimmed)
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
