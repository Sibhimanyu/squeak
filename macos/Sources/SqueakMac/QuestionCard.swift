import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

/// The card for a question or plan an agent is waiting on (DESIGN.md §8.4 decision rows, generated from the
/// question itself). Options are rows: radio for one answer, checkboxes ("Choose any") for several,
/// "Something else…" for your own words. It never sends on its own: `onSend` is the caller's path and is
/// only called from the Send button.
struct AskCard: View {
    let ask: PendingAsk
    /// The compact form for the popover: shorter text, and a plan is read in the window.
    var compact = false
    /// The conversation window's card: framed, the question above its header, lettered rows, a "Recommended" pill.
    var framed = false
    /// False when nothing can be sent from here (offline, or the session is read-only).
    var canSend = true
    var onOpen: () -> Void = {}
    var onSend: (AskForm) async -> AnswerOutcome = { _ in .refused(reason: "Nothing is sent here.") }
    /// Captures start a card part-way through.
    var initial: AskForm?
    /// A result to show from the start: the card was rebuilt after its answer was sent.
    var result: AnswerOutcome?

    @State private var form: AskForm
    @State private var sending = false
    @State private var outcome: AnswerOutcome?
    @FocusState private var otherFocused: Bool

    init(ask: PendingAsk, compact: Bool = false, framed: Bool = false, canSend: Bool = true, onOpen: @escaping () -> Void = {},
         onSend: @escaping (AskForm) async -> AnswerOutcome = { _ in .refused(reason: "Nothing is sent here.") },
         initial: AskForm? = nil, result: AnswerOutcome? = nil) {
        self.result = result
        _outcome = State(initialValue: result)
        self.ask = ask; self.compact = compact; self.framed = framed; self.canSend = canSend; self.onOpen = onOpen; self.onSend = onSend
        self.initial = initial
        _form = State(initialValue: initial ?? AskForm(ask))
    }

