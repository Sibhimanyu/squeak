import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

extension NewChatState {
    /// "Start" on the Create page: a new branch is one host call; a branch, PR or issue makes its workspace first
    /// (kept if the chat then fails to start, so Start again reuses it).
    func startCreate(model: AppModel, kind: CreateStartKind, input: String) {
        guard !nativeStarting, CreateWork.canStart(form: native, kind: kind, input: input), let project = native.project else { return }
        nativeStarting = true
        nativeError = nil
        Task { [weak self] in
            guard let self else { return }
            var spec: NativeNewSession?
            if let source = kind.source(from: input) {
                let signature = "\(project.id)|\(kind.rawValue)|\(input.trimmingCharacters(in: .whitespacesAndNewlines))"
                var made: (workspace: NativeWorkspace, prompt: String?)
                if let c = createdWorkspace, c.signature == signature {
                    made = (c.workspace, c.prompt)
                } else {
                    if model.demoMode { nativeError = "Demo data: no workspace is made."; nativeStarting = false; return }
                    do {
                        let m = try await model.nativeHost.createWorkspace(projectId: project.id, from: source)
                        createdWorkspace = (signature, m.workspace, m.prompt)
                        made = (m.workspace, m.prompt)
                    } catch {
                        nativeError = NativeWorkspaceMaking.problem(error)
                        nativeStarting = false
                        return
                    }
                }
                spec = CreateWork.session(form: native, workspace: made.workspace, issuePrompt: made.prompt)
            } else {
                spec = CreateWork.newBranchSession(form: native)
            }
            guard let spec else { nativeError = "Squeak needs a message to start."; nativeStarting = false; return }
            let (key, problem) = await model.startNativeChat(spec)
            nativeStarting = false
            if key != nil {
                native.text = ""
                createdWorkspace = nil
                await model.refreshNativeWorkspaces()
            } else {
                nativeError = problem // the words and the made workspace stay
            }
        }
    }
}

/// Create (DESIGN.md §8.10, the workbench's centre): start work in a project, add a project, join a pond.
struct CreatePage: View {
    @Environment(AppModel.self) private var model
    @Environment(NewChatState.self) private var state
    @State private var kind: CreateStartKind = .newBranch
    @State private var source = ""
    @State private var cloneURL = ""
    @State private var cloning = false
    @State private var cloneError: String?
    private var ponds: PondsModel { .shared }

    private var orderedProjects: [NativeProject] {
        CreateWork.orderedProjects(state.native.projects, activityOrder: model.sidebarTree.projects.map(\.name))
    }

