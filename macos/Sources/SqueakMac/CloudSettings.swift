import AppKit
import SqueakMacCore
import SwiftUI

/// A visible one-tap Copy: anything the owner has to type somewhere else carries one.
struct CopyButton: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Button(copied ? "Copied" : "Copy") {
            CloudModel.copy(text)
            copied = true
            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
        }
        .buttonStyle(SecondaryButtonStyle())
        .accessibilityLabel("Copy \(text)")
    }
}

/// Settings › Cloud: where the phone channel lives, Firebase or Catalyst.
struct CloudSettings: View {
    @Environment(AppModel.self) private var app
    @State private var settingUp = false
    @State private var setupFinished = false
    @State private var confirming: CloudProvider?
    @State private var renameDraft = ""

    private var m: CloudModel { app.cloud }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if let s = m.state {
                if let rows = s.comparison { comparison(rows) }
                if let f = s.firebase { firebaseCard(f, s) }
                if let c = s.catalyst { catalystCard(c, s) }
                Footnote("Your devices see exactly the same thing on either. Sealed documents only: the cloud never holds a readable word.")
            } else {
                SettingsCard(title: "Cloud", subtitle: "Where your phone and this Mac meet.", symbol: "cloud") {
                    StatusLine(dot: nil, text: "Checking")
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .task { await m.refresh(); await m.pollWhileBusy() }
        .sheet(isPresented: $settingUp, onDismiss: {
            Task { await m.refresh() }
            if setupFinished { setupFinished = false }
        }) {
            FirebaseSetupSheet(channels: app.channels, finished: $setupFinished, movingFromShared: app.channels.onSharedServer)
        }
        .confirmationDialog("Use \(confirming?.title ?? "this")?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), presenting: confirming) { p in
            Button("Move to \(p.title)") { Task { await m.use(p) } }
        } message: { p in
            Text("Paired devices will move to \(p.title). Devices that are off will move when they come back; if one doesn't, pair it again.")
        }
    }

    // MARK: Comparison

    private func comparison(_ rows: [CloudComparisonRow]) -> some View {
        SettingsCard(title: "Speed", subtitle: "The last test on each, side by side.", symbol: "gauge") {
            Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                GridRow {
                    Text("").gridColumnAlignment(.leading)
                    Text("Firebase").font(Typo.label).foregroundStyle(Theme.ink)
                    Text("Catalyst").font(Typo.label).foregroundStyle(Theme.ink)
                }
                ForEach(rows, id: \.label) { r in
                    GridRow {
                        Text(r.label).font(Typo.body).foregroundStyle(Theme.muted)
                        Text(CloudComparisonRow.format(r.firebaseMs)).font(Typo.body).monospacedDigit().foregroundStyle(Theme.ink)
                        Text(CloudComparisonRow.format(r.catalystMs)).font(Typo.body).monospacedDigit().foregroundStyle(Theme.ink)
                    }
                }
            }
        }
    }

    // MARK: Shared pieces

    private func statusDot(_ s: CloudProviderStatus) -> Color? {
        switch s { case .inUse: Theme.done; case .ready: Theme.working; case .notSetUp: nil }
    }

    @ViewBuilder private func testLine(_ p: CloudProvider, _ t: CloudTest?) -> some View {
        if let e = m.testErrors[p] {
            Footnote("Last test failed: \(e)")
            ReportProblemButton(problem: "Last test failed: \(e)", place: "Settings › Cloud › \(p.title)")
        } else if let t, t.ok {
            Footnote("Last test: write \(CloudComparisonRow.format(t.writeMs)), read \(CloudComparisonRow.format(t.readMs)), change notice \(CloudComparisonRow.format(t.noticeMs)).")
        } else if let t, let e = t.error {
            Footnote("Last test failed: \(e)")
            ReportProblemButton(problem: "Last test failed: \(e)", place: "Settings › Cloud › \(p.title)")
        }
    }

    @ViewBuilder private func notice(_ p: CloudProvider) -> some View {
        if let n = m.notices[p] { Footnote(n) }
    }

