import SqueakIcons
import SqueakMacCore
import SwiftUI

// One row of the Ripples feed. Rows are id-stable: a turn that changes redraws in place with the same height class,
// and only a row that arrives after the first draw fades in (Motion.standard), once.

struct RoomRippleView: View {
    let ripple: RoomRipple
    let threads: [RoomThread]
    let ledger: RoomFadeLedger
    let open: (String) -> Void
    let retry: (String) -> Void
    @State private var visible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// How many rows of "new activity" a ripple counts as (a group counts its turns).
    static func weight(_ r: RoomRipple) -> Int {
        if case .threadTurns(let g) = r { return g.rows.count }
        return 1
    }

    static let gutter: CGFloat = 90

    var body: some View {
        content
            .opacity(visible ? 1 : 0)
            .onAppear {
                guard ledger.shouldFade(ripple.id), !reduceMotion else { return }
                visible = false
                withAnimation(Motion.standard) { visible = true }
            }
    }

    @ViewBuilder private var content: some View {
        switch ripple {
        case .day(_, let label): DaySeparator(label: label)
        case .threadTurns(let g): GroupView(group: g, open: open)
        case .bubble(let row, let mine): BubbleView(row: row, mine: mine, retry: retry)
        case .handoff(let h): HandoffView(handoff: h, threads: threads)
        case .event(let row, let title, let agent): EventView(row: row, title: title, agent: agent)
        }
    }
}

private func clock(_ at: Int64) -> some View {
    Text(verbatim: at > 0 ? RoomRipples.clock(at) : "").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.subtle)
        .frame(width: 48, alignment: .leading)
}

private struct DaySeparator: View {
    let label: String
    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Theme.line).frame(height: 1)
            Text(verbatim: label).font(.system(size: 12)).foregroundStyle(Theme.subtle)
            Rectangle().fill(Theme.line).frame(height: 1)
        }
        .padding(.vertical, Space.m).accessibilityElement(children: .ignore).accessibilityLabel(label).accessibilityAddTraits(.isHeader)
    }
}

private struct GroupView: View {
    let group: RoomThreadGroup
    let open: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Color.clear.frame(width: 56, height: 1)
                ThreadDuckView(id: group.sessionId, agent: group.agent, size: 24)
                Color.clear.frame(width: RoomRippleView.gutter - 56 - 24, height: 1)
                Button { open(group.sessionId) } label: {
                    HStack(spacing: 8) {
                        Text(verbatim: group.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                        Text(verbatim: group.countLabel).font(.system(size: 12)).foregroundStyle(Theme.subtle)
                    }
                }
                .buttonStyle(.plain).help("Open \(group.title)")
                Spacer(minLength: 0)
            }
            .padding(.top, Space.l).padding(.bottom, 2)
            .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
            ForEach(group.rows) { TurnRowView(row: $0) }
        }
    }
}

private struct TurnRowView: View {
    let row: RoomTurnRow

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            clock(row.turn.startedAt).padding(.leading, 12).padding(.top, 2).frame(width: RoomRippleView.gutter, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                prompt
                outcome
                if !row.meta.isEmpty { Text(verbatim: row.meta).font(.system(size: 12)).foregroundStyle(Theme.subtle) }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }

    private var label: String {
        var parts = [RoomRipples.clock(row.turn.startedAt), row.turn.threadTitle]
        switch row.prompt {
        case .said(let n, let q)?: parts.append("\(n) said \(q)")
        case .answered(let w, let l, let q)?: parts.append("\(w) answered \(l), \(q)")
        case nil: break
        }
        parts.append(row.outcome.text)
        if !row.meta.isEmpty { parts.append(row.meta) }
        return parts.joined(separator: ". ")
    }

