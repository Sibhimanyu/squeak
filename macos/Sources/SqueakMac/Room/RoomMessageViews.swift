import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The conversation of the pond room (draft A): groups of bubbles, a duck's reply with its chip and ducklings, the ask
// card, a duck's offer, Squeak's quiet system line and the working lines. Everything is decided in `RoomMessages`.

/// A duck's avatar: its thread duck on a soft tile of its own colour, the agent badge at the corner.
struct DuckAvatar: View {
    let sessionId: String
    var agent: String?
    var size: CGFloat = 36
    var off = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = ThreadDuck.rgb(for: sessionId, dark: scheme == .dark)
        let colour = Color(red: c.r, green: c.g, blue: c.b)
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(Theme.surfaceRaised.opacity(1))
            .overlay(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(colour.opacity(0.15)))
            .frame(width: size, height: size)
            .overlay { ThreadDuckView(id: sessionId, agent: agent, size: size * 0.72) }
            .opacity(off ? 0.4 : 1).saturation(off ? 0.3 : 1)
            .accessibilityHidden(true)
    }
}

/// A person's avatar: initials on a soft tile.
struct PersonAvatar: View {
    let name: String
    var size: CGFloat = 36
    var body: some View {
        Text(verbatim: RoomPresentation.initials(name)).font(.system(size: size * 0.34, weight: .semibold)).foregroundStyle(Theme.muted)
            .frame(width: size, height: size).background(Theme.selectedStrong, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct RoomItemView: View {
    let item: RoomItem
    let ducks: [RoomThread]
    let ledger: RoomFadeLedger
    let open: (String) -> Void
    let openTarget: (PondOpenTarget) -> Void
    let answer: (String, String) -> Void
    let retry: (String) -> Void
    let makeJob: (String) -> Void
    let act: (String, RoomJobAction, String?) -> Void
    @State private var visible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .opacity(visible ? 1 : 0)
            .onAppear {
                guard ledger.shouldFade(item.id), !reduceMotion else { return }
                visible = false
                withAnimation(Motion.standard) { visible = true }
            }
    }

    @ViewBuilder private var content: some View {
        switch item {
        case .day(_, let label):
            Text(verbatim: label).font(.system(size: 11)).foregroundStyle(Theme.subtle).frame(maxWidth: .infinity)
                .padding(.vertical, 2).accessibilityAddTraits(.isHeader)
        case .group(let g): RoomGroupView(group: g, ducks: ducks, open: open, openTarget: openTarget, answer: answer, retry: retry, makeJob: makeJob, act: act)
        case .system(let s): RoomSystemView(line: s, act: act, open: PondClick.target(line: s).map { t in { openTarget(t) } })
        }
    }
}

// MARK: Groups

private struct RoomGroupView: View {
    let group: RoomMessageGroup
    let ducks: [RoomThread]
    let open: (String) -> Void
    let openTarget: (PondOpenTarget) -> Void
    let answer: (String, String) -> Void
    let retry: (String) -> Void
    let makeJob: (String) -> Void
    let act: (String, RoomJobAction, String?) -> Void

    var body: some View {
        if group.author.kind == .me { mine } else { theirs }
    }

    private var mine: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 96)
            VStack(alignment: .trailing, spacing: 3) {
                ForEach(group.messages) { m in
                    ForEach(Array(m.parts.enumerated()), id: \.offset) { _, part in
                        if case .text(let t, _) = part {
                            MessageBubble(message: m, text: t, tone: .normal, mine: true, first: false, retry: retry, makeJob: makeJob, open: opener(PondClick.target(message: m)))
                        }
                    }
                    if !m.attachments.isEmpty { RoomAttachmentsView(attachments: m.attachments, pending: m.pending, alignment: .trailing) }
                }
                Text(verbatim: RoomRipples.clock(group.lastAt)).font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.subtle).padding(.top, 2)
            }
        }
    }

    private var theirs: some View {
        HStack(alignment: .top, spacing: 11) {
            avatar
            VStack(alignment: .leading, spacing: 3) {
                header
                ForEach(Array(group.messages.enumerated()), id: \.element.id) { i, m in
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(m.parts.enumerated()), id: \.offset) { j, part in
                            partView(m, part, first: i == 0 && j == 0)
                        }
                        if !m.attachments.isEmpty { RoomAttachmentsView(attachments: m.attachments, pending: m.pending) }
                    }
                }
            }
            Spacer(minLength: 60)
        }
    }

    /// What clicking this group's avatar or name opens: a duck, or the duck a person's first message went to.
    private var groupTarget: PondOpenTarget? { PondClick.target(author: group.author, goesTo: group.messages.compactMap(\.goesTo).first) }

    private func opener(_ target: PondOpenTarget?) -> (() -> Void)? { target.map { t in { openTarget(t) } } }

    @ViewBuilder private var avatar: some View {
        let a = group.author
        if let t = groupTarget {
            Button { openTarget(t) } label: {
                if a.kind == .duck, let id = a.sessionId { DuckAvatar(sessionId: id, agent: a.agent) } else { PersonAvatar(name: a.name) }
            }
            .buttonStyle(.plain).pointerHand().help("Open \(a.kind == .duck ? a.name : "the duck it went to")")
        } else if a.kind == .duck, let id = a.sessionId {
            Button { open(id) } label: { DuckAvatar(sessionId: id, agent: a.agent) }.buttonStyle(.plain).help("Open \(a.name)")
        } else {
            PersonAvatar(name: a.name)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            nameText
            if let l = group.author.agentLabel { Text(verbatim: l).font(.system(size: 12)).foregroundStyle(Theme.muted) }
            Text(verbatim: RoomRipples.clock(group.at)).font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.subtle)
        }
        .padding(.bottom, 1)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var nameText: some View {
        let name = Text(verbatim: group.author.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
        if let t = groupTarget { Button { openTarget(t) } label: { name }.buttonStyle(.plain).pointerHand().help("Open") } else { name }
    }

    @ViewBuilder private func partView(_ m: RoomMessage, _ part: RoomPart, first: Bool) -> some View {
        switch part {
        case .text(let t, let tone): MessageBubble(message: m, text: t, tone: tone, mine: false, first: first, retry: retry, makeJob: makeJob, open: opener(PondClick.target(part: part, in: m)))
        case .chip(let sid, let text): FilesChip(text: text) { open(sid) }.padding(.top, 5)
        case .ducklings(let d):
            DucklingsDisclosure(ducklings: d, openAll: opener(PondClick.target(part: part, in: m)),
                                openOne: { item in m.author.sessionId.map { id in { openTarget(PondClick.target(duckling: item, of: id)) } } })
        case .ask(let card): AskCardView(card: card, answer: answer, open: open)
        case .offer(let o): OfferView(offer: o, ducks: ducks, act: act)
        }
    }
}

