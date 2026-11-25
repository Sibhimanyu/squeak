import AppKit
import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

// The conversation of the pond room as flat rows (RoomFlatRows): the ask card, a duck's offer, hand-off notes, Squeak's quiet
// system line and the working lines. Everything is decided in `RoomMessages` and `RoomRowPlan`.

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
    let reply: ((RoomReply) -> Void)?
    let act: (String, RoomTaskAction, String?) -> Void
    let comment: (String, String) -> Void
    @State private var visible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .environment(\.roomThreads, ducks)
            .environment(\.roomOpenTarget, openTarget)
            .opacity(visible ? 1 : 0)
            .onAppear {
                guard ledger.shouldFade(item.id), !reduceMotion else { return }
                visible = false
                withAnimation(Motion.standard) { visible = true }
            }
    }

    @ViewBuilder private var content: some View {
        switch item {
        case .day(_, let label): RoomDaySeparator(label: label)
        case .unread(let count): RoomUnreadDivider(count: count)
        case .group(let g): RoomGroupView(group: g, ducks: ducks, open: open, openTarget: openTarget, answer: answer, retry: retry, makeJob: makeJob, reply: reply, act: act)
        case .system(let s): RoomSystemView(line: s, act: act, comment: comment, open: PondClick.target(line: s).map { t in { openTarget(t) } }).padding(.vertical, 4)
        }
    }
}

// MARK: Opening a Duck from its avatar or name

extension EnvironmentValues {
    /// The Room's Ducks and the one "open Duck" action (the same the Duck row and the Dashboard use), for any avatar or name.
    @Entry var roomThreads: [RoomThread] = []
    @Entry var roomOpenTarget: (PondOpenTarget) -> Void = { _ in }
}

/// A Duck's avatar and name are one hit target: one pointer-hand click opens its chat; hovering either shows a ring on the
/// avatar and an underline on the name. An off-duty Duck opens too (no duty change). People's avatars use plain views.
struct DuckHitAvatar: View {
    let target: PondOpenTarget
    let name: String
    let hovering: Bool
    let set: (Bool) -> Void
    let avatar: AnyView
    @Environment(\.roomOpenTarget) private var openTarget

    var body: some View {
        Button { openTarget(target) } label: {
            avatar
                .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 1.5).opacity(hovering ? 1 : 0))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().onHover(perform: set)
        .help("Open \(name)'s chat").accessibilityLabel("Open \(name)'s chat").accessibilityAddTraits(.isButton)
    }
}

struct DuckHitName<Label: View>: View {
    let target: PondOpenTarget
    let name: String
    let hovering: Bool
    let set: (Bool) -> Void
    @ViewBuilder let label: () -> Label
    @Environment(\.roomOpenTarget) private var openTarget

    var body: some View {
        Button { openTarget(target) } label: { label().underline(hovering, color: Theme.muted).contentShape(Rectangle()) }
            .buttonStyle(.plain).pointerHand().onHover(perform: set)
            .help("Open \(name)'s chat").accessibilityLabel("Open \(name)'s chat").accessibilityAddTraits(.isButton)
    }
}

extension EnvironmentValues {
    /// The pond's directory id, for the colour of my own line.
    @Entry var roomPondId: String?
}

/// "7 files . 4m 20s >": opens the duck's tab.
struct FilesChip: View {
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
struct DucklingsDisclosure: View {
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

/// The duck's question, the "needs you" state: an amber triangle and label, a 3 pt amber edge, lettered options, a field for the person's own words.
struct AskCardView: View {
    let card: RoomAskCard
    let answer: (String, String) -> Void
    let open: (String) -> Void
    @State private var text = ""
    @State private var sent = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Lucide(.triangleAlert, size: 13, color: Theme.warning)
                Text(verbatim: "\(card.name) needs your answer").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
            }
            .padding(.bottom, 6)
            Text(verbatim: card.question).font(.system(size: 14)).lineSpacing(3).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
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
struct OfferView: View {
    let offer: RoomOffer
    let ducks: [RoomThread]
    let act: (String, RoomTaskAction, String?) -> Void

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
            if let c = offer.place, offer.note == nil { RoomPlaceChipView(jobId: offer.jobId, chip: c) }
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
    let act: (String, RoomTaskAction, String?) -> Void
    let comment: (String, String) -> Void
    /// A handoff line opens the duck it went to.
    var open: (() -> Void)?