    @ViewBuilder private var prompt: some View {
        switch row.prompt {
        case .said(let name, let quote)?:
            HStack(spacing: 6) {
                Text(verbatim: name).foregroundStyle(Theme.muted)
                Text(verbatim: "\u{201C}\(quote)\u{201D}").foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
            }
            .font(.system(size: 13))
        case .answered(let who, let letter, let question)?:
            HStack(spacing: 6) {
                Text(verbatim: who).foregroundStyle(Theme.muted)
                Text("answered").foregroundStyle(Theme.muted)
                Text(verbatim: letter).font(.system(size: 10, weight: .medium, design: .monospaced)).foregroundStyle(Theme.ink)
                    .frame(minWidth: 18, minHeight: 18).background(Theme.selected, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                Text(verbatim: "\u{2014} \(question)").foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
            }
            .font(.system(size: 13))
        case nil: EmptyView()
        }
    }

    @ViewBuilder private var outcome: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            switch row.outcome.mark {
            case .working: WorkingGlyph(slot: TideGlyph.Grid.mark.size.width, alignment: .leading, grid: .mark).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
            case .attention: Lucide(.triangleAlert, size: 14, color: Theme.warning).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            case .failed: Lucide(.circleX, size: 14, color: Theme.negative).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            case .none: EmptyView()
            }
            Text(verbatim: row.outcome.text).font(.system(size: 15)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct BubbleView: View {
    let row: RoomRow
    let mine: Bool
    let retry: (String) -> Void
    private var author: RoomAuthor { row.post.author }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            clock(row.post.at).padding(.leading, 12).padding(.top, 2).frame(width: 60, alignment: .leading)
            if mine {
                Spacer(minLength: 120)
                VStack(alignment: .trailing, spacing: 4) {
                    Text("You").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted)
                    bubble.frame(alignment: .trailing)
                    failure
                }
            } else {
                avatar.padding(.trailing, 4)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: RoomPresentation.authorName(author)).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                    bubble
                }
                Spacer(minLength: 120)
            }
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(mine ? "You" : RoomPresentation.authorName(author)): \(row.post.text)")
    }

    private var bubble: some View {
        Text(verbatim: row.post.text).font(.system(size: 14)).foregroundStyle(Theme.ink).textSelection(.enabled)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(mine ? AnyShapeStyle(Theme.selected) : AnyShapeStyle(Theme.surface), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line))
            .opacity(row.pending ? 0.6 : 1)
    }

    @ViewBuilder private var failure: some View {
        if row.failed { Button("Not sent. Retry") { retry(row.id) }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Theme.negative) }
    }

    private var avatar: some View {
        Text(verbatim: RoomPresentation.initials(RoomPresentation.authorName(author))).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Theme.ink).frame(width: 26, height: 26).background(Theme.selectedStrong, in: Circle())
            .accessibilityHidden(true)
    }
}

/// Agent to agent: one dim row, "A → B “…”", with the scope as a chip.
private struct HandoffView: View {
    let handoff: RoomHandoff
    let threads: [RoomThread]

    var body: some View {
        HStack(spacing: 0) {
            clock(handoff.at).padding(.leading, 12).frame(width: RoomRippleView.gutter, alignment: .leading)
            HStack(spacing: 6) {
                Text(verbatim: handoff.fromTitle).foregroundStyle(Theme.muted).lineLimit(1)
                Image(systemName: "arrow.right").font(.system(size: 10)).foregroundStyle(Theme.subtle)
                if let id = handoff.toSessionId { ThreadDuckView(id: id, agent: threads.first { $0.sessionId == id }?.agent, size: 16) }
                if let to = handoff.toTitle { Text(verbatim: to).foregroundStyle(Theme.muted).lineLimit(1) }
                Text(verbatim: "\u{201C}\(handoff.quote)\u{201D}").foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
                    .layoutPriority(-1)
                if let scope = handoff.scope {
                    Text(verbatim: scope).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 6).frame(height: 18).background(Theme.selected, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                }
            }
            .font(.system(size: 13))
            Spacer(minLength: 0)
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(handoff.fromTitle) to \(handoff.toTitle ?? "another thread"): \(handoff.quote)")
    }
}

/// The posts fallback (a host without turns): a thread's working / done / needs line.
private struct EventView: View {
    let row: RoomRow
    let title: String
    let agent: String?

    var body: some View {
        let label = RoomPresentation.kindLabel(row.post)
        HStack(alignment: .top, spacing: 0) {
            clock(row.post.at).padding(.leading, 12).frame(width: RoomRippleView.gutter, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                    if let label {
                        if label.attention { Lucide(.triangleAlert, size: 12, color: Theme.warning) }
                        Text(verbatim: label.text).font(.system(size: 12)).foregroundStyle(Theme.subtle)
                    }
                }
                Text(verbatim: row.post.text).font(.system(size: 14)).foregroundStyle(Theme.ink)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
        .accessibilityElement(children: .combine)
    }
}
