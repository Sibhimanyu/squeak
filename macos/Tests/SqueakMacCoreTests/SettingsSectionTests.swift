import Testing
@testable import SqueakMacCore

@Suite struct SettingsSectionTests {
    @Test func everySectionIsInExactlyOneGroup() {
        let grouped = SettingsSection.groups(conductorLink: true).flatMap { $0 }
        let expected = SettingsSection.allCases
        #expect(grouped.count == expected.count)
        #expect(Set(grouped) == Set(expected))
    }

    @Test func conductorPageExistsOnlyWithAnAddOn() {
        #expect(!SettingsSection.groups(conductorLink: false).flatMap { $0 }.contains(.conductor))
        #expect(SettingsSection(link: "conductor", conductorLink: false) == nil)
        #expect(SettingsSection.groups(conductorLink: true).flatMap { $0 }.contains(.conductor))
    }

    @Test func linksLandOnTheirSection() {
        #expect(SettingsSection(link: "iphone") == .iphone)
        #expect(SettingsSection(link: " About ") == .about)
        #expect(SettingsSection(link: "connections") == .connections)
        #expect(SettingsSection(link: "zoho") == .cliq)
    }

    @Test func phoneStyleOrderAndAliases() {
        #expect(SettingsSection.groups(conductorLink: true)[1] == [.general, .notifications, .awake])
        #expect(SettingsSection.general.title == "Mac")
        #expect(SettingsSection(link: "notify") == .notifications)
        #expect(SettingsSection(link: "mac") == .general)
    }

    @Test func conductorSitsAfterKeepAwakeBeforeConnections() {
        #expect(SettingsSection.groups(conductorLink: true)[2].first == .conductor)
        #expect(SettingsSection.conductor.title == "Conductor")
        #expect(SettingsSection(link: "conductor", conductorLink: true) == .conductor)
    }

    @Test func setupIsFirstOnItsOwn() {
        #expect(SettingsSection.groups(conductorLink: true).first == [.setup])
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
