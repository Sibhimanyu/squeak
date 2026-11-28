import Foundation
import Testing
@testable import SqueakMacCore

// docs/adr/0006-pond-policy.md: the Mac reads the daemon's `me.can`, `policy` and per-member answers, leniently.
struct PondPolicyTests {
    private func detail(role: String = "member") throws -> PondDetail {
        let json = #"{"pond":{"id":"p","name":"P","role":"\#(role)"},"members":[{"id":"a","name":"A","role":"\#(role)","you":true}]}"#
        return try JSONDecoder().decode(PondDetail.self, from: Data(json.utf8))
    }

    @Test func decodesCanPolicyAndMemberPolicy() throws {
        let json = #"""
        {"pond":{"id":"p","name":"P","role":"member"},
         "policy":{"reachDucks":"room","startDucks":"members-approval","overrides":{"a":{"reachDucks":"direct"}}},
         "me":{"id":"a","role":"member","can":{"post-room":true,"message-duck":"Ducks answer in the Room here.","start-duck":true},
               "policy":{"reachDucks":"direct","startDucks":"members-approval","custom":{"reachDucks":true,"startDucks":false}}},
         "members":[{"id":"a","name":"A","role":"member","you":true,"can":{"invite":"Only the Owner can do that."},
                     "policy":{"reachDucks":"direct","startDucks":"members-approval","custom":{"reachDucks":true,"startDucks":false}}}]}
        """#
        let d = try JSONDecoder().decode(PondDetail.self, from: Data(json.utf8))
        #expect(d.policy?.startDucks == .membersApproval)
        #expect(d.policy?.overrides["a"]?.reachDucks == .direct)
        #expect(d.myPolicy == PondEffectivePolicy(reachDucks: .direct, startDucks: .membersApproval, customReach: true, customStart: false))
        #expect(d.can.allows(.postRoom) && d.can.allows(.startDuck))
        #expect(!d.can.allows(.messageDuck))
        #expect(d.can.reason(.messageDuck) == "Ducks answer in the Room here.")
        #expect(d.members[0].policy?.isCustom == true)
    }

    @Test func absentFieldsFallBackToTheRoleInOnePlace() throws {
        let member = try detail()
        #expect(member.policy == nil && member.myPolicy == nil && member.me == nil)
        #expect(member.can.allows(.messageDuck) && !member.can.allows(.invite) && !member.can.allows(.setPolicy))
        #expect(member.can.reason(.invite) == nil)
        let owner = try detail(role: "owner")
        #expect(owner.can.allows(.invite) && owner.can.allows(.deletePond) && owner.can.allows(.approveEdit))
        #expect(!owner.can.allows(.setPolicy))
        let viewer = try detail(role: "viewer")
        #expect(!viewer.can.allows(.postRoom) && viewer.can.allows(.requestDiff))
    }

    @Test func badShapesNeverBreakThePond() throws {
        let json = #"""
        {"pond":{"id":"p","name":"P","role":"owner"},"policy":"nonsense",
         "me":{"id":"a","role":"owner","can":["x"],"policy":7},
         "members":[{"id":"a","can":{"invite":3,"stop":true},"policy":{"reachDucks":"weird","custom":5}}]}
        """#
        let d = try JSONDecoder().decode(PondDetail.self, from: Data(json.utf8))
        #expect(d.pond.id == "p" && d.members.count == 1)
        #expect(d.policy == nil)
        #expect(d.can.allows(.invite))
        #expect(d.members[0].can?.map["stop"] == .allowed && d.members[0].can?.map["invite"] == nil)
        #expect(d.members[0].policy?.reachDucks == .room)
    }

    @Test func canReadsTheDaemonsVerdictAndSentence() {
        let can = PondCan(PondVerdicts(map: ["start-duck": .refused("Ducks start from the Room here."), "invite": .allowed, "stop": .refused(nil)]), role: .owner)
        #expect(can.allows(.invite) && !can.allows(.startDuck) && !can.allows(.stop))
        #expect(can.reason(.startDuck) == "Ducks start from the Room here.")
        #expect(can.reason(.stop) == nil && can.reason(.invite) == nil)
        #expect(can.allows(.deletePond))
    }

    @Test func threadComposerShowsTheDaemonsRefusal() {
        let can = PondCan(PondVerdicts(map: ["message-duck": .refused("Ducks answer in the Room here.")]), role: .member)
        let a = ThreadAccess(role: .member, starter: "x", me: "a", starterName: "X", can: can)
        #expect(a.composer(working: false) == .watchOnly(line: "Ducks answer in the Room here."))
        #expect(PondThreadRules.composerPlaceholder(role: .member, working: false, can: can) == "Ducks answer in the Room here.")
        #expect(!a.gate(.stop).enabled)
    }

    @Test func dashboardStartReadsTheDaemonAndWaitsOnlyWhenTheDaemonSays() {
        let can = PondCan(PondVerdicts(map: ["start-duck": .refused("Ducks start from the Room here.")]), role: .member)
        let h = PondDashboardHeader.make(.init(role: .member, isRemote: true, ownerName: "Sibhi", start: .own, can: can))
        #expect(h.start == .closed(reason: "Ducks start from the Room here."))
        #expect(PondDashboardBlocks.emptySentence(can: PondCan(role: .member), policy: PondEffectivePolicy(startDucks: .membersApproval)).contains("Owner to approve"))
        #expect(!PondDashboardBlocks.emptySentence(can: PondCan(role: .member), policy: PondEffectivePolicy(startDucks: .members)).contains("Owner to approve"))
    }

    @Test func ownerOnlyMenuItemsReadCan() {
        let refuse = PondCan(PondVerdicts(map: ["rename-pond": .refused(nil), "delete-pond": .allowed, "invite": .refused(nil)]), role: .owner)
        let h = PondDashboardHeader.make(.init(role: .owner, can: refuse))
        #expect(!h.menu.contains(.rename) && h.menu.contains(.delete) && !h.showsInvite)
    }

    @Test func permissionsPickersAndBodies() {
        #expect(PondPermissions.reachChoices.map { PondPermissions.title($0) } == ["In the Room (default)", "Directly"])
        #expect(PondPermissions.startChoices.map { PondPermissions.title($0) } == ["From the Room (default)", "Ask the Owner first", "Freely"])
        #expect(PondPermissions.body(reach: .direct) == .object(["reachDucks": .string("direct")]))
        #expect(PondPermissions.body(start: .membersApproval) == .object(["startDucks": .string("members-approval")]))
        #expect(PondPermissions.overrideBody(member: "m", reach: .set(nil), start: .set(.members))
                == .object(["overrides": .object(["m": .object(["reachDucks": .null, "startDucks": .string("members")])])]))
        #expect(PondPermissions.overrideBody(member: "m", start: .set(.room)) == .object(["overrides": .object(["m": .object(["startDucks": .string("room")])])]))
    }

    @Test func personMenuIsForTheOwnerOnOthersAndCustomLineShows() {
        let owner = PondCan(PondVerdicts(map: ["change-role": .allowed, "set-policy": .allowed]), role: .owner)
        #expect(PondPermissions.personMenu(owner: owner, you: false, connecting: false, currentRole: .member)?.offersPolicy == true)
        #expect(PondPermissions.personMenu(owner: owner, you: true, connecting: false, currentRole: .owner) == nil)
        #expect(PondPermissions.personMenu(owner: owner, you: false, connecting: true, currentRole: .member) == nil)
        let member = PondCan(PondVerdicts(map: ["change-role": .refused(nil), "set-policy": .refused(nil)]), role: .member)
        #expect(PondPermissions.personMenu(owner: member, you: false, connecting: false, currentRole: .member) == nil)
        #expect(PondPermissions.customLine(PondEffectivePolicy(reachDucks: .direct, customReach: true)) == "Can message Ducks directly")
        #expect(PondPermissions.customLine(PondEffectivePolicy()) == nil)
    }

    /// No view compares a role to decide what is offered: every view asks `PondCan` (the daemon's `me.can`).
    @Test func noViewComparesARoleForTheseActions() throws {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/SqueakMac")
        let files = try #require(FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil))
        let banned = [#"[rR]ole\.can(Message|Invite|RemoveMembers)\b"#, #"(myRole|role)\s*[!=]=\s*\.(owner|viewer|member)\b"#, #"\.caps\b"#]
        var hits: [String] = []
        for case let url as URL in files where url.pathExtension == "swift" {
            let text = try String(contentsOf: url, encoding: .utf8)
            for (i, line) in text.components(separatedBy: "\n").enumerated() {
                let code = line.components(separatedBy: "//").first ?? line
                for b in banned where code.range(of: b, options: .regularExpression) != nil { hits.append("\(url.lastPathComponent):\(i + 1) \(line.trimmingCharacters(in: .whitespaces))") }
            }
        }
        // `pond.role != .owner` in PondHome.roomProject says whose Room it is, not what a person may do.
        hits.removeAll { $0.hasPrefix("PondHome.swift") && $0.contains("pond.role != .owner") }
        #expect(hits.isEmpty, "views compare a role: \(hits)")
    }
}
