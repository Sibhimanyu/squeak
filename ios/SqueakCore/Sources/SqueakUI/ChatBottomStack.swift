#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// "What it's doing", pinned above the composer: one compact line (the live step, Stop), opening to the live turn.
struct LiveBar: View {
    let label: String
    let steps: [TurnStep]
    let total: Int
    let live: Bool
    @Binding var open: Bool
    let canStop: Bool
    let stopping: Bool
    let stop: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if open, !steps.isEmpty {
                ScrollView {
                    StepList(steps: steps, total: max(total, steps.count), live: live, readable: true)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(.bottom)
                .frame(maxHeight: UIScreen.main.bounds.height * 0.35)
                Divider()
            }
            HStack(spacing: 8) {
                Button {
                    Haptics.play(.tap)
                    withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        WorkingGlyph()
                        Text(stopping ? "Stopping…" : label).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
                        Spacer(minLength: 4)
                        if !steps.isEmpty { Lucide(open ? .chevronDown : .chevronUp, size: 14, color: Theme.muted) }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.press)
                .allowsHitTesting(!steps.isEmpty)
                .accessibilityLabel("Working: \(label)")
                .accessibilityValue(steps.isEmpty ? "" : open ? "Expanded" : "Collapsed")
                .accessibilityHint(steps.isEmpty ? "" : open ? "Hides the steps" : "Shows the steps of this turn")
                if canStop {
                    Button(action: stop) {
                        if stopping { GlyphLoader().controlSize(.small) } else { Text("Stop").font(.subheadline.weight(.semibold)) }
                    }
                    .buttonStyle(.bordered).tint(Theme.ink)
                    .frame(minHeight: 44)
                    .disabled(stopping)
                    .accessibilityLabel(stopping ? "Stopping" : "Stop the agent")
                }
            }
            .padding(.horizontal, 14)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundRectangleStroke())
        .padding(.horizontal, 12).padding(.bottom, 8)
    }
}

private struct RoundRectangleStroke: View {
    var body: some View { RoundedRectangle(cornerRadius: 16).stroke(Theme.line) }
}

/// The pinned needs-you card: a film's call, a Squeak chat's request, or a plan / question to answer. Tall cards
/// scroll inside 45% of the screen.
struct DecisionDock: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    @State private var measured: CGFloat = 0

    var body: some View {
        let agentName = Presentation.agentName(session.agent)
        let rasanai = model.snapshot?.rasanaiEnabled ?? true
        ScrollView {
            VStack(spacing: 0) {
                if rasanai, let workflow = session.workflow {
                    WorkflowCard(workflow: workflow, owner: .session(session))
                } else if let request = session.nativeRequest {
                    NativeRequestCard(request: request, agentName: agentName, session: session).id(request.id)
                } else {
                    AnswerCardSlot(session: session, agentName: agentName)
                }
            }
            .padding(.horizontal, 16)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(measured, UIScreen.main.bounds.height * 0.45))
        .padding(.bottom, measured > 0 ? 8 : 0)
    }
}

/// While a decision waits the composer folds to one quiet button; a tap brings it back.
struct FoldedComposerButton: View {
    let agentName: String
    let action: () -> Void

    var body: some View {
        Button { Haptics.play(.tap); action() } label: {
            Text("Reply to \(agentName) instead…").font(.subheadline).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.press)
        .padding(.horizontal, 12).padding(.bottom, 4)
        .background(Theme.bg.ignoresSafeArea(edges: .bottom))
        .accessibilityLabel("Reply to \(agentName) in your own words")
    }
}
#endif
