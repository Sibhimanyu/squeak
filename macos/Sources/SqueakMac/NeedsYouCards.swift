import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

// DESIGN.md §8.10 "Cards that need you": one anatomy (surface-raised, radius-card, line border, a 3pt left edge (`warning` for an approval or a plan, `subtle` for a question), no state header: the first row is the card's own title and, at the right, the kind chip), three bodies. They take a simple model and
// closures, so any source can drive them: an action closure that is nil is an action this chat cannot give, and
// its button is not drawn (the card says so instead). Nothing here sends by itself.
//
// Keys (§8.10): the bare ↵ (allow once, approve), ⌫ (deny, keep planning) and 1–9 / 0 (answer, other) come from
// `cardKeys` (CardKeyMonitor.swift), which lets them through only when the composer is empty or focus is not in a
// text field. The ⌘ forms stay real key equivalents: ⌘↵ allows for the whole chat on an approval (⌘↵ or ⌘⇧↵ approves
// a plan), ⌘⌫ denies, ⌘1–9 an option. A bare ↵ typed in the composer while a card waits denies with the typed words
// (SessionDetail). The composer's own ⌘↵ Send is disabled while a card is up, so ⌘↵ is the card's.

/// The shared frame. The amber or grey edge is the only thing that marks "this one is waiting for you" in a long transcript.
struct NeedsYouFrame<Body: View>: View {
    let title: String
    /// The title's second part in `muted` (a plan's own title).
    var titleDetail: String?
    /// The tool name in mono, at the right, when there is one.
    let kind: String?
    /// `warning` for an approval or a plan, `subtle` for a question (§8.10).
    var edge: Color = Theme.warning
    @ViewBuilder var content: () -> Body
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var arrived = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Group {
                    if let titleDetail {
                        Text(verbatim: title).foregroundStyle(Theme.ink) + Text(verbatim: "  \(titleDetail)").foregroundStyle(Theme.muted)
                    } else {
                        Text(verbatim: title).foregroundStyle(Theme.ink)
                    }
                }
                .font(Typo.heading).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if let kind {
                    Text(verbatim: kind).font(Typo.code).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 6).frame(height: 20)
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
                }
            }
            content()
        }
        .padding(.leading, 16).padding(.trailing, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(alignment: .leading) { Rectangle().fill(edge).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .opacity(arrived || reduceMotion ? 1 : 0).offset(y: arrived || reduceMotion ? 0 : 6)
        .onAppear { withAnimation(Motion.emphasis) { arrived = true } }
        .accessibilityElement(children: .contain)
    }
}