/// One bubble. The first of a group has a square top-left corner; mine are filled and borderless.
private struct MessageBubble: View {
    let message: RoomMessage
    let text: String
    let tone: RoomPart.Tone
    let mine: Bool
    let first: Bool
    let retry: (String) -> Void
    let makeJob: (String) -> Void
    /// Opens the tab this bubble belongs to (the duck, or the duck a person's message went to); nil opens nothing.
    var open: (() -> Void)?
    @State private var hover = false

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                switch tone {
                case .attention: Lucide(.triangleAlert, size: 14, color: Theme.warning).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                case .failed: Lucide(.circleX, size: 14, color: Theme.negative).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                case .normal: EmptyView()
                }
                Text(verbatim: text).font(.system(size: 14)).lineSpacing(3).foregroundStyle(Theme.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 13).padding(.vertical, 8)
            .background(mine ? Theme.selectedStrong : Theme.surface, in: shape)
            .overlay { if !mine { shape.strokeBorder(Theme.line) } }
            .frame(maxWidth: 640, alignment: mine ? .trailing : .leading)
            .opacity(message.pending ? 0.6 : 1)
            .onTapGesture { open?() }
            .pointerHand(open != nil)
            .contextMenu {
                if message.canMakeJob, let id = message.postId { Button("Make this a job") { makeJob(id) } }
                Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
            }
            if message.failed { Button("Not sent. Retry") { retry(message.id) }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Theme.negative) }
            if message.canMakeJob, let id = message.postId {
                // Hover affordance; its height is reserved so the row never jumps.
                Button("Make this a job") { makeJob(id) }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Theme.muted)
                    .opacity(hover ? 1 : 0).allowsHitTesting(hover)
            }
        }
        .onHover { hover = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(mine ? "You" : message.author.name): \(text)")
    }

    private var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: first && !mine ? 4 : 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous)
    }
}

