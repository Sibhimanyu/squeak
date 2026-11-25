import AppKit
import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

// DESIGN.md 8.12, the Room as flat rows (Slack or Cliq style; mock-up direction B): avatar, bold name, muted time, the text on
// the page with no box. A run by one sender sits under one name; a row lights up on hover with a quiet bar under its text; your own
// are marked only by a thin Pond-coloured line. Every number and word is decided in `RoomRowPlan`; this only places them.

/// One row of the Room. Layout never depends on hover: the highlight is a background, the bar an overlay, and the time of a
/// continuation row is always in its gutter (only its opacity changes), so a row never changes height or width as the pointer
/// passes.
struct RoomRow<Avatar: View, Header: View, Content: View>: View {
    /// The first row of a group carries the avatar and the name line; the rest of the run shows its text only.
    let first: Bool
    @ViewBuilder let avatar: () -> Avatar
    let at: Int64
    var own = false
    var actions: [RoomRowPlan.Action] = []
    var perform: (RoomRowPlan.Action) -> Void = { _ in }
    var tap: (() -> Void)?
    @ViewBuilder var header: () -> Header
    @ViewBuilder var content: () -> Content
    @State private var rowHover = false
    @State private var barHover = false
    @State private var copied = false
    @FocusState private var barFocus: Bool
    @Environment(\.roomPondId) private var pondId

    private var hover: Bool { rowHover || barHover }

    var body: some View {
        HStack(alignment: .top, spacing: CGFloat(RoomRowPlan.gutterGap)) {
            ZStack(alignment: .top) {
                if first {
                    avatar()
                } else {
                    Text(verbatim: RoomRipples.clock(at)).font(.system(size: CGFloat(RoomRowPlan.timeSize))).monospacedDigit()
                        .foregroundStyle(Theme.subtle).opacity(rowHover ? 1 : 0).padding(.top, 4).accessibilityHidden(true)
                }
            }
            .frame(width: CGFloat(RoomRowPlan.avatar), alignment: .top)
            VStack(alignment: .leading, spacing: 1) {
                if first { header() }
                content()
                // The bar's own row: its height is always reserved (only its opacity changes), so the feed never changes
                // height as the pointer passes and the bar never covers the text above it.
                if !actions.isEmpty {
                    RoomHoverBar(actions: actions, copied: copied, perform: { a in
                        if a == .copy { copied = true; Task { try? await Task.sleep(for: .seconds(1.2)); copied = false } }
                        perform(a)
                    })
                    .onHover { barHover = $0 }
                    .focused($barFocus)
                    .opacity(RoomRowPlan.barOpacity(hover: hover, focusWithin: barFocus))
                    .allowsHitTesting(hover || barFocus)
                    .frame(height: CGFloat(RoomRowPlan.barHeight), alignment: .leading)
                    .padding(.top, CGFloat(RoomRowPlan.barGap))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.top, first ? 6 : CGFloat(RoomRowPlan.rowPad)).padding(.bottom, CGFloat(RoomRowPlan.rowPad))
        .background(RoundedRectangle(cornerRadius: CGFloat(RoomRowPlan.rowRadius), style: .continuous).fill(hover ? Theme.selected : Color.clear))
        .contentShape(Rectangle())
        .onTapGesture { tap?() }
        .overlay(alignment: .leading) {
            if own {
                Capsule().fill(PondColour.pondAccent(pondId, fallback: PondColour.tint(pondId)).opacity(0.85))
                    .frame(width: CGFloat(RoomRowPlan.ownLineWidth)).padding(.vertical, 3).padding(.top, first ? 4 : 0)
                    .accessibilityHidden(true)
            }
        }
        .onHover { rowHover = $0 }
        .animation(Motion.quick, value: hover)
    }
}

/// Reply, Copy, Make task: a quiet row of small buttons under the row's text, left-aligned with it. No box, no shadow.
struct RoomHoverBar: View {
    let actions: [RoomRowPlan.Action]
    let copied: Bool
    let perform: (RoomRowPlan.Action) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(actions, id: \.self) { a in RoomHoverButton(action: a, copied: copied && a == .copy, perform: perform) }
        }
        .fixedSize()
        .accessibilityElement(children: .contain)
    }
}

private struct RoomHoverButton: View {
    let action: RoomRowPlan.Action
    let copied: Bool
    let perform: (RoomRowPlan.Action) -> Void
    @State private var hover = false

    private var symbol: String {
        switch action {
        case .reply: "arrowshape.turn.up.left"
        case .copy: copied ? "checkmark" : "doc.on.doc"
        case .makeTask: "checkmark"
        }
    }

