#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// A film (RasanAI) in progress: its five calls as a stepper, and under it what the director is doing now
/// (or the call it waits on you for). Shown beside the chat whether the film works or waits.
/// Everything here is the director's text: plain text only.
struct FilmProgressCard: View {
    let progress: WorkflowProgress

    private static let names = ["brief": "Brief", "story": "Story", "look": "Look", "animatic": "Animatic", "final": "Final", "ask": "Question"]

    private static func name(_ call: String) -> String { names[call] ?? call.capitalized }

    private var steps: [WorkflowProgress.Call] {
        progress.calls.isEmpty
            ? ["brief", "story", "look", "animatic", "final"].map { .init(call: $0, state: "next") }
            : progress.calls
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(["RasanAI", progress.title].compactMap { $0 }.joined(separator: " · ").uppercased())
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                .accessibilityAddTraits(.isHeader)
            stepper
            TimelineView(.periodic(from: .now, by: 5)) { context in
                line(now: context.date)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(now: Date()))
    }

    private var stepper: some View {
        HStack(alignment: .top, spacing: 4) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                let now = step.state == "now", done = step.state == "done"
                VStack(spacing: 6) {
                    Capsule()
                        .fill(done || now ? Theme.ink : Theme.lineStrong)
                        .frame(height: now ? 4 : 3)
                        .opacity(done ? 0.55 : 1)
                    Text(Self.name(step.call))
                        .font(.caption2.weight(now ? .semibold : .regular))
                        .foregroundStyle(now ? Theme.ink : done ? Theme.muted : Theme.subtle)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    @ViewBuilder private func line(now: Date) -> some View {
        if progress.waiting {
            Text("Waiting on you: \(Self.name(progress.call))")
                .font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
        } else if let activity = progress.activity, !activity.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(activity).font(.subheadline).foregroundStyle(Theme.ink)
                if let ago = ago(now: now) { Text(ago).font(.caption).foregroundStyle(Theme.muted) }
            }
        } else {
            Text("Working on the \(Self.name(progress.call).lowercased())")
                .font(.subheadline).foregroundStyle(Theme.muted)
        }
    }

    private func ago(now: Date) -> String? {
        guard let iso = progress.activityAt, let date = Age.date(iso) else { return nil }
        return Age.sync(date, now: now)
    }

    private func accessibilityText(now: Date) -> String {
        var parts = ["RasanAI film" + (progress.title.map { " \($0)" } ?? "")]
        let current = steps.first { $0.state == "now" }
        let done = steps.filter { $0.state == "done" }.count
        parts.append("\(done) of \(steps.count) calls done" + (current.map { ", now on \(Self.name($0.call))" } ?? ""))
        if progress.waiting {
            parts.append("Waiting on you: \(Self.name(progress.call))")
        } else if let activity = progress.activity, !activity.isEmpty {
            parts.append(activity + (ago(now: now).map { ", \($0)" } ?? ""))
        }
        return parts.joined(separator: ". ")
    }
}
#endif
