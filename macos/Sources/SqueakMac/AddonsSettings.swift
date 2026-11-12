import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Add-ons: what the daemon carries as add-ons, each with an Add or Remove button. A page an add-on
/// describes (`AddonPage`) shows under its row once it is on. The add-on decides the words, the switches and the
/// buttons; this only draws them in Squeak's design.
struct AddonsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                if model.addonsOldDaemon {
                    Text("Update Squeak's background service (Settings › Connections) to add or remove add-ons.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                } else if model.addonCatalogue.isEmpty {
                    HStack(spacing: Space.s) {
                        ProgressView().controlSize(.small)
                        Text(model.addonsLoaded ? "No add-ons on this Mac." : "Checking…").font(Typo.body).foregroundStyle(Theme.muted)
                    }
                }
                if let error = model.addonError {
                    HStack(spacing: Space.s) {
                        Text(error).font(Typo.body).foregroundStyle(Theme.negative)
                        ReportProblemButton(problem: "Add-ons didn't work", place: "Settings › Add-ons", title: "Report")
                    }
                }
                ForEach(model.addonCatalogue) { info in
                    AddonRow(info: info, app: AddonRegistry.shared.app(id: info.id))
                }
            }
            .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, Space.l)
        }
        .task { await model.refreshAddons() }
    }
}

/// One add-on: name, blurb and Add or Remove; once on, its pages.
private struct AddonRow: View {
    @Environment(AppModel.self) private var model
    let info: AddonInfo
    let app: (any AppAddon)?

    var body: some View {
        let busy = model.addonBusy.contains(info.id)
        VStack(alignment: .leading, spacing: Space.l) {
            SettingsCard(title: info.name, subtitle: info.blurb.isEmpty ? (app?.summary ?? "") : info.blurb, symbol: "puzzlepiece.extension", mark: app?.mark) {
                HStack(spacing: Space.s) {
                    Circle().fill(info.enabled ? Theme.working : Theme.offline).frame(width: 8, height: 8).accessibilityHidden(true)
                    Text(status).font(Typo.body).foregroundStyle(Theme.ink)
                    Spacer(minLength: 0)
                    if busy { ProgressView().controlSize(.small) }
                    if info.enabled {
                        Button("Remove") { Task { await model.setAddon(info.id, enabled: false) } }
                            .buttonStyle(SecondaryButtonStyle()).disabled(busy)
                    } else {
                        Button("Add") { Task { await model.setAddon(info.id, enabled: true) } }
                            .buttonStyle(PrimaryButtonStyle()).disabled(busy || !info.available || app == nil)
                    }
                }
            }
            if info.enabled, let app {
                if let page = app.page {
                    AddonPageCard(page: page, mark: app.mark) { await app.poll() }
                }
                ForEach(Array(app.extraPages.enumerated()), id: \.offset) { _, page in
                    AddonPageCard(page: page, mark: app.mark)
                }
            }
        }
    }

    private var status: String {
        if info.enabled { return "Added" }
        if app == nil { return "Not in this build" }
        return info.available ? "Not added" : "\(info.name) isn't installed on this Mac"
    }
}

struct AddonPageCard: View {
    let page: AddonPage
    var mark: AgentMarkAsset?
    /// Runs while the card is on screen, until cancelled.
    var poll: @MainActor @Sendable () async -> Void = {}
    @State private var confirming: AddonPage.Action?
    @State private var showArchived = false

    var body: some View {
        SettingsCard(title: page.title, subtitle: page.subtitle, symbol: page.symbol, mark: mark) {
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
                    if let title = page.choicesTitle { choicesView(title) }
                } else {
                    HStack(spacing: Space.s) {
                        ProgressView().controlSize(.small)
                        Text(page.loading).font(Typo.body).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .task { await poll() }
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

    @ViewBuilder private func choicesView(_ title: String) -> some View {
        let live = page.choices.filter { !$0.archived }
        let archived = page.choices.filter(\.archived)
        VStack(alignment: .leading, spacing: Space.m) {
            Text(title).font(Typo.meta).foregroundStyle(Theme.muted)
            if page.choices.isEmpty {
                Text(page.choicesEmpty).font(Typo.body).foregroundStyle(Theme.muted)
            }
            choiceGroups(live)
            if !archived.isEmpty {
                DisclosureGroup("Archived", isExpanded: $showArchived) { choiceGroups(archived).padding(.top, Space.s) }
                    .font(Typo.body).foregroundStyle(Theme.muted)
            }
        }
    }

    /// Choices under their group's heading, in the order the groups first appear.
    private func choiceGroups(_ items: [AddonPage.Choice]) -> some View {
        var groups: [String?] = []
        for c in items where !groups.contains(where: { $0 == c.group }) { groups.append(c.group) }
        return VStack(alignment: .leading, spacing: Space.m) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                VStack(alignment: .leading, spacing: Space.xs) {
                    if let group { Text(verbatim: group).font(Typo.meta).foregroundStyle(Theme.muted) }
                    ForEach(items.filter { $0.group == group }) { choiceRow($0) }
                }
            }
        }
    }

    private func choiceRow(_ c: AddonPage.Choice) -> some View {
        Toggle(isOn: Binding(get: { c.isOn }, set: { on in Task { await c.toggle(on) } })) {
            HStack(spacing: Space.s) {
                Text(verbatim: c.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 0)
                if let sub = c.subtitle, !sub.isEmpty {
                    Text(verbatim: sub).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                }
            }
        }
        .toggleStyle(.switch)
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