    var body: some View {
        Button { perform(action) } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 11, weight: .medium))
                Text(verbatim: copied ? "Copied" : action.rawValue).font(.system(size: 12, weight: .medium)).lineLimit(1).fixedSize()
            }
            .foregroundStyle(hover ? Theme.ink : Theme.muted)
            .padding(.horizontal, 6).frame(height: 24)
            .background(hover ? Theme.selectedStrong : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().onHover { hover = $0 }
        .help(action == .makeTask ? "Hand this message to a Duck as a Task" : action.rawValue)
        .accessibilityLabel(action.rawValue)
    }
}

/// The words of a row, in full as Markdown (lists and code blocks laid out by the same reader the chat uses). An unusually long
/// one ends after about twelve lines with "Open in <name>'s chat". The cut is computed from the text (`RoomRowPlan.clip`),
/// never measured, so a row is the same height from its first draw.
struct RoomRowBody: View {
    let text: String
    var name: String = ""
    var muted = false
    var open: (() -> Void)?
    @State private var hover = false

    var body: some View {
        let clip = RoomRowPlan.clip(text)
        VStack(alignment: .leading, spacing: 6) {
            MessageText(markdown: clip.shown, style: muted ? Self.mutedStyle : .reading)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if clip.clipped, let open {
                Button(action: open) {
                    HStack(spacing: 4) {
                        Text(verbatim: RoomRowPlan.openLabel(name: name)).font(.system(size: 12, weight: .medium))
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                    }
                    .foregroundStyle(hover ? Theme.ink : Theme.muted).frame(minHeight: 22).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand().onHover { hover = $0 }
                .accessibilityLabel(RoomRowPlan.openLabel(name: name))
            }
        }
    }

    private static var mutedStyle: MessageStyle {
        var s = MessageStyle.reading
        s.ink = Theme.muted
        return s
    }
}

/// The name line of a row: bold name, a small tag, the muted time.
struct RoomNameLine<Name: View>: View {
    let tag: String?
    let at: Int64
    var mark: String?
    @ViewBuilder var name: () -> Name

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            name()
            if let tag { Text(verbatim: tag).font(.system(size: CGFloat(RoomRowPlan.timeSize))).foregroundStyle(Theme.subtle) }
            Text(verbatim: RoomRipples.clock(at)).font(.system(size: CGFloat(RoomRowPlan.timeSize) + 1)).monospacedDigit().foregroundStyle(Theme.subtle)
            if let mark { Text(verbatim: "\u{00B7} \(mark)").font(.system(size: CGFloat(RoomRowPlan.timeSize))).foregroundStyle(Theme.subtle) }
        }
        .lineLimit(1)
        .padding(.bottom, 1)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Separators

/// A day: a hairline either side of a quiet label.
struct RoomDaySeparator: View {
    let label: String

    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Theme.line).frame(height: 1)
            Text(verbatim: label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.subtle).fixedSize()
            Rectangle().fill(Theme.line).frame(height: 1)
        }
        .padding(.horizontal, 12).padding(.top, 18).padding(.bottom, 8)
        .accessibilityElement(children: .ignore).accessibilityLabel(label).accessibilityAddTraits(.isHeader)
    }
}

/// "3 new" in the duck's yellow, once.
struct RoomUnreadDivider: View {
    let count: Int

    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Theme.duck.opacity(0.45)).frame(height: 1)
            Text(verbatim: RoomUnread.label(count)).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.duck).fixedSize()
        }
        .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 6)
        .accessibilityElement(children: .ignore).accessibilityLabel(RoomUnread.label(count))
    }
}

// MARK: Groups

/// One sender's run of messages (within five minutes of each other): the first row has the avatar and name, the others only
/// their text. Tapping a row, the avatar or the name opens that Duck's chat at the turn the message came from.
struct RoomGroupView: View {
    let group: RoomMessageGroup
    let ducks: [RoomThread]
    let open: (String) -> Void
    let openTarget: (PondOpenTarget) -> Void
    let answer: (String, String) -> Void
    let retry: (String) -> Void
    let makeJob: (String) -> Void
    let reply: ((RoomReply) -> Void)?
    let act: (String, RoomTaskAction, String?) -> Void

    @State private var hoverDuck = false
    @Environment(\.roomThreads) private var threads

