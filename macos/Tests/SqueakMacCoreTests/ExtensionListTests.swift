import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ExtensionListTests {
    private let addons = [
        AddonInfo(id: "conductor", name: "Conductor", blurb: "b", available: true, enabled: true),
        AddonInfo(id: "rasanai", name: "RasanAI", blurb: "r", available: true, enabled: false),
    ]

    @Test func mergesAddonsThenBuiltIns() {
        let items = ExtensionList.items(addons: addons, telegram: nil, cliq: nil, voice: nil)
        #expect(items.map(\.id) == ["conductor", "rasanai", "telegram", "cliq", "calls"])
        #expect(items.map(\.status) == [.added, .notAdded, .notAdded, .notAdded, .notAdded])
    }

    @Test func builtInsAreAddedWhenConfigured() {
        let tg = ChannelsStatus.Telegram(configured: true, polling: .ok)
        let items = ExtensionList.items(
            addons: [], telegram: tg, cliq: ChannelsStatus.Cliq(oneWay: true), voice: VoiceSettings(mode: "direct"))
        #expect(items.map(\.status) == [.added, .added, .added])
    }

    @Test func phoneCallsFollowTheSwitchAndKeepTheSetup() throws {
        func calls(_ v: VoiceSettings?) -> ExtensionItem {
            ExtensionList.items(addons: [], telegram: nil, cliq: nil, voice: v).first { $0.id == "calls" }!
        }
        #expect(calls(VoiceSettings(mode: "direct", enabled: true)).status == .added)
        let off = calls(VoiceSettings(mode: "direct", enabled: false))
        #expect(off.status == .notAdded)
        #expect(off.callsConfigured)
        #expect(calls(VoiceSettings(mode: "off", enabled: false)).callsConfigured == false)
        #expect(calls(VoiceSettings(mode: "direct")).status == .added)
        #expect(String(data: VoiceSettings.enabledRequestBody(false), encoding: .utf8) == "{\"enabled\":false}")
        let decoded = try JSONDecoder().decode(VoiceSettings.self, from: Data("{\"mode\":\"direct\",\"enabled\":false}".utf8))
        #expect(decoded.enabled == false && decoded.callsOn == false)
    }

    @Test func telegramErrorNeedsAttentionAndUnavailableAddonToo() {
        let tg = ChannelsStatus.Telegram(configured: true, polling: .error, lastError: "401")
        let gone = AddonInfo(id: "conductor", name: "Conductor", available: false, enabled: true)
        let items = ExtensionList.items(addons: [gone], telegram: tg, cliq: nil, voice: nil)
        #expect(items[0].status == .needsAttention)
        #expect(items[0].note == "Conductor isn't installed on this Mac.")
        #expect(items[1].status == .needsAttention)
        #expect(ExtensionStatus.needsAttention.label == "Needs attention")
    }

    @Test func sidebarListsOnlyAddedExtensions() {
        let items = ExtensionList.items(
            addons: addons, telegram: ChannelsStatus.Telegram(configured: true, polling: .ok), cliq: nil, voice: nil)
        #expect(ExtensionList.sidebarSections(items) == [.addons, .conductor, .telegram])
    }
}
