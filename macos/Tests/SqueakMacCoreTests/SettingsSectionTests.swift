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

    @Test func groupsAreGeneralDevicesAddOnsAbout() {
        #expect(SettingsSection.titledGroups.map(\.title) == ["General", "Devices", "Add-ons", "About"])
        #expect(SettingsSection.Group.general.sections.contains(.account))
        #expect(SettingsSection.Group.general.sections.contains(.awake))
        #expect(SettingsSection.Group.devices.sections == [.iphone, .connections])
        #expect(SettingsSection.Group.addons.sections == [.conductor, .telegram, .cliq, .voice])
        #expect(SettingsSection.Group.agents.title == "Agents")
    }

    @Test func conductorPageIsAlwaysThere() {
        #expect(SettingsSection.groups().flatMap { $0 }.contains(.conductor))
        #expect(SettingsSection(link: "conductor") == .conductor)
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
        #expect(SettingsSection.conductor.title == "Conductor")
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

    @Test func conductorLinkStateDecodesLeniently() throws {
        let full = try JSONDecoder().decode(ConductorLinkState.self, from: Data(#"{"linked":true,"available":true,"appInstalled":true}"#.utf8))
        #expect(full == ConductorLinkState(linked: true, available: true, appInstalled: true))
        let sparse = try JSONDecoder().decode(ConductorLinkState.self, from: Data(#"{"available":true,"extra":1,"linked":"yes"}"#.utf8))
        #expect(sparse == ConductorLinkState(linked: false, available: true, appInstalled: false))
    }
}
