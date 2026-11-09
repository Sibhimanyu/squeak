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
            if let link = model.addons.conductorLink {
                AddonPageCard(link: link).padding(.horizontal, 24).padding(.top, 8)
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
