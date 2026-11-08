import SqueakMacCore
import SwiftUI

/// The card a Squeak-run chat waits on, with the host's real request behind its buttons. Answers go to the host
/// through `AppModel` (`nativeAllow`, `nativeDeny`…); a refusal shows as a quiet line under the card.
struct NativeNeedsYouCard: View {
    let session: HostSession
    let card: NativeCard
    /// Puts the cursor in the composer (an "Other" answer is typed there).
    var focusComposer: () -> Void
    @Environment(AppModel.self) private var model

    private var agent: String { SessionRowView.agentName(session.agent) ?? "Agent" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch card.kind {
            case .approval:
                if let m = card.approval {
                    ApprovalCardView(
                        model: m, agent: agent,
                        actions: model.native.busy ? nil : ApprovalActions(
                            allowOnce: { model.nativeAllow(session) }, allowSession: nil, deny: { model.nativeDeny(session) }),
                        unavailableNote: "Answering…", link: nil)
                }
            case .plan:
                if let m = card.plan {
                    PlanCardView(
                        model: m, agent: agent,
                        approve: model.native.busy ? nil : { model.nativeApprovePlan(session) },
                        keepPlanning: { model.nativeKeepPlanning(session) }, unavailableNote: "Answering…")
                }
            case .question:
                if let m = card.questionModels.indices.contains(model.native.flow?.index ?? 0)
                    ? card.questionModels[model.native.flow?.index ?? 0] : card.question {
                    QuestionCardView(
                        model: m, agent: agent,
                        choose: model.native.busy ? nil : { model.nativeAnswer(session, option: $0) },
                        other: {
                            let typed = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
                            if typed.isEmpty { focusComposer() } else { model.nativeAnswer(session, option: nil, other: typed); model.setDraft("") }
                        })
                }
            }
            if let note = model.native.note {
                Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted).padding(.leading, 4)
            }
        }
        .id(card.id)
    }
}
