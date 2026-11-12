import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Extensions: every extension as the same card (name, blurb, status, Add or Remove): the daemon's
/// add-ons and the built-in channels. An extension without a page of its own shows its page cards under its card.
struct AddonsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                if model.addonsOldDaemon {
                    Text("Update Squeak's background service (Settings › Connections) to add or remove extensions.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                } else if !model.addonsLoaded {
                    HStack(spacing: Space.s) {
                        ProgressView().controlSize(.small)
                        Text("Checking…").font(Typo.body).foregroundStyle(Theme.muted)
                    }
                }
                if let error = model.addonError {
                    HStack(spacing: Space.s) {
                        Text(error).font(Typo.body).foregroundStyle(Theme.negative)
                        ReportProblemButton(problem: "Extensions didn't work", place: "Settings › Extensions", title: "Report")
                    }
                }
                ForEach(model.extensionItems) { item in
                    ExtensionRow(item: item)
                }
            }
            .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, Space.l)
        }
        .task { await model.refreshExtensions() }
    }
}

/// One extension: name, blurb, status and Add or Remove.
private struct ExtensionRow: View {
    @Environment(AppModel.self) private var model
    let item: ExtensionItem
    @State private var confirmingRemove = false

    private var app: (any AppAddon)? { item.kind == .addon ? AddonRegistry.shared.app(id: item.id) : nil }

    var body: some View {
        let busy = model.addonBusy.contains(item.id) || model.channels.restarting
        VStack(alignment: .leading, spacing: Space.l) {
            SettingsCard(title: item.name, subtitle: item.blurb.isEmpty ? (app?.summary ?? "") : item.blurb, symbol: symbol, mark: app?.mark) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack(spacing: Space.s) {
                        Circle().fill(dot).frame(width: 8, height: 8).accessibilityHidden(true)
                        Text(statusText).font(Typo.body).foregroundStyle(Theme.ink)
                        Spacer(minLength: 0)
                        if busy { ProgressView().controlSize(.small) }
                        if item.isAdded {
                            Button("Remove") { remove() }.buttonStyle(SecondaryButtonStyle()).disabled(busy)
                        } else {
                            Button("Add") { add() }.buttonStyle(PrimaryButtonStyle()).disabled(busy || !item.canAdd || (item.kind == .addon && app == nil))
                        }
                    }
                    if let note = item.note, !note.isEmpty {
                        Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if item.isAdded, item.section == nil, let app {
                if let page = app.page { AddonPageCard(page: page, mark: app.mark) { await app.poll() } }
                ForEach(Array(app.extraPages.enumerated()), id: \.offset) { _, page in AddonPageCard(page: page, mark: app.mark) }
            }
        }
        .confirmationDialog(removeTitle, isPresented: $confirmingRemove) {
            Button(removeButton, role: .destructive) { Task { await confirmedRemove() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(removeMessage)
        }
    }

    private var symbol: String {
        switch item.kind {
        case .addon: "puzzlepiece.extension"
        case .telegram: "paperplane"
        case .cliq: "bubble.left"
        case .calls: "phone"
        }
    }

    private var dot: Color {
        switch item.status {
        case .added: Theme.working
        case .needsAttention: Theme.negative
        case .notAdded: Theme.offline
        }
    }

    private var statusText: String {
        if item.kind == .addon, app == nil, !item.isAdded { return "Not in this build" }
        return item.status.label
    }

    private func add() {
        if item.kind == .addon { Task { await model.setAddon(item.id, enabled: true) } }
        else if item.kind == .calls, item.callsConfigured { Task { await model.channels.setVoiceEnabled(true); await model.refreshExtensions() } }
        else if let section = item.section { model.settingsSection = section }
    }

    private func remove() {
        // An older daemon has no switch for calls: the page holds its settings.
        if item.kind == .calls, !item.callsConfigured, let section = item.section { model.settingsSection = section } else { confirmingRemove = true }
    }

    private var removeTitle: String { "Remove \(item.name)?" }
    private var removeButton: String { "Remove \(item.name)" }
    private var removeMessage: String {
        switch item.kind {
        case .addon: "\(item.name) stops showing in Squeak. Nothing in \(item.name) itself is changed."
        case .telegram: "Squeak stops using the Telegram bot and forgets its token."
        case .cliq: "Squeak forgets the Cliq webhook and stops sending to it."
        case .calls: "Squeak stops calling you. Your setup is kept."
        }
    }

    private func confirmedRemove() async {
        switch item.kind {
        case .addon: await model.setAddon(item.id, enabled: false)
        case .telegram: await model.channels.turnOffTelegram(); await model.refreshExtensions()
        case .cliq: await model.channels.removeWebhook(); await model.refreshExtensions()
        case .calls: await model.channels.setVoiceEnabled(false); await model.refreshExtensions()
        }
    }
}

/// An added daemon extension's own page (Settings › Conductor, › RasanAI): its page cards, as the add-on describes them.
struct ExtensionPageView: View {
    @Environment(AppModel.self) private var model
    let id: String

    var body: some View {
        let app = AddonRegistry.shared.app(id: id)
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                if let app, model.isAddonOn(id) {
                    if let page = app.page { AddonPageCard(page: page, mark: app.mark) { await app.poll() } }
                    ForEach(Array(app.extraPages.enumerated()), id: \.offset) { _, page in AddonPageCard(page: page, mark: app.mark) }
                    if app.page == nil && app.extraPages.isEmpty {
                        Text("Nothing to set up here.").font(Typo.body).foregroundStyle(Theme.muted)
                    }
                } else {
                    Text("This extension isn't added. Add it in Settings › Extensions.").font(Typo.body).foregroundStyle(Theme.muted)
                    Button("Open Extensions") { model.settingsSection = .addons }.buttonStyle(SecondaryButtonStyle())
                }
            }
            .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, Space.l)
        }
        .task { await model.refreshExtensions() }
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
