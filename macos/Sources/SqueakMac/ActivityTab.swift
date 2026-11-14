import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Activity tab

/// The icon a step's text implies; the list itself lives in the inspector's Activity tab.
enum ActivityList {
    static func icon(_ step: ActivityStep) -> LucideName {
        switch step.kind {
        case "thinking": return .brain
        case "note", "text": return .alignLeft
        case "background", "waiting": return .history
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