    var body: some View {
        let sections = CreateWork.sections(projectCount: state.native.projects.count)
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                header
                if sections.addProjectLeads { addProject; startWork(sections) } else { startWork(sections); addProject }
                if sections.showsPonds { pondSection }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, Space.xl).padding(.top, Space.l).padding(.bottom, Space.xl)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onChange(of: model.native.projects) { old, new in
            // A project just added (opened or cloned) is the one Start work offers.
            let added = new.filter { n in !old.contains { $0.id == n.id } }
            state.native.setProjects(new, select: added.count == 1 ? added[0].id : state.native.projectId)
        }
        .onChange(of: state.nativeLoading) { _, loading in
            if !loading, let first = orderedProjects.first { state.native.choose(project: first.id) }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Create").font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
            Text(PondWords.createHeader).font(Typo.body).foregroundStyle(Theme.muted)
        }
    }

    private func card<C: View>(_ title: String, subtitle: String? = nil, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: Space.m) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Typo.label).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                if let subtitle { Text(subtitle).font(Typo.body).foregroundStyle(Theme.muted) }
            }
            content()
        }
        .padding(Space.l).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sidebar.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    // MARK: Start work

    private func startWork(_ sections: CreateSections) -> some View {
        @Bindable var state = state
        let f = state.native
        let busy = state.nativeStarting
        return card("Start work", subtitle: sections.startWorkNote) {
            if state.nativeLoading && f.projects.isEmpty {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text(PondWords.loadingPonds).foregroundStyle(Theme.muted) }
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    NCField("Pond") {
                        NCPopup(label: "Pond", selection: Binding(get: { state.native.projectId ?? "" }, set: { id in
                            state.native.choose(project: id)
                        }), options: orderedProjects.map { ($0.id, $0.name) })
                    }
                    NativeFirstMessageField(sendKey: .returnSends, title: "What to do", onSend: start)
                    NativeChatOptionsFields()
                    NCField("Starts from") {
                        NCSegmented(options: CreateStartKind.allCases.map { ($0.rawValue, $0.title) }, selection: kind.rawValue) { pick in
                            kind = CreateStartKind(rawValue: pick) ?? .newBranch
                        }
                        if kind.needsInput {
                            TextField(kind.placeholder, text: $source).textFieldStyle(.roundedBorder)
                                .onSubmit(start).accessibilityLabel(kind.title)
                        }
                        Text(kind == .newBranch ? "A new worktree branched from \(f.project?.defaultBranch ?? "the default branch")." : kind.hint)
                            .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let e = state.nativeError {
                        HStack(alignment: .top, spacing: 6) {
                            Lucide(.triangleAlert, size: Metrics.icon, color: Theme.negative)
                            Text(e).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                        }
                        ReportProblemButton(problem: e, place: "Create")
                    }
                    HStack(spacing: 12) {
                        Spacer()
                        if busy { ProgressView().controlSize(.small); Text("Starting…").font(Typo.meta).foregroundStyle(Theme.muted) }
                        Button("Start") { start() }
                            .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                            .disabled(busy || !CreateWork.canStart(form: f, kind: kind, input: source))
                            .accessibilityLabel("Start work")
                    }
                }
                .disabled(!sections.startWorkEnabled || busy)
                .opacity(sections.startWorkEnabled ? 1 : 0.5)
            }
        }
    }

    private func start() { state.startCreate(model: model, kind: kind, input: source) }

    // MARK: New pond

    private var addProject: some View {
        card(PondWords.newPond) {
            HStack(alignment: .top, spacing: Space.m) {
                tile(icon: .folder, title: PondWords.openFolder, subtitle: "A git repository already on this Mac.") {
                    Button("Choose folder…") { ProjectActions.shared.open(model) }
                        .buttonStyle(SecondaryButtonStyle()).disabled(ProjectActions.shared.busy)
                }
                tile(icon: .gitBranch, title: PondWords.cloneRepository, subtitle: "owner/repo from GitHub, or a git URL. It goes to ~/squeak/repos.") {
                    HStack(spacing: 8) {
                        TextField("owner/repo", text: $cloneURL).textFieldStyle(.roundedBorder).onSubmit(clone)
                            .accessibilityLabel("Repository to clone")
                        Button("Clone") { clone() }.buttonStyle(SecondaryButtonStyle())
                            .disabled(cloning || cloneURL.trimmingCharacters(in: .whitespaces).isEmpty || ProjectActions.shared.busy)
                    }
                    if cloning {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Cloning…").font(Typo.meta).foregroundStyle(Theme.muted) }
                    }
                    if let e = cloneError { Text(verbatim: e).font(Typo.meta).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true) }
                }
            }
        }
    }

    private func tile<C: View>(icon: LucideName, title: String, subtitle: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Lucide(icon, size: 18, color: Theme.muted)
            Text(title).font(Typo.label).foregroundStyle(Theme.ink)
            Text(subtitle).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            content()
        }
        .padding(Space.m).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    private func clone() {
        let url = cloneURL.trimmingCharacters(in: .whitespaces)
        guard !cloning, !url.isEmpty else { return }
        cloning = true
        cloneError = nil
        Task {
            let (project, problem) = await ProjectActions.shared.clone(model, url: url)
            cloning = false
            if project != nil { cloneURL = "" } else { cloneError = problem }
        }
    }

    // MARK: Ponds

    private var pondSection: some View {
        card("Join a pond", subtitle: "Paste an invite link to work with other people.") {
            JoinPondForm(dismiss: {}, inline: true)
        }
    }
}
