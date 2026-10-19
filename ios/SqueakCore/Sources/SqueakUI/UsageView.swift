#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// Plan usage: what the Mac last saw for Claude and Codex. Bars are ink, not state colours
/// (DESIGN.md §3.3: a state colour is never a fill). Refresh asks the Mac for a new Claude reading,
/// signed like a reply; it makes one small real call, at most once a minute.
struct UsageView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var refreshing = false
    @State private var refreshNote: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    if let snapshot = model.snapshot, let usage = snapshot.usage {
                        claude(usage.claude)
                        codex(usage.codex)
                    } else {
                        Text(model.snapshot == nil
                            ? "Waiting for your Mac."
                            : "Your Mac hasn't sent usage yet. Update Squeak on your Mac to see it here.")
                            .foregroundStyle(Theme.muted)
                    }
                    Text(refreshNote ?? "Refresh asks your Mac for a new Claude reading. It makes one small real call, so it runs at most once a minute.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        refreshing = true
                        Task {
                            refreshNote = await model.refreshUsage()
                            refreshing = false
                        }
                    } label: {
                        if refreshing { ProgressView() } else { Text("Refresh") }
                    }
                    .disabled(refreshing || model.snapshot == nil)
                    .accessibilityHint("Asks your Mac for a new Claude reading")
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .foregroundStyle(Theme.ink)
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
                if let asOf { Text(asOf).font(.footnote).foregroundStyle(Theme.muted) }
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
                    Text(UsageFormat.left(window.usedPercent, resetsAt: window.resetsAt)).font(.subheadline.weight(.semibold)).monospacedDigit()
                }
            }
            if let window {
                UsageBar(fraction: UsageFormat.remaining(window.usedPercent, resetsAt: window.resetsAt))
                Text(UsageFormat.resets(window.resetsAt)).font(.footnote).foregroundStyle(Theme.muted)
            } else {
                Text("Not reported").font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A thin track and an ink fill.
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