    private func useThis(_ p: CloudProvider, _ s: CloudState) -> some View {
        Button {
            confirming = p
        } label: {
            if m.selecting == p { ProgressView().controlSize(.small) } else { Text("Use this") }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(s.status(p) != .ready || m.selecting != nil)
        .help(s.status(p) == .inUse ? "Already in use" : s.status(p) == .notSetUp ? "Set it up first" : "Move paired devices to \(p.title)")
    }

    private func testButton(_ p: CloudProvider, _ s: CloudState) -> some View {
        Button {
            Task { await m.test(p) }
        } label: {
            if m.testing.contains(p) { ProgressView().controlSize(.small) } else { Text("Test") }
        }
        .buttonStyle(SecondaryButtonStyle())
        .disabled(s.status(p) == .notSetUp || m.testing.contains(p))
    }

    // MARK: Firebase

    private func firebaseCard(_ f: CloudFirebase, _ s: CloudState) -> some View {
        let status = s.status(.firebase)
        return SettingsCard(title: "Firebase", subtitle: "Google's Realtime Database. Free, and the original home of the channel.", symbol: "flame") {
            StatusLine(dot: statusDot(status), text: status.text, detail: [f.projectId, f.databaseUrl].compactMap { $0 }.joined(separator: "\n").nilIfEmpty)
            testLine(.firebase, f.lastTest)
            HStack(spacing: Space.s) {
                Button("Set up…") { settingUp = true }.buttonStyle(SecondaryButtonStyle())
                testButton(.firebase, s)
                Spacer(minLength: 0)
                useThis(.firebase, s)
            }
            if f.configured {
                HStack(spacing: Space.s) {
                    TextField("Project name", text: $renameDraft, prompt: Text("New display name"))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { rename() }
                    Button {
                        rename()
                    } label: {
                        if m.renaming { ProgressView().controlSize(.small) } else { Text("Rename") }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(renameDraft.trimmingCharacters(in: .whitespaces).isEmpty || m.renaming)
                }
            }
            notice(.firebase)
        }
    }

    private func rename() {
        Task { if await m.renameFirebase(renameDraft) { renameDraft = "" } }
    }

    // MARK: Catalyst

    private func catalystCard(_ c: CloudCatalyst, _ s: CloudState) -> some View {
        let status = s.status(.catalyst)
        let detail = [c.projectName ?? c.projectId, c.dc.map { "Region \($0)" }, c.appUrl].compactMap { $0 }.joined(separator: " · ")
        return SettingsCard(title: "Zoho Catalyst", subtitle: "Zoho's serverless cloud. Four console steps, once.", symbol: "cloud") {
            StatusLine(dot: statusDot(status), text: status.text, detail: detail.nilIfEmpty)
            if !c.steps.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(c.steps.enumerated()), id: \.element.id) { i, step in
                        if i > 0 { Divider().overlay(Theme.line) }
                        CloudStepRow(step: step, catalyst: c)
                            .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 14)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
            }
            testLine(.catalyst, c.lastTest)
            HStack(spacing: Space.s) {
                Button {
                    Task { await m.check() }
                } label: {
                    if m.checking { ProgressView().controlSize(.small) } else { Text("Check again") }
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(m.checking)
                testButton(.catalyst, s)
                Spacer(minLength: 0)
                useThis(.catalyst, s)
            }
            DisclosureGroup("Rename the project") {
                VStack(alignment: .leading, spacing: 6) {
                    Footnote("Catalyst can't rename a project from outside, so do it in the console:")
                    ForEach(Array(CloudRename.catalystConsoleSteps.enumerated()), id: \.offset) { i, line in
                        Footnote("\(i + 1). \(line)")
                    }
                    HStack {
                        Button("Open console") { NSWorkspace.shared.open(CloudConsole.url(dc: c.dc)) }.buttonStyle(SecondaryButtonStyle())
                        Spacer(minLength: 0)
                    }
                }
                .padding(.top, 6)
            }
            .font(Typo.body).foregroundStyle(Theme.ink)
            notice(.catalyst)
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// One step of Catalyst's checklist: glyph, title, one line, then its action.
private struct CloudStepRow: View {
    @Environment(AppModel.self) private var app
    let step: CloudStep
    let catalyst: CloudCatalyst

    private var m: CloudModel { app.cloud }
    private var p: CloudStepPresentation { .make(step: step, cli: catalyst.cli) }

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            glyph.frame(width: 20, height: 20).padding(.top, 1)
            VStack(alignment: .leading, spacing: 6) {
                Text(p.title).font(Typo.label).foregroundStyle(Theme.ink)
                Text(p.instruction).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                if let d = step.detail, step.state == .error || isUnknown { Text(d).font(Typo.meta).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true) }
                if let d = step.detail, step.state == .error { ReportProblemButton(problem: d, place: "Settings › Cloud › Catalyst › \(p.title)") }
                if step.state != .done || p.action == .test { actionBody }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
    }

    private var isUnknown: Bool { if case .unknown = step.state { true } else { false } }

    @ViewBuilder private var glyph: some View {
        switch step.state {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.done)
        case .todo: Image(systemName: "circle").foregroundStyle(Theme.muted)
        case .working: ProgressView().controlSize(.small)
        case .error: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.negative)
        case .unknown: Image(systemName: "questionmark.circle").foregroundStyle(Theme.muted)
        }
    }

    private var consoleURL: URL { step.consoleURL ?? CloudConsole.url(dc: catalyst.dc) }

    @ViewBuilder private var actionBody: some View {
        switch p.action {
        case .install(let command):
            commandBox(label: "Install", command: command)
        case .signIn(let command):
            commandBox(label: "Sign in", command: command, note: "Run this in Terminal. It opens your browser; Squeak runs nothing itself.")
        case .chooseProject:
            VStack(alignment: .leading, spacing: 8) {
                consoleButton
                ForEach(Array(p.consoleSteps.enumerated()), id: \.offset) { i, line in Footnote("\(i + 1). \(line)") }
                HStack(spacing: Space.s) {
                    Picker("Project", selection: Binding(get: { m.pickedProject }, set: { m.pickedProject = $0 })) {
                        if m.projects.isEmpty { Text("No projects yet").tag(CloudProject?.none) }
                        ForEach(m.projects) { Text($0.name).tag(Optional($0)) }
                    }
                    .labelsHidden().frame(maxWidth: 220)
                    Button {
                        Task { await m.chooseProject() }
                    } label: {
                        if m.choosingProject { ProgressView().controlSize(.small) } else { Text("Use this project") }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(m.pickedProject == nil || m.choosingProject)
                    Button("Refresh list") { Task { await m.loadProjects() } }.buttonStyle(QuietButtonStyle()).disabled(m.loadingProjects)
                }
            }
            .task { await m.loadProjects() }
        case .openConsole:
            VStack(alignment: .leading, spacing: 8) {
                consoleButton
                ForEach(Array(p.consoleSteps.enumerated()), id: \.offset) { i, line in Footnote("\(i + 1). \(line)") }
                ForEach(p.fields, id: \.label) { f in
                    HStack(spacing: Space.s) {
                        Text(f.label).font(Typo.meta).foregroundStyle(Theme.muted).frame(width: 92, alignment: .leading)
                        Text(verbatim: f.value).font(Typo.code).foregroundStyle(Theme.ink).textSelection(.enabled)
                        Spacer(minLength: 0)
                        CopyButton(text: f.value)
                    }
                }
            }
        case .deploy:
            HStack(spacing: Space.s) {
                Button {
                    Task { await m.deploy() }
                } label: {
                    if m.deploying || step.state == .working { ProgressView().controlSize(.small) } else { Text("Deploy") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(m.deploying || step.state == .working)
                if m.deploying || step.state == .working { Text("Deploying, this takes a minute or two.").font(Typo.meta).foregroundStyle(Theme.muted) }
            }
        case .test:
            Button {
                Task { await m.test(.catalyst) }
            } label: {
                if m.testing.contains(.catalyst) { ProgressView().controlSize(.small) } else { Text("Test") }
            }
            .buttonStyle(SecondaryButtonStyle())
            .disabled(m.testing.contains(.catalyst))
        case .none:
            EmptyView()
        }
    }

    private var consoleButton: some View {
        HStack {
            Button("Open console") { NSWorkspace.shared.open(consoleURL) }.buttonStyle(SecondaryButtonStyle())
            Spacer(minLength: 0)
        }
    }

    private func commandBox(label: String, command: String, note: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(Typo.meta).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                Text(verbatim: command).font(Typo.code).foregroundStyle(Theme.ink).textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
                Spacer(minLength: 0)
                CopyButton(text: command)
            }
            if let note { Footnote(note) }
        }
    }
}
