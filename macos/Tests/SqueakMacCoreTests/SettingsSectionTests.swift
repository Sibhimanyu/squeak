import Testing
@testable import SqueakMacCore

@Suite struct SettingsSectionTests {
    @Test func everySectionIsInExactlyOneGroup() {
        let grouped = SettingsSection.groups.flatMap { $0 }
        let expected = SettingsSection.allCases.filter { $0 != .conductor || ConductorLink.isBuiltIn }
        #expect(grouped.count == expected.count)
        #expect(Set(grouped) == Set(expected))
    }

    @Test func linksLandOnTheirSection() {
        #expect(SettingsSection(link: "iphone") == .iphone)
        #expect(SettingsSection(link: " About ") == .about)
        #expect(SettingsSection(link: "connections") == .connections)
        #expect(SettingsSection(link: "zoho") == .cliq)
    }

    @Test func phoneStyleOrderAndAliases() {
        #expect(SettingsSection.groups[1] == [.general, .notifications, .awake])
        #expect(SettingsSection.general.title == "Mac")
        #expect(SettingsSection(link: "notify") == .notifications)
        #expect(SettingsSection(link: "mac") == .general)
    }

#if SQUEAK_CONDUCTOR_RELAY
    @Test func conductorSitsAfterKeepAwakeBeforeConnections() {
        #expect(SettingsSection.groups[2].first == .conductor)
        #expect(SettingsSection.conductor.title == "Conductor")
        #expect(SettingsSection(link: "conductor") == .conductor)
    }
#endif

    @Test func setupIsFirstOnItsOwn() {
        #expect(SettingsSection.groups.first == [.setup])
        #expect(SettingsSection(link: "setup") == .setup)
        #expect(SettingsSection.setup.title == "Setup")
    }

    @Test func theOldChannelsTabLandsOnTelegram() {
        #expect(SettingsSection(link: "channels") == .telegram)
    }

    @Test func unknownOrMissingLinksAreNil() {
        #expect(SettingsSection(link: nil) == nil)
        #expect(SettingsSection(link: "") == nil)
        #expect(SettingsSection(link: "billing") == nil)
    }
}
