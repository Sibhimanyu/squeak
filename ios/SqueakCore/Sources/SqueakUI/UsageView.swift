#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// Plan usage: what the Mac last saw for Claude and Codex. Bars are ink, not state colours
/// (DESIGN.md §3.3: a state colour is never a fill); they fill as a window is used. The sheet asks
/// the Mac for a new Claude reading when it opens, and again on Refresh, signed like a reply; it
/// fetches usage without consuming tokens, at most once a minute.
struct UsageView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var refreshing = false
    @State private var refreshNote: String?
    @State private var refreshedOnOpen = false
    @State private var switchTarget: ClaudeAccounts.Account?
    @State private var switching = false
    @State private var switchNote: String?
    /// `-squeak-usage-details` (screenshots only) opens Details.
    @State private var showingDetails = ProcessInfo.processInfo.arguments.contains("-squeak-usage-details")

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    if refreshFailed, let note = refreshNote {
                        // Up top, not in the fine print: the readings below are old until this is fixed.
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Couldn't refresh").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.needsYou)
                            Text(note).font(.footnote).foregroundStyle(Theme.ink)
                            if note.localizedCaseInsensitiveContains("sign-in") {
                                Text("Use Claude Code on your Mac once, then press Refresh.").font(.footnote).foregroundStyle(Theme.muted)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    if let snapshot = model.snapshot, let usage = snapshot.usage {
                        claude(usage.claude)
                        if let accounts = snapshot.claudeAccounts, accounts.available { claudeAccounts(accounts) }
                        codex(usage.codex)
                        if snapshot.usageStats == true || model.demo {
                            NavigationLink { UsageDetailsView() } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("Details").font(.headline)
                                        Text("Tokens, cost, models, streaks and projects").font(.footnote).foregroundStyle(Theme.muted)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("usage-details")
                        }
                    } else {
                        Text(model.snapshot == nil
                            ? "Waiting for your Mac."
                            : "Your Mac hasn't sent usage yet. Update Squeak on your Mac to see it here.")
                            .foregroundStyle(Theme.muted)
                    }
                    Text((refreshFailed ? nil : refreshNote) ?? "Usage refreshes when you open this, and on Refresh. It asks your Mac for a new Claude reading and fetches usage without consuming tokens, at most once a minute.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Usage")
            .navigationDestination(isPresented: $showingDetails) { UsageDetailsView() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { Haptics.play(.tap); 
                        Task { await refresh() }
                    } label: {
                        if refreshing { ProgressView() } else { Text("Refresh") }
                    }
                    .disabled(refreshing || model.snapshot == nil)
                    .accessibilityHint("Asks your Mac for a new Claude reading")
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { Haptics.play(.tap); dismiss() } }
            }
        }
        .foregroundStyle(Theme.ink)
        .task(id: model.snapshot == nil) {
            guard model.snapshot != nil, !refreshedOnOpen else { return }
            refreshedOnOpen = true
            await refresh()
        }
    }

    /// The Mac answered with a reason instead of a reading ("Updated just now." and "Already up to date…" are the good answers).
    private var refreshFailed: Bool {
        guard let note = refreshNote else { return false }
        return !note.hasPrefix("Updated") && !note.hasPrefix("Already up to date")
    }

    private func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        refreshNote = await model.refreshUsage()
        refreshing = false
    }

    @ViewBuilder
    private func claude(_ usage: PhoneSnapshot.ClaudeUsage?) -> some View {
        section("Claude", asOf: usage.flatMap { UsageFormat.asOf($0.observedAt) }) {
            if let usage {
                row("5 hours", usage.fiveHour)
                row("7 days", usage.sevenDay)
            } else {
                Text("Not seen yet. Press Refresh.").foregroundStyle(Theme.muted)
            }
        }
    }

    /// The Claude accounts saved on the Mac (claude-swap). Tapping another asks first, then Face ID, then the Mac switches.
    @ViewBuilder
    private func claudeAccounts(_ list: ClaudeAccounts) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Claude account").font(.headline).accessibilityAddTraits(.isHeader)
            ForEach(list.accounts) { account in
                Button { Haptics.play(.tap); 
                    if account.name != list.current { switchTarget = account }
                } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.name).font(.subheadline.weight(.semibold))
                            Text("\(account.planLabel) · \(account.email)").font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer()
                        if account.name == list.current {
                            Image(systemName: "checkmark").font(.subheadline.weight(.semibold))
                        }
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(switching)
                .accessibilityAddTraits(account.name == list.current ? .isSelected : [])
                .accessibilityIdentifier("claude-account-\(account.name)")
            }
            if let switchNote {
                Text(switchNote).font(.footnote).foregroundStyle(Theme.needsYou)
            } else {
                Text("New chats use the account you pick. Chats already running keep the current one until they restart.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .confirmationDialog(
            switchTarget.map { "Switch Claude to \($0.name)?" } ?? "",
            isPresented: Binding(get: { switchTarget != nil }, set: { if !$0 { switchTarget = nil } }),
            titleVisibility: .visible, presenting: switchTarget
        ) { account in
            Button("Switch to \(account.name)") { Haptics.play(.tap); 
                Task {
                    switching = true
                    switchNote = await model.switchClaudeAccount(account.name)
                    switching = false
                    if switchNote == nil { await refresh() }
                }
            }
            Button("Cancel", role: .cancel) { Haptics.play(.tap); }
        } message: { _ in
            Text("New chats use it; chats already running keep the current account until they restart.")
        }
    }

    @ViewBuilder
    private func codex(_ usage: PhoneSnapshot.CodexUsage?) -> some View {
        section("Codex", asOf: usage.flatMap { UsageFormat.asOf($0.observedAt) }) {
            if let usage {
                row("5 hours", usage.fiveHour)
                row("Weekly", usage.weekly)
            } else {
                Text("Not seen yet. Codex reports it once a session has run.").foregroundStyle(Theme.muted)
            }
        }
    }

    private func section<Content: View>(_ title: String, asOf: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer()
                // Older than an hour is a warning, not a caption.
                if let asOf { Text(asOf).font(.footnote).foregroundStyle(Theme.needsYou) }
            }
            content()
        }
    }

    @ViewBuilder
    private func row(_ name: String, _ window: PhoneSnapshot.UsageWindow?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(name).font(.subheadline)
                Spacer()
                if let window {
                    Text(UsageFormat.usedLabel(window.usedPercent, resetsAt: window.resetsAt)).font(.subheadline.weight(.semibold)).monospacedDigit()
                }
            }
            if let window {
                UsageBar(fraction: UsageFormat.usedFraction(window.usedPercent, resetsAt: window.resetsAt))
                Text(UsageFormat.resets(window.resetsAt)).font(.footnote).foregroundStyle(Theme.muted)
            } else {
                Text("Not reported").font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A thin line track and an ink fill that grows with use (never a state colour).
struct UsageBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.line)
                Capsule().fill(Theme.ink).frame(width: max(proxy.size.width * fraction, fraction > 0 ? 4 : 0))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}
#endif
