import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond settings: a page in the workbench centre (not a dialog), one column, saved as you change.
// Look, Streams, Scripts, Flock, This Mac, and the pond's Agents settings (review model, prompts, routines, backlog).
// The back button returns to the pond's home.

struct PondSettingsView: View {
    let project: String
    @Environment(AppModel.self) private var model
    @State private var original: NativeProjectSettings?
    @State private var draft: ProjectSettingsDraft?
    @State private var problem: String?
    @State private var saveTask: Task<Void, Never>?
    @State private var reviewModels: [DaemonChatModel] = []
    @State private var labelDraft = ""
    @State private var confirmRemove = false
    @State private var removeProblem: String?
    @State private var promptsExpanded = false

    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(named: project) }
    private var role: PondRole { ponds.detail(named: project)?.myRole ?? pond?.role ?? .owner }
    private var native: NativeProject? { NativeWorkspaceMaking.project(named: project, in: model.native.projects) }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        introduction
                        if let native {
                            FlowChips(items: ["Appearance", "Streams", "Scripts", "Flock", "Agents", "This Mac"]) { title in
                                Button(title) { scroll.scrollTo(title, anchor: .top) }
                                    .buttonStyle(SecondaryButtonStyle())
                            }
                            if let problem {
                                Label(problem, systemImage: "exclamationmark.circle")
                                    .font(Typo.footnote).foregroundStyle(Theme.negative)
                                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                            }
                            look(native).id("Appearance")
                            branches(native).id("Streams")
                            scripts.id("Scripts")
                            VStack(alignment: .leading, spacing: 12) {
                                HStack {
                                    Text("Flock").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                                    Spacer()
                                    invite
                                }
                                Text("The people in this pond and where they’re working.")
                                    .font(Typo.footnote).foregroundStyle(Theme.muted)
                                PondFlockSection(project: project, showsHeading: false)
                            }.id("Flock")
                            agents(native).id("Agents")
                            thisMac(native).id("This Mac")
                        } else {
                            Label("This pond has no project on this Mac, so local settings aren’t available.", systemImage: "desktopcomputer")
                                .font(Typo.body).foregroundStyle(Theme.muted).padding(20)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                        }
                    }
                    .padding(.horizontal, 24).padding(.vertical, 24)
                    .frame(maxWidth: 780, alignment: .leading).frame(maxWidth: .infinity)
                }
            }
        }
        .task(id: native?.id) { await load() }
        .onDisappear { flush() }
        .onChange(of: draft) { _, _ in schedule() }
        .confirmationDialog("Remove \(project) from Squeak?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove from Squeak", role: .destructive) { remove() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Remove \(project) from Squeak? Its folder and files stay where they are; you can add it back with New pond.")
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: Space.m) {
            Button { ponds.route = .home(project: project) } label: {
                HStack(spacing: 4) {
                    Lucide(.arrowLeft, size: 14, color: Theme.muted)
                    Text(verbatim: project).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).keyboardShortcut(.cancelAction).accessibilityLabel("Back to \(project)")
            Spacer(minLength: 0)
            Text("Changes save automatically").font(Typo.meta).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, Space.l).frame(height: 40)
    }

    private var introduction: some View {
        HStack(alignment: .center, spacing: 14) {
            PondTile(name: project, pondId: pond?.id, size: 48)
            VStack(alignment: .leading, spacing: 5) {
                Text(verbatim: project).font(Typo.footnote).foregroundStyle(Theme.muted)
                Text(PondWords.settings).font(.system(size: 26, weight: .semibold))
                    .tracking(-0.5).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Text("Appearance, stream defaults and how agents work in this pond.")
                    .font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    private func section<C: View>(_ title: String, _ description: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(verbatim: title).font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Text(verbatim: description).font(Typo.footnote).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 22, content: content)
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
        }
    }

    // MARK: Sections

    private func look(_ p: NativeProject) -> some View {
        section("Appearance", "Make this pond easy to recognise in your sidebar.") {
            PondLookSection(project: p)
            VStack(alignment: .leading, spacing: 6) {
                Text("Labels").font(Typo.label).foregroundStyle(Theme.ink)
                if !p.labels.isEmpty {
                    FlowChips(items: p.labels) { l in
                        Button { setLabels(p, p.labels.filter { $0 != l }) } label: {
                            HStack(spacing: 4) {
                                Text(verbatim: l).font(Typo.meta).foregroundStyle(Theme.ink)
                                Lucide(.x, size: 10, color: Theme.subtle)
                            }
                            .padding(.horizontal, 8).frame(height: 22)
                            .background(Theme.selected, in: Capsule())
                            .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain).help("Remove \(l)").accessibilityLabel("Remove label \(l)")
                    }
                }
                HStack(spacing: 8) {
                    TextField("Add a label", text: $labelDraft).textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 280).onSubmit { addLabel(p) }.accessibilityLabel("New pond label")
                    Button("Add") { addLabel(p) }.buttonStyle(SecondaryButtonStyle())
                        .disabled(PondFilter.adding(labelDraft, to: p.labels) == nil)
                }
                Text("Use labels to filter ponds in the sidebar.").font(Typo.meta).foregroundStyle(Theme.muted)
                if p.labels.count >= PondFilter.maxLabelsPerPond {
                    Text("A pond takes up to \(PondFilter.maxLabelsPerPond) labels.").font(Typo.meta).foregroundStyle(Theme.subtle)
                }
            }
        }
    }

    private func branches(_ p: NativeProject) -> some View {
        section("Streams", "Defaults for new streams and their folders on this Mac.") {
            if let original, draft != nil {
                VStack(alignment: .leading, spacing: 4) {
                    label("New streams start from", nil)
                    Text(verbatim: p.defaultBranch).font(Typo.code).foregroundStyle(Theme.ink)
                    Text("The project\u{2019}s default branch, read from git.").font(Typo.meta).foregroundStyle(Theme.subtle)
                }
                VStack(alignment: .leading, spacing: 4) {
                    label("Stream folders go to", nil)
                    Text(verbatim: "~/squeak/workspaces/\(p.name)/").font(Typo.code).foregroundStyle(Theme.ink)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text("Fixed by Squeak for now.").font(Typo.meta).foregroundStyle(Theme.subtle)
                }
                branchPrefix(original)
                mergeMethod(original)
            } else { loading }
        }
    }

    private var scripts: some View {
        section("Scripts", "Commands for setting up, running and archiving a stream.") {
            if let original, draft != nil {
                scriptField("Setup script", "setupScript", \.setupScript, original.effective.setupScript, original.sources.setupScript)
                scriptField("Run script", "runScript", \.runScript, original.effective.runScript, original.sources.runScript)
                scriptField("Archive script", "archiveScript", \.archiveScript, original.effective.archiveScript, original.sources.archiveScript)
            } else { loading }
        }
    }

    @ViewBuilder private var invite: some View {
        if role.canInvite, let p = pond {
            Button("Invite") { ponds.startInvite(pondId: p.id, account: model.account) }.buttonStyle(SecondaryButtonStyle())
        }
    }

    private func agents(_ p: NativeProject) -> some View {
        section("Agents", "Choose how reviews, action prompts and scheduled work behave.") {
            if let original, draft != nil {
                reviewModel(original)
                Divider().overlay(Theme.line)
                DisclosureGroup(isExpanded: $promptsExpanded) {
                    prompts(original).padding(.top, 12)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Action prompts").font(Typo.label).foregroundStyle(Theme.ink)
                        Text("Customise what Git and review actions tell the agent.")
                            .font(Typo.footnote).foregroundStyle(Theme.muted)
                    }
                }
                Divider().overlay(Theme.line)
                RoutinesSection(project: p)
                Divider().overlay(Theme.line)
                BacklogSection(project: p)
            } else { loading }
        }
    }

    private func thisMac(_ p: NativeProject) -> some View {
        section("This Mac", "The local folder and how this pond appears on this Mac.") {
            HStack(spacing: Space.m) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Project folder").font(Typo.label).foregroundStyle(Theme.ink)
                    Text(verbatim: p.rootPath).font(Typo.code).foregroundStyle(Theme.muted)
                        .lineLimit(2).truncationMode(.middle).textSelection(.enabled).help(p.rootPath)
                }
                Spacer(minLength: 0)
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p.rootPath)]) }
                    .buttonStyle(SecondaryButtonStyle())
            }
            Toggle(isOn: Binding(get: { p.hidden }, set: { setHidden(p, $0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hide pond").font(Typo.label).foregroundStyle(Theme.ink)
                    Text("Leaves it off the Ponds list. Nothing is deleted.").font(Typo.meta).foregroundStyle(Theme.muted)
                }
            }
            .toggleStyle(.switch)
            Divider().overlay(Theme.line)
            VStack(alignment: .leading, spacing: 8) {
                Text("Remove this pond").font(Typo.label).foregroundStyle(Theme.ink)
                Text("Its folder and files stay on this Mac. You can add it back later.")
                    .font(Typo.footnote).foregroundStyle(Theme.muted)
                Button("Remove from Squeak\u{2026}") { removeProblem = nil; confirmRemove = true }.buttonStyle(DestructiveButtonStyle())
                if let removeProblem { Text(verbatim: removeProblem).font(Typo.body).foregroundStyle(Theme.negative) }
            }
        }
    }

    private var loading: some View {
        Text(problem ?? "Reading the settings\u{2026}").font(Typo.body).foregroundStyle(Theme.muted)
    }

    // MARK: Saving (as you change)

    private func load() async {
        guard let native else { return }
        if model.demoMode {
            let settings = DemoData.pondSettings
            original = settings
            draft = ProjectSettingsDraft(settings)
            return
        }
        do {
            let s = try await model.nativeHost.projectSettings(projectId: native.id)
            original = s
            draft = ProjectSettingsDraft(s)
            problem = nil
            reviewModels = await model.newChatModels()
        } catch let e as NativeHostError { problem = e.reason } catch { problem = "Squeak couldn't read the settings" }
    }

    private func schedule() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(700))
            if !Task.isCancelled { await save() }
        }
    }

    private func flush() {
        saveTask?.cancel()
        Task { await save() }
    }

    private func save() async {
        guard let native, let draft, let original, !model.demoMode else { return }
        let body = draft.patch(from: original)
        guard !body.isEmpty else { return }
        do {
            self.original = try await model.nativeHost.patchProjectSettings(projectId: native.id, body: body)
            problem = nil
        } catch let e as NativeHostError { problem = e.reason } catch { problem = "Squeak couldn't save the settings" }
    }

    private func setHidden(_ p: NativeProject, _ hidden: Bool) {
        guard !model.demoMode else { return }
        Task {
            try? await model.nativeHost.setProjectPrefs(key: p.id, hidden: hidden)
            await model.refreshNativeProjects()
        }
    }

    private func setLabels(_ p: NativeProject, _ labels: [String]) {
        guard !model.demoMode else { return }
        Task {
            try? await model.nativeHost.setProjectPrefs(key: p.id, labels: labels)
            await model.refreshNativeProjects()
        }
    }

    private func addLabel(_ p: NativeProject) {
        guard let next = PondFilter.adding(labelDraft, to: p.labels) else { return }
        labelDraft = ""
        setLabels(p, next)
    }

    private func remove() {
        guard let native, !model.demoMode else { return }
        Task {
            do {
                try await model.nativeHost.removeProject(projectId: native.id)
                await model.refreshNativeProjects()
                ponds.route = nil
                WorkbenchNav.goHome(model)
            } catch let e as NativeHostError { removeProblem = e.reason } catch { removeProblem = "Squeak couldn't remove it" }
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
                .accessibilityLabel(title)
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
                .accessibilityLabel("Branch prefix")
                .textFieldStyle(.plain).font(Typo.code).foregroundStyle(Theme.ink)
                .padding(.horizontal, 8).frame(height: 28)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        }
    }

    private func mergeMethod(_ s: NativeProjectSettings) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            label("Merge method", s.sources.mergeMethod == "project" ? nil : s.sources.mergeMethod)
            SqueakPicker("Merge method", selection: Binding(get: { draft?.mergeMethod ?? "" }, set: { draft?.mergeMethod = $0 })) {
                SqueakChoice(title: "Default (\(s.effective.mergeMethod == "squash" || s.settings.mergeMethod != nil ? "squash" : s.effective.mergeMethod))", value: "")
                SqueakOptions(NativeProjectSettings.methods, id: \.self) { SqueakChoice(title: GitPresentation.methodTitle($0), value: $0) }
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
            Text("When set, Review starts a new chat in the stream with this model instead of asking the chat you are in.")
                .font(Typo.meta).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                SqueakPicker("Review model", selection: Binding(get: { chosen }, set: { picked in
                    draft?.reviewModel = picked
                    let levels = reviewModels.first { $0.id == picked }?.levels ?? []
                    if !levels.contains(draft?.reviewEffort ?? "") { draft?.reviewEffort = "" }
                })) {
                    SqueakChoice(title: "This chat's model", value: "")
                    // A saved model the picker no longer lists stays selectable so Save does not silently drop it.
                    if !chosen.isEmpty, !reviewModels.contains(where: { $0.id == chosen }) { SqueakChoice(title: chosen, value: chosen) }
                    SqueakOptions(reviewModels) { SqueakChoice(title: $0.label, value: $0.id) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
                if !levels.isEmpty {
                    SqueakPicker("Review effort", selection: Binding(get: { draft?.reviewEffort ?? "" }, set: { draft?.reviewEffort = $0 })) {
                        SqueakChoice(title: "Default", value: "")
                        SqueakOptions(levels, id: \.self) { SqueakChoice(title: DaemonChatModel.levelName($0), value: $0) }
                    }
                    .labelsHidden().pickerStyle(.menu).fixedSize()
                }
            }
        }
    }

    private func prompts(_ s: NativeProjectSettings) -> some View {
        VStack(alignment: .leading, spacing: Space.m) {
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
                        editor(text, height: 72).accessibilityLabel("\(title) prompt")
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