    @State private var showEarlier = false

    var body: some View {
        if line.earlier.isEmpty { single }
        else {
            // A folded run: one row above the latest line ("Show 4 earlier from Ruby 2"), lined up with the names, that opens
            // the run's older lines right under it. The row never moves and nothing already drawn is replaced (ids are the lines' own).
            VStack(alignment: .leading, spacing: 8) {
                // One compact centred line for the run ("Ruby 2 \u{00B7} 4 updates"); it opens in place, below, pushing nothing up.
                let foldLabel = RoomMoment.foldLabel(name: RoomFold.owner(of: line) ?? "Duck", updates: line.earlier.count + 1)
                Button { showEarlier.toggle() } label: {
                    HStack(spacing: 4) {
                        Text(verbatim: foldLabel).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Theme.subtle)
                            .rotationEffect(.degrees(showEarlier ? 90 : 0))
                    }
                    .frame(maxWidth: .infinity, minHeight: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand()
                .accessibilityLabel(foldLabel + (showEarlier ? ", open" : ", closed"))
                if showEarlier {
                    ForEach(line.earlier) { e in RoomSystemView(line: e, act: act, comment: comment, open: open) }
                }
                single
            }
        }
    }

    @ViewBuilder private var single: some View {
        if let h = line.handoff { RoomHandoffCard(note: h, at: line.at, open: open) }
        else if let st = line.status { RoomStatusLineView(status: st, at: line.at, comment: comment, open: open) }
        else if let t = line.task { RoomTaskCardView(card: t, at: line.at, act: act, open: open) }
        else { quiet }
    }

    private var quiet: some View {
        VStack(spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: line.text).font(.system(size: 12)).foregroundStyle(Theme.subtle)
                    .onTapGesture { open?() }.pointerHand(open != nil)
                if let n = line.note { Text(verbatim: n).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                if let id = line.jobId, let c = line.place, line.note == nil { RoomPlaceChipView(jobId: id, chip: c) }
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

/// The one row every Duck-side line of the Room uses (a Duck's note to another Duck, a plan card): the same flat row as a
/// message (`RoomRow`), with the name line "Ivy \u{2192} Kit" for a hand-off. The text shows in full; only an unusually long one
/// ends with "Open in <name>'s chat".
struct RoomEventRow<Extra: View>: View {
    let avatar: AnyView
    let name: String
    /// A handoff's receiver ("Quill 2 \u{2192} Dot 2").
    var to: String?
    /// What the Duck did, quietly after the name ("posted a plan").
    var verb: String?
    let at: Int64
    let text: String
    /// Hand-off notes read quieter than messages.
    var quiet = false
    var open: (() -> Void)?
    /// The Ducks the avatar and name (and the "\u{2192} receiver") open.
    var senderTarget: PondOpenTarget?
    var receiverTarget: PondOpenTarget?
    @ViewBuilder var extra: () -> Extra
    @State private var hoverSender = false
    @State private var hoverReceiver = false

    var body: some View {
        RoomRow(
            first: true, avatar: { avatarView }, at: at, tap: open,
            header: { RoomNameLine(tag: nil, at: at) { headlineView } },
            content: {
                if !text.isEmpty { RoomRowBody(text: text, name: name, muted: quiet, open: open) }
                extra()
            })
        .padding(.top, CGFloat(RoomRowPlan.groupLead))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var avatarView: some View {
        if let senderTarget {
            DuckHitAvatar(target: senderTarget, name: name, hovering: hoverSender, set: { hoverSender = $0 }, avatar: avatar)
        } else { avatar }
    }

    private var nameFont: Font { .system(size: CGFloat(RoomRowPlan.nameSize), weight: .bold) }

    /// "Sage 2 \u{2192} Dot 2": the sender and the receiver each open their own Duck; a status line's name opens its Duck.
    @ViewBuilder private var headlineView: some View {
        HStack(spacing: 0) {
            if let senderTarget {
                DuckHitName(target: senderTarget, name: name, hovering: hoverSender, set: { hoverSender = $0 }) {
                    Text(verbatim: name).font(nameFont).foregroundStyle(Theme.ink)
                }
            } else {
                Text(verbatim: name).font(nameFont).foregroundStyle(Theme.ink)
            }
            if let to {
                Text(verbatim: " \u{2192} ").font(nameFont).foregroundStyle(Theme.muted)
                if let receiverTarget {
                    DuckHitName(target: receiverTarget, name: to, hovering: hoverReceiver, set: { hoverReceiver = $0 }) {
                        Text(verbatim: to).font(nameFont).foregroundStyle(Theme.ink)
                    }
                } else { Text(verbatim: to).font(nameFont).foregroundStyle(Theme.ink) }
            }
            if let verb { Text(verbatim: " \(verb)").font(.system(size: 13)).foregroundStyle(Theme.muted) }
        }
        .lineLimit(1)
    }
}

extension RoomEventRow where Extra == EmptyView {
    init(avatar: AnyView, name: String, to: String? = nil, verb: String? = nil, at: Int64, text: String, quiet: Bool = false, open: (() -> Void)? = nil,
         senderTarget: PondOpenTarget? = nil, receiverTarget: PondOpenTarget? = nil) {
        self.init(avatar: avatar, name: name, to: to, verb: verb, at: at, text: text, quiet: quiet, open: open,
                  senderTarget: senderTarget, receiverTarget: receiverTarget, extra: { EmptyView() })
    }
}

/// A duck's note to another duck.
private struct RoomHandoffCard: View {
    let note: RoomHandoff
    let at: Int64
    var open: (() -> Void)?
    @Environment(\.roomThreads) private var threads

    var body: some View {
        RoomEventRow(
            avatar: AnyView(Group { if let id = note.fromSessionId { DuckAvatar(sessionId: id, agent: note.agent) } else { PersonAvatar(name: note.from) } }),
            name: note.from, to: note.to ?? "another duck", at: at, text: note.body, quiet: true, open: open,
            senderTarget: PondClick.sender(of: note, threads: threads), receiverTarget: PondClick.receiver(of: note, threads: threads))
    }
}

extension EnvironmentValues {
    /// The Room is a Member's (a view-only copy of the Owner's).
    @Entry var roomMemberView = false
    /// Opens a canvas card from the Room: the canvas for the Owner, its view-only bundle for a Member.
    @Entry var roomOpenCanvas: (RoomCanvasCard) -> Void = { _ in }
}

/// A canvas the Task made, under the done line: title, kind and artboard count; a tap opens it.
struct RoomCanvasCardView: View {
    let card: RoomCanvasCard
    let memberView: Bool
    @Environment(\.roomOpenCanvas) private var openCanvas
    @State private var hovering = false

    var body: some View {
        Button { openCanvas(card) } label: {
            HStack(spacing: 10) {
                Lucide(.layers, size: 16, color: Theme.muted).frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: card.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(verbatim: card.subtitle + (memberView ? " \u{00B7} View only" : "")).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: 360, alignment: .leading)
            .background(hovering ? Theme.selected : Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().onHover { hovering = $0 }
        .accessibilityLabel("Open canvas \(card.title)\(memberView ? ", view only" : "")")
    }
}

/// A duck's state change ("Pip finished"): the same row as a note; a plan card opens its spec inline.
private struct RoomStatusLineView: View {
    let status: RoomStatusLine
    let at: Int64
    let comment: (String, String) -> Void
    var open: (() -> Void)?
    @State private var disclosure = RoomDisclosure()
    @State private var draft = ""
    @State private var sent = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.roomMemberView) private var memberView

    @Environment(\.roomThreads) private var threads
    @Environment(\.roomOpenTarget) private var openTarget
    @State private var hover = false

    var body: some View {
        if status.kind == .plan { planCard } else { moment }
    }

    /// A moment is not chat: one compact centred line, a small duck glyph then "Ruby 2 finished \u{00B7} summary" in muted 12pt.
    /// A tap opens that Duck (an off-duty one too). A canvas or a longer detail sits quietly under it.
    private var moment: some View {
        let target = PondClick.target(status: status, threads: threads)
        let text = RoomMoment.line(name: status.name, verb: status.verb, summary: status.summary)
        return VStack(spacing: 4) {
            Button { if let target { openTarget(target) } } label: {
                HStack(spacing: 6) {
                    if let id = status.sessionId { ThreadDuckView(id: id, agent: status.agent, size: 14) }
                    Text(verbatim: text).font(.system(size: 12)).foregroundStyle(status.kind == .blocked ? Theme.negative : Theme.muted)
                        .lineLimit(1).truncationMode(.tail).underline(hover && target != nil, color: Theme.muted)
                }
                .frame(maxWidth: .infinity, minHeight: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerHand(target != nil).onHover { hover = $0 }
            .help(target != nil ? "Open \(status.name)'s chat" : "").accessibilityLabel(text + (target != nil ? ". Opens \(status.name)'s chat" : ""))
            ForEach(status.canvases) { RoomCanvasCardView(card: $0, memberView: memberView) }
            if status.isExpandable {
                Button { withAnimation(reduceMotion ? nil : Motion.standard) { disclosure.toggle() } } label: {
                    Text(disclosure.isOpen ? "Hide detail" : "Show detail").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(minHeight: 22).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand()
            }
            if disclosure.isOpen, let d = status.detail {
                MessageText(markdown: d, style: .reading).frame(maxWidth: 640, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var planCard: some View {
        RoomEventRow(
            avatar: AnyView(Group { if let id = status.sessionId { DuckAvatar(sessionId: id, agent: status.agent) } else { Color.clear.frame(width: CGFloat(RoomRowPlan.avatar), height: CGFloat(RoomRowPlan.avatar)) } }),
            name: status.name, verb: status.verb,
            at: at, text: status.summary, open: open, senderTarget: PondClick.target(status: status, threads: threads)
        ) {
            ForEach(status.canvases) { RoomCanvasCardView(card: $0, memberView: memberView) }
            if status.isExpandable {
                Button { withAnimation(reduceMotion ? nil : Motion.standard) { disclosure.toggle() } } label: {
                    Text(disclosure.isOpen ? "Hide detail" : "Show detail").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(minHeight: 22).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand()
            }
            if disclosure.isOpen, let d = status.detail {
                MessageText(markdown: d, style: .reading).frame(maxWidth: 640, alignment: .leading)
                if let card = status.commentTarget { commentBox(card) }
            }
        }
        .padding(.vertical, 2)
    }
}

extension RoomStatusLineView {
    /// Steer the duck before it goes far: the host hands the comment to it at its next turn.
    fileprivate func commentBox(_ card: String) -> some View {
        HStack(spacing: 8) {
            TextField("Comment on this plan", text: $draft).textFieldStyle(.plain).font(.system(size: 13))
                .padding(.horizontal, 10).frame(height: 30)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.line))
                .onSubmit { submit(card) }
            Button(sent ? "Sent" : "Comment") { submit(card) }
                .buttonStyle(SmallButtonStyle(role: .secondary))
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .frame(maxWidth: 640, alignment: .leading)
    }

    fileprivate func submit(_ card: String) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        comment(card, text); draft = ""; sent = true
    }
}

// MARK: Working

/// "Pip is working . updating the layout builder . 3 of 5": no bubble.
struct RoomWorkingRow: View {
    let line: RoomWorkingLine
    let open: (String) -> Void

    var body: some View {
        HStack(spacing: CGFloat(RoomRowPlan.gutterGap)) {
            Button { open(line.sessionId) } label: { DuckAvatar(sessionId: line.sessionId, agent: line.agent) }.buttonStyle(.plain).pointerHand().help("Open \(line.name)'s chat").accessibilityLabel("Open \(line.name)'s chat")
            WorkingGlyph(slot: TideGlyph.Grid.mark.size.width, alignment: .leading, grid: .mark)
            (Text(verbatim: line.name).fontWeight(.semibold).foregroundStyle(Theme.ink)
                + Text(verbatim: " is working" + (line.detail.map { " \u{00B7} " + $0 } ?? "")).foregroundStyle(Theme.muted))
                .font(.system(size: 13)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .accessibilityElement(children: .ignore).accessibilityLabel(line.spoken)
    }
}
