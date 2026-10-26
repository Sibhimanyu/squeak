import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Bot avatar")
struct BotAvatarTests {
    private func state(_ status: Int, _ body: String = "{}") -> BotAvatarState {
        BotAvatarState(BotAvatarOutcome.from(status: status, body: Data(body.utf8)))
    }

    @Test func okIsDone() {
        #expect(state(200, #"{"message":"Done"}"#) == .done)
        #expect(BotAvatarText.line(.done) == "Done — it can take a moment to show in Telegram")
    }

    @Test func badRequestShowsTheDaemonsSentence() {
        #expect(state(400, #"{"error":"Telegram refused the picture."}"#) == .failed("Telegram refused the picture."))
        #expect(state(400, "not json") == .failed(BotAvatarText.rejected))
        #expect(state(400, #"{"error":42}"#) == .failed(BotAvatarText.rejected))
    }

    @Test func tooSoon() {
        #expect(state(429, #"{"error":"Try again in a minute"}"#) == .failed("Try again in a minute"))
        #expect(state(429, "") == .failed("Try again in a minute."))
    }

    @Test func olderDaemonAndNotWired() {
        #expect(state(404) == .failed("Update Squeak's background service to set the bot picture."))
        #expect(state(503) == .failed(BotAvatarText.unavailable))
    }

    @Test func otherStatusesAndNetworkErrors() {
        #expect(state(401) == .failed(BotAvatarText.token))
        #expect(state(500) == .failed(BotAvatarText.unexpected))
        #expect(BotAvatarState(.from(error: AdapterError.daemonDown)) == .failed(BotAvatarText.down))
        #expect(BotAvatarState(.from(error: AdapterError.timedOut)) == .failed(BotAvatarText.slow))
        #expect(BotAvatarState(.from(error: URLError(.notConnectedToInternet))) == .failed(BotAvatarText.unexpected))
    }

    @Test func buttonRule() {
        #expect(BotAvatarState.idle.canSet(telegramConfigured: true))
        #expect(!BotAvatarState.idle.canSet(telegramConfigured: false))
        #expect(!BotAvatarState.working.canSet(telegramConfigured: true))
        #expect(BotAvatarState.failed("x").isError)
        #expect(BotAvatarText.line(.idle) == nil)
    }
}
