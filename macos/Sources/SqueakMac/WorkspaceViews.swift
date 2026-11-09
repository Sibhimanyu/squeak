import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the workspace of a Squeak chat: its sidebar mark while it sets up or when setup failed, the
// context menu (run script, setup log, archive), the setup log sheet, and the project settings sheet.

/// The age's slot (28x16) for a workspace that is not ready: the quiet loader while it sets up, the failed mark
/// when setup failed; the tooltip carries the words.
struct LifecycleSlot: View {
    let mark: WorkspaceLifecycle.Mark

    var body: some View {
        ZStack {
            switch mark {
            case .settingUp: DotGridLoader(size: 12, quiet: true)
            case .setupFailed: Lucide(.circleX, size: 14, color: Theme.negative).accessibilityHidden(true)
            }
        }
        .frame(width: 28, height: 16, alignment: .trailing)
        .help(WorkspaceLifecycle.words(mark))
        .accessibilityLabel(WorkspaceLifecycle.words(mark))
    }
}

struct WorkspaceMenu: View {
    let workspace: NativeWorkspace
    @Environment(AppModel.self) private var model

    var body: some View {
        let run = model.git.runs[workspace.id]
        let ready = workspace.state == "ready"
        Button(run?.running == true ? "Stop run script" : "Run") { model.toggleRun(workspace) }.disabled(!ready)
        if run?.running == true, let title = WorkspaceLifecycle.openTitle(port: run?.port ?? workspace.port) {
            Button(title) { model.openLocalhost(workspace) }
        }
        if FileManager.default.fileExists(atPath: workspace.path) {
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: workspace.path)]) }
        }
        Divider()
        Button("View setup log…") { model.git.logSheet = LogSheet(workspaceId: workspace.id, name: workspace.name) }
        Divider()
        Button("Archive workspace…", role: .destructive) { model.archiveNativeWorkspace(workspace) }
            .disabled(workspace.state == "setting_up")
    }
}

// MARK: Setup log

