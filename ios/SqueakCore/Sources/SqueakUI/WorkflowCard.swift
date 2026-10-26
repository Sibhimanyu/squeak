#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// A film waiting on one of its calls (RasanAI): the call itself, built for a phone. A story or a
/// look is a pick from a few cards; the director's question has its options and room for words.
/// Calls the phone can't make yet (the animatic, the final film) say so and point at the Mac.
/// Everything here is the director's text: plain text only.
struct WorkflowCard: View {
    let workflow: Workflow
    let owner: WorkflowOwner
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var selected: String?
    @State private var choice: String?
    @State private var words = ""
    @State private var sending = false
    @State private var installing = false
    @State private var result: (delivered: Bool, line: String)?

    private var answered: Bool { result?.delivered == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if let ask = workflow.ask {
                askBody(ask)
            } else if let options = workflow.options, !options.isEmpty {
                ForEach(options) { option in optionCard(option) }
                pickFooter(options)
            } else if let review = workflow.review {
                ReviewCard(review: review, owner: owner, workflow: workflow)
                    .id(workflow.revision)
            } else if let macOnly = workflow.macOnly {
                note(macOnly)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(sending || answered)
        // A new call (three more, the next step) starts clean.
        .onChange(of: workflow.revision) { _, _ in selected = nil; choice = nil; words = ""; result = nil }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(["RasanAI", workflow.title].compactMap { $0 }.joined(separator: " · ").uppercased())
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            Text(workflow.ask?.question ?? workflow.prompt).font(.headline)
            if let context = workflow.ask?.context ?? workflow.context, !context.isEmpty {
                Text(context).font(.subheadline).foregroundStyle(Theme.muted)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /* ---------- a pick: stories or looks ---------- */

    private func optionCard(_ option: Workflow.Option) -> some View {
        let on = selected == option.id
        return Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { selected = on ? nil : option.id }
            UISelectionFeedbackGenerator().selectionChanged()
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                if let image = option.image {
                    CardPicture(owner: owner, source: image, name: option.title)
                }
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Lucide(on ? .circleCheck : .circle, size: 18, color: on ? Theme.ink : Theme.subtle)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(option.label.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                            // DESIGN.md §8.4: "recommended" is a muted word, never a colour, never pre-selected.
                            if option.id == workflow.recommended {
                                Text("recommended").font(.caption).foregroundStyle(Theme.muted)
                            }
                        }
                        Text(option.title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                        if let note = option.note, !note.isEmpty {
                            Text(note).font(.footnote).foregroundStyle(Theme.muted)
                        }
                        if let summary = option.summary, !summary.isEmpty {
                            Text(summary).font(.subheadline).foregroundStyle(Theme.ink)
                        }
                        if on, let why = option.why, !why.isEmpty {
                            Text(why).font(.footnote).foregroundStyle(Theme.muted)
                        }
                    }
                    Spacer(minLength: 0)
                }
                if on, let frames = option.frames, !frames.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(frames, id: \.image) { frame in
                                CardPicture(owner: owner, source: frame.image, name: frame.id, fit: .box(width: 160, height: 120))
                            }
                        }
                    }
                }
                if on, let beats = option.beats, !beats.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(beats.enumerated()), id: \.offset) { _, beat in beatRow(beat) }
                    }
                    .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(on ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Theme.ink : Theme.line, lineWidth: on ? 1.5 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }

    private func beatRow(_ beat: Workflow.Beat) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(beat.seconds.map { String(format: "%.0fs", $0) } ?? "·")
                .font(.caption.monospacedDigit()).foregroundStyle(Theme.subtle)
                .frame(width: 30, alignment: .trailing)
            VStack(alignment: .leading, spacing: 2) {
                if let line = beat.line, !line.isEmpty { Text(line).font(.footnote).foregroundStyle(Theme.ink) }
                if let screen = beat.onScreen, !screen.isEmpty, screen != "(captions only)" {
                    Text(screen).font(.caption).foregroundStyle(Theme.muted)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func pickFooter(_ options: [Workflow.Option]) -> some View {
        let picked = options.first { $0.id == selected }
        let noun = workflow.call == "look" ? "look" : workflow.call == "story" ? "story" : "one"
        return VStack(alignment: .leading, spacing: 8) {
            if !answered {
                primaryButton(picked.map { "Use \($0.label)" } ?? "Pick a \(noun)", enabled: picked != nil) {
                    guard let picked else { return }
                    send(type: "choose", value: .id(picked.id))
                }
                if workflow.canAskMore == true {
                    Button {
                        send(type: "more", value: .more(near: selected))
                    } label: {
                        Text(picked.map { "Three more like \($0.label)" } ?? "Three more")
                            .font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                    }
                    .buttonStyle(.plain)
                }
                decideButton
            }
            resultLine
        }
    }

    /// "You decide": the film's own pick for this call (contract v2), on a film of its own only.
    @ViewBuilder private var decideButton: some View {
        if owner.film != nil, workflow.canDecide == true {
            Button { send(type: "decide", value: WorkflowCommand.Value.none) } label: {
                Text("You decide").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            }
            .buttonStyle(.plain)
        }
    }

    /* ---------- the director's question ---------- */

    @ViewBuilder
    private func askBody(_ ask: Workflow.Ask) -> some View {
        ForEach(ask.options) { option in
            let on = choice == option.id
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { choice = on ? nil : option.id }
                UISelectionFeedbackGenerator().selectionChanged()
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Lucide(on ? .circleCheck : .circle, size: 18, color: on ? Theme.ink : Theme.subtle)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        if option.id == ask.recommended {
                            Text("recommended").font(.caption).foregroundStyle(Theme.muted)
                        }
                        Text(option.label).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                        if let detail = option.detail, !detail.isEmpty {
                            Text(detail).font(.subheadline).foregroundStyle(Theme.muted)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(on ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Theme.ink : Theme.line, lineWidth: on ? 1.5 : 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        }
        TextField(ask.placeholder ?? "Or type your answer", text: $words, axis: .vertical)
            .lineLimit(1...5)
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .leading, spacing: 8) {
            if !answered {
                if let tool = workflow.tool, let film = owner.film {
                    Button {
                        installing = true
                        Task {
                            let outcome = await model.installTool(film, workflow: workflow, tool: tool)
                            installing = false
                            if !outcome.line.isEmpty { result = outcome }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if installing { ProgressView() }
                            Text(installing ? "Asking your Mac…" : "Install \(tool.label) for me")
                        }
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.lineStrong))
                    }
                    .buttonStyle(.plain)
                    .disabled(installing)
                }
                primaryButton("Send answer", enabled: choice != nil || !text.isEmpty) {
                    send(type: "answer", value: .answer(choice: choice, text: text))
                }
                decideButton
            }
            resultLine
        }
    }

    /* ---------- shared ---------- */

    private func primaryButton(_ title: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if sending { ProgressView().tint(Theme.primaryText) }
                Text(sending ? "Sending…" : title).font(.body.weight(.semibold))
            }
            .foregroundStyle(enabled ? Theme.primaryText : Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(enabled ? Theme.primaryFill : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!enabled || sending)
    }

    @ViewBuilder
    private var resultLine: some View {
        if let result {
            Text(result.line).font(.footnote).foregroundStyle(result.delivered ? Theme.muted : Theme.needsYou)
        } else {
            Text("Goes to RasanAI on your Mac, the same as answering in RasanAI Studio.")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private func note(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Lucide(.info, size: 14, color: Theme.muted).accessibilityHidden(true)
            Text(text).font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private func send(type: String, value: WorkflowCommand.Value?) {
        sending = true
        Task {
            let outcome = await model.act(on: owner, workflow: workflow, type: type, value: value)
            sending = false
            if !outcome.line.isEmpty { result = outcome }
        }
    }
}

#endif
