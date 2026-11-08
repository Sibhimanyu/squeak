import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10 "Cards that need you": one anatomy (surface-raised, radius-card, line border, a 3pt needs-you
// left edge, header = dot + state word + kind chip + "Claude · age"), three bodies. They take a simple model and
// closures, so any source can drive them: an action closure that is nil is an action this chat cannot give, and
// its button is not drawn (the card says so instead). Nothing here sends by itself.
//
// Keycaps are hints. Only the ⌘-modified keys are bound: a bare ↵, ⌫ or 1–9 would be taken from the composer's
// text field (key equivalents run before the first responder), so those wait for the focus-aware handling that
// comes with native requests (phase 5), where the composer's own ⌘↵ Send is also disabled while a card is up.

/// The shared frame. `edge` is false once answered, when the card is a receipt line.
struct NeedsYouFrame<Body: View>: View {
    let stateWord: String
    let kind: String?
    let agent: String
    let age: String?
    @ViewBuilder var content: () -> Body
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var arrived = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StateDot(state: .blocked)
                Text(verbatim: stateWord).font(Typo.label).foregroundStyle(Theme.ink)
                if let kind {
                    Text(verbatim: kind).font(Typo.meta).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 6).frame(height: 20)
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
                }
                Spacer(minLength: 8)
                Text(verbatim: [agent, age].compactMap { $0 }.joined(separator: " · ")).font(Typo.meta).foregroundStyle(Theme.subtle)
            }
            content()
        }
        .padding(.leading, 16).padding(.trailing, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.needsYou).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .opacity(arrived || reduceMotion ? 1 : 0).offset(y: arrived || reduceMotion ? 0 : 6)
        .onAppear { withAnimation(WorkbenchMotion.emphasis) { arrived = true } }
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
    var allowSession: (() -> Void)?
    var deny: () -> Void
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
        NeedsYouFrame(stateWord: "Needs approval", kind: model.tool, agent: agent, age: model.age) {
            Text(verbatim: model.heading).font(Typo.heading).foregroundStyle(Theme.ink)
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
            if let reason = model.reason {
                Text(verbatim: "\(agent): “\(reason)”").font(Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actions {
                HStack(spacing: 8) {
                    Button(action: actions.allowOnce) { label("Allow once", "↵") }
                        .buttonStyle(PrimaryButtonStyle())
                    if let session = actions.allowSession {
                        Button(action: session) { label("Allow for this session", "⌘↵") }
                            .buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.return, modifiers: .command)
                    }
                    Spacer(minLength: 16)
                    Button(action: actions.deny) { label("Deny", "⌫", tint: Theme.needsYou) }
                        .buttonStyle(SecondaryButtonStyle())
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
        NeedsYouFrame(stateWord: "Plan ready", kind: "Plan", agent: agent, age: model.age) {
            Text(verbatim: model.title).font(Typo.heading).foregroundStyle(Theme.ink)
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
                        HStack(spacing: 8) { Text("Approve plan"); KeyCap(text: "⌘⇧↵") }
                    }
                    .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.return, modifiers: [.command, .shift])
                    if let keepPlanning {
                        Button("Keep planning", action: keepPlanning).buttonStyle(SecondaryButtonStyle())
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
        NeedsYouFrame(stateWord: "Needs an answer", kind: "Question", agent: agent, age: model.age) {
            Text(verbatim: model.question).font(Typo.heading).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
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
        .disabled(choose == nil)
        .opacity(choose == nil ? 0.5 : 1)
        .onHover { hovered = $0 ? i : (hovered == i ? nil : hovered) }
        .accessibilityLabel("Answer \(i + 1): \(option.title)\(option.recommended ? ", recommended" : "")")
    }
}
