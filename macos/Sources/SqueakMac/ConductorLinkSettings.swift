import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Conductor, drawn from whatever the registered Conductor link add-on describes (`AddonPage`): the
/// status row, the steps and the buttons for the current state. The add-on decides the words and the buttons; this
/// only draws them in Squeak's design.
struct ConductorLinkSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                ConductorLinkCard()
                ConductorWorkspacesCard()
                if let link = model.addons.conductorLink {
                    AddonPageCard(link: link)
                }
            }
            .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, Space.l)
        }
    }
}

/// "Link Conductor": whether Squeak sees Conductor's chats and answers them in its window. State from the daemon
/// (`GET /control/conductor/link`); an older daemon has no such route and the card says so.
struct ConductorLinkCard: View {
    @Environment(AppModel.self) private var model
    @State private var state: ConductorLinkState?
    @State private var oldDaemon = false
    @State private var failed = false
    @State private var busy = false

    var body: some View {
        SettingsCard(title: "Link Conductor", subtitle: "Let Squeak work with the chats in Conductor.", symbol: "link", mark: .conductor) {
            VStack(alignment: .leading, spacing: Space.m) {
                if oldDaemon {
                    Text("Update Squeak's service to manage Conductor here.").font(Typo.body).foregroundStyle(Theme.muted)
                } else if let state {
                    if state.available {
                        Text("Linking lets Squeak see your Conductor chats and answer them in Conductor's window. Typing there needs Accessibility access for Squeak Hands.")
                            .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: Space.s) {
                            Circle().fill(state.linked ? Theme.working : Theme.offline).frame(width: 8, height: 8).accessibilityHidden(true)
                            Text(state.linked ? "Linked" : "Not linked").font(Typo.body).foregroundStyle(Theme.ink)
                            Spacer(minLength: 0)
                            if busy { ProgressView().controlSize(.small) }
                            if state.linked {
                                Button("Unlink") { set(false) }.buttonStyle(SecondaryButtonStyle()).disabled(busy)
                            } else {
                                Button("Link Conductor") { set(true) }.buttonStyle(PrimaryButtonStyle()).disabled(busy)
                            }
                        }
                    } else {
                        Text("Conductor isn't installed on this Mac.").font(Typo.body).foregroundStyle(Theme.muted)
                    }
                    if failed { Text("That didn't work. Try again.").font(Typo.body).foregroundStyle(Theme.negative) }
                } else {
                    HStack(spacing: Space.s) {
                        ProgressView().controlSize(.small)
                        Text("Checking…").font(Typo.body).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        if model.demoMode || model.captureMode { state = ConductorLinkState(linked: true, available: true, appInstalled: true); return }
        do {
            if let s = try await model.client.conductorLink() { state = s; oldDaemon = false } else { oldDaemon = true }
        } catch { state = state ?? ConductorLinkState() }
    }

    private func set(_ linked: Bool) {
        busy = true; failed = false
        Task {
            defer { busy = false }
            if model.demoMode || model.captureMode { state?.linked = linked; return }
            do {
                if try await model.client.setConductorLink(linked) == nil { oldDaemon = true } else { await load() }
            } catch { failed = true }
        }
    }
}

/// "Workspaces": which of Conductor's workspaces show in Squeak. Nothing shows until it is ticked here.
struct ConductorWorkspacesCard: View {
    @Environment(AppModel.self) private var model
    @State private var list: ConductorWorkspaceList?
    @State private var failed = false
    @State private var showArchived = false

    var body: some View {
        Group {
            if let list, list.linked { card(list) }
        }
        .task { await load() }
    }

    private func card(_ list: ConductorWorkspaceList) -> some View {
        let live = list.workspaces.filter { !$0.isArchived }
        let archived = list.workspaces.filter(\.isArchived)
        return SettingsCard(title: "Workspaces", subtitle: "Only the workspaces you add show in Squeak.", symbol: "folder", mark: .conductor) {
            VStack(alignment: .leading, spacing: Space.m) {
                if list.workspaces.isEmpty {
                    Text("No Conductor workspaces.").font(Typo.body).foregroundStyle(Theme.muted)
                }
                groups(live)
                if !archived.isEmpty {
                    DisclosureGroup("Archived", isExpanded: $showArchived) {
                        groups(archived).padding(.top, Space.s)
                    }
                    .font(Typo.body).foregroundStyle(Theme.muted)
                }
                if failed { Text("That didn't work. Try again.").font(Typo.body).foregroundStyle(Theme.negative) }
            }
        }
    }

    private func groups(_ items: [ConductorWorkspaceItem]) -> some View {
        // Repos in the order of their newest workspace; the list arrives newest first.
        var repos: [String] = []
        for w in items where !repos.contains(w.repo) { repos.append(w.repo) }
        return VStack(alignment: .leading, spacing: Space.m) {
            ForEach(repos, id: \.self) { repo in
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(verbatim: repo).font(Typo.meta).foregroundStyle(Theme.muted)
                    ForEach(items.filter { $0.repo == repo }) { row($0) }
                }
            }
        }
    }

    private func row(_ w: ConductorWorkspaceItem) -> some View {
        Toggle(isOn: Binding(get: { w.picked }, set: { set(w, $0) })) {
            HStack(spacing: Space.s) {
                Text(verbatim: w.name).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                if let b = w.branch, !b.isEmpty, b != w.name {
                    Text(verbatim: b).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 0)
                Text("\(w.chats) \(w.chats == 1 ? "chat" : "chats")").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
            }
        }
        .toggleStyle(.switch)
    }

    private func load() async {
        if model.demoMode || model.captureMode { return }
        if let l = try? await model.client.conductorWorkspaces() { list = l }
    }

    private func set(_ w: ConductorWorkspaceItem, _ picked: Bool) {
        failed = false
        let before = list
        if let i = list?.workspaces.firstIndex(where: { $0.id == w.id }) { list?.workspaces[i].picked = picked }
        Task {
            do {
                guard let answer = try await model.client.setConductorWorkspace(id: w.id, picked: picked) else { throw AdapterError.http(404) }
                list = answer
                model.recheck()
            } catch {
                list = before
                failed = true
            }
        }
    }
}

struct AddonPageCard: View {
    let link: any ConductorLinkAddon
    @State private var confirming: AddonPage.Action?

    var body: some View {
        let page = link.page
        SettingsCard(title: page.title, subtitle: page.subtitle, symbol: page.symbol, mark: .conductor) {
            VStack(alignment: .leading, spacing: Space.m) {
                if let headline = page.headline {
                    HStack(alignment: .top, spacing: Space.s) {
                        Circle().fill(color(headline.tone)).frame(width: 8, height: 8).padding(.top, 5).accessibilityHidden(true)
                        Text(verbatim: headline.text).font(Typo.body).foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    if !page.steps.isEmpty {
                        VStack(alignment: .leading, spacing: Space.xs) {
                            ForEach(Array(page.steps.enumerated()), id: \.offset) { i, step in
                                HStack(alignment: .top, spacing: Space.s) {
                                    Text("\(i + 1).").font(Typo.body).monospacedDigit().foregroundStyle(Theme.muted)
                                    Text(verbatim: step).font(Typo.body).foregroundStyle(Theme.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                    ForEach(Array(page.notes.enumerated()), id: \.offset) { _, note in
                        Text(note).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let problem = page.problem {
                        Text(problem).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                    }
                    if let report = page.reportProblem {
                        ReportProblemButton(problem: report, place: page.reportPlace)
                    }
                    HStack(spacing: Space.s) {
                        ForEach(page.actions) { action in
                            button(action)
                        }
                        if page.busy {
                            ProgressView().controlSize(.small)
                            Text("Working…").font(Typo.meta).foregroundStyle(Theme.muted)
                        }
                    }
                } else {
                    HStack(spacing: Space.s) {
                        ProgressView().controlSize(.small)
                        Text(page.loading).font(Typo.body).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .task { await link.poll() }
        .confirmationDialog(
            confirming?.confirmation?.title ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })
        ) {
            if let action = confirming, let c = action.confirmation {
                Button(c.confirmTitle, role: c.destructive ? .destructive : nil) { Task { await action.run() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(confirming?.confirmation?.message ?? "")
        }
    }

    @ViewBuilder private func button(_ action: AddonPage.Action) -> some View {
        let press = { if action.confirmation != nil { confirming = action } else { Task { await action.run() } } }
        if action.primary {
            Button(action.title, action: press).buttonStyle(PrimaryButtonStyle()).disabled(action.disabled)
        } else {
            Button(action.title, action: press).buttonStyle(SecondaryButtonStyle()).disabled(action.disabled)
        }
    }

    private func color(_ tone: AddonPage.Tone) -> Color {
        switch tone {
        case .good: Theme.working
        case .bad: Theme.negative
        case .quiet: Theme.offline
        }
    }
}
