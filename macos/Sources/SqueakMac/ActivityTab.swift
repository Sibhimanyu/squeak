import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Activity tab

struct ActivityList: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.activity.isEmpty {
            VStack(spacing: Space.s) {
                Lucide(.clipboardList, size: 28, color: Theme.subtle)
                Text("No activity to show").font(Typo.heading)
                Text(session.state == .working ? "Steps appear here as the agent works." : "Steps appear here while the agent works on a turn.")
                    .font(Typo.body).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(model.activity.enumerated()), id: \.offset) { i, step in
                        ActivityStepRow(step: step)
                        if i < model.activity.count - 1 { Divider().padding(.leading, 40) }
                    }
                }
                .frame(maxWidth: 820).padding(.horizontal, 28).padding(.vertical, 16)
                .frame(maxWidth: .infinity)
            }
        }
    }

    static func icon(_ step: ActivityStep) -> LucideName {
        switch step.kind {
        case "thinking": return .brain
        case "note", "text": return .alignLeft
        case "background": return .history
        default:
            let l = step.text.lowercased()
            if l.hasPrefix("read") { return .fileText }
            if l.hasPrefix("edit") || l.hasPrefix("write") { return .filePen }
            if l.hasPrefix("run") { return .terminal }
            if l.hasPrefix("search") || l.hasPrefix("find") { return .search }
            return .wrench
        }
    }
}

/// One step of an agent's turn: its icon, text and time. The Activity tab and a subagent's feed draw the same row.
struct ActivityStepRow: View {
    let step: ActivityStep
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: compact ? 8 : 12) {
            Lucide(ActivityList.icon(step), size: compact ? 12 : 16, color: Theme.muted)
                .frame(width: compact ? 22 : 28, height: compact ? 22 : 28)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
            Text(verbatim: step.text).font(compact ? Typo.body : .body).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, compact ? 2 : 5)
            if let at = step.at {
                Text(at.formatted(date: .omitted, time: .standard)).font(Typo.body).monospacedDigit()
                    .foregroundStyle(Theme.subtle).padding(.top, compact ? 2 : 5)
            }
        }
        .padding(.vertical, compact ? 6 : 9)
    }
}

