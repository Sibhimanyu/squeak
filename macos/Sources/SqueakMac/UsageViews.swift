import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Plan usage, drawn the same way in the popover and the window. Bars are ink on a line track,
/// never a state colour (DESIGN.md §3.3: a state colour is never a fill). Every reading carries its
/// age once it is stale, and "not seen yet" is said plainly rather than shown as zero.

/// A thin track with an ink fill.
struct UsageBar: View {
    let fraction: Double
    var height: CGFloat = 5

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.line)
                Capsule().fill(Theme.ink).frame(width: max(proxy.size.width * fraction, fraction > 0 ? height : 0))
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

/// One window: name and "58% left · resets in 2h 10m" on a line, the bar under it (what is left).
struct UsageWindowRow: View {
    let name: String
    let window: UsageWindow?
    var bigger = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(name).font(bigger ? Typo.body : Typo.meta).foregroundStyle(bigger ? Theme.ink : Theme.muted)
                Spacer(minLength: 6)
                if let window {
                    Text(UsageFormat.left(window.usedPercent, resetsAt: window.resetsAt)).font(bigger ? Typo.label : Typo.meta.weight(.semibold))
                        .monospacedDigit().foregroundStyle(Theme.ink)
                    Text("·").foregroundStyle(Theme.subtle)
                    Text(UsageFormat.resets(window.resetsAt)).font(bigger ? Typo.body : Typo.meta).foregroundStyle(Theme.muted)
                } else {
                    Text("not reported").font(bigger ? Typo.body : Typo.meta).foregroundStyle(Theme.muted)
                }
            }
            UsageBar(fraction: window.map { UsageFormat.remaining($0.usedPercent, resetsAt: $0.resetsAt) } ?? 0, height: bigger ? 6 : 5)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(window.map { "\(name), \(UsageFormat.left($0.usedPercent, resetsAt: $0.resetsAt)), \(UsageFormat.resets($0.resetsAt))" } ?? "\(name), not reported")
    }
}

/// A provider's heading: its name, the age of the reading when stale, and an optional trailing control.
private struct ProviderHeader<Trailing: View>: View {
    let name: String
    let reading: ProviderUsage?
    var bigger = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(name).font(bigger ? Typo.heading : Typo.label).foregroundStyle(Theme.ink)
            if let age = UsageFormat.asOf(reading?.observedAt) {
                Text(age).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 6)
            trailing
        }
    }
}

/// Refresh for Claude: one real, tiny call on the daemon, so only ever on this press.
struct ClaudeRefreshButton: View {
    @Environment(AppModel.self) private var model
    var labelled = true

    var body: some View {
        Button { Task { await model.refreshClaude() } } label: {
            HStack(spacing: 5) {
                if model.claudeRefreshing {
                    ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 16, height: 16)
                } else {
                    Lucide(.refreshCw, size: 16, color: Theme.muted)
                }
                if labelled { Text(model.claudeRefreshing ? "Asking Claude…" : "Refresh").font(Typo.meta.weight(.medium)) }
            }
            .foregroundStyle(Theme.ink)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.claudeRefreshing || !model.isConnected)
        .accessibilityLabel("Refresh Claude usage")
        .help("Ask Claude for its current limits. This makes one small call and counts a little against your usage.")
    }
}

// MARK: - Popover

/// The compact section at the foot of the popover.
struct UsageSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            SectionLabel("Usage")
            provider("Claude", reading: model.usage?.claude, long: "7 days", notSeen: "Not seen yet. Press Refresh to read it.") {
                ClaudeRefreshButton()
            }
            if let note = model.claudeRefreshNote {
                Text(note).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            provider("Codex", reading: model.usage?.codex, long: "Weekly", notSeen: "Not seen yet. Codex reports it once a session has run.") {
                EmptyView()
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, Space.m)
        .task { await model.pollUsage() }
    }

    @ViewBuilder
    private func provider<T: View>(_ name: String, reading: ProviderUsage?, long: String, notSeen: String, @ViewBuilder trailing: () -> T) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProviderHeader(name: name, reading: reading) { trailing() }
            if let reading {
                UsageWindowRow(name: "5 hours", window: reading.fiveHour)
                UsageWindowRow(name: long, window: reading.longWindow)
            } else {
                Text(notSeen).font(Typo.meta).foregroundStyle(Theme.muted)
            }
        }
    }
}

// MARK: - Window

