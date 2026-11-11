#if os(iOS)
import SqueakCore
import SqueakIcons
import SqueakMarkup
import SwiftUI

/// A Squeak (native) chat's open request, as a card: an approval (Allow once / Allow for this chat / Deny), a plan
/// (Approve / Keep planning) or a question (its options, then Send). The words come from `NativeWords`; the Mac
/// matches the tap against the session host's current request, so a request answered elsewhere comes back refused.
struct NativeRequestCard: View {
    let request: NativeRequest
    let agentName: String
    let session: PhoneSnapshot.Session
    @Environment(AppModel.self) private var model
    @State private var sending = false
    @State private var result: (delivered: Bool, line: String)?
    /// Per question, the labels picked.
    @State private var picked: [Int: Set<String>] = [:]

    private static let keepPlanning = "Keep planning; don't make changes yet."

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(NativeWords.heading(request, agentName: agentName)).font(.headline).accessibilityAddTraits(.isHeader)
            content
            if let result, result.delivered {
                Label { Text(result.line) } icon: { Lucide(.check, size: 14, color: Theme.muted) }
                    .font(.footnote).foregroundStyle(Theme.muted)
            } else {
                actions
                if let result, !result.line.isEmpty {
                    Text(result.line).font(.footnote).foregroundStyle(Theme.muted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var content: some View {
        if request.kind == "plan" {
            MessageText(markdown: request.plan ?? request.summary, style: .squeak)
                .padding(14)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        } else if request.kind == "question" {
            ForEach(Array((request.questions ?? []).enumerated()), id: \.offset) { index, prompt in
                VStack(alignment: .leading, spacing: 8) {
                    if let header = prompt.header { Text(header).font(.footnote).foregroundStyle(Theme.muted) }
                    Text(prompt.question).font(.headline)
                    ForEach(prompt.options, id: \.label) { option in optionRow(index, prompt, option) }
                }
            }
        } else if let target = NativeWords.target(request) {
            Text(target)
                .font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        }
    }

    private func optionRow(_ index: Int, _ prompt: NativeRequest.Question, _ option: NativeRequest.Option) -> some View {
        let on = picked[index]?.contains(option.label) == true
        return Button {
            Haptics.play(.tap)
            if prompt.multiSelect == true {
                if on { picked[index]?.remove(option.label) } else { picked[index, default: []].insert(option.label) }
            } else {
                picked[index] = [option.label]
            }
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).foregroundStyle(Theme.ink)
                    if let d = option.description { Text(d).font(.footnote).foregroundStyle(Theme.muted) }
                }
                Spacer(minLength: 8)
                if on { Lucide(.check, size: 16, color: Theme.ink) }
            }
            .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44)
            .background(on ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Theme.ink : Theme.line))
        }
        .buttonStyle(.press)
        .disabled(sending)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var answered: Bool {
        guard let questions = request.questions, !questions.isEmpty else { return false }
        return questions.indices.allSatisfy { !(picked[$0] ?? []).isEmpty }
    }

    @ViewBuilder private var actions: some View {
        switch request.kind {
        case "plan":
            HStack(spacing: 10) {
                button("Keep planning", prominent: false) { await send(.deny(note: Self.keepPlanning)) }
                button("Approve", prominent: true) { await send(.allowOnce) }
            }
        case "question":
            button("Send", prominent: true, enabled: answered) {
                let picks = (request.questions ?? []).indices.map { i in
                    NativeCommand.Pick(question: i, picked: (request.questions?[i].options.map(\.label) ?? []).filter { picked[i]?.contains($0) == true }.joined(separator: ", "))
                }
                await send(.answer(picks))
            }
        default:
            HStack(spacing: 10) {
                button("Deny", prominent: false) { await send(.deny(note: nil)) }
                button("Allow once", prominent: true) { await send(.allowOnce) }
            }
            if request.chatRule {
                button("Allow for this chat", prominent: false) { await send(.allowForChat) }
            }
        }
    }

    private func button(_ title: String, prominent: Bool, enabled: Bool = true, _ action: @escaping () async -> Void) -> some View {
        Button { Haptics.play(.tap); Task { await action() } } label: {
            Text(sending ? "Sending…" : title).frame(maxWidth: .infinity, minHeight: 44)
        }
        .modifier(NativeButtonStyle(prominent: prominent))
        .disabled(sending || !enabled)
        .settleGuard()
    }

    private func send(_ decision: NativeDecision) async {
        sending = true
        let outcome = await model.respondNative(decision, to: session)
        sending = false
        result = outcome
    }
}