    private var answered: Bool { outcome?.isAnswered == true }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? Space.s : Space.m) {
            if !answered {
                if ask.kind == .plan { planBody } else { questionBody }
            }
            if let outcome {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(outcome.isAnswered ? .circleCheck : .circleAlert, size: 14, color: outcome.isAnswered ? Theme.done : Theme.muted)
                        .padding(.top, 1)
                    Text(verbatim: outcome.line).font(Typo.meta).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(framed ? 14 : 0)
        .background { if framed { RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface.opacity(0.7)) } }
        .overlay { if framed { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.lineStrong) } }
        .animation(nil, value: form.index)
    }

    // MARK: Question

    @ViewBuilder private var questionBody: some View {
        if let q = form.current {
            if framed {
                Text(verbatim: q.question).font(.system(size: Metrics.cardTitle, weight: .semibold)).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                if let header = q.header, !header.isEmpty {
                    Text(verbatim: header).font(framed ? .system(size: 12) : Typo.meta).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
                if q.multiSelect { Text("Choose any").font(Typo.meta).foregroundStyle(Theme.muted) }
                if let progress = form.progress { Text(verbatim: progress).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted) }
            }
            if !framed {
                Text(verbatim: q.question).font(compact ? Typo.label : Typo.heading).foregroundStyle(Theme.ink)
                    .lineLimit(compact ? 3 : nil).fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: compact ? 6 : Space.s) {
                ForEach(Array(q.options.enumerated()), id: \.element.label) { i, option in
                    optionRow(option, index: i, selected: form.picks[form.index].contains(option.label), multi: q.multiSelect)
                }
                otherRow(multi: q.multiSelect)
            }
            if form.count > 1 {
                HStack(spacing: Space.s) {
                    if form.canGoBack { quietButton("Back") { form.back() } }
                    if form.canGoNext { quietButton("Next") { form.next() }.disabled(!form.isAnswered(form.index)) }
                    Spacer(minLength: 0)
                }
            }
            if let summary = form.summary {
                Text(verbatim: summary).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true).accessibilityLabel("Your answer: \(summary)")
            }
            if let note = ask.routeNote {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(.info, size: 14, color: Theme.subtle).padding(.top, 1)
                    Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack {
                primaryButton("Send answer", enabled: canSend && ask.canDeliver && form.isComplete) { send() }
                Spacer(minLength: 0)
            }
        }
    }

    /// Claude marks the option it prefers with a "(Recommended)" suffix; framed rows show that as a pill.
    private func split(_ label: String) -> (title: String, recommended: Bool) {
        let tag = "(recommended)"
        guard label.lowercased().hasSuffix(tag) else { return (label, false) }
        return (String(label.dropLast(tag.count)).trimmingCharacters(in: .whitespaces), true)
    }

    private func optionRow(_ option: AskOption, index: Int = 0, selected: Bool, multi: Bool) -> some View {
        let parts = framed ? split(option.label) : (option.label, false)
        let letter = framed ? "\(Character(UnicodeScalar(65 + index % 26)!))) " : ""
        return Button {
            form.toggle(option.label, in: form.index)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                control(selected: selected, multi: multi)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: letter + parts.0).font(framed ? .system(size: 13, weight: .semibold) : Typo.label).foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let d = option.description, !d.isEmpty {
                        Text(verbatim: d).font(framed ? .system(size: 12) : compact ? Typo.meta : Typo.body).foregroundStyle(Theme.muted)
                            .lineLimit(compact ? 2 : nil).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                if parts.1 {
                    Text("Recommended").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.working)
                        .padding(.horizontal, 8).frame(height: 22)
                        .background(Theme.working.opacity(0.16), in: Capsule())
                }
            }
            .padding(.horizontal, 12).padding(.vertical, framed ? 8 : compact ? 8 : 11)
            .frame(maxWidth: .infinity, minHeight: compact ? 32 : 40, alignment: .leading)
            .background(framed ? Theme.bg.opacity(selected ? 0.2 : 0.45) : selected ? Theme.surfaceRaised : Theme.surfaceRaised.opacity(0.35),
                        in: RoundedRectangle(cornerRadius: framed ? 10 : Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: framed ? 10 : Radius.card, style: .continuous).strokeBorder(selected ? Theme.lineStrong : Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
        .accessibilityHint(option.description ?? "")
        .accessibilityValue(selected ? "Selected" : "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func otherRow(multi: Bool) -> some View {
        let q = form.index
        let on = form.usingOther[q]
        return VStack(alignment: .leading, spacing: 8) {
            Button {
                form.setUsingOther(multi ? !on : true, in: q)
                if form.usingOther[q] { otherFocused = true }
            } label: {
                HStack(spacing: 12) {
                    control(selected: on, multi: multi)
                    Text("Something else…").font(Typo.label).foregroundStyle(Theme.ink)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(on ? "Selected" : "")
            if on {
                TextField("Your answer", text: Binding(get: { form.other[q] }, set: { form.setOther($0, in: q) }), axis: .vertical)
                    .textFieldStyle(.plain).font(Typo.body).lineLimit(1...5)
                    .focused($otherFocused)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Theme.bg.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.control))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, compact ? 8 : 11)
        .frame(maxWidth: .infinity, minHeight: compact ? 36 : 44, alignment: .leading)
        .background(on ? Theme.surfaceRaised : Theme.surfaceRaised.opacity(0.35), in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(on ? Theme.lineStrong : Theme.line))
    }

    /// Radio (a ring with a dot) or checkbox (a rounded square with a check), drawn so both match the tokens.
    @ViewBuilder private func control(selected: Bool, multi: Bool) -> some View {
        Group {
            if multi {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(selected ? Theme.primaryFill : .clear)
                    .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(selected ? Theme.primaryFill : Theme.subtle, lineWidth: 1.5))
                    .overlay { if selected { Lucide(.check, size: 12, color: Theme.primaryText) } }
            } else {
                Circle().strokeBorder(selected ? Theme.primaryFill : Theme.subtle, lineWidth: 1.5)
                    .overlay { if selected { Circle().fill(Theme.primaryFill).padding(4) } }
            }
        }
        .frame(width: 18, height: 18)
        .padding(.top, 1)
        .accessibilityHidden(true)
    }

    // MARK: Plan

    @ViewBuilder private var planBody: some View {
        HStack(spacing: 6) {
            Lucide(.clipboardList, size: 14, color: Theme.muted)
            Text("Plan to approve").font(Typo.meta).foregroundStyle(Theme.muted)
        }
        if let plan = ask.plan, !plan.isEmpty {
            if compact {
                MessageInlineText(markdown: Choices.stripMarkdown(plan), style: .squeak).lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack { quietButton("Read the plan", action: onOpen); Spacer(minLength: 0) }
            } else {
                MessageText(markdown: plan, style: .squeak)
                    .padding(Space.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surfaceRaised.opacity(0.35), in: RoundedRectangle(cornerRadius: Radius.card))
                    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
            }
        } else {
            Text("The agent has a plan for you to review.").font(Typo.body).foregroundStyle(Theme.muted)
        }
        if !compact {
            if form.revising {
                TextField("What should it change?", text: $form.planNote, axis: .vertical)
                    .textFieldStyle(.plain).font(Typo.body).lineLimit(2...6)
                    .focused($otherFocused)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(Theme.bg.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.control))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            }
            if let note = ask.routeNote {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(.info, size: 14, color: Theme.subtle).padding(.top, 1)
                    Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: Space.s) {
                if form.revising {
                    primaryButton("Send note", enabled: canSend && ask.canDeliver && form.isComplete) { send() }
                    quietButton("Cancel") { form.revising = false }
                } else {
                    primaryButton("Approve", enabled: canSend && ask.canDeliver) { send() }
                    quietButton("Keep planning") { form.revising = true; otherFocused = true }
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: Buttons

    private func primaryButton(_ title: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if sending { ProgressView().controlSize(.small) }
                Text(sending ? "Sending…" : title).font(Typo.label)
            }
            .foregroundStyle(enabled ? Theme.primaryText : Theme.muted)
            .padding(.horizontal, 12).frame(height: Metrics.button)
            .background(enabled ? Theme.primaryFill : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
        }
        .buttonStyle(.plain)
        .disabled(!enabled || sending)
        .accessibilityLabel(title)
    }

    private func quietButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(Typo.label).foregroundStyle(Theme.muted)
                .padding(.horizontal, Space.s).frame(height: Metrics.button).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func send() {
        guard !sending, form.isComplete else { return }
        sending = true
        outcome = nil
        let snapshot = form
        Task {
            let result = await onSend(snapshot)
            sending = false
            outcome = result
        }
    }
}
