import Foundation

/// What the dock under a chat's transcript says and offers, decided apart from the view so the replay harness and the
/// view read the same answer: whether the working row draws, its words, whether Stop is there.
public enum ChatDock {
    public struct Resolved: Equatable, Sendable {
        public var indicator: ChatIndicator
        /// The transcript's own sense of "a turn is running" (steps listed live, folds held back, footers).
        public var isWorking: Bool
        /// The chat's state (the host's word, or the Mac's own from the press of Send) is working.
        public var working: Bool
        /// The live row (glyph, clock, Stop) is drawn.
        public var showsRow: Bool
        /// The row's words ("Working… · Opus 5.5"), nil when the chat is idle.
        public var line: String?
        public var canStop: Bool
    }

    /// - `hostOwnsState`: the host reports the chat's status itself (a Squeak chat). Its word, and the Mac's own from the
    ///   press of Send (`OptimisticWork`), are the whole truth: a chat the host calls idle is not "starting" just
    ///   because the newest message is the person's. That guess (a send within 3 minutes with no reply yet) is for
    ///   sources that cannot say, and it kept a stopped chat "Working…" for three minutes.
    public static func resolve(
        liveState: SessionState, messages: [ChatMessage], awaitingApproval: Bool, backgroundCount: Int, backgroundWaiting: Bool,
        hostStatus: String?, hostBackgroundCount: Int?, optimistic: Bool, hostOwnsState: Bool, hasStopRoute: Bool,
        activity: [ActivityStep], model: String?, now: Date = Date()
    ) -> Resolved {
        let indicator = ChatIndicator.resolve(
            state: liveState, awaitingApproval: awaitingApproval, backgroundCount: backgroundCount,
            backgroundWaiting: backgroundWaiting, sending: false)
        let isWorking = hostOwnsState ? liveState == .working : ChatTimeline.isWorking(messages: messages, state: liveState, now: now)
        let hostSays = ChatLiveness.showsWorkingLine(
            indicatorActive: false, isWorking: false, hostStatus: hostStatus, backgroundCount: hostBackgroundCount, optimistic: optimistic)
        let working = liveState == .working
        return Resolved(
            indicator: indicator, isWorking: isWorking, working: working, showsRow: indicator.isActive || isWorking || hostSays,
            line: indicator.line(workingLabel: ChatTimeline.workingLabel(activity), model: model),
            canStop: working && hasStopRoute)
    }
}