private struct NativeButtonStyle: ViewModifier {
    let prominent: Bool
    func body(content: Content) -> some View {
        if prominent {
            content.buttonStyle(.borderedProminent).tint(Theme.primaryFill).foregroundStyle(Theme.primaryText)
        } else {
            content.buttonStyle(.bordered).tint(Theme.ink)
        }
    }
}

/// "New chat" with a target: Squeak (native) by default when the Mac lists projects, Conductor as an option.
struct NewChatEntry: View {
    @Environment(AppModel.self) private var model
    var project: String? = nil
    @State private var conductor = false

    var body: some View {
        if !conductor, let projects = model.snapshot?.nativeProjects, !projects.isEmpty {
            NativeNewChatView(projects: projects, project: project, onUseConductor: model.home.workspaces == nil ? nil : { conductor = true })
        } else {
            NewChatView(workspaces: model.home.workspaces ?? [], project: project,
                        onUseSqueak: (model.snapshot?.nativeProjects?.isEmpty == false) ? { conductor = false } : nil)
        }
    }
}

/// Start a Squeak chat: project, where it runs, agent, model, mode and the first message. The phone offers only what
/// the Mac listed; the Mac checks again, and the command is signed here behind Face ID.
struct NativeNewChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let projects: [NativeProject]
    var project: String? = nil
    var onUseConductor: (() -> Void)? = nil

    @State private var projectId = ""
    @State private var place = NativeWhere.newWorkspace
    @State private var workspaceId: String?
    @State private var agent = NewChatAgent.claude
    @State private var modelId: String?
    @State private var effort: String?
    @State private var mode = "default"
    @State private var text = ""
    @State private var sending = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var current: NativeProject? { projects.first { $0.id == projectId } ?? projects.first }
    private var models: [PhoneSnapshot.ChatModel] { (model.snapshot?.nativeModels ?? []).filter { $0.agent == agent.rawValue } }
    private var chosen: PhoneSnapshot.ChatModel? { models.first { $0.id == modelId } ?? models.first }
    private var modes: [String] { model.snapshot?.nativePermissionModes ?? ["default", "acceptEdits", "plan"] }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canStart: Bool {
        current != nil && chosen != nil && !trimmed.isEmpty && trimmed.count <= 20_000 && !sending
            && (place != .workspace || (workspaceId.map { id in current?.workspaces.contains { $0.id == id } == true } ?? false))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    row("Pond", current?.name ?? "Choose a pond") {
                        ForEach(projects) { p in Button(p.name) { projectId = p.id; workspaceId = nil } }
                    }
                    Picker("Where", selection: $place) {
                        Text("New stream").tag(NativeWhere.newWorkspace)
                        Text("Stream").tag(NativeWhere.workspace)
                        Text("Pond folder").tag(NativeWhere.folder)
                    }
                    .pickerStyle(.segmented)
                    if place == .workspace {
                        if let workspaces = current?.workspaces, !workspaces.isEmpty {
                            row("Stream", workspaces.first { $0.id == workspaceId }.map { "\($0.displayTitle) · \($0.branch)" } ?? "Choose a stream") {
                                ForEach(workspaces) { w in Button("\(w.displayTitle) · \(w.branch)") { workspaceId = w.id } }
                            }
                        } else {
                            Text("This pond has no ready stream. Start in a new stream or the pond folder.")
                                .font(.footnote).foregroundStyle(Theme.muted)
                        }
                    }
                    Picker("Agent", selection: $agent) {
                        Text("Claude").tag(NewChatAgent.claude)
                        Text("Codex").tag(NewChatAgent.codex)
                    }
                    .pickerStyle(.segmented)
                    row("Model", chosen?.label ?? "No model offered") {
                        ForEach(models) { m in Button(m.label) { modelId = m.id; effort = m.defaultLevel ?? m.levels.first } }
                    }
                    if let levels = chosen?.levels, !levels.isEmpty {
                        row("Thinking", (effort ?? chosen?.defaultLevel ?? levels[0]).capitalized) {
                            ForEach(levels, id: \.self) { l in Button(l.capitalized) { effort = l } }
                        }
                    }
                    row("Mode", NativeWords.modeLabel(mode)) {
                        ForEach(modes, id: \.self) { m in Button(NativeWords.modeLabel(m)) { mode = m } }
                    }
                    if let note = NativeWords.permissionModes.first(where: { $0.id == mode })?.note {
                        Text(note).font(.footnote).foregroundStyle(mode == "bypassPermissions" ? Theme.error : Theme.muted)
                    }
                    TextField("What should it do?", text: $text, axis: .vertical)
                        .lineLimit(4...10).focused($focused)
                        .padding(14).frame(minHeight: 110, alignment: .topLeading)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                    if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.error) }
                    Button { Haptics.play(.tap); Task { await start() } } label: {
                        Text(sending ? "Starting…" : "Start chat").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.primaryFill).foregroundStyle(Theme.primaryText)
                    .disabled(!canStart)
                    .settleGuard()
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("New chat").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { Haptics.play(.tap); dismiss() } }
                if let onUseConductor {
                    ToolbarItem(placement: .primaryAction) { Button("Conductor") { Haptics.play(.tap); onUseConductor() } }
                }
            }
            .interactiveDismissDisabled(sending || !trimmed.isEmpty)
            .onAppear {
                if projectId.isEmpty { projectId = (project.flatMap { name in projects.first { $0.name == name } } ?? projects.first)?.id ?? "" }
                if modelId == nil { modelId = models.first(where: \.favorite)?.id ?? models.first?.id }
                if effort == nil { effort = chosen?.defaultLevel ?? chosen?.levels.first }
            }
            .onChange(of: agent) { _, _ in
                modelId = models.first(where: \.favorite)?.id ?? models.first?.id
                effort = chosen?.defaultLevel ?? chosen?.levels.first
            }
        }
        .foregroundStyle(Theme.ink)
    }

    private func row<Items: View>(_ title: String, _ value: String, @ViewBuilder items: () -> Items) -> some View {
        Menu { items() } label: {
            HStack {
                Text(title).foregroundStyle(Theme.muted)
                Spacer(minLength: 8)
                Text(value).foregroundStyle(Theme.ink).lineLimit(1)
                Lucide(.chevronRight, size: 14, color: Theme.subtle)
            }
            .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 48)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        }
        .accessibilityLabel("\(title): \(value)")
    }

    private func start() async {
        guard let current, let chosen else { return }
        sending = true; problem = nil
        let levels = chosen.levels
        let request = NativeStart(
            projectId: current.id, where: place, workspaceId: place == .workspace ? workspaceId : nil, agent: agent,
            model: chosen.id, effort: levels.isEmpty ? nil : (effort.flatMap { levels.contains($0) ? $0 : nil } ?? chosen.defaultLevel ?? levels[0]),
            permissionMode: mode, text: trimmed)
        let outcome = await model.startNativeChat(request, label: current.name)
        sending = false
        switch outcome {
        case .started: dismiss()
        case .cancelled: break
        case let .refused(reason): problem = reason
        }
    }
}
#endif
