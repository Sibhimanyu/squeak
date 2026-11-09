import Testing
@testable import SqueakIcons

@Suite struct MatrixMotionTests {
    @Test func sameChatKeepsItsRhythmAcrossViewRecreation() {
        let first = MatrixMotion(identity: "project:squeak"), restored = MatrixMotion(identity: "project:squeak")
        #expect(first.phase(at: 12345) == restored.phase(at: 12345))
        #expect(first.patternTime(at: 12345) == restored.patternTime(at: 12345))
        #expect(first.arrival(at: 12345) == restored.arrival(at: 12345))
    }

    @Test func neighboringChatsHaveIndependentPatternsOffsetsAndSpeeds() {
        let chats = ["project:squeak", "project:atlas", "project:compass"].map(MatrixMotion.init(identity:))
        #expect(Set(chats.map(\.seed)).count == chats.count)
        #expect(Set(chats.map { $0.phase(at: 12345) }).count == chats.count)
        #expect(Set(chats.map { $0.patternTime(at: 12346) - $0.patternTime(at: 12345) }).count == chats.count)
    }

    @Test func reducedMotionFreezesBothTextAndMatrix() {
        let motion = MatrixMotion(identity: "chat:a")
        #expect(motion.phase(at: 100, still: true) == motion.phase(at: 10000, still: true))
        #expect(motion.patternTime(at: 100, still: true) == motion.patternTime(at: 10000, still: true))
        #expect(motion.arrival(at: 100, still: true) == motion.arrival(at: 10000, still: true))
    }
}