/// "7 files . 4m 20s >": opens the duck's tab.
private struct FilesChip: View {
    let text: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                ForEach(Array(text.components(separatedBy: " \u{00B7} ").enumerated()), id: \.offset) { i, part in
                    if i > 0 { Text(verbatim: "\u{00B7}").opacity(0.5) }
                    Image(systemName: part.contains("file") ? "doc" : "clock").font(.system(size: 11))
                    Text(verbatim: part).monospacedDigit()
                }
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.subtle).padding(.leading, 2)
            }
            .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.leading, 8).padding(.trailing, 9).frame(height: 22)
            .background(hover ? Theme.selectedStrong : Theme.selected, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hover = $0 }
        .help("Open the duck").accessibilityLabel("\(text). Opens the duck")
    }
}

/// "> handed 2 pieces to ducklings": expands to the pieces with their state.
private struct DucklingsDisclosure: View {
    let ducklings: RoomDucklings
    /// Opens the duck and its duckling tabs; each piece opens its own.
    var openAll: (() -> Void)?
    var openOne: (RoomDuckling) -> (() -> Void)? = { _ in nil }
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Button { open.toggle() } label: {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
                        .frame(width: 16, height: 16).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(open ? "Hide the pieces" : "Show the pieces")
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                Button { openAll?() ?? open.toggle() } label: {
                    Text(verbatim: RoomMessages.ducklingsLine(ducklings)).font(.system(size: 12)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand().help("Open the ducklings")
            }
            .foregroundStyle(Theme.subtle)
            if open {
                VStack(alignment: .leading, spacing: 3) {
                    if ducklings.items.isEmpty {
                        Text("\(ducklings.done) of \(ducklings.count) done").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    ForEach(ducklings.items) { d in
                        Button { openOne(d)?() } label: { HStack(spacing: 6) {
                            switch d.state {
                            case .running: WorkingGlyph(slot: TideGlyph.Grid.micro.size.width, alignment: .leading, grid: .micro)
                            case .done: Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.done)
                            case .failed: Lucide(.circleX, size: 12, color: Theme.negative)
                            }
                            Text(verbatim: d.label).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                        }.contentShape(Rectangle()) }
                        .buttonStyle(.plain).pointerHand(openOne(d) != nil).disabled(openOne(d) == nil)
                    }
                }
                .padding(.leading, 14)
            }
        }
        .padding(.top, 6)
    }
}

// MARK: Ask, offer, system

/// The duck's question: warning edge, lettered options, a field for the person's own words.
private struct AskCardView: View {
    let card: RoomAskCard
    let answer: (String, String) -> Void
    let open: (String) -> Void
    @State private var text = ""
    @State private var sent = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: card.question).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            if !card.options.isEmpty {
                VStack(spacing: 6) { ForEach(card.options) { o in OptionRow(option: o, disabled: sent) { send(o.letter) } } }.padding(.top, 10)
            }
            HStack(spacing: 8) {
                TextField("Or tell \(card.name) something else\u{2026}", text: $text).textFieldStyle(.plain).font(.system(size: 14))
                    .onSubmit(sendText).disabled(sent).accessibilityLabel("Your own answer")
                if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button(action: sendText) { Image(systemName: "return").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted).frame(width: 26, height: 22) }
                        .buttonStyle(.plain).accessibilityLabel("Send answer")
                }
            }
            .padding(.horizontal, 11).frame(height: 30)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
            .padding(.top, 8)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: 640, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.warning).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .opacity(sent ? 0.6 : 1)
        .accessibilityElement(children: .contain).accessibilityLabel("\(card.name) asks. \(card.question)")
    }

    private func send(_ s: String) { guard !sent else { return }; sent = true; answer(card.sessionId, s) }
    private func sendText() {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !clean.isEmpty { send(clean) }
    }
}