    private var own: Bool { RoomRowPlan.isOwn(group.author) }
    private var displayName: String {
        guard own else { return group.author.name }
        let n = NSFullUserName().trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? group.author.name : n
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(group.messages.enumerated()), id: \.element.id) { i, m in
                messageRow(m, first: RoomRowPlan.showsHeader(index: i))
                    .padding(.top, i == 0 ? CGFloat(RoomRowPlan.groupLead) : 0)
            }
        }
    }

    private func opener(_ target: PondOpenTarget?) -> (() -> Void)? { target.map { t in { openTarget(t) } } }

    /// Where the group's avatar and name lead: the first message's chat and turn.
    private var groupTarget: PondOpenTarget? { group.messages.first.flatMap { PondClick.target(message: $0) } }

    private func plainText(_ m: RoomMessage) -> String {
        m.parts.compactMap { if case .text(let t, _) = $0 { t } else { nil } }.joined(separator: "\n\n")
    }

    private func messageRow(_ m: RoomMessage, first: Bool) -> some View {
        let text = plainText(m)
        let actions = RoomRowPlan.actions(for: m, text: text, canReply: reply != nil)
        return RoomRow(
            first: first, avatar: { avatar }, at: m.at, own: own, actions: actions,
            perform: { a in perform(a, message: m, text: text) }, tap: opener(PondClick.target(message: m)),
            header: { header(m) },
            content: {
                ForEach(Array(m.parts.enumerated()), id: \.offset) { _, part in partView(m, part) }
                if !m.attachments.isEmpty { RoomAttachmentsView(attachments: m.attachments, pending: m.pending).padding(.top, 4) }
                if own, let words = RoomRowPlan.words(RoomRowPlan.ownState(pending: m.pending, failed: m.failed)) {
                    HStack(spacing: 6) {
                        Text(verbatim: words).font(.system(size: 11)).foregroundStyle(m.failed ? Theme.negative : Theme.subtle)
                        if m.failed { Button("Retry") { retry(m.id) }.buttonStyle(.plain).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.negative).pointerHand() }
                    }
                    .padding(.top, 2)
                }
            })
        .opacity(m.pending ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(displayName): \(text)")
        .accessibilityActions {
            if actions.contains(.reply), let r = RoomRowPlan.reply(to: m.author, quoting: text), let reply { Button("Reply") { reply(r) } }
            if actions.contains(.makeTask), let id = m.postId { Button("Make task") { makeJob(id) } }
        }
    }

    private func perform(_ a: RoomRowPlan.Action, message m: RoomMessage, text: String) {
        switch a {
        case .reply: if let r = RoomRowPlan.reply(to: m.author, quoting: text) { reply?(r) }
        case .copy: NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        case .makeTask: if let id = m.postId { makeJob(id) }
        }
    }

    // MARK: Avatar and name

    @ViewBuilder private var avatar: some View {
        let a = group.author
        if a.kind == .duck, let id = a.sessionId, let t = groupTarget {
            DuckHitAvatar(target: t, name: a.name, hovering: hoverDuck, set: { hoverDuck = $0 }, avatar: AnyView(DuckAvatar(sessionId: id, agent: a.agent)))
        } else if let t = groupTarget {
            // A person's avatar opens the Duck their message went to.
            Button { openTarget(t) } label: { PersonAvatar(name: displayName) }.buttonStyle(.plain).pointerHand().help("Open the Duck it went to")
        } else {
            PersonAvatar(name: displayName)
        }
    }

    private func header(_ m: RoomMessage) -> some View {
        let a = group.author
        let tag: String? = a.kind == .duck ? (a.agentLabel ?? "Duck") : (own ? "you" : nil)
        return RoomNameLine(tag: tag, at: group.at, mark: RoomRowPlan.fallbackMark(for: m)) { nameText }
    }

    @ViewBuilder private var nameText: some View {
        let a = group.author
        let label = Text(verbatim: displayName).font(.system(size: CGFloat(RoomRowPlan.nameSize), weight: .bold)).foregroundStyle(Theme.ink)
        if a.kind == .duck, let t = groupTarget {
            DuckHitName(target: t, name: a.name, hovering: hoverDuck, set: { hoverDuck = $0 }) { label }
        } else {
            label
        }
    }

    // MARK: Parts

    @ViewBuilder private func partView(_ m: RoomMessage, _ part: RoomPart) -> some View {
        switch part {
        case .text(let t, let tone):
            RoomTextPart(text: t, tone: tone, name: group.author.name, open: group.author.kind == .duck ? opener(PondClick.target(part: part, in: m)) : nil)
        case .chip(let sid, let text): FilesChip(text: text) { open(sid) }.padding(.top, 5)
        case .ducklings(let d):
            DucklingsDisclosure(ducklings: d, openAll: opener(PondClick.target(part: part, in: m)),
                                openOne: { item in m.author.sessionId.map { id in { openTarget(PondClick.target(duckling: item, of: id)) } } })
        case .ask(let card): AskCardView(card: card, answer: answer, open: open).padding(.top, 6)
        case .offer(let o): OfferView(offer: o, ducks: ducks, act: act).padding(.top, 6)
        }
    }
}

/// A message's words. An attention line (a Duck waiting on you) or a failed one wears its mark in front.
private struct RoomTextPart: View {
    let text: String
    let tone: RoomPart.Tone
    let name: String
    let open: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            switch tone {
            case .attention: Lucide(.triangleAlert, size: 14, color: Theme.warning).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            case .failed: Lucide(.circleX, size: 14, color: Theme.negative).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            case .normal: EmptyView()
            }
            RoomRowBody(text: text, name: name, open: open)
        }
    }
}
