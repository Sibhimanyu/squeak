import Testing
@testable import SqueakMacCore

@Suite struct SettingsSectionTests {
    @Test func everySectionIsInExactlyOneGroup() {
        let grouped = SettingsSection.groups.flatMap { $0 }
        #expect(grouped.count == SettingsSection.allCases.count)
        #expect(Set(grouped) == Set(SettingsSection.allCases))
    }

    @Test func linksLandOnTheirSection() {
        #expect(SettingsSection(link: "iphone") == .iphone)
        #expect(SettingsSection(link: " About ") == .about)
        #expect(SettingsSection(link: "connections") == .connections)
        #expect(SettingsSection(link: "zoho") == .cliq)
    }

    @Test func phoneStyleOrderAndAliases() {
        #expect(SettingsSection.groups.first == [.general, .notifications, .awake])
        #expect(SettingsSection.general.title == "Mac")
        #expect(SettingsSection(link: "notify") == .notifications)
        #expect(SettingsSection(link: "mac") == .general)
    }

    @Test func conductorSitsAfterKeepAwakeBeforeConnections() {
        #expect(SettingsSection.groups[1].first == .conductor)
        #expect(SettingsSection.conductor.title == "Conductor")
        #expect(SettingsSection(link: "conductor") == .conductor)
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
