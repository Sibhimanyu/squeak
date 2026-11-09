import SqueakIcons
import SqueakMacCore
import SwiftUI

// A project's work for later, in Project settings: the backlog (ideas to start as a chat) and routines (a prompt
// that starts a chat on a schedule). Both act at once through the session host; Save is for the settings above.

struct BacklogSection: View {
    let project: NativeProject
    @Environment(AppModel.self) private var model
    @State private var items: [NativeBacklogItem] = []
    @State private var draft = ""
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text("Backlog").font(Typo.heading).foregroundStyle(Theme.ink)
            Text("Ideas to start later. Start one as a new chat in a fresh workspace; it leaves the list.")
                .font(Typo.meta).foregroundStyle(Theme.muted)
            ForEach(items) { item in
                HStack(spacing: Space.s) {
                    Text(verbatim: item.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer(minLength: 0)
                    Button("Start") { start(item) }.buttonStyle(QuietButtonStyle())
                    Button { remove(item) } label: { Lucide(.trash2, size: 13, color: Theme.muted) }
                        .buttonStyle(.plain).help("Remove from the backlog").accessibilityLabel("Remove \(item.title)")
                }
                .frame(height: 28)
            }
            HStack(spacing: Space.s) {
                TextField("Something to do later…", text: $draft).textFieldStyle(.roundedBorder).onSubmit(add)
                Button("Add") { add() }.buttonStyle(SecondaryButtonStyle())
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let problem { Text(verbatim: problem).font(Typo.meta).foregroundStyle(Theme.negative) }
        }
        .task { await load() }
    }

    private func load() async {
        items = (try? await model.nativeHost.backlog(projectId: project.id)) ?? []
    }

    private func add() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Task {
            do { _ = try await model.nativeHost.addBacklog(projectId: project.id, prompt: text); draft = ""; problem = nil }
            catch { problem = (error as? NativeHostError)?.reason ?? "Squeak couldn't add that." }
            await load()
        }
    }

    private func remove(_ item: NativeBacklogItem) {
        Task { try? await model.nativeHost.removeBacklog(id: item.id); await load() }
    }

    /// Opens New chat on a fresh workspace with the idea in the composer; it leaves the backlog once the workspace is made.
    private func start(_ item: NativeBacklogItem) {
        Task {
            try? await model.nativeHost.removeBacklog(id: item.id)
            await load()
            model.nativeMakeWorkspace(projectId: project.id, prompt: item.prompt)
        }
    }
}

struct RoutinesSection: View {
    let project: NativeProject
    @Environment(AppModel.self) private var model
    @State private var routines: [NativeRoutine] = []
    @State private var models: [DaemonChatModel] = []
    @State private var draft = NativeRoutineDraft()
    @State private var adding = false
    @State private var problem: String?
    @State private var note: String?

    private static let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Text("Routines").font(Typo.heading).foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
                if !adding { Button("Add routine") { adding = true }.buttonStyle(QuietButtonStyle()) }
            }
            Text("A prompt that starts a chat on a schedule, in this Mac's time, while Squeak runs. Never in a mode that skips approvals.")
                .font(Typo.meta).foregroundStyle(Theme.muted)
            ForEach(routines) { r in row(r) }
            if adding { form }
            if let note { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted) }
            if let problem { Text(verbatim: problem).font(Typo.meta).foregroundStyle(Theme.negative) }
        }
        .task { await load() }
    }

    private func row(_ r: NativeRoutine) -> some View {
        HStack(spacing: Space.s) {
            Toggle("", isOn: Binding(get: { r.enabled }, set: { on in setEnabled(r, on) })).labelsHidden().toggleStyle(.switch)
                .controlSize(.mini).accessibilityLabel("\(r.title) on")
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: r.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                Text(verbatim: "\(r.scheduleWords) · \(r.agent)\(r.lastError.map { " · last run failed: \($0)" } ?? "")")
                    .font(Typo.meta).foregroundStyle(r.lastError == nil ? Theme.muted : Theme.negative).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button("Run now") { run(r) }.buttonStyle(QuietButtonStyle())
            Button { remove(r) } label: { Lucide(.trash2, size: 13, color: Theme.muted) }
                .buttonStyle(.plain).help("Delete this routine").accessibilityLabel("Delete \(r.title)")
        }
        .frame(minHeight: 32)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            TextField("What the chat should do each time", text: $draft.prompt, axis: .vertical)
                .lineLimit(2...5).textFieldStyle(.roundedBorder)
            HStack(spacing: Space.s) {
                Picker("", selection: $draft.kind) {
                    Text("Every N hours").tag("hourly"); Text("Daily").tag("daily"); Text("Weekly").tag("weekly")
                }
                .labelsHidden().frame(width: 140)
                if draft.kind == "hourly" {
                    Stepper("Every \(draft.every) h", value: $draft.every, in: 1...168)
                } else {
                    if draft.kind == "weekly" {
                        Picker("", selection: $draft.day) {
                            ForEach(0..<7, id: \.self) { Text(Self.days[$0]).tag($0) }
                        }
                        .labelsHidden().frame(width: 120)
                    }
                    TextField("09:00", text: $draft.at).textFieldStyle(.roundedBorder).frame(width: 64)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: Space.s) {
                Picker("", selection: $draft.model) {
                    ForEach(models) { m in Text(m.label).tag(m.id) }
                }
                .labelsHidden().frame(width: 220)
                .onChange(of: draft.model) { _, id in draft.agent = models.first { $0.id == id }?.agent ?? draft.agent }
                Toggle("Fresh workspace each run", isOn: $draft.newWorkspace).toggleStyle(.checkbox)
                Spacer(minLength: 0)
                Button("Cancel") { adding = false; draft = NativeRoutineDraft(); draft.model = models.first?.id ?? "" }
                    .buttonStyle(SecondaryButtonStyle())
                Button("Add") { add() }.buttonStyle(PrimaryButtonStyle()).disabled(!draft.isValid)
            }
        }
        .padding(Space.s)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    private func load() async {
        routines = (try? await model.nativeHost.routines(projectId: project.id)) ?? []
        if models.isEmpty {
            models = await model.newChatModels()
            if draft.model.isEmpty, let first = models.first { draft.model = first.id; draft.agent = first.agent }
        }
    }

    private func act(_ body: @escaping () async throws -> Void) {
        Task {
            do { try await body(); problem = nil } catch { problem = (error as? NativeHostError)?.reason ?? "Squeak couldn't do that." }
            await load()
        }
    }

    private func add() {
        let d = draft
        act {
            _ = try await model.nativeHost.addRoutine(projectId: project.id, d)
            adding = false
            draft = NativeRoutineDraft(); draft.model = models.first?.id ?? ""; draft.agent = models.first?.agent ?? "claude"
        }
    }

    private func setEnabled(_ r: NativeRoutine, _ on: Bool) { act { _ = try await model.nativeHost.setRoutineEnabled(id: r.id, on) } }
    private func remove(_ r: NativeRoutine) { act { try await model.nativeHost.removeRoutine(id: r.id) } }
    private func run(_ r: NativeRoutine) {
        act {
            try await model.nativeHost.runRoutine(id: r.id)
            note = "Started \(r.title). It's in the sidebar."
        }
    }
}
