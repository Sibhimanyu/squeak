import SqueakIcons
import SqueakMacCore
import SwiftUI

struct LaunchOfferBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.launchOfferPending {
            HStack(spacing: 8) {
                Text("Open Squeak when you log in?")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Button("Not now") { model.answerLaunchOffer(enable: false) }.buttonStyle(QuietButtonStyle())
                Button("Turn on") { model.answerLaunchOffer(enable: true) }.buttonStyle(PrimaryButtonStyle())
            }
            .padding(10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        }
    }
}

struct EmptyStateView: View {
    let symbol: LucideName
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Lucide(symbol, size: 28, color: Theme.subtle)
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            Text(message).font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: 320)
        .accessibilityElement(children: .combine)
    }
}

/// What the popover and quick composer say about a send. Self-contained so these two surfaces do not
/// depend on the conversation window's delivery wording.
struct SendFeedback {
    var text: String
    var symbol: LucideName
    var color: Color
    var succeeded: Bool

    init?(_ result: SendResult) {
        switch result {
        case .accepted(let via, let delivery, _):
            let word = via == "terminal" ? "Terminal" : via == "conductor" ? "Conductor" : via
            let text = switch delivery {
            case .queued: "Queued in \(word). It reads it after this turn"
            case .steered: "Steered into the current turn in \(word)"
            case .sent, nil: "Sent in \(word)"
            }
            self = .init(text: text, symbol: .check, color: Theme.subtle, succeeded: true)
        case .uncertain:
            self = .init(text: "Couldn't confirm it was sent. Check Conductor before resending.", symbol: .circleAlert, color: Theme.muted, succeeded: false)
        case .refused(let r):
            self = .init(text: "Refused: \(r)", symbol: .circleX, color: Theme.error, succeeded: false)
        case .notSent(let r):
            self = .init(text: "Not sent: \(r)", symbol: .circleAlert, color: Theme.error, succeeded: false)
        }
    }

    private init(text: String, symbol: LucideName, color: Color, succeeded: Bool) {
        self.text = text; self.symbol = symbol; self.color = color; self.succeeded = succeeded
    }

    /// Nil when the send went through, so the card goes quiet again.
    var failureText: String? { succeeded ? nil : text }
}