struct SetupLogSheet: View {
    let sheet: LogSheet
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var log: NativeWorkspaceLog?
    @State private var failed = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.s) {
                Text("Setup log").font(Typo.heading).foregroundStyle(Theme.ink)
                Text(verbatim: sheet.name).font(Typo.body).foregroundStyle(Theme.muted)
                if let mark = log.flatMap({ WorkspaceLifecycle.mark($0.state) }) { LifecycleSlot(mark: mark) }
                Spacer(minLength: 0)
            }
            ScrollView {
                Text(verbatim: body_).font(Typo.code).foregroundStyle(log?.log.isEmpty == false ? Theme.ink : Theme.muted)
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
            }
            .frame(height: 320)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            HStack(spacing: Space.s) {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(log?.log ?? "", forType: .string)
                    copied = true
                } label: {
                    HStack(spacing: 6) {
                        Lucide(copied ? .check : .copy, size: 13, color: Theme.ink)
                        Text(copied ? "Copied" : "Copy")
                    }
                }
                .buttonStyle(SecondaryButtonStyle()).disabled(log?.log.isEmpty != false)
                Spacer(minLength: 0)
                Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
            }
        }
        .padding(Space.l).frame(width: 640)
        .background(Theme.surfaceRaised)
        .task {
            while !Task.isCancelled {
                if let read = try? await model.nativeHost.workspaceLog(workspaceId: sheet.workspaceId) { log = read; failed = false } else { failed = true }
                // Follows a setup in progress; a finished one is read once.
                if log.map({ $0.state != "setting_up" }) == true { break }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private var body_: String {
        if let text = log?.log, !text.isEmpty { return text }
        if failed { return "Squeak couldn't read the log." }
        return log == nil ? "Reading the log…" : "The setup script printed nothing."
    }
}

// MARK: Project settings

struct ProjectSettingsSheet: View {
    let project: NativeProject
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var original: NativeProjectSettings?
    @State private var draft: ProjectSettingsDraft?
    @State private var problem: String?
    @State private var saving = false
    @State private var reviewModels: [DaemonChatModel] = []

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.s) {
                Text("Project settings").font(Typo.heading).foregroundStyle(Theme.ink)
                Text(verbatim: project.name).font(Typo.body).foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
            }
            if let original, draft != nil {
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.l) {
                        scriptField("Setup script", "setupScript", \.setupScript, original.effective.setupScript, original.sources.setupScript)
                        scriptField("Run script", "runScript", \.runScript, original.effective.runScript, original.sources.runScript)
                        scriptField("Archive script", "archiveScript", \.archiveScript, original.effective.archiveScript, original.sources.archiveScript)
                        branchPrefix(original)
                        mergeMethod(original)
                        reviewModel(original)
                        prompts(original)
                        Divider()
                        RoutinesSection(project: project)
                        Divider()
                        BacklogSection(project: project)
                    }
                    .padding(.trailing, Space.s)
                }
                .frame(height: 460)
            } else {
                Text(problem ?? "Reading the settings…").font(Typo.body).foregroundStyle(Theme.muted).frame(height: 120, alignment: .top)
            }
            if let problem, original != nil { Text(verbatim: problem).font(Typo.body).foregroundStyle(Theme.negative) }
            HStack(spacing: Space.s) {
                Spacer(minLength: 0)
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button("Save") { save() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                    .disabled(saving || draft == nil || patch.isEmpty)
            }
        }
        .padding(Space.l).frame(width: 640)
        .background(Theme.surfaceRaised)
        .task { await load() }
    }

    private var patch: [String: NativeJSON] {
        guard let original, let draft else { return [:] }
        return draft.patch(from: original)
    }

    private func load() async {
        do {
            let s = try await model.nativeHost.projectSettings(projectId: project.id)
            original = s
            draft = ProjectSettingsDraft(s)
            reviewModels = await model.newChatModels()
        } catch let e as NativeHostError { problem = e.reason } catch { problem = "Squeak couldn't read the settings" }
    }

    private func save() {
        guard let draft, let original else { return }
        saving = true
        problem = nil
        Task {
            defer { saving = false }
            do {
                _ = try await model.nativeHost.patchProjectSettings(projectId: project.id, body: draft.patch(from: original))
                dismiss()
            } catch let e as NativeHostError { problem = e.reason } catch { problem = "Squeak couldn't save the settings" }
        }
    }

    // MARK: Fields

    private func caption(_ source: String) -> String? {
        source == "conductor.json" ? "from conductor.json" : source == "default" ? "default" : nil
    }

    private func label(_ title: String, _ source: String?) -> some View {
        HStack(spacing: 6) {
            Text(title).font(Typo.label).foregroundStyle(Theme.ink)
            if let source, let c = caption(source) { Text(c).font(Typo.meta).foregroundStyle(Theme.subtle) }
        }
    }

    private func editor(_ text: Binding<String>, height: CGFloat) -> some View {
        TextEditor(text: text)
            .font(Typo.code).foregroundStyle(Theme.ink).scrollContentBackground(.hidden)
            .padding(6).frame(height: height)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }

    /// A script: its own text here; when the project stores none, what conductor.json gives is shown under it.
    private func scriptField(
        _ title: String, _ key: String, _ path: WritableKeyPath<ProjectSettingsDraft, String>, _ effective: String?, _ source: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            label(title, source == "project" ? nil : source)
            editor(Binding(get: { draft?[keyPath: path] ?? "" }, set: { draft?[keyPath: path] = $0 }), height: 64)
            if source == "conductor.json", draft?[keyPath: path].isEmpty == true, let effective {
                Text(verbatim: effective).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(3)
                Text("Used until you write one here.").font(Typo.meta).foregroundStyle(Theme.subtle)
            }
        }
    }

    private func branchPrefix(_ s: NativeProjectSettings) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            label("Branch prefix", s.sources.branchPrefix == "project" ? nil : s.sources.branchPrefix)
            TextField(s.effective.branchPrefix, text: Binding(get: { draft?.branchPrefix ?? "" }, set: { draft?.branchPrefix = $0 }))
                .textFieldStyle(.plain).font(Typo.code).foregroundStyle(Theme.ink)
                .padding(.horizontal, 8).frame(height: 28)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        }
    }

    private func mergeMethod(_ s: NativeProjectSettings) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            label("Merge method", s.sources.mergeMethod == "project" ? nil : s.sources.mergeMethod)
            Picker("Merge method", selection: Binding(get: { draft?.mergeMethod ?? "" }, set: { draft?.mergeMethod = $0 })) {
                Text("Default (\(s.effective.mergeMethod == "squash" || s.settings.mergeMethod != nil ? "squash" : s.effective.mergeMethod))").tag("")
                ForEach(NativeProjectSettings.methods, id: \.self) { Text(GitPresentation.methodTitle($0)).tag($0) }
            }
            .labelsHidden().pickerStyle(.menu).fixedSize()
        }
    }

    /// The models a review can use come from the same picker as a new chat; unset reviews in the chat itself.
    private func reviewModel(_ s: NativeProjectSettings) -> some View {
        let chosen = draft?.reviewModel ?? ""
        let levels = reviewModels.first { $0.id == chosen }?.levels ?? []
        return VStack(alignment: .leading, spacing: 4) {
            label("Review model", nil)
            Text("When set, Review starts a new chat in the workspace with this model instead of asking the chat you are in.")
                .font(Typo.meta).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                Picker("Review model", selection: Binding(get: { chosen }, set: { picked in
                    draft?.reviewModel = picked
                    let levels = reviewModels.first { $0.id == picked }?.levels ?? []
                    if !levels.contains(draft?.reviewEffort ?? "") { draft?.reviewEffort = "" }
                })) {
                    Text("This chat's model").tag("")
                    // A saved model the picker no longer lists stays selectable so Save does not silently drop it.
                    if !chosen.isEmpty, !reviewModels.contains(where: { $0.id == chosen }) { Text(verbatim: chosen).tag(chosen) }
                    ForEach(reviewModels) { Text(verbatim: $0.label).tag($0.id) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
                if !levels.isEmpty {
                    Picker("Review effort", selection: Binding(get: { draft?.reviewEffort ?? "" }, set: { draft?.reviewEffort = $0 })) {
                        Text("Default").tag("")
                        ForEach(levels, id: \.self) { Text(DaemonChatModel.levelName($0)).tag($0) }
                    }
                    .labelsHidden().pickerStyle(.menu).fixedSize()
                }
            }
        }
    }

    private func prompts(_ s: NativeProjectSettings) -> some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("What each action tells the chat").font(Typo.heading).foregroundStyle(Theme.ink)
            Text("Leave a field empty to use the default shown behind it. {base} and {branch} are filled in when it is sent.")
                .font(Typo.meta).foregroundStyle(Theme.muted)
            ForEach(NativeProjectSettings.actions, id: \.self) { action in
                let title = GitActionKind(rawValue: action)?.title ?? action
                let text = Binding(get: { draft?.prompts[action] ?? "" }, set: { draft?.prompts[action] = $0 })
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        label(title, s.sources.prompts[action] == "project" ? nil : "default")
                        Spacer(minLength: 0)
                        if text.wrappedValue.isEmpty == false {
                            Button("Use default") { text.wrappedValue = "" }.buttonStyle(QuietButtonStyle())
                        }
                    }
                    ZStack(alignment: .topLeading) {
                        editor(text, height: 72)
                        if text.wrappedValue.isEmpty {
                            Text(verbatim: s.defaultPrompts[action] ?? "").font(Typo.code).foregroundStyle(Theme.subtle)
                                .padding(.horizontal, 11).padding(.vertical, 6).allowsHitTesting(false).lineLimit(3)
                        }
                    }
                }
            }
        }
    }
}
