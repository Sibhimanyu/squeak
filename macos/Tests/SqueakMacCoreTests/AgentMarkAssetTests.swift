import Foundation
import Testing
@testable import SqueakMacCore

struct AgentMarkAssetTests {
    @Test func agentValuesMapCaseInsensitively() {
        #expect(AgentMarkAsset(agent: "claude") == .claude)
        #expect(AgentMarkAsset(agent: "Codex") == .codex)
        #expect(AgentMarkAsset(agent: "gemini") == nil)
        #expect(AgentMarkAsset(agent: nil) == nil)
    }

    @Test func providersMapByPrefixAndConductor() {
        #expect(AgentMarkAsset(provider: "conductor") == .conductor)
        #expect(AgentMarkAsset(provider: "claude-terminal") == .claude)
        #expect(AgentMarkAsset(provider: "codex-desktop") == .codex)
        #expect(AgentMarkAsset(provider: "claude-cowork") == .claude)
        #expect(AgentMarkAsset(provider: "agent-sdk") == nil)
    }

    @Test func sessionUsesItsAgentThenProviderAndBadgesConductor() {
        let key = SessionKey(provider: "conductor", hostSessionId: "s1")
        let s = HostSession(key: key, agent: "codex", conductorSessionId: "s1")
        #expect(s.agentMark == .codex)
        #expect(s.showsConductorBadge)
        let t = HostSession(key: SessionKey(provider: "claude-terminal", hostSessionId: "t"))
        #expect(t.agentMark == .claude)
        #expect(!t.showsConductorBadge)
        #expect(HostSession(key: key).agentMark == nil)  // Conductor, agent unknown: no agent mark
    }

    @Test func shippedFilesExistAndNamesMatchTheIPhone() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        for m in AgentMarkAsset.allCases {
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("assets/agents/\(m.fileName)").path))
        }
        #expect(AgentMarkAsset.allCases.map(\.rawValue).sorted() == ["agent-claude", "agent-codex", "agent-conductor"])
    }
}
