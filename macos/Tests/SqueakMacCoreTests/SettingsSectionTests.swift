import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct SettingsSectionTests {
    @Test func everySectionIsInExactlyOneGroup() {
        let grouped = SettingsSection.groups().flatMap { $0 }
        let expected = SettingsSection.allCases
        #expect(grouped.count == expected.count)
        #expect(Set(grouped) == Set(expected))
    }

    @Test func groupsAreGeneralDevicesAddOnsIntegrationsAbout() {
        #expect(SettingsSection.titledGroups.map(\.title) == ["General", "Devices", "Add-ons", "Integrations", "About"])
        #expect(SettingsSection.Group.general.sections.contains(.account))
        #expect(SettingsSection.Group.general.sections.contains(.awake))
        #expect(SettingsSection.Group.devices.sections == [.iphone, .connections])
        #expect(SettingsSection.Group.addons.sections == [.addons])
        #expect(SettingsSection.Group.integrations.sections == [.telegram, .cliq, .voice])
        #expect(SettingsSection.Group.agents.title == "Agents")
    }

    @Test func addOnsPageIsAlwaysThereAndOldConductorLinksLandOnIt() {
        #expect(SettingsSection.groups().flatMap { $0 }.contains(.addons))
        #expect(SettingsSection(link: "conductor") == .addons)
        #expect(SettingsSection(link: "add-ons") == .addons)
    }

    @Test func linksLandOnTheirSection() {
        #expect(SettingsSection(link: "iphone") == .iphone)
        #expect(SettingsSection(link: " About ") == .about)
        #expect(SettingsSection(link: "connections") == .connections)
        #expect(SettingsSection(link: "zoho") == .cliq)
    }

    @Test func titlesAndAliases() {
        #expect(SettingsSection.general.title == "Mac")
        #expect(SettingsSection(link: "notify") == .notifications)
        #expect(SettingsSection(link: "mac") == .general)
        #expect(SettingsSection.addons.title == "Add-ons")
        #expect(SettingsSection(link: "setup") == .setup)
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
