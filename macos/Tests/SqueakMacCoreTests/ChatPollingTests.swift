import Testing
@testable import SqueakMacCore

@Suite("Chat polling")
struct ChatPollingTests {
    @Test func aSqueakChatPollsNoExtras() {
        #expect(!ChatPolling.pollsExtras(isNative: true, hasConductorId: false))
        #expect(!ChatPolling.pollsExtras(isNative: true, hasConductorId: true))
    }

    @Test func otherChatsKeepThePollOnlyWithAConductorId() {
        #expect(ChatPolling.pollsExtras(isNative: false, hasConductorId: true))
        #expect(!ChatPolling.pollsExtras(isNative: false, hasConductorId: false))
    }

    @Test func activityPollsOnlyWithoutATimelineWhileAWorkingChatShows() {
        #expect(ChatPolling.pollsActivity(usesTimeline: false, active: true, working: true))
        #expect(!ChatPolling.pollsActivity(usesTimeline: true, active: true, working: true))
        #expect(!ChatPolling.pollsActivity(usesTimeline: false, active: false, working: true))
        #expect(!ChatPolling.pollsActivity(usesTimeline: false, active: true, working: false))
    }
}
