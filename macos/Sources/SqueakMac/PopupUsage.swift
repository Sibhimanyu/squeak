import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The Usage tab's header: its title and Refresh. Refresh is the only thing that asks Claude for its
/// limits, only on a press, and at most once a minute (the daemon throttles to the same).
struct PopupUsageHeader: View {
    @Environment(AppModel.self) private var model
    let nav = PopupNav.shared
    var namespace: Namespace.ID
    @Binding var searching: Bool
    let dismiss: () -> Void

    var body: some View {
        PopupTabHeader(selected: .usage, namespace: namespace) {
            Text("Usage").font(.popup(16, .bold)).foregroundStyle(Theme.ink)
        } trailing: {
            HStack(spacing: 8) {
                TimelineView(.periodic(from: .now, by: 5)) { ctx in
                    let waiting = nav.lastUsageRefresh.map { ctx.date.timeIntervalSince($0) < 60 } ?? false
                    Button {
                        nav.lastUsageRefresh = Date()
                        Task { await model.refreshClaude() }
                    } label: {
                        HStack(spacing: 7) {
                            if model.claudeRefreshing {
                                ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 16, height: 16)
                            } else {
                                Lucide(.refreshCw, size: 14, color: Theme.ink)
                            }
                            Text(model.claudeRefreshing ? "Fetching…" : "Refresh")
                        }
                    }
                    .buttonStyle(PopupButtonStyle(height: 26, hPad: 13, size: 12.5))
                    .disabled(model.claudeRefreshing || waiting || !model.isConnected)
                    .help(waiting ? "Squeak checks Claude's usage at most once a minute." : "Ask Claude for its current limits. Uses no tokens.")
                    .accessibilityLabel("Refresh Claude usage")
                }
                PopupMoreMenu(searching: $searching, isHome: false, dismiss: dismiss)
            }
        }
    }
}

/// Claude's and Codex's windows as neutral ink bars: what is used and when it resets.
struct PopupUsageBand: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            provider("Claude", model.usage?.claude, long: "7 days", notSeen: "Not seen yet. Press Refresh to read it.")
            if let note = model.claudeRefreshNote {
                Text(note).font(.popup(12.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 12)
            }
            provider("Codex", model.usage?.codex, long: "Weekly", notSeen: "Not seen yet. Codex reports it once a session has run.")
            PopupDivider()
            Text("Claude's reading is taken when you press Refresh. Codex's is live. This screen shows what Squeak last saw.")
                .font(.popup(12.5)).foregroundStyle(Theme.muted).lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 14).padding(.bottom, 4)
        }
        .padding(.bottom, 14)
        .task { await model.pollUsage() }
    }

    @ViewBuilder private func provider(_ name: String, _ reading: ProviderUsage?, long: String, notSeen: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let m = AgentMarkAsset(agent: name) { AgentMark(m, size: 18).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 } }
            Text(name).font(.popup(14, .bold)).foregroundStyle(Theme.ink)
            if let age = UsageFormat.asOf(reading?.observedAt) { Text(age).font(.popup(12)).foregroundStyle(Theme.muted) }
            Spacer(minLength: 0)
        }
        .padding(.top, 8).padding(.bottom, 10)
        PopupDivider()
        if reading?.fiveHour == nil && reading?.longWindow == nil {
            Text(notSeen).font(.popup(12.5)).foregroundStyle(Theme.muted).padding(.vertical, 14)
        } else {
            windowRow("5 hours", reading?.fiveHour)
            if reading?.fiveHour != nil, reading?.longWindow != nil { PopupDivider() }
            windowRow(long, reading?.longWindow)
        }
        Spacer().frame(height: 14)
    }

    @ViewBuilder private func windowRow(_ name: String, _ w: UsageWindow?) -> some View {
        if let w {
            let reset = UsageFormat.hasReset(w.resetsAt)
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline) {
                    Text(name).font(.popup(14, .semibold)).foregroundStyle(Theme.ink)
                    Spacer(minLength: 8)
                    Text(reset ? "Reset" : UsageFormat.used(w.usedPercent)).font(.popup(14, .semibold)).monospacedDigit().foregroundStyle(Theme.ink)
                }
                PopupBar(fraction: reset ? 0 : UsageFormat.fraction(w.usedPercent), fill: Theme.ink.opacity(0.82), track: Color.wash(0.14), height: 8)
                let resets = UsageFormat.resets(w.resetsAt)
                if !resets.isEmpty && !reset { Text(resets).font(.popup(12.5)).foregroundStyle(Theme.muted).monospacedDigit() }
            }
            .padding(.vertical, 12)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(name), \(reset ? "reset" : UsageFormat.used(w.usedPercent)), \(UsageFormat.resets(w.resetsAt))")
        }
    }
}
