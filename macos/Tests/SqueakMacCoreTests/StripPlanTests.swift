import Testing
@testable import SqueakMacCore

@Suite struct StripPlanTests {
    private func key(_ id: String) -> SessionKey { SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: id) }

    @Test func composeInAWorkspaceKeepsTheStripWithThePlaceholderSelected() {
        let a = key("a"), b = key("b")
        let plan = StripPlan.plan(location: .compose(.newThread, pond: "p", workspace: "w"), previous: a.stringValue,
                                  threads: [a.stringValue, b.stringValue])
        #expect(plan.entries == [.thread(a.stringValue), .placeholder, .thread(b.stringValue)])
        #expect(plan.selected == .placeholder)
    }

    @Test func aChatTheStripLacksIsNotAddedToIt() {
        let a = key("a"), b = key("b"), n = key("new")
        let plan = StripPlan.plan(location: .chat(n), previous: a.stringValue, threads: [a.stringValue, b.stringValue])
        #expect(plan.entries == [.thread(a.stringValue), .thread(b.stringValue)])
        #expect(plan.selected == .thread(n.stringValue))
    }

    @Test func noEmptyIntermediateBetweenChatAndComposeAndBack() {
        let a = key("a")
        for location in [WorkbenchLocation.chat(a), .compose(.newThread, pond: nil, workspace: nil), .chat(a)] {
            let plan = StripPlan.plan(location: location, previous: a.stringValue, threads: [a.stringValue])
            #expect(plan.selected != nil)
        }
    }

    @Test func otherPagesSelectNothing() {
        let plan = StripPlan.plan(location: .home, previous: nil, threads: ["x"])
        #expect(plan.entries == [.thread("x")])
        #expect(plan.selected == nil)
    }
}