/// The fuller view in the window's detail column.
struct UsageDetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Usage").font(Typo.title).accessibilityAddTraits(.isHeader)
                    Text("How much of each plan's limits you have used.").font(Typo.body).foregroundStyle(Theme.muted)
                }
                claude
                codex
                cost
                Text("Claude only reports its limits while it runs, so Refresh makes one small call to read them (a little counts against your usage), at most once a minute. Squeak never does it on its own. Codex is read from its own files and is always current.")
                    .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(.horizontal, 32).padding(.vertical, 28)
            .frame(maxWidth: .infinity)
        }
        .task { await model.pollUsage() }
    }

    private var claude: some View {
        VStack(alignment: .leading, spacing: 14) {
            ProviderHeader(name: "Claude", reading: model.usage?.claude, bigger: true) { ClaudeRefreshButton() }
            if let reading = model.usage?.claude {
                UsageWindowRow(name: "5 hours", window: reading.fiveHour, bigger: true)
                UsageWindowRow(name: "7 days", window: reading.longWindow, bigger: true)
            } else {
                Text("Not seen yet. Press Refresh to read it.").font(Typo.body).foregroundStyle(Theme.muted)
            }
            if let note = model.claudeRefreshNote {
                Text(note).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var codex: some View {
        VStack(alignment: .leading, spacing: 14) {
            ProviderHeader(name: "Codex", reading: model.usage?.codex, bigger: true) { EmptyView() }
            if let reading = model.usage?.codex {
                UsageWindowRow(name: "5 hours", window: reading.fiveHour, bigger: true)
                UsageWindowRow(name: "Weekly", window: reading.longWindow, bigger: true)
            } else {
                Text("Not seen yet. Codex reports it once a session has run.").font(Typo.body).foregroundStyle(Theme.muted)
            }
        }
    }

    private var cost: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Today").font(Typo.heading)
            if let usd = model.usage?.todayCostUsd, let n = model.usage?.todayCostSessions {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(UsageFormat.dollars(usd)).font(.system(size: 20, weight: .semibold)).monospacedDigit()
                    Text("estimated").font(Typo.body).foregroundStyle(Theme.muted)
                }
                Text("Estimated from token counts across \(n) session\(n == 1 ? "" : "s") active today. A session's whole cost counts on the day it was last active, and a model Squeak has no price for is left out.")
                    .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("No cost to estimate yet today.").font(Typo.body).foregroundStyle(Theme.muted)
            }
        }
    }
}

/// The Mac's awake session in the popover (the one place on the Mac to see it, with the countdown
/// beside the duck): what is left and a way to add time or end it; or a way to start one. And, when the
/// hotspot has taken over, that it has.
struct AwakeRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Keep Mac awake").font(Typo.body).foregroundStyle(Theme.ink)
                Spacer(minLength: 6)
                if let awake = model.awake {
                    Text(awake.until.map { "until \($0.formatted(date: .omitted, time: .shortened))" } ?? "until you end it")
                        .font(Typo.meta).foregroundStyle(Theme.muted).monospacedDigit()
                    Menu {
                        if awake.until != nil { Button("Add 1 hour") { Task { await model.changeAwake("extend", minutes: 60) } } }
                        if !awake.lid, model.awakeLidReady {
                            // A lid-closed session must end: keep this one's end, or an hour from now.
                            Button("Keep awake with the lid closed too") {
                                Task { await model.changeAwake("start", minutes: Self.minutesLeft(awake.until) ?? 60, lid: true) }
                            }
                        }
                        if !model.awakeLidReady { setUpButton }
                        Button("End awake session", role: .destructive) { Task { await model.changeAwake("end") } }
                    } label: { Text("On").font(Typo.meta.weight(.semibold)) }
                    .menuStyle(.borderlessButton).fixedSize()
                } else {
                    Menu {
                        Section("Lid open") {
                            ForEach(Self.lengths, id: \.0) { hours, minutes in
                                Button("For \(hours) hour\(hours == 1 ? "" : "s")") { Task { await model.changeAwake("start", minutes: minutes) } }
                            }
                            Button("Until I end it") { Task { await model.changeAwake("start") } }
                        }
                        Section("Lid closed too") {
                            if model.awakeLidReady {
                                ForEach(Self.lengths, id: \.0) { hours, minutes in
                                    Button("For \(hours) hour\(hours == 1 ? "" : "s")") { Task { await model.changeAwake("start", minutes: minutes, lid: true) } }
                                }
                            } else {
                                setUpButton
                            }
                        }
                    } label: { Text("Off").font(Typo.meta) }
                    .menuStyle(.borderlessButton).fixedSize()
                }
            }
            if let awake = model.awake, awake.lid {
                Text("Stays awake with the lid closed. Keep it on a hard, open surface, never in a bag.")
                    .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if model.settingUpLid {
                Text("Waiting for your Mac password…").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            if let hotspot = model.hotspot, hotspot.onHotspot {
                Text("On your iPhone's hotspot\(hotspot.ssid.map { " (\($0))" } ?? "")").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            if let note = model.awakeNote {
                Text(note).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, Space.m)
        .accessibilityElement(children: .contain)
    }

    static let lengths = [(1, 60), (2, 120), (4, 240), (8, 480)]

    /// Asks for the Mac password once; after that, lid-closed sessions start without it.
    private var setUpButton: some View {
        Button("Set up lid-closed…") { Task { await model.setUpLidClosed() } }
            .disabled(model.settingUpLid)
    }

    static func minutesLeft(_ until: Date?, now: Date = Date()) -> Int? {
        guard let until else { return nil }
        return max(5, Int((until.timeIntervalSince(now) / 60).rounded()))
    }
}