private struct OptionRow: View {
    let option: RoomAskOption
    let disabled: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Text(verbatim: option.letter).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                    .frame(width: 20, height: 20).background(Theme.selectedStrong, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text(verbatim: option.text).font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if option.recommended { Text("recommended").font(.system(size: 11)).foregroundStyle(Theme.subtle) }
            }
            .padding(.horizontal, 11).padding(.vertical, 6).frame(maxWidth: .infinity)
            .background(hover && !disabled ? Theme.selected : Color.white.opacity(0.02), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(option.recommended ? Theme.lineStrong : Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled).onHover { hover = $0 }
        .accessibilityLabel("\(option.letter). \(option.text)" + (option.recommended ? ", recommended" : ""))
    }
}

/// A duck offering to take a job, or asking to take it after its turn: words, then [Go] [Not now] / [Allow] [No].
private struct OfferView: View {
    let offer: RoomOffer
    let ducks: [RoomThread]
    let act: (String, RoomJobAction, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 14) {
                Text(verbatim: offer.text).font(.system(size: 14)).lineSpacing(3).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if let n = offer.note { Text(verbatim: n).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                HStack(spacing: 6) {
                    ForEach(offer.buttons) { b in
                        if b.id == "go" {
                            HStack(spacing: 0) {
                                Button(b.title) { act(offer.jobId, b.action, nil) }.buttonStyle(SmallButtonStyle(role: .primary))
                                if !offer.candidates.isEmpty { candidates }
                            }
                        } else {
                            Button(b.title) { act(offer.jobId, b.action, nil) }.buttonStyle(SmallButtonStyle(role: b.role))
                        }
                    }
                }
            }
            if let e = offer.error { Text(verbatim: e).font(.system(size: 12)).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(.leading, 14).padding(.trailing, 12).padding(.vertical, 10)
        .frame(maxWidth: 560, alignment: .leading)
        .background(Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain).accessibilityLabel(offer.text)
    }

    /// Pick another duck for the job instead of the suggested one.
    private var candidates: some View {
        Menu {
            ForEach(offer.candidates, id: \.sessionId) { c in
                let name = ducks.first { $0.sessionId == c.sessionId }?.duckName ?? c.title
                Button(name) { act(offer.jobId, .go(sessionId: c.sessionId), name) }
            }
        } label: {
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted).frame(width: 18, height: 24)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("Pick another duck")
    }
}

/// Squeak never speaks as a person: a quiet centred line with its buttons.
private struct RoomSystemView: View {
    let line: RoomSystemLine
    let act: (String, RoomJobAction, String?) -> Void
    /// A handoff line opens the duck it went to.
    var open: (() -> Void)?

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: line.text).font(.system(size: 12)).foregroundStyle(Theme.subtle)
                    .onTapGesture { open?() }.pointerHand(open != nil)
                if let n = line.note { Text(verbatim: n).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                if let id = line.jobId {
                    ForEach(line.buttons) { b in Button(b.title) { act(id, b.action, nil) }.buttonStyle(SmallButtonStyle(role: b.role)) }
                }
            }
            if let e = line.error { Text(verbatim: e).font(.system(size: 12)).foregroundStyle(Theme.negative) }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Working

/// "Pip is working . updating the layout builder . 3 of 5": no bubble.
struct RoomWorkingRow: View {
    let line: RoomWorkingLine
    let open: (String) -> Void

    var body: some View {
        HStack(spacing: 11) {
            Button { open(line.sessionId) } label: { DuckAvatar(sessionId: line.sessionId, agent: line.agent) }.buttonStyle(.plain).help("Open \(line.name)")
            WorkingGlyph(slot: TideGlyph.Grid.mark.size.width, alignment: .leading, grid: .mark)
            (Text(verbatim: line.name).fontWeight(.semibold).foregroundStyle(Theme.ink)
                + Text(verbatim: " is working" + (line.detail.map { " \u{00B7} " + $0 } ?? "")).foregroundStyle(Theme.muted))
                .font(.system(size: 13)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore).accessibilityLabel(line.spoken)
    }
}