/// What a card became once answered: one line, no edge.
struct ReceiptLine: View {
    let text: String
    var body: some View {
        HStack(spacing: 6) {
            Lucide(.check, size: 12, color: Theme.working)
            Text(verbatim: text).font(Typo.meta).foregroundStyle(Theme.muted)
        }
        .frame(minHeight: 24, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Tool approval

struct ApprovalActions {
    var allowOnce: () -> Void
    var deny: () -> Void
    /// "Allow for this chat": only a chat whose host keeps rules (a Squeak chat's tool approval) offers it.
    var allowSession: (() -> Void)?
    /// "Allow edits for this chat": an Edit/Write approval on a host that has it.
    var allowEdits: (() -> Void)?
}

struct ApprovalCardView: View {
    let model: ApprovalCardModel
    let agent: String
    /// Nil: this chat cannot be approved from here; the card says where to do it (`unavailableNote`).
    var actions: ApprovalActions?
    var unavailableNote: String?
    /// A link beside the note, e.g. Open in Conductor.
    var link: (title: String, action: () -> Void)?

    var body: some View {
        NeedsYouFrame(title: model.heading, kind: model.tool) {
            if let command = model.command {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("$").font(Typo.code).foregroundStyle(Theme.subtle)
                    Text(verbatim: command).font(Typo.code).foregroundStyle(Theme.ink).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
            }
            if let target = model.target {
                Text(verbatim: target).font(Typo.code).foregroundStyle(Theme.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
            }
            if let reason = model.reason {
                Text(verbatim: "\(agent): “\(reason)”").font(Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actions {
                HStack(spacing: 8) {
                    Button(action: actions.allowOnce) { label("Allow once", CardKeycaps.allowOnce) }
                        .buttonStyle(PrimaryButtonStyle())
                    if let allowSession = actions.allowSession {
                        Button(action: allowSession) { label("Allow for this chat", CardKeycaps.allowSession) }
                            .buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.return, modifiers: .command)
                            .help("Allows this and the same kind of request for the rest of this chat. Remove it under Rules in the inspector.")
                    }
                    if let allowEdits = actions.allowEdits {
                        Button(action: allowEdits) { Text(verbatim: "Allow edits for this chat") }
                            .buttonStyle(SecondaryButtonStyle())
                            .help("Allows this edit and every file edit for the rest of this chat.")
                    }
                    Spacer(minLength: 16)
                    Button(action: actions.deny) { label("Deny", CardKeycaps.deny, tint: Theme.negative) }
                        .buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.delete, modifiers: .command)
                }
            } else if let unavailableNote {
                HStack(spacing: 10) {
                    Text(verbatim: unavailableNote).font(Typo.label).foregroundStyle(Theme.ink)
                    Spacer(minLength: 0)
                    if let link { Button(link.title, action: link.action).buttonStyle(SecondaryButtonStyle()) }
                }
            }
        }
    }

    private func label(_ title: String, _ key: String, tint: Color? = nil) -> some View {
        HStack(spacing: 8) {
            if let tint { Text(verbatim: title).foregroundStyle(tint) } else { Text(verbatim: title) }
            KeyCap(text: key)
        }
    }
}

// MARK: Plan

struct PlanCardView: View {
    let model: PlanCardModel
    let agent: String
    var approve: (() -> Void)?
    var keepPlanning: (() -> Void)?
    var unavailableNote: String?

    var body: some View {
        NeedsYouFrame(title: "\(agent)’s plan", titleDetail: model.title, kind: nil) {
            if let markdown = model.markdown, !markdown.isEmpty {
                ScrollView {
                    MessageText(markdown: markdown, style: .squeak).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 320)
                .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(model.steps.enumerated()), id: \.offset) { i, step in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(i + 1).").font(.system(size: 13.5)).monospacedDigit().foregroundStyle(Theme.muted).frame(width: 22, alignment: .trailing)
                        Text(verbatim: step).font(.system(size: 13.5)).foregroundStyle(Theme.ink).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if !model.files.isEmpty {
                HStack(spacing: 6) {
                    ForEach(model.files, id: \.self) { f in
                        Text(verbatim: f).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.head)
                            .padding(.horizontal, 7).frame(height: 22).background(Theme.selected, in: RoundedRectangle(cornerRadius: Radius.chip))
                    }
                }
            }
            if let approve {
                Text("Approving switches to Accept edits").font(Typo.meta).foregroundStyle(Theme.muted)
                HStack(spacing: 8) {
                    Button(action: approve) {
                        HStack(spacing: 8) { Text("Approve plan"); KeyCap(text: CardKeycaps.approvePlan) }
                    }
                    .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.return, modifiers: .command)
                    // §8.10 lists ⌘⇧↵ for the plan; ⌘↵ stays for those used to it.
                    Button("Approve plan", action: approve).keyboardShortcut(.return, modifiers: [.command, .shift])
                        .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
                    if let keepPlanning {
                        Button(action: keepPlanning) {
                            HStack(spacing: 8) { Text("Keep planning"); KeyCap(text: CardKeycaps.keepPlanning) }
                        }
                        .buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.delete, modifiers: .command)
                    }
                }
            } else if let unavailableNote {
                Text(verbatim: unavailableNote).font(Typo.label).foregroundStyle(Theme.ink)
            }
        }
    }
}

// MARK: Question

/// The question with its options as full rows: the number (a `radius-chip` square), the title, `recommended` in
/// `muted` (never pre-selected). `1…9` answer, `0` opens your own. No action row: choosing sends.
struct QuestionCardView: View {
    let model: QuestionCardModel
    let agent: String
    /// Nil: this chat cannot be answered from here (the rows show, disabled).
    var choose: ((Int) -> Void)?
    var other: (() -> Void)?
    @State private var hovered: Int?

    var body: some View {
        NeedsYouFrame(title: model.question, kind: nil, edge: Theme.subtle) {
            VStack(spacing: 6) {
                ForEach(Array(model.options.enumerated()), id: \.offset) { i, option in row(i, option) }
            }
            if let other {
                Button(action: other) {
                    HStack(spacing: 8) { Text("Other"); KeyCap(text: "0") }.foregroundStyle(Theme.muted).font(Typo.body)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func row(_ i: Int, _ option: QuestionCardModel.Option) -> some View {
        Button { choose?(i) } label: {
            HStack(alignment: .top, spacing: 12) {
                Text("\(i + 1)").font(Typo.label).monospacedDigit().foregroundStyle(Theme.muted)
                    .frame(width: 24, height: 24)
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: option.title).font(Typo.label).foregroundStyle(Theme.ink)
                    if let d = option.detail { Text(verbatim: d).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
                }
                Spacer(minLength: 12)
                if option.recommended { Text("recommended").font(Typo.meta).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            .background(hovered == i && choose != nil ? Theme.selected : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .modifier(OptionShortcut(number: i + 1))
        .disabled(choose == nil)
        .opacity(choose == nil ? 0.5 : 1)
        .onHover { hovered = $0 ? i : (hovered == i ? nil : hovered) }
        .accessibilityLabel("Answer \(i + 1): \(option.title)\(option.recommended ? ", recommended" : "")")
    }
}

/// ⌘1…⌘9 answers option 1…9.
private struct OptionShortcut: ViewModifier {
    let number: Int
    func body(content: Content) -> some View {
        if number >= 1, number <= 9, let c = Character("\(number)").asciiValue {
            content.keyboardShortcut(KeyEquivalent(Character(UnicodeScalar(c))), modifiers: .command)
        } else {
            content
        }
    }
}
