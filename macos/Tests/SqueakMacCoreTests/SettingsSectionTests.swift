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

    @Test func groupsAreYouAgentsThisMacDevicesAddOnsIntegrationsAbout() {
        #expect(SettingsSection.titledGroups.map(\.title) == ["You", "Agents", "This Mac", "Devices", "Add-ons", "Integrations", "About"])
        #expect(SettingsSection.Group.you.sections == [.account, .notifications, .privacy])
        #expect(SettingsSection.Group.agents.sections == [.models, .messages])
        #expect(SettingsSection.Group.mac.sections == [.general, .awake, .service])
        #expect(SettingsSection.Group.devices.sections == [.iphone, .connections])
        #expect(SettingsSection.Group.addons.sections == [.addons])
        #expect(SettingsSection.Group.integrations.sections == [.telegram, .cliq, .voice])
        #expect(SettingsSection.Group.about.sections == [.about])
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
        #expect(SettingsSection.general.title == "General")
        #expect(SettingsSection.models.title == "Models & presets")
        #expect(SettingsSection.service.title == "Background service")
        #expect(SettingsSection(link: "notify") == .notifications)
        #expect(SettingsSection(link: "mac") == .general)
        #expect(SettingsSection(link: "general") == .general)
        #expect(SettingsSection(link: "presets") == .models)
        #expect(SettingsSection(link: "models") == .models)
        #expect(SettingsSection(link: "sending") == .messages)
        #expect(SettingsSection(link: "diagnostics") == .service)
        #expect(SettingsSection(link: "service") == .service)
        #expect(SettingsSection.addons.title == "Add-ons")
    }

    @Test func setupIsACardNotAPage() {
        #expect(SettingsSection(link: "setup") == nil)
        #expect(SettingsSection.isSetupLink(" Setup "))
        #expect(!SettingsSection.isSetupLink("about"))
        #expect(!SettingsSection.allCases.map(\.rawValue).contains("setup"))
    }

    @Test func setupCardShowsWhileAStepIsLeftAndLeavesWhenDone() {
        let fresh = SetupFlow(SetupFlowFacts())
        #expect(SetupCard.isVisible(fresh))
        #expect(SetupCard.remaining(fresh).first == .service)
        let done = SetupProgress(skipped: ["account", "phone"], completed: ["service", "agents"])
        let finished = SetupFlow(SetupFlowFacts(), progress: done)
        #expect(SetupCard.remaining(finished).isEmpty)
        #expect(!SetupCard.isVisible(finished))
        let oneLeft = SetupFlow(SetupFlowFacts(), progress: SetupProgress(skipped: ["account"], completed: ["service", "agents"]))
        #expect(SetupCard.remaining(oneLeft) == [.phone])
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
